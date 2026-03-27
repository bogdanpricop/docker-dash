# Plan 04 — Container Update/Recreate

## Problem
No way to update a container to the latest image version. Users must manually: pull image → stop container → remove → recreate with same settings. This is the #1 most requested feature in any Docker management tool.

## Goal
One-click "Update" button that pulls the latest image, stops the container, removes it, and recreates it with identical configuration.

## User Flow
1. Click "Update" on container (list view or detail view)
2. Confirm dialog shows: "Pull latest image for nginx:latest and recreate container?"
3. Progress modal shows each step:
   - Pulling image... ✓
   - Stopping container... ✓
   - Removing old container... ✓
   - Creating new container... ✓
   - Starting container... ✓
4. Success toast with "Container updated to nginx:latest@sha256:abc..."

## Implementation Steps

### Step 1: Backend — Update endpoint
**File:** `src/routes/containers.js`

New route: `POST /containers/:id/update`
```js
router.post('/:id/update', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { id } = req.params;
  const progress = [];

  try {
    // 1. Inspect current container for full config
    const docker = dockerService.getDocker();
    const container = docker.getContainer(id);
    const inspect = await container.inspect();
    const image = inspect.Config.Image;
    const name = inspect.Name.replace(/^\//, '');

    // Prevent self-update
    if (dockerService.isSelf(id)) {
      return res.status(400).json({ error: 'Cannot update Docker Dash itself' });
    }

    // 2. Pull latest image
    progress.push({ step: 'pull', status: 'running' });
    await dockerService.pullImage(image);
    progress.push({ step: 'pull', status: 'done' });

    // 3. Stop container (if running)
    if (inspect.State.Running) {
      progress.push({ step: 'stop', status: 'running' });
      await container.stop();
      progress.push({ step: 'stop', status: 'done' });
    }

    // 4. Remove old container
    progress.push({ step: 'remove', status: 'running' });
    await container.remove();
    progress.push({ step: 'remove', status: 'done' });

    // 5. Recreate with same config
    progress.push({ step: 'create', status: 'running' });
    const createOpts = {
      name,
      Image: inspect.Config.Image,
      Cmd: inspect.Config.Cmd,
      Env: inspect.Config.Env,
      ExposedPorts: inspect.Config.ExposedPorts,
      Labels: inspect.Config.Labels,
      WorkingDir: inspect.Config.WorkingDir,
      Entrypoint: inspect.Config.Entrypoint,
      Volumes: inspect.Config.Volumes,
      HostConfig: inspect.HostConfig,
      NetworkingConfig: {
        EndpointsConfig: inspect.NetworkSettings?.Networks || {},
      },
    };
    const newContainer = await docker.createContainer(createOpts);
    progress.push({ step: 'create', status: 'done' });

    // 6. Start
    progress.push({ step: 'start', status: 'running' });
    await newContainer.start();
    progress.push({ step: 'start', status: 'done' });

    // Audit
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_update', targetType: 'container', targetId: name,
      details: { image, newId: newContainer.id },
      ip: getClientIp(req),
    });

    res.json({ ok: true, newId: newContainer.id, image });
  } catch (err) {
    res.status(500).json({ error: err.message, progress });
  }
});
```

### Step 2: Backend — Compose stack update
**File:** `src/routes/system.js` — extend compose endpoint

For containers that are part of a compose stack, use `docker compose pull && docker compose up -d` instead:
```js
// Check if container is part of a compose project
const project = inspect.Config.Labels?.['com.docker.compose.project'];
const workingDir = inspect.Config.Labels?.['com.docker.compose.project.working_dir'];
if (project && workingDir) {
  // Use compose commands instead
  execSync(`cd "${workingDir}" && docker compose pull && docker compose up -d`, { timeout: 120000 });
}
```

### Step 3: Frontend — Update button in list view
**File:** `public/js/pages/containers.js` — `_renderRow()`

Add update button to action-btns:
```html
<button class="action-btn" onclick="ContainersPage._updateContainer('${id}','${image}')"
  title="Update"><i class="fas fa-arrow-circle-up"></i></button>
```

### Step 4: Frontend — Update button in detail view
**File:** `public/js/pages/containers.js` — `_renderDetailActions()`

Add before remove button:
```html
<button class="btn btn-sm btn-accent" data-act="update">
  <i class="fas fa-arrow-circle-up"></i> Update
</button>
```

### Step 5: Frontend — Progress modal
**File:** `public/js/pages/containers.js`

New method `_updateContainer(id, image)`:
```js
async _updateContainer(id, image) {
  const ok = await Modal.confirm(`Update container to latest ${image}?`);
  if (!ok) return;

  // Show progress modal with steps
  Modal.open(`
    <div class="modal-header"><h3>Updating Container</h3></div>
    <div class="modal-body" id="update-progress">
      <div class="update-step" id="step-pull"><i class="fas fa-spinner fa-spin"></i> Pulling ${image}...</div>
      <div class="update-step pending" id="step-stop">Stopping container...</div>
      <div class="update-step pending" id="step-remove">Removing old container...</div>
      <div class="update-step pending" id="step-create">Creating new container...</div>
      <div class="update-step pending" id="step-start">Starting container...</div>
    </div>
  `, { closeable: false });

  try {
    const result = await Api.post(`/containers/${id}/update`);
    // Show success
    Toast.success('Container updated successfully');
    Modal.close();
    this._load(); // Refresh list
  } catch (err) {
    Toast.error(err.message);
    Modal.close();
  }
}
```

### Step 6: API client method
**File:** `public/js/api.js`
```js
updateContainer(id) { return this.post(`/containers/${id}/update`); },
```

## Files Changed
| File | Changes |
|------|---------|
| `src/routes/containers.js` | POST /:id/update endpoint |
| `public/js/pages/containers.js` | Update button (list + detail), progress modal |
| `public/js/api.js` | updateContainer() method |

## Edge Cases
- Container is part of a compose stack → use compose commands
- Image pull fails → stop operation, report error, container unchanged
- Container was stopped → skip stop step, just remove + recreate
- Container uses host networking → preserve HostConfig.NetworkMode
- Container has anonymous volumes → warn user, create new volumes

## Testing
- Update a running container → verify it comes back with same ports/volumes/env
- Update a stopped container → verify it stays stopped after update
- Update with a compose stack → verify compose commands used
- Update with bad image tag → verify error handling, container untouched
- Update Docker Dash itself → verify rejection
