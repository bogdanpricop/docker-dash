# Disk-pressure guardrails

Per-host disk-pressure policies protect Docker hosts from uncontrolled image, stopped-container, network, and BuildKit-cache growth. Configure the selected host from **System → Disk → Disk-pressure Guardrail**.

Policies are disabled and dry-run-only by default. A leader-only job evaluates enabled policies every five minutes with a configurable cooldown.

## Candidate rules

- resources must be older than the configured minimum age;
- running and paused containers are never candidates;
- images referenced by any running or stopped container are excluded;
- default or attached networks are excluded;
- resources carrying the configured protection label, default `docker-dash.protect`, are excluded;
- Docker Dash itself is excluded;
- volumes are always an empty candidate set and are never passed to a removal call.

The filesystem percentage is available for the local/default host. Remote hosts can use the Docker logical-byte threshold because the Engine API does not expose the capacity of the daemon's backing filesystem.

Live cleanup deletes the exact reviewed container, image, and network IDs. Build cache uses an age-filtered builder prune. Partial failures are persisted per run, and every manual or automatic execution is audited.

## API

- `GET|PUT /api/disk-pressure/hosts/:hostId/policy`
- `POST /api/disk-pressure/hosts/:hostId/preview`
- `POST /api/disk-pressure/hosts/:hostId/run`
- `GET /api/disk-pressure/hosts/:hostId/history`

