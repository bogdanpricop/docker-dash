# Signed Compose blueprint catalog

Docker Dash provides a curated catalog for reusable OCI Compose applications. Each published catalog version points to an immutable SHA-256 OCI manifest, carries cryptographic trust evidence, declares typed inputs and produces a deterministic, secret-safe local override.

The catalog is a controlled source of application definitions. It does not bypass the OCI Compose deployment boundary: instantiation creates a stopped OCI application definition, and deployment still requires a fresh Docker Compose dry-run plan plus explicit confirmation in **Git Stacks → OCI Apps**.

## Capabilities

- catalog metadata with owner, category, support level and draft/active/deprecated/retired lifecycle;
- immutable semantic versions whose OCI tags are resolved once to `sha256:` digests;
- mandatory Cosign verification and an explicit signer identity regexp before publication or restoration;
- typed `string`, `integer`, `boolean`, `enum` and `secret_ref` parameters;
- exact-scalar placeholders such as `{{parameter.port}}` in a local Compose override template;
- daemon/environment/architecture compatibility declarations and a minimum Compose version;
- healthcheck expectations, backup/restore guidance and bounded CPU/memory/storage estimates;
- deterministic preview hashes for version, parameters, rendered override and the complete instantiation plan;
- immutable version diff, deprecation and restoration of a prior verified catalog default;
- host-scoped operator instantiation, idempotent OCI hand-off and hash-only history;
- administrator authoring, role/host enforcement and sanitized audit events.

## Trust and secret model

Creating a version performs an OCI manifest lookup and stores the resolved digest. A version may remain a draft with weaker evidence, but publication is fail-closed unless all of these are true:

1. the reference resolved to a complete SHA-256 digest and OCI schema v2 manifest;
2. the version uses the `cosign` policy;
3. an explicit signer identity regexp is present;
4. Cosign returned successful cryptographic verification;
5. publication-time verification still succeeds.

Restoring a deprecated version repeats the same trust check. Annotation presence alone is not sufficient.

Parameters whose names resemble credentials must use `secret_ref`, and their keys must end in `Ref` or `Reference`. Accepted values are approved manager URIs such as `vault://...` or exact symbolic environment references such as `${APP_TOKEN}`. The rendered Compose document passes the shared secret-reference admission service before it can become an OCI application override.

Raw parameters and raw secret references are never stored in instantiation history or audit. History contains only SHA-256 hashes. Preview responses contain the rendered symbolic references so an operator can review what Compose will receive; they never resolve a secret.

The override validator also rejects local builds, bind mounts, remote includes and file-backed local secrets/configs. These controls preserve the existing OCI Compose trust boundary.

## Versioning and rollback semantics

Publishing a new version deprecates the prior published version and makes the new digest the catalog default. The diff endpoint reports digest, trust policy, parameter schema, override, compatibility and operational-profile changes without resolving secrets.

An administrator may restore a deprecated version. Restoration changes only the catalog default after a new Cosign verification. It does **not** mutate deployed applications. Existing applications retain their stored digest. An operator must separately create or update an OCI application and review its own dry-run plan before deployment; this avoids an implicit fleet rollback.

Version rows are otherwise immutable. Retired versions and blueprints cannot return to service.

## Compatibility and operational metadata

Compatibility declares supported Docker/Podman daemons, target environments, publisher-supported architectures and the minimum Compose version. Instantiation enforces active host, daemon and environment locally. Architecture remains publisher-declared because `docker_hosts` does not persist normalized CPU architecture; Docker/OCI performs final platform selection during the reviewed plan and deploy.

The operational profile contains:

- required healthcheck service names and a bounded expected timeout;
- backup mode, named volume hints and an optional HTTPS runbook;
- bounded CPU millicore, memory MiB and storage GiB estimates.

These fields are planning guidance. They do not create monitoring, backups or reservations, and their UI labels state that boundary.

The outer OCI Compose artifact is pinned. Images referenced inside the publisher's Compose bundle can only be guaranteed pinned by the publisher because Docker Dash does not extract and rewrite the remote bundle. The mandatory dry-run remains the final visible check before deployment.

## Roles and host scope

| Action | Administrator | Operator |
|---|---:|---:|
| View active/deprecated catalog | Yes | Yes |
| View drafts and retired entries | Yes | No |
| Author metadata/version | Yes | No |
| Publish/deprecate/restore/retire | Yes | No |
| Preview/instantiate | Yes | Yes, with effective `operate` access to the host |
| View history | Yes | Only rows for hosts with effective `view` access |

The migration registers `compose_blueprint.view`, `compose_blueprint.manage` and `compose_blueprint.instantiate` in the governance permission catalog. HTTP enforcement uses the established admin/operator roles and effective host permissions.

## Operator workflow

1. An administrator creates a draft blueprint with owner, category and support level.
2. The administrator adds a semantic version, registry reference, Cosign signer policy, parameter schema, override template, compatibility and operational profile.
3. Docker Dash resolves and verifies the artifact. The administrator reviews and publishes the version.
4. An operator opens **Compose Catalog**, selects an active blueprint and enters target, environment and typed parameters.
5. Docker Dash validates the input and shows the deterministic plan hashes plus rendered symbolic override.
6. Confirmation creates a stopped, digest-pinned OCI Compose application definition exactly once.
7. The operator opens **Git Stacks → OCI Apps**, generates a fresh Docker Compose dry-run plan and explicitly deploys that exact plan hash.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/compose-blueprints` | Permission-filtered catalog |
| `GET` | `/api/compose-blueprints/:id?versions=true` | Metadata and visible immutable versions |
| `POST/PUT` | `/api/compose-blueprints...` | Administrator metadata authoring |
| `POST` | `/api/compose-blueprints/:id/state` | Blueprint lifecycle transition |
| `POST` | `/api/compose-blueprints/:id/versions` | Resolve, validate and create an immutable version |
| `POST` | `/api/compose-blueprints/:id/versions/:versionId/state` | Publish, deprecate, restore or retire |
| `GET` | `/api/compose-blueprints/:id/versions/:versionId/diff` | Compare with `?against=<versionId>` or the preceding version |
| `POST` | `/api/compose-blueprints/:id/versions/:versionId/preview` | Validate and generate a deterministic safe plan |
| `POST` | `/api/compose-blueprints/:id/versions/:versionId/instantiate` | Idempotently create the OCI application definition |
| `GET` | `/api/compose-blueprints/:id/instantiations` | Host-filtered, hash-only history |

## Publisher and incident runbook

- Sign the immutable OCI Compose artifact in CI with a dedicated release identity. Do not use a broad identity regexp.
- Rotate signing identity by publishing a new version and signer policy. Existing versions retain their evidence; restoration must pass current verification.
- On template compromise, deprecate the affected version immediately, publish a known-good digest or restore a verified prior version, then retire the compromised version after impact review.
- Catalog state does not prove deployed state. Use OCI application inventory and deployment history to identify instances, review a plan for each intended rollback and preserve application-specific backup requirements.
- If `COSIGN_UNAVAILABLE` or verification fails, do not weaken the policy. Restore the verifier/trust configuration and retry with a new request.
- Back up the Docker Dash database before rollout. Migration rollback drops only the three catalog tables and its three governance permission rows; it does not remove OCI applications already created from the catalog.

## Qualification boundary

Automated tests cover migration, immutable hashing, trust failure, parameter/admission failure, compatibility, deterministic preview, stale plan rejection, idempotency, diff/restore, RBAC, audit redaction and UI contracts. Production qualification still needs a real signed OCI Compose artifact, the deployment's Cosign trust root, Docker Compose 2.34+ and an approved disposable target. A browser smoke should be recorded when an in-app browser runtime is available.
