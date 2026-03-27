<p align="center">
  <h1 align="center">Docker Dash</h1>
  <p align="center">
    A lightweight, full-featured Docker management dashboard.<br>
    Self-hosted alternative to Portainer — built with Node.js, vanilla JavaScript, and SQLite.
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> &bull;
    <a href="#features">Features</a> &bull;
    <a href="#screenshots">Screenshots</a> &bull;
    <a href="#multi-host">Multi-Host</a> &bull;
    <a href="#contributing">Contributing</a>
  </p>
</p>

**Zero dependencies to deploy** — just Docker. No external database, no Redis, no build step.

## Screenshots

<table>
  <tr>
    <td align="center"><strong>Dashboard</strong><br><img src="docs/screenshots/dashboard.png" alt="Dashboard" width="400"></td>
    <td align="center"><strong>Containers</strong><br><img src="docs/screenshots/containers.png" alt="Containers" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Container Detail</strong><br><img src="docs/screenshots/container-detail.png" alt="Container Detail" width="400"></td>
    <td align="center"><strong>Terminal (xterm.js)</strong><br><img src="docs/screenshots/terminal.png" alt="Terminal" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Network Topology</strong><br><img src="docs/screenshots/topology.png" alt="Network Topology" width="400"></td>
    <td align="center"><strong>Security Scanning</strong><br><img src="docs/screenshots/security.png" alt="Security" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Image Management</strong><br><img src="docs/screenshots/images.png" alt="Images" width="400"></td>
    <td align="center"><strong>Multi-Host Management</strong><br><img src="docs/screenshots/hosts.png" alt="Hosts" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Compose Stacks</strong><br><img src="docs/screenshots/stacks.png" alt="Stacks" width="400"></td>
    <td align="center"><strong>Light Theme</strong><br><img src="docs/screenshots/dashboard-light.png" alt="Light Theme" width="400"></td>
  </tr>
</table>

## Features

### Core
- **Container Management** — Start, stop, restart, pause, kill, remove, clone, update/recreate
- **Image Management** — Pull, remove, tag, import/export, build from Dockerfile with streaming output
- **Volume Management** — Create, remove, inspect with real disk usage sizes
- **Network Management** — Create, remove, connect/disconnect containers, inspect IPAM config

### Monitoring & Visualization
- **Real-time Dashboard** — Live CPU/memory time-series charts (WebSocket-powered, 10s interval)
- **Container Stats** — Per-container CPU, memory, network I/O, block I/O, PIDs
- **Network Topology** — Interactive canvas map with drag, zoom, pan, hover highlighting
- **Health Checks** — Monitor container health status with event history

### Security
- **Vulnerability Scanning** — Integrated Trivy + Docker Scout with automatic detection
- **Security Dashboard** — Scan history, per-image status, AI-assisted remediation prompts
- **Smart Classification** — Distinguishes npm, OS, and third-party binary vulnerabilities
- **First-login Setup Wizard** — Forces password change, recommends disabling default admin

### Multi-Host
- **TCP + TLS** — Connect remote Docker hosts over the network with mutual TLS
- **SSH Tunnel** — Secure tunnel via SSH (no need to expose Docker API)
- **Docker Desktop** — Connect to Windows/Mac Docker Desktop instances
- **Host Selector** — Switch between hosts from the sidebar dropdown

### Operations
- **Compose/Stacks** — List, view, edit YAML, manage environment variables, deploy
- **Terminal** — Full xterm.js terminal with shell selection (`sh`, `bash`, `zsh`, `ash`)
- **Alerts** — CPU/memory threshold rules with email (SMTP) and webhook notifications
- **Schedules** — Cron-based container actions (start/stop/restart on schedule)
- **Firewall** — View and manage UFW rules (Linux)

### Platform
- **Multi-user** — Admin, operator, viewer roles with session management
- **Audit Log** — Every action logged with user, timestamp, IP address
- **Container Metadata** — Custom labels, descriptions, links, categories, owner, notes
- **Dark/Light Theme** — System-aware with manual toggle
- **i18n** — English, Romanian, German (easily extensible — [add your language](public/js/i18n/README.md))
- **Command Palette** — Ctrl+K quick navigation

## Quick Start

```bash
# Clone the repository
git clone https://github.com/bogdan-pricop/docker-dash.git
cd docker-dash

# Copy and configure environment
cp .env.example .env
# Edit .env — at minimum change APP_SECRET and ADMIN_PASSWORD

# Start with Docker Compose
docker compose up -d

# Open in browser
open http://localhost:8101
```

Default credentials: `admin` / `admin` — on first login, a **security setup wizard** will require you to change the password.

## Requirements

- Docker Engine 20.10+ (or Docker Desktop 4.x+)
- Docker Compose v2
- ~50MB RAM, minimal CPU

## Architecture

```
┌─────────────────┐     ┌──────────────────┐
│   Browser SPA   │────▸│  Node.js/Express  │
│  (vanilla JS)   │◂────│   REST + WebSocket│
└─────────────────┘     └────────┬─────────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
              ┌─────┴─────┐ ┌───┴────┐ ┌─────┴─────┐
              │  SQLite    │ │ Docker │ │  Docker   │
              │ (embedded) │ │ Local  │ │  Remote   │
              │ WAL mode   │ │ Socket │ │ TCP/SSH   │
              └───────────┘ └────────┘ └───────────┘
```

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20, Express 4, dockerode, better-sqlite3, ws, ssh2 |
| Frontend | Vanilla JavaScript SPA, Chart.js, xterm.js, Font Awesome (CDN) |
| Database | SQLite with WAL mode, auto-aggregation, configurable retention |
| Security | bcrypt, Helmet CSP, rate limiting, session-based auth, Bearer token fallback |
| Scanning | Trivy (OSS), Docker Scout (SARIF format) |

**Zero build step** — no webpack, no bundler, no transpiler. Frontend files are served as-is.

## Multi-Host

Docker Dash can manage multiple Docker hosts from a single instance:

| Method | Use Case | Requirements |
|--------|----------|-------------|
| **TCP + TLS** | Remote Linux servers | Docker API exposed on port 2376 + TLS certificates |
| **Docker Desktop** | Windows / Mac | "Expose daemon on TCP" enabled in DD Settings |
| **SSH Tunnel** | Secure remote (no API exposure) | SSH access + `socat` installed + user in `docker` group |
| **Unix Socket** | Local (default) | Docker socket mounted (automatic) |

The app includes a **built-in setup guide** (Hosts page) with step-by-step instructions for each method, including TLS certificate generation and per-OS `socat` installation commands.

## Configuration

All config via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_PORT` | `8101` | HTTP port |
| `APP_SECRET` | — | **Required.** Session signing key |
| `ADMIN_PASSWORD` | `admin` | Initial admin password (first launch only) |
| `ENCRYPTION_KEY` | — | Encrypt registry credentials at rest |
| `STATS_INTERVAL_MS` | `10000` | Stats collection interval (ms) |
| `STATS_RAW_RETENTION_HOURS` | `24` | Keep raw stats for N hours |
| `EVENT_RETENTION_DAYS` | `3` | Keep Docker events for N days |
| `ENABLE_EXEC` | `true` | Allow terminal exec into containers |
| `READ_ONLY_MODE` | `false` | Disable all write operations |

## Development

```bash
# Install dependencies
npm install

# Start in development mode (auto-reload on file changes)
npm run dev

# Open http://localhost:3456 (dev port)
```

No build step needed. Edit any `.js` or `.css` file and refresh the browser.

## Adding a Language

Docker Dash uses a modular i18n system. To add a new language:

1. Copy `public/js/i18n/TEMPLATE.js` to `public/js/i18n/{code}.js`
2. Translate the values (keys stay in English)
3. Add one `<script>` tag in `index.html`

That's it — the language appears automatically in the selector. See [`public/js/i18n/README.md`](public/js/i18n/README.md) for full instructions.

Currently supported: **English**, **Romanian**, **German**.

## Project Structure

```
docker-dash/
├── src/
│   ├── config/          # Environment-based configuration
│   ├── db/              # SQLite setup + 13 auto-migrations
│   ├── middleware/       # Auth, rate limiting, hostId extraction
│   ├── routes/          # REST API (containers, images, volumes, networks, hosts, ...)
│   ├── services/        # Business logic (docker, stats, alerts, ssh-tunnel, registry)
│   ├── ws/              # WebSocket server (exec, live logs, live stats)
│   └── utils/           # Logger, helpers
├── public/
│   ├── js/
│   │   ├── i18n/        # Language files (en.js, ro.js, de.js, TEMPLATE.js)
│   │   ├── pages/       # SPA pages (dashboard, containers, images, security, hosts, ...)
│   │   ├── components/  # Reusable UI (modal, toast, data table)
│   │   ├── api.js       # HTTP client with auto host-context
│   │   ├── ws.js        # WebSocket client with reconnect
│   │   └── app.js       # Router, auth, sidebar, command palette
│   └── css/app.css      # Single stylesheet, CSS variables, dark/light themes
├── docs/
│   └── screenshots/     # UI screenshots for README
├── Dockerfile           # Multi-stage: base → deps → production
├── docker-compose.yml   # Production-ready with health check
├── .env.example         # All variables documented
└── plans/               # Architecture decisions and feature roadmap
```

## Comparison with Portainer

| Feature | Portainer CE | Docker Dash |
|---------|-------------|-------------|
| Container CRUD | Yes | Yes |
| Real-time stats | Yes | Yes (WebSocket) |
| Terminal (exec) | Yes | Yes (xterm.js) |
| Compose/Stacks | Yes | Yes |
| Image management | Yes | Yes + vulnerability scanning |
| Network topology | No | Yes (interactive canvas) |
| Multi-host | Yes (agent required) | Yes (TCP/SSH/Socket, agentless) |
| Vulnerability scanning | No | Yes (Trivy + Scout) |
| Dark theme | Yes | Yes |
| i18n | Partial | Yes (EN + RO + DE, extensible) |
| Audit log | Business only | Yes (free) |
| Alerts | Business only | Yes (free) |
| Security wizard | No | Yes (first-login setup) |
| Database | External (Bolt) | Embedded SQLite |
| Build step | Yes (Angular) | None (vanilla JS) |
| Container size | ~250MB | ~80MB |
| RAM usage | ~200MB | ~50MB |

## License

[MIT](LICENSE) — free for personal and commercial use.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Development setup
- Architecture principles (no build step, no framework)
- How to add pages, API endpoints, database migrations
- How to add a language translation
- Pull request checklist

## Acknowledgments

Built with:
- [dockerode](https://github.com/apocas/dockerode) — Docker API client
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — SQLite driver
- [xterm.js](https://xtermjs.org/) — Terminal emulator
- [Chart.js](https://www.chartjs.org/) — Charts
- [Trivy](https://trivy.dev/) — Vulnerability scanner
- [ssh2](https://github.com/mscdex/ssh2) — SSH client
- [Font Awesome](https://fontawesome.com/) — Icons
