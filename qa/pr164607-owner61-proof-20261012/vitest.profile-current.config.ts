import { defineConfig } from "vitest/config";
import { createUiE2eVitestConfig } from "../../test/vitest/vitest.ui-e2e.config.ts";

const fixture = "ui/src/e2e/profile-current.qa.real-gateway.e2e.test.ts";
const canonical = createUiE2eVitestConfig(
  {
    ...process.env,
    OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: undefined,
    OPENCLAW_VITEST_INCLUDE_FILE: undefined,
  },
  [],
);
const project = canonical.test.projects?.find(
  (candidate) => candidate.test?.name === "ui-e2e-serial",
);
if (!project) {
  throw new Error("Current Profile qualification requires the canonical bundled serial E2E owner");
}

export default defineConfig({
  ...canonical,
  test: {
    ...canonical.test,
    include: [fixture],
    projects: [{ ...project, test: { ...project.test, include: [fixture] } }],
  },
});
