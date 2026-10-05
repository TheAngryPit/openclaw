# macOS real-distribution CLI identity proof

This QA-only harness tests the macOS app's managed-CLI inspection against two
independent, real npm installations of the same pinned public release. It is
intended to run only in the disposable, standard GitHub Actions macOS job using
the repository's `scripts/test-macos-native.mts` launcher. Do not run this
suite, build, or install locally on a personal Mac.

The proof is deliberately narrow. It covers `CLIInstaller.status()`,
`CLIInstaller.managedStatus(expectedVersion:usesBundledRuntime:)`, persisted
validated-CLI defaults, and `CommandResolver.openclawExecutable()`. Both npm
prefixes use the official `openclaw@2026.9.8` tarball and the runner's actual
Node/npm toolchain. The helper places a symlink to that exact real Node binary
in each fresh prefix so the app's preferred-path ordering resolves the pinned
runtime in both selection states. The suite also checks `RuntimeLocator` against
the status APIs' production-derived search paths as a preparation gate; it does
not claim to instrument each subprocess invocation. One prefix is derived at runtime from
`CLIInstaller.installPrefix()` and `managedExecutableLocation()` under the
launcher-created HOME; the other is a distinct temporary prefix. The helper
does not guess the managed location from `OPENCLAW_STATE_DIR`.

The two serialized cells exercise these contracts:

1. Discovery selects the external CLI; inspecting the real managed CLI must
   leave the external executable and version selected, and command resolution
   must continue to return that external executable (including its resolved
   target).
2. With the validated executable/version initially unset, inspecting the
   ready managed CLI must leave both values unset.

The baseline is expected to fail only the exact identity-preservation
assertions above when the managed inspection writes the managed executable
and version into defaults; the canonical Swift Testing runner must report its
ordinary assertion-failure exit code of `1`. A red test run is not sufficient: the helper's
`verify` mode requires complete setup/install/readiness/cleanup receipts and
the exact before/after path and version evidence for the two regression
cells. Build errors, setup failures, missing tests/receipts, unrelated
assertion failures, timeouts, and cleanup/restoration failures can never count
as an expected baseline result. The candidate passes only with a successful
focused test run and all preservation checks true.

## npm preparation and failure diagnostics

The release metadata query and tarball pack run from a unique, private scratch
working directory under the receipt directory, while `--pack-destination`
keeps the verified tarball in the persistent receipt directory. This prevents
the product checkout's project configuration from becoming an input to npm
preparation. The previous run's exact cause remains unknown: its helper did not
retain npm output. In the pinned npm CLI v11.17.0 source, an explicit remote
package spec bypasses workspace expansion, and `prepack`/`postpack` hooks run
only for directory specs ([`pack.js`](https://github.com/npm/cli/blob/v11.17.0/lib/commands/pack.js),
[`libnpmpack`](https://github.com/npm/cli/blob/v11.17.0/workspaces/libnpmpack/lib/index.js)).
Thus neither product workspaces nor release lifecycle hooks are established as
the cause of that earlier failure; using scratch is an isolation improvement,
not a claimed fix for an unobserved cause.

If metadata lookup or packing fails, the setup receipt preserves any verified
release metadata and records each npm command's exit code and signal, plus the
failed command's bounded stdout/stderr tail (last 12 non-empty lines, at most
2,400 characters per stream). The helper also emits that excerpt with the
failure. URL credentials and common token or password forms are redacted before
either copy is retained.

## Workflow integration

The workflow must stage these three sidecar files into the product checkout at
`qa/maccli-real-distribution-qa-20261005/` and place the Swift test file in
`apps/macos/Tests/OpenClawIPCTests/CLIInstallerRealDistributionProofTests.swift`.
Keep the sidecar checkout separate from the product checkout so source-hash
comparison is meaningful. Do not add a production seam or modify the canonical
native launcher.

Before the Swift build, prepare a job-persistent receipt directory outside the
launcher HOME and run:

```sh
node "$SIDECAR/prepare.mjs" manifest \
  --repo-root "$PRODUCT" \
  --receipt-dir "$RUNNER_TEMP/maccli-real-distribution-receipts" \
  --sidecar-root "$SIDECAR" \
  --product-sha "$PRODUCT_SHA"
```

Prebuild the native test target with the workflow's bounded build settings,
then run the focused suite through the canonical launcher:

```sh
node scripts/test-macos-native.mts default \
  --package-path apps/macos \
  --build-system native \
  --skip-build \
  --experimental-maximum-parallelization-width 1 \
  --filter CLIInstallerRealDistributionProofTests
```

Capture the launcher exit status without losing it through log piping, and
always run the verifier afterward:

```sh
node "$PRODUCT/qa/maccli-real-distribution-qa-20261005/prepare.mjs" verify \
  --receipt-dir "$RUNNER_TEMP/maccli-real-distribution-receipts" \
  --expect baseline|candidate \
  --test-exit "$TEST_EXIT"
```

`verify` checks that the product SHA matches the selected lane, the staged
files match the immutable sidecar sources, the pinned npm integrity and bytes
match, both independent installations are real and complete, each expected
cell ran, and cleanup plus `TestIsolation` restoration succeeded. It emits a
machine-readable summary; its exit code is the gate result. Retain the summary
and all JSON receipts as workflow artifacts.

## Not established

This first slice does not invoke `updateManaged`, install/update the CLI through
the app's updater, launch or inspect UI, or validate LaunchAgent behavior. It
does not claim app-wide isolation, signing/entitlement behavior, or proof on a
personally managed Mac. The canonical launcher provides a disposable standard
GitHub Actions runner HOME and private test state for this bounded CLI test;
the evidence is only as broad as the APIs and assertions listed above.
