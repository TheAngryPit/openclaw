# Linux operator token capture

This helper captures the real Control UI served by a task-owned Gateway on a
secretless standard Ubuntu 24.04 qualification runner. It refuses other operating
systems, edited product checkouts, partial commit identifiers, reused artifact
directories, and missing Playwright Chromium. It does not build product code.

The workflow must freshly build the selected UI and Gateway checkouts before
starting the helper. It passes the UI and Gateway product roots independently so
baseline UI, candidate UI, baseline Gateway, and candidate Gateway provenance
cannot be inferred from one shared default. The Gateway is configured to serve
the UI tree named by `OPENCLAW_QA_UI_REPO_ROOT`; both full expected commit SHAs
are checked. After building those clean checkouts, the workflow records a receipt
tying the selected product commits and workflow revision to the Gateway entry,
UI index, and UI main-asset SHA-256 digests, then passes those digests to the
helper. The helper compares its local build index and local/Gateway-served main JavaScript bytes with the
caller-provided build digests before opening the browser, and rechecks local UI
bytes and the captured served digests after cleanup. It resolves the already-installed `playwright`
dependency from the verified Gateway product root; the temporary QA workflow
checkout needs no duplicate dependency installation.

The Gateway legitimately prepares the served HTML index, so its digest is
recorded separately rather than equated with the raw build index. The served
document must reference the exact same-origin main asset identified by the
receipt-verified local index. Main JavaScript bytes must match local and expected
digests; the same served document URL is re-fetched after capture and must remain
unchanged before shutdown. This proves entry asset identity and document stability,
not complete transformed-HTML equivalence.

Run each case in its own new, empty artifact directory outside both product
checkouts. The Gateway product checkout must have its existing `playwright`
package and Chromium browser installed; the helper resolves that package from
the verified product root instead of installing a duplicate in the QA checkout.
Each invocation starts one Gateway with a
random process-only token and loopback binding, opens the real profile settings
page, saves a synthetic display name through the actual UI when it changes,
checks persistence after reload, and inspects the live Gateway owner presence
and hovercard. In the `mutation` case, the fresh profile must not already be
named `Synthetic operator`; the helper first saves that name through the UI,
waits for the real `users.setDisplayName` acknowledgement, and verifies it after
reload. It then saves `Synthetic mutation probe` through the same UI path and
again waits for its acknowledgement and checks persistence. Both acknowledgements
must target `gateway-owner`, match the requested names in order, and are recorded
in the result. The `named` and `unnamed` cases retain their single-target behavior.
The helper never injects presence or calls a fake RPC. The desktop and
390×844 mobile viewport PNGs are direct Playwright captures of the rendered UI;
the invitation card is dismissed through its canonical localStorage preference
before the first Control UI render, then asserted absent in both captures.

Required environment variables:

| Name | Required value |
| --- | --- |
| `OPENCLAW_QA_UI_VARIANT` | `baseline` or `candidate` |
| `OPENCLAW_QA_CASE` | `named`, `unnamed`, or `mutation` |
| `OPENCLAW_QA_UI_REPO_ROOT` | Absolute root of the exact clean UI checkout |
| `OPENCLAW_QA_GATEWAY_REPO_ROOT` | Absolute root of the exact clean Gateway checkout |
| `OPENCLAW_QA_EXPECTED_UI_COMMIT` | Full 40-character expected UI commit SHA |
| `OPENCLAW_QA_EXPECTED_UI_INDEX_SHA256` | SHA-256 of `dist/control-ui/index.html`, computed immediately after a fresh UI build of the exact verified UI commit |
| `OPENCLAW_QA_EXPECTED_UI_MAIN_ASSET_SHA256` | SHA-256 of the main JavaScript asset referenced by that freshly built index |
| `OPENCLAW_QA_EXPECTED_GATEWAY_COMMIT` | Full 40-character expected Gateway commit SHA |
| `OPENCLAW_QA_EXPECTED_GATEWAY_ENTRY_SHA256` | SHA-256 of `dist/entry.js`, computed immediately after a fresh build of the exact verified Gateway commit |
| `OPENCLAW_QA_ARTIFACT_DIR` | Existing empty directory outside both product checkouts |

Example for one matrix cell, run from the separate QA workflow checkout:

```bash
mkdir -p "$QA_RESULTS/baseline-named"
UI_INDEX_SHA256="$(sha256sum "$BASELINE_PRODUCT/dist/control-ui/index.html" | cut -d ' ' -f 1)"
UI_MAIN_ASSET_RELATIVE_PATH="$(node -e 'const fs=require("node:fs");const html=fs.readFileSync(process.argv[1],"utf8");const src=html.match(/<script\b[^>]*\bsrc=["\x27]([^"\x27]+\.js(?:\?[^"\x27]*)?)["\x27]/i)?.[1];if(!src)process.exit(2);console.log(decodeURIComponent(new URL(src,"http://127.0.0.1/").pathname.replace(/^\/+/,""))' "$BASELINE_PRODUCT/dist/control-ui/index.html")"
UI_MAIN_ASSET_SHA256="$(sha256sum "$BASELINE_PRODUCT/dist/control-ui/$UI_MAIN_ASSET_RELATIVE_PATH" | cut -d ' ' -f 1)"
GATEWAY_ENTRY_SHA256="$(sha256sum "$BASELINE_PRODUCT/dist/entry.js" | cut -d ' ' -f 1)"
OPENCLAW_QA_UI_VARIANT=baseline \
OPENCLAW_QA_CASE=named \
OPENCLAW_QA_UI_REPO_ROOT="$BASELINE_PRODUCT" \
OPENCLAW_QA_GATEWAY_REPO_ROOT="$BASELINE_PRODUCT" \
OPENCLAW_QA_EXPECTED_UI_COMMIT=2a4dacc224c56ba48c9e5353eb0907156a8b35d4 \
OPENCLAW_QA_EXPECTED_UI_INDEX_SHA256="$UI_INDEX_SHA256" \
OPENCLAW_QA_EXPECTED_UI_MAIN_ASSET_SHA256="$UI_MAIN_ASSET_SHA256" \
OPENCLAW_QA_EXPECTED_GATEWAY_COMMIT=2a4dacc224c56ba48c9e5353eb0907156a8b35d4 \
OPENCLAW_QA_EXPECTED_GATEWAY_ENTRY_SHA256="$GATEWAY_ENTRY_SHA256" \
OPENCLAW_QA_ARTIFACT_DIR="$QA_RESULTS/baseline-named" \
pnpm exec node artifacts/operator-token-capture-linux-20261005/run-operator-token-capture.mjs
```

Compute `UI_INDEX_SHA256` and `UI_MAIN_ASSET_SHA256` after `pnpm ui:build` in the
clean UI checkout at `OPENCLAW_QA_EXPECTED_UI_COMMIT`. Compute
`GATEWAY_ENTRY_SHA256` only after the workflow has run `pnpm build` in the clean
Gateway checkout at `OPENCLAW_QA_EXPECTED_GATEWAY_COMMIT`. The helper checks the
Gateway entry digest before launch and after cleanup, and validates any available
`dist/build-info.json`, `dist/.buildstamp`, or
`dist/.runtime-postbuildstamp` source-commit/clean-input metadata. The workflow
must keep its build receipt (product commits, workflow revision, and all three
artifact digests) associated with those exact source checkouts; the helper does
not rebuild product code.

Use a separate invocation and artifact directory for each `named`, `unnamed`,
and `mutation` case under both UI variants. Set the Gateway root and expected
Gateway SHA to the actual backend source selected for that matrix cell, even
when it differs from the UI checkout. The runner records and verifies both
identities rather than silently substituting one for the other.

Each artifact directory contains `result.json`, `gateway.log`, the synthetic
runtime configuration, and desktop/mobile PNGs. The JSON omits the generated
token value and records the selected source commits, expected and observed UI
asset digests, the backend `dist/entry.js` digest and any source-build metadata,
UI mutation targets and actual acknowledgement responses, rendered card labels,
invitation state, browser version, and task-owned process cleanup evidence. A result cannot pass unless
the browser is closed, the Gateway process group is stopped, the port is
released, and the build digests still match after cleanup.
