import Foundation
import JavaScriptCore
import OpenClawChatUI
import OpenClawKit
import Testing
import WebKit
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
    func `embedded pages preserve the selected authentication without exporting personal credentials`(
        personal: Bool) throws
    {
        let config = try self.config(personal: personal)
        let url = try #require(AuthenticatedControlUI.pageURL(config: config, path: "settings", queryItems: []))
        #expect(ControlUIHubPage.terminal.url(config: config) != nil)
        #expect(ControlUIHubPage.desktop(source: nil, session: nil).url(config: config) != nil)
        #expect(SessionDashboardScreen.dashboardURL(config: config, sessionKey: "agent:main:chat") != nil)
        let script = try #require(AuthenticatedControlUI.authUserScript(
            config: config, pageURL: url, storedOperatorToken: "synthetic-paired-grant"))
        let context = try #require(JSContext())
        context.evaluateScript("var window = {}; var location = {origin: 'https://gateway.example.ts.net'};")
        context.evaluateScript(script)
        #expect(context.exception == nil)
        let auth = try #require(context.evaluateScript("window.__OPENCLAW_NATIVE_CONTROL_AUTH__")?.toDictionary())
        #expect(auth["gatewayUrl"] as? String == config.url.absoluteString)
        if personal {
            #expect(auth["nativeConnectAuth"] as? Bool == true)
            #expect(auth["token"] == nil)
            #expect(auth["password"] == nil)
            #expect(AuthenticatedControlUI.storedOperatorToken(config: config) == nil)
        } else {
            #expect(auth["token"] as? String == "synthetic-shared-token")
        }
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

    @Test(arguments: [false, true])
    func `native Dashboard bridge refuses foreign documents and retires lost authority`(
        foreignOrigin: Bool) async throws
    {
        let config = try self.config(personal: true)
        let url = try #require(AuthenticatedControlUI.pageURL(config: config, path: "settings", queryItems: []))
        let fixture =
            DashboardDocumentFixture(url: foreignOrigin ? URL(string: "https://foreign.example/settings")! : url)
        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        model.activeGatewayConnectConfig = config
        model.setOperatorConnected(true)
        let bridge = IOSPersonalGatewayAuthBridge(appModel: model, config: config, url: url)
        let controller = fixture.webView.configuration.userContentController
        controller.addScriptMessageHandler(bridge, contentWorld: .page, name: IOSPersonalGatewayAuthBridge.name)
        bridge.attach(to: fixture.webView)
        defer {
            bridge.detach()
            controller.removeScriptMessageHandler(forName: IOSPersonalGatewayAuthBridge.name, contentWorld: .page)
        }
        bridge.startNavigation()
        _ = try await fixture.load(hasEmbedMarker: true)
        bridge.commitNavigation()
        let response = try await fixture.webView.callAsyncJavaScript(
            """
            try {
              return await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
                id: 'synthetic-request', nonce: 'synthetic-challenge', signedAt: Date.now()
              });
            } catch (error) { return { rejected: String(error) }; }
            """,
            arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
        let reply = try #require(response)
        #expect(reply["result"] == nil)
        if foreignOrigin {
            #expect((reply["rejected"] as? String)?.contains("Invalid native Gateway") == true)
        } else {
            #expect(reply["error"] as? String == "Personal sign-in is unavailable. Reconnect in the app.")
        }
        model.setOperatorConnected(false)
        try await waitForDashboardCondition { !fixture.webView.isLoading && fixture.webView.url?.host == nil }
        let body = try await fixture.webView.evaluateJavaScript("document.body.textContent") as? String
        #expect(body?.contains("Personal sign-in changed") == true)
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
