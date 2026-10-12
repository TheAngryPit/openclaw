import { serialize } from "node:v8";
import { expect, it, vi } from "vitest";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import {
  seedSessionActorOutcomeTransferTranscript,
  SESSION_ACTOR_TRANSFER_TEST_MESSAGE_COUNT,
  withActor,
  type Mutation,
} from "./session-actor-worker.test-support.js";

// mock-isolation: The fixture owns its database lifetime without background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns its database lifetime without background history eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it("transfers a cold tiny patch's accumulated receipt in bounded frames", async () => {
  await withActor(async (f) => {
    const idempotencyKey = "k".repeat(512);
    seedSessionActorOutcomeTransferTranscript(f);
    const snapshot = f.read();
    expect(snapshot.transcript.idempotency).toHaveLength(SESSION_ACTOR_TRANSFER_TEST_MESSAGE_COUNT);
    expect(snapshot.transcript.anchors).toHaveLength(SESSION_ACTOR_TRANSFER_TEST_MESSAGE_COUNT);
    expect(snapshot.transcript.idempotency[0]?.key).toHaveLength(idempotencyKey.length + 6);
    expect(serialize(snapshot).byteLength).toBeGreaterThan(SQLITE_WORKER_MAX_MESSAGE_BYTES);
    const before = f.nativeEntry();
    f.restartActor();
    const transfers: { id?: number; frames: number[]; complete: boolean } = {
      frames: [],
      complete: false,
    };
    f.hooks.admit = (_stage, facts) => {
      if (!facts || typeof facts !== "object" || !("publication" in facts)) {
        return;
      }
      const publication = facts.publication;
      if (!publication || typeof publication !== "object" || !("kind" in publication)) {
        return;
      }
      if (publication.kind === "session-actor-outcome-transfer" && "handle" in publication) {
        const handle = publication.handle;
        if (
          handle &&
          typeof handle === "object" &&
          "id" in handle &&
          typeof handle.id === "number"
        ) {
          transfers.id = handle.id;
        }
      } else if (publication.kind === "session-actor-outcome-frame" && "frame" in publication) {
        const frame = publication.frame;
        if (frame && typeof frame === "object" && "done" in frame && frame.done === true) {
          transfers.complete = true;
        }
        if (
          frame &&
          typeof frame === "object" &&
          "bytes" in frame &&
          frame.bytes instanceof Uint8Array
        ) {
          transfers.frames.push(frame.bytes.byteLength);
        }
      }
    };

    const command: Mutation = {
      type: "session.actor.patch",
      input: {
        target: f.target,
        commandId: "oversized-transcript-activity",
        phaseId: "activity",
        reducers: [{ kind: "activity", updatedAt: 500 }],
      },
    };
    await f.prepare(command);
    const outcome = f.mutate(command);

    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") {
      throw new Error("Expected the worker to preserve its full domain outcome");
    }
    expect(outcome.receipt.postimage.transcript.anchors).toHaveLength(
      SESSION_ACTOR_TRANSFER_TEST_MESSAGE_COUNT,
    );
    expect(transfers.complete).toBe(true);
    expect(transfers.frames.length).toBeGreaterThan(1);
    expect(transfers.frames.every((bytes) => bytes <= 8 * 1024 * 1024)).toBe(true);
    expect(f.nativeEntry()).toEqual({ ...before, updatedAt: 500 });
    expect(f.receipt()).toMatchObject({
      kind: "native-commit",
      committed: {
        facts: {
          kind: "session-actor-committed-transfer",
          transferId: transfers.id,
          commandId: "oversized-transcript-activity",
          phaseId: "activity",
          phase: "patch",
        },
      },
    });
  });
});
