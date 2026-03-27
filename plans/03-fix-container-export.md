# Plan 03 — Fix Container Export

## Problem
Backend has `GET /containers/:id/export?format=compose|run` but:
1. No UI button to trigger it in the container detail view
2. `generateCompose()` is incomplete (missing restart_policy, healthcheck, networks, depends_on)
3. `generateRunCommand()` is incomplete (missing --restart, --log-driver, security opts)

## Goal
Add export buttons to the container detail actions bar and fix the generated output.

## Implementation Steps

### Step 1: Add export buttons to detail actions
**File:** `public/js/pages/containers.js` — `_renderDetailActions()`

Add a dropdown button with export options after the existing action buttons:
```html
<button class="btn btn-sm btn-secondary" data-act="export">
  <i class="fas fa-file-export"></i> Export
</button>
```

On click, show a small dropdown: "Docker Compose YAML" / "Docker Run Command" / "JSON Inspect"

### Step 2: Implement export modal
**File:** `public/js/pages/containers.js`

New method `_exportContainer(format)`:
- Call `Api.get(`/containers/${id}/export?format=${format}`)`
- Display result in a modal with a `<pre>` block
- Add "Copy to Clipboard" and "Download" buttons
- For compose: filename `{name}-compose.yml`
- For run: filename `{name}-run.sh`
- For JSON: filename `{name}-inspect.json`

### Step 3: Fix compose generation
**File:** `src/routes/containers.js` — `generateCompose()`

Add missing fields:
```yaml
services:
  {name}:
    image: ...
    restart: unless-stopped        # FROM data.HostConfig.RestartPolicy
    healthcheck:                   # FROM data.Config.Healthcheck
      test: ["CMD", ...]
      interval: 30s
      timeout: 10s
    networks:                      # FROM data.NetworkSettings.Networks
      - network_name
    environment:                   # FROM data.Config.Env
      - KEY=value
    labels:                        # FROM data.Config.Labels
      com.example.key: value
    logging:                       # FROM data.HostConfig.LogConfig
      driver: json-file
```

### Step 4: Fix run command generation
**File:** `src/routes/containers.js` — `generateRunCommand()`

Add missing flags:
```bash
docker run -d \
  --name {name} \
  --restart unless-stopped \       # RestartPolicy
  -p 8080:80 \                     # Ports
  -v /host:/container \            # Mounts
  -e KEY=value \                   # Env vars
  --network my-network \           # Networks
  --memory 512m \                  # Resource limits
  --cpus 1.5 \
  --log-driver json-file \         # Logging
  --label key=value \              # Labels
  image:tag
```

## Files Changed
| File | Changes |
|------|---------|
| `public/js/pages/containers.js` | Export button, dropdown, modal, copy/download |
| `src/routes/containers.js` | Fix generateCompose(), fix generateRunCommand() |

## Testing
- Open container detail → click Export → Docker Compose → verify valid YAML
- Copy YAML → run `docker compose config` → should validate
- Export as Run → verify command includes all settings
- Export as JSON → verify full inspect data
