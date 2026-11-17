'use strict';

const triage = require('./dgx-triage');
const { hasFix } = require('../../image-scan-results');

async function summarize({ scans, containers }, config, analyze = triage.analyze) {
  const images = new Map();
  for (const scan of scans) {
    if (!images.has(scan.verified_image_id)) images.set(scan.verified_image_id, {
      imageId: scan.verified_image_id, image: scan.image_name, scans: [],
      consumers: containers.filter(c => c.imageIdFull === scan.verified_image_id)
        .map(({ id, name, stack, state }) => ({ id, name, stack, state })), findings: new Map(),
    });
    const image = images.get(scan.verified_image_id);
    image.scans.push({ id: scan.id, scanner: scan.scanner, scannedAt: scan.scanned_at });
    const rows = JSON.parse(scan.results_json);
    if (!Array.isArray(rows)) throw new Error('Stored scan evidence is unreadable. Rescan this image.');
    for (const row of rows) {
      const key = JSON.stringify([row.id, row.package, row.version]);
      const old = image.findings.get(key);
      const rank = { critical: 0, high: 1, medium: 2, low: 3 };
      const prioritized = !old || (rank[row.severity] ?? 4) < (rank[old.severity] ?? 4) ? row : old;
      image.findings.set(key, { ...prioritized, reportedFix: Boolean(old?.reportedFix || hasFix(row)) });
    }
  }
  const summary = [...images.values()].map(({ findings, ...image }) => ({ ...image,
    total: findings.size,
    critical: [...findings.values()].filter(v => v.severity === 'critical').length,
    high: [...findings.values()].filter(v => v.severity === 'high').length,
    fixable: [...findings.values()].filter(v => v.reportedFix).length,
  })).sort((a, b) => b.critical - a.critical || b.high - a.high || b.fixable - a.fixable || a.image.localeCompare(b.image));
  const result = { images: summary, scanCount: scans.length, dgxStatus: config.enabled ? 'pending' : 'disabled' };
  if (!config.enabled || !scans.length) return result;
  let analysis;
  try {
    analysis = await analyze({
      scans: scans.map(scan => ({ ...scan, imageId: scan.verified_image_id })),
      runningContainers: containers.filter(c => c.state === 'running' && images.has(c.imageIdFull)).length,
      stack: true,
    }, config);
  } catch (error) {
    return { ...result, dgxStatus: 'failed', dgxError: String(error.message || 'Inference failed').slice(0, 300) };
  }
  return { ...result, analysis, dgxStatus: analysis.transport === 'no_findings' ? 'no_findings' : 'completed' };
}

module.exports = { summarize };
