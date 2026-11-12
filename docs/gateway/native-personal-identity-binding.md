---
title: Native personal identity binding
summary: "Gateway protocol contract for continuing verified personal admission over local TLS."
read_when:
  - Implementing a native local personal identity client
  - Reviewing personal binding admission and revocation
---

# Native personal identity binding

This implementation candidate follows the [local identity proposal](/specs/native-local-personal-identity).
It adds a Gateway-owned continuation of verified Tailscale Serve admission. It does
not identify people from shared credentials, device ownership, display names, or
loopback addresses. Existing pairing, role, scope, profile, and delegated-user
policies remain authoritative. A binding does not grant administrator permission.

## Discover support before enrollment

An ordinary authenticated Serve `hello-ok` advertises
`native-personal-identity-binding-v1` in `features.capabilities`. This is protocol
support, not a statement that this connection is eligible. Clients must discover
support before sending the new `personalIdentity` connect field. If the capability
is absent, report that local personal admission is unsupported. Do not attempt
enrollment or silently switch the selected personal connection to Shared owner.

The capability uses the existing extensible string vector; it does not change the
global protocol version. Old clients that do not request a binding receive no
`personalIdentityBinding` field. The signed V4 payload applies only when a client
supplies an explicit personal intent; ordinary V2/V3 device admission is unchanged.

## Bind, then use

1. On authenticated Tailscale Serve, send a signed V4 `personalIdentity` intent with
   `mode: personal-identity`, `provider: tailscale`, `phase: bind`, a fresh
   `bindingId`, and `issuedAtMs`. The device must already have a current paired
   operator credential with the requested scopes. Core resolves the canonical
   profile from verified ingress and independently revalidates the provider.
2. Require the returned binding to match the request and canonical personal
   profile. Its `gatewayId` must match `hello.server.bootId`. Retain the attested
   local `tlsFingerprint` only from this trusted enrollment connection.
3. Authenticate the local Gateway's TLS certificate against that fingerprint
   before sending personal proof. Connect to literal loopback with ordinary local
   authentication and a fresh signed V4 `phase: use` intent carrying the exact
   `bindingId`, `profileId`, `gatewayId`, and `issuedAtMs`.
4. The Gateway checks current pairing, exact device generation and scope set,
   canonical profile authority, and current Tailscale identity. Invalid personal
   admission is rejected; shared authentication does not substitute another actor.

V4 signs the complete intent together with the challenge, client/device metadata,
role, scopes, timestamp, and ordinary authentication material. Bind timestamps must
match the signed device timestamp. Both admission phases enforce the existing
two-minute signature freshness window. The binding identifier alone is not a
bearer credential and must not be exposed as a reusable browser authorization.

## Lifetime and recovery

Bindings live only in the current Gateway process. Gateway shutdown, device token
rotation/revocation/removal, or a replacement binding retires affected authority.
Pending and retained request work observes binding invalidation through its
existing authority and cancellation checks. Restart or invalidation requires new
verified Serve enrollment; no database migration or persistent credential is added.

The Gateway revalidates provider identity when admitting each bound request.
Provider unavailability or a changed login fails closed and retires the binding.
There is no provider push-invalidation subscription: instantaneous Tailscale
logout cancellation during a lone pending request is not guaranteed. Provider
validity between checks remains distinct from local binding revocation.

Native clients own TLS verification, unsupported-server recovery, connection
generation retirement, and the decision to select Shared owner explicitly. Device
and node connections retain their separate identities. Client implementation,
installed-state upgrade, final message attribution, and live-provider behavior
require their own end-to-end qualification.
