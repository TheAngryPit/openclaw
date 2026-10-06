# Cloudflare native QA

This directory contains the xcresult verifier used by the secretless
`cloudflare-native` workflow job. The job pins product source to
`TheAngryPit/openclaw@3c07fe17649715937b822ea0e1ed9cabd8c7c5ad` and checks out
this verifier from the workflow commit recorded by `github.workflow_sha`.

## Coverage and limits

| Selected test | Coverage | Boundary |
| --- | --- | --- |
| `CloudflareAccessClientTests` | Challenge detection, authority checks, app grants, identity and issuer metadata | Injected HTTP and synthetic tokens; no live Cloudflare account or IdP |
| `CloudflareAccessBrowserPresenterTests` | Confirmation and cancellation decisions | Captured presenter callbacks; no Safari or live login |
| `CloudflareAccessTransferTests` | Transfer decoding, polling and cancellation | Test vectors and stubbed responses; no cloud transfer service |
| `CloudflareAccessSessionStoreTests` | Sharing, expiry, retirement, revocation and authority scope | Mostly test persistence; includes an isolated simulator Keychain test |
| `GatewayAccessDeviceAuthBindingTests` | Principal binding and stale-token rejection | In-memory state and synthetic tokens; no token issued by a deployed Gateway |
| `GatewayIngressControllerTests` | Admission, lifecycle, cleanup and retirement | Includes the `GatewayIngressActivationTests` and `GatewayIngressWireTests` extensions. Fixtures are local and test-owned. |
| `GatewayIngressLoginPreparationTests` | Login preparation | Injected test collaborators; no external login |
| `SettingsHubVisualProofTests/testOlderDashboardShowsNativeGatewayUpgradeBanner()` | Legacy-dashboard banner placement in SwiftUI and WKWebView | Local HTTP fixture; not compatibility with a deployed older Gateway |

The existing `testIngressAuthorizedDashboardEntryPointsLoadTheSelectedGatewayPage()`
remains a separate, exact one-test gate. It uses a local Gateway fixture.

The canonical `scripts/ios-access-restart-proof.py` then verifies sign-out across
two app processes on one simulator installation. It checks the app, test bundle,
container, executable hashes, process IDs, retired session, and an unexpired
control session. It invokes `build-for-testing` again without an explicit
DerivedData path, so it reuses the lane's default DerivedData products
incrementally. This proves a same-build process restart. It does not test an
application update, upgrade, reinstall, or migration.

`verify-cloudflare-native-xcresult.py` fails closed on a changed product SHA,
missing suite or required UI case, unexpected test identity, duplicate or
non-passing case, failure, skip, expected failure, count mismatch, or different
simulator/configuration. Its JSON receipt records the suite counts and SHA-256
hashes for the selected tests, production owners, project specification, and
restart helper.

No runtime result is claimed by these files. The xcode-27 job must run and its
xcresults must be inspected before reporting QA as passed.
