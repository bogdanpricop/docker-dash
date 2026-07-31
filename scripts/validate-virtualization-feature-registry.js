'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RESEARCH_RELATIVE = 'docs/research/virtualization-market-research-2026.md';
const REGISTRY_RELATIVE = 'docs/research/virtualization-feature-registry.json';
const REPORT_RELATIVE = 'docs/research/virtualization-feature-status-report.md';
const RESEARCH_PATH = path.join(ROOT, RESEARCH_RELATIVE);
const REGISTRY_PATH = path.join(ROOT, REGISTRY_RELATIVE);
const REPORT_PATH = path.join(ROOT, REPORT_RELATIVE);
const BASELINE_RELEASE = 'v8.79.0';
const STATUS_VALUES = new Set(['Done', 'Partial', 'Open']);
const SOURCE_VALUES = new Set(['Done', 'Partial', 'Now', 'Next', 'Later']);
const DELIVERY_LEVELS = new Set([
  'declared-scope', 'control-plane', 'local-end-to-end', 'partial', 'not-started',
]);

function expandIdSpecs(specs) {
  const ids = new Set();
  for (const spec of specs) {
    const match = /^(B\d{3})(?:-(B\d{3}))?$/.exec(spec);
    if (!match) throw new Error(`Invalid feature ID specification: ${spec}`);
    const start = Number(match[1].slice(1));
    const end = match[2] ? Number(match[2].slice(1)) : start;
    if (start > end || start < 1 || end > 450) throw new Error(`Invalid feature ID range: ${spec}`);
    for (let value = start; value <= end; value += 1) ids.add(`B${String(value).padStart(3, '0')}`);
  }
  return ids;
}

// Mutation-looking features in these shipped slices deliberately stop at a
// validated control-plane contract. Keeping this list explicit prevents a
// `Done` row from being misread as proof of provider/external execution.
const CONTROL_PLANE_IDS = expandIdSpecs([
  'B041-B044', 'B047', 'B056-B061', 'B075', 'B082-B084', 'B087-B089',
  'B102-B103', 'B105-B117', 'B406-B425',
]);

function parseResearch(markdown) {
  const lines = markdown.split(/\r?\n/);
  const features = [];
  let category = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = /^### ([A-R])\. (.+?) \(B(\d{3})[–-]B(\d{3})\)$/.exec(line);
    if (heading) {
      category = {
        id: heading[1],
        name: heading[2],
        firstFeatureId: `B${heading[3]}`,
        lastFeatureId: `B${heading[4]}`,
      };
      continue;
    }

    const row = /^\| (B\d{3}) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/.exec(line);
    if (!row || !SOURCE_VALUES.has(row[6].trim())) continue;
    if (!category) throw new Error(`Feature row ${row[1]} has no category heading`);
    features.push({
      featureId: row[1],
      name: row[2].trim(),
      description: row[3].trim(),
      value: row[4].trim(),
      effort: row[5].trim(),
      sourceState: row[6].trim(),
      category: { ...category },
      sourceLine: index + 1,
    });
  }
  return features;
}

function normalizedStatus(sourceState) {
  if (sourceState === 'Done' || sourceState === 'Partial') return sourceState;
  return 'Open';
}

function providersFor(feature) {
  const number = Number(feature.featureId.slice(1));
  if (number <= 175) return ['proxmox', 'vsphere', 'xen'];
  if (number >= 301 && number <= 325) return ['kubevirt', 'openshift-virtualization'];
  return ['provider-neutral'];
}

function deliveryLevelFor(feature, status) {
  if (status === 'Open') return 'not-started';
  if (['B015', 'B045', 'B090', 'B104', 'B118', 'B119', 'B120', 'B121', 'B123', 'B124', 'B125'].includes(feature.featureId)) return 'local-end-to-end';
  if (status === 'Partial') return 'partial';
  if (CONTROL_PLANE_IDS.has(feature.featureId)) return 'control-plane';
  return 'declared-scope';
}

function evidenceFor(feature, status) {
  if (status === 'Open') return [];
  if (feature.featureId === 'B015') {
    return [
      {
        type: 'test',
        reference: 'provider-inventory-views focused tests',
        path: 'src/__tests__/provider-inventory-views.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R1/B015 local implementation',
        path: 'docs/planning/remaining-market-research-implementation-plan.md',
      },
    ];
  }
  if (feature.featureId === 'B045') {
    return [
      {
        type: 'test',
        reference: 'scheduled VM actions focused tests',
        path: 'src/__tests__/provider-vm-action-schedules.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R2/B045 local implementation',
        path: 'docs/planning/virtualization-platform/V2.1c-scheduled-vm-actions-feature-spec.md',
      },
    ];
  }
  if (feature.featureId === 'B090') {
    return [
      {
        type: 'test',
        reference: 'provider snapshot risk focused tests',
        path: 'src/__tests__/provider-snapshot-risk.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R3a/B090 local implementation',
        path: 'docs/planning/virtualization-platform/V4.2g-stale-snapshot-growth-monitor-feature-spec.md',
      },
    ];
  }
  if (feature.featureId === 'B096') {
    return [
      {
        type: 'test',
        reference: 'storage repository health focused tests',
        path: 'src/__tests__/storage-repository-health.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R3b/B096 local implementation',
        path: 'docs/planning/virtualization-platform/V4.2h-nfs-smb-repository-health-feature-spec.md',
      },
    ];
  }
  if (feature.featureId === 'B104') {
    return [
      {
        type: 'test',
        reference: 'provider VM NIC link focused tests',
        path: 'src/__tests__/provider-vm-nics.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R4f/B104 local implementation',
        path: 'docs/planning/virtualization-platform/V4.4k-vm-nic-link-control-feature-spec.md',
      },
    ];
  }
  if (feature.featureId === 'B118') {
    return [
      {
        type: 'test',
        reference: 'network dependency map focused tests',
        path: 'src/__tests__/network-dependency-map.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R4a/B118 local implementation',
        path: 'docs/planning/virtualization-platform/V4.4e-network-dependency-map-feature-spec.md',
      },
    ];
  }
  if (feature.featureId === 'B119') {
    return [
      {
        type: 'test',
        reference: 'network reachability simulation focused tests',
        path: 'src/__tests__/network-reachability.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R4b/B119 local simulation-only implementation',
        path: 'docs/planning/virtualization-platform/V4.4f-network-reachability-simulation-feature-spec.md',
      },
    ];
  }
  if (feature.featureId === 'B120') {
    return [
      {
        type: 'test',
        reference: 'network MTU detector focused tests',
        path: 'src/__tests__/network-mtu-detector.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R4b/B120 local implementation',
        path: 'docs/planning/virtualization-platform/V4.4g-network-mtu-mismatch-feature-spec.md',
      },
    ];
  }
  if (feature.featureId === 'B121') {
    return [
      {
        type: 'test',
        reference: 'network Bond/LAG health focused tests',
        path: 'src/__tests__/network-bond-health.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R4c/B121 local implementation',
        path: 'docs/planning/virtualization-platform/V4.4h-network-bond-health-feature-spec.md',
      },
    ];
  }
  if (feature.featureId === 'B123') {
    return [
      {
        type: 'test',
        reference: 'network load balancer inventory focused tests',
        path: 'src/__tests__/network-load-balancer-inventory.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R4d/B123 local implementation',
        path: 'docs/planning/virtualization-platform/V4.4i-load-balancer-inventory-feature-spec.md',
      },
    ];
  }
  if (feature.featureId === 'B124') {
    return [
      {
        type: 'test',
        reference: 'network public IP lifecycle plan focused tests',
        path: 'src/__tests__/network-public-ip-plans.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R4d/B124 local implementation',
        path: 'docs/planning/virtualization-platform/V4.4j-public-ip-lifecycle-plan-feature-spec.md',
      },
      {
        type: 'test',
        reference: 'v8.86 network/backup qualification tests',
        path: 'src/__tests__/provider-operational-qualification.test.js',
      },
    ];
  }
  if (feature.featureId === 'B125') {
    return [
      {
        type: 'test',
        reference: 'network intent validation focused tests',
        path: 'src/__tests__/network-intent-validator.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R4e/B125 local implementation',
        path: 'docs/planning/virtualization-platform/V4.5i-network-intent-validation-feature-spec.md',
      },
      {
        type: 'test',
        reference: 'v8.86 network/backup qualification tests',
        path: 'src/__tests__/provider-operational-qualification.test.js',
      },
    ];
  }
  const featureNumber = Number(feature.featureId.slice(1));
  if (featureNumber >= 129 && featureNumber <= 138) {
    const evidence = [
      {
        type: 'test',
        reference: 'R5a backup control-plane focused tests',
        path: 'src/__tests__/provider-backup-control-plane.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R5a/B129-B138 local control-plane depth',
        path: 'docs/planning/virtualization-platform/V3.3b-backup-control-plane-depth-feature-spec.md',
      },
    ];
    if (featureNumber <= 136) evidence.push({
      type: 'test',
      reference: 'v8.86 network/backup qualification tests',
      path: 'src/__tests__/provider-operational-qualification.test.js',
    });
    if (featureNumber >= 137) evidence.push({
      type: 'test',
      reference: 'v8.87 recovery-depth qualification tests',
      path: 'src/__tests__/provider-operational-qualification.test.js',
    });
    return evidence;
  }
  if (featureNumber >= 139 && featureNumber <= 148) {
    const testPath = featureNumber <= 140 ? 'src/__tests__/provider-restore-drills.test.js'
      : featureNumber <= 145 ? 'src/__tests__/provider-restore-replication-depth.test.js'
        : 'src/__tests__/provider-dr-runbooks.test.js';
    const evidence = [
      { type: 'test', reference: 'R5b/R5c recovery control-plane focused tests', path: testPath },
      { type: 'working-tree', reference: 'R5b/R5c restore and replication depth',
        path: 'docs/planning/virtualization-platform/V3.7-restore-replication-depth-feature-spec.md' },
    ];
    if (featureNumber <= 146) evidence.push({
      type: 'test', reference: 'v8.87 recovery-depth qualification tests',
      path: 'src/__tests__/provider-operational-qualification.test.js',
    });
    if (featureNumber >= 147) evidence.push({
      type: 'test', reference: 'v8.88 DR/security qualification tests',
      path: 'src/__tests__/provider-operational-qualification.test.js',
    });
    return evidence;
  }
  if (featureNumber >= 149 && featureNumber <= 158) {
    const evidence = [
      { type: 'test', reference: 'R5c/R6a DR and security assurance focused tests',
        path: featureNumber <= 150 ? 'src/__tests__/provider-dr-runbooks.test.js'
          : 'src/__tests__/provider-security-assurance.test.js' },
      { type: 'working-tree', reference: 'R5c/R6a DR objectives and security assurance',
        path: 'docs/planning/virtualization-platform/V3.8-security-assurance-feature-spec.md' },
    ];
    if (featureNumber <= 156) evidence.push({
      type: 'test', reference: 'v8.88 DR/security qualification tests',
      path: 'src/__tests__/provider-operational-qualification.test.js',
    });
    if (featureNumber >= 157) evidence.push({
      type: 'test', reference: 'v8.89 security-lifecycle qualification tests',
      path: 'src/__tests__/provider-operational-qualification.test.js',
    });
    return evidence;
  }
  if (featureNumber >= 159 && featureNumber <= 168) {
    const evidence = [
      {
        type: 'test',
        reference: 'R6b provider security lifecycle focused tests',
        path: 'src/__tests__/provider-security-lifecycle.test.js',
      },
      {
        type: 'working-tree',
        reference: 'R6a/R6b B159-B168 security lifecycle control plane',
        path: 'docs/planning/virtualization-platform/V3.9-security-lifecycle-feature-spec.md',
      },
    ];
    if (featureNumber <= 166) evidence.push({
      type: 'test', reference: 'v8.89 security-lifecycle qualification tests',
      path: 'src/__tests__/provider-operational-qualification.test.js',
    });
    return evidence;
  }
  return [{
    type: 'release',
    reference: `${BASELINE_RELEASE} reconciled delivery baseline`,
    path: 'docs/planning/virtualization-platform-implementation-plan.md',
  }];
}

function limitationsFor(feature, status, deliveryLevel) {
  if (status === 'Open') {
    const number = Number(feature.featureId.slice(1));
    const batch = feature.featureId === 'B045' ? 'R2'
      : [90, 96].includes(number) ? 'R3'
        : 'R4';
    return [`Outstanding implementation scope is tracked in batch ${batch}.`];
  }
  if (feature.featureId === 'B015') {
    return ['Released in v8.80.0 and read-only qualified in v8.85.0; browser smoke remains outstanding.'];
  }
  if (feature.featureId === 'B045') {
    return ['Released in v8.80.0 and read-only qualified in v8.85.0; browser smoke and a real-provider canary remain outstanding.'];
  }
  if (feature.featureId === 'B090') {
    return ['Released in v8.80.0 and read-only qualified in v8.85.0; browser smoke remains outstanding.'];
  }
  if (feature.featureId === 'B096') {
    return ['Released in v8.80.0 and read-only qualified in v8.85.0; a protocol auth/list adapter and browser smoke remain outstanding.'];
  }
  if (feature.featureId === 'B104') {
    return ['Released in v8.80.0 and read-only qualified in v8.85.0; link mutation stays default-off pending browser smoke and a disposable-provider canary.'];
  }
  if (feature.featureId === 'B118') {
    return ['Released in v8.80.0 and read-only qualified in v8.85.0; browser smoke and provider evidence adapters remain outstanding.'];
  }
  if (feature.featureId === 'B119') {
    return ['Released in v8.80.0 and read-only qualified in v8.85.0 with zero qualification network calls; provider simulation adapters, browser smoke and any approved allowlisted active-probe runner remain outstanding.'];
  }
  if (feature.featureId === 'B120') {
    return ['Released in v8.80.0 and read-only qualified in v8.85.0; browser smoke and provider evidence adapters remain outstanding.'];
  }
  if (feature.featureId === 'B121') {
    return ['Released in v8.80.0 and read-only qualified in v8.85.0; browser smoke and provider collectors remain outstanding.'];
  }
  if (feature.featureId === 'B123') {
    return ['Released in v8.80.0 and read-only qualified in v8.85.0; browser smoke and provider collectors remain outstanding.'];
  }
  if (feature.featureId === 'B124') {
    return ['Released in v8.80.0 and read-only qualified in v8.86.0; browser smoke, provider adapters, canary and controlled apply remain outstanding.'];
  }
  if (feature.featureId === 'B125') {
    return ['Released in v8.80.0 and read-only qualified in v8.86.0; browser smoke and the first executor hash binding remain outstanding.'];
  }
  const number = Number(feature.featureId.slice(1));
  if (status === 'Partial' && number >= 129 && number <= 136) {
    return ['Released in v8.80.0 and read-only qualified in v8.86.0; Proxmox remains the only real executor, while XO/vSphere adapters, browser smoke and a disposable-provider canary remain outstanding.'];
  }
  if (status === 'Partial' && number >= 137 && number <= 138) {
    return ['Released in v8.80.0 and read-only qualified in v8.87.0; Proxmox remains the only real executor, while XO/vSphere adapters, browser smoke and a disposable-provider canary remain outstanding.'];
  }
  if (status === 'Partial' && number >= 139 && number <= 140) {
    return ['Released in v8.81.0 and read-only qualified in v8.87.0; a second task-aware drill executor, browser smoke and a disposable-provider canary remain outstanding.'];
  }
  if (status === 'Partial' && number === 141) {
    return ['Released in v8.81.0 and read-only qualified in v8.87.0; provider-native file content adapters, an approved content endpoint and browser smoke remain outstanding.'];
  }
  if (status === 'Partial' && number >= 142 && number <= 144) {
    return ['Released in v8.81.0 and read-only qualified in v8.87.0; the provider-native restore/copy executor, browser smoke and a disposable-provider canary remain outstanding.'];
  }
  if (status === 'Partial' && number === 145) {
    return ['Released in v8.81.0 and read-only qualified in v8.87.0; provider-native replication configuration, fencing, browser smoke and a disposable-provider canary remain outstanding.'];
  }
  if (status === 'Partial' && number === 146) {
    return ['Released in v8.81.0 and read-only qualified in v8.87.0; provider fencing, network cutover, data-authority reversal, browser smoke and a disposable-provider canary remain outstanding.'];
  }
  if (status === 'Partial' && number >= 147 && number <= 148) {
    return ['Released in v8.81.0 and read-only qualified in v8.88.0 as deterministic rehearsal-only control plane; provider-native failover/failback execution, fencing, browser smoke and canary remain outstanding.'];
  }
  if (status === 'Partial' && number >= 149 && number <= 150) {
    return ['Released in v8.82.0 and read-only qualified in v8.88.0; provider-native DR test/failover execution, isolated-network canary and browser smoke remain outstanding.'];
  }
  if (status === 'Partial' && number >= 151 && number <= 156) {
    return ['Released in v8.82.0 and read-only qualified in v8.88.0; provider-native security collectors, browser smoke and provider canary remain outstanding.'];
  }
  if (status === 'Partial' && number >= 157 && number <= 158) {
    return ['Released in v8.82.0 and read-only qualified in v8.89.0; guarded confidential provisioning, provider-native hardening collection, browser smoke and provider canary remain outstanding.'];
  }
  if (status === 'Partial' && number >= 159 && number <= 166) {
    return ['Released in v8.83.0 and read-only qualified in v8.89.0; provider-native collectors, production certificate/remediation adapters, browser smoke and canary remain outstanding.'];
  }
  if (status === 'Partial' && number >= 129 && number <= 150) {
    return ['Deeper multi-provider backup, restore and DR execution remains in batch R5.'];
  }
  if (status === 'Partial' && number >= 151 && number <= 175) {
    if (number >= 159 && number <= 168) return ['Local evidence, correlation, exception, planning and secret-reference controls are complete; provider-native collectors, production remediation/certificate adapters, browser smoke and canary remain outstanding.'];
    return ['Provider-native security evidence, controlled remediation and compliance depth remain in batch R6.'];
  }
  if (deliveryLevel === 'control-plane') {
    return ['No implicit provider or external apply path is claimed by this delivery level.'];
  }
  return [];
}

function categorySummary(features) {
  const byCategory = new Map();
  for (const feature of features) {
    if (!byCategory.has(feature.category.id)) {
      byCategory.set(feature.category.id, {
        id: feature.category.id,
        name: feature.category.name,
        Done: 0,
        Partial: 0,
        Open: 0,
        total: 0,
      });
    }
    const summary = byCategory.get(feature.category.id);
    summary[feature.status] += 1;
    summary.total += 1;
  }
  return [...byCategory.values()];
}

function buildRegistry(markdown) {
  const parsed = parseResearch(markdown);
  const features = parsed.map(feature => {
    const status = normalizedStatus(feature.sourceState);
    const deliveryLevel = deliveryLevelFor(feature, status);
    return {
      featureId: feature.featureId,
      name: feature.name,
      description: feature.description,
      category: { id: feature.category.id, name: feature.category.name },
      value: feature.value,
      effort: feature.effort,
      marketHorizon: status === 'Open' ? feature.sourceState : null,
      status,
      deliveryLevel,
      providers: providersFor(feature),
      evidence: evidenceFor(feature, status),
      limitations: limitationsFor(feature, status, deliveryLevel),
      source: { path: RESEARCH_RELATIVE, line: feature.sourceLine },
    };
  });
  const statuses = { Done: 0, Partial: 0, Open: 0 };
  for (const feature of features) statuses[feature.status] += 1;
  return {
    schemaVersion: 1,
    generatedFrom: RESEARCH_RELATIVE,
    baselineRelease: BASELINE_RELEASE,
    summary: { total: features.length, statuses, categories: categorySummary(features) },
    features,
  };
}

function validateRegistry(registry) {
  const errors = [];
  const features = Array.isArray(registry?.features) ? registry.features : [];
  if (registry?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (features.length !== 450) errors.push(`Expected 450 features, found ${features.length}`);
  const ids = new Set();
  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    const expectedId = `B${String(index + 1).padStart(3, '0')}`;
    if (feature.featureId !== expectedId) errors.push(`Position ${index + 1}: expected ${expectedId}, found ${feature.featureId}`);
    if (ids.has(feature.featureId)) errors.push(`Duplicate feature ID: ${feature.featureId}`);
    ids.add(feature.featureId);
    if (!STATUS_VALUES.has(feature.status)) errors.push(`${feature.featureId}: invalid status ${feature.status}`);
    if (!DELIVERY_LEVELS.has(feature.deliveryLevel)) errors.push(`${feature.featureId}: invalid deliveryLevel ${feature.deliveryLevel}`);
    if (!Array.isArray(feature.providers) || !feature.providers.length) errors.push(`${feature.featureId}: providers must not be empty`);
    if (!Array.isArray(feature.evidence) || !Array.isArray(feature.limitations)) errors.push(`${feature.featureId}: evidence and limitations must be arrays`);
    if (feature.status === 'Done' && !feature.evidence?.some(item => ['release', 'commit', 'test'].includes(item.type))) {
      errors.push(`${feature.featureId}: Done requires release, commit or test evidence`);
    }
    if (feature.status === 'Partial' && (!feature.evidence?.length || !feature.limitations?.length)) {
      errors.push(`${feature.featureId}: Partial requires evidence and limitations`);
    }
    if (feature.status === 'Open' && (!['Now', 'Next', 'Later'].includes(feature.marketHorizon) || !feature.limitations?.length)) {
      errors.push(`${feature.featureId}: Open requires a market horizon and remaining-scope limitation`);
    }
    if (feature.deliveryLevel === 'control-plane'
      && !feature.limitations?.some(item => item.includes('No implicit provider or external apply path'))) {
      errors.push(`${feature.featureId}: control-plane delivery must state the no-apply limitation`);
    }
  }
  const categories = registry?.summary?.categories || [];
  if (categories.length !== 18) errors.push(`Expected 18 categories, found ${categories.length}`);
  for (const category of categories) {
    if (category.total !== 25) errors.push(`Category ${category.id} must contain 25 features, found ${category.total}`);
  }
  return errors;
}

function buildReport(registry) {
  const lines = [
    '# Virtualization feature delivery status',
    '',
    `Generated deterministically from [${RESEARCH_RELATIVE}](virtualization-market-research-2026.md).`,
    `Baseline release: \`${registry.baselineRelease}\`.`,
    '',
    '## Summary',
    '',
    '| Status | Count |',
    '|---|---:|',
    `| Done | ${registry.summary.statuses.Done} |`,
    `| Partial | ${registry.summary.statuses.Partial} |`,
    `| Open | ${registry.summary.statuses.Open} |`,
    `| **Total** | **${registry.summary.total}** |`,
    '',
    '## By category',
    '',
    '| Category | Done | Partial | Open | Total |',
    '|---|---:|---:|---:|---:|',
    ...registry.summary.categories.map(category => `| ${category.id}. ${category.name} | ${category.Done} | ${category.Partial} | ${category.Open} | ${category.total} |`),
    '',
  ];
  for (const status of ['Open', 'Partial']) {
    const items = registry.features.filter(feature => feature.status === status);
    lines.push(`## ${status} feature IDs`, '', items.map(feature => `\`${feature.featureId}\``).join(', '), '');
  }
  lines.push('The JSON registry is the machine-readable projection; edit the research table and regenerate it instead of editing generated artifacts directly.');
  return lines.join('\n');
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function run({ write = false } = {}) {
  const markdown = fs.readFileSync(RESEARCH_PATH, 'utf8');
  const expectedRegistry = buildRegistry(markdown);
  const errors = validateRegistry(expectedRegistry);
  if (errors.length) throw new Error(`Registry validation failed:\n- ${errors.join('\n- ')}`);
  const expectedJson = canonicalJson(expectedRegistry);
  const expectedReport = `${buildReport(expectedRegistry)}\n`;

  if (write) {
    fs.writeFileSync(REGISTRY_PATH, expectedJson);
    fs.writeFileSync(REPORT_PATH, expectedReport);
  } else {
    if (!fs.existsSync(REGISTRY_PATH) || fs.readFileSync(REGISTRY_PATH, 'utf8') !== expectedJson) {
      throw new Error(`Generated registry is stale. Run: npm run generate:virtualization-research`);
    }
    if (!fs.existsSync(REPORT_PATH) || fs.readFileSync(REPORT_PATH, 'utf8') !== expectedReport) {
      throw new Error(`Generated status report is stale. Run: npm run generate:virtualization-research`);
    }
  }

  const { statuses } = expectedRegistry.summary;
  process.stdout.write(`Virtualization registry valid: ${expectedRegistry.summary.total} features (Done ${statuses.Done}, Partial ${statuses.Partial}, Open ${statuses.Open}).\n`);
  return expectedRegistry;
}

if (require.main === module) {
  try { run({ write: process.argv.includes('--write') }); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseResearch, buildRegistry, validateRegistry, buildReport, canonicalJson,
  expandIdSpecs, CONTROL_PLANE_IDS, run,
};
