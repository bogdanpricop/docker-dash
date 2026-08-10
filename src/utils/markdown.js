'use strict';

// v8.94.2 — Markdown to HTML for how-to guides.
//
// The how-to loader stores each guide's body straight into `howto_guides.content`,
// and the frontend injects that as HTML. Guides seeded from migrations are HTML,
// so they render. Guides authored as markdown were injected verbatim, so headings,
// lists, tables and code fences arrived as one undifferentiated wall of text.
//
// Why not a dependency: the corpus is ours and small in surface — headings, fenced
// code, lists (incl. nested), ordered lists, tables, horizontal rules, bold,
// italic, inline code and links. That is what this renders, and a corpus test
// renders all 154 shipped files to prove it. A general CommonMark implementation
// would be far more machinery than the input needs.
//
// Critically, **raw HTML passes through untouched**: 133 of the 154 files contain
// HTML blocks, 89 of them mixed with markdown. So this transforms markdown and
// leaves HTML alone, the way CommonMark treats HTML blocks. It follows that this
// is NOT a sanitizer — guide content is authored by administrators and shipped
// with the application, exactly as before this change.

const BLOCK_HTML = /^\s*<\/?(?:h[1-6]|p|div|section|article|ul|ol|li|table|thead|tbody|tr|td|th|pre|blockquote|hr|img|details|summary|figure|dl|dt|dd|aside|nav|form|iframe|video|audio|canvas|main|header|footer)\b/i;
const FENCE = /^\s*(?:```|~~~)(.*)$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// Delimiters for lifted code spans. NUL cannot occur in guide text, so a span
// can be restored unambiguously; a bare index would turn any standalone number
// already in the prose into a code span.
const SPAN_OPEN = '\u0000C';
const SPAN_CLOSE = '\u0000';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline formatting. Code spans are lifted out first so their contents are never
 * treated as emphasis — `**` inside a shell snippet must stay literal.
 */
function inline(text) {
  const spans = [];
  let out = String(text).replace(/`([^`\n]+)`/g, (_m, code) => {
    spans.push(code);
    return SPAN_OPEN + (spans.length - 1) + SPAN_CLOSE;
  });

  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) =>
    `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) =>
    `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a>`);

  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  // Single `*` only. Underscores are left alone: they appear constantly inside
  // env-var names and file paths, where emphasis is never what was meant.
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');

  const restore = new RegExp(SPAN_OPEN + '(\\d+)' + SPAN_CLOSE, 'g');
  return out.replace(restore, (_m, i) => `<code>${escapeHtml(spans[Number(i)])}</code>`);
}

function splitRow(row) {
  return row.split('|').map(cell => cell.trim());
}

/** Render markdown to HTML, passing raw HTML blocks through unchanged. */
function render(source) {
  if (source === null || source === undefined) return '';
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const out = [];

  let i = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code ────────────────────────────────────────────────────────
    const fence = line.match(FENCE);
    if (fence) {
      flushParagraph();
      const lang = fence[1].trim().split(/\s+/)[0] || '';
      const body = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of input)
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // ── Raw HTML block ─────────────────────────────────────────────────────
    // Passed through verbatim until a blank line, so authored HTML survives.
    if (BLOCK_HTML.test(line)) {
      flushParagraph();
      while (i < lines.length && lines[i].trim() !== '') out.push(lines[i++]);
      continue;
    }

    if (line.trim() === '') { flushParagraph(); i++; continue; }

    // ── Heading ────────────────────────────────────────────────────────────
    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // ── Horizontal rule ────────────────────────────────────────────────────
    if (HR.test(line)) { flushParagraph(); out.push('<hr>'); i++; continue; }

    // ── Table ──────────────────────────────────────────────────────────────
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushParagraph();
      const header = splitRow(line.match(TABLE_ROW)[1]);
      i += 2;
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(splitRow(lines[i].match(TABLE_ROW)[1]));
        i++;
      }
      const head = header.map(c => `<th>${inline(c)}</th>`).join('');
      const body = rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table class="howto-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // ── Lists (nested by indentation) ──────────────────────────────────────
    if (BULLET.test(line) || ORDERED.test(line)) {
      flushParagraph();
      const stack = []; // { tag, indent }
      while (i < lines.length) {
        const cur = lines[i];
        const b = cur.match(BULLET);
        const o = !b && cur.match(ORDERED);
        if (!b && !o) {
          // A blank line inside a list is allowed only if a list item follows.
          if (cur.trim() === '' && i + 1 < lines.length &&
              (BULLET.test(lines[i + 1]) || ORDERED.test(lines[i + 1]))) { i++; continue; }
          break;
        }
        const m = b || o;
        const indent = m[1].replace(/\t/g, '  ').length;
        const tag = b ? 'ul' : 'ol';

        while (stack.length && indent < stack[stack.length - 1].indent) {
          out.push(`</${stack.pop().tag}>`);
        }
        if (!stack.length || indent > stack[stack.length - 1].indent) {
          stack.push({ tag, indent });
          out.push(`<${tag}>`);
        } else if (stack[stack.length - 1].tag !== tag) {
          out.push(`</${stack.pop().tag}>`);
          stack.push({ tag, indent });
          out.push(`<${tag}>`);
        }
        out.push(`<li>${inline(m[2])}</li>`);
        i++;
      }
      while (stack.length) out.push(`</${stack.pop().tag}>`);
      continue;
    }

    // ── Paragraph text ─────────────────────────────────────────────────────
    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  return out.join('\n');
}

/** True when the body contains markdown constructs that `render` will transform. */
function looksLikeMarkdown(source) {
  const text = String(source || '');
  return /^#{1,6}\s+\S/m.test(text) ||
    /^\s*[-*+]\s+\S/m.test(text) ||
    /^\s*\d+[.)]\s+\S/m.test(text) ||
    /^\s*\|.+\|\s*$/m.test(text) ||
    /```|~~~/.test(text);
}

module.exports = { render, inline, escapeHtml, looksLikeMarkdown };
