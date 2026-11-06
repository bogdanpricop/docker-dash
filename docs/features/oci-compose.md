# OCI Compose applications

Docker Dash can import and deploy a Compose application published to an OCI registry. Docker Compose 2.34.0 or newer is required. The implementation follows Docker's documented `docker compose -f oci://...` workflow.

## Pinning and trust

On import, a tag is resolved through the Registry V2 API and the returned `sha256` digest is persisted. Plans and deployments always use `oci://registry/repository@sha256:...`; a mutable tag is never used at runtime. Refreshing a definition is the explicit operation that resolves the tag again.

Trust policies are:

- `none`: digest pinning only;
- `annotation`: require a recognized signature annotation and optionally match its signer. This detects metadata but is not cryptographic verification;
- `cosign`: invoke `cosign verify` against the pinned digest. The request fails with `501 COSIGN_UNAVAILABLE` if the binary is absent.

A Docker Compose dry-run is mandatory before deployment. Apply carries the reviewed plan hash, which is bound to the digest, target host, project name, override, and trust policy. Local overrides may not add builds, bind mounts, or remote includes.

The Compose subprocess receives only the operating-system and Docker connection variables it needs. Docker Dash process secrets are excluded from Compose interpolation, and implicit `.env` loading is disabled.

## API

- `GET|POST /api/oci-compose`
- `POST /api/oci-compose/:id/refresh`
- `POST /api/oci-compose/:id/plan`
- `POST /api/oci-compose/:id/deploy`
- `POST /api/oci-compose/:id/down`
- `DELETE /api/oci-compose/:id`

The Git Stacks page exposes these operations under **OCI Apps**.
