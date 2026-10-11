#if os(macOS) || os(iOS)
import Foundation
import Testing

struct NativeGatewayWebSocketFixtureTests {
    @Test
    func rpcWaitAfterFixtureStopThrowsCancellation() async throws {
        let fixture = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [])
        defer { fixture.stop() }
        fixture.stop()

        await #expect(throws: CancellationError.self) {
            _ = try await fixture.waitForRPC(method: "users.self")
        }
    }
}
#endif
