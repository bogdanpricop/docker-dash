# Docker Dash for Developers Using Git

**Audience:** developers who use git daily, may not have fully bought into Docker yet, and want to know why Docker Dash specifically — not Portainer, not Dockge, not bash scripts.
**Reading time:** ~5 minutes.

> ⏪ [Back to README](../../README.md) · 🇷🇴 [Versiunea română](why-docker-dash-developers.ro.md)

---

## "I know git. Why should I bother with Docker?"

Git versions your **code**. Docker versions **the environment that code runs in**.

The mental model if you already use git:

| Git | Docker |
|---|---|
| `git commit` | image (immutable snapshot) |
| branch / tag | image tag (`v1.2.0`, `latest`, `staging`) |
| `git clone` | `docker pull` |
| GitHub / GitLab | Docker registry (Docker Hub, GHCR, Harbor) |
| `package.json` | `docker-compose.yml` |
| diff between commits | image layers (each `RUN` / `COPY` = one layer) |
| `git revert` | `docker compose up image:v1.1.0` (instant rollback) |

If you've ever lived through "works locally, doesn't work on the server" or "we need to convince ops to install Redis" — Docker is the answer. **The compose file becomes the source of truth for your entire runtime infrastructure**, exactly like `package.json` is the source of truth for dependencies.

## The 5 places git-savvy devs get stuck on Docker

1. **Volumes vs bind mounts** — *"where the hell does my database actually live after a restart"*
2. **Networking** — *"why can't the `web` container connect to `db` when both are running"*
3. **Compose vs Swarm vs Kubernetes** — *"do I need K8s for 3 containers?"* (no, never)
4. **Image hygiene** — *"why is my Node app 1.2 GB"*
5. **Secrets** — `.env` in git, the original sin

A good Docker UI fixes #1, #2, #5 visually — you no longer need to remember `docker network inspect` commands at 2 in the morning.

## "OK but why Docker Dash and not Portainer / Dockge / bash scripts?"

### Portainer

- **Everything that matters for any real company is paywalled:** OIDC, SSO, LDAP, audit log, granular RBAC, MFA. Costs **$95/server/year**.
- Compose stacks **live in Portainer's internal database** — if Portainer crashes, your configs vanish from view until you bring it back up.
- GitHub issue [#3582](https://github.com/portainer/portainer/issues/3582) is full of users furious that a community-contributed OAuth PR was turned into a paid feature.

### Dockge

- Excellent for *"compose, beautiful, simple"*. Compose on disk, not in DB — exactly what you want.
- **Limited:** no audit log, no MFA, no RBAC, no serious multi-host, no image scanning.
- If you have 3 containers in a homelab — perfect. If you have a production server — you're behind.

### Bash scripts + SSH

- Works until the day you need an audit (*"who stopped the prod container at 3 am?"*) or RBAC (*"the new dev should be able to restart but not delete"*).
- You hold the entire cluster status in your head. Fun for 5 services, dangerously fragile at 50.

### Docker Dash

Docker Scout is temporarily excluded for security reasons; see [the explanation and return criteria](../audits/2026-09-20-scout-exclusion.md).

- **Everything Portainer Business paywalls, free, in the same package:** OIDC, LDAP, SSO via header, audit log with SHA-256 hash chain (compliance-friendly), three-tier RBAC, MFA with recovery codes, image scanning with Trivy / Grype, CIS Docker Benchmark integrated.
- **Multi-host through SSH tunnel** — no agent on the remote server. Add a new host with an SSH key, done.
- **Compose stacks deploy from git repos:** connect a repo, pick a branch, deploy runs `docker compose up -d` with auto-pull webhooks. One-click rollback.
- **Secrets Wizard** — paste a complete `.env`, get a hardened bash script that creates `*_FILE` entries with permissions `600`, owner `root:docker`, optionally with automatic SSH deployment. Plus a **Rotation Tracker** that nags you when secrets expire.
- **Certificate Manager** — track PEMs, expiry, CSR generator (RSA 4096 / EC P-256).
- **Single binary feel** — one container, no external DB, no Redis, no build step. **80 MB image, 50 MB RAM.** Runs on N100 or c5.large with no difference.
- **MIT licensed**, no telemetry, no signup, no *"register your instance"*.

## Your workflow with Docker Dash if you already use git

```
1. Push to repo with docker-compose.yml
2. Docker Dash detects via webhook
3. Pull the code, docker compose up -d with the new image
4. Audit log: "deploy webhook → user X → commit abc123 → success in 12s"
5. If something breaks: rollback to the previous version from the UI, one click
```

You get **GitOps without Argo CD, without K8s, without Kafka-esque YAML**.

## Where to start

- 👉 [Quick Start](../../README.md#quick-start) — install Docker Dash in 2 minutes
- Open **Stacks** in the left menu — connect your first git repo
- Open **Hosts** — add a remote server with an SSH key (no agent install needed)
- Open **System → Secrets → Audit & Wizard** — paste a real `.env` file and watch it classify 20+ secret types and generate a hardened setup script
- Open **System → Audit Log** — see the full hash-chained trail of every action since installation

---

> First time hearing about Docker itself? Read the [Beginner's guide](why-docker-dash-beginners.md) first — it covers the recipe-and-kitchen metaphor and the basics this guide assumes you already know.
