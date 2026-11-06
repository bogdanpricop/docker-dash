'use strict';

// v8.3.0-prep — Markdown-based How-To loader.
//
// Background: pre-v8.3, all built-in how-to content lived inside SQL
// migrations (040, 041, 042, 048, 059 — together ~250KB of HTML strings
// embedded in JS). That's wrong: content shouldn't be schema. Editing
// content meant writing a new migration. Diffs were unreviewable
// (109KB single migration file). And seeds re-ran on clean installs
// even though the rows were already INSERTed elsewhere.
//
// New convention: each how-to lives in `src/db/howto-content/<slug>.md`
// with YAML-style front-matter for metadata, plus optional
// `<slug>.ro.md` for Romanian content. The loader runs once at startup
// AFTER migrations and UPSERTs into `howto_guides`.
//
// Migration: existing 84 howtos stay in DB rows from their migrations.
// New howtos from now on go in markdown only. Existing howtos can be
// migrated piece-by-piece — drop a `<slug>.md` with the same slug and
// the next startup will overwrite the DB row's content.

const fs = require('fs');
const path = require('path');
const log = require('../utils/logger')('howto-loader');
const markdown = require('../utils/markdown');

const CONTENT_DIR = path.join(__dirname, '..', 'db', 'howto-content');

/**
 * Parse a markdown file with simple YAML-ish front-matter.
 * Format:
 *   ---
 *   title: How to do X
 *   summary: Short blurb
 *   category: basics
 *   difficulty: beginner
 *   icon: fas fa-book
 *   ---
 *   <body markdown/HTML>
 *
 * Returns { meta: {...}, body: '...' } or null if format is invalid.
 */
function _parseFrontMatter(text) {
  if (!text.startsWith('---')) return null;
  const endIdx = text.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const frontmatter = text.substring(3, endIdx).trim();
  const body = text.substring(endIdx + 4).trimStart();

  const meta = {};
  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let value = line.substring(colonIdx + 1).trim();
    // Strip wrapping quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body };
}

/**
 * Load all `.md` files in CONTENT_DIR and upsert into howto_guides.
 * Files named `<slug>.md` are EN content; `<slug>.ro.md` are RO content.
 * Returns { loaded, skipped, errors }.
 */
function loadAll(db) {
  if (!fs.existsSync(CONTENT_DIR)) {
    return { loaded: 0, skipped: 0, errors: [] };
  }

  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  if (files.length === 0) {
    return { loaded: 0, skipped: 0, errors: [] };
  }

  // Group files by slug — `nginx.md` is EN, `nginx.ro.md` is RO
  const bySlug = {};
  for (const f of files) {
    const m = f.match(/^([a-z0-9-]+)(?:\.([a-z]{2}))?\.md$/);
    if (!m) continue;
    const slug = m[1];
    const lang = m[2] || 'en';
    bySlug[slug] = bySlug[slug] || {};
    bySlug[slug][lang] = path.join(CONTENT_DIR, f);
  }

  let loaded = 0;
  let skipped = 0;
  const errors = [];

  const upsertStmt = db.prepare(`
    INSERT INTO howto_guides (slug, title, title_ro, category, difficulty, icon, summary, summary_ro, content, content_ro, is_builtin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(slug) DO UPDATE SET
      title = COALESCE(NULLIF(excluded.title, ''), howto_guides.title),
      title_ro = COALESCE(NULLIF(excluded.title_ro, ''), howto_guides.title_ro),
      category = COALESCE(NULLIF(excluded.category, ''), howto_guides.category),
      difficulty = COALESCE(NULLIF(excluded.difficulty, ''), howto_guides.difficulty),
      icon = COALESCE(NULLIF(excluded.icon, ''), howto_guides.icon),
      summary = COALESCE(NULLIF(excluded.summary, ''), howto_guides.summary),
      summary_ro = COALESCE(NULLIF(excluded.summary_ro, ''), howto_guides.summary_ro),
      content = COALESCE(NULLIF(excluded.content, ''), howto_guides.content),
      content_ro = COALESCE(NULLIF(excluded.content_ro, ''), howto_guides.content_ro),
      updated_at = datetime('now')
  `);

  for (const [slug, paths] of Object.entries(bySlug)) {
    try {
      let enMeta = {}, enBody = '';
      let roMeta = {}, roBody = '';

      if (paths.en) {
        const text = fs.readFileSync(paths.en, 'utf8');
        const parsed = _parseFrontMatter(text);
        if (!parsed) { skipped++; errors.push({ slug, error: 'invalid front-matter (en)' }); continue; }
        enMeta = parsed.meta;
        enBody = parsed.body;
      }
      if (paths.ro) {
        const text = fs.readFileSync(paths.ro, 'utf8');
        const parsed = _parseFrontMatter(text);
        if (parsed) {
          roMeta = parsed.meta;
          roBody = parsed.body;
        }
      }

      upsertStmt.run(
        slug,
        enMeta.title || '',
        roMeta.title || '',
        enMeta.category || '',
        enMeta.difficulty || '',
        enMeta.icon || '',
        enMeta.summary || '',
        roMeta.summary || '',
        // v8.94.2 — convert to HTML before storing. The frontend injects
        // `content` as HTML, so a markdown body used to arrive as one wall of
        // text. Raw HTML in a body passes through untouched, which matters:
        // most bodies mix the two.
        enBody ? markdown.render(enBody) : '',
        roBody ? markdown.render(roBody) : '',
      );
      loaded++;
    } catch (err) {
      errors.push({ slug, error: err.message });
      skipped++;
    }
  }

  if (loaded > 0 || errors.length > 0) {
    log.info('How-to markdown content loaded', { loaded, skipped, errorCount: errors.length });
  }
  return { loaded, skipped, errors };
}

module.exports = { loadAll, _parseFrontMatter };
