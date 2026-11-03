import Foundation
import OpenClawChatUI
import OpenClawProtocol

struct MacGatewayOperatorBinding: Sendable, Equatable {
    let selection: MacGatewaySelectionPreferences.Snapshot
    let connection: GatewayConnection
    let lease: GatewayConnection.ServerLease

    var target: DashboardGatewayTarget {
        self.selection.target
    }

    var isCurrent: Bool {
        self.selection.isCurrent && self.connection.serverLeaseMatchesCurrentState(self.lease)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.selection.id == rhs.selection.id && lhs.connection === rhs.connection && lhs.lease.route == rhs.lease.route
    }

    @MainActor
    static func capture(
        selection: MacGatewaySelectionPreferences = .shared,
        snapshot: MacGatewaySelectionPreferences.Snapshot? = nil,
        connectionProvider: @Sendable (DashboardGatewayTarget) async -> GatewayConnection = {
            await DashboardManager.gatewayConnection(for: $0)
        }) async throws -> Self
    {
        let snapshot = snapshot ?? selection.snapshot()
        guard snapshot.isCurrent, !Task.isCancelled else { throw CancellationError() }
        let connection = await connectionProvider(snapshot.target)
        guard snapshot.isCurrent, !Task.isCancelled else { throw CancellationError() }
        let lease = try await connection.acquireServerLease()
        let binding = Self(selection: snapshot, connection: connection, lease: lease)
        guard binding.isCurrent, !Task.isCancelled else { throw CancellationError() }
        return binding
    }

    func request(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        guard self.isCurrent, !Task.isCancelled else { throw CancellationError() }
        return try await self.connection.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: self.lease,
            admission: self.selection.admission,
            ifCurrent: { self.isCurrent })
    }

    func request(method: String, params: [String: AnyCodable]? = nil) async throws -> Data {
        guard self.isCurrent, !Task.isCancelled else { throw CancellationError() }
        return try await self.connection.request(
            method: method,
            params: params,
            ifCurrentServerLease: self.lease,
            admission: self.selection.admission,
            ifCurrent: { self.isCurrent })
    }
}
