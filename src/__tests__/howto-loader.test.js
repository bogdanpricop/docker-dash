'use strict';

// WHY: Closing self-introduced test debt from the v8.2.x post-audit
// remediation pass.
//
// `src/services/howto-loader.js` is the v8.3.0-prep service that moves
// how-to content out of SQL migrations (where it never belonged) and
// into reviewable markdown files in `src/db/howto-content/`. The
// loader runs on every startup, so any regression breaks the help
// system silently for every operator on next deploy.
//
// Concrete failure modes this suite locks down:
//   - YAML-ish front-matter parser handles missing fences, quotes,
//     and colons-in-values without crashing the boot sequence.
//   - Slug grouping pairs `<slug>.md` (EN) with `<slug>.ro.md` (RO)
//     into a SINGLE row — not two rows, not a dropped translation.
//   - UPSERT preserves DB content when a markdown body is empty
//     (COALESCE branch) — important when a `.ro.md` lands without an
//     EN body to match.
//   - Per-file errors do NOT abort the whole load — one bad markdown
//     should not blow up startup.
//   - Filename regex rejects bad slugs that would corrupt the DB.

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { _parseFrontMatter } = require('../services/howto-loader');

// Helper: build a fresh in-memory DB with just the howto_guides
// table. We bypass real migrations to keep the suite fast and decouple
// it from migration ordering changes.
function makeTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE howto_guides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      title_ro TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      difficulty TEXT DEFAULT 'beginner',
      icon TEXT DEFAULT 'fas fa-book',
      summary TEXT DEFAULT '',
      summary_ro TEXT DEFAULT '',
      content TEXT DEFAULT '',
      content_ro TEXT DEFAULT '',
      is_builtin INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return db;
}

// Helper: the loader hardcodes its content dir to
// `src/db/howto-content/`. We can't change that from the outside without
// jest.mock() of the path module, so instead we point the loader at a
// temp directory by mocking `fs.readdirSync` + `fs.existsSync` + the
// `fs.readFileSync` for files inside CONTENT_DIR. Easier: re-require the
// module under jest.isolateModules with a custom CONTENT_DIR injected
// via __dirname trick? Cleanest: use jest.doMock on `fs` within an
// isolateModules block so the loader sees our temp dir as `CONTENT_DIR`.
//
// Simpler approach: stub fs primitives that the loader uses, scoped
// to a tmp dir. We replace fs.readdirSync / fs.existsSync /
// fs.readFileSync with thin wrappers that redirect lookups inside the
// real CONTENT_DIR to our temp dir.
function withTempContentDir(fn) {
  const realDir = path.join(__dirname, '..', 'db', 'howto-content');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'howto-loader-test-'));

  const origExists = fs.existsSync;
  const origReaddir = fs.readdirSync;
  const origReadFile = fs.readFileSync;

  fs.existsSync = function (p) {
    if (p === realDir) return origExists(tmp);
    return origExists(p);
  };
  fs.readdirSync = function (p, opts) {
    if (p === realDir) return origReaddir(tmp, opts);
    return origReaddir(p, opts);
  };
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.startsWith(realDir)) {
      const relative = p.substring(realDir.length).replace(/^[\\/]+/, '');
      return origReadFile(path.join(tmp, relative), ...rest);
    }
    return origReadFile(p, ...rest);
  };

  try {
    return fn(tmp);
  } finally {
    fs.existsSync = origExists;
    fs.readdirSync = origReaddir;
    fs.readFileSync = origReadFile;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

// Re-require loadAll fresh after the fs stubs are in place, so the
// CONTENT_DIR constant resolves through our shim.
function getLoadAll() {
  // No fresh state required — the loader has no module-level cache.
  return require('../services/howto-loader').loadAll;
}

describe('howto-loader — _parseFrontMatter (pure, no I/O)', () => {
  it('returns null on missing leading "---"', () => {
    expect(_parseFrontMatter('title: Hello\n---\nbody')).toBeNull();
    expect(_parseFrontMatter('# heading only\n')).toBeNull();
  });

  it('returns null on missing closing "---"', () => {
    expect(_parseFrontMatter('---\ntitle: Hello\nbody never closes\n')).toBeNull();
  });

  it('parses simple key:value pairs into meta + body', () => {
    const text = '---\ntitle: How to X\ncategory: basics\n---\nBody here';
    const r = _parseFrontMatter(text);
    expect(r).not.toBeNull();
    expect(r.meta).toEqual({ title: 'How to X', category: 'basics' });
    expect(r.body).toBe('Body here');
  });

  it('strips wrapping single AND double quotes from values', () => {
    const text = `---
title: "Quoted Title"
summary: 'Single-quoted summary'
plain: bare value
---
content`;
    const r = _parseFrontMatter(text);
    expect(r.meta.title).toBe('Quoted Title');
    expect(r.meta.summary).toBe('Single-quoted summary');
    expect(r.meta.plain).toBe('bare value');
  });

  it('handles colons inside values (only the FIRST colon is the separator)', () => {
    const text = '---\ntitle: How to: Do The Thing\nicon: fas fa-book\n---\nbody';
    const r = _parseFrontMatter(text);
    expect(r.meta.title).toBe('How to: Do The Thing');
    expect(r.meta.icon).toBe('fas fa-book');
  });

  it('skips lines without a colon (graceful — not a parse error)', () => {
    const text = '---\ntitle: OK\njust a comment\nicon: book\n---\nbody';
    const r = _parseFrontMatter(text);
    expect(r.meta).toEqual({ title: 'OK', icon: 'book' });
  });
});

describe('howto-loader — loadAll (DB integration)', () => {
  let db;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    if (db) db.close();
  });

  it('returns {loaded:0, skipped:0, errors:[]} when the content dir does not exist', () => {
    // No stub — real CONTENT_DIR may or may not exist. To make this
    // deterministic, point existsSync at a non-existent path.
    const realDir = path.join(__dirname, '..', 'db', 'howto-content');
    const origExists = fs.existsSync;
    fs.existsSync = function (p) {
      if (p === realDir) return false;
      return origExists(p);
    };
    try {
      jest.resetModules();
      const { loadAll } = require('../services/howto-loader');
      expect(loadAll(db)).toEqual({ loaded: 0, skipped: 0, errors: [] });
    } finally {
      fs.existsSync = origExists;
    }
  });

  it('returns {loaded:0, skipped:0, errors:[]} when the content dir is empty', () => {
    withTempContentDir(() => {
      jest.resetModules();
      const loadAll = getLoadAll();
      expect(loadAll(db)).toEqual({ loaded: 0, skipped: 0, errors: [] });
    });
  });

  it('skips files starting with "_" (drafts)', () => {
    withTempContentDir((tmp) => {
      fs.writeFileSync(
        path.join(tmp, '_draft.md'),
        '---\ntitle: Draft\n---\nshould be skipped'
      );
      fs.writeFileSync(
        path.join(tmp, 'real-guide.md'),
        '---\ntitle: Real\ncategory: basics\n---\nReal body'
      );
      jest.resetModules();
      const loadAll = getLoadAll();
      const result = loadAll(db);
      expect(result.loaded).toBe(1);
      const rows = db.prepare('SELECT slug FROM howto_guides').all();
      expect(rows.map((r) => r.slug)).toEqual(['real-guide']);
    });
  });

  it('groups <slug>.md (EN) with <slug>.ro.md (RO) into ONE row', () => {
    withTempContentDir((tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'nginx.md'),
        '---\ntitle: Nginx Guide\nsummary: EN summary\ncategory: web\n---\nEN body content'
      );
      fs.writeFileSync(
        path.join(tmp, 'nginx.ro.md'),
        '---\ntitle: Ghid Nginx\nsummary: Sumar RO\n---\nRO body content'
      );
      jest.resetModules();
      const loadAll = getLoadAll();
      const result = loadAll(db);
      expect(result.loaded).toBe(1);

      const rows = db.prepare('SELECT * FROM howto_guides').all();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.slug).toBe('nginx');
      expect(row.title).toBe('Nginx Guide');
      expect(row.title_ro).toBe('Ghid Nginx');
      expect(row.summary).toBe('EN summary');
      expect(row.summary_ro).toBe('Sumar RO');
      // v8.94.2 — bodies are rendered to HTML on load. The frontend injects
      // `content` as HTML, so storing raw markdown produced a wall of text.
      expect(row.content).toBe('<p>EN body content</p>');
      expect(row.content_ro).toBe('<p>RO body content</p>');
    });
  });

  it('UPSERTs into howto_guides — insert path then update path', () => {
    withTempContentDir((tmp) => {
      const slug = 'upsert-test';
      // First load: INSERT
      fs.writeFileSync(
        path.join(tmp, `${slug}.md`),
        '---\ntitle: First\ncategory: basics\n---\nv1 body'
      );
      jest.resetModules();
      let loadAll = getLoadAll();
      let result = loadAll(db);
      expect(result.loaded).toBe(1);
      let row = db.prepare('SELECT * FROM howto_guides WHERE slug = ?').get(slug);
      expect(row.title).toBe('First');
      expect(row.content).toBe('<p>v1 body</p>');

      // Second load: UPDATE (same slug, new content)
      fs.writeFileSync(
        path.join(tmp, `${slug}.md`),
        '---\ntitle: Second\ncategory: basics\n---\nv2 body'
      );
      jest.resetModules();
      loadAll = getLoadAll();
      result = loadAll(db);
      expect(result.loaded).toBe(1);
      row = db.prepare('SELECT * FROM howto_guides WHERE slug = ?').get(slug);
      expect(row.title).toBe('Second');
      expect(row.content).toBe('<p>v2 body</p>');

      // Still exactly one row
      const count = db.prepare('SELECT COUNT(*) as n FROM howto_guides').get().n;
      expect(count).toBe(1);
    });
  });

  it('preserves existing DB content when markdown body is empty (COALESCE branch)', () => {
    withTempContentDir((tmp) => {
      const slug = 'coalesce-test';
      // Seed a row with rich content already in the DB (simulates the
      // legacy migration-based howto rows).
      db.prepare(
        `INSERT INTO howto_guides (slug, title, content, is_builtin)
         VALUES (?, 'Existing Title', 'Pre-existing rich body', 1)`
      ).run(slug);

      // Markdown file with an EMPTY body and minimal front-matter.
      fs.writeFileSync(
        path.join(tmp, `${slug}.md`),
        '---\ncategory: basics\n---\n'
      );
      jest.resetModules();
      const loadAll = getLoadAll();
      const result = loadAll(db);
      expect(result.loaded).toBe(1);

      const row = db.prepare('SELECT * FROM howto_guides WHERE slug = ?').get(slug);
      // Title — markdown didn't supply one; existing must be preserved.
      expect(row.title).toBe('Existing Title');
      // Body — empty in markdown; COALESCE branch keeps DB content.
      expect(row.content).toBe('Pre-existing rich body');
      // Category — markdown DID supply one; should overwrite.
      expect(row.category).toBe('basics');
    });
  });

  it('captures parse errors per-file without aborting the whole load', () => {
    withTempContentDir((tmp) => {
      // bad.md has no front-matter at all → _parseFrontMatter returns null
      // → loader records the error and continues.
      fs.writeFileSync(
        path.join(tmp, 'bad.md'),
        'No front-matter here, just plain text.\n'
      );
      // good.md is valid — must still be loaded.
      fs.writeFileSync(
        path.join(tmp, 'good.md'),
        '---\ntitle: Good\ncategory: basics\n---\ngood body'
      );
      jest.resetModules();
      const loadAll = getLoadAll();
      const result = loadAll(db);

      expect(result.loaded).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        slug: 'bad',
        error: expect.stringContaining('front-matter'),
      });

      const goodRow = db.prepare('SELECT slug FROM howto_guides WHERE slug = ?').get('good');
      expect(goodRow).toBeTruthy();
    });
  });

  it('filename regex rejects bad slugs (uppercase, spaces, dots beyond extension)', () => {
    withTempContentDir((tmp) => {
      // Each of these filenames must fail the loader's
      // ^([a-z0-9-]+)(?:\.([a-z]{2}))?\.md$ test and be silently skipped
      // (no error, no DB row).
      const bad = [
        'UPPER.md',
        'has space.md',
        'extra.dotted.name.md',
        'snake_case.md',
      ];
      for (const f of bad) fs.writeFileSync(path.join(tmp, f), '---\ntitle: x\n---\n');
      // And one good one to prove the loader is actually running
      fs.writeFileSync(
        path.join(tmp, 'valid-slug.md'),
        '---\ntitle: Valid\ncategory: basics\n---\nbody'
      );

      jest.resetModules();
      const loadAll = getLoadAll();
      const result = loadAll(db);

      expect(result.loaded).toBe(1);
      const rows = db.prepare('SELECT slug FROM howto_guides').all();
      expect(rows.map((r) => r.slug)).toEqual(['valid-slug']);
    });
  });

  it('filename regex accepts kebab-case lowercase slugs and 2-letter language codes', () => {
    withTempContentDir((tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'multi-word-slug.md'),
        '---\ntitle: Multi\ncategory: basics\n---\nEN'
      );
      fs.writeFileSync(
        path.join(tmp, 'multi-word-slug.ro.md'),
        '---\ntitle: Multi-RO\n---\nRO'
      );
      fs.writeFileSync(
        path.join(tmp, 'with-numbers-123.md'),
        '---\ntitle: WithNums\ncategory: basics\n---\nbody'
      );

      jest.resetModules();
      const loadAll = getLoadAll();
      const result = loadAll(db);

      expect(result.loaded).toBe(2);
      const slugs = db
        .prepare('SELECT slug FROM howto_guides ORDER BY slug')
        .all()
        .map((r) => r.slug);
      expect(slugs).toEqual(['multi-word-slug', 'with-numbers-123']);
    });
  });
});
