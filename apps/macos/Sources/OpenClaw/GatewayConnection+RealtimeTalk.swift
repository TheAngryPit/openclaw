import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

private actor RealtimeTalkOperatorRequests {
    private enum CreatedSession {
        case open
        case closing(Task<Data, Error>)
    }

    private let binding: MacGatewayOperatorBinding
    private var createdSessions: [String: CreatedSession] = [:]

    init(binding: MacGatewayOperatorBinding) {
        self.binding = binding
    }

    func request(method: String, params: [String: AnyCodable]?, timeoutMs: Double) async throws -> Data {
        switch method {
        case "talk.session.create":
            try Task.checkCancellation()
            let creation = Task { [binding] in
                try await binding.connection.createRealtimeTalkSession(
                    params: params, timeoutMs: timeoutMs, operatorBinding: binding)
            }
            let data = try await creation.value
            let result = try JSONDecoder().decode(TalkSessionCreateResult.self, from: data)
            if let id = result.relaysessionid?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty {
                if self.createdSessions[id] == nil { self.createdSessions[id] = .open }
            }
            return data
        case "talk.session.close":
            guard let params, let id = params["sessionId"]?.stringValue,
                  let receipt = self.createdSessions[id],
                  Set(params.keys).isSubset(of: ["sessionId", "disposition"]),
                  params["disposition"] == nil || params["disposition"]?.stringValue == "detach"
            else { throw OpenClawChatTransportSendError.notDispatched }
            if case let .closing(close) = receipt { return try await close.value }
            let close = Task { [binding] in
                try await binding.connection.request(
                    method: "talk.session.close",
                    params: params,
                    timeoutMs: timeoutMs,
                    ifCurrentServerLease: binding.lease)
            }
            self.createdSessions[id] = .closing(close)
            return try await close.value
        default:
            return try await self.binding.request(OpenClawChatGatewayRequest(
                method: method, params: params ?? [:], timeoutMs: timeoutMs))
        }
    }
}

private actor RealtimeTalkEventIterator {
    private var iterator: AsyncStream<GatewayConnection.PushDelivery>.Iterator

    init(stream: AsyncStream<GatewayConnection.PushDelivery>) {
        self.iterator = stream.makeAsyncIterator()
    }

    func next() async -> EventFrame? {
        var iterator = self.iterator
        defer { self.iterator = iterator }
        guard !Task.isCancelled else { return nil }
        while let delivery = await iterator.next(isolation: self) {
            guard !Task.isCancelled else { return nil }
            guard delivery.isCurrent, case let .event(event)? = delivery.push else { continue }
            return event
        }
        return nil
    }
}

extension GatewayConnection {
    // MARK: - VoiceWake

    func voiceWakeSetTriggers(_ triggers: [String]) async {
        try? await self.requestVoid(
            method: .voicewakeSet,
            params: ["triggers": AnyCodable(triggers)],
            timeoutMs: 10000)
    }

    func talkMode(enabled: Bool, phase: String? = nil) async {
        var params: [String: AnyCodable] = ["enabled": AnyCodable(enabled)]
        if let phase {
            params["phase"] = AnyCodable(phase)
        }
        // Phase broadcasts report UI state; a failed notification must not start
        // the Gateway or restart its tunnel. Talk startup owns that recovery.
        _ = try? await self.request(method: Method.talkMode.rawValue, params: params, retryTransportFailures: false)
    }

    struct RealtimeTalkBootstrap: @unchecked Sendable {
        let transport: RealtimeTalkRelayTransport
        let configSnapshot: ConfigSnapshot
        let sessionKey: String
    }

    /// Freezes config and relay traffic to one physical Gateway socket.
    ///
    /// A route replacement between config resolution and session creation must
    /// fail this attempt instead of silently moving the relay to a new owner.
    func acquireRealtimeTalkBootstrap(
        operatorBinding: MacGatewayOperatorBinding? = nil) async throws -> RealtimeTalkBootstrap
    {
        let lease: ServerLease
        if let operatorBinding {
            guard operatorBinding.isCurrent, operatorBinding.connection === self else { throw CancellationError() }
            lease = operatorBinding.lease
        } else {
            lease = try await self.acquireServerLease()
        }
        let data = try await self.request(
            method: Method.talkConfig.rawValue,
            params: [:],
            timeoutMs: 8000,
            ifCurrentServerLease: lease,
            admission: operatorBinding?.selection.admission,
            ifCurrent: { operatorBinding?.isCurrent ?? true })
        let snapshot = try JSONDecoder().decode(ConfigSnapshot.self, from: data)
        guard await self.isCurrentServerLease(lease) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let configuredSessionKey = snapshot.config?["session"]?.dictionaryValue?["mainKey"]?
            .stringValue?.nonEmpty
        return RealtimeTalkBootstrap(
            transport: self.realtimeTalkTransport(ifCurrentServerLease: lease, operatorBinding: operatorBinding),
            configSnapshot: snapshot,
            sessionKey: configuredSessionKey ?? "main")
    }

    /// Creates a realtime Talk transport bound to one physical Gateway socket.
    ///
    /// Gateway relay sessions are owned by the connection that created them. A
    /// route-only transport could silently move follow-up audio or close calls to
    /// a replacement socket after reconnecting, where that session does not exist.
    func acquireRealtimeTalkTransport() async throws -> RealtimeTalkRelayTransport {
        let lease = try await self.acquireServerLease()
        return self.realtimeTalkTransport(ifCurrentServerLease: lease)
    }

    private func realtimeTalkTransport(
        ifCurrentServerLease lease: ServerLease,
        operatorBinding: MacGatewayOperatorBinding? = nil) -> RealtimeTalkRelayTransport
    {
        let operatorRequests = operatorBinding.map { RealtimeTalkOperatorRequests(binding: $0) }
        return RealtimeTalkRelayTransport(
            subscribeServerEvents: { bufferingNewest in
                let subscription = await self.makeRealtimeTalkSubscription(
                    bufferingNewest: bufferingNewest,
                    ifCurrentServerLease: lease)
                let iterator = RealtimeTalkEventIterator(stream: subscription.stream)
                // Pull directly from the owning queue; prefetching adds another buffer and stale frames.
                return AsyncStream(
                    unfolding: {
                        let event = await iterator.next()
                        guard operatorBinding?.isCurrent ?? true else { return nil }
                        return event
                    },
                    onCancel: { [continuation = subscription.continuation] in
                        continuation.finish()
                    })
            },
            request: { method, params, timeoutMs in
                if let operatorRequests {
                    return try await operatorRequests.request(method: method, params: params, timeoutMs: timeoutMs)
                }
                return try await self.request(
                    method: method,
                    params: params,
                    timeoutMs: timeoutMs,
                    ifCurrentServerLease: lease,
                    admission: operatorBinding?.selection.admission,
                    ifCurrent: { operatorBinding?.isCurrent ?? true })
            },
            isCurrent: {
                guard operatorBinding?.isCurrent ?? true else { return false }
                return await self.isCurrentServerLease(lease)
            },
            supportsCloseDisposition: {
                await self.supportsServerCapability(
                    .talkSessionCloseDisposition,
                    ifCurrentServerLease: lease) == true
            })
    }

    private func makeRealtimeTalkSubscription(
        bufferingNewest: Int,
        ifCurrentServerLease lease: ServerLease)
        -> (stream: AsyncStream<PushDelivery>, continuation: AsyncStream<PushDelivery>.Continuation)
    {
        let id = UUID()
        let connection = self
        let subscription = AsyncStream<PushDelivery>.makeStream(bufferingPolicy: .bufferingNewest(bufferingNewest))
        let continuation = subscription.continuation
        guard self.serverLeaseMatchesCurrentState(lease) else {
            continuation.finish()
            return subscription
        }
        self.realtimeTalkSubscribers[lease.socketGeneration, default: [:]][id] = continuation
        continuation.onTermination = { @Sendable _ in
            Task {
                await connection.removeRealtimeTalkSubscriber(
                    id,
                    socketGeneration: lease.socketGeneration)
            }
        }
        return subscription
    }

    func removeRealtimeTalkSubscriber(_ id: UUID, socketGeneration: UInt64) {
        self.realtimeTalkSubscribers[socketGeneration]?[id] = nil
        if self.realtimeTalkSubscribers[socketGeneration]?.isEmpty == true {
            self.realtimeTalkSubscribers[socketGeneration] = nil
        }
    }

    func finishRealtimeTalkSubscribers(socketGeneration: UInt64? = nil) {
        let subscribers: [AsyncStream<PushDelivery>.Continuation]
        if let socketGeneration {
            subscribers = self.realtimeTalkSubscribers.removeValue(forKey: socketGeneration)
                .map { Array($0.values) } ?? []
        } else {
            subscribers = self.realtimeTalkSubscribers.values.flatMap(\.values)
            self.realtimeTalkSubscribers.removeAll()
        }
        subscribers.forEach { $0.finish() }
    }
}
