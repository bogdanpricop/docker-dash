'use strict';

// v8.94.2 — markdown renderer for how-to guides.
//
// Two kinds of coverage: focused cases for each construct, and a corpus pass
// over all 154 shipped guides. The corpus pass is the one that matters — it is
// the actual input, and it proves both that markdown is converted and that the
// HTML already present in 133 of those files survives.

const fs = require('fs');
const path = require('path');
const md = require('../utils/markdown');
const { _parseFrontMatter } = require('../services/howto-loader');

const CONTENT_DIR = path.join(__dirname, '..', 'db', 'howto-content');

describe('markdown — headings', () => {
  it('renders each level', () => {
    expect(md.render('# One')).toBe('<h1>One</h1>');
    expect(md.render('## Two')).toBe('<h2>Two</h2>');
    expect(md.render('###### Six')).toBe('<h6>Six</h6>');
  });

  it('requires a space, so a bare hash is prose', () => {
    expect(md.render('#hashtag')).toBe('<p>#hashtag</p>');
  });

  it('does not treat shell comments inside a fence as headings', () => {
    // This is the single most common false positive in the corpus: hundreds of
    // `# comment` lines live inside bash blocks.
    const out = md.render('```bash\n# install docker\napt install docker\n```');
    expect(out).toContain('<pre><code class="language-bash">');
    expect(out).toContain('# install docker');
    expect(out).not.toContain('<h1>');
  });
});

describe('markdown — code', () => {
  it('escapes HTML inside fences', () => {
    const out = md.render('```\n<script>alert(1)</script>\n```');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
  });

  it('renders inline code and escapes it', () => {
    expect(md.render('use `docker ps` now')).toBe('<p>use <code>docker ps</code> now</p>');
    expect(md.render('`a < b`')).toContain('<code>a &lt; b</code>');
  });

  it('leaves emphasis markers inside code spans alone', () => {
    expect(md.render('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });

  it('does not turn a standalone number into a code span', () => {
    // Regression: an index-based placeholder made any bare digit a code span.
    expect(md.render('scale to 3 replicas')).toBe('<p>scale to 3 replicas</p>');
    expect(md.render('`x` and 0 and `y`')).toBe('<p><code>x</code> and 0 and <code>y</code></p>');
  });

  it('handles an unterminated fence without hanging', () => {
    expect(md.render('```\nstuff')).toContain('<pre><code>stuff</code></pre>');
  });
});

describe('markdown — emphasis and links', () => {
  it('renders bold and italic', () => {
    expect(md.render('**bold**')).toBe('<p><strong>bold</strong></p>');
    expect(md.render('*italic*')).toBe('<p><em>italic</em></p>');
  });

  it('leaves underscores in identifiers alone', () => {
    // DD_PROVIDER_X and /var/log/some_file must not become emphasis.
    expect(md.render('set DD_SOME_VAR now')).toBe('<p>set DD_SOME_VAR now</p>');
  });

  it('renders links as external', () => {
    const out = md.render('[docs](https://example.com/x)');
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('rel="noopener"');
  });
});

describe('markdown — lists', () => {
  it('renders bullets and ordered lists', () => {
    expect(md.render('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    expect(md.render('1. a\n2. b')).toBe('<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
  });

  it('nests by indentation and closes every level', () => {
    const out = md.render('- a\n  - b\n- c');
    expect(out).toContain('<ul>');
    expect((out.match(/<ul>/g) || []).length).toBe(2);
    expect((out.match(/<\/ul>/g) || []).length).toBe(2);
  });

  it('applies inline formatting inside items', () => {
    expect(md.render('- run `ls` **now**')).toContain('<li>run <code>ls</code> <strong>now</strong></li>');
  });
});

describe('markdown — tables', () => {
  it('renders a header and body', () => {
    const out = md.render('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(out).toContain('<th>A</th><th>B</th>');
    expect(out).toContain('<td>1</td><td>2</td>');
  });

  it('needs a separator row, otherwise it is prose', () => {
    expect(md.render('| not | a table |')).toContain('<p>');
  });

  it('supports alignment markers', () => {
    expect(md.render('| A | B |\n|:--|--:|\n| 1 | 2 |')).toContain('<th>A</th>');
  });
});

describe('markdown — raw HTML passthrough', () => {
  it('leaves an HTML block untouched', () => {
    const html = '<div class="tip">Keep me</div>';
    expect(md.render(html)).toBe(html);
  });

  it('preserves HTML mixed with markdown in one document', () => {
    const out = md.render('## Title\n\n<p class="lead">HTML here</p>\n\n- item');
    expect(out).toContain('<h2>Title</h2>');
    expect(out).toContain('<p class="lead">HTML here</p>');
    expect(out).toContain('<li>item</li>');
  });
});

describe('markdown — robustness', () => {
  it('tolerates empty and nullish input', () => {
    expect(md.render('')).toBe('');
    expect(md.render(null)).toBe('');
    expect(md.render(undefined)).toBe('');
  });

  it('normalises CRLF', () => {
    expect(md.render('# A\r\n\r\ntext')).toBe('<h1>A</h1>\n<p>text</p>');
  });
});

describe('markdown — the shipped how-to corpus', () => {
  const files = fs.existsSync(CONTENT_DIR)
    ? fs.readdirSync(CONTENT_DIR).filter(f => /^[a-z0-9-]+(\.[a-z]{2})?\.md$/.test(f))
    : [];

  it('has guides to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(files)('%s renders with no markdown left over', (file) => {
    const parsed = _parseFrontMatter(fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8'));
    expect(parsed).not.toBeNull();
    const html = md.render(parsed.body);
    // Code blocks legitimately contain markdown-looking text; everything else
    // must have been converted.
    const outside = html.replace(/<pre>[\s\S]*?<\/pre>/g, '');
    expect(outside).not.toMatch(/^#{1,6}\s+\S/m);
    expect(outside).not.toMatch(/\*\*[^*\n]+\*\*/);
    expect(outside).not.toMatch(/^\s*[-*+]\s+\S/m);
    expect(outside).not.toMatch(/^\s*\|.+\|\s*$/m);
  });

  it.each(files)('%s keeps the HTML it already contained', (file) => {
    const parsed = _parseFrontMatter(fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8'));
    const html = md.render(parsed.body);
    for (const tag of ['h2', 'h3', 'table', 'ul', 'div']) {
      const before = (parsed.body.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
      const after = (html.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
      expect(`${file}:${tag}:${after >= before}`).toBe(`${file}:${tag}:true`);
    }
  });
});
