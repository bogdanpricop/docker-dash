# Compose stacks

Docker Dash runs local Compose stack actions asynchronously so a slow pull, restart, or deployment does not block unrelated HTTP requests. The Stacks page displays live `stdout` and `stderr` in an accessible progress dialog for **Up**, **Down**, **Restart**, and **Pull**.

## Deployment plan

Before one of those four actions runs, Docker Dash invokes `docker compose --progress json --dry-run` with the same stack directory and selected-host Docker context. The confirmation dialog shows the redacted, bounded plan and a summary of classified create, remove, pull, build, start, restart, wait, and no-op steps. The real action starts only after confirmation.

The read-only API is `POST /api/system/compose/:stack/:action/plan`. It is restricted to administrators and operators, shares the three-operation per-user concurrency limit, caps output at 1 MB before normalization and 100 KB in the response, and audits `compose_<action>_plan`. If a host uses an older Compose version without dry-run/JSON progress, the endpoint returns HTTP 501 with `compose_dry_run_unsupported`; it never executes the real action as a fallback. The UI labels this limitation and requires a separate explicit confirmation to continue without a plan.

## Progress and failure behavior

- Docker Dash invokes `docker compose --ansi never` through `spawn`; it never uses a shell.
- Actions have a 120-second default timeout. The child receives `SIGTERM` and then `SIGKILL` if it does not exit.
- Output pipes continue to be consumed, while captured and streamed output is capped at 5 MB. A visible truncation marker is emitted when the limit is reached.
- Closing the progress dialog or losing the browser connection does not kill an in-flight Compose command. The server lets it reach a safe terminal state and records the result.
- Separate stacks can run concurrently, with at most three active Compose operations per user; further requests receive HTTP 429 until a slot becomes available. Each result includes exit code, duration, and bounded output.

## API

The live endpoint is:

- `POST /api/system/compose/:stack/:action/stream`

`action` must be `up`, `down`, `restart`, or `pull`. The response is `text/event-stream` with `start`, `output`, `done`, and `error` events. Because native `EventSource` cannot send a `POST`, the browser consumes the response with `fetch()` and `ReadableStream`.

Existing clients can continue to use the JSON endpoint:

- `POST /api/system/compose/:stack/:action`

It uses the same asynchronous runner and returns only after the command completes. Compose config rendering, validation, stack creation, and stack deployment also use the non-blocking runner.

Both endpoints require an authenticated administrator or operator and honor writeable/read-only mode and CSRF protection. Each action is audited as `compose_up`, `compose_down`, `compose_restart`, or `compose_pull`, including status, host, exit code, duration, and a redacted tail of the last 4 KB of captured output. A user may run at most three Compose actions concurrently.

## Storage footprint

The **Services** tab requests Docker container summaries with `size=true` only
when one stack detail is opened. Each running/stopped container shows:

- image size from the matching Docker image ID;
- writable-layer bytes changed or added by that container;
- root-filesystem bytes reported by Docker for that container.

The stack summary counts a shared image only once and defines approximate
footprint as unique image bytes plus all measured writable layers. Docker
volumes, container log files and build cache are explicitly excluded. If image
or container coverage is partial, the API returns the measured coverage and
does not synthesize an approximate total from incomplete evidence. Global stack
listing remains on the lightweight Docker request without size accounting.

## YAML editing and validation

Create Stack, the stack Config tab, and Git Stack **Edit & Push** use the same offline YAML editor. The browser-ready CodeMirror and js-yaml files are vendored with Docker Dash, so syntax highlighting, bracket matching, automatic bracket closing, line numbers, and linting work without a CDN or frontend build step. The theme follows Docker Dash light and dark CSS variables, and a plain textarea remains usable if editor enhancement cannot load.

Saving is intentionally two-stage: js-yaml reports syntax errors with line and column information immediately, then the server runs `docker compose config` as the authoritative Compose validation. Invalid input is never written or pushed. Non-administrators can inspect stack configuration in read-only mode.

Git Stack editing reads only the configured relative `.yml` or `.yaml` file. The endpoint rejects path traversal, keeps canonical paths inside the managed repository, requires a regular file, enforces stack view access, and limits files to 2 MB before returning content.

## Visual service editor

The Compose Config tab can switch between **YAML** and **Form (preview)**. Form view covers the common service fields: name, image, restart policy, ports, environment variables, volumes, dependencies, and networks. Administrators can also add, rename, and remove services; viewers receive the same representation with disabled controls.

Form view lazily loads the vendored browser build of the `yaml` package and updates individual YAML document nodes. Comments, key order, top-level networks/volumes, and unsupported service fields such as `build`, `healthcheck`, and `deploy` remain intact. Each service calls out its unsupported fields so the operator knows to use YAML view for them. Switching back applies valid form changes to the YAML editor; Save also performs that synchronization automatically before the normal local and server validation pipeline.

## Filesystem discovery

Set `DD_STACKS_DIR` to one or more comma-separated directories inside the Docker Dash container. The default is `/opt/stacks`. Docker Dash scans up to three directory levels for `compose.yml`, `compose.yaml`, `docker-compose.yml`, or `docker-compose.yaml` and merges them with runtime-discovered projects.

Stacks with no containers remain visible with a **Stopped · discovered on disk** badge and can be pulled or brought up from the same card. Nested symlinks and junctions are not followed, canonical paths must remain inside a configured root, and Git-managed repositories under `/data/repos` are excluded from the filesystem list.

When Docker Dash runs in a container, the host directory must also be bind-mounted into the app container. The bundled Compose file maps `DD_STACKS_HOST_DIR` to `/opt/stacks`; additional roots configured in `DD_STACKS_DIR` need corresponding volume mounts. Read-only discovery can use `:ro`, while stack edits require a writable mount.

## Compose-first mode

The standard sidebar places Dashboard, Stacks, Containers, and Images first. A dismissible Dashboard card links directly to Stacks and stores its dismissal in per-user preferences. Open Docker Dash with `?mode=simple` to persist a reduced sidebar containing those four entries and a More accordion; **Show all** restores the complete navigation.

## `docker run` conversion

**Convert docker run** in the Stacks toolbar accepts a quoted command and converts common flags such as ports, volumes, environment, restart policy, network, user, working directory, capabilities, devices, labels, and command arguments. The generated Compose document opens in the same linted YAML editor for review. **Create Stack** then carries the edited YAML and suggested service name into the normal create, server-validation, and optional deploy flow.

## Monitoring integration discovery

The Stacks page checks the selected Docker host for the official Uptime Kuma image. When found, it displays the container name and a safe same-host link if port 3001 is published; missing ports and daemon failures do not interrupt stack loading. Docker Dash does not attempt monitor mutation through Uptime Kuma's private Socket.IO protocol.

## Combined stack logs

The **Logs** tab aggregates up to 20 services from a Compose stack into one time-ordered view. It loads a bounded history, then subscribes to every selected container over the authenticated WebSocket connection. Every line carries a stable per-service color and supports search, follow, pause/resume, clear, and download.

The WebSocket server checks both effective host access and stack `view` permission for every container. A single client may subscribe to at most 25 container log streams, log tails are capped, and all streams are destroyed on tab change, explicit unsubscribe, or socket disconnect.
