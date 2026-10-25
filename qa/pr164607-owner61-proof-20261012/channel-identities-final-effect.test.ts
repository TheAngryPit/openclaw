import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { resolveUserChannelIdentity } from "../state/user-channel-identities.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

const identity = {
  channelId: "synthetic-proof-channel",
  accountId: "synthetic-proof-account",
  senderId: "synthetic-proof-sender",
};
const cases = [
  "non-admin",
  "scope-revoked",
  "role-policy-revoked",
  "requester-reassigned",
] as const;

it.each(cases)("keeps final channel storage unchanged for %s", async (change) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const admin = ensureProfileForEmail("admin@example.test");
    const replacement = ensureProfileForEmail("replacement@example.test");
    setUserProfileRole(admin.id, "admin");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const allowedConfig: OpenClawConfig = {
      gateway: {
        roles: {
          default: "member",
          definitions: {
            admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
            member: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
          },
        },
      },
    };
    let config = allowedConfig;
    const client: GatewayClient = {
      connId: "synthetic-channel-proof",
      authenticatedUserId: "admin@example.test",
      authenticatedUserProfile: {
        profileId: admin.id,
        displayName: "Synthetic Administrator",
        avatarRevision: "synthetic",
        hasAvatar: false,
        updatedAt: 1,
      },
      connect: {
        role: "operator",
        scopes: ["operator.admin"],
        client: { id: "test", version: "1", platform: "test", mode: "test" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    };
    const context = {
      getRuntimeConfig: () => config,
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestContext; // SAFETY: matches the existing registered channel-identity test's consumed context fields.
    const dispatch = async (action: "link" | "unlink") => {
      const method =
        action === "link" ? "users.linkChannelIdentity" : "users.unlinkChannelIdentity";
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: `proof-${action}`,
          method,
          params: { profileId: admin.id, identity },
        },
        respond,
        client,
        isWebchatConnect: () => false,
        context,
      });
      expect(respond).toHaveBeenCalledTimes(1);
      return respond.mock.calls[0];
    };
    const restoreAuthority = () => {
      client.connect.scopes = ["operator.admin"];
      client.authenticatedUserProfile!.profileId = admin.id;
      config = allowedConfig;
    };
    const changeAuthority = () => {
      if (change === "requester-reassigned") {
        client.authenticatedUserProfile!.profileId = replacement.id;
      } else if (change === "role-policy-revoked") {
        config = {
          gateway: {
            roles: {
              default: "member",
              definitions: {
                admin: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
                member: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
              },
            },
          },
        };
      } else {
        client.connect.scopes = ["operator.read", "operator.write"];
      }
    };
    expect(await dispatch("link")).toEqual([true, { profileId: admin.id, identity }]);
    expect(resolveUserChannelIdentity(identity)?.profileId).toBe(admin.id);
    expect(await dispatch("unlink")).toEqual([true, { removed: true }]);
    expect(resolveUserChannelIdentity(identity)).toBeUndefined();
    const observations: Array<{
      action: "link" | "unlink";
      reachedCommit: boolean;
      rejected: boolean;
      errorCode: unknown;
      finalBinding: string;
    }> = [];

    for (const action of ["link", "unlink"] as const) {
      restoreAuthority();
      if (action === "unlink") {
        expect(await dispatch("link")).toEqual([true, { profileId: admin.id, identity }]);
      }
      const expectedBinding = action === "unlink" ? admin.id : undefined;
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      let reachedCommit = false;
      using admission = vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission");
      admission.mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          if (
            change !== "non-admin" &&
            request.stage === "commit" &&
            isRecord(request.facts) &&
            request.facts.kind === "channel-identity" &&
            request.facts.action === action
          ) {
            reachedCommit = true;
            changeAuthority();
          }
          admit(request, grant);
        }, attachment),
      );
      if (change === "non-admin") {
        changeAuthority();
      }
      const response = await dispatch(action);
      expect(response?.[0]).toBe(false);
      expect(response?.[1]).toBeUndefined();
      expect(response?.[2]).toMatchObject({
        message: expect.stringMatching(/operator\.admin|authority|profile changed/i),
      });
      expect(reachedCommit).toBe(change !== "non-admin");
      const savedProfile = resolveUserChannelIdentity(identity)?.profileId;
      expect(savedProfile).toBe(expectedBinding);
      const observed = {
        action,
        reachedCommit,
        rejected: response?.[0] === false,
        errorCode: response?.[2]?.code,
        finalBinding: savedProfile === undefined ? "absent" : "original synthetic profile retained",
      };
      observations.push(observed);
      console.info(
        JSON.stringify({
          proof: "profile-channel-final-effect",
          change,
          ...observed,
        }),
      );
    }
    const proofRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR;
    if (!proofRoot) {
      throw new Error("Final-effect qualification requires a retained artifact directory");
    }
    await writeFile(
      path.join(proofRoot, `final-storage-${change}.json`),
      JSON.stringify(
        {
          source: process.env.OPENCLAW_PROFILE_QA_PRODUCT_SHA,
          boundary:
            "registered Gateway, synchronous worker commit admission, actual isolated storage",
          change,
          observations,
        },
        null,
        2,
      ) + "\n",
    );
  });
});
