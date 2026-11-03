import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

@MainActor
final class QuickChatGatewaySession {
    private let selection: MacGatewaySelectionPreferences
    private let connectionProvider: @Sendable (DashboardGatewayTarget) async -> GatewayConnection
    private var snapshot: MacGatewaySelectionPreferences.Snapshot?
    private var admission: Task<MacGatewayOperatorBinding, Error>?
    private var monitor: Task<Void, Never>?
    private var observer: NSObjectProtocol?
    private var presentationID = UUID()
    private(set) var binding: MacGatewayOperatorBinding?
    var onRetired: (() -> Void)?

    init(
        selection: MacGatewaySelectionPreferences = .shared,
        connectionProvider: @escaping @Sendable (DashboardGatewayTarget) async -> GatewayConnection = {
            await DashboardManager.gatewayConnection(for: $0)
        })
    {
        self.selection = selection
        self.connectionProvider = connectionProvider
        self.observer = NotificationCenter.default.addObserver(
            forName: MacGatewaySelectionPreferences.didChangeNotification, object: selection, queue: .main)
        { [weak self] _ in
            MainActor.assumeIsolated { self?.retire() }
        }
    }

    isolated deinit {
        self.admission?.cancel()
        self.monitor?.cancel()
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    func beginPresentation() {
        self.endPresentation()
        self.snapshot = self.selection.snapshot()
    }

    func endPresentation() {
        self.presentationID = UUID()
        self.admission?.cancel()
        self.admission = nil
        self.monitor?.cancel()
        self.monitor = nil
        self.binding = nil
        self.snapshot = nil
    }

    private func retire() {
        guard self.snapshot != nil else { return }
        self.endPresentation()
        self.onRetired?()
    }

    var isCurrent: Bool {
        self.binding?.isCurrent == true
    }

    func requireBinding() async throws -> MacGatewayOperatorBinding {
        guard let snapshot, snapshot.isCurrent, !Task.isCancelled else { throw CancellationError() }
        let presentationID = self.presentationID
        if let binding {
            guard binding.isCurrent else { self.retire()
                throw CancellationError()
            }
            return binding
        }
        let task: Task<MacGatewayOperatorBinding, Error>
        if let admission {
            task = admission
        } else {
            task = Task { [selection, connectionProvider] in
                try await MacGatewayOperatorBinding.capture(
                    selection: selection,
                    snapshot: snapshot,
                    connectionProvider: connectionProvider)
            }
            self.admission = task
        }
        do {
            let binding = try await task.value
            guard self.presentationID == presentationID, snapshot.isCurrent, binding.isCurrent, !Task.isCancelled else {
                throw CancellationError()
            }
            self.binding = binding
            self.admission = nil
            if self.monitor == nil {
                self.monitor = Task { [weak self] in
                    let stream = await binding.connection.subscribe()
                    guard !Task.isCancelled else { return }
                    guard binding.isCurrent else { self?.retire()
                        return
                    }
                    for await _ in stream {
                        guard !Task.isCancelled else { return }
                        if !binding.isCurrent { self?.retire()
                            return
                        }
                    }
                }
            }
            return binding
        } catch {
            if self.presentationID == presentationID { self.retire() }
            throw error
        }
    }

    func sessionKey() async -> String {
        guard let binding = try? await self.requireBinding(),
              let key = try? await binding.connection.mainSessionKey(
                  ifCurrentServerLease: binding.lease, admission: binding.selection.admission),
              binding.isCurrent else { return "" }
        return key
    }

    func agents() async throws -> AgentsListResult {
        let binding = try await self.requireBinding()
        return try await JSONDecoder().decode(AgentsListResult.self, from: binding.request(method: "agents.list"))
    }

    func agentIdentity(sessionKey: String) async throws -> QuickChatAgentDisplay {
        let binding = try await self.requireBinding()
        let data = try await binding.request(method: "agent.identity.get", params: ["sessionKey": .init(sessionKey)])
        let identity = try JSONDecoder().decode(AgentIdentityResult.self, from: data)
        return QuickChatAgentDisplay(
            id: identity.agentid,
            name: identity.name?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? identity.agentid,
            emoji: identity.emoji?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty,
            avatar: QuickChatAgentDisplay.avatar(fromRendered: identity.avatar))
    }

    func send(
        sessionKey: String,
        agentID: String?,
        message: String,
        thinking: String?,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> String
    {
        let binding = try await self.requireBinding()
        let send = QuickChatModel.gatewaySendProvider(gateway: binding.connection, binding: binding)
        return try await send(sessionKey, agentID, message, thinking, idempotencyKey, attachments)
    }

    func modelControls(target: OpenClawChatSessionTarget) async throws -> QuickChatModelControlSnapshot {
        let binding = try await self.requireBinding()
        let transport = MacGatewayChatTransport(
            connection: binding.connection, defaultGlobalAgentID: target.agentID, operatorBinding: binding)
        async let catalog = transport.loadModelCatalog(sessionKey: target.sessionKey, agentID: target.agentID)
        async let sessions = transport.listSessions(limit: 200, search: target.sessionKey, archived: false)
        async let agents = JSONDecoder().decode(AgentsListResult.self, from: binding.request(method: "agents.list"))
        let modelCatalog = try await catalog
        var result = try await QuickChatModelControlLogic.snapshot(
            target: target,
            models: modelCatalog.choices,
            sessions: sessions,
            agents: agents,
            modelSelectionPolicy: modelCatalog.modelSelectionPolicy)
        guard binding.isCurrent else { throw CancellationError() }
        result.catalogMessage = modelCatalog.message
        result.catalogRefreshFailed = modelCatalog.refreshFailed
        return result
    }

    func patch(
        target: OpenClawChatSessionTarget,
        settings: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?
    {
        let binding = try await self.requireBinding()
        return try await Self.patch(binding: binding, target: target, settings: settings)
    }

    static func patch(
        binding: MacGatewayOperatorBinding,
        target: OpenClawChatSessionTarget,
        settings: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?
    {
        let transport = MacGatewayChatTransport(
            connection: binding.connection, defaultGlobalAgentID: target.agentID, operatorBinding: binding)
        guard let lease = await transport.acquireSessionSettingsRouteLease(), binding.isCurrent else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        return try await lease.patchSessionSettings(target.sessionKey, target.agentID, settings)
    }

    func events() async -> AsyncStream<GatewayConnection.PushDelivery> {
        guard let binding = try? await self.requireBinding() else { return AsyncStream { $0.finish() } }
        return await binding.connection.subscribe()
    }

    func recents() async throws -> [SessionRow] {
        let binding = try await self.requireBinding()
        return try await SessionLoader.loadSnapshot(limit: 5, operatorBinding: binding).rows
    }
}
