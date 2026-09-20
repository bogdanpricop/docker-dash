# Fleet operations and host organization

Docker Dash keeps the active-host workflow for day-to-day work while adding fleet-level navigation, health history, grouping, and guarded bulk operations for larger installations.

## Host groups and access

Administrators manage host groups under **Settings → Access**. The **Hosts** page links directly to that section. A host can belong to multiple groups, and each group can carry `view`, `operate`, or `admin` grants for users or teams.

The sidebar host selector renders accessible, collapsible group sections with connection-status indicators. Users only see hosts and group memberships allowed by their effective host permissions. Hosts remain searchable from the selector and from the `Ctrl/⌘+K` command palette, which uses fuzzy matching.

The multi-host overview provides group filter chips. Host cards on the Hosts and Multi-host pages show their group badges. The Hosts page automatically enables compact mode above ten hosts unless the user has saved a preference.

## Fleet health

For administrators with at least three active Docker or Podman hosts, the dashboard shows connected, degraded, and disconnected counts plus a 24-hour sparkline. A leader-only background job records one snapshot per five-minute bucket and retains eight days of history.

The health endpoint is administrator-only:

- `GET /api/fleet/health?hours=24` (range: 1–168 hours)

## Bulk restart and prune

Administrators can open **Multi-host → Bulk actions**, select up to 50 active Docker or Podman hosts, and preview the operation before it runs.

- **Restart running containers** restarts eligible containers serially on each host while hosts run concurrently. Stopped containers, Docker Dash itself, and `docker-dash-caddy` are excluded.
- **Prune unused resources** removes unused containers, images, networks, and BuildKit cache. Volumes are always preserved. The destructive confirmation requires typing `PRUNE`, and the global prune feature flag must be enabled.

An unreachable host does not prevent other selected hosts from running. Results report success, partial success, or failure per host. Executions write `fleet_bulk_restart` or `fleet_bulk_prune` to the audit trail.

API endpoints:

- `POST /api/fleet/bulk/preview` with `{ "action": "restart|prune", "host_ids": [1, 2] }`
- `POST /api/fleet/bulk/run` with the same body

Both bulk endpoints are administrator-only. Run requests also honor read-only mode, CSRF protection, feature flags, and the normal audit policy.
