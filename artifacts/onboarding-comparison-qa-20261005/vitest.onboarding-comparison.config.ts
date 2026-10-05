// Preserve the canonical ordinary UI E2E setup for one allowlisted capture fixture.
import { defineConfig } from "vitest/config";
import { createUiE2eVitestConfig } from "../../test/vitest/vitest.ui-e2e.config.ts";

const fixture = "ui/src/e2e/onboarding-comparison.capture.real-gateway.e2e.test.ts";
const canonical = createUiE2eVitestConfig(
  {
    ...process.env,
    OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: undefined,
    OPENCLAW_VITEST_INCLUDE_FILE: undefined,
  },
  [],
);
const serialProject = canonical.test.projects?.find(
  (project) => project.test?.name === "ui-e2e-serial",
);

if (!serialProject) {
  throw new Error("Canonical Control UI serial E2E project is unavailable");
}

export default defineConfig({
  ...canonical,
  test: {
    ...canonical.test,
    include: [fixture],
    projects: [
      {
        ...serialProject,
        test: {
          ...serialProject.test,
          include: [fixture],
        },
      },
    ],
  },
});


