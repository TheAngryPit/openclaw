# PR 193672 shipped-build evidence

Head: `4eee8c3ca781b991bb6d9a76325655bb46c12e58`.

## Results

- Desktop failed notice and confirmation captured against an isolated real Gateway and production-built Control UI with synthetic fixture/selected and fixture/default models.
- Real Gateway flow passed (1 test): cancellation/concurrent selection rejected stale switch; confirmed switch patched the default model; no failed-message replay or extra provider request; auth/runtime overrides preserved.
- **Mobile 400 px is NOT visually corrected.** Current shipped markup has the expected icon/copy/button classes, but the long default-model action consumes the flexible row. Measured copy column width is **0 CSS px**, height 175.46875 px; the screenshot shows help text squeezed vertically underneath the action. Do not describe this image as a successful mobile fix.
- Focused committed regression: original recovery markup from `981424ca6^1` fails (exit 1, 1 failed / 29 skipped); exact head passes (exit 0, 1 passed / 29 skipped). This DOM-structure assertion does not establish usable mobile geometry.

## Commands

```sh
node scripts/run-vitest.mjs run --config test/vitest/vitest.ui.config.ts --configLoader runner ui/src/pages/chat/chat-view-notices.test.tsx -t 'keeps default-model recovery help'
node /path/to/pnpm.mjs ui:build
node /path/to/pnpm.mjs build:runtime
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/installed/chrome-headless-shell OPENCLAW_VITEST_RUNTIME=node node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/pr193672.real-gateway.e2e.test.ts
```

The temporary real-Gateway test reuses the preserved harness and adds desktop/mobile screenshots plus geometry capture; the temporary suite-inventory entry and test were removed afterward. The original recovery block was temporarily substituted only for the red test and restored byte-for-byte before the green test. No PR code commits or pushes.

## Build/setup qualifications

The first full Chromium binary exited SIGTRAP; the installed Chromium headless shell worked. The first Gateway attempt identified stale local build artifacts (schema 40 vs fixture schema 41), so the runtime was rebuilt from the pinned checkout. A full package build was stopped during unrelated declaration generation, then supported build:runtime completed successfully. UI build completed successfully; report-only performance output listed existing budget overages. Final real-Gateway test passed against the rebuilt runtime and production UI.

## Media review

All three PNGs inspected visually. Desktop notice text and model-switch confirmation are readable; mobile exposes the defect above. Only neutral synthetic session/model text is visible; no IP addresses, hostnames, tokens, private paths, or protected model/provider identities appear. PNG metadata stripped, retaining only IHDR/IDAT/IEND chunks. Raw logs and RPC/state details remain private and are not published. Public regression logs have local paths sanitized.
