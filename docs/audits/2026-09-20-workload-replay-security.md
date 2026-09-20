# Workload assertion replay and issuance audit — 2026-09-20

Source baseline: `725272d`. Changes are not deployed and are not included in the
existing 8.96.10 image. [Machine-readable evidence](2026-09-20-workload-replay-security.json).

## Reproduced defects and correction

Three regression tests failed against the previous implementation: adding signature
padding, replacing an ES256 signature with the equally valid `(r, n-s)` signature,
and signing changed claims with the same issuer/JWT id each obtained a second token.
The old replay key hashed the complete textual JWT, including its signature.

Canonical base64url and strict UTF-8 object parsing now reject ambiguous encoding.
Replay identities hash the signed header/payload and, when present, issuer/jti.
The new replay table has no trust foreign key, so deleting/recreating a trust does
not erase those records. Records last until the accepted proof expires; issuers
must use unique ids. This is not indefinite jti retention.

Validation checks identity/time claim types, unsupported critical headers, allowed
algorithms and JWK alg/use/key_ops. RSA requires at least 2048 bits; ES256 requires
P-256 and a 64-byte signature; EdDSA requires Ed25519 or Ed448. RSA, ECDSA and EdDSA
success paths remain tested. Guidance:
[RFC 8725 algorithm verification](https://www.rfc-editor.org/rfc/rfc8725.html#section-3.1)
and [RFC 7519 JWT id](https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1.7).

An immediate SQLite transaction now includes current trust verification, replay
registration, token creation and synchronous HTTP audit. Audit failure rolls all
of them back, allowing a later successful retry. HTTP exchange obeys read-only mode
and returns no-store for issuance responses. The audit contains trust id/scopes and
principal, never the assertion or returned credential. Tokens with less than a
minute of remaining proof validity are supported, without exceeding proof expiry.

## Upgrade impact

Migration 183 revokes existing workload-exchange tokens and all rotation descendants,
because the old scheme cannot establish whether they resulted from replay. Independent
manual credentials are preserved. Downgrading the schema does not reactivate tokens.

Raw legacy digests cannot reconstruct the signed-content or issuer/jti keys. Where
unexpired legacy replay history exists, the migration records its timestamp plus
60 seconds as a minimum iat. Proofs must be issued strictly after this cutoff; the
issuer may need to wait up to 61 seconds and issue a fresh proof. Fresh databases
and installations without active legacy history use a zero cutoff.

The read-only live snapshot at 10:27 UTC found zero workload trusts, zero active
replay rows and zero active service tokens on both hosts. Both still ran 8.96.8.
No production data or Docker daemon configuration was changed.

## Verification

- Full suite: 378 suites, 5,106 passed, one skipped.
- Final focused run: 44 passed, including two additional weak-RSA/wrong-curve cases
  added after the full run; 33 new tests in this checkpoint.
- Lint passed; help coverage remains 60/60 with English/Romanian workload guidance.
- LAN and VPS each passed 49 native authentication checks using the existing image
  with SHA-256-verified source overlays. New checks cover replay variants, trust
  recreation, two-process single redemption, HTTP read-only and audit rollback.
- All owned canary containers were removed. Tests used isolated fixture databases;
  external providers and email delivery remained mocked.
- npm audit reports zero known vulnerabilities; npm outdated reports `{}`. This
  does not clear the separate container image findings documented in the 8.96.10 audit.

## Remaining limits

Changing or deleting a trust does not yet revoke already issued tokens automatically.
This correction does not establish general service-token tenant isolation or harden
every credential administration route. Replay sharing requires the same SQLite
database; it is not a distributed replay service across independent databases.
No real external identity provider exchange or SMTP delivery was performed.
Full rollout still awaits the LAN/VPS account-email URLs requested from the user.
