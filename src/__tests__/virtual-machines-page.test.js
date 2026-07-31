'use strict';

const page = require('../../public/js/pages/virtual-machines');

describe('common virtual machines page routing', () => {
  it('parses only canonical host-scoped VM deep links', () => {
    const id = `ddr_vm_${'a'.repeat(26)}`;
    expect(page._parseRoute(`7/${id}/hardware`)).toEqual({ hostId: 7, resourceId: id, tab: 'hardware' });
    expect(page._parseRoute(`7/${id}`)).toEqual({ hostId: 7, resourceId: id, tab: null });
    expect(page._parseRoute('7/OpaqueRef:secret')).toBeNull();
    expect(page._parseRoute(`0/${id}`)).toBeNull();
  });

  it('turns action blockers into an explanatory disabled-action tooltip', () => {
    expect(page._blockerSummary({ blockers: [
      { type: 'POLICY_BLOCKED', reason: 'Change freeze' },
      { type: 'ACTION_NOT_ENABLED', reason: 'Read-only in V1.1' },
    ] })).toBe('Change freeze · Read-only in V1.1');
  });

  it('renders snapshot preflight guardrails without trusting provider text', () => {
    global.Utils = { escapeHtml: value => String(value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') };
    const html = page._snapshotPlanHtml({
      vm: { displayName: '<img src=x>' }, action: 'create', name: 'safe-snapshot',
      consistency: 'crash', protection: { warning: '<script>alert(1)</script>' },
      blockers: [{ reason: '<b>blocked</b>' }], warnings: [{ type: 'NOT_A_BACKUP', reason: 'guardrail' }],
    });
    expect(html).toContain('Snapshot is not backup');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<script>');
    delete global.Utils;
  });

  it('contains a same-origin console launcher and never constructs provider URLs', () => {
    expect(page._openConsole).toEqual(expect.any(Function));
    const source = page._openConsole.toString();
    expect(source).toContain("target.origin !== location.origin");
    expect(source).toContain("target.pathname !== '/vm-console.html'");
    expect(source).not.toMatch(/proxmox|vcenter|xenserver|ticket/i);
  });

  it('renders normalized disk and NIC tables with explicit unknown capability evidence', () => {
    const source = page._mountDetail.toString();
    expect(source).toContain('totalDiskCapacityBytes');
    expect(source).toContain('connectDisconnect');
    expect(source).toContain("value === false ? 'Unsupported' : 'Unknown'");
    expect(source).not.toContain('nativeRef');
  });

  it('exposes migration preflight with release-gated execution controls', () => {
    const source = page._mountMigrationPreflight.toString();
    expect(source).toContain('getProviderVMMigrationPreflight');
    expect(source).toContain('Read-only evidence');
    expect(source).toContain('executionEnabled');
    expect(source).toContain('data-migrate-target');
    expect(page._runMigration.toString()).toContain('submitProviderVMMigration');
    expect(source).not.toContain('nativeRef');
  });

  it('wires blackout-aware scheduled VM actions with typed execute authorization', () => {
    const loader = page._loadActionSchedules.toString();
    const editor = page._editActionSchedule.toString();
    expect(loader).toContain('getProviderVMActionSchedules');
    expect(loader).toContain('runProviderVMActionSchedule');
    expect(loader).toContain('consecutiveFailures');
    expect(editor).toContain('dstPolicy');
    expect(editor).toContain('blackoutWindows');
    expect(editor).toContain('typeToConfirm: vm.displayName');
    expect(editor).toContain('Stop is a graceful guest shutdown');
  });

  it('renders safe host-maintenance plan/run evidence and wires persistent controls', () => {
    global.Utils = {
      escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
      statusBadgeClass: () => 'badge-secondary',
    };
    const html = page._maintenancePlanHtml({
      sourceHost: { displayName: '<source>' }, goal: 'drain', waveSize: 2,
      itemCount: 1, readyCount: 0, deferredCount: 1,
      blockers: [{ reason: '<blocked>' }], warnings: [],
      items: [{ vm: { displayName: '<vm>', powerState: 'running' }, target: null, mode: null, state: 'deferred', blockers: [{ reason: '<unsafe>' }] }],
    });
    expect(html).toContain('&lt;source&gt;');
    expect(html).toContain('&lt;unsafe&gt;');
    expect(html).not.toContain('<source>');
    expect(page._planHostMaintenance.toString()).toContain('preflightProviderHostMaintenance');
    expect(page._planHostMaintenance.toString()).toContain('startProviderHostMaintenance');
    const controls = page._manageHostMaintenance.toString();
    expect(controls).toContain('getProviderHostMaintenanceRuns');
    expect(controls).toContain('controlProviderHostMaintenance');
    expect(controls).toContain('Completed migrations stay on their targets');
    delete global.Utils;
  });

  it('normalizes saved inventory view state without sharing mutable arrays', () => {
    const view = {
      providerHostId: 7,
      filters: { query: 'prod', powerState: 'running' },
      columns: ['name', 'cpu'],
      sort: { field: 'cpu', direction: 'desc' },
    };
    const state = page._stateFromView(view);
    expect(state).toEqual({
      providerHostId: 7, query: 'prod', powerState: 'running',
      columns: ['name', 'cpu'], sort: { field: 'cpu', direction: 'desc' },
    });
    state.columns.push('memory');
    state.sort.direction = 'asc';
    expect(view.columns).toEqual(['name', 'cpu']);
    expect(view.sort.direction).toBe('desc');
  });

  it('builds the persisted VM view contract and includes versions only for updates', () => {
    page._viewState = {
      providerHostId: 4, query: 'db', powerState: 'stopped',
      columns: ['name', 'memory'], sort: { field: 'memory', direction: 'asc' },
    };
    expect(page._viewPayload('Databases', false)).toEqual({
      name: 'Databases', resourceType: 'virtual-machines', providerHostId: 4,
      filters: { query: 'db', powerState: 'stopped' },
      columns: ['name', 'memory'], sort: { field: 'memory', direction: 'asc' },
      isDefault: false,
    });
    expect(page._viewPayload('Databases', true, 3)).toEqual(expect.objectContaining({ version: 3, isDefault: true }));
    page._viewState = null;
  });

  it('sorts a copy of inventory deterministically and puts missing values last', () => {
    const items = [
      { displayName: 'small', spec: { cpuCount: 2 } },
      { displayName: 'unknown', spec: {} },
      { displayName: 'large', spec: { cpuCount: 8 } },
    ];
    expect(page._sortInventory(items, { field: 'cpu', direction: 'desc' }).map(item => item.displayName))
      .toEqual(['large', 'small', 'unknown']);
    expect(items.map(item => item.displayName)).toEqual(['small', 'unknown', 'large']);
  });
});
