# Plan 16: Multi-Host Docker Management

## Overview
Connect Docker Dash to multiple Docker Engine instances (remote servers + Docker Desktop).
Supports 3 connection types: Unix Socket (local), TCP+TLS (remote), SSH Tunnel (remote).

## Implementation Phases

### Phase 1: Backend Infrastructure
1. **New route: `src/routes/hosts.js`** — CRUD for docker_hosts table
   - GET / — list all hosts with live status
   - POST / — add host (validate connection before saving)
   - PUT /:id — update host
   - DELETE /:id — remove host (cannot remove default)
   - POST /:id/test — test connection
   - GET /:id/info — get Docker info for specific host

2. **Update `src/services/docker.js`** — Multi-connection logic
   - `getDocker(hostId)` reads from docker_hosts table, creates appropriate Dockerode instance
   - TCP+TLS: `new Docker({ host, port, ca, cert, key })`
   - SSH: `ssh2` tunnel → localhost TCP → Dockerode
   - Connection caching with TTL and health check
   - `getActiveHosts()` — returns all active hosts from DB
   - `testConnection(config)` — validates connection params
   - `refreshConnections()` — called when host config changes

3. **Middleware: `extractHostId`** — Applied to all Docker-facing routes
   - Reads `?hostId=N` from query string
   - Defaults to 0 (local/default host)
   - Validates host exists and is active

4. **Update ALL routes** to pass `req.hostId` to dockerService methods

### Phase 2: Stats & Events Multi-Host
5. **Update `src/services/stats.js`**
   - `start()` loops through all active hosts
   - Separate collector interval per host
   - `_refreshHosts()` — adds/removes collectors when hosts change

6. **Update `src/ws/index.js`**
   - Event streams per active host
   - Include `hostId` and `hostName` in all broadcast messages
   - Host-aware channel subscriptions

### Phase 3: Frontend
7. **New: Host selector in sidebar** — dropdown above nav items
   - Shows all hosts with status indicator (green/yellow/red)
   - Selected host stored in `App._currentHostId`
   - "All Hosts" option for aggregated view

8. **Update `public/js/api.js`** — Add hostId to all requests
   - `_currentHostId` state variable
   - Automatic `?hostId=N` append to all API calls

9. **New page: `public/js/pages/hosts.js`** — Host management
   - List hosts with status, latency, Docker version
   - Add/edit host dialog (connection type selector)
   - Test connection button
   - TLS certificate upload (paste PEM content)

10. **Update all existing pages** — Show host context when multi-host active

### Phase 4: SSH Tunnels (Advanced)
11. **New: `src/services/ssh-tunnel.js`** — SSH tunnel manager
    - Creates local TCP tunnel to remote Docker socket
    - Auto-reconnect on failure
    - Key-based and password auth

## File Changes Summary
- New files: hosts.js (route), hosts.js (page), ssh-tunnel.js (service)
- Modified: docker.js, server.js, stats.js, ws/index.js, api.js, app.js, index.html, i18n.js
- Modified routes: containers.js, images.js, volumes.js, networks.js, system.js, stats.js
