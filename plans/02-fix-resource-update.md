# Plan 02 — Fix Container Resource Update

## Problem
Frontend `containers.js` has a `_editResources()` dialog (line 469-524) that calls `Api.updateContainerResources()`, which hits `PUT /system/containers/:id/resources`. The route exists in `system.js` but the API client method may not map correctly. Additionally:
- Only memory and cpuQuota/cpuPeriod are editable
- No validation that new limits >= current usage
- No feedback on whether limits were applied

## Goal
Ensure resource editing works end-to-end with proper validation and feedback.

## Implementation Steps

### Step 1: Verify API route path matches frontend call
**File:** `public/js/api.js`

Check that `updateContainerResources(id, data)` calls the correct path. If missing, add:
```js
updateContainerResources(id, data) {
  return this.put(`/system/containers/${id}/resources`, data);
},
```

### Step 2: Improve resource update dialog
**File:** `public/js/pages/containers.js` — `_editResources()`

- Show current usage alongside limits
- Add fields for: memory, memorySwap, memoryReservation, cpuShares, cpuQuota, cpuPeriod, pidsLimit
- Validate memory >= 6MB (Docker minimum)
- Show human-readable units (MB/GB selector)
- After update, refresh the detail view

### Step 3: Improve backend validation
**File:** `src/routes/system.js` — `PUT /containers/:id/resources`

- Validate memory >= 6291456 (6MB) if set
- Validate cpuQuota > 0 if set
- Return the applied values in response
- Handle Docker API errors gracefully (e.g., "not supported" on some drivers)

## Files Changed
| File | Changes |
|------|---------|
| `public/js/api.js` | Verify/add updateContainerResources method |
| `public/js/pages/containers.js` | Improve dialog, add fields, validation |
| `src/routes/system.js` | Add validation, better error handling |

## Testing
- Open running container → Edit Resources → change memory to 512MB → verify applied
- Try setting memory to 0 → should show validation error
- Try on a stopped container → should show appropriate message
