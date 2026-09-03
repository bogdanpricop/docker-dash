# Procedures

Procedures are reusable, user-invoked operational runbooks. Unlike event-driven workflows, a procedure executes explicitly ordered stages when an administrator or operator presses **Run**. Independent steps in one stage can run concurrently.

## Permissions

- Administrators can create, edit, disable, delete, run, and inspect procedures.
- Operators can view and run a procedure only when they have `operate` permission on every referenced host.
- Viewers can see a procedure only when they have `view` permission on every referenced host.
- A Git stack step inherits access checks from every deployment target attached to that Git stack.

Only one run of a given procedure can be active at a time. Creation and editing are intentionally administrator-only because webhook and deployment steps can affect external systems.

## Supported steps

| Action | Configuration | Behavior |
|---|---|---|
| Pull image | Host, image | Pulls an image on the selected Docker/Podman host. |
| Restart container | Host, container ID/name | Restarts one container. |
| Stop container | Host, container ID/name | Stops one container. |
| Start container | Host, container ID/name | Starts one container. |
| Deploy local Compose stack | Host, stack name | Runs Compose from the working directory recorded in the stack's labels. |
| Deploy Git stack | Git stack, force flag | Starts the normal Git deployment, including all configured targets, and waits for it to finish. |
| Send notification | Optional channel, message | Sends through one channel or all enabled channels. |
| Call webhook | HTTP(S) URL, JSON payload | Sends a JSON `POST` with the procedure name, run ID, payload, and timestamp. |
| Wait | Seconds | Pauses for up to one hour and remains cancellable. |

Every step has an **On error** policy:

- **Stop run** marks the run failed and skips remaining steps.
- **Continue** records the failure, executes later steps, and finishes the run as `partial`.

## Stages, dependencies, and concurrency

Every step has a stable ID, a numeric stage, an enabled flag, and an optional comma-separated `needs` list:

- Stages run in ascending order. Existing procedures are upgraded in memory to one step per stage, so their original serial behavior is unchanged.
- Ready steps in the same stage run concurrently, bounded by **Max parallel** (1–10).
- A dependency may point to a step in the same or an earlier stage, but never a later stage.
- Duplicate IDs, missing dependencies, future-stage dependencies, and cycles are rejected when the procedure is saved.
- If a required step fails or is disabled, its dependants are persisted as `skipped`; unrelated steps can still run when the failure policy is **Continue**.
- If any step in the active batch uses **Stop run** and fails, already-started peers are allowed to finish, but no new work or later stage is started.

Each run stores per-step status, stage, start/finish timestamps, duration, message, and sanitized error alongside the bounded live log. Cancellation remains cooperative: already-started external actions cannot always be interrupted.

## Running and monitoring

Open **Operations → Procedures**, select **Run**, and keep the progress dialog open for live WebSocket updates. A polling fallback refreshes the same persisted state if WebSocket delivery is interrupted. The run can be cancelled between steps, during a wait, or while waiting for a Git deployment; an already-started external operation is not rolled back automatically.

Run records retain their procedure-name snapshot, status, completed-step count, current stage, per-step results, bounded log, initiator, and timestamps. History remains available in the database if the procedure is later deleted. Start, completion, failure, cancellation, and CRUD events are written to the audit trail.

## Templates

The editor includes three configurable starting points:

- Blue/green deploy
- Roll all containers
- Emergency stop stack

Template placeholders must be replaced with real hosts, images, containers, and Git stacks before saving.

## API

- `GET|POST /api/procedures`
- `GET|PUT|DELETE /api/procedures/:id`
- `POST /api/procedures/:id/run`
- `GET /api/procedures/:id/runs`
- `GET /api/procedures/runs/:runId`
- `POST /api/procedures/runs/:runId/cancel`
- `GET /api/procedures/templates`

Mutating requests use the same session, CSRF, read-only-mode, rate-limit, and role middleware as the rest of Docker Dash.
