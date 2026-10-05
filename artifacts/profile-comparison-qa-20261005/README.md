# Matched real-Gateway Profile comparison capture

This task-local fixture is not a product test and is not tracked by the PR. The runner must stage `profile-comparison.capture.real-gateway.e2e.test.ts` as the new, untracked file `ui/src/e2e/profile-comparison.capture.real-gateway.e2e.test.ts` in each clean checkout. Never replace `profile-page.real-gateway.e2e.test.ts`.

Use the same fixture and config for these exact source revisions:

- Baseline: `e87ab44327c049ca6454550addb4a314048ee2fb`.
- Candidate: `ae51861738ec9a3095388a3ff64ba4a2a6220095` (the fixture/formatter/type repairs preserve the Profile UI).

The config imports the canonical ordinary UI E2E config, selects only its serial bundled project, and changes that project's include to the staged fixture. Chromium preflight, bundled Control UI preparation, isolated fork cleanup, and the canonical test setup remain inherited. Do not use the clean-checkout prebuilt wrapper or change Git exclusions to conceal the QA file. The runner independently checks exact HEAD, unchanged tracked source, the one allowlisted untracked fixture and fixture/config hashes before and after execution. The fixture starts the incumbent-style isolated trusted-proxy Gateway and Vite WebSocket proxy with synthetic `primary.user@example.test` / `Test Person`; it does not edit the name or mutate channel links.

Run once per revision, with a different task-owned artifact parent for each run:

```powershell
$env:OPENCLAW_CAPTURE_UI_PROOF = "1"
$env:OPENCLAW_PROFILE_COMPARISON_CHANNEL_STATE = "absent" # baseline only
$env:OPENCLAW_UI_E2E_ARTIFACT_DIR = "<task-owned-baseline-capture-parent>"
node scripts/run-vitest.mjs run --config .artifacts/profile-comparison-qa-20261005/vitest.profile-comparison.config.ts --configLoader runner
```

For candidate, change only `OPENCLAW_PROFILE_COMPARISON_CHANNEL_STATE` to `empty` and the artifact parent to a candidate-owned directory. The fixture waits for the candidate channel section to report its empty state before capturing. Both runs use Chromium, `en-US`, a 1280×800 viewport, the incumbent's canonical pre-render community-invitation dismissal, and the same synthetic identity. Each successful capture contains a viewport PNG and an uncropped full-page PNG beneath the suite's generated artifact directory.

This checkout is only the source for a trusted, secretless PR-CI capture runner. Do not execute this forked candidate or its hooks locally. Root owns staging, remote execution, image inspection, and publication.
