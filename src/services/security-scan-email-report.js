'use strict';

const { hasFix } = require('./image-scan-results');
const httpUrl = require('../utils/http-url');

const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const levels = ['critical', 'high', 'medium', 'low', 'negligible', 'unknown'];
const labels = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', negligible: 'Negligible', unknown: 'Unknown' };
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const count = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const n = value => count.format(value ?? 0);
const severity = value => Object.hasOwn(labels, value) ? value : 'unknown';
const rank = value => levels.indexOf(value);

function escape(value, limit = 300) {
  const text = typeof value === 'string' ? value.trim() : '';
  const bounded = text.length > limit ? text.slice(0, limit) + '…' : text;
  return (bounded || '—').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[&<>"']/g, character => entities[character]);
}

function advisory(finding) {
  const id = String(finding.id || '');
  let url;
  if (/^CVE-\d{4}-\d{4,}$/i.test(id)) url = 'https://www.cve.org/CVERecord?id=' + id.toUpperCase();
  else if (/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(id)) url = 'https://github.com/advisories/' + id;
  else if (typeof finding.url === 'string' && finding.url.length <= 500) {
    const source = httpUrl(finding.url, { httpsOnly: true });
    if (source && /^(?:[a-z0-9-]+\.)*(?:advisories\.gitlab\.com|security\.alpinelinux\.org|security-tracker\.debian\.org|ubuntu\.com|access\.redhat\.com|osv\.dev)$/i.test(source.hostname)) {
      url = source.href;
    }
  }
  return url ? '<a href="' + escape(url, 750) + '" rel="noreferrer">' + escape(id) + '</a>' : escape(id);
}

function groupFindings(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const level = severity(finding.severity);
    const fixed = hasFix(finding) ? finding.fixedIn.trim() : '';
    const title = finding.title;
    const key = JSON.stringify([finding.id, level, finding.package, finding.version, fixed]);
    const existing = groups.get(key);
    if (existing) { existing.occurrences++; continue; }
    groups.set(key, { id: finding.id, severity: level, package: finding.package, version: finding.version,
      fixed, title, url: finding.url, occurrences: 1 });
  }
  return [...groups.values()].sort((a, b) => rank(a.severity) - rank(b.severity) ||
    Number(Boolean(b.fixed)) - Number(Boolean(a.fixed)) || String(a.id).localeCompare(String(b.id)));
}

function dashboardLink(run, scanId) {
  if (!run.publicUrl) return '';
  const url = new URL('/#/security/schedules/' + run.id + (scanId ? '/images/' + scanId : ''), run.publicUrl);
  return '<a class="jump" href="' + escape(url.href, 2048) + '">Open ' + (scanId ? 'findings' : 'run') + ' in Docker Dash ↗</a>';
}

function findingRow(finding) {
  const level = finding.severity;
  const times = finding.occurrences;
  return '<tr><td>' + advisory(finding) + (finding.title ? '<span class="finding-title">' + escape(finding.title, 104) + '</span>' : '') +
    '</td><td class="' + level + '">' + labels[level] + '</td><td><code>' + escape(finding.package) +
    '</code></td><td><code>' + escape(finding.version) + '</code></td><td>' +
    (finding.fixed ? '<code class="fixed">' + escape(finding.fixed) + '</code>' : '<span class="muted">No published fix</span>') +
    '</td><td class="num">' + n(times) + '</td></tr>';
}

const tableHeader = '<div class="scroll"><table><thead><tr><th scope="col">Advisory</th><th scope="col">Severity</th>' +
  '<th scope="col">Package</th><th scope="col">Installed</th><th scope="col">Fixed in</th><th scope="col">Occurrences</th></tr></thead><tbody>';
const tableFooter = '</tbody></table></div>';

function imageOrder(a, b) {
  return Number(Boolean(a.error)) - Number(Boolean(b.error)) ||
    (b.summary?.critical || 0) - (a.summary?.critical || 0) ||
    (b.summary?.high || 0) - (a.summary?.high || 0) ||
    (b.fixable || 0) - (a.fixable || 0) || a.name.localeCompare(b.name);
}

function contents(images) {
  if (!images.length) return '';
  const rows = images.map(image =>
    '<tr><th scope="row"><a href="#' + image.anchor + '">' + escape(image.name) + '</a></th>' +
    (image.error ? '<td colspan="5"><span class="critical">Scan failed</span></td></tr>' :
      '<td>' + escape(image.scanner) + '</td><td class="num">' + n(image.summary.critical) + '</td><td class="num">' +
      n(image.summary.high) + '</td><td class="num">' + n(image.fixable) + '</td><td class="num">' + n(image.summary.total) + '</td></tr>'));
  return '<section id="contents"><h2>Image index</h2><p class="muted">Select an image to jump to its results.</p>' +
    '<div class="scroll"><table><thead><tr><th scope="col">Image</th><th scope="col">Scanner</th><th scope="col">Critical</th>' +
    '<th scope="col">High</th><th scope="col">With fixes</th><th scope="col">Findings</th></tr></thead><tbody>' + rows.join('') + tableFooter + '</section>';
}

function overview(summary, images) {
  if (!summary) return '<section id="overview"><h2>Scan coverage</h2><p>No scan results are available for this run.</p></section>';
  const other = Math.max(0, summary.total - levels.slice(0, 4).reduce((sum, key) => sum + (summary[key] || 0), 0));
  const cards = [
    ['Images scanned', n(summary.scanned) + ' / ' + n(summary.selected), ''],
    ['Critical', n(summary.critical), 'critical'], ['High', n(summary.high), 'high'],
    ['With published fixes', n(summary.fixable), 'fixed'],
  ].map(([label, value, style]) => '<div><dt>' + label + '</dt><dd class="' + style + '">' + value + '</dd></div>');
  const failed = images.filter(image => image.error);
  return '<section id="overview"><h2>At a glance</h2><dl class="metrics">' + cards.join('') +
    '</dl><p><strong>' + n(summary.total) + ' findings</strong> · ' + n(summary.medium) + ' medium · ' +
    n(summary.low) + ' low · ' + n(other) + ' other severities</p>' +
    (summary.failed || summary.skipped ? '<aside><strong>Coverage gaps</strong><p>' + n(summary.failed) + ' failed · ' +
      n(summary.skipped) + ' skipped</p>' + (failed.length ? '<ul>' + failed.map(image => '<li><a href="#' +
        image.anchor + '">' + escape(image.name) + '</a> — ' + escape(image.error) + '</li>').join('') + '</ul>' : '') + '</aside>' : '') +
    '</section>';
}

function priorities(items) {
  if (!items.length) return '';
  return '<section id="priorities"><h2>Priority fixes</h2><p class="muted">Critical and high-severity package upgrades with a published fix. Review and rebuild the affected images.</p>' +
    '<ol class="priorities">' + items.map(({ image, finding }) => '<li><span class="' + finding.severity + '">' +
      labels[finding.severity] + '</span> · ' + advisory(finding) + ' · <code>' + escape(finding.package) + '</code> ' +
      '<code>' + escape(finding.version) + ' → <strong class="fixed">' + escape(finding.fixed) + '</strong></code>' +
      '<br><a href="#' + image.anchor + '">' + escape(image.name) + '</a></li>').join('') + '</ol></section>';
}

const style = '<style>' +
  '*{box-sizing:border-box}html{scroll-padding:18px}body{margin:0;background:#f2f5f9;color:#18243a;font:16px/1.55 system-ui,sans-serif}' +
  'main{max-width:1180px;margin:auto;padding:32px 24px 60px}header,section,article,aside{padding:18px 24px;border-radius:10px}' +
  'header{background:#142747;color:#fff;padding:30px 26px;border-bottom:4px solid #5396e8}header a{color:#b7d9ff}' +
  'h1{font-size:clamp(25px,5vw,39px);line-height:1.13;margin:0 0 10px}h2{margin:.1em 0 .5em;font-size:23px;line-height:1.25}' +
  'p{margin:.6em 0}section,article{margin-top:16px;background:#fff;border:1px solid #d6dfeb}aside{background:#fff5eb;border-left:4px solid #9d421f}' +
    'aside ul{margin:.4em 0;max-height:15em;overflow:auto}nav{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:16px;padding-left:2px}' +
  'a{color:#174f99;text-underline-offset:.15em}a:focus-visible,summary:focus-visible{outline:3px solid #267dbd;outline-offset:2px}' +
  '.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin:0}.metrics div{padding:10px 13px;background:#eef3fa;border-radius:7px}' +
  'dt,.muted,.finding-title{color:#465975}.metrics dd{margin:1px 0 0;font-size:28px;font-weight:700}.critical{color:#a21b31;font-weight:700}' +
  '.high{color:#974019;font-weight:670}.fixed{color:#176348;font-weight:670}.finding-title{display:block;font-size:.85em}' +
  '.priorities{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:10px 25px;margin-bottom:.5em;padding-left:1.5em}' +
  'summary{cursor:pointer;font-weight:670;padding:8px 0}details article{margin:6px 0 16px}article:target{outline:3px solid #2b6cb0;outline-offset:3px}' +
  'details>summary strong{overflow-wrap:anywhere}.image-label{display:inline-block;margin-left:.4em;font-size:.9em;font-weight:500}' +
  '.scroll{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left;font-size:14px;margin:.5em 0}thead{background:#edf3fa}' +
  'th,td{border-bottom:1px solid #dbe3ef;padding:7px 10px;vertical-align:top}tbody tr:nth-child(even){background:#f7faff}' +
  'code{overflow-wrap:anywhere}.num{text-align:right;font-variant-numeric:tabular-nums}footer{margin:18px 0 0;color:#465975}' +
  '@media(max-width:600px){main{padding:14px 10px 35px}header,section,article,aside{padding:13px}th,td{padding:6px}.scroll table{min-width:490px}}' +
  '@media print{body{background:white}main{max-width:none;padding:0}header{color:black;background:white;border-color:#aaa}header a{color:#174f99}' +
  'aside ul{max-height:none}.scroll{overflow:visible}tr,summary{break-inside:avoid}thead{display:table-header-group}}' +
  '</style>';

function build(db, run, result) {
  const summary = result.report?.summary;
  const images = [...(result.report?.images || [])].sort(imageOrder)
    .map((image, index) => ({ ...image, anchor: 'image-' + (index + 1), rows: [], included: 0 }));
  const read = db.prepare('SELECT results_json FROM scan_results WHERE id=? AND security_run_id=? AND verified_image_id=?');
  const shortlist = levels.slice(0, 2).map(() => []);
  const buffered = levels.map(() => 0);
  const queues = levels.map(() => []);
  const clean = images.filter(image => !image.error && !image.summary?.total).length;
  for (const image of images) {
    if (!image.scanId || !image.summary?.total) continue;
    const record = read.get(image.scanId, run.id, image.id);
    if (!record) continue;
    const groups = levels.map(() => []);
    const upgrades = new Set();
    for (const finding of groupFindings(JSON.parse(record.results_json))) {
      const level = rank(finding.severity);
      const selected = shortlist[level];
      if (selected && finding.fixed && selected.length < 6) {
        const upgrade = JSON.stringify([finding.package, finding.version, finding.fixed]);
        if (!upgrades.has(upgrade)) {
          upgrades.add(upgrade);
          selected.push({ image, finding });
        }
      }
      if (groups[level].length && buffered[level] >= MAX_ATTACHMENT_BYTES) continue;
      const row = findingRow(finding);
      const bytes = Buffer.byteLength(row);
      groups[level].push({ row, bytes, occurrences: finding.occurrences });
      buffered[level] += bytes;
    }
    groups.forEach((entries, level) => {
      if (entries.length) queues[level].push({ image, entries, index: 0 });
    });
  }
  const priorityItems = shortlist.flat().slice(0, 6);
  const fullRun = dashboardLink(run);
  const status = { success: 'Completed', partial: 'Partial coverage', error: 'Scan failed' }[result.status] || 'Unknown';
  const scope = run.image_scope === 'all' ? 'All installed images' : 'Images used by running containers';
  const heading = '<header id="top"><h1>Image vulnerability report</h1><p>' + escape(run.host_name) + ' · Run #' + run.id + ' · ' + status +
    '</p><p>' + scope + ' · Finished <time datetime="' + escape(run.finished_at) + '">' +
    escape(run.finished_at?.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')) + '</time></p>' + fullRun + '</header>';
  const navigation = '<nav aria-label="Report sections"><a href="#overview">At a glance</a>' +
    (priorityItems.length ? '<a href="#priorities">Priority fixes</a>' : '') +
    (images.length ? '<a href="#contents">Image index</a><a href="#details">Image details</a>' : '') + '</nav>';
  const head = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
    '<title>Docker Dash image vulnerability report</title>' + style + '</head><body><main>' + heading + navigation;
  const summaryHtml = overview(summary, images) + priorities(priorityItems);
  const indexHtml = contents(images);
  const end = '<footer><a href="#top">Back to top</a></footer></main></body></html>';
  const detailsHeading = '<section id="details"><h2>Image details</h2><p class="muted">Expand an image to see its findings. Entries with the same advisory, severity, package, installed version and fix share one row. Counts include all occurrences.' +
    (clean ? ' ' + n(clean) + ' scanned images had no findings.' : '') + '</p>';
  const wrappers = images.map(image => {
    const digest = image.id ? '<p class="muted"><code>' + escape(image.id) + '</code></p>' : '';
    const label = image.error ? '<span class="image-label critical">Scan failed</span>' :
      '<span class="image-label">' + n(image.summary.total) + ' findings · ' + n(image.fixable) + ' with fixes</span>';
    const before = '<details><summary><strong>' + escape(image.name) + '</strong> ' + label +
      '</summary><article id="' + image.anchor + '">' + digest + (image.error ? '<p>' + escape(image.error) + '</p>' : dashboardLink(run, image.scanId)) +
      (!image.error && !image.summary.total ? '<p>No vulnerabilities reported by ' + escape(image.scanner) + '.</p>' : '');
    return { before, after: '<p><a href="#contents">Back to image index</a></p></article></details>' };
  });
  const skeleton = head + summaryHtml + indexHtml + detailsHeading + end + wrappers.map(item => item.before + item.after).join('');
  let remaining = MAX_ATTACHMENT_BYTES - Buffer.byteLength(skeleton) -
    images.length * (Buffer.byteLength(tableHeader + tableFooter) + 144) - 512;
  // Share the attachment budget across images at each severity so a large image cannot hide critical findings from the rest.
  for (const group of queues) {
    while (group.length && remaining > 0) {
      for (let i = 0; i < group.length;) {
        const queue = group[i];
        const { row, bytes, occurrences } = queue.entries[queue.index++];
        if (bytes <= remaining) {
          queue.image.rows.push(row);
          queue.image.included += occurrences;
          remaining -= bytes;
        }
        if (queue.index === queue.entries.length) group.splice(i, 1);
        else i++;
      }
    }
  }
  const omitted = Math.max(0, (summary?.total || 0) - images.reduce((sum, image) => sum + image.included, 0));
  const notice = omitted > 0 ? '<aside><strong>' + n(omitted) + ' findings are omitted from this attachment.</strong> ' +
    'The attachment is limited to 2 MiB. For the complete findings, open the image in Docker Dash and select Download findings JSON.</aside>' : '';
  const details = images.map((image, index) => {
    const missing = (image.summary?.total || 0) - image.included;
    return wrappers[index].before +
      (image.rows.length ? tableHeader + image.rows.join('') + tableFooter : '') +
      (missing > 0 ? '<p class="muted">' + n(missing) + ' findings omitted from this image in the attachment.</p>' : '') +
      wrappers[index].after;
  }).join('');
  return {
    omitted,
    attachment: { filename: 'docker-dash-image-scan-' + run.id + '.html', contentType: 'text/html; charset=utf-8',
      content: head + summaryHtml + indexHtml + (images.length ? detailsHeading + notice + details + '</section>' : notice) + end },
  };
}

module.exports = { build };
