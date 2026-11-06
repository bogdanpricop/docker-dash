# Declarative fleet GitOps

Docker Dash can export fleet configuration as a versioned YAML document, calculate a semantic plan against live state, and apply exactly the reviewed plan. Open **Git Stacks → Fleet GitOps** as an administrator to use the editor and plan viewer.

## Document model

```yaml
apiVersion: docker-dash.io/v1alpha1
kind: FleetConfiguration
metadata:
  name: docker-dash-fleet
  authoritative: false
spec:
  hosts: []
  hostGroups: []
  gitStacks: []
  procedures: []
  notificationReferences: []
```

Resources use stable names rather than database IDs. Host-group members, Git deployment targets, Git credentials, procedure targets, Git-stack steps, and notification steps therefore remain readable and portable across installations.

The parser accepts YAML or JSON up to 1 MiB. It normalizes ordering and defaults, rejects duplicate names, invalid Compose paths, unsupported actions, malformed procedure graphs, missing references, and ambiguous live names before any mutation begins.

## Export and secrets

Exports never contain TLS material, SSH credentials, Git tokens/keys, notification-channel configuration, environment overrides, custom CAs, or webhook URLs/payloads. Existing secret-backed resources use symbolic references such as:

- `existing-host/production`
- Git credential names in `credentialRef`
- notification-channel names in `notificationRef`
- `existing-procedure/release/notify-hook`

A symbolic reference preserves an existing local secret; it does not transport that secret to another installation. New SSH/TLS/non-Docker hosts and new webhook procedures must first be registered interactively. Missing or ambiguous references appear as blocked plan entries.

## Plan and apply safety

Planning produces `create`, `update`, `delete`, `unchanged`, and `blocked` entries plus three SHA-256 hashes:

- `stateHash` identifies the normalized live state used by the plan.
- `documentHash` identifies the normalized desired document.
- `planHash` binds the state, document, actions, blocked entries, and ownership mode.

Apply requires the exact `planHash`. Docker Dash recomputes the entire plan and returns `409 STALE_PLAN` if either the document or live state changed after review. Plans with blocked entries cannot be applied.

Omitted resources are ignored by default. Deletion requires both `metadata.authoritative: true` and `allowDelete: true` on the apply request; the UI also requires a final destructive-action confirmation. The default host, running procedures, and deploying Git stacks remain protected.

Declaratively created Git stacks are saved with status `pending` and are not cloned or deployed automatically. This separates configuration reconciliation from a production rollout; use the normal explicit deploy action afterward.

## Managed repository write-back

An administrator can bind the fleet document to a path in an existing Git Stack from **Git Stacks → Managed Git**. Docker Dash exports the same normalized, secret-free document, fetches the remote branch, and produces a bounded unified diff before any commit. Apply requires the reviewed plan hash, refuses a diverged checkout, and never force-pushes.

Write-back can remain manual or run automatically after a successful Fleet GitOps apply. Automatic failures are reported independently and do not disguise the successful fleet reconciliation. The managed path cannot overwrite that stack's Compose or additional Compose files. See [Managed GitOps write-back](managed-gitops-writeback.md) for the full safety contract.

## API

- `GET /api/gitops/export` returns the document, YAML, and state hash.
- `GET /api/gitops/export?download=yaml` downloads the YAML file.
- `POST /api/gitops/plan` accepts `{ "document": "<yaml-or-object>" }`.
- `POST /api/gitops/apply` accepts `{ "document": "<yaml-or-object>", "planHash": "...", "allowDelete": false }`.
- `GET /api/gitops/managed` lists managed repository targets.
- `PUT /api/gitops/managed` creates or updates a managed target.
- `POST /api/gitops/managed/:id/plan` returns the exact proposed diff and plan hash.
- `POST /api/gitops/managed/:id/apply` commits and pushes the reviewed plan without force.

All endpoints require an administrator. Apply also obeys read-only mode and CSRF protection. Export, plan, and apply write bounded, secret-free audit records.
