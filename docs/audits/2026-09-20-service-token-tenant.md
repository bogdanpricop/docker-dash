# Tenant service-credential boundary — 2026-09-20

Source baseline: `4d89d8f`. Not deployed and not included in the existing 8.96.10
image. [Machine-readable evidence](2026-09-20-service-token-tenant.json).

## Evidence and behavior

Seven initial regression tests failed. Approval lists, decision lookup and policy
lists ignored the service token tenant. A tenant token could read the global role
catalog. Meanwhile, own-project reads and capacity writes failed because a service
principal has no user id. Suspending its tenant did not invalidate the credential.

Required service authentication now applies an explicit tenant route catalog before
the handler runs. Foreign path/body/query project, tenant or scope selectors are
rejected. Headers cannot override the tenant stored with the credential. Unknown
routes fail closed until their resource ownership and response filtering are added.
Global service credentials retain their explicit global scope.

The following routes support tenant credentials (GET also permits HEAD):

| Method | Path under `/api/governance` | Ownership behavior |
|---|---|---|
| GET | `/projects`, `/projects/:id` | Own project only |
| GET | `/scopes` | Own project and descendant resource scopes |
| GET | `/controls/catalog` | Static capability catalog |
| GET | `/controls/projects/:id/capacity` | Own capacity accounting |
| GET | `/controls/projects/:id/quota-requests` | Own recorded quota requests |
| GET | `/controls/approval-requests` | Own requests; ownership checked before decisions lookup and pagination |
| GET | `/controls/approval-policies`, `/controls/blackouts` | Own scopes and applicable inherited/global rules |
| PUT | `/controls/projects/:id/capacity/quotas` | Own capacity limits |
| POST | `/controls/projects/:id/capacity/allocations` | Own accounting allocations |
| DELETE | `/controls/projects/:id/capacity/allocations/:allocationId` | Allocation must belong to own project |

Read calls require governance.read or api.read. Writes require governance.write or
api.write; their responses may include the updated capacity state. Service principals
receive only project/governance read and capacity-accounting permissions, without
user membership, approval decisions, identity administration or provider execution.
Capacity mutation and audit commit together. Audit includes the token id and tenant
id, never the raw credential. Failure rolls the mutation back.

Approval records with conflicting tenant/scope ownership are excluded. Unscoped
global approval requests are not exposed as tenant-owned requests. Policies and
blackouts scoped to ancestors are visible because they apply to that project.
Session users and personal API keys continue to use their existing RBAC.

## Lifecycle and upgrade

Migration 185 backfills revocation for tokens belonging to inactive tenants and adds
a trigger for subsequent suspension/status changes away from active. Reactivating a
tenant does not resurrect old tokens. New issuance, rotation and workload exchange
verify active tenant state while holding their SQLite write transaction. Validation
also refuses inactive tenants. Global credentials remain independent.

No production settings changed. The most recent read-only live snapshot before this
checkpoint found both hosts on 8.96.8 with zero workload trusts, zero active replay
rows and zero active service tokens. Deploy still awaits the requested account-email
URLs; container image vulnerability findings remain separate.

## Verification

- Seven initial failed regressions; final focused run: 107 passed.
- 39 new unit/integration cases cover selectors, foreign ownership, supported reads
  and writes, scope denial, allocation ownership, pagination, inheritance, atomic
  audit, suspension and migration downgrade without credential resurrection.
- Full suite: 380 suites, 5,181 passed, one skipped.
- Lint passes; page-help coverage 60/60, with English/Romanian guidance.
- LAN and VPS each pass 56 native authentication checks using hash-verified source
  overlays. New checks cover real HTTP tenant boundaries/capacity audit and two
  processes racing credential issuance against tenant suspension.
- Owned canary containers are removed. Fixture databases are disposable; email and
  external identity providers remain mocked.

## Remaining limits

This is enforcement for authenticated service routes, not a claim that every API
supports tenant credentials. Provider APIs and other unreviewed authenticated paths
remain unavailable to tenant service tokens. No service-user identity is fabricated.

Code inspection found `/api/metrics` and `/api/cluster/status` still using optional
authentication in `src/routes/misc.js`. Their public global information is outside
this required-authentication boundary and needs a separate access-control correction.
Complete isolation is therefore not established by this checkpoint. Existing user
RBAC, already-authorized operations and independent SQLite deployments also require
their own applicable controls.
