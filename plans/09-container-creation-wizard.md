# Plan 09 — Container Creation Wizard

## Problem
The existing create container dialog is a single form with all fields at once. It's overwhelming for beginners and doesn't guide the user through the process. Port/volume/env inputs are text-based with no validation.

## Goal
Step-by-step wizard with validation at each step, smart defaults, and a review/confirm step.

## Wizard Steps

### Step 1: Image Selection
- Search images from local registry
- Pull from Docker Hub if not found
- Show image size, tags, creation date
- Auto-suggest popular images

### Step 2: Basic Configuration
- Container name (auto-generated suggestion)
- Restart policy (dropdown: no, always, unless-stopped, on-failure)
- Command override (optional)
- Working directory (optional)

### Step 3: Port Mapping
- Dynamic add/remove port rows
- Host port / Container port / Protocol (tcp/udp)
- Auto-detect exposed ports from image config
- Conflict detection (port already in use)

### Step 4: Volumes
- Dynamic add/remove volume rows
- Type selector: bind mount / named volume / tmpfs
- Host path / Volume name input
- Container path input
- Read-only toggle

### Step 5: Environment Variables
- Dynamic add/remove key=value rows
- Import from .env file (paste or upload)
- Pre-populate from image's ENV directives
- Mask sensitive values (passwords)

### Step 6: Network
- Select existing network (dropdown)
- Create new network option
- IP address override (optional)
- Hostname override (optional)

### Step 7: Resource Limits (Advanced, collapsible)
- Memory limit (slider with MB/GB toggle)
- CPU limit (slider 0.1 - all cores)
- PID limit
- Storage limit

### Step 8: Review & Create
- Summary of all settings in a clean table
- Generated docker run command preview
- "Create" and "Create & Start" buttons
- Warning for any potential issues (port conflicts, missing volumes)

## Implementation Steps

### Step 1: Frontend — Wizard component
**File:** `public/js/pages/containers.js`

Replace `_createDialog()` with `_createWizard()`:
```js
_createWizard() {
  const steps = [
    { id: 'image', title: 'Image', icon: 'fa-layer-group' },
    { id: 'basic', title: 'Configuration', icon: 'fa-cog' },
    { id: 'ports', title: 'Ports', icon: 'fa-plug' },
    { id: 'volumes', title: 'Volumes', icon: 'fa-database' },
    { id: 'env', title: 'Environment', icon: 'fa-key' },
    { id: 'network', title: 'Network', icon: 'fa-network-wired' },
    { id: 'review', title: 'Review', icon: 'fa-check' },
  ];
  // ... wizard modal with step indicators, back/next buttons
}
```

### Step 2: Backend — Image metadata endpoint
**File:** `src/routes/images.js`

Add endpoint to get image's exposed ports and env:
```
GET /images/:id/config → returns ExposedPorts, Env, Cmd, WorkingDir, Volumes
```
Used to pre-populate wizard steps 3-5.

### Step 3: Backend — Port conflict check
**File:** `src/routes/containers.js`

Add endpoint to check port availability:
```
GET /containers/check-port/:port → returns { available: true/false, usedBy: "container_name" }
```

### Step 4: CSS — Wizard styles
**File:** `public/css/app.css`

Step indicator bar, active/completed states, transition animations.

## Files Changed
| File | Changes |
|------|---------|
| `public/js/pages/containers.js` | Replace create dialog with wizard |
| `src/routes/images.js` | Image config endpoint |
| `src/routes/containers.js` | Port check endpoint |
| `public/css/app.css` | Wizard styles |

## Testing
- Full wizard flow → create container → verify all settings applied
- Select image → verify exposed ports auto-populated
- Add port conflict → verify warning shown
- Back and forth between steps → verify data preserved
- Create without starting → verify container created but stopped
