# Tailscale native completion diagnostic

This QA-only overlay preserves the raw Swift Testing JSONL stream when the unchanged native completion parser rejects a run. It is not a product change or a completion fix. The data shape is one opt-in `RUNNER_TEMP` evidence directory containing the raw event bytes and their SHA-256 sidecar. The launcher continues to fail on duplicate/missing/out-of-order events or invalid schema.

## Pinned inputs

- Product source: `706c6fccf7596f67f0504664bb3a74d7833dad65`.
- Base launcher SHA-256: `dacb9fad271e9ed0438dbf8d58a9c80e072f55533eff863db0f572a2684c065f`.
- Observational patch: `tooling/launcher-event-stream-diagnostic.patch`.
- Patch SHA-256: `69c6190ff796f4f8159aff76ce557153f6549c0a2dd2c74fd72c4786ba77ce42`.
- Prior failing workflow: run `37376859701`, workflow commit `4d5ae718ec4713d48a508681e333734db3b04184`.
- Current QA branch starting point: `b166bce6b7ee4fc86631cb491fd7c17990be6362`.

The workflow must first verify the exact product SHA and clean source tree. It then sparse-checks out the exact workflow commit under the existing ignored `apps/ios/build/tailscale-qa-tools-<run id>-<attempt>` path, applies this patch to the product checkout using `git apply --check` followed by `git apply`, and records the patch hash, base launcher hash, instrumented launcher hash, and applied one-file diff hash. Final verification allows only the exact `scripts/test-macos-native.mts` overlay, requires its hash and diff hash to match the values recorded at application, and does not call the source tree pristine after overlay.

The launcher receives `OPENCLAW_SWIFT_TESTING_EVENT_DIAGNOSTIC_DIR="$EVIDENCE_DIR"` only for the filtered Tailscale invocation. Its existing `RUNNER_TEMP/tailscale-native-163765-<run id>` directory is a direct child of `RUNNER_TEMP` and is already included in the always-run evidence upload. The captured stream and hash sidecar are separate from test-result summaries; neither can convert the macOS step or job to success.

## Behavior contract and negative controls

The observed result must remain split by platform. The macOS guard can fail while independent iOS suites run, but the workflow conclusion must remain failed when the macOS step fails.

- Duplicate `runStarted` with Swift exit 0: parser still fails; capture retains complete JSONL.
- One `runStarted` then one `runEnded`, valid schema, Swift exit 0: parser remains successful; capture is observational only.
- Missing end, end-before-start, duplicate end, malformed JSON, or wrong schema: parser still fails; capture retains available JSONL.
- Swift nonzero: nonzero result remains a failure; capture does not override it.
- Missing/out-of-scope/symlink evidence directory, absent event file, or output collision: requested diagnostic export fails closed without overwriting.
- Opt-in variable absent: existing launcher behavior and cleanup are unchanged.

Static tests only are in scope here. No launcher, product source, or hook is executed locally. Native event chronology remains unproven until a public GitHub-hosted run uploads the JSONL.
