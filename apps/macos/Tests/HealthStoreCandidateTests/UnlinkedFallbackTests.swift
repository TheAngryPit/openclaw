import Foundation
import Testing
@testable import OpenClaw

struct UnlinkedFallbackTests {
    @Test(arguments: [false, true])
    @MainActor func `unlinked channels cannot provide a healthy fallback`(whatsappFirst: Bool) throws {
        try Self.withSnapshot([
            "whatsapp": Self.unlinkedWhatsApp,
            "zalouser": ["configured": true, "linked": false, "running": false],
        ], order: whatsappFirst ? ["whatsapp", "zalouser"] : ["zalouser", "whatsapp"]) { store in
            #expect(store.state == .linkingNeeded)
            #expect(store.summaryLine == "Not linked — run openclaw login")
        }
    }

    @Test(arguments: [nil, false, true] as [Bool?])
    @MainActor func `selected disabled channels remain inactive`(linked: Bool?) throws {
        let channel = linked == nil ? "telegram" : "whatsapp"
        let label = linked == nil ? "Telegram" : "WhatsApp"
        var fields: [String: Any] = ["enabled": false, "configured": true, "running": false]
        if let linked {
            fields["linked"] = linked
            fields["connected"] = false
            fields["lifecycle"] = "stopped"
            fields["healthState"] = "stopped"
        }
        var channels = [channel: fields]
        var order = [channel]
        if linked == nil {
            channels["matrix"] = [
                "configured": true, "running": true, "connected": true, "lifecycle": "ready",
                "healthState": "healthy",
            ]
            order.append("matrix")
        }
        try Self.withSnapshot(channels, order: order) { store in
            #expect(store.state == .unknown)
            #expect(store.summaryLine == "\(label) disabled")
        }
    }

    @Test @MainActor func `disabled channels cannot provide a healthy fallback`() throws {
        try Self.withSnapshot([
            "whatsapp": Self.unlinkedWhatsApp,
            "telegram": ["enabled": false, "configured": true, "running": false],
        ], order: ["whatsapp", "telegram"]) { store in
            #expect(store.state == .linkingNeeded)
            #expect(store.summaryLine == "Not linked — run openclaw login")
        }
    }

    @Test(arguments: [nil, true] as [Bool?])
    @MainActor func `enabled and unspecified channels remain eligible`(enabled: Bool?) throws {
        var fields: [String: Any] = [
            "configured": true, "running": true, "connected": true, "lifecycle": "ready",
        ]
        if let enabled { fields["enabled"] = enabled }
        try Self.withSnapshot(["telegram": fields], order: ["telegram"]) { store in
            #expect(store.state == .ok)
            #expect(store.summaryLine == "Telegram ready")
        }
        try Self.withSnapshot([
            "whatsapp": Self.unlinkedWhatsApp,
            "telegram": fields,
        ], order: ["whatsapp", "telegram"]) { store in
            #expect(store.state == .degraded("Not linked"))
            #expect(store.summaryLine == "Telegram ok · Not linked — run openclaw login")
        }
    }

    private static var unlinkedWhatsApp: [String: Any] {
        [
            "configured": true, "linked": false, "running": false, "connected": false,
            "healthState": "stopped", "lifecycle": "stopped",
        ]
    }

    @MainActor private static func withSnapshot(
        _ channels: [String: [String: Any]],
        order: [String],
        body: @MainActor (HealthStore) throws -> Void) throws
    {
        // Prove this uses the candidate module, and suppress polling before creating its singleton.
        try #require(String(reflecting: HealthStore.self) == "HealthStoreCandidateTests.HealthStore")
        try #require(ProcessInfo.processInfo.isRunningTests)
        let fixture: [String: Any] = [
            "ok": true,
            "ts": 1772798400000,
            "durationMs": 2,
            "channels": channels,
            "channelOrder": order,
            "channelLabels": ["telegram": "Telegram", "whatsapp": "WhatsApp", "zalouser": "Zalo Personal"],
            "sessions": ["path": "/tmp/sessions.json", "count": 0, "recent": []],
        ]
        let data = try JSONSerialization.data(withJSONObject: fixture)
        let snapshot: HealthSnapshot = try #require(decodeHealthSnapshot(from: data))
        let store = HealthStore.shared
        let previousSnapshot = store.snapshot
        let previousError = store.lastError
        defer { store.__setSnapshotForTest(previousSnapshot, lastError: previousError) }
        store.__setSnapshotForTest(snapshot, lastError: nil)

        try body(store)
    }
}
