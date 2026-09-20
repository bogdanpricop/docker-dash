# Contributing to Docker Dash

Thanks for your interest in contributing! Docker Dash is actively maintained and welcomes contributions of all sizes — from typo fixes to new features.

**No build step required.** Edit any `.js` or `.css` file, refresh the browser, and see your changes immediately. This is the simplest Docker management dashboard to contribute to.

### Good First Issues

Looking for where to start? These are great first contributions:

- **Add a language translation** — copy `public/js/i18n/TEMPLATE.js`, translate values, add one `<script>` tag. Currently: 11 languages (EN complete, RO ~77%, others ~66% — translations tab in System covers the gap without code).
- **Add an app template** — add an entry to `src/routes/templates.js` (JSON object with compose YAML). Currently: 47 templates including the AI Workload Pack (12 entries: Ollama, RAG stack, vLLM, etc.).
- **Improve i18n coverage** — some pages still have hardcoded English strings (grep for strings not using `i18n.t()`)
- **Add tests** — 1122 tests across 70 suites; more coverage is always welcome, especially integration tests for newer features (registry retention, pCloud orchestration, AI provider abstraction)
- **Documentation** — improve README, add examples, write tutorials
- **Accessibility** — add ARIA attributes, improve screen reader support, test keyboard navigation

### Project Stats (v8.2.0)

- **30+ pages** in the frontend SPA (incl. Registry Browse, AI Settings, Observability Wizard, pCloud Backup card)
- **451 API endpoints** (`grep -hE "router\.(get|post|put|patch|delete)" src/routes/*.js | wc -l`)
- **1122 tests** (70 test suites, 100% passing — 4 skipped are live-Cloudflare ACME integration gated on a CI secret)
- **47 app templates** including the v8.0.1 AI Workload Pack (Ollama / Open WebUI / RAG / vLLM / SD / ComfyUI / Whisper / Langflow / AnythingLLM / n8n / LiteLLM / Flowise)
- **64 database migrations** (001-064)
- **11 languages** — EN (complete), RO (~77%), DE/IT/FR/ES/PT/ZH/JA/KO/tlh (~66%, fall back to EN for missing keys)
- **84 built-in How-To guides** (EN + RO content; AI category covers Ollama on CPU/GPU + GPU passthrough + RAG stack)

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/docker-dash.git
   cd docker-dash
   ```
3. **Create a branch** for your work:
   ```bash
   git checkout -b feature/my-feature
   ```
4. **Install dependencies**:
   ```bash
   npm install
   ```
5. **Configure environment**:
   ```bash
   cp .env.example .env
   ```
6. **Start dev server** (auto-reloads on changes):
   ```bash
   npm run dev
   ```
7. Open http://localhost:8101 — login with `admin` / `admin`

## Project workflow conventions

- **`plans/` is gitignored — strategic specs live there locally.** Major features (anything that ships in a `.0` minor) follow the deep-spec → feature-spec → code → tests pipeline. Specs are local-only by design (one author, multiple iterations, no need to pollute repo history). Contributors can request a spec walkthrough via Discussion if they want to understand the "why" behind a major feature.
- **`CLAUDE.md` at repo root** documents the project conventions for AI-assisted contributions. Read it if you're using Claude Code or any AI agent to contribute.
- **Anti-features are documented WITH RATIONALE.** When a feature is *not* shipped, the deep-spec or CHANGELOG section says why. Examples: "no always-on AI chat sidebar" (v8.0.0), "no pCloud OAuth" (v8.2.0), "no automatic registry GC" (v7.6.0).

## Architecture Principles

These are non-negotiable design decisions. Please respect them in your contributions:

- **No build step** — The frontend is vanilla JavaScript loaded directly by the browser. No webpack, Vite, Rollup, or any bundler. Files in `public/` are served as-is.
- **No frontend framework** — No React, Vue, Svelte, or Angular. All UI is built with plain DOM manipulation. This keeps the project dependency-free on the frontend.
- **CDN for frontend libraries** — xterm.js, Chart.js, Font Awesome are loaded from CDN (jsDelivr). Don't add npm packages for frontend use.
- **SQLite embedded** — No external database. No PostgreSQL, no Redis. SQLite is the database and it runs in-process. Migrations auto-apply on startup.
- **CommonJS** — Backend uses `require()`/`module.exports`. No ESM imports.
- **Single CSS file** — All styles live in `public/css/app.css` using CSS custom properties (variables) for theming.

## Development Guidelines

### Code Style

- `'use strict'` at the top of every file
- Single quotes for strings
- No semicolon-free style — always use semicolons
- Functions should be short and focused (under 50 lines ideally)
- No TypeScript — this is a vanilla JS project by design
- No classes on the frontend — use plain objects with methods

### Adding a New Page

1. Create `public/js/pages/mypage.js`:
   ```javascript
   'use strict';

   const MyPage = {
     async render(container, params) {
       container.innerHTML = `
         <div class="page-header">
           <h2><i class="fas fa-icon"></i> ${i18n.t('pages.mypage.title')}</h2>
         </div>
         <div id="mypage-content"></div>
       `;
       // Load data, bindevents, etc.
     },

     destroy() {
       // Cleanup: remove event listeners, stop intervals, etc.
     },
   };

   window.MyPage = MyPage;
   ```

2. Register in `public/js/app.js` → `_pages` object:
   ```javascript
   _pages: {
     // ...existing pages...
     mypage: () => MyPage,
   },
   ```

3. Add nav item in `public/index.html`:
   ```html
   <a href="#/mypage" class="nav-item" data-page="mypage">
     <i class="fas fa-icon"></i><span>My Page</span>
   </a>
   ```

4. Add to command palette in `app.js` → `_getCommands()`:
   ```javascript
   { icon: 'fa-icon', label: i18n.t('nav.mypage'), action: () => this.navigate('/mypage'), section: 'nav' },
   ```

5. Add translations in `public/js/i18n.js` — **both EN and RO sections**:
   ```javascript
   // EN
   nav: { /* ... */ mypage: 'My Page' },
   pages: { mypage: { title: 'My Page' } },

   // RO
   nav: { /* ... */ mypage: 'Pagina Mea' },
   pages: { mypage: { title: 'Pagina Mea' } },
   ```

6. Add `<script>` tag in `public/index.html` (before `app.js`):
   ```html
   <script src="/js/pages/mypage.js?v=5.4"></script>
   ```

### Adding a New API Endpoint

1. Create or edit a route file in `src/routes/`:
   ```javascript
   router.get('/my-endpoint', requireAuth, async (req, res) => {
     try {
       const data = await someService.getData(req.hostId);
       res.json(data);
     } catch (err) {
       res.status(500).json({ error: err.message });
     }
   });
   ```

2. Mount in `src/server.js` if it's a new file:
   ```javascript
   app.use('/api/myroute', apiLimiter, require('./routes/myroute'));
   ```

3. Add the `extractHostId` middleware if the endpoint interacts with Docker:
   ```javascript
   const { extractHostId } = require('../middleware/hostId');
   router.use(extractHostId);
   ```

4. Add client method in `public/js/api.js`:
   ```javascript
   getMyData() { return this.get('/myroute/my-endpoint'); },
   ```
   Note: `hostId` is automatically appended to API calls.

### Database Migrations

Migrations live in `src/db/migrations/` and run automatically on startup in order.

Create a new file with the next sequential number:

```javascript
// src/db/migrations/013_my_table.js
'use strict';

exports.up = function(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS my_table (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
};
```

Rules:
- Always use `CREATE TABLE IF NOT EXISTS` or `try/catch` for `ALTER TABLE`
- Include `host_id` column if the data is per-Docker-host
- Add indexes for columns used in WHERE/ORDER BY
- Never modify existing migration files — create a new one instead

### Theming

All colors use CSS variables defined in `public/css/app.css`:

```css
/* Use these instead of hardcoded colors */
var(--text)       /* Primary text */
var(--text-dim)   /* Secondary/muted text */
var(--accent)     /* Primary accent (blue) */
var(--green)      /* Success/running */
var(--red)        /* Error/danger */
var(--yellow)     /* Warning */
var(--surface)    /* Card backgrounds */
var(--surface2)   /* Code blocks, subtle backgrounds */
var(--border)     /* Borders */
```

Always test your changes in **both dark and light themes**.

## Pull Request Checklist

Before submitting a PR, verify:

- [ ] `node --check` passes on all modified `.js` files
- [ ] `npm test` passes (currently 1122 tests at 100%)
- [ ] `npm run lint` passes (0 errors)
- [ ] Works in both **dark and light** themes
- [ ] Works with **sidebar collapsed** and expanded
- [ ] Works on **mobile** (768px and 480px breakpoints)
- [ ] **Translations** added for EN (RO and DE appreciated but not required)
- [ ] No **console.log** in production code (use `log.info/warn/error`)
- [ ] No **`execSync`** with template literals — use `execFileSync` with argument arrays
- [ ] No **hardcoded colors** — use CSS variables
- [ ] API endpoints include **`extractHostId`** if they touch Docker resources
- [ ] Sensitive data (tokens, keys) encrypted with **`crypto.encrypt()`**, never stored in plaintext
- [ ] PR is focused on a **single feature or fix**
- [ ] Commit messages follow **conventional format** (`feat:`, `fix:`, `chore:`, `test:`)

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npx jest auth-flow --verbose

# Run with watch mode
npm run test:watch

# Run linter
npm run lint
```

## Reporting Issues

Use [GitHub Issues](https://github.com/bogdanpricop/docker-dash/issues) with our templates:

- **Bug Report** — include browser, OS, Docker version, steps to reproduce
- **Feature Request** — describe the problem, proposed solution, use case

For security vulnerabilities, see [SECURITY.md](SECURITY.md) — **do not** open public issues.

## Questions & Ideas

Use [GitHub Discussions](https://github.com/bogdanpricop/docker-dash/discussions):

- **Q&A** — for support questions
- **Ideas** — for feature suggestions
- **Show and tell** — share your Docker Dash setup

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

## Dependency and browser asset updates

Use the latest patched Node.js 24 LTS (`.nvmrc`). After changing npm dependencies,
run `npm install`, `npm run build:vendor`, and `npm ci` to verify the lockfile.
Commit the generated browser assets and `public/vendor/versions.json`; production
still serves plain JavaScript with no build step.

Run `npm run check:vendor`, `npm run check:browser`, `npm run check:inventory-browser`, `npm run check:syntax`,
`npm run lint`, `npm test -- --runInBand`, and `npm run audit:dependencies`.
CodeMirror 6 is bundled from `scripts/vendor/codemirror.mjs`. Browser checks cover
YAML validation, keyboard editing, forms, read-only and modal disposal. The inventory
browser gate uses real view routes, auth, CSRF and an ephemeral DB with fixture
provider data; it does not replace the live-provider release smoke.
The scoped ioredis-mock peer override is validated by the cluster regression suite;
production uses ioredis 6 with `protocol: 2` for wire compatibility.

Use npm 11.19.1 (`npm install --global npm@11.19.1 --ignore-scripts`), matching CI
and the Docker image. This newer security-patched release fixes bundled packages
still vulnerable in npm's current `latest` tag (12.0.2); revisit the major upgrade
when its bundled dependencies are patched. npm blocks dependency lifecycle scripts unless
listed in `package.json#allowScripts`. Approvals are pinned to reviewed versions,
and `.npmrc` rejects unreviewed script-bearing packages. Review a changed script
before running `npm install-scripts approve <package>` during an upgrade.
`better-sqlite3` uses its packaged native prebuilds; its implicit node-gyp fallback
and protobufjs's advisory-only postinstall are explicitly denied.
