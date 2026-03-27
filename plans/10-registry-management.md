# Plan 10 — Registry Management

## Problem
No way to authenticate with private Docker registries. Users can only pull from Docker Hub public repos. Enterprise environments need private registries (Harbor, GitLab, AWS ECR, GitHub GHCR).

## Goal
Add/manage Docker registry credentials. Browse images from registries. Pull with authentication.

## Implementation Steps

### Step 1: Database — Registry credentials table
**File:** `src/db/migrations/010_registries.js`
```sql
CREATE TABLE registries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  username TEXT,
  password_encrypted TEXT,
  auth_type TEXT DEFAULT 'basic' CHECK(auth_type IN ('basic', 'token', 'aws')),
  is_default INTEGER DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE UNIQUE INDEX idx_registries_url ON registries(url);
```

### Step 2: Backend — Registry CRUD
**File:** `src/routes/registries.js` (new)
```
GET    /registries              — List all (password masked)
POST   /registries              — Add registry (encrypt password)
PUT    /registries/:id          — Update registry
DELETE /registries/:id          — Remove registry
POST   /registries/:id/test     — Test connection
GET    /registries/:id/catalog  — List images in registry (v2 API)
GET    /registries/:id/tags/:repo — List tags for image
```

### Step 3: Backend — Authenticated image pull
**File:** `src/services/docker.js` — `pullImage()`

Modify to accept registry auth:
```js
async pullImage(imageName, hostId = 0) {
  const docker = this.getDocker(hostId);
  // Determine registry from image name
  const registry = this._findRegistry(imageName);
  const authconfig = registry ? {
    username: registry.username,
    password: decrypt(registry.password_encrypted),
    serveraddress: registry.url,
  } : undefined;

  const stream = await docker.pull(imageName, { authconfig });
  // ... handle stream
}
```

### Step 4: Backend — Registry v2 API client
**File:** `src/services/registry.js` (new)

Implement Docker Registry v2 API:
```js
class RegistryService {
  async listRepositories(registryId) { /* GET /v2/_catalog */ }
  async listTags(registryId, repo) { /* GET /v2/{repo}/tags/list */ }
  async getManifest(registryId, repo, tag) { /* GET /v2/{repo}/manifests/{tag} */ }
  async testConnection(registryId) { /* GET /v2/ */ }
}
```

### Step 5: Frontend — Registry management in Settings
**File:** `public/js/pages/settings.js`

New "Registries" tab:
- List configured registries with URL, username, last used
- Add/edit dialog with fields: name, URL, username, password, auth type
- Test connection button
- Delete with confirmation

### Step 6: Frontend — Registry browser
**File:** `public/js/pages/images.js`

Add "Browse Registry" button next to "Pull Image":
- Dropdown to select configured registry
- Catalog listing with search
- Tag listing for selected image
- One-click pull from registry

## Files Changed
| File | Changes |
|------|---------|
| `src/db/migrations/010_registries.js` | New table |
| `src/routes/registries.js` | New CRUD + catalog endpoints |
| `src/services/registry.js` | Registry v2 API client |
| `src/services/docker.js` | Auth-aware pull |
| `src/server.js` | Mount new routes |
| `public/js/pages/settings.js` | Registries tab |
| `public/js/pages/images.js` | Registry browser |
| `public/js/api.js` | Registry API methods |

## Supported Registries
- Docker Hub (default, auth optional)
- Harbor (v2 API compatible)
- GitLab Container Registry
- GitHub GHCR
- AWS ECR (token-based auth)
- Azure ACR
- Any Docker Registry v2 compatible

## Security
- Passwords encrypted at rest using ENCRYPTION_KEY
- Credentials never sent to frontend (masked)
- Admin-only for registry management
- Audit log for all operations
