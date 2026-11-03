import Foundation
import OpenClawKit

@MainActor
final class MacGatewaySelectionPreferences {
    static let shared = MacGatewaySelectionPreferences(defaults: AppDefaults.standard)
    static let didChangeNotification = Notification.Name("openclaw.operator-selection.did-change")
    private static let profileKey = "openclaw.webchat.lastGatewayProfileID"
    private static let localKey = "openclaw.webchat.lastGatewayLocal"
    private let defaults: UserDefaults
    private var authorityID = UUID()
    private var authority = WebSocketRequestAdmission()
    private var principalObserver: NSObjectProtocol?

    struct Snapshot: Sendable {
        let id: UUID
        let target: DashboardGatewayTarget
        let admission: WebSocketRequestAdmission

        nonisolated var isCurrent: Bool {
            self.admission.isActive
        }
    }

    init(defaults: UserDefaults) {
        self.defaults = defaults
        self.principalObserver = NotificationCenter.default.addObserver(
            forName: MacGatewayProfileStore.willChangePrincipalNotification, object: nil, queue: .main)
        { [weak self] note in
            guard let profileID = note.userInfo?[MacGatewayProfileStore.changedProfileIDKey] as? String else { return }
            MainActor.assumeIsolated {
                guard let self, self.target == .profile(profileID) else { return }
                self.retireAuthority()
            }
        }
    }

    isolated deinit {
        self.authority.retire()
        if let principalObserver { NotificationCenter.default.removeObserver(principalObserver) }
    }

    func snapshot() -> Snapshot {
        Snapshot(id: self.authorityID, target: self.target, admission: self.authority)
    }

    private func retireAuthority(updatingSelection target: DashboardGatewayTarget? = nil) {
        self.authority.retire()
        if let target { self.persist(target) }
        self.authority = WebSocketRequestAdmission()
        self.authorityID = UUID()
        NotificationCenter.default.post(name: Self.didChangeNotification, object: self)
    }

    var profileID: String? {
        self.defaults.string(forKey: Self.profileKey)?.nonEmpty
    }

    var target: DashboardGatewayTarget {
        if self.defaults.bool(forKey: Self.localKey) {
            let state = AppStateStore.shared
            return state.connectionMode == .remote && state.hostsLocalGatewayWithRemotePrimary ? .local : .primary
        }
        return self.profileID.map(DashboardGatewayTarget.profile) ?? .primary
    }

    func select(_ target: DashboardGatewayTarget) {
        let previous = self.target
        if previous != target {
            self.retireAuthority(updatingSelection: target)
        } else {
            self.persist(target)
        }
    }

    private func persist(_ target: DashboardGatewayTarget) {
        self.defaults.set(target == .local, forKey: Self.localKey)
        switch target {
        case .primary, .local:
            self.defaults.removeObject(forKey: Self.profileKey)
        case let .profile(id):
            self.defaults.set(id, forKey: Self.profileKey)
        }
    }

    func forget(profileID: String) {
        guard self.profileID == profileID else { return }
        self.select(.primary)
    }
}
