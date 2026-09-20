# Scoped egress authorization — 20 September 2026

The existing global allowlist union violates the container/stack policy contract.
Replace it with a local authorization lookup on every new proxy connection.

## Contract

- The application owns a Unix socket in the shared egress volume. It is not an
  HTTP route on the public application listener. Only the application and the
  trusted sidecar may mount this volume; socket mode is 0600.
- The sidecar submits the TCP peer IP, never a client-controlled HTTP header.
- The resolver looks up running containers on the configured Docker host and
  requires exactly one matching network address. It inspects that container
  again, validates identity/address/running state and filter preconditions.
- Container policies match the canonical Docker ID (unambiguous legacy short
  IDs are supported). Stack policies match the inspected Compose project label.
  Host scope is checked, including Docker Dash's default-host ID alias.
- All matching enforce policies must permit the destination. Audit-only policies
  can record misses but cannot override an enforce policy. No policy, unknown
  source, ambiguous identity, invalid response, resolver failure or timeout denies
  the connection. There is no fallback to a global policy or cached decision.
- Schema 2 policy files contain an empty enforce allowlist, so older sidecars
  fail closed during an upgrade. Schema 1 remains available only for standalone
  manually configured single-policy proxies.
- Resolution and replies are bounded. Backend mutations are visible to the next
  connection; existing streams retain the policy accepted at connection time.

## Trust and deployment assumptions

Source identity relies on a trusted Docker bridge preserving peer IPs. This is
not cryptographic workload attestation. Host administrators, privileged peers,
ARP/source spoofing and externally NATed shared sources require network isolation
or host anti-spoofing controls. Containers with namespace-changing capabilities
are refused. The resolver is scoped to one Docker host, never a union of hosts.
Use one app/sidecar authorization domain per host. Remote socket volume transport
is not provided by this change.

## Acceptance and remaining work

- Node tests: exact container/stack/host matching, ambiguity, stopped/replaced
  containers, missing policies, capability prechecks, limits and errors.
- Go tests: scoped intersection, audit behavior, missing/malformed authorization,
  timeout, strict response bounds and actual Unix-socket protocol on Linux CI.
- Application startup/shutdown manages the socket; the sidecar uses it by default
  for schema 2. No Docker socket is exposed to the sidecar.
- Disposable Docker canary (`scripts/smoke-egress-isolation.js`) passed on the
  authorized LAN Docker host on 2026-09-20: two containers do not inherit each
  other's allowlists, stack/container overlap is restrictive, audit cannot
  override enforce, policy revocation is immediate for new connections, IP reuse
  does not inherit identity, recreating a removed policy succeeds and unavailable
  authorization revokes a previously allowed destination. All 12 scenarios passed. Resources were
  removed after the test. This exercises real production modules and Unix sockets.
- Runner atomic table replacement, bounded helpers and truthful snapshot recovery
  subsequently passed disposable Docker canaries on LAN and VPS. See
  [transaction evidence](../../../audits/2026-09-20-egress-transactions.md).
  IPv6/non-TCP handling, private exceptions, restart reconciliation and log
  attribution remain required work. Passing these tests does not close full
  egress enforcement.
