# Plan 15 — Quick Container Actions in List View

## Problem
To perform common actions (restart, view logs, update) users must click into the container detail view first. The list view has basic start/stop buttons but lacks quick access to frequently used features.

## Goal
Add a context menu / action dropdown to each container in the list view with quick access to: restart, logs (modal), update, exec, export, and open web URL.

## Implementation Steps

### Step 1: Replace action buttons with dropdown
**File:** `public/js/pages/containers.js` — `_renderRow()`

Replace individual buttons with a "..." dropdown menu:
```js
_renderRowActions(container) {
  return `
    <div class="action-btns">
      ${container.state === 'running'
        ? `<button class="action-btn" onclick="ContainersPage._action('${container.id}','stop')" title="Stop"><i class="fas fa-stop"></i></button>`
        : `<button class="action-btn" onclick="ContainersPage._action('${container.id}','start')" title="Start"><i class="fas fa-play"></i></button>`
      }
      <div class="dropdown-wrap" style="position:relative;display:inline-block">
        <button class="action-btn" onclick="ContainersPage._showQuickMenu(event,'${container.id}','${container.name}','${container.state}','${container.image}')">
          <i class="fas fa-ellipsis-v"></i>
        </button>
      </div>
    </div>
  `;
}
```

### Step 2: Quick action context menu
```js
_showQuickMenu(event, id, name, state, image) {
  event.stopPropagation();
  document.querySelectorAll('.quick-menu').forEach(el => el.remove());

  const running = state === 'running';
  const meta = this._metaMap?.[name];
  const webUrl = meta?.web_url;

  const items = [
    running && { icon: 'fa-redo', label: 'Restart', action: () => this._containerAction(id, 'restart') },
    { icon: 'fa-file-alt', label: 'Quick Logs', action: () => this._quickLogs(id, name) },
    running && { icon: 'fa-terminal', label: 'Quick Exec', action: () => this._quickExec(id, name) },
    { icon: 'fa-arrow-circle-up', label: 'Update', action: () => this._updateContainer(id, image) },
    { icon: 'fa-file-export', label: 'Export', action: () => this._exportContainer(id) },
    webUrl && { icon: 'fa-external-link-alt', label: 'Open Web', action: () => window.open(webUrl) },
    { separator: true },
    { icon: 'fa-info-circle', label: 'Inspect', action: () => location.hash = `#/containers/${id}` },
    { icon: 'fa-trash', label: 'Remove', danger: true, action: () => this._containerAction(id, 'remove') },
  ].filter(Boolean);

  const menu = document.createElement('div');
  menu.className = 'quick-menu';
  // Position and render items...
  // Auto-close on outside click
}
```

### Step 3: Quick Logs modal
```js
_quickLogs(id, name) {
  // Open a modal with the last 200 log lines
  // Include auto-follow toggle
  // No need to navigate to detail view
  Modal.open(`
    <div class="modal-header">
      <h3><i class="fas fa-file-alt"></i> ${name} — Logs</h3>
      <button class="modal-close-btn" onclick="Modal.close()"><i class="fas fa-times"></i></button>
    </div>
    <div class="modal-body">
      <pre id="quick-logs" class="log-view" style="max-height:60vh;overflow:auto">Loading...</pre>
    </div>
  `, { width: '800px' });

  Api.getContainerLogs(id, { tail: 200 }).then(logs => {
    document.getElementById('quick-logs').textContent = logs;
  });
}
```

### Step 4: Quick Exec modal (lightweight)
```js
_quickExec(id, name) {
  // Simple command input + output display
  Modal.open(`
    <div class="modal-header"><h3>${name} — Execute</h3></div>
    <div class="modal-body">
      <input type="text" id="quick-cmd" class="form-control" placeholder="Enter command...">
      <pre id="quick-output" style="margin-top:8px;max-height:300px;overflow:auto"></pre>
    </div>
  `, { width: '600px' });

  document.getElementById('quick-cmd').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const cmd = e.target.value;
      const result = await Api.post(`/containers/${id}/exec-run`, { cmd });
      document.getElementById('quick-output').textContent += `$ ${cmd}\n${result.output}\n`;
      e.target.value = '';
    }
  });
}
```

### Step 5: CSS for context menu
**File:** `public/css/app.css`
```css
.quick-menu {
  position: fixed;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  min-width: 180px;
  z-index: 9999;
  padding: 4px 0;
}
.quick-menu-item {
  padding: 8px 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.quick-menu-item:hover { background: var(--surface2); }
.quick-menu-item.danger { color: var(--red); }
.quick-menu-separator {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
```

### Step 6: Backend — Quick exec endpoint (optional)
**File:** `src/routes/containers.js`

HTTP-based exec for simple commands (no PTY needed):
```
POST /containers/:id/exec-run
Body: { cmd: "ls -la" }
Response: { output: "...", exitCode: 0 }
```

## Files Changed
| File | Changes |
|------|---------|
| `public/js/pages/containers.js` | Quick menu, quick logs, quick exec |
| `public/css/app.css` | Context menu styles |
| `src/routes/containers.js` | exec-run endpoint |

## Testing
- Click "..." on container → verify menu appears
- Quick Logs → verify logs shown in modal
- Restart from menu → verify container restarts
- Open Web → verify opens meta URL in new tab
- Click outside menu → verify it closes
