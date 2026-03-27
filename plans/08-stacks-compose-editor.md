# Plan 08 — Stacks / Compose Editor

## Problem
Containers are grouped by compose project but there's no way to view/edit the docker-compose.yml file from the UI. Users must SSH into the server to edit compose files. The `GET /system/compose/:stack/config` endpoint exists but has no dedicated UI.

## Goal
Full stack management page: view compose config, edit YAML in-browser, deploy changes, view stack logs.

## Implementation Steps

### Step 1: Load CodeMirror from CDN
**File:** `public/index.html`
```html
<script src="https://cdn.jsdelivr.net/npm/codemirror@5/lib/codemirror.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5/mode/yaml/yaml.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/codemirror@5/lib/codemirror.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/codemirror@5/theme/material-darker.min.css">
```

### Step 2: Backend — Stack management endpoints
**File:** `src/routes/system.js`

Add new endpoints:
```
GET  /system/stacks              — List all compose stacks with container counts
GET  /system/stacks/:name        — Get stack details (containers, compose file)
PUT  /system/stacks/:name/config — Save modified compose file
POST /system/stacks/:name/deploy — Run docker compose up -d
POST /system/stacks/:name/pull   — Pull latest images for stack
GET  /system/stacks/:name/logs   — Combined logs for all stack containers
```

### Step 3: Backend — Stack listing
```js
router.get('/stacks', requireAuth, async (req, res) => {
  const containers = await dockerService.listContainers();
  const stacks = {};

  for (const c of containers) {
    const project = c.labels?.['com.docker.compose.project'];
    if (!project) continue;
    if (!stacks[project]) {
      stacks[project] = {
        name: project,
        workingDir: c.labels?.['com.docker.compose.project.working_dir'] || '',
        containers: [],
        running: 0, total: 0,
      };
    }
    stacks[project].containers.push({ id: c.id, name: c.name, state: c.state, image: c.image });
    stacks[project].total++;
    if (c.state === 'running') stacks[project].running++;
  }

  res.json(Object.values(stacks));
});
```

### Step 4: Backend — Save compose config
```js
router.put('/stacks/:name/config', requireAuth, requireRole('admin'), writeable, (req, res) => {
  const { config } = req.body;
  // Find working dir from stack containers
  // Write config to docker-compose.yml
  // Validate YAML before writing
  fs.writeFileSync(path.join(workingDir, 'docker-compose.yml'), config);
  auditService.log({ ... });
  res.json({ ok: true });
});
```

### Step 5: Frontend — Stacks page or tab
**Option A:** New sidebar page "Stacks"
**Option B:** Tab in System page (recommended to keep things simple)

Create stack detail view with:
1. Stack info card (name, working dir, container count)
2. YAML editor (CodeMirror) with the compose file
3. Action buttons: Save, Deploy, Pull, Down
4. Container list showing all services in the stack

### Step 6: Frontend — YAML editor component
```js
_renderStackEditor(el, stack) {
  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3>docker-compose.yml</h3>
        <div class="btn-group">
          <button class="btn btn-sm btn-primary" id="stack-save">Save</button>
          <button class="btn btn-sm btn-accent" id="stack-deploy">Deploy</button>
          <button class="btn btn-sm btn-secondary" id="stack-pull">Pull</button>
        </div>
      </div>
      <div class="card-body" style="padding:0">
        <textarea id="compose-editor"></textarea>
      </div>
    </div>
  `;

  this._editor = CodeMirror.fromTextArea(document.getElementById('compose-editor'), {
    mode: 'yaml',
    theme: 'material-darker',
    lineNumbers: true,
    tabSize: 2,
    indentWithTabs: false,
    autofocus: true,
  });
  this._editor.setValue(stack.config);
}
```

## Files Changed
| File | Changes |
|------|---------|
| `public/index.html` | CodeMirror CDN links |
| `src/routes/system.js` | Stack CRUD endpoints |
| `public/js/pages/system.js` | Stacks tab with editor |
| `public/js/api.js` | Stack API methods |

## Security Considerations
- YAML validation before writing to disk
- Path traversal prevention (validate workingDir is a real compose project)
- Admin-only for config editing
- Audit log all changes
- Backup compose file before overwrite

## Testing
- View stack → verify compose YAML displayed
- Edit YAML → Save → verify file written
- Deploy → verify `docker compose up -d` runs
- Invalid YAML → verify validation error shown
- Pull → verify images updated
