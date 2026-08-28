import Foundation
import Testing
@testable import OpenClaw

struct UnlinkedFallbackTests {
    @Test(arguments: [false, true])
    @MainActor func `unlinked channels cannot provide a healthy fallback`(whatsappFirst: Bool) throws {
        // Prove this uses the candidate module, and suppress polling before creating its singleton.
        try #require(String(reflecting: HealthStore.self) == "HealthStoreCandidateTests.HealthStore")
        try #require(ProcessInfo.processInfo.isRunningTests)
        let fixture: [String: Any] = [
            "ok": true,
            "ts": 1772798400000,
            "durationMs": 2,
            "channels": [
                "whatsapp": [
                    "configured": true, "linked": false, "running": false, "connected": false,
                    "healthState": "stopped", "lifecycle": "stopped",
                ],
                "zalouser": ["configured": true, "linked": false, "running": false],
            ],
            "channelOrder": whatsappFirst ? ["whatsapp", "zalouser"] : ["zalouser", "whatsapp"],
            "channelLabels": ["whatsapp": "WhatsApp", "zalouser": "Zalo Personal"],
            "sessions": ["path": "/tmp/sessions.json", "count": 0, "recent": []],
        ]
        let data = try JSONSerialization.data(withJSONObject: fixture)
        let snapshot: HealthSnapshot = try #require(decodeHealthSnapshot(from: data))
        let store = HealthStore.shared
        let previousSnapshot = store.snapshot
        let previousError = store.lastError
        defer { store.__setSnapshotForTest(previousSnapshot, lastError: previousError) }
        store.__setSnapshotForTest(snapshot, lastError: nil)

        #expect(store.state == .linkingNeeded)
        #expect(store.summaryLine == "Not linked — run openclaw login")
    }
}
