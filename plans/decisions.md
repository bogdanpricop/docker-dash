# Architecture Decisions Log

## AD-001: Stats Pipeline — Use existing setInterval collector, not Docker event stream
**Context:** Stats are collected every 10s via `statsService.collect()` but never broadcast to WebSocket clients. The `broadcastStats()` method in ws/index.js exists but is dead code.
**Decision:** Hook into the existing `collect()` cycle to broadcast latest stats via WebSocket, rather than creating a separate Docker stats stream per container. This reuses the existing data flow and avoids N concurrent Docker API streams.
**Rationale:** One stats polling loop for all containers is more efficient than N individual streams. The 10s interval is sufficient for dashboards. Per-container streaming can be added later for the stats detail tab only.

## AD-002: Terminal — xterm.js over custom terminal implementation
**Context:** Current exec terminal is a basic textarea with line-based input. No character-at-a-time, no escape sequences, no resize.
**Decision:** Replace with xterm.js (CDN-loaded) which handles all terminal emulation. Communicate via WebSocket binary frames.
**Rationale:** xterm.js is the industry standard (used by VS Code, GitHub Codespaces, Portainer). Trying to build a terminal emulator from scratch is not worth the effort.

## AD-003: Compose Editor — CodeMirror 6 over Monaco
**Context:** Need a YAML editor for docker-compose files.
**Decision:** Use CodeMirror 6 (CDN). It's 40KB vs Monaco's 2MB+. Only need syntax highlighting and basic editing, not a full IDE.
**Rationale:** Monaco is overkill for editing one YAML file. CodeMirror 6 is lighter, faster to load, and sufficient.

## AD-004: Container Update — Pull + Recreate strategy
**Context:** Users need a one-click "update container" that pulls the latest image and recreates the container with the same settings.
**Decision:** Implement as: inspect → pull image → stop → remove → create (with original config) → start. Store original creation config in container labels for recovery.
**Rationale:** This mirrors what `docker compose up -d` does. Storing config in labels ensures we can recreate even if the compose file is unavailable.

## AD-005: Registry Management — Support Docker Hub + generic v2 registries
**Context:** Users may need private registries for image pulls.
**Decision:** Store registry credentials encrypted in SQLite. Support Docker Hub auth and generic Docker Registry v2 API. No Harbor/GitLab-specific integrations initially.
**Rationale:** Covers 90% of use cases. Harbor/GitLab can be added later as they use v2 API anyway.

## AD-006: Log Streaming — WebSocket channel per container
**Context:** Current log view polls HTTP endpoint. Need real-time tail.
**Decision:** Add `logs:subscribe` WebSocket message that starts `container.logs({follow: true, tail: 100})` stream and pipes to the WebSocket client. Unsubscribe stops the stream.
**Rationale:** Docker's log stream is efficient (server push). One WS connection can handle multiple log subscriptions.

## AD-007: Dashboard Stats — Broadcast from collector, not per-client streams
**Context:** Dashboard needs live CPU/memory graphs for top containers.
**Decision:** After each stats collection cycle (every 10s), broadcast the overview data to all clients subscribed to `stats:overview`. Individual container stats tabs subscribe to `stats:{containerId}`.
**Rationale:** One collection cycle serves all clients. No need for per-client Docker API calls.

## AD-008: Volume sizes — Use docker.df() instead of per-volume inspect
**Context:** Docker's volume list API doesn't return sizes. Individual volume inspect also doesn't.
**Decision:** Call `docker.df()` once and map sizes to volumes. Cache for 60 seconds.
**Rationale:** One API call vs N. Already implemented in current code, just needs caching.

## AD-009: Feature flags — All new features behind .env toggles
**Context:** Some deployments may not want all features (e.g., image build, registry management).
**Decision:** Every Tier 2+ feature gets a `ENABLE_*` flag in config. Default to true for most.
**Rationale:** Zero-risk deployments. Users can disable features they don't need.

## AD-010: No new npm dependencies for frontend
**Context:** Frontend is vanilla JS, no build step.
**Decision:** Load xterm.js and CodeMirror from CDN (jsDelivr). All other UI components built in vanilla JS.
**Rationale:** Keeps the build simple (just copy files). No webpack/vite/rollup needed.

## AD-011: EventEmitter super() call required
**Context:** When extending EventEmitter in StatsService, the constructor must call `super()` before `this`.
**Decision:** Added `super()` call. This was a deployment-blocking bug caught during the first deploy attempt.
**Rationale:** Node.js class inheritance requires super() in derived constructors.

## AD-012: _handleMessage must be async for log streaming
**Context:** The WebSocket `_handleMessage` uses `await container.logs()` in the logs:subscribe case.
**Decision:** Changed `_handleMessage(ws, raw)` to `async _handleMessage(ws, raw)`. The caller (`ws.on('message')`) doesn't need the return value, so making it async is safe.
**Rationale:** Async event handlers in Node.js are fine as long as errors are caught internally.

## AD-013: Stacks editor uses textarea instead of CodeMirror initially
**Context:** Plan 08 specified CodeMirror for YAML editing. However, adding another CDN dependency increases load time.
**Decision:** Ship with a styled textarea first. CodeMirror can be added later as an enhancement.
**Rationale:** A textarea is functional for editing compose files. CodeMirror adds 40KB+ and complexity for syntax highlighting that isn't essential.

## AD-014: Container clone clears port bindings
**Context:** When cloning a container, the port bindings from the source would conflict (same host port).
**Decision:** Clear `HostConfig.PortBindings` in the clone. Users must manually set ports on the cloned container.
**Rationale:** Port conflicts would cause the clone to fail on start. Better to create successfully without ports than to fail.

## AD-015: Image import uses req stream directly
**Context:** Image import needs to receive a tar file upload. Express.json() middleware could interfere.
**Decision:** The import endpoint relies on `Content-Type: application/x-tar` which express.json() ignores. The raw request stream is passed directly to `docker.loadImage()`.
**Rationale:** No need for multer or raw body parser. Docker SDK accepts any readable stream.

## AD-016: Stack creation writes files to server filesystem
**Context:** Creating a new stack requires writing docker-compose.yml and .env to the server.
**Decision:** Write to the directory specified by the user (default: /opt/{name}). Create directory if needed. Always backup existing files before overwriting.
**Rationale:** This is the same approach as Portainer. The alternative (storing in DB) would require a custom compose adapter which is over-engineered.

## AD-018: Multi-Host — Hub & Spoke model (no agent)
**Context:** Need to support multiple Docker hosts from a single Docker Dash instance.
**Decision:** Implement Hub & Spoke model where Docker Dash connects directly to remote Docker APIs. Three connection types: Socket (local), TCP+TLS (remote), SSH tunnel (via ssh2 library).
**Rationale:** Simpler than agent model (Portainer), no need to install anything on remote hosts. TCP+TLS covers 80% of use cases including Docker Desktop. SSH tunnel as fallback for hosts that can't expose Docker API.

## AD-019: Multi-Host — Host selector in sidebar, hostId propagation via query string
**Context:** Frontend needs to know which Docker host to query for all operations.
**Decision:** Add `?hostId=N` query parameter automatically to all API calls via Api._appendHostId(). Skip host parameter for non-Docker endpoints (auth, settings, alerts). Host selector dropdown in sidebar, hidden when only one host exists.
**Rationale:** Query string approach is simple, transparent (visible in browser devtools), and works with all HTTP methods. No breaking changes to API structure. Backend middleware extracts and validates hostId before passing to services.

## AD-020: Multi-Host — Stats collection per host
**Context:** Stats service needs to collect from all active hosts independently.
**Decision:** Use separate setInterval per active host. StatsService._intervals Map tracks each collector. refreshHosts() called when hosts change to start/stop collectors dynamically. Each collected event includes hostId.
**Rationale:** Independent collectors mean a slow/offline remote host doesn't block local stats collection. Failure isolation is important for multi-host reliability.

## AD-021: Multi-Host — SSH tunnels via ssh2 + openssh_forwardOutStreamLocal
**Context:** Some hosts can't expose Docker TCP API. Need SSH-based access.
**Decision:** Use ssh2 library with openssh_forwardOutStreamLocal to tunnel to the remote Docker Unix socket. Create local TCP server that forwards connections through the SSH channel. Auto-reconnect on failure.
**Rationale:** openssh_forwardOutStreamLocal is the proper way to tunnel Unix sockets over SSH (equivalent to `ssh -L local:remote_socket`). More reliable than exec-based approaches.

## AD-017: Skipped Swarm, LDAP, Edge Agent features
**Context:** Portainer has Swarm management, LDAP/OAuth, and Edge Agent. These are large features.
**Decision:** Skip for now. Docker Swarm adoption is declining (replaced by Kubernetes). LDAP/OAuth is only in Portainer Business Edition. Edge Agent requires a separate binary.
**Rationale:** Focus on single-host Docker management which covers 90%+ of use cases. These can be added later if needed.
