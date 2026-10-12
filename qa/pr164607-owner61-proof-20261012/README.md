# Current Solid Profile qualification

This QA branch is a direct child of frozen product `64123ecc8813b534a01b7cc5b4b3f57744b2bba4`. It changes only the registered fork `CI` workflow and this QA directory. Product source must match that parent exactly. The public workflow has one manual run with two standard Ubuntu24.04 cells. Baseline is main `bcd41d1aae8d60336fbf5466f22eb665ee353e4f`. Candidate is product64123ecc. Node24.21.0 and the source-owned pnpm12.9.0 lock are exact. No secrets, personal runtime, paid runner, private image or new policy is used.

Root must review the product and QA commits before publication. Root owns source and QA pushes, enable/dispatch/finally-disable/readback, actual artifact collection, visual inspection, publication and subsequent reviewer consumption. Neither these instructions nor successful static checks establish a hosted pass.

## Product and overlay identities

`profile-current.real-gateway.e2e.test.ts` derives from the exact product's canonical `ui/src/e2e/profile-page.real-gateway.e2e.test.ts`. It keeps the original identity, remote name-update, unsaved draft, exact channel CRUD, fresh-reload, viewport containment and nested cleanup assertions. Both cells stage the SAME separately hashed fixture as the new untracked `ui/src/e2e/profile-current.qa.real-gateway.e2e.test.ts`. No tracked test or product file is replaced. The separately hashed config stages under the already ignored `.artifacts` directory and selects the current canonical ordinary bundled serial E2E project. Its Chromium preflight, production bundle creation, isolated-fork and Gateway cleanup remain canonical.

The baseline expects channel controls absent. The candidate expects an empty channel form and then performs the original actual browser add, reload, remove and reload sequence. The QA extension checks real exact storage after allowed CRUD. It also edits a channel draft, navigates away and back, verifies the abandoned draft did not persist, and closes its own real WebSocket proxy while another unsubmitted draft is visible. The disconnected Profile hides channel controls and storage remains empty. This last scenario does not claim to reject a pending submitted write.

`channel-identities-final-effect.test.ts` stages only in the candidate as the new untracked `src/gateway/channel-identities-final-effect.qa.test.ts`. It uses the registered Gateway request entry, actual existing storage owner and synchronous commit-admission callback. Its allowed link/unlink control precedes separate forbidden link and unlink cases for non-admin, negotiated scope removal, current role-policy revocation and requester-profile reassignment. Pending cases change authority at actual commit admission and then call the ORIGINAL admission function synchronously. The owner rejects an admission callback that returns without a decision, so this fixture never holds or fabricates a delayed commit grant. The final exact binding must remain absent or retain its original synthetic profile.

The final-effect fixture covers registered Gateway, worker and storage. It uses a synthetic in-process requester and does not separately qualify WebSocket authentication, live provider revocation, real external-account ownership or another person's sign-in. No production seam, authorization policy, role or grant is added.

## Retained proof inventory

Each cell retains product/harness SHA, exact package-manager pin, QA fixture/config digests, unchanged compiled runtime digests and after-run source checks. `served-assets.json` records SHA256 of the actual UI asset responses consumed by the browser. The canonical ordinary E2E owner builds its UI in an isolated temporary directory; compiled runtime digests alone are not the served UI identity.

Both cells must produce `06-current-profile-desktop.png` and `06-current-profile-mobile.png`. The same synthetic personal identity and current Profile are in those before/after views. Candidate additionally requires these stages at1280x900 and390x844.

- `07-current-channel-form` shows the current empty Solid form.
- `08-link-added` shows the exact saved link.
- `09-link-reloaded` shows the row after a fresh reload.
- `10-link-removed` shows the empty list after removal and another reload.
- `11-navigation-abandoned-draft` shows the restored empty form after navigation.
- `12-disconnecting-draft` shows entered identifiers before transport loss.
- `13-disconnected` shows the unavailable Profile after transport loss.

The current screenshot helper settles semantic content, fonts, images and viewport geometry. It retains complete viewport PNGs. It performs ordinary scrolling and canonical animation settling without replacing DOM, styles or screenshot pixels. Original existing five incumbent captures are also retained. Root must inspect the actual image contents before claiming the form or identity is visible.

Candidate must retain `browser-final-storage.json` and four `final-storage-*.json` receipts. Storage receipt outcomes derive from observed production replies and exact binding reads after independent assertions. JSON contains synthetic scenario labels and no credentials, raw profile IDs, IPs or endpoints. Canonical public timeout diagnostics remain retained if the run fails. Required media and receipt checks cannot be skipped to pass the run.

## Gates that remain separate

The product's current canonical CI and independent source/QA review remain required. Native installation, released-state upgrade, live external identity and complete umbrella162164 behavior are not established by this browser fixture. The Core decision between current-profile-only management and overlapping157298's person selector remains open. This QA does not invent that contract or settle maintainer acceptance.

Local actionlint, Bash syntax and pinned-format receipts qualify preparation only. Do not run product, dependency installation or this QA on the credentialed Windows host. No runtime test or screenshot has been produced by the preparation worker.
