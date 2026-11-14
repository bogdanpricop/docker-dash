'use strict';

const { hasFix } = require('./image-scan-results');

const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const severityOrder = ['critical', 'high', 'medium', 'low', 'negligible', 'unknown'];
const labels = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', negligible: 'Negligible', unknown: 'Unknown' };
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function cell(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const bounded = text.length > 300 ? text.slice(0, 300) + '…' : text;
  return (bounded || '—').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[&<>"']/g, character => entities[character]);
}

function build(db, run, result) {
  const images = result.report?.images || [];
  const summary = result.report?.summary;
  const prefix = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Docker Dash image vulnerability report</title>
    <style>body{font:16px system-ui,sans-serif;max-width:1150px;margin:30px auto;padding:0 16px;color:#17202a}
    h2{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;margin-bottom:24px}th,td{border:1px solid #cbd5e1;
    padding:6px 9px;text-align:left;overflow-wrap:anywhere}th{background:#f1f5f9}code{overflow-wrap:anywhere}</style></head><body>
    <h1>Image vulnerability report</h1><p>Docker host · ${cell(run.host_name)} · Run #${run.id} · ${cell(result.status)}</p>
    <p>Finished at ${cell(run.finished_at)}</p>${summary ? `<p>${summary.scanned}/${summary.selected} images scanned · ${summary.failed} failed ·
    ${summary.skipped} skipped · ${summary.total} findings · ${summary.fixable} with fixes available</p>` : '<p>No scan results are available for this run.</p>'}`;
  const table = '<table><thead><tr><th>Vulnerability ID</th><th>Severity</th><th>Package</th><th>Installed version</th><th>Fixed in</th></tr></thead><tbody>';
  const tableEnd = '</tbody></table>';
  const sections = images.map(image => {
    const title = `<h2>${cell(image.name)}</h2>${image.id ? `<div><code>${cell(image.id)}</code></div>` : ''}`;
    if (image.error) return title + `<p>Scan failed · ${cell(image.error)}</p>`;
    return title + `<p>${cell(image.scanner)} · ${image.summary.total} findings · ${image.fixable} with fixes available</p>`;
  });
  let remaining = MAX_ATTACHMENT_BYTES - Buffer.byteLength(prefix + sections.join('')) -
    images.length * Buffer.byteLength(table + tableEnd) - 1024;
  let included = 0;
  const scan = db.prepare('SELECT results_json FROM scan_results WHERE id=? AND security_run_id=? AND verified_image_id=?');
  for (const [index, image] of images.entries()) {
    if (!image.scanId || !image.summary?.total || remaining <= 0) continue;
    const recorded = scan.get(image.scanId, run.id, image.id);
    if (!recorded) continue;
    const findings = JSON.parse(recorded.results_json);
    const severity = value => Object.hasOwn(labels, value) ? value : 'unknown';
    findings.sort((a, b) => severityOrder.indexOf(severity(a.severity)) - severityOrder.indexOf(severity(b.severity)));
    const rows = [];
    for (const finding of findings) {
      const row = `<tr><td>${cell(finding.id)}</td><td>${labels[severity(finding.severity)]}</td><td>${cell(finding.package)}</td>` +
        `<td>${cell(finding.version)}</td><td>${hasFix(finding) ? cell(finding.fixedIn) : 'No published fix'}</td></tr>`;
      const size = Buffer.byteLength(row);
      if (size > remaining) break;
      remaining -= size;
      included++;
      rows.push(row);
    }
    if (rows.length) sections[index] += table + rows.join('') + tableEnd;
  }
  const omitted = (summary?.total || 0) - included;
  const note = omitted > 0 ? `<p><strong>${omitted} findings are omitted from this attachment.</strong> Open the run in Docker Dash for the full results.</p>` : '';
  return {
    omitted,
    attachment: { filename: `docker-dash-image-scan-${run.id}.html`, contentType: 'text/html; charset=utf-8',
      content: prefix + note + sections.join('') + '</body></html>' },
  };
}

module.exports = { build };
