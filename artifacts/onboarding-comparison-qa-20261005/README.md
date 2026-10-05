# Matched onboarding-surface comparison

Static preparation only. This task did not execute either source revision, invoke candidate hooks, dispatch CI, or edit a product checkout or GitHub. Root owns the scoped review, CI integration, secretless execution, image inspection, and any publication of evidence.

## Pinned comparison

Use the same task-local fixture and ordinary UI E2E config against these immutable commits:

| Label | Exact source |
| --- | --- |
| Baseline | `8db9539ee84a9c89f535c70fd39aa8fcaebc1bb9` |
| Candidate | `31c9aadb82cb4a0b99fbd49b12111eb204cf0a43` |

The Settings/Profile owner (`ui/src/pages/profile/profile-page.ts`, blob `7c5f52f76777d2adb9b5a60a73b7f3aba028a48a`), empty-profile fixture owner (`src/state/user-profiles.ts`, blob `002fb47fe041b157726b943bd9780aefe2351a3e`), and Gateway-ready helper (`ui/src/test-helpers/control-ui-e2e-readiness.ts`, blob `10e5f31291811a16a402717fcdf8451a8f2d3c4a`) are identical at both pins. The Custodian page differs (`04a18a13f5025e431fd6f7aa4682af93ea7d7c20` baseline; `248091269311047fd0f2272c9d5f5676e542e7fe` candidate), which is the visual contrast under review.

## Capture contract

`onboarding-comparison.capture.real-gateway.e2e.test.ts` uses the incumbent Control UI E2E suite, an isolated real Gateway, and the same loopback trusted-proxy/Vite WebSocket path as the prior Profile comparison. Both runs create only the synthetic `primary.user@example.test` Profile with no display name. Before opening setup, the actual Settings/Profile page must show that identity, an empty Display name editor, and an enabled editor under the same synthetic write-capable proxy identity. The test does not set or clear the name, invoke a profile write, or touch channels.

The baseline capture is labelled “ordinary setup surface”; the candidate capture is taken only after its real page renders the optional name prompt with an empty input and visible “Maybe later” affordance. The baseline assertion intentionally claims only that no such prompt exists in baseline code; it does not call or synthesize a candidate-only response. Both frames require the Gateway to report `connected` through the existing `waitForControlUiGatewayReady` helper, and the blank name is read through the unchanged, user-visible Profile surface. This keeps baseline evidence honest while holding the synthetic identity and actual unnamed Profile state constant.

The test captures viewport-only screenshots at 1280×800 and 390×844. It dismisses the canonical community invitation in local storage before first render. It does not manipulate DOM/CSS, crop, use fixed sleeps, click “Maybe later,” or write profile state. The existing candidate real-Gateway test already covers save, skip, persistence, and revisit; this fixture does not duplicate those mutations. The persisted-name receipt remains separate runtime evidence and is not inferred from these screenshots.

## Test-audit authoring receipt

1. Observable contract: the same unnamed writable Profile reaches the existing setup route, and the optional prompt is visibly placed at desktop and mobile sizes only on the candidate.
2. Credible failure: the new prompt is absent, visually crowded/clipped, or displaces the ordinary setup surface at one of the requested viewports.
3. Existing coverage already exercises candidate save/skip/persist/revisit, but does not provide an exact baseline/candidate visual pair at these two viewports. This is a task-local capture fixture, not another committed product regression test or a duplicate mutation matrix.
4. No production seam or mocked Gateway is added. The fixture uses the actual rendered Profile route, Gateway connection readiness, Custodian route, and established test-state owner.

## Runner handling

Stage only these two allowlisted files into each disposable exact-revision checkout:

- `ui/src/e2e/onboarding-comparison.capture.real-gateway.e2e.test.ts`
- `.artifacts/onboarding-comparison-qa-20261005/vitest.onboarding-comparison.config.ts`

The staged source file is untracked and must remain visible as untracked. Record its SHA-256 and the config SHA-256 before and after each run; verify no other tracked or untracked source changes occurred; remove only these exact staged files after collecting the task-owned output. Do not alter Git excludes or the canonical UI E2E/pristine-check paths.

For each pin, use the same standard secretless fork-CI runner, Node/pnpm versions declared by that checkout, frozen lockfile install, repository-pinned Chromium installer, `pnpm build`, and this command:

```sh
OPENCLAW_CAPTURE_UI_PROOF=1 \
OPENCLAW_ONBOARDING_COMPARISON_SIDE=baseline \
OPENCLAW_UI_E2E_ARTIFACT_DIR="$RUNNER_TEMP/onboarding-comparison/baseline" \
node scripts/run-vitest.mjs run \
  --config .artifacts/onboarding-comparison-qa-20261005/vitest.onboarding-comparison.config.ts \
  --configLoader runner
```

Use `candidate` and a distinct candidate artifact directory for the second pin; change no other fixture/config inputs. Retain the exact checked-out SHAs and tool/browser versions with the captures. Upload only the four viewport images and a bounded receipt; exclude full runner logs, runtime state, databases, credentials, and unrelated artifact directories. A screenshot pair is visual evidence only; it does not replace the already-separate Gateway persistence proof.


