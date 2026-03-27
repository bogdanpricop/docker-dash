# Plan 14 — Image Build from Dockerfile

## Problem
No way to build Docker images from the UI. Users must SSH into the server and run `docker build`. This is common in development workflows and CI/CD pipelines.

## Goal
Build Docker images from a Dockerfile pasted in the browser or from a build context (tar/directory on server).

## Implementation Steps

### Step 1: Backend — Build endpoint
**File:** `src/routes/images.js`

```
POST /images/build
Body: { dockerfile: "FROM node:20...", tag: "myapp:latest", buildArgs: {} }
Response: streaming build output
```

Implementation:
```js
router.post('/build', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  const { dockerfile, tag, buildArgs = {} } = req.body;
  if (!dockerfile || !tag) return res.status(400).json({ error: 'dockerfile and tag required' });

  // Create tar stream with Dockerfile
  const tar = require('tar-stream');
  const pack = tar.pack();
  pack.entry({ name: 'Dockerfile' }, dockerfile);
  pack.finalize();

  const docker = dockerService.getDocker();
  const stream = await docker.buildImage(pack, {
    t: tag,
    buildargs: buildArgs,
    rm: true,
  });

  // Stream build output to client
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

  stream.on('data', (chunk) => {
    try {
      const json = JSON.parse(chunk.toString());
      if (json.stream) res.write(`data: ${JSON.stringify({ type: 'output', text: json.stream })}\n\n`);
      if (json.error) res.write(`data: ${JSON.stringify({ type: 'error', text: json.error })}\n\n`);
    } catch {}
  });

  stream.on('end', () => {
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
    auditService.log({ ... });
  });
});
```

### Step 2: Frontend — Build dialog
**File:** `public/js/pages/images.js`

Add "Build" button next to "Pull":
```html
<button class="btn btn-sm btn-secondary" id="build-btn">
  <i class="fas fa-hammer"></i> Build
</button>
```

Build modal with:
- Tag name input
- Dockerfile textarea (with basic syntax highlighting)
- Build args key=value inputs
- Build output log (streaming via SSE)
- Cancel button

### Step 3: Frontend — Streaming build output
```js
async _build(tag, dockerfile, buildArgs) {
  const response = await fetch('/api/images/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dockerfile, tag, buildArgs }),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    // Parse SSE events and append to log
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        this._appendBuildLog(data);
      }
    }
  }
}
```

### Step 4: Add tar-stream dependency
**File:** `package.json`

Add `"tar-stream": "^3.0.0"` to dependencies.

## Files Changed
| File | Changes |
|------|---------|
| `src/routes/images.js` | POST /build endpoint with SSE streaming |
| `public/js/pages/images.js` | Build button, dialog, streaming output |
| `public/js/api.js` | Build API method |
| `package.json` | Add tar-stream dependency |

## Security Considerations
- Admin-only endpoint
- No access to host filesystem (only Dockerfile content sent as text)
- Build args validated (no shell injection)
- Audit log all builds
- Consider build timeout (10 min max)

## Testing
- Build simple Dockerfile (FROM alpine, RUN echo test) → verify image created
- Build with syntax error → verify error shown
- Long build → verify streaming output updates live
- Cancel mid-build → verify cleanup
