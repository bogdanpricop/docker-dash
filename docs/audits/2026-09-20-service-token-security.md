# Service credential authority and lifecycle audit — 2026-09-20

Source baseline: `4d909f2`. These corrections are not deployed or included in the
existing 8.96.10 image. [Machine-readable evidence](2026-09-20-service-token-security.json).

## Reproduced defects

Five regression tests failed against the previous implementation:

1. A personal administrator API key with write permission could mint an independent
   service token, bypassing the user-authentication boundary for credential management.
2. Failure to write the issuance audit returned HTTP 500 but left an issued token row.
3. Disabling a workload trust did not invalidate credentials already derived from it.
4. Rotation could extend a workload credential to 24 hours despite a five-minute proof.
5. Rotation could expand workload scopes beyond the verified trust/proof grant.

Code inspection also found rotation reading the old token before acquiring its write
transaction, allowing concurrent callers to rotate the same credential. Revoking an
already-rotated ancestor did not affect its active descendants.

## Final behavior

Identity realm, workload trust and service-token administration requires a signed-in
administrator; personal API keys and service credentials are refused, including for
credential lists. Trusted proxy user authentication remains supported. Credentials
are still displayed once and stored only as hashes; administration responses use
Cache-Control no-store.

HTTP issuance, rotation and realm/trust mutations commit with their audit records.
Audit failure rolls the entire change back. This includes a requested trust disable
or deletion: an HTTP 500 means repair audit and retry, or explicitly revoke the token.
Explicit token revocation commits before its audit, so audit failure cannot restore
access. Revoking an ancestor reaches all rotation descendants, including when the
ancestor was already superseded.

Rotation reads current state inside an immediate SQLite transaction. Validation also
checks token state, proof lifetime and current trust in one write transaction, then
records last use. Expired/invalid lifetimes, malformed raw credentials and malformed
stored scope arrays fail closed.

Migration 184 adds workload trust/proof lineage to service tokens, propagated through
rotations. Scope changes, signing-key changes, issuer/audience/subject changes,
tenant or identity-kind changes, validity-policy changes, disablement and deletion
revoke all linked credentials. A name-only edit preserves credentials. Database
triggers also cover direct SQL authority changes.

Workload rotations can narrow scopes, cannot broaden them, and cannot exceed the
original proof expiry or the current trust token TTL. Independent manual tokens can
be renewed by an administrator with their existing one-day maximum.

## Upgrade impact and limits

Old workload credentials and their rotation descendants lack reconstructible lineage.
Migration 184 revokes them rather than guessing their trust. Independent manual tokens
are retained. Downgrade does not reactivate revoked credentials. Migration 183's proof
cutoff and replay history remain in effect.

At 10:39 UTC both live instances still ran 8.96.8 and had zero workload trusts, zero
active replay rows and zero active service tokens. These read-only counts contain no
names, JWKs, assertions or secrets. No production configuration was changed.

These changes do not establish tenant isolation throughout the API or cancel operations
that were already authorized before revocation. Independent SQLite databases do not
share credential state. Real external identity providers and SMTP were not exercised.
Full deployment still awaits the requested LAN/VPS account-email URLs; Docker image
findings remain separately documented in the 8.96.10 audit.

## Verification

- Original regression run: five failed tests.
- Final focused suite: 101 passed, including 34 new service-credential tests.
- Final full suite: 379 suites, 5,142 passed, one skipped.
- Lint passed; page-help coverage 60/60 with English and Romanian explanations.
- LAN and VPS: 53 native authentication checks per host using source overlays with
  verified SHA-256 hashes. New native checks cover two-process rotation, revocation
  racing rotation, workload scope/expiry/trust limits and real HTTP audit rollback.
- Every owned canary container was removed. Databases were disposable; no external
  provider calls or real email deliveries were made.

The native checks exercise the final source over the existing image; they are not
evidence that a rebuilt image containing these changes has been deployed.
