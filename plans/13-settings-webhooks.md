# Plan 13 — Settings & Webhook Improvements

## Problems
1. Webhook event field accepts freeform text — no autocomplete, no validation
2. No webhook delivery history UI (endpoint exists but no page)
3. No webhook retry logic
4. Email sending has no feedback on success/failure
5. No API token management UI (endpoints exist but no page)
6. Settings General tab is bare — just version and WS status
7. No session management (can't see/revoke active sessions)

## Implementation Steps

### Step 1: Webhook event autocomplete
**File:** `public/js/pages/settings.js` — webhook create/edit dialog

Replace text input with multi-select checkboxes:
```js
const WEBHOOK_EVENTS = [
  { value: '*', label: 'All Events' },
  { value: 'container.start', label: 'Container Started' },
  { value: 'container.stop', label: 'Container Stopped' },
  { value: 'container.die', label: 'Container Died' },
  { value: 'container.create', label: 'Container Created' },
  { value: 'container.destroy', label: 'Container Removed' },
  { value: 'image.pull', label: 'Image Pulled' },
  { value: 'image.delete', label: 'Image Removed' },
  { value: 'alert.triggered', label: 'Alert Triggered' },
  { value: 'alert.resolved', label: 'Alert Resolved' },
  { value: 'user.login', label: 'User Login' },
];
```

### Step 2: Webhook delivery history
**File:** `public/js/pages/settings.js`

Add "Deliveries" button per webhook that opens a modal:
```js
_viewDeliveries(webhookId) {
  // GET /webhooks/:id/deliveries
  // Show table: event, status code, response time, error, timestamp
  // Retry button per failed delivery
}
```

### Step 3: Webhook retry logic
**File:** `src/services/webhooks.js`

Add exponential backoff retry:
```js
async deliver(webhook, event, payload) {
  const maxRetries = config.webhooks.maxRetries || 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await this._send(webhook, payload);
      this._logDelivery(webhook.id, event, result, attempt, true);
      return;
    } catch (err) {
      this._logDelivery(webhook.id, event, err, attempt, false);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
}
```

### Step 4: API token management UI
**File:** `public/js/pages/settings.js` or `public/js/pages/profile.js`

Add "API Keys" section:
- List user's API keys (prefix, name, created, last used, permissions)
- Create new key (name, permissions, expiry)
- Revoke key
- Show key value ONCE on creation

### Step 5: Active sessions management
**File:** `src/routes/auth.js`

Add endpoints:
```
GET  /auth/sessions    — List active sessions for current user
DELETE /auth/sessions/:id — Revoke a session
```

**File:** `public/js/pages/profile.js`

Add "Active Sessions" section:
- IP, user agent, last active, created
- "Revoke" button per session
- "Revoke All Others" button

### Step 6: Settings General tab improvements
**File:** `public/js/pages/settings.js` — General tab

Show:
- App version with update check
- Database size and stats (link to System > Database)
- Feature flags with descriptions (read-only display)
- Retention settings overview
- SMTP status (configured/not configured)

### Step 7: Email feedback improvements
After sending password reset or invitation email, show a toast with actual result from SMTP:
```js
try {
  const result = await Api.sendPasswordReset(userId);
  if (result.emailSent) {
    Toast.success('Password reset email sent successfully');
  } else {
    Toast.warning('Password reset created but email delivery failed. Share the link manually.');
  }
}
```

## Files Changed
| File | Changes |
|------|---------|
| `public/js/pages/settings.js` | Webhook events, deliveries, general tab |
| `public/js/pages/profile.js` | API keys, active sessions |
| `src/services/webhooks.js` | Retry logic |
| `src/routes/auth.js` | Sessions endpoints |
| `src/routes/webhooks.js` | Delivery re-send endpoint |
| `public/js/api.js` | New API methods |

## Testing
- Create webhook → verify event checkboxes work
- Trigger event → check delivery history shows success
- Test webhook to dead URL → verify retry attempts logged
- Create API key → verify shown once, works for API calls
- View sessions → verify current session listed
- Revoke session → verify logout forced
