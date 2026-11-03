import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

private let gatewayConnectionLogger = Logger(subsystem: "ai.openclaw", category: "gateway.connection")

extension GatewayConnection {
    private func sessionDefaultString(_ defaults: [String: OpenClawProtocol.AnyCodable]?, key: String) -> String {
        let raw = defaults?[key]?.value as? String
        return (raw ?? "").trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
    }

    func cachedMainSessionKey() -> String? {
        guard let snapshot = lastSnapshot else { return nil }
        let trimmed = self.sessionDefaultString(snapshot.snapshot.sessiondefaults, key: "mainSessionKey")
        return trimmed.isEmpty ? nil : trimmed
    }

    private func canonicalizeSessionKey(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return trimmed }
        guard let defaults = lastSnapshot?.snapshot.sessiondefaults else { return trimmed }
        let mainSessionKey = self.sessionDefaultString(defaults, key: "mainSessionKey")
        guard !mainSessionKey.isEmpty else { return trimmed }
        let mainKey = self.sessionDefaultString(defaults, key: "mainKey")
        let defaultAgentId = self.sessionDefaultString(defaults, key: "defaultAgentId")
        let isMainAlias =
            trimmed == "main" ||
            (!mainKey.isEmpty && trimmed == mainKey) ||
            trimmed == mainSessionKey ||
            (!defaultAgentId.isEmpty &&
                (trimmed == "agent:\(defaultAgentId):main" ||
                    (mainKey.isEmpty == false && trimmed == "agent:\(defaultAgentId):\(mainKey)")))
        return isMainAlias ? mainSessionKey : trimmed
    }
}


extension GatewayConnection {
    struct ConfigGetSnapshot: Decodable {
        struct SnapshotConfig: Decodable {
            struct Session: Decodable {
                let mainKey: String?
                let scope: String?
            }

            let session: Session?
        }

        let config: SnapshotConfig?
    }

    static func mainSessionKey(fromConfigGetData data: Data) throws -> String {
        let snapshot = try JSONDecoder().decode(ConfigGetSnapshot.self, from: data)
        let scope = snapshot.config?.session?.scope?.trimmingCharacters(in: .whitespacesAndNewlines)
        if scope == "global" {
            return "global"
        }
        return "main"
    }

    func mainSessionKey(timeoutMs: Double = 15000) async -> String {
        if let cached = cachedMainSessionKey() {
            return cached
        }
        return await self.refreshMainSessionKey(timeoutMs: timeoutMs)
    }

    func mainSessionKey(
        ifCurrentServerLease lease: ServerLease,
        admission: WebSocketRequestAdmission? = nil,
        timeoutMs: Double = 15000) async throws -> String
    {
        guard await self.isCurrentServerLease(lease) else { throw CancellationError() }
        if let cached = self.cachedMainSessionKey() { return cached }
        do {
            let data = try await self.request(
                method: "config.get",
                params: nil,
                timeoutMs: timeoutMs,
                ifCurrentServerLease: lease,
                admission: admission)
            return try Self.mainSessionKey(fromConfigGetData: data)
        } catch {
            try Task.checkCancellation()
            guard await self.isCurrentServerLease(lease) else { throw CancellationError() }
            return "main"
        }
    }

    func refreshMainSessionKey(timeoutMs: Double = 15000) async -> String {
        do {
            let data = try await request(method: "config.get", params: nil, timeoutMs: timeoutMs)
            return try Self.mainSessionKey(fromConfigGetData: data)
        } catch {
            return "main"
        }
    }

    func setHeartbeatsEnabled(_ enabled: Bool) async -> Bool {
        do {
            try await self.requestVoid(method: .setHeartbeats, params: ["enabled": AnyCodable(enabled)])
            return true
        } catch {
            gatewayConnectionLogger.error("setHeartbeatsEnabled failed \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func sendAgent(
        _ invocation: GatewayAgentInvocation,
        ifCurrentServerLease lease: ServerLease? = nil,
        admission: WebSocketRequestAdmission? = nil,
        ifCurrent: @Sendable () -> Bool = { true }) async -> (ok: Bool, error: String?)
    {
        let trimmed = invocation.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return (false, "message empty") }
        let sessionKey = self.canonicalizeSessionKey(invocation.sessionKey)

        var params: [String: AnyCodable] = [
            "message": AnyCodable(trimmed),
            "sessionKey": AnyCodable(sessionKey),
            "deliver": AnyCodable(invocation.deliver),
            "to": AnyCodable(invocation.to ?? ""),
            "channel": AnyCodable(invocation.channel.rawValue),
            "idempotencyKey": AnyCodable(invocation.idempotencyKey),
        ]
        if let thinking = invocation.thinking?.trimmingCharacters(in: .whitespacesAndNewlines),
           !thinking.isEmpty
        {
            params["thinking"] = AnyCodable(thinking)
        }
        if let timeout = invocation.timeoutSeconds {
            params["timeout"] = AnyCodable(timeout)
        }
        if let trigger = invocation.voiceWakeTrigger {
            params["voiceWakeTrigger"] = AnyCodable(
                trigger.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        do {
            if let lease {
                _ = try await self.request(
                    method: Method.agent.rawValue,
                    params: params,
                    ifCurrentServerLease: lease,
                    admission: admission,
                    ifCurrent: ifCurrent)
            } else {
                try await self.requestVoid(method: .agent, params: params)
            }
            return (true, nil)
        } catch {
            return (false, error.localizedDescription)
        }
    }


    func healthOK(timeoutMs: Int = 8000) async throws -> Bool {
        let data = try await requestRaw(method: .health, timeoutMs: Double(timeoutMs))
        return (try? JSONDecoder().decode(OpenClawGatewayHealthOK.self, from: data))?.ok ?? true
    }


    func sessionsPreview(
        keys: [String],
        limit: Int? = nil,
        maxChars: Int? = nil,
        timeoutMs: Int? = nil,
        ifCurrentServerLease lease: ServerLease) async throws -> OpenClawSessionsPreviewPayload
    {
        let resolvedKeys = keys
            .map { self.canonicalizeSessionKey($0) }
            .filter { !$0.isEmpty }
        if resolvedKeys.isEmpty {
            return OpenClawSessionsPreviewPayload(ts: 0, previews: [])
        }
        var params: [String: AnyCodable] = ["keys": AnyCodable(resolvedKeys)]
        if let limit {
            params["limit"] = AnyCodable(limit)
        }
        if let maxChars {
            params["maxChars"] = AnyCodable(maxChars)
        }
        let data = try await self.request(
            method: Method.sessionsPreview.rawValue,
            params: params,
            timeoutMs: timeoutMs.map { Double($0) },
            ifCurrentServerLease: lease)
        do {
            return try JSONDecoder().decode(OpenClawSessionsPreviewPayload.self, from: data)
        } catch {
            throw GatewayDecodingError(method: Method.sessionsPreview.rawValue, message: error.localizedDescription)
        }
    }


    func agentIdentity(sessionKey: String, timeoutMs: Double = 10000) async throws -> AgentIdentityResult {
        try await self.requestDecoded(
            method: .agentIdentityGet,
            params: ["sessionKey": AnyCodable(self.canonicalizeSessionKey(sessionKey))],
            timeoutMs: timeoutMs)
    }

    func chatHistory(
        sessionKey: String,
        agentID: String? = nil,
        limit: Int? = nil,
        maxChars: Int? = nil,
        cursor: String? = nil,
        maxBytes: Int? = nil,
        timeoutMs: Int? = nil,
        inputRunIDs: [String]? = nil,
        ifCurrentRoute route: Route? = nil,
        operatorBinding: MacGatewayOperatorBinding? = nil) async throws -> OpenClawChatHistoryPayload
    {
        let request = OpenClawChatGatewayRequests.history(
            sessionKey: self.canonicalizeSessionKey(sessionKey),
            agentID: agentID,
            limit: limit,
            maxChars: maxChars,
            inputRunIDs: inputRunIDs,
            cursor: cursor,
            maxBytes: maxBytes,
            timeoutMs: timeoutMs)
        let data = try await self.requestHistory(request, ifCurrentRoute: route, operatorBinding: operatorBinding)
        return try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: data)
    }

    func conversationOwnershipScope(sessionKey: String, agentID: String?) -> OpenClawChatSendOwnership.Scope {
        let defaults = self.lastSnapshot?.snapshot.sessiondefaults
        return OpenClawChatSendOwnership.Scope(
            sessionKey: sessionKey,
            agentID: agentID,
            scope: defaults?["scope"]?.value as? String,
            mainKey: defaults?["mainKey"]?.value as? String,
            defaultAgentID: defaults?["defaultAgentId"]?.value as? String)
    }

    func chatSend(
        sessionKey: String,
        agentID: String? = nil,
        expectedSessionRoutingContract: String? = nil,
        expectedSessionSettings: OpenClawChatSessionSettingsExpectation? = nil,
        queueMode: OpenClawChatQueueMode? = nil,
        message: String,
        thinking: String?,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload],
        runTimeoutMs: Int? = nil,
        requestTimeoutMs: Int? = nil,
        ifCurrentRoute route: Route? = nil,
        distinguishPreDispatchRouteChange: Bool = false,
        operatorBinding: MacGatewayOperatorBinding? = nil) async throws -> OpenClawChatSendResponse
    {
        let supportsSettingsCAS = if let route {
            await self.supportsServerCapability(
                .sessionSettingsCAS,
                ifCurrentRoute: route) == true
        } else {
            false
        }
        guard expectedSessionSettings == nil || supportsSettingsCAS else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let request = OpenClawChatGatewayRequests.sendMessage(
            sessionKey: self.canonicalizeSessionKey(sessionKey),
            agentID: agentID,
            expectedSessionRoutingContract: expectedSessionRoutingContract,
            expectedSessionSettings: expectedSessionSettings,
            supportsSessionSettingsCAS: supportsSettingsCAS,
            queueMode: queueMode,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            runTimeoutMs: runTimeoutMs,
            requestTimeoutMs: requestTimeoutMs)

        let data: Data = if let operatorBinding {
            try await operatorBinding.request(request)
        } else {
            try await self.request(
                request,
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: distinguishPreDispatchRouteChange)
        }
        return try JSONDecoder().decode(OpenClawChatSendResponse.self, from: data)
    }
}
