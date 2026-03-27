# Docker Dash — Master Development Plan

## Vision
Transform Docker Dash from a solid Docker management tool into a complete, polished alternative to Portainer — with features Portainer doesn't have (vulnerability scanning, alerting, scheduling, metadata) plus the features users expect from a modern container management UI.

---

## Priority Tiers

### TIER 1 — Critical Fixes (Broken/Missing functionality)
Things that are called in the code but don't work.

| # | Plan | Impact | Effort | Status |
|---|------|--------|--------|--------|
| 01 | [Fix Stats Pipeline](./01-fix-stats-pipeline.md) | High | Small | Pending |
| 02 | [Fix Container Resource Update](./02-fix-resource-update.md) | Medium | Small | Pending |
| 03 | [Fix Container Export](./03-fix-container-export.md) | Medium | Small | Pending |

### TIER 2 — High-Impact Features (New functionality)
Major features that close the gap with Portainer.

| # | Plan | Impact | Effort | Status |
|---|------|--------|--------|--------|
| 04 | [Container Update/Recreate](./04-container-update-recreate.md) | Very High | Medium | Pending |
| 05 | [Live Log Streaming](./05-live-log-streaming.md) | High | Medium | Pending |
| 06 | [Xterm.js Terminal](./06-xterm-terminal.md) | High | Medium | Pending |
| 07 | [Dashboard Live Graphs](./07-dashboard-live-graphs.md) | High | Medium | Pending |

### TIER 3 — Competitive Features
Features that make Docker Dash stand out.

| # | Plan | Impact | Effort | Status |
|---|------|--------|--------|--------|
| 08 | [Stacks/Compose Editor](./08-stacks-compose-editor.md) | High | Large | Pending |
| 09 | [Container Creation Wizard](./09-container-creation-wizard.md) | Medium | Medium | Pending |
| 10 | [Registry Management](./10-registry-management.md) | Medium | Large | Pending |

### TIER 4 — Polish & Hardening
Improvements to existing features.

| # | Plan | Impact | Effort | Status |
|---|------|--------|--------|--------|
| 11 | [WebSocket Hardening](./11-websocket-hardening.md) | Medium | Small | Pending |
| 12 | [Network Topology Interactive](./12-network-topology.md) | Low | Medium | Pending |
| 13 | [Settings & Webhook Improvements](./13-settings-webhooks.md) | Medium | Medium | Pending |
| 14 | [Image Build from Dockerfile](./14-image-build.md) | Medium | Large | Pending |
| 15 | [Quick Container Actions](./15-quick-container-actions.md) | Medium | Small | Pending |

---

## Recommended Implementation Order

```
Week 1:  01 (Stats Pipeline) → 02 (Resource Update) → 03 (Export Fix)
Week 2:  05 (Live Logs) → 15 (Quick Actions) → 11 (WS Hardening)
Week 3:  04 (Container Update/Recreate) → 07 (Dashboard Graphs)
Week 4:  06 (Xterm.js Terminal)
Week 5:  08 (Stacks/Compose Editor)
Week 6:  09 (Creation Wizard) → 13 (Settings/Webhooks)
Week 7:  10 (Registry Management)
Week 8:  12 (Network Topology) → 14 (Image Build)
```

---

## Architecture Principles

1. **No new dependencies unless essential** — vanilla JS frontend, minimal backend deps
2. **WebSocket-first for real-time data** — stop polling where possible
3. **SQLite stays embedded** — no external DB needed
4. **Feature flags for everything** — new features toggleable via .env
5. **Mobile-friendly** — all new UI must be responsive
6. **i18n** — all new text must use i18n keys (EN + RO)
