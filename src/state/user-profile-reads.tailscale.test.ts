import { expect, it } from "vitest";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { listProfiles, resolveCanonicalTailscaleProfileId } from "./user-profile-reads.js";
import { ensureCanonicalUserProfileForTailscaleIdentity } from "./user-profile-writes.js";
import { useProfileState } from "./user-profiles-fixture.test-support.js";

useProfileState();

it("reads canonical provider identities through the worker without creating unknown profiles", async () => {
  const email = await ensureCanonicalUserProfileForTailscaleIdentity({
    login: "person@example.test",
  });
  const provider = await ensureCanonicalUserProfileForTailscaleIdentity({ login: "person@github" });
  const before = await listProfiles();
  const sql = observeMainThreadSql();
  try {
    expect(await resolveCanonicalTailscaleProfileId(" PERSON@EXAMPLE.TEST ")).toBe(email.id);
    expect(await resolveCanonicalTailscaleProfileId("person@github")).toBe(provider.id);
    expect(email.id).not.toBe(provider.id);
    expect(await resolveCanonicalTailscaleProfileId("missing@example.test")).toBeUndefined();
    expect(await resolveCanonicalTailscaleProfileId("not-a-provider-login")).toBeUndefined();
    expect(await listProfiles()).toEqual(before);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});
