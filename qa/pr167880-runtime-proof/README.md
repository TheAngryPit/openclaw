# PR 167880 installed-runtime proof

This fixture checks the installable OpenClaw package on a disposable, public GitHub-hosted Ubuntu 24.04 runner. It runs the packaged CLI under the runner's real systemd supervisor beside a separate, real Tailscale userspace daemon; it does not launch source-tree Gateway code or run the product test suite.

The owning workflow is [CI](../../.github/workflows/ci.yml). It builds the candidate archive and immutable runtime images from the exact product SHA, then calls the controller phases in order. These phases are workflow-owned, not a local runtime command: the controller fails closed unless the GitHub runner, Ubuntu version, systemd PID 1, exact source SHA, run identity, and image IDs match the proof contract.

## Proof phases

- `parking` starts a fresh unlogged-in Tailscale node and the installed Gateway. It observes the exact Gateway “startup is parked” signal in a private Docker log snapshot, then confirms `NeedsLogin`, the same active systemd invocation with `Restart=no` and zero restarts, no TCP listeners in either `/proc/net/tcp` table, and no Tailscale Serve claim before and after the bounded backoff interval.
- `recovery` is required only for full mode. The workflow authenticates the sidecar through its mounted private key file; the controller never receives or prints the key. It observes the same node recover to `Running`, checking only boolean equality for the expected DNS suffix and approved tag. It then probes ordinary Gateway readiness on port 18789 separately from the actual strict-loopback Serve backend port, and verifies the foreground Serve process and claim belong to this supervised Gateway.
- `cancel` creates a second fresh `NeedsLogin` node, observes the same parked signal and listener-free wait, then asks systemd to stop the service and verifies its graceful zero exit, zero restarts, no OOM kill, gone process, and released Serve claim.
- `cleanup` retains bounded raw Gateway logs, sidecar logs, and the exact unit journal only under `QA_ROOT/private/diagnostics/` before removing verified stopped resources. It never force-kills or removes a still-running/failed Gateway container.
- `summarize` writes the explicit allowlisted receipt files under `QA_ROOT/public/`. The workflow uploads only that directory.

The public pin receipt records the product/workflow SHA, immutable image IDs, installed package version and archive/CLI hashes, and observed Tailscale version and binary hashes. Public phase evidence is restricted to booleans, bounded durations, fixed statuses, and those validated pins. Tailnet names, addresses, status JSON, tags, Serve configuration, Gateway configuration, tokens, logs, keys, and daemon state are not public receipt fields. Diagnostic files in `private/` can contain sensitive runtime output and must never be uploaded.

The installed-process check verifies supervisor custody: the exact container launch command, Node executable, working directory and systemd invocation must match. It recognizes either the installed launcher argv or the Gateway's exact `openclaw-gateway` process title, which replaces argv on Linux. A legitimate respawn parent may remain PID 1; this check does not claim PID 1 itself serves requests. Parking signals, listener checks and graceful shutdown remain independent required observations.

Full mode requires the dedicated test-tailnet secret `TS_QA_AUTHKEY` plus `TS_QA_EXPECTED_DNS_SUFFIX` and `TS_QA_TAG` variables. The workflow rejects missing values before building images. The key is mounted only into the sidecar's private auth directory for the separate operator step; it is not passed to this controller or the Gateway container. Parking mode needs none of those values.

## Tracked-startup regression

The separate `tailscale-tracked-regression` lane uses the pinned dependency builder and frozen baseline `59d29a7c1683dbb33f25e35c5196475e3a8b7b8d`, without packaging an app for a unit test. It verifies the three baseline source files by hash, applies the test-only overlay and requires the real prerequisite-waiter cancellation test to fail specifically with exit 1 instead of 0. It then applies the source-only repair overlay and requires that test plus six error-identity, cleanup and foreground controls to pass. Both variants use the same installed dependencies and separate module caches. The workflow rejects incomplete proof and uploads the closed phase/failure-category receipt even on failure.

This lane exports only a closed pass/count/duration receipt. Test output stays inside the disposable builder. The candidate is baseline plus the inspected repair overlay, not a published source revision or installed-runtime cancellation proof.

## Proof limits

Upgrade survival is explicitly `NOT_RUN`: this fixture does not install a published predecessor or prove settings preservation across update. It also does not prove HTTPS reachability from another tailnet peer. A successful full-mode receipt is therefore partial operational evidence for this one isolated node, not upgrade acceptance, cross-peer HTTPS acceptance, or production-tailnet proof. If upgrade or cross-peer proof is required, it needs its own approved fixture and assertions rather than inference from this result.
