# Current Solid Profile qualification

The QA overlay remains a descendant of its existing fork tip `ceba1804295df7407fbd42241163d70dcda35d11`. The current integration uses product candidate `22b983e2889973b28ae1f3a5133a11e036aa1ec3` as its first parent and prior QA tip `28c40be825ed84153daf1da792e5bab72062ea5d` as its second parent. Its tree carries the updated overlay and workflow. The hosted workflow verifies both parent relationships and checks that the candidate-to-integration diff changes only this QA directory and its workflow. Its depth-9 blob-filtered checkout reaches the pinned prep and legacy QA commits through the second-parent history. It runs only from the registered fork, with a manually supplied full candidate SHA. Baseline is pinned to upstream main `d79ab6195d8d0566b285008bcc30c01a6ce368e2`; the candidate job checks out the supplied SHA. Node is pinned to 24.22.1. For each exact product checkout, the workflow verifies the full `packageManager` integrity pin through Corepack, compares pnpm to the version before `+`, and checks the installed Playwright version against that source's `ui/package.json`. No user credentials or personal runtime are used.

Review the product and QA diffs before publication. A successful dispatch acknowledgement or local static check does not establish a hosted pass; verify the exact workflow inputs, both matrix jobs, retained artifacts and actual screenshot contents.

## Product and overlay identities

`profile-current.real-gateway.e2e.test.ts` derives from the exact product's canonical `ui/src/e2e/profile-page.real-gateway.e2e.test.ts`. It keeps the original identity, remote name-update, unsaved draft, exact channel CRUD, fresh-reload, viewport containment and nested cleanup assertions. Both cells stage the SAME separately hashed fixture as the new untracked `ui/src/e2e/profile-current.qa.real-gateway.e2e.test.ts`. No tracked test or product file is replaced. The separately hashed config stages under the already ignored `.artifacts` directory and selects the current canonical ordinary bundled serial E2E project. Its Chromium preflight, production bundle creation, isolated-fork and Gateway cleanup remain canonical.

The baseline expects channel controls absent. The candidate expects an empty channel form and then performs the original actual browser add, reload, remove and reload sequence. The QA extension checks real exact storage after allowed CRUD. It also edits a channel draft, navigates away and back, verifies the abandoned draft did not persist, and closes its own real WebSocket proxy while another unsubmitted draft is visible. The disconnected Profile hides channel controls and storage remains empty. This last scenario does not claim to reject a pending submitted write.

`channel-identities-final-effect.test.ts` stages only in the candidate as the new untracked `src/gateway/channel-identities-final-effect.qa.test.ts`. It uses the registered Gateway request entry, actual existing storage owner and synchronous commit-admission callback. Its allowed link/unlink control precedes separate forbidden link and unlink cases for non-admin, negotiated scope removal, current role-policy revocation and requester-profile reassignment. Pending cases change authority at actual commit admission and then call the ORIGINAL admission function synchronously. The owner rejects an admission callback that returns without a decision, so this fixture never holds or fabricates a delayed commit grant. The final exact binding must remain absent or retain its original synthetic profile.

The final-effect fixture covers registered Gateway, worker and storage. It uses a synthetic in-process requester and does not separately qualify WebSocket authentication, live provider revocation, real external-account ownership or another person's sign-in. No production seam, authorization policy, role or grant is added.

## Retained proof inventory

Each cell retains candidate, product, and harness SHAs, Node, the full package-manager integrity pin, pnpm and Playwright versions, QA fixture and config digests, unchanged compiled runtime digests, and after-run source checks. Candidate add attempts also write `channel-link-add-observation.json`. The file records each channel RPC method and outcome, a fixed error-code category, whether requests and responses matched the synthetic fixture, the status category, alert presence, whether the form cleared, and whether the expected link reached canonical storage. It omits request IDs, RPC payloads, raw alert or status text, connection URLs, and identity values. `served-assets.json` records the runner image, operating system, architecture, actual Chromium version, exact browser package version, and SHA256 hashes of the UI assets consumed by the browser. The canonical E2E owner builds its UI in an isolated temporary directory. Compiled runtime digests alone do not identify the UI assets served to the browser.

Both cells must produce `06-current-profile-desktop.png` and `06-current-profile-mobile.png`. The same synthetic personal identity and current Profile are in those before/after views. Candidate additionally requires these stages at 1280x900 and 390x844.

- `07-current-channel-form` shows the current empty Solid form.
- `08-link-added` shows the exact saved link.
- `09-link-reloaded` shows the row after a fresh reload.
- `10-link-removed` shows the empty list after removal and another reload.
- `11-navigation-abandoned-draft` shows the restored empty form after navigation.
- `12-disconnecting-draft` shows entered identifiers before transport loss.
- `13-disconnected` shows the unavailable Profile after transport loss.

The current screenshot helper settles semantic content, fonts, images and viewport geometry. It retains complete viewport PNGs. It performs ordinary scrolling and canonical animation settling without replacing DOM, styles or screenshot pixels. The five incumbent filenames are retained and now use the same helper, with the profile hero, linked row or empty state framed as appropriate. Inspect the actual images before claiming the form or identity is visible.

Candidate must retain `browser-final-storage.json` and four `final-storage-*.json` receipts. Storage receipt outcomes derive from observed production replies and exact binding reads after independent assertions. JSON contains synthetic scenario labels and no credentials, raw profile IDs, IPs or endpoints. Canonical public timeout diagnostics remain retained if the run fails. Required media and receipt checks cannot be skipped to pass the run.

## Gates that remain separate

The product's current canonical CI and independent source/QA review remain required. Native installation, released-state upgrade, live external identity and complete umbrella162164 behavior are not established by this browser fixture. The Core decision between current-profile-only management and overlapping157298's person selector remains open. This QA does not invent that contract or settle maintainer acceptance.

Local actionlint, Bash syntax and pinned-format receipts qualify preparation only. Do not run product, dependency installation or this QA on the credentialed Windows host. No runtime test or screenshot has been produced by the preparation worker.
