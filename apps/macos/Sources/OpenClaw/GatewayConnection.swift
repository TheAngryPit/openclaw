import ConcurrencyExtras
import CryptoKit
import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

/// Owns one Gateway websocket shared by its callers. The primary app runtime
/// uses `.shared`; saved-profile windows use independent connections.
actor GatewayConnection: Observable {
    nonisolated let chatSendOwnership = OpenClawChatSendOwnership()
    var nativeChatSubscriptionOwners: [UUID: OpenClawChatSessionTarget] = [:]
    var nativeChatSubscribedScopes: Set<OpenClawChatSendOwnership.Scope> = []
    var nativeChatSubscriptionLease: ServerLease?
    var nativeChatSubscriptionTail: Task<Void, Error>?

    static let shared: GatewayConnection = {
        #if DEBUG
        // Rendered test views can request previews through the shared connection.
        // Only explicitly injected test routes may reach a transport or credentials.
        if ProcessInfo.processInfo.isRunningTests {
            return GatewayConnection(testEndpointProvider: { throw URLError(.notConnectedToInternet) })
        }
        #endif
        return GatewayConnection(
            endpointProvider: GatewayConnection.defaultEndpointProvider,
            currentEndpointRevision: { GatewayEndpointStore.shared.routeRevision })
    }()

    @MainActor private weak var approvalQueueStore: ExecApprovalQueueStore?

    @MainActor var approvalQueue: ExecApprovalQueueStore {
        if let store = self.approvalQueueStore { return store }
        let store = ExecApprovalQueueStore(gateway: self)
        self.approvalQueueStore = store
        return store
    }

    nonisolated static let operatorClientCaps = [
        OpenClawGatewayClientCapability.agentKind,
        OpenClawGatewayClientCapability.inlineWidgets,
        OpenClawGatewayClientCapability.modelSelectionPolicy,
        OpenClawGatewayClientCapability.ultrafast,
        OpenClawGatewayClientCapability.usageRefreshing,
    ]

    typealias Config = (url: URL, token: String?, password: String?)

    struct EndpointSnapshot {
        let config: Config
        let tls: GatewayTLSRoute?
        let routeAuthority: UInt64?
        let deviceAuthGatewayID: String?
        let revision: UInt64?
        let browserSession: GatewayBrowserSession?
        let personalTailscaleAuthentication: Bool

        init(
            config: Config,
            tls: GatewayTLSRoute? = nil,
            routeAuthority: UInt64?,
            deviceAuthGatewayID: String? = nil,
            revision: UInt64? = nil,
            browserSession: GatewayBrowserSession? = nil,
            personalTailscaleAuthentication: Bool = false)
        {
            self.config = config
            self.tls = tls
            self.routeAuthority = routeAuthority
            self.deviceAuthGatewayID = deviceAuthGatewayID
            self.revision = revision
            self.browserSession = browserSession
            self.personalTailscaleAuthentication = personalTailscaleAuthentication
        }
    }

    typealias EndpointProvider = @Sendable () async throws -> EndpointSnapshot
    typealias SessionProvider = @Sendable (GatewayTLSRoute?) -> WebSocketSessionBox?

    struct Route: Equatable, Sendable {
        fileprivate let generation: UInt64
        let authority: UInt64?
        let url: URL
        fileprivate let token: String?
        fileprivate let password: String?
        let tls: GatewayTLSRoute?
        let deviceAuthGatewayID: String?
        let browserSession: GatewayBrowserSession?
        let personalTailscaleAuthentication: Bool
        let activationOwnershipFingerprint: String?

        fileprivate init(
            endpoint: EndpointSnapshot,
            generation: UInt64,
            activationBindingKey: SymmetricKey?,
            authBinding: GatewayAuthBinding? = nil)
        {
            self.generation = generation
            self.authority = endpoint.routeAuthority
            self.url = endpoint.config.url
            self.token = endpoint.config.token
            self.password = endpoint.config.password
            self.tls = endpoint.tls
            self.deviceAuthGatewayID = endpoint.deviceAuthGatewayID
            self.browserSession = endpoint.browserSession
            self.personalTailscaleAuthentication = endpoint.personalTailscaleAuthentication
            self.activationOwnershipFingerprint = GatewayConnection.activationOwnershipFingerprint(
                config: endpoint.config,
                browserSession: endpoint.browserSession,
                authBinding: authBinding,
                key: activationBindingKey)
        }

        func matches(config: Config) -> Bool {
            self.url == config.url && self.token == config.token && self.password == config.password
        }

        fileprivate func matches(_ endpoint: EndpointSnapshot) -> Bool {
            self.authority == endpoint.routeAuthority &&
                self.matches(config: endpoint.config) &&
                GatewayTLSRoute.hasSameConnectionIdentity(self.tls, endpoint.tls) &&
                self.deviceAuthGatewayID == endpoint.deviceAuthGatewayID &&
                self.browserSession == endpoint.browserSession &&
                self.personalTailscaleAuthentication == endpoint.personalTailscaleAuthentication
        }
    }

    /// One connected Gateway server, not merely an endpoint configuration.
    /// A reconnect at the same URL creates a different lease.
    struct ServerLease: Sendable, Hashable {
        // Managed-image HTTP reuses this captured route from its focused extension file.
        // Carrying the snapshot forward prevents endpoint or TLS rediscovery after suspension.
        let route: Route
        let socketGeneration: UInt64
        let endpointRevision: UInt64?
        fileprivate let client: GatewayChannelActor

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.client === rhs.client && lhs.route.generation == rhs.route.generation &&
                lhs.socketGeneration == rhs.socketGeneration && lhs.endpointRevision == rhs.endpointRevision
        }

        func hash(into hasher: inout Hasher) {
            hasher.combine(ObjectIdentifier(self.client))
            hasher.combine(self.route.generation)
            hasher.combine(self.socketGeneration)
            hasher.combine(self.endpointRevision)
        }
    }

    struct PushDelivery: Sendable {
        enum Event: Sendable {
            case push(GatewayPush)
            /// Retirement is also an exact-source cleanup receipt. It grants no
            /// action or current-status authority when isCurrent is false.
            case disconnected(String?)
        }

        let event: Event
        let serverLease: ServerLease
        let mainSessionKey: String?
        fileprivate let currentOwner: @Sendable () -> Bool

        /// Terminal chat outcomes retain route ownership; RPCs still validate the exact server lease.
        var isCurrent: Bool {
            self.currentOwner()
        }

        var push: GatewayPush? {
            guard case let .push(push) = self.event else { return nil }
            return push
        }
    }

    private struct AdmittedConnection: Sendable {
        let lease: ServerLease
        let mainSessionKey: String?
    }

    private enum ConnectionPublication: Sendable {
        case connected(AdmittedConnection)
        case disconnected(ServerLease)
        case retired(ServerLease)
    }

    enum Method: String {
        case agent
        case setHeartbeats = "set-heartbeats"
        case health
        case configGet = "config.get"
        case configSet = "config.set"
        case talkConfig = "talk.config"
        case talkMode = "talk.mode"
        case talkSpeak = "talk.speak"
        case agentsList = "agents.list"
        case agentIdentityGet = "agent.identity.get"
        case sessionsPreview = "sessions.preview"
        case skillsStatus = "skills.status"
        case voicewakeGet = "voicewake.get"
        case voicewakeSet = "voicewake.set"
        case nodePairApprove = "node.pair.approve"
        case nodePairReject = "node.pair.reject"
        case devicePairList = "device.pair.list"
        case devicePairApprove = "device.pair.approve"
        case devicePairReject = "device.pair.reject"
        case execApprovalResolve = "exec.approval.resolve"
        case approvalResolve = "approval.resolve"
        case cronList = "cron.list"
    }

    private let endpointProvider: EndpointProvider
    private nonisolated let currentEndpointRevision: (@Sendable () -> UInt64)?
    private nonisolated let endpointObservation = ObservationRegistrar()
    private let supportsSharedEndpointRecovery: Bool
    private let activationBindingKeyProvider: @Sendable () -> SymmetricKey?
    let includeDeviceIdentity: Bool
    private let sessionProvider: SessionProvider
    private let clientShutdown: @Sendable (GatewayChannelActor) async -> Void
    private let decoder = JSONDecoder()
    private var browserSessionExpiryTask: Task<Void, Never>?
    var sourceResources: (lease: ServerLease, revision: UInt64, loader: OpenClawChatSourceResources)?
    var sourceResourceRevision: UInt64 = 0
    var managedMediaTransfers: [UUID: Task<(Data, URLResponse), Error>] = [:]

    private struct ConfiguredConnection {
        let client: GatewayChannelActor
        var endpoint: EndpointSnapshot
        let tlsMetadataProvider: (any GatewayTLSRouteMetadataProviding)?
        let shutdownGeneration: UInt64
        let activationBindingKey: SymmetricKey?

        func matches(endpoint: EndpointSnapshot, shutdownGeneration: UInt64) -> Bool {
            self.endpoint.config.url == endpoint.config.url &&
                self.endpoint.config.token == endpoint.config.token &&
                self.endpoint.config.password == endpoint.config.password &&
                self.endpoint.browserSession == endpoint.browserSession &&
                self.endpoint.personalTailscaleAuthentication == endpoint.personalTailscaleAuthentication &&
                GatewayTLSRoute.hasSameConnectionIdentity(self.endpoint.tls, endpoint.tls) &&
                self.endpoint.deviceAuthGatewayID == endpoint.deviceAuthGatewayID &&
                self.endpoint.routeAuthority == endpoint.routeAuthority &&
                self.shutdownGeneration == shutdownGeneration
        }
    }

    private nonisolated let connectionPublication = LockIsolated<ConnectionPublication?>(nil)
    private var configuredConnection: ConfiguredConnection? {
        didSet { self.publishConnectedServerLease() }
    }

    private var highestEndpointRevision: UInt64?
    private var routeGeneration: UInt64 = 0
    /// Unbound operations capture this before their first suspension. Shutdown
    /// advances it so delayed config and retry work cannot recreate a route.
    private var shutdownGeneration: UInt64 = 0
    /// Callback work keeps the physical socket epoch that decoded it. Retiring
    /// that epoch prevents delayed pushes from entering a replacement socket.
    private(set) var socketGenerationState = GatewaySocketGenerationState()

    private var subscribers: [UUID: AsyncStream<PushDelivery>.Continuation] = [:]
    #if DEBUG
    private var subscriberWaitersForTesting: [CheckedContinuation<Void, Never>] = []
    #endif
    var realtimeTalkSubscribers: [UInt64: [UUID: AsyncStream<PushDelivery>.Continuation]] = [:]
    var lastSnapshot: HelloOk? {
        didSet { self.publishConnectedServerLease() }
    }

    private struct PersonalIdentity: Equatable {
        let profileID: String
        let recoveryScope: String
    }

    private var personalIdentity: PersonalIdentity?
    private var verifiedPersonalSocketGeneration: UInt64?
    private var personalVerificationTask: Task<Void, Never>?

    nonisolated var connectedEndpointRevision: UInt64? {
        guard case let .connected(connection) = self.connectionPublication.value else { return nil }
        return connection.lease.endpointRevision
    }

    nonisolated var hasConnectedServer: Bool {
        guard case let .connected(connection) = self.connectionPublication.value else { return false }
        return self.serverLeaseMatchesCurrentState(connection.lease)
    }

    private func publishConnectedServerLease() {
        // Retirement clears authority before changing any other actor state.
        // Only a fully admitted handshake may replace that terminal publication.
        guard self.lastSnapshot != nil, let connection = self.configuredConnection,
              let socketGeneration = self.socketGenerationState.activeGeneration,
              !connection.endpoint.personalTailscaleAuthentication ||
              self.verifiedPersonalSocketGeneration == socketGeneration
        else { return }
        let endpoint = connection.endpoint
        let lease = ServerLease(
            route: Route(
                endpoint: endpoint,
                generation: self.routeGeneration,
                activationBindingKey: connection.activationBindingKey),
            socketGeneration: socketGeneration,
            endpointRevision: endpoint.revision,
            client: connection.client)
        let admitted = AdmittedConnection(lease: lease, mainSessionKey: self.cachedMainSessionKey())
        self.connectionPublication.withValue { $0 = .connected(admitted) }
    }

    var canvasPluginSurfaceURL: String?

    struct CanvasPluginSurfaceRefresh {
        let id: UUID
        let task: Task<GatewayCanvasHostRoute?, Never>
    }

    var canvasPluginSurfaceRefresh: CanvasPluginSurfaceRefresh?

    init(
        endpointProvider: @escaping EndpointProvider = GatewayConnection.defaultEndpointProvider,
        currentEndpointRevision: (@Sendable () -> UInt64)? = nil,
        supportsSharedEndpointRecovery: Bool = true,
        activationBindingKeyProvider: @escaping @Sendable () -> SymmetricKey? =
            GatewayConnection.defaultActivationBindingKey,
        sessionBox: WebSocketSessionBox? = nil,
        sessionProvider: SessionProvider? = nil,
        clientShutdown: @escaping @Sendable (GatewayChannelActor) async -> Void = { client in
            await client.shutdown()
        })
    {
        self.endpointProvider = endpointProvider
        self.currentEndpointRevision = currentEndpointRevision
        self.supportsSharedEndpointRecovery = supportsSharedEndpointRecovery
        self.activationBindingKeyProvider = activationBindingKeyProvider
        self.includeDeviceIdentity = true
        self.sessionProvider = Self.resolveSessionProvider(
            sessionBox: sessionBox,
            sessionProvider: sessionProvider)
        self.clientShutdown = clientShutdown
    }

    #if DEBUG
    private static let testingActivationBindingKey = SymmetricKey(size: .bits256)

    init(
        configProvider: @escaping @Sendable () async throws -> Config,
        activationBindingKeyProvider: @escaping @Sendable () -> SymmetricKey? = {
            GatewayConnection.testingActivationBindingKey
        },
        sessionBox: WebSocketSessionBox? = nil,
        sessionProvider: SessionProvider? = nil,
        clientShutdown: @escaping @Sendable (GatewayChannelActor) async -> Void = { client in
            await client.shutdown()
        })
    {
        self.endpointProvider = {
            try await EndpointSnapshot(config: configProvider(), routeAuthority: nil)
        }
        self.currentEndpointRevision = nil
        self.supportsSharedEndpointRecovery = false
        self.activationBindingKeyProvider = activationBindingKeyProvider
        // Mock WebSocket routes do not exercise device authentication and must not
        // depend on the process-global persisted identity store.
        self.includeDeviceIdentity = false
        self.sessionProvider = Self.resolveSessionProvider(
            sessionBox: sessionBox,
            sessionProvider: sessionProvider)
        self.clientShutdown = clientShutdown
    }

    init(
        testEndpointProvider: @escaping EndpointProvider,
        currentEndpointRevision: (@Sendable () -> UInt64)? = nil,
        sessionBox: WebSocketSessionBox? = nil)
    {
        self.endpointProvider = testEndpointProvider
        self.currentEndpointRevision = currentEndpointRevision
        self.supportsSharedEndpointRecovery = false
        self.activationBindingKeyProvider = { GatewayConnection.testingActivationBindingKey }
        // Mock WebSocket routes do not exercise device authentication and must not
        // depend on the process-global persisted identity store.
        self.includeDeviceIdentity = false
        self.sessionProvider = Self.resolveSessionProvider(
            sessionBox: sessionBox,
            sessionProvider: nil)
        self.clientShutdown = { client in await client.shutdown() }
    }
    #endif

    private static func resolveSessionProvider(
        sessionBox: WebSocketSessionBox?,
        sessionProvider: SessionProvider?) -> SessionProvider
    {
        if let sessionProvider {
            return sessionProvider
        }
        if let sessionBox {
            return { _ in sessionBox }
        }
        return { route in
            route.map { WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0.params)) }
        }
    }

    // MARK: - Low-level request

    func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double? = nil,
        retryTransportFailures: Bool = true,
        preflightRoute: Route? = nil) async throws -> Data
    {
        let shutdownGeneration = shutdownGeneration
        let endpoint = try await currentEndpoint()
        if let preflightRoute {
            try self.requireCurrentPreflightRoute(
                preflightRoute, endpoint: endpoint, shutdownGeneration: shutdownGeneration)
        }
        let cfg = endpoint.config
        let client = try await configure(
            endpoint: endpoint,
            shutdownGeneration: shutdownGeneration)
        let route = Route(
            endpoint: endpoint,
            generation: self.routeGeneration,
            activationBindingKey: self.configuredConnection?.activationBindingKey)

        do {
            return try await self.sendRequest(
                client: client, route: route, method: method, params: params, timeoutMs: timeoutMs)
        } catch {
            try Task.checkCancellation()
            if GatewayCompatibilityIssue(error: error) != nil { throw error }
            if let tlsError = error as? GatewayTLSValidationError,
               let replacement = try await self.renewLearnedPin(
                   after: tlsError.failure, route: route, shutdownGeneration: shutdownGeneration)
            {
                // The typed handshake failure precedes dispatch. Retry it once;
                // never recursively discover a different endpoint or repair again.
                return try await replacement.request(method: method, params: params, timeoutMs: timeoutMs)
            }
            if !retryTransportFailures || error is GatewayResponseError || error is GatewayDecodingError {
                throw error
            }
            try requireCurrentShutdownGeneration(shutdownGeneration)
            // Profile-bound windows own a fixed endpoint. Shared recovery reads global
            // connection-mode state and may legitimately retarget only the primary app route.
            guard self.supportsSharedEndpointRecovery else { throw error }

            // Auto-recover in local mode by spawning/attaching a gateway and retrying a few times.
            // Canvas interactions should "just work" even if the local gateway isn't running yet.
            let mode = await MainActor.run { AppStateStore.shared.connectionMode }
            try requireCurrentShutdownGeneration(shutdownGeneration)
            switch mode {
            case .local:
                await MainActor.run { GatewayProcessManager.shared.setActive(true, source: .recovery) }
                try requireCurrentShutdownGeneration(shutdownGeneration)

                let lastError: Error
                do {
                    return try await self.retryRequest(
                        after: error,
                        shutdownGeneration: shutdownGeneration)
                    {
                        try await client.request(method: method, params: params, timeoutMs: timeoutMs)
                    }
                } catch {
                    lastError = error
                }

                let nsError = lastError as NSError
                if nsError.domain == URLError.errorDomain,
                   let fallback = await GatewayEndpointStore.shared.maybeFallbackToTailnet(from: cfg.url)
                {
                    try acceptEndpointRevision(fallback.revision)
                    let fallbackClient = try await configure(
                        endpoint: fallback,
                        shutdownGeneration: shutdownGeneration)
                    return try await self.retryRequest(
                        after: lastError,
                        shutdownGeneration: shutdownGeneration)
                    {
                        try await fallbackClient.request(method: method, params: params, timeoutMs: timeoutMs)
                    }
                }

                throw lastError
            case .remote:
                let nsError = error as NSError
                guard nsError.domain == URLError.errorDomain else { throw error }

                var lastError: Error = error
                await RemoteTunnelManager.shared.stopAll()
                try requireCurrentShutdownGeneration(shutdownGeneration)
                do {
                    _ = try await GatewayEndpointStore.shared.ensureRemoteControlTunnel()
                    try requireCurrentShutdownGeneration(shutdownGeneration)
                } catch {
                    try requireCurrentShutdownGeneration(shutdownGeneration)
                    lastError = error
                }

                return try await self.retryRequest(
                    after: lastError,
                    shutdownGeneration: shutdownGeneration)
                {
                    let endpoint = try await self.currentEndpoint()
                    let client = try await self.configure(
                        endpoint: endpoint,
                        shutdownGeneration: shutdownGeneration)
                    return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
                }
            case .unconfigured:
                throw error
            }
        }
    }

    /// A delayed TLS failure has no authority to repair credentials or a route that
    /// changed while the handshake was in flight. Returns the renewed route's client.
    private func renewLearnedPin(
        after failure: GatewayTLSValidationFailure,
        route: Route,
        shutdownGeneration: UInt64) async throws -> GatewayChannelActor?
    {
        let current = try await self.currentEndpoint()
        try self.requireCurrentPreflightRoute(route, endpoint: current, shutdownGeneration: shutdownGeneration)
        guard GatewayTLSRepairCoordinator.repairOnCurrentExecutor(route: route.tls, url: route.url, failure: failure)
        else { return nil }
        let refreshed = try await self.currentEndpoint()
        try self.requireCurrentPreflightRoute(route, endpoint: refreshed, shutdownGeneration: shutdownGeneration)
        return try await self.configure(endpoint: refreshed, shutdownGeneration: shutdownGeneration)
    }

    /// Automatic reconnects have no request to retry: renew through the same owner
    /// checks, then reconnect only the replacement socket.
    private func renewLearnedPinAfterReconnectFailure(
        _ error: GatewayTLSValidationError,
        routeGeneration: UInt64) async
    {
        guard routeGeneration == self.routeGeneration, let connection = self.configuredConnection else { return }
        let route = Route(
            endpoint: connection.endpoint,
            generation: routeGeneration,
            activationBindingKey: connection.activationBindingKey)
        guard let replacement = try? await self.renewLearnedPin(
            after: error.failure, route: route, shutdownGeneration: connection.shutdownGeneration)
        else { return }
        // Retiring the old channel cancels the task that reported this failure.
        Task { try? await replacement.connect() }
    }

    /// Learned-pin renewal can be shared with another connection. Only that TLS
    /// metadata may change; the configured client, credentials and route owner stay fixed.
    private func requireCurrentPreflightRoute(
        _ route: Route,
        endpoint: EndpointSnapshot,
        shutdownGeneration: UInt64) throws
    {
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        try Task.checkCancellation()
        guard let configuredConnection,
              route.matches(configuredConnection.endpoint),
              route.generation == self.routeGeneration,
              route.matches(config: endpoint.config),
              route.authority == endpoint.routeAuthority,
              route.deviceAuthGatewayID == endpoint.deviceAuthGatewayID,
              route.browserSession == endpoint.browserSession,
              GatewayTLSRoute.hasSameTrustPolicy(route.tls, endpoint.tls)
        else { throw CancellationError() }
    }

    private func retryRequest(
        after initialError: Error,
        shutdownGeneration: UInt64,
        operation: @Sendable () async throws -> Data) async throws -> Data
    {
        var lastError = initialError
        for delayMs in Self.requestRetryDelaysMs {
            try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            try requireCurrentShutdownGeneration(shutdownGeneration)
            do {
                return try await operation()
            } catch {
                try requireCurrentShutdownGeneration(shutdownGeneration)
                // Preserve the authoritative rejection before a later retry can
                // replace update guidance with an unrelated transport failure.
                if GatewayCompatibilityIssue(error: error) != nil { throw error }
                lastError = error
            }
        }
        throw lastError
    }

    /// Route-bound requests never reconfigure or retry on another endpoint.
    /// Durable outbox rows must remain owned by the gateway that created them.
    func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double? = nil,
        ifCurrentRoute route: Route,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> Data
    {
        let endpoint = try await currentEndpoint()
        guard self.routeMatchesCurrentState(route, endpoint: endpoint),
              let client = self.configuredConnection?.client
        else {
            if distinguishPreDispatchRouteChange {
                throw OpenClawChatTransportSendError.notDispatched
            }
            throw CancellationError()
        }
        let result: Result<Data, Error>
        do {
            result = try await .success(self.sendRequest(
                client: client, route: route, method: method, params: params, timeoutMs: timeoutMs))
        } catch {
            result = .failure(error)
        }
        // A late error has the same route authority as a late payload.
        // Revalidate before either outcome reaches a replacement owner.
        guard await self.isCurrentRoute(route), self.configuredConnection?.client === client else {
            throw CancellationError()
        }
        return try result.get()
    }

    func createRealtimeTalkSession(
        params: [String: AnyCodable]?,
        timeoutMs: Double,
        operatorBinding binding: MacGatewayOperatorBinding) async throws -> Data
    {
        guard binding.connection === self, await self.isCurrentServerLease(binding.lease),
              binding.isCurrent, !Task.isCancelled else { throw OpenClawChatTransportSendError.notDispatched }
        return try await binding.lease.client.request(
            method: "talk.session.create",
            params: params,
            timeoutMs: timeoutMs,
            ifCurrentConnectionGeneration: binding.lease.socketGeneration,
            admission: binding.selection.admission)
    }

    /// Server-bound requests never reconfigure, reconnect, or cross onto a
    /// replacement socket at the same endpoint.
    func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double? = nil,
        ifCurrentServerLease lease: ServerLease,
        admission: WebSocketRequestAdmission? = nil,
        ifCurrent: @Sendable () -> Bool = { true }) async throws -> Data
    {
        guard await isCurrentServerLease(lease), ifCurrent(), !Task.isCancelled else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        // Untagged channel cancellation can follow a send. Only the guard above
        // proves this wrapper rejected the request before dispatch.
        let result: Result<Data, Error>
        do {
            result = try await .success(lease.client.request(
                method: method,
                params: params,
                timeoutMs: timeoutMs,
                ifCurrentConnectionGeneration: lease.socketGeneration,
                admission: admission))
        } catch {
            result = .failure(error)
        }
        // A late error has the same route authority as a late payload.
        // Revalidate before either outcome reaches a replacement owner.
        guard await self.isCurrentServerLease(lease), ifCurrent(), !Task.isCancelled else {
            throw CancellationError()
        }
        return try result.get()
    }
}

extension GatewayConnection {
    enum WizardCancellationOutcome: Equatable {
        case cancelled
        case absent
        case unresolved
    }

    /// Cancel on the socket that created the wizard, or a replacement socket on
    /// the same route. Absence stays distinct so callers can reconcile a commit.
    @discardableResult
    func cancelWizardSession(
        _ sessionID: String,
        on lease: ServerLease) async -> WizardCancellationOutcome
    {
        let initial = await sendWizardCancellation(sessionID, on: lease)
        if initial != .unresolved {
            return initial
        }
        guard let replacement = try? await acquireServerLease(
            ifSameRouteAs: lease,
            timeoutMs: 5000)
        else { return .unresolved }
        return await self.sendWizardCancellation(sessionID, on: replacement)
    }

    private func sendWizardCancellation(
        _ sessionID: String,
        on lease: ServerLease) async -> WizardCancellationOutcome
    {
        do {
            let data = try await lease.client.request(
                method: "wizard.cancel",
                params: ["sessionId": AnyCodable(sessionID)],
                timeoutMs: 10000,
                ifCurrentConnectionGeneration: lease.socketGeneration)
            let status = try decoder.decode(WizardCancellationStatus.self, from: data)
            return switch status.status {
            case "cancelled": .cancelled
            case "running": .unresolved
            default: .absent
            }
        } catch {
            return Self.wizardCancellationOutcome(after: error)
        }
    }

    static func wizardCancellationOutcome(after error: Error) -> WizardCancellationOutcome {
        guard let response = error as? GatewayResponseError else { return .unresolved }
        let sessionIsAbsent = response.method == "wizard.cancel" &&
            response.code == "INVALID_REQUEST" &&
            response.message == "wizard not found"
        return sessionIsAbsent ? .absent : .unresolved
    }

    private struct WizardCancellationStatus: Decodable {
        let status: String
    }

    func requestRaw(
        method: Method,
        params: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil) async throws -> Data
    {
        try await self.request(method: method.rawValue, params: params, timeoutMs: timeoutMs)
    }

    func requestDecoded<T: Decodable>(
        method: Method,
        params: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil,
        ifCurrentRoute route: Route? = nil) async throws -> T
    {
        let data: Data
        if let route {
            data = try await self.request(
                method: method.rawValue,
                params: params,
                timeoutMs: timeoutMs,
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: true)
            guard await self.isCurrentRoute(route) else {
                throw GatewayRouteChangedAfterDispatchError(method: method.rawValue)
            }
        } else {
            data = try await self.requestRaw(method: method, params: params, timeoutMs: timeoutMs)
        }
        do {
            return try self.decoder.decode(T.self, from: data)
        } catch {
            throw GatewayDecodingError(method: method.rawValue, message: error.localizedDescription)
        }
    }

    func requestVoid(
        method: Method,
        params: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil) async throws
    {
        _ = try await self.requestRaw(method: method, params: params, timeoutMs: timeoutMs)
    }

    /// Ensure the underlying socket is configured (and replaced if config changed).
    func refresh() async throws {
        let shutdownGeneration = shutdownGeneration
        let endpoint = try await currentEndpoint()
        _ = try await self.configure(
            endpoint: endpoint,
            shutdownGeneration: shutdownGeneration)
    }

    func captureRoute() async -> Route? {
        try? await self.captureRequiredRoute()
    }

    func captureRequiredRoute() async throws -> Route {
        let shutdownGeneration = shutdownGeneration
        let endpoint = try await currentEndpoint()
        _ = try await self.configure(
            endpoint: endpoint,
            shutdownGeneration: shutdownGeneration)
        return Route(
            endpoint: endpoint,
            generation: self.routeGeneration,
            activationBindingKey: self.configuredConnection?.activationBindingKey)
    }

    /// Connect and bind subsequent work to the hello snapshot's physical
    /// socket. The read-only health preflight intentionally uses the ordinary
    /// recovery path so a fresh local Gateway can start and a remote tunnel can
    /// recover before onboarding freezes the successful physical connection.
    func acquireServerLease() async throws -> ServerLease {
        try await self.acquireServerLease(timeoutMs: 15000, retryTransportFailures: true)
    }

    /// Captures the currently connected physical socket without probing or
    /// reconnecting. Queued mutations use this so waiting cannot retarget them.
    func captureServerLease() async -> ServerLease? {
        guard let route = await self.captureRoute(),
              let client = self.configuredConnection?.client,
              let socketGeneration = self.socketGenerationState.activeGeneration
        else { return nil }
        let lease = ServerLease(
            route: route,
            socketGeneration: socketGeneration,
            endpointRevision: self.configuredConnection?.endpoint.revision,
            client: client)
        guard await self.isCurrentServerLease(lease) else { return nil }
        return lease
    }

    func acquireServerLease(
        timeoutMs: Double,
        retryTransportFailures: Bool,
        preflightRoute: Route? = nil) async throws -> ServerLease
    {
        let shutdownGeneration = self.shutdownGeneration
        _ = try await self.request(
            method: Method.health.rawValue,
            params: nil,
            timeoutMs: timeoutMs,
            retryTransportFailures: retryTransportFailures,
            preflightRoute: preflightRoute)
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        let endpoint = try await currentEndpoint()
        guard let client = configuredClient(
            endpoint: endpoint,
            shutdownGeneration: shutdownGeneration)
        else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard let socketGeneration = await client.currentConnectionGeneration() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard let authBinding = await client.authBinding(
            ifCurrentConnectionGeneration: socketGeneration)
        else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let lease = ServerLease(
            route: Route(
                endpoint: endpoint,
                generation: routeGeneration,
                activationBindingKey: self.configuredConnection?.activationBindingKey,
                authBinding: authBinding),
            socketGeneration: socketGeneration,
            endpointRevision: endpoint.revision,
            client: client)
        guard await self.isCurrentServerLease(lease) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        return lease
    }

    /// Reconnect one physical socket without crossing the route that owned the
    /// original request. Endpoint or credential changes must start fresh work.
    func acquireServerLease(
        ifSameRouteAs previous: ServerLease,
        timeoutMs: Double) async throws -> ServerLease
    {
        guard await self.isCurrentRoute(previous.route) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        // Restart reconciliation owns its overall deadline. One short, non-retrying
        // health request keeps a failed attempt from consuming the whole budget.
        let replacement = try await acquireServerLease(
            timeoutMs: timeoutMs,
            retryTransportFailures: false)
        guard replacement.route.generation == previous.route.generation,
              replacement.route.url == previous.route.url,
              replacement.route.token == previous.route.token,
              replacement.route.password == previous.route.password,
              replacement.route.browserSession == previous.route.browserSession,
              GatewayTLSRoute.hasSameConnectionIdentity(replacement.route.tls, previous.route.tls),
              replacement.route.deviceAuthGatewayID == previous.route.deviceAuthGatewayID
        else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        return replacement
    }

    func isCurrentRoute(_ route: Route) async -> Bool {
        guard let endpoint = try? await currentEndpoint() else { return false }
        return self.routeMatchesCurrentState(route, endpoint: endpoint)
    }

    func supportsServerCapability(
        _ capability: GatewayServerCapability,
        ifCurrentRoute route: Route) async -> Bool?
    {
        guard let endpoint = try? await currentEndpoint() else { return nil }
        guard self.routeMatchesCurrentState(route, endpoint: endpoint),
              let snapshot = lastSnapshot
        else { return nil }
        return snapshot.supportsServerCapability(capability)
    }

    func supportsServerCapability(
        _ capability: GatewayServerCapability,
        ifCurrentServerLease lease: ServerLease) async -> Bool?
    {
        guard await self.isCurrentServerLease(lease),
              self.serverLeaseMatchesCurrentState(lease),
              let snapshot = lastSnapshot
        else { return nil }
        return snapshot.supportsServerCapability(capability)
    }

    func supportsServerMethod(
        _ method: String,
        ifCurrentServerLease lease: ServerLease) async -> Bool?
    {
        guard await self.isCurrentServerLease(lease),
              self.serverLeaseMatchesCurrentState(lease),
              let snapshot = lastSnapshot
        else { return nil }
        return snapshot.advertisedServerMethods()?.contains(method)
    }

    func isCurrentServerLease(_ lease: ServerLease) async -> Bool {
        guard let endpoint = try? await currentEndpoint(),
              serverLeaseMatchesCurrentState(lease),
              lease.route.matches(endpoint),
              await lease.client.currentConnectionGeneration() == lease.socketGeneration,
              serverLeaseMatchesCurrentState(lease)
        else { return false }
        return true
    }

    func activationOwnershipFingerprint(
        ifCurrentServerLease lease: ServerLease) async -> String?
    {
        guard await self.isCurrentServerLease(lease) else { return nil }
        return lease.route.activationOwnershipFingerprint
    }

    nonisolated var selectedEndpointRevision: UInt64? {
        self.endpointObservation.access(self, keyPath: \.selectedEndpointRevision)
        return self.currentEndpointRevision?()
    }

    nonisolated func serverLeaseMatchesCurrentState(_ lease: ServerLease) -> Bool {
        self.publicationIsCurrent(lease, connected: true)
    }

    /// Durable intents survive socket reconnects, but not configured-client retirement.
    /// Reads and ephemeral approvals still require the exact connected server lease.
    nonisolated func serverLeaseMatchesCurrentRoute(_ lease: ServerLease) -> Bool {
        guard lease.route.browserSession.map({ $0.expiresAt > Date() }) ?? true else { return false }
        let current: ServerLease
        switch self.connectionPublication.value {
        case let .connected(connection): current = connection.lease
        case let .disconnected(disconnected): current = disconnected
        case .retired, nil: return false
        }
        guard current.client === lease.client, current.route.generation == lease.route.generation else { return false }
        return self.selectedEndpointRevision.map { $0 == current.endpointRevision } ?? true
    }

    private nonisolated func publicationIsCurrent(_ lease: ServerLease, connected: Bool) -> Bool {
        guard lease.route.browserSession.map({ $0.expiresAt > Date() }) ?? true else { return false }
        let current: ServerLease? = switch (self.connectionPublication.value, connected) {
        case let (.connected(connection), true): connection.lease
        case let (.disconnected(lease), false), let (.retired(lease), false): lease
        default: nil
        }
        guard current == lease else { return false }
        return self.selectedEndpointRevision.map { $0 == lease.endpointRevision } ?? true
    }

    private func routeMatchesCurrentState(_ route: Route, endpoint: EndpointSnapshot) -> Bool {
        guard let configuredConnection else { return false }
        return route.matches(endpoint) && route.generation == self.routeGeneration &&
            route.matches(configuredConnection.endpoint)
    }

    func sessionRoutingIdentity(
        ifCurrentRoute route: Route) async throws -> OpenClawChatSessionRoutingIdentity
    {
        let data = try await request(
            OpenClawChatGatewayRequests.agentsList(),
            ifCurrentRoute: route)
        return try OpenClawChatGatewayPayloadCodec.decodeSessionRoutingIdentity(data)
    }

    func configuredGatewayURL() -> URL? {
        self.configuredConnection?.endpoint.config.url
    }

    var configuredPersonalTailscaleAuthentication: Bool {
        self.configuredConnection?.endpoint.personalTailscaleAuthentication == true
    }

    func configuredTLSFingerprintSHA256() -> String? {
        self.configuredConnection?.tlsMetadataProvider?.effectiveTLSFingerprintSHA256
    }

    func authSource() async -> GatewayAuthSource? {
        guard let connection = self.configuredConnection else { return nil }
        return await connection.client.authSource()
    }

    func clearConnectFailureBackoff() async {
        await self.configuredConnection?.client.clearConnectFailureBackoff()
    }

    func shutdown(ifCurrent: @Sendable () -> Bool = { true }) async {
        // Revalidate at the socket owner, after the actor hop: a superseded
        // credential save must not disconnect a newer same-account renewal.
        guard ifCurrent() else { return }
        let client = self.retireConfiguredConnection(disconnection: .disconnected(nil))
        self.shutdownGeneration &+= 1
        if let client {
            await self.clientShutdown(client)
        }
    }

    private func configure(
        endpoint: EndpointSnapshot,
        shutdownGeneration: UInt64) async throws -> GatewayChannelActor
    {
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        let config = endpoint.config
        let browserSession = endpoint.browserSession
        let personal = endpoint.personalTailscaleAuthentication
        if personal {
            try MacGatewayProfileStore.validatePersonalTailscaleURL(config.url)
            guard config.token == nil, config.password == nil, browserSession == nil else {
                throw CancellationError()
            }
        }
        try browserSession?.validate(for: config.url)
        if let client = configuredClient(
            endpoint: endpoint,
            shutdownGeneration: shutdownGeneration)
        {
            return client
        }
        let previousClient = self.retireConfiguredConnection()
        let configuredRouteGeneration = self.routeGeneration
        if let previousClient {
            await self.clientShutdown(previousClient)
        }
        try self.requireCurrentShutdownGeneration(shutdownGeneration)
        if self.routeGeneration != configuredRouteGeneration {
            if let client = configuredClient(
                endpoint: endpoint,
                shutdownGeneration: shutdownGeneration)
            {
                return client
            }
            throw CancellationError()
        }
        let activationBindingKey = self.activationBindingKeyProvider()
        let sessionBox: WebSocketSessionBox? = if personal {
            self.sessionProvider(nil) ?? WebSocketSessionBox(session: GatewayTLSPinningSession(
                params: GatewayTLSParams(
                    required: true, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
                allowsRedirects: false,
                allowsStoredCredentials: false))
        } else {
            self.sessionProvider(browserSession == nil ? endpoint.tls : nil) ?? browserSession.map { _ in
                WebSocketSessionBox(session: GatewayTLSPinningSession(
                    params: GatewayTLSParams(
                        required: true, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
                    allowsRedirects: false,
                    allowsStoredCredentials: false))
            }
        }
        let client = GatewayChannelActor(
            url: config.url,
            token: browserSession == nil ? config.token : nil,
            password: browserSession == nil ? config.password : nil,
            authBindingKey: activationBindingKey,
            session: sessionBox,
            connectSnapshotAdmissionHandler: { [weak self] snapshot, socketGeneration in
                await self?.admitConnectSnapshot(
                    snapshot,
                    routeGeneration: configuredRouteGeneration,
                    socketGeneration: socketGeneration)
            },
            pushHandler: { [weak self] push, socketGeneration in
                await self?.handle(
                    push: push,
                    routeGeneration: configuredRouteGeneration,
                    socketGeneration: socketGeneration)
            },
            connectOptions: GatewayConnectOptions(
                role: "operator",
                scopes: GatewayChannelActor.defaultOperatorConnectScopes,
                caps: Self.operatorClientCaps,
                commands: [],
                permissions: [:],
                clientId: "openclaw-macos",
                clientMode: "ui",
                clientDisplayName: InstanceIdentity.displayName,
                includeDeviceIdentity: self.includeDeviceIdentity,
                allowStoredDeviceAuth: !personal && browserSession == nil && endpoint.deviceAuthGatewayID != nil,
                deviceAuthGatewayID: browserSession == nil ? endpoint.deviceAuthGatewayID : nil,
                requiredAuthMethod: personal ? .tailscale : nil),
            disconnectHandler: { [weak self] reason, socketGeneration in
                await self?.handleDisconnect(
                    routeGeneration: configuredRouteGeneration,
                    socketGeneration: socketGeneration,
                    reason: reason)
            },
            extraHeadersProvider: browserSession.map { session in
                { @Sendable in (try? session.headers(for: config.url)) ?? [:] }
            },
            reconnectTLSFailureHandler: { [weak self] error in
                await self?.renewLearnedPinAfterReconnectFailure(error, routeGeneration: configuredRouteGeneration)
            })
        self.configuredConnection = ConfiguredConnection(
            client: client,
            endpoint: endpoint,
            tlsMetadataProvider: sessionBox?.session as? GatewayTLSRouteMetadataProviding,
            shutdownGeneration: shutdownGeneration,
            activationBindingKey: activationBindingKey)
        if let browserSession {
            self.browserSessionExpiryTask = Task { [weak self] in
                do {
                    try await Task.sleep(for: .seconds(max(0, browserSession.expiresAt.timeIntervalSinceNow)))
                    await self?.expireBrowserSession(routeGeneration: configuredRouteGeneration)
                } catch {}
            }
        }
        return client
    }

    private func expireBrowserSession(routeGeneration: UInt64) async {
        guard self.routeGeneration == routeGeneration,
              self.configuredConnection?.endpoint.browserSession != nil else { return }
        let reason = GatewayBrowserSessionError.expired.localizedDescription
        if let client = self.retireConfiguredConnection(disconnection: .disconnected(reason)) {
            await self.clientShutdown(client)
        }
    }

    private func configuredClient(
        endpoint: EndpointSnapshot,
        shutdownGeneration: UInt64) -> GatewayChannelActor?
    {
        guard let connection = self.configuredConnection,
              connection.matches(
                  endpoint: endpoint,
                  shutdownGeneration: shutdownGeneration)
        else { return nil }
        // Equivalent routes can acquire a new endpoint revision without reconnecting.
        // An older waiter must not roll the recorded connection owner backward.
        if endpoint.revision == self.highestEndpointRevision {
            self.configuredConnection?.endpoint = endpoint
        }
        return connection.client
    }

    /// Invalidate every route-owned fact before shutdown can suspend; otherwise
    /// reentrant work could continue on a client whose replacement is in flight.
    private func retireConfiguredConnection(disconnection: PushDelivery.Event? = nil) -> GatewayChannelActor? {
        self.personalVerificationTask?.cancel()
        self.personalVerificationTask = nil
        self.verifiedPersonalSocketGeneration = nil
        self.browserSessionExpiryTask?.cancel()
        self.browserSessionExpiryTask = nil
        self.retirePublication(disconnection: disconnection, retiresRoute: true)
        self.routeGeneration &+= 1
        self.finishRealtimeTalkSubscribers()
        self.socketGenerationState = GatewaySocketGenerationState()
        self.lastSnapshot = nil
        self.resetCanvasPluginSurfaceState()
        let client = self.configuredConnection?.client
        self.configuredConnection = nil
        return client
    }

    private func requireCurrentShutdownGeneration(_ shutdownGeneration: UInt64) throws {
        guard self.shutdownGeneration == shutdownGeneration else {
            throw CancellationError()
        }
    }

    private func handle(
        push: GatewayPush,
        routeGeneration: UInt64,
        socketGeneration: UInt64)
    {
        guard routeGeneration == self.routeGeneration,
              self.socketGenerationState.admit(socketGeneration)
        else { return }
        broadcast(push)
    }

    /// Short connect-path admission only. Subscriber delivery stays on the
    /// ordinary push task so connect never waits on downstream UI work.
    private func admitConnectSnapshot(
        _ snapshot: HelloOk,
        routeGeneration: UInt64,
        socketGeneration: UInt64)
    {
        guard routeGeneration == self.routeGeneration,
              self.socketGenerationState.admit(socketGeneration)
        else { return }
        self.lastSnapshot = snapshot
        if let connection = self.configuredConnection, connection.endpoint.personalTailscaleAuthentication {
            let client = connection.client
            let route = Route(
                endpoint: connection.endpoint,
                generation: routeGeneration,
                activationBindingKey: connection.activationBindingKey)
            self.personalVerificationTask?.cancel()
            self.personalVerificationTask = Task { [weak self] in
                guard let self else { return }
                try? await self.verifyPersonalIdentity(client: client, route: route, timeoutMs: nil)
            }
        }
        self.installCanvasPluginSurfaceURL(from: snapshot)
    }

    private func handleDisconnect(
        routeGeneration: UInt64,
        socketGeneration: UInt64,
        reason: String = "gateway disconnected")
    {
        guard routeGeneration == self.routeGeneration,
              retireSocketGeneration(socketGeneration, reason: reason)
        else { return }
        self.finishRealtimeTalkSubscribers(socketGeneration: socketGeneration)
        self.personalVerificationTask?.cancel()
        self.personalVerificationTask = nil
        self.verifiedPersonalSocketGeneration = nil
        self.lastSnapshot = nil
        self.resetCanvasPluginSurfaceState()
    }
}

extension GatewayConnection {
    enum PersonalSignInError: LocalizedError {
        case unverified
        case accountChanged

        var errorDescription: String? {
            switch self {
            case .unverified:
                "The Gateway did not verify your personal account. Reconnect this saved Gateway."
            case .accountChanged:
                "Your personal account changed. Reconnect this saved Gateway to open a new session."
            }
        }
    }

    private func sendRequest(
        client: GatewayChannelActor,
        route: Route,
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double?) async throws -> Data
    {
        if let generation = try await self.verifyPersonalIdentity(client: client, route: route, timeoutMs: timeoutMs) {
            return try await client.request(
                method: method,
                params: params,
                timeoutMs: timeoutMs,
                ifCurrentConnectionGeneration: generation)
        }
        return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
    }

    @discardableResult
    private func verifyPersonalIdentity(
        client: GatewayChannelActor,
        route: Route,
        timeoutMs: Double?) async throws -> UInt64?
    {
        guard route.personalTailscaleAuthentication else { return nil }
        try await client.connect()
        let initialEndpoint = try await self.currentEndpoint()
        guard let generation = await client.currentConnectionGeneration(),
              self.configuredConnection?.client === client,
              self.routeMatchesCurrentState(route, endpoint: initialEndpoint),
              self.selectedEndpointRevision.map({ $0 == initialEndpoint.revision }) ?? true,
              let snapshot = self.lastSnapshot,
              snapshot.auth["method"]?.value as? String == "tailscale",
              let scope = snapshot.auth["recoveryScope"]?.value as? String,
              !scope.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { throw PersonalSignInError.unverified }
        if self.verifiedPersonalSocketGeneration == generation {
            guard self.socketGenerationState.activeGeneration == generation else { throw CancellationError() }
            return generation
        }
        let data = try await client.request(
            method: "users.self",
            params: [:],
            timeoutMs: timeoutMs,
            ifCurrentConnectionGeneration: generation)
        let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let endpoint = try await self.currentEndpoint()
        guard let profile = result?["profile"] as? [String: Any],
              let profileID = profile["id"] as? String, !profileID.isEmpty,
              await client.currentConnectionGeneration() == generation,
              self.configuredConnection?.client === client,
              self.socketGenerationState.activeGeneration == generation,
              self.routeMatchesCurrentState(route, endpoint: endpoint),
              self.selectedEndpointRevision.map({ $0 == endpoint.revision }) ?? true
        else { throw PersonalSignInError.unverified }
        let identity = PersonalIdentity(profileID: profileID, recoveryScope: scope)
        guard self.personalIdentity == nil || self.personalIdentity == identity else {
            throw PersonalSignInError.accountChanged
        }
        self.personalIdentity = identity
        self.verifiedPersonalSocketGeneration = generation
        self.publishConnectedServerLease()
        self.broadcast(.snapshot(snapshot))
        return generation
    }

    func personalChatStoreID(base: String) async throws -> String {
        guard let route = await self.captureRoute(), route.personalTailscaleAuthentication else { return base }
        let lease = try await self.acquireServerLease(
            timeoutMs: 15000,
            retryTransportFailures: false,
            preflightRoute: route)
        guard let identity = self.personalIdentity, await self.isCurrentServerLease(lease) else {
            throw PersonalSignInError.unverified
        }
        let digest = SHA256.hash(data: Data(identity.profileID.utf8)).map { String(format: "%02x", $0) }.joined()
        return "\(base):person:\(digest)"
    }

    func personalRecoveryScope(ifCurrentServerLease lease: ServerLease) async throws -> String {
        guard lease.route.personalTailscaleAuthentication,
              self.verifiedPersonalSocketGeneration == lease.socketGeneration,
              let identity = self.personalIdentity,
              await self.isCurrentServerLease(lease)
        else { throw PersonalSignInError.unverified }
        return identity.recoveryScope
    }
}

extension GatewayConnection {
    private func retireSocketGeneration(_ socketGeneration: UInt64, reason: String) -> Bool {
        guard self.socketGenerationState.accepts(socketGeneration) else { return false }
        self.retirePublication(disconnection: .disconnected(reason), retiresRoute: false)
        return self.socketGenerationState.retire(socketGeneration)
    }

    #if DEBUG
    func _test_routeGeneration() -> UInt64 {
        self.routeGeneration
    }

    func _test_configuredURL() -> URL? {
        self.configuredConnection?.endpoint.config.url
    }

    func _test_waitForSubscriber() async {
        guard self.subscribers.isEmpty else { return }
        await withCheckedContinuation { continuation in
            self.subscriberWaitersForTesting.append(continuation)
        }
    }

    func _test_handlePush(
        _ push: GatewayPush,
        routeGeneration: UInt64? = nil,
        socketGeneration: UInt64)
    {
        self.handle(
            push: push,
            routeGeneration: routeGeneration ?? self.routeGeneration,
            socketGeneration: socketGeneration)
    }

    func _test_handleDisconnect(
        routeGeneration: UInt64? = nil,
        socketGeneration: UInt64)
    {
        self.handleDisconnect(
            routeGeneration: routeGeneration ?? self.routeGeneration,
            socketGeneration: socketGeneration)
    }
    #endif

    private static func defaultEndpointProvider() async throws -> EndpointSnapshot {
        try await GatewayEndpointStore.shared.requireEndpoint()
    }

    func adoptSelectedEndpoint() async throws {
        while true {
            let revision = self.currentEndpointRevision?()
            try self.acceptEndpointRevision(revision)
            guard let revision, let connection = self.configuredConnection,
                  connection.endpoint.revision != revision else { return }
            // Retire before shutdown suspends, including selections that never become ready.
            if let client = self.retireConfiguredConnection() { await self.clientShutdown(client) }
            // A newer selection or configured client may have arrived during shutdown.
        }
    }

    private func currentEndpoint() async throws -> EndpointSnapshot {
        try await self.adoptSelectedEndpoint()
        let endpoint: EndpointSnapshot
        do {
            endpoint = try await self.endpointProvider()
        } catch {
            try await self.adoptSelectedEndpoint()
            throw error
        }
        try await self.adoptSelectedEndpoint()
        try self.acceptEndpointRevision(endpoint.revision)
        try endpoint.browserSession?.validate(for: endpoint.config.url)
        return endpoint
    }

    private func acceptEndpointRevision(_ revision: UInt64?) throws {
        guard let revision else { return }
        if let highestEndpointRevision, revision < highestEndpointRevision {
            throw CancellationError()
        }
        if highestEndpointRevision.map({ revision > $0 }) ?? true {
            // Cached UI reads use the live revision; admission also invalidates
            // observers when the old source never produced a physical lease.
            self.endpointObservation.withMutation(of: self, keyPath: \.selectedEndpointRevision) {
                self.highestEndpointRevision = revision
            }
        }
    }
}

// MARK: - Snapshot cache and subscriptions

extension GatewayConnection {
    func controlUiAuthBinding(ifCurrentServerLease lease: ServerLease) async throws -> GatewayAuthBinding {
        guard await self.isCurrentServerLease(lease),
              let binding = await lease.client.authBinding(ifCurrentConnectionGeneration: lease.socketGeneration),
              await self.isCurrentServerLease(lease)
        else { throw CancellationError() }
        return binding
    }

    func sourceResourceBearer(ifCurrentServerLease lease: ServerLease) async throws -> String? {
        guard await self.isCurrentServerLease(lease) else { throw CancellationError() }
        let bearer = await lease.client.httpResourceBearer(ifCurrentConnectionGeneration: lease.socketGeneration)
        guard await self.isCurrentServerLease(lease) else { throw CancellationError() }
        return bearer
    }

    func controlUiAutoAuthToken(config: Config) async -> String? {
        guard let endpoint = try? await currentEndpoint(),
              endpoint.browserSession == nil,
              endpoint.config.url == config.url,
              endpoint.config.token == config.token,
              endpoint.config.password == config.password,
              let client = self.configuredConnection?.client,
              let socketGeneration = self.socketGenerationState.activeGeneration,
              controlUiRouteIsLive(
                  endpoint: endpoint,
                  client: client,
                  socketGeneration: socketGeneration),
              await client.currentConnectionGeneration() == socketGeneration,
              controlUiRouteIsLive(
                  endpoint: endpoint,
                  client: client,
                  socketGeneration: socketGeneration),
              let authBinding = await client.authBinding(
                  ifCurrentConnectionGeneration: socketGeneration),
              controlUiRouteIsLive(
                  endpoint: endpoint,
                  client: client,
                  socketGeneration: socketGeneration)
        else { return nil }

        switch authBinding.source {
        case .sharedToken:
            return config.token?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        case .deviceToken:
            guard let gatewayID = configuredConnection?.endpoint.deviceAuthGatewayID?
                .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            else { return nil }
            if let deviceToken = lastSnapshot?.auth["deviceToken"]?.value as? String,
               let token = deviceToken.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            {
                return token
            }
            guard let identity = DeviceIdentityStore.loadOrCreatePersisted() else { return nil }
            return DeviceAuthStore.loadToken(
                deviceId: identity.deviceId,
                role: "operator",
                gatewayID: gatewayID)?.token
                .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        case .bootstrapToken, .password, .none:
            return nil
        }
    }

    private func controlUiRouteIsLive(
        endpoint: EndpointSnapshot,
        client: GatewayChannelActor,
        socketGeneration: UInt64) -> Bool
    {
        self.configuredConnection?.matches(
            endpoint: endpoint,
            shutdownGeneration: self.shutdownGeneration) == true &&
            self.configuredConnection?.client === client &&
            self.socketGenerationState.activeGeneration == socketGeneration &&
            self.lastSnapshot != nil
    }

    func cachedGatewayVersion() -> String? {
        (self.lastSnapshot?.server["version"]?.value as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    func connectionSummary() -> (connected: Bool, gatewayVersion: String?) {
        guard case .connected = self.connectionPublication.value else { return (false, nil) }
        return (true, self.cachedGatewayVersion())
    }

    func currentAttachmentLimits() -> GatewayAttachmentLimits? {
        // Staging reads the admitted hello; endpoint recovery must not delay local file preparation.
        guard case let .connected(connection) = self.connectionPublication.value,
              self.serverLeaseMatchesCurrentState(connection.lease)
        else { return nil }
        return self.lastSnapshot?.advertisedAttachmentLimits()
    }

    func cachedGatewayVersion(ifCurrentServerLease lease: ServerLease) async -> String? {
        guard await self.isCurrentServerLease(lease) else { return nil }
        return self.cachedGatewayVersion()
    }

    func subscribe(bufferingNewest: Int = 100) -> AsyncStream<PushDelivery> {
        let id = UUID()
        let snapshot = self.lastSnapshot
        let connection = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
            if let snapshot, let delivery = self.makePushDelivery(.snapshot(snapshot)) {
                continuation.yield(delivery)
            }
            self.subscribers[id] = continuation
            #if DEBUG
            let waiters = self.subscriberWaitersForTesting
            self.subscriberWaitersForTesting.removeAll()
            for waiter in waiters {
                waiter.resume()
            }
            #endif
            continuation.onTermination = { @Sendable _ in
                Task { await connection.removeSubscriber(id) }
            }
        }
    }

    private func removeSubscriber(_ id: UUID) {
        self.subscribers[id] = nil
    }

    func makePushDelivery(_ push: GatewayPush) -> PushDelivery? {
        guard case let .connected(connection) = self.connectionPublication.value else { return nil }
        let lease = connection.lease
        let terminal = push.isTerminalChatEvent
        return PushDelivery(
            event: .push(push),
            serverLease: lease,
            mainSessionKey: connection.mainSessionKey,
            currentOwner: { [weak self] in
                // Accepted outcomes outlive socket recovery, but never their configured route.
                if terminal {
                    return self?.serverLeaseMatchesCurrentRoute(lease) == true
                }
                return self?.serverLeaseMatchesCurrentState(lease) == true
            })
    }

    private func retirePublication(disconnection: PushDelivery.Event?, retiresRoute: Bool) {
        self.invalidateSourceResources()
        let lease = self.connectionPublication.withValue { publication -> ServerLease? in
            let lease: ServerLease? = switch publication {
            case let .connected(connection): connection.lease
            case let .disconnected(lease), let .retired(lease): lease
            case nil: nil
            }
            // Keep intentional shutdown visible without preserving its ended route.
            publication = disconnection == nil ? nil : lease.map {
                retiresRoute ? .retired($0) : .disconnected($0)
            }
            return lease
        }
        // HTTP media belongs to this socket lease just like its ticket RPC.
        // Cancel before notifying observers, including requests still waiting for headers.
        for transfer in self.managedMediaTransfers.values {
            transfer.cancel()
        }
        self.managedMediaTransfers.removeAll()
        guard let lease else { return }
        // The terminal outcome survives its socket, but a replacement owner
        // invalidates it before it can degrade the newly selected Gateway.
        let delivery = PushDelivery(
            event: disconnection ?? .disconnected(nil),
            serverLease: lease,
            mainSessionKey: nil,
            currentOwner: { [weak self] in
                self?.publicationIsCurrent(lease, connected: false) == true
            })
        for continuation in self.subscribers.values {
            continuation.yield(delivery)
        }
    }

    private func invalidateSourceResources() {
        self.sourceResourceRevision &+= 1
        let loader = self.sourceResources?.loader
        self.sourceResources = nil
        if let loader { Task { await loader.invalidate() } }
    }

    private func broadcast(_ push: GatewayPush) {
        if case let .event(event) = push,
           event.event == "chat.metadata.changed" || event.event == "config.changed"
        {
            self.invalidateSourceResources()
        }
        if case let .snapshot(snapshot) = push {
            self.lastSnapshot = snapshot
            if self.canvasPluginSurfaceURL == nil {
                self.installCanvasPluginSurfaceURL(from: snapshot)
            }
        }
        guard let delivery = self.makePushDelivery(push) else { return }
        for (_, continuation) in self.subscribers {
            continuation.yield(delivery)
        }
        if case .event = push, let socketGeneration = self.socketGenerationState.activeGeneration {
            for (id, continuation) in self.realtimeTalkSubscribers[socketGeneration] ?? [:] {
                if case .enqueued = continuation.yield(delivery) { continue }
                continuation.finish()
                self.removeRealtimeTalkSubscriber(id, socketGeneration: socketGeneration)
            }
        }
    }
}
