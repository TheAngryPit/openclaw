import Foundation
import OpenClawChatUI
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct PersonalGatewayAuthenticationTests {
    private func config(personal: Bool) throws -> GatewayConnectConfig {
        try GatewayConnectConfig(
            url: #require(URL(string: "wss://gateway.example.ts.net")),
            stableID: "manual|gateway.example.ts.net|443",
            tls: nil,
            token: "synthetic-shared-token",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node", scopes: [], caps: [], commands: [], permissions: [:],
                clientId: "ios", clientMode: "node", clientDisplayName: "Phone",
                deviceAuthGatewayID: "manual|gateway.example.ts.net|443"),
            personalTailscaleAuthentication: personal)
    }

    @Test(arguments: [false, true])
    func `personal selection only changes operator authentication`(personal: Bool) throws {
        let config = try self.config(personal: personal)
        let credentials = config.operatorCredentials(fallback: .init(token: config.token))
        #expect(credentials.token == (personal ? nil : config.token))
        let options = config.operatorOptions(from: config.nodeOptions)
        #expect(options.requiredAuthMethod == (personal ? .tailscale : nil))
        #expect(options.deviceAuthGatewayID == config.nodeOptions.deviceAuthGatewayID)
        #expect(options.allowStoredDeviceAuth == !personal)
        #expect(config.nodeOptions.allowStoredDeviceAuth)
        #expect(config.nodeOptions.requiredAuthMethod == nil)
    }

    @Test(arguments: [false, true])
    func `embedded pages never load an older UI in personal mode`(personal: Bool) throws {
        let config = try self.config(personal: personal)
        #expect((AuthenticatedControlUI.pageURL(config: config, path: "settings", queryItems: []) == nil) == personal)
        #expect((ControlUIHubPage.terminal.url(config: config) == nil) == personal)
        #expect((ControlUIHubPage.desktop(source: nil, session: nil).url(config: config) == nil) == personal)
        #expect((SessionDashboardScreen.dashboardURL(config: config, sessionKey: "agent:main:chat") == nil) == personal)
    }

    @Test func `personal mode cannot create a legacy persistent transcript or outbox`() throws {
        let model = NodeAppModel()
        model.activeGatewayConnectConfig = try self.config(personal: true)
        #expect(model.chatTranscriptCacheGatewayID == nil)
        #expect(model.makeChatOfflineStore() == nil)
        model.adoptPersonalChatOwner(scope: "synthetic-person-a", stableID: "manual|gateway.example.ts.net|443")
        let owner = model.chatViewModelOwnerID
        model.setOperatorConnected(false)
        #expect(model.chatViewModelOwnerID == owner)
        model.adoptPersonalChatOwner(scope: "synthetic-person-a", stableID: "manual|gateway.example.ts.net|443")
        #expect(model.chatViewModelOwnerID == owner)
        model.adoptPersonalChatOwner(scope: "synthetic-person-b", stableID: "manual|gateway.example.ts.net|443")
        #expect(model.chatViewModelOwnerID != owner)
        #expect(model.makeChatOfflineStore() == nil)
    }

    @Test func `old saved gateways retain shared-owner authentication`() throws {
        let entry = try JSONDecoder().decode(
            GatewaySettingsStore.GatewayRegistryEntry.self,
            from: Data(
                #"{"stableID":"manual|gateway.example.ts.net|443","kind":"manual","name":"Gateway","host":"gateway.example.ts.net","port":443,"useTLS":true}"#
                    .utf8))
        #expect(entry.personalTailscaleAuthentication == nil)
    }

    @Test(arguments: [false, true])
    func `personal draft survives reconnect but cannot retain another person's authority`(changesPerson: Bool) throws {
        let model = NodeAppModel()
        model.enterScreenshotFixtureMode()
        let config = try self.config(personal: true)
        model.activeGatewayConnectConfig = config
        model.adoptPersonalChatOwner(scope: "synthetic-person-a", stableID: config.effectiveStableID)
        let owner = model.chatPresentation
        owner.sync(appModel: model)
        let original = try #require(owner.viewModel)
        defer { owner.viewModel?.detachTransport() }
        original.input = "Synthetic draft"
        let attachment = OpenClawPendingAttachment(
            url: nil, data: Data("fixture".utf8), fileName: "fixture.txt", mimeType: "text/plain", preview: nil)
        original.attachments = [attachment]
        model.setOperatorConnected(false)
        model.adoptPersonalChatOwner(
            scope: changesPerson ? "synthetic-person-b" : "synthetic-person-a", stableID: config.effectiveStableID)
        owner.sync(appModel: model)
        #expect(owner.viewModel === original)
        #expect(original.input == "Synthetic draft")
        #expect(original.attachments.map(\.id) == [attachment.id])
        #expect(original.isQuestionAuthorityRetired == changesPerson)
        original.removeAttachment(attachment.id)
        owner.sync(appModel: model)
        let current = try #require(owner.viewModel)
        #expect((current === original) == !changesPerson)
        #expect(current.input == (changesPerson ? "" : "Synthetic draft"))
    }

    @Test func `explicit personal mode retirement clears the verified draft owner`() throws {
        let model = NodeAppModel()
        let config = try self.config(personal: true)
        model.activeGatewayConnectConfig = config
        model.adoptPersonalChatOwner(scope: "synthetic-person-a", stableID: config.effectiveStableID)
        let previousOwner = model.chatViewModelOwnerID
        model.activeGatewayConnectConfig = nil
        model.activeGatewayConnectConfig = config
        #expect(model.chatViewModelOwnerID != previousOwner)
        #expect(model.chatViewModelOwnerID.contains("pending"))
    }

    @Test func `personal Watch admission never takes durable custody of a command`() async throws {
        let model = NodeAppModel()
        let journal = try await model.watchMessageJournal()
        model.activeGatewayConnectConfig = try self.config(personal: true)
        let commandID = UUID().uuidString
        let context = OpenClawWatchChatDeliveryContext(
            gatewayStableID: "manual|gateway.example.ts.net|443", routeGeneration: UUID().uuidString,
            agentId: "main", sessionKey: "main", deliverySessionKey: "agent:main:main",
            sessionRoutingContract: "synthetic-routing-contract")
        let command = OpenClawWatchChatDeliveryCommand(
            context: context, commandId: commandID, submittedAtMs: WatchMessagingPayloadCodec.nowMs(),
            body: .chat(text: "Synthetic Watch work"))
        do {
            try await model.admitWatchChatDelivery(command)
            Issue.record("Personal mode must reject machine-owned Watch work")
        } catch let error as WatchMessagingError {
            guard case .admissionUnavailable = error else {
                Issue.record("Unexpected Watch admission error")
                return
            }
        }
        #expect(try await journal.entries().contains { $0.commandId == commandID } == false)
    }
}
