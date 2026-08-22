import Foundation
import Testing
@testable import OpenClaw

struct HealthStoreStateTests {
    @Test @MainActor func `current channel lifecycle reports healthy`() throws {
        let data = Data(
            """
            {
              "ok": true,
              "ts": 1,
              "durationMs": 2,
              "channels": {
                "telegram": {
                  "accountId": "default",
                  "configured": true,
                  "running": true,
                  "connected": true,
                  "lifecycle": "ready"
                }
              },
              "channelOrder": ["telegram"],
              "channelLabels": {"telegram": "Telegram"},
              "heartbeatSeconds": 60,
              "sessions": {"path": "/tmp/sessions.json", "count": 0, "recent": []}
            }
            """.utf8)
        let snap = try #require(decodeHealthSnapshot(from: data))
        let store = HealthStore.shared
        store.__setSnapshotForTest(snap, lastError: nil)

        #expect(store.state == .ok)
        #expect(store.summaryLine == "Telegram ready")
    }

    @Test @MainActor func `linked channel probe failure degrades state`() {
        let snap = HealthSnapshot(
            ok: true,
            ts: 0,
            durationMs: 1,
            channels: [
                "whatsapp": .init(
                    configured: true,
                    linked: true,
                    authAgeMs: 1,
                    probe: .init(
                        ok: false,
                        status: 503,
                        error: "gateway connect failed",
                        elapsedMs: 12,
                        bot: nil,
                        webhook: nil),
                    lastProbeAt: 0,
                    running: nil,
                    connected: nil,
                    lifecycle: nil,
                    lastError: nil),
            ],
            channelOrder: ["whatsapp"],
            channelLabels: ["whatsapp": "WhatsApp"],
            heartbeatSeconds: 60,
            sessions: .init(path: "/tmp/sessions.json", count: 0, recent: []))

        let store = HealthStore.shared
        store.__setSnapshotForTest(snap, lastError: nil)

        switch store.state {
        case let .degraded(message):
            #expect(!message.isEmpty)
        default:
            Issue.record("Expected degraded state when probe fails for linked channel")
        }

        #expect(store.summaryLine.contains("probe degraded"))
    }

    @Test @MainActor func `current channel selection skips an unconfigured entry`() {
        let snap = HealthSnapshot(
            ok: true,
            ts: 0,
            durationMs: 1,
            channels: [
                "disabled": .init(
                    configured: false,
                    linked: nil,
                    authAgeMs: nil,
                    probe: nil,
                    lastProbeAt: nil,
                    running: false,
                    connected: false,
                    lifecycle: "stopped",
                    lastError: nil),
                "telegram": .init(
                    configured: true,
                    linked: nil,
                    authAgeMs: nil,
                    probe: nil,
                    lastProbeAt: nil,
                    running: true,
                    connected: true,
                    lifecycle: "ready",
                    lastError: nil),
            ],
            channelOrder: ["disabled", "telegram"],
            channelLabels: ["disabled": "Disabled", "telegram": "Telegram"],
            heartbeatSeconds: 60,
            sessions: .init(path: "/tmp/sessions.json", count: 0, recent: []))

        let store = HealthStore.shared
        store.__setSnapshotForTest(snap, lastError: nil)

        #expect(store.state == .ok)
        #expect(store.summaryLine == "Telegram ready")
    }

    @Test @MainActor func `current channel probe failure degrades state`() {
        let snap = HealthSnapshot(
            ok: true,
            ts: 0,
            durationMs: 1,
            channels: [
                "telegram": .init(
                    configured: true,
                    linked: nil,
                    authAgeMs: nil,
                    probe: .init(
                        ok: false,
                        status: 503,
                        error: "gateway connect failed",
                        elapsedMs: 12,
                        bot: nil,
                        webhook: nil),
                    lastProbeAt: 0,
                    running: true,
                    connected: true,
                    lifecycle: "ready",
                    lastError: nil),
            ],
            channelOrder: ["telegram"],
            channelLabels: ["telegram": "Telegram"],
            heartbeatSeconds: 60,
            sessions: .init(path: "/tmp/sessions.json", count: 0, recent: []))

        let store = HealthStore.shared
        store.__setSnapshotForTest(snap, lastError: nil)

        switch store.state {
        case let .degraded(message):
            #expect(message.contains("gateway connect failed"))
        default:
            Issue.record("Expected degraded state when a current channel probe fails")
        }
        #expect(store.summaryLine.contains("gateway connect failed"))
    }

    @Test @MainActor func `fallback channel with last error is not healthy`() {
        let snap = HealthSnapshot(
            ok: true,
            ts: 0,
            durationMs: 1,
            channels: [
                "whatsapp": .init(
                    configured: true,
                    linked: false,
                    authAgeMs: nil,
                    probe: nil,
                    lastProbeAt: nil,
                    running: nil,
                    connected: nil,
                    lifecycle: nil,
                    lastError: nil),
                "telegram": .init(
                    configured: true,
                    linked: nil,
                    authAgeMs: nil,
                    probe: nil,
                    lastProbeAt: nil,
                    running: true,
                    connected: true,
                    lifecycle: "ready",
                    lastError: "polling failed"),
            ],
            channelOrder: ["whatsapp", "telegram"],
            channelLabels: ["whatsapp": "WhatsApp", "telegram": "Telegram"],
            heartbeatSeconds: 60,
            sessions: .init(path: "/tmp/sessions.json", count: 0, recent: []))

        let store = HealthStore.shared
        store.__setSnapshotForTest(snap, lastError: nil)

        #expect(store.state == .linkingNeeded)
        #expect(store.summaryLine == "Not linked — run openclaw login")
    }
}
