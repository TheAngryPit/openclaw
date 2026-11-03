import Foundation
import OpenClawChatUI
import OpenClawProtocol

extension TalkModeRuntime {
    func admitTalkOperator(generation: Int) async throws {
        guard self.usesSelectedOperator else { return }
        if let operatorBinding {
            guard operatorBinding.isCurrent else { throw CancellationError() }
            return
        }
        let selection = await self.operatorSelection()
        guard self.isCurrent(generation) else { throw CancellationError() }
        let snapshot: MacGatewaySelectionPreferences.Snapshot
        if let existing = self.operatorSnapshot {
            snapshot = existing
        } else {
            snapshot = await selection.snapshot()
            guard self.isCurrent(generation) else { throw CancellationError() }
            self.operatorSnapshot = snapshot
        }
        let binding = try await MacGatewayOperatorBinding.capture(
            selection: selection, snapshot: snapshot, connectionProvider: self.operatorConnectionProvider)
        guard self.isCurrent(generation), binding.isCurrent else { throw CancellationError() }
        self.operatorBinding = binding
        self.operatorRetirementTask = Task { [weak self] in
            for await _ in binding.selection.admission.retirement() {}
            guard !Task.isCancelled else { return }
            await self?.retireTalkOperator(generation: generation)
        }
        self.operatorConnectionTask = Task { [weak self] in
            let stream = await binding.connection.subscribe()
            guard !Task.isCancelled else { return }
            guard binding.isCurrent else {
                await self?.retireTalkOperator(generation: generation)
                return
            }
            for await _ in stream {
                guard !Task.isCancelled else { return }
                if !binding.isCurrent {
                    await self?.retireTalkOperator(generation: generation)
                    return
                }
            }
        }
    }

    func retireTalkOperator(generation: Int) async {
        guard self.lifecycleGeneration == generation, self.isEnabled else { return }
        self.isEnabled = false
        self.lifecycleGeneration &+= 1
        let retiredGeneration = self.lifecycleGeneration
        await self.stop(lifecycleGeneration: retiredGeneration)
        guard self.lifecycleGeneration == retiredGeneration else { return }
        self.clearTalkOperatorState()
        await MainActor.run { self.controller()?.operatorDidRetire() }
    }

    func requireTalkGateway() throws -> GatewayConnection {
        if self.usesSelectedOperator {
            guard let operatorBinding, operatorBinding.isCurrent else { throw CancellationError() }
            return operatorBinding.connection
        }
        guard let gateway else { throw CancellationError() }
        return gateway
    }

    func talkRequest(
        _ request: OpenClawChatGatewayRequest,
        ifCurrentRoute route: GatewayConnection.Route? = nil,
        generation: Int? = nil) async throws -> Data
    {
        guard generation.map(self.isCurrent) ?? true else { throw CancellationError() }
        if self.usesSelectedOperator {
            guard let operatorBinding else { throw CancellationError() }
            return try await operatorBinding.request(request)
        }
        return try await self.requireTalkGateway().request(request, ifCurrentRoute: route)
    }

    func captureTalkRoute() async throws -> GatewayConnection.Route {
        if let operatorBinding {
            guard operatorBinding.isCurrent else { throw CancellationError() }
            return operatorBinding.lease.route
        }
        return try await self.requireTalkGateway().captureRequiredRoute()
    }

    func isCurrentTalkRoute(_ route: GatewayConnection.Route) async -> Bool {
        if let operatorBinding { return operatorBinding.isCurrent && operatorBinding.lease.route == route }
        guard let gateway = try? self.requireTalkGateway() else { return false }
        return await gateway.isCurrentRoute(route)
    }

    func talkSnapshot() async -> HelloOk? {
        guard let gateway = try? self.requireTalkGateway() else { return nil }
        return await gateway.lastSnapshot
    }

    func selectedTalkSession() async -> String? {
        if let operatorBinding {
            guard operatorBinding.isCurrent else { return nil }
            return await MainActor.run { WebChatManager.shared.activeSessionKey(for: operatorBinding.target) }
        }
        guard !self.usesSelectedOperator else { return nil }
        return await self.dependencies.selectedSession()
    }

    func talkMainSessionKey() async throws -> String {
        if let operatorBinding {
            return try await operatorBinding.connection.mainSessionKey(
                ifCurrentServerLease: operatorBinding.lease, admission: operatorBinding.selection.admission)
        }
        return try await self.requireTalkGateway().mainSessionKey()
    }
}
