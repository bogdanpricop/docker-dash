'use strict';

const fs = require('fs');
const path = require('path');
const {
  parseResearch, buildRegistry, validateRegistry, buildReport, expandIdSpecs,
} = require('../../scripts/validate-virtualization-feature-registry');

const research = fs.readFileSync(path.join(__dirname, '../../docs/research/virtualization-market-research-2026.md'), 'utf8');

describe('virtualization market-research registry', () => {
  test('parses every feature exactly once in canonical order', () => {
    const features = parseResearch(research);
    expect(features).toHaveLength(450);
    expect(features[0].featureId).toBe('B001');
    expect(features.at(-1).featureId).toBe('B450');
    expect(new Set(features.map(feature => feature.featureId)).size).toBe(450);
    expect(new Set(features.map(feature => feature.category.id))).toEqual(
      new Set('ABCDEFGHIJKLMNOPQR'.split('')),
    );
  });

  test('normalizes reconciled delivery status and preserves explicit limitations', () => {
    const registry = buildRegistry(research);
    expect(registry.summary).toEqual(expect.objectContaining({
      total: 450,
      statuses: { Done: 391, Partial: 59, Open: 0 },
    }));
    expect(registry.features.find(feature => feature.featureId === 'B015')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'local-end-to-end', providers: ['proxmox', 'vsphere', 'xen'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B045')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'local-end-to-end', marketHorizon: null,
      limitations: ['Released in v8.80.0 and read-only qualified in v8.85.0; browser smoke and a real-provider canary remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B090')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'local-end-to-end', providers: ['proxmox', 'vsphere', 'xen'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B096')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'partial', providers: ['proxmox', 'vsphere', 'xen'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B104')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'local-end-to-end', providers: ['proxmox', 'vsphere', 'xen'],
      limitations: ['Released in v8.80.0 and read-only qualified in v8.85.0; link mutation stays default-off pending browser smoke and a disposable-provider canary.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B118')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'local-end-to-end', providers: ['proxmox', 'vsphere', 'xen'],
      limitations: ['Released in v8.80.0 and qualified in v8.85.0; v8.91.0 adds bounded provider-native VM IP capture, while live evidence, DNS/flow adapters and browser smoke remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B119')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'local-end-to-end', providers: ['proxmox', 'vsphere', 'xen'],
      limitations: ['Released in v8.80.0 and read-only qualified in v8.85.0 with zero qualification network calls; provider simulation adapters, browser smoke and any approved allowlisted active-probe runner remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B120')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'local-end-to-end', providers: ['proxmox', 'vsphere', 'xen'],
      limitations: ['Released in v8.80.0 and qualified in v8.85.0; v8.91.0 adds fail-closed vSphere/Xen segment-MTU capture, while end-to-end path/DF evidence and browser smoke remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B121')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'local-end-to-end', providers: ['proxmox', 'vsphere', 'xen'],
      limitations: ['Released in v8.80.0 and qualified in v8.85.0; v8.91.0 adds a read-only vSphere standard-vSwitch/pNIC collector, while live evidence, distributed-switch/LACP depth, non-vSphere collectors and browser smoke remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B123')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'local-end-to-end', providers: ['proxmox', 'vsphere', 'xen'],
      limitations: ['Released in v8.80.0 and read-only qualified in v8.85.0; browser smoke and provider collectors remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B124')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'local-end-to-end', providers: ['proxmox', 'vsphere', 'xen'],
      limitations: ['Released in v8.80.0 and read-only qualified in v8.86.0; browser smoke, provider adapters, canary and controlled apply remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B125')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'local-end-to-end', providers: ['proxmox', 'vsphere', 'xen'],
      limitations: ['Released in v8.80.0 and read-only qualified in v8.86.0; browser smoke and the first executor hash binding remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B129')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'partial', providers: ['proxmox', 'vsphere', 'xen'],
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-backup-control-plane.test.js',
      })]),
      limitations: ['Released in v8.80.0 and read-only qualified in v8.86.0; Proxmox remains the only real executor, while XO/vSphere adapters, browser smoke and a disposable-provider canary remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B137')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'partial',
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-operational-qualification.test.js',
      })]),
      limitations: ['Released in v8.80.0 and read-only qualified in v8.87.0; Proxmox remains the only real executor, while XO/vSphere adapters, browser smoke and a disposable-provider canary remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B139')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'partial',
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-restore-drills.test.js',
      })]),
      limitations: ['Released in v8.81.0 and read-only qualified in v8.87.0; a second task-aware drill executor, browser smoke and a disposable-provider canary remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B146')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'partial',
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-dr-runbooks.test.js',
      })]),
      limitations: ['Released in v8.81.0 and read-only qualified in v8.87.0; provider fencing, network cutover, data-authority reversal, browser smoke and a disposable-provider canary remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B147')).toEqual(expect.objectContaining({
      status: 'Partial', deliveryLevel: 'partial',
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-operational-qualification.test.js',
      })]),
      limitations: ['Released in v8.81.0 and read-only qualified in v8.88.0 as deterministic rehearsal-only control plane; provider-native failover/failback execution, fencing, browser smoke and canary remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B150')).toEqual(expect.objectContaining({
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-dr-runbooks.test.js',
      })]),
      limitations: ['Released in v8.82.0 and read-only qualified in v8.88.0; provider-native DR test/failover execution, isolated-network canary and browser smoke remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B156')).toEqual(expect.objectContaining({
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-security-assurance.test.js',
      })]),
      limitations: ['Released in v8.82.0 and read-only qualified in v8.88.0; provider-native security collectors, browser smoke and provider canary remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B157')).toEqual(expect.objectContaining({
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-operational-qualification.test.js',
      })]),
      limitations: ['Released in v8.82.0 and read-only qualified in v8.89.0; guarded confidential provisioning, provider-native hardening collection, browser smoke and provider canary remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B159')).toEqual(expect.objectContaining({
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-security-lifecycle.test.js',
      })]),
      limitations: ['Released in v8.83.0 and read-only qualified in v8.89.0; provider-native collectors, production certificate/remediation adapters, browser smoke and canary remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B166')).toEqual(expect.objectContaining({
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-operational-qualification.test.js',
      })]),
      limitations: ['Released in v8.83.0 and read-only qualified in v8.89.0; provider-native collectors, production certificate/remediation adapters, browser smoke and canary remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B167')).toEqual(expect.objectContaining({
      status: 'Partial',
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-operational-qualification.test.js',
      })]),
      limitations: ['Released in v8.83.0 and read-only qualified in v8.90.0; a production remediation adapter, disposable-provider canary and browser smoke remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B169')).toEqual(expect.objectContaining({
      status: 'Partial',
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-privileged-compliance.test.js',
      }), expect.objectContaining({
        path: 'docs/planning/virtualization-platform/V4.4t-critical-operation-jit-feature-spec.md',
      })]),
      limitations: ['Released in v8.84.0 and read-only qualified in v8.90.0; v8.91.4 wires granular JIT to forced power, snapshot revert/delete and VM migration behind a default-off rollout gate, while canary/enablement, SSO/WebAuthn step-up and browser smoke remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B175')).toEqual(expect.objectContaining({
      limitations: ['Released in v8.84.0 and read-only qualified in v8.90.0; provider-native factor collectors, a recovery canary and browser smoke remain outstanding.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B176')).toEqual(expect.objectContaining({
      status: 'Done', limitations: [],
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/provider-operational-qualification.test.js',
      })]),
    }));
    expect(registry.features.find(feature => feature.featureId === 'B041')).toEqual(expect.objectContaining({
      status: 'Done', deliveryLevel: 'control-plane',
      limitations: ['No implicit provider or external apply path is claimed by this delivery level.'],
    }));
    expect(registry.features.find(feature => feature.featureId === 'B122').status).toBe('Done');
    expect(registry.features.find(feature => feature.featureId === 'B168')).toEqual(expect.objectContaining({
      status: 'Partial',
      evidence: expect.arrayContaining([expect.objectContaining({
        path: 'src/__tests__/secret-reference-admission.test.js',
      })]),
      limitations: ['Released in v8.83.0 and read-only qualified in v8.90.0; v8.91.3 adds automatic manifest/job/template admission integration, while browser smoke remains outstanding.'],
    }));
  });

  test('rejects Done entries without release, commit or test evidence', () => {
    const registry = buildRegistry(research);
    registry.features.find(feature => feature.featureId === 'B001').evidence = [];
    expect(validateRegistry(registry)).toContain('B001: Done requires release, commit or test evidence');
  });

  test('renders a deterministic category and non-done feature report', () => {
    const report = buildReport(buildRegistry(research));
    expect(report).toContain('| A. Provider platform și inventar | 24 | 1 | 0 | 25 |');
    expect(report).toContain('| D. Storage și volume | 23 | 2 | 0 | 25 |');
    expect(report).toContain('| E. Networking și connectivity | 17 | 8 | 0 | 25 |');
    expect(report).toContain('| Open | 0 |');
    expect(report).toContain('## Open feature IDs');
    expect(report).toContain('## Partial feature IDs');
    expect(report).toContain('`B015`, `B045`, `B090`, `B096`, `B104`, `B118`, `B119`, `B120`, `B121`, `B123`, `B124`');
  });

  test('expands bounded feature ranges and rejects malformed input', () => {
    expect([...expandIdSpecs(['B003-B005'])]).toEqual(['B003', 'B004', 'B005']);
    expect(() => expandIdSpecs(['B005-B003'])).toThrow('Invalid feature ID range');
    expect(() => expandIdSpecs(['C001'])).toThrow('Invalid feature ID specification');
  });
});
