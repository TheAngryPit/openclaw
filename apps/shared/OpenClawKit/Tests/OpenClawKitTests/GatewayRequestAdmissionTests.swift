#if os(macOS) || os(iOS)
import Foundation
import Testing
@testable import OpenClawKit

private final class HeldNativeRequestSession: WebSocketSessioning, @unchecked Sendable {
    let session = URLSession(configuration: .ephemeral)
    let entered = AsyncStream<Void>.makeStream()
    let released = AsyncStream<Void>.makeStream()

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        WebSocketTaskBox(task: HeldNativeRequestTask(
            task: self.session.webSocketTask(with: request), entered: self.entered, released: self.released.stream))
    }
}

private final class HeldNativeRequestTask: WebSocketRequestSending, @unchecked Sendable {
    let task: URLSessionWebSocketTask
    let entered: (stream: AsyncStream<Void>, continuation: AsyncStream<Void>.Continuation)
    let released: AsyncStream<Void>

    init(
        task: URLSessionWebSocketTask,
        entered: (stream: AsyncStream<Void>, continuation: AsyncStream<Void>.Continuation),
        released: AsyncStream<Void>)
    {
        self.task = task
        self.entered = entered
        self.released = released
    }

    var state: URLSessionTask.State {
        self.task.state
    }

    var response: URLResponse? {
        self.task.response
    }

    func resume() {
        self.task.resume()
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        self.task.cancel(with: closeCode, reason: reason)
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try await self.task.send(message)
    }

    func sendRequest(_ message: URLSessionWebSocketTask.Message, lifetime: WebSocketRequestLifetime) async throws {
        self.entered.continuation.yield(())
        var release = self.released.makeAsyncIterator()
        _ = await release.next()
        try await WebSocketTaskBox(task: self.task).sendRequest(message, lifetime: lifetime)
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        self.task.sendPing(pongReceiveHandler: pongReceiveHandler)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await self.task.receive()
    }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        self.task.receive(completionHandler: completionHandler)
    }
}

struct GatewayRequestAdmissionTests {
    @Test(arguments: [false, true])
    func `retirement before native enqueue emits no frame while dispatched requests still settle`(
        retireBeforeEnqueue: Bool) async throws
    {
        let fixture = try await NativeGatewayWebSocketFixture.start(
            issuedDeviceTokens: [nil], manualResponseMethods: ["health"])
        defer { fixture.stop() }
        let transport = HeldNativeRequestSession()
        defer {
            transport.entered.continuation.finish()
            transport.released.continuation.finish()
            transport.session.invalidateAndCancel()
        }
        let channel = GatewayChannelActor(
            url: fixture.url(), token: nil, session: WebSocketSessionBox(session: transport),
            connectOptions: GatewayConnectOptions(
                role: "node", scopes: [], caps: [], commands: [], permissions: [:],
                clientId: "request-admission-test", clientMode: "node", clientDisplayName: "Admission Test",
                includeDeviceIdentity: false))
        do {
            try await channel.connect()
            let generation = try #require(await channel.currentConnectionGeneration())
            let admission = WebSocketRequestAdmission()
            let request = Task {
                try await channel.request(
                    method: "health", params: nil, ifCurrentConnectionGeneration: generation, admission: admission)
            }
            var entered = transport.entered.stream.makeAsyncIterator()
            _ = await entered.next()
            #expect(await channel._test_pendingRequestCount() == 1)
            if retireBeforeEnqueue { admission.retire() }
            transport.released.continuation.yield(())
            if retireBeforeEnqueue {
                await #expect(throws: CancellationError.self) { try await request.value }
                #expect(fixture.capturedRPC(at: 0) == nil)
            } else {
                let frame = try await fixture.waitForRPC(method: "health")
                admission.retire()
                #expect(fixture.respond(to: frame, payload: ["ok": true]))
                let data = try await request.value
                #expect(try (JSONSerialization.jsonObject(with: data) as? [String: Bool])?["ok"] == true)
            }
            #expect(await channel.currentConnectionGeneration() == generation)
            #expect(await channel._test_pendingRequestCount() == 0)
        } catch {
            await channel.shutdown()
            throw error
        }
        await channel.shutdown()
    }
}
#endif
