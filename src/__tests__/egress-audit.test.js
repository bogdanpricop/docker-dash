'use strict';

// Unit tests for src/services/egress-audit.js — pure-function classifier.

const { analyzeContainer } = require('../services/egress-audit');

const makeInspect = (over = {}) => ({
  HostConfig: {
    NetworkMode: 'bridge',
    ExtraHosts: [],
    Dns: [],
    CapAdd: [],
    CapDrop: ['NET_RAW'],
    ...over.HostConfig,
  },
  NetworkSettings: {
    Networks: { bridge: { Gateway: '172.17.0.1', IPAddress: '172.17.0.2' } },
    ...over.NetworkSettings,
  },
  Config: { Labels: {} },
});

const makeNetMap = (entries) => {
  const m = new Map();
  for (const [name, data] of Object.entries(entries)) m.set(name, data);
  return m;
};

describe('egress-audit — analyzeContainer', () => {
  describe('network_mode: host', () => {
    it('flags host mode as critical, all reachability true', () => {
      const r = analyzeContainer(
        makeInspect({ HostConfig: { NetworkMode: 'host' } }),
        makeNetMap({})
      );
      expect(r.networkMode).toBe('host');
      expect(r.canReachInternet).toBe(true);
      expect(r.canReachIMDS).toBe(true);
      expect(r.canReachRFC1918).toBe(true);
      expect(r.findings.some(f => f.severity === 'critical' && /host network mode/.test(f.message))).toBe(true);
      expect(r.score).toBeLessThan(80);
    });
  });

  describe('network_mode: none', () => {
    it('reports isolated, no reachability, score stays high', () => {
      const r = analyzeContainer(
        makeInspect({
          HostConfig: { NetworkMode: 'none' },
          NetworkSettings: { Networks: {} },
        }),
        makeNetMap({})
      );
      expect(r.networkMode).toBe('none');
      expect(r.canReachInternet).toBe(false);
      expect(r.canReachIMDS).toBe(false);
      expect(r.score).toBe(100);
    });
  });

  describe('default bridge (Docker default)', () => {
    it('flags internet + IMDS reachable, warns but does not mark critical', () => {
      const r = analyzeContainer(
        makeInspect({}),
        makeNetMap({ bridge: { Name: 'bridge', Driver: 'bridge', Internal: false } })
      );
      expect(r.canReachInternet).toBe(true);
      expect(r.canReachIMDS).toBe(true);
      expect(r.findings.some(f => f.severity === 'warning' && /internet/.test(f.message))).toBe(true);
      expect(r.findings.some(f => f.severity === 'critical')).toBe(false);
      expect(r.score).toBeLessThan(100);
      expect(r.score).toBeGreaterThanOrEqual(60);
    });
  });

  describe('user-defined internal network', () => {
    it('reports isolated when only attached to --internal networks', () => {
      const r = analyzeContainer(
        makeInspect({
          HostConfig: { NetworkMode: 'internal-net' },
          NetworkSettings: { Networks: { 'internal-net': { Gateway: '', IPAddress: '10.1.0.2' } } },
        }),
        makeNetMap({ 'internal-net': { Name: 'internal-net', Driver: 'bridge', Internal: true } })
      );
      expect(r.canReachInternet).toBe(false);
      expect(r.canReachIMDS).toBe(false);
      expect(r.findings.some(f => f.severity === 'info' && /internal networks/.test(f.message))).toBe(true);
      expect(r.score).toBe(100);
    });
  });

  describe('mixed: one internal + one public bridge', () => {
    it('still flags internet-reachable (any non-internal is enough)', () => {
      const r = analyzeContainer(
        makeInspect({
          NetworkSettings: {
            Networks: {
              'db-net': { Gateway: '', IPAddress: '10.1.0.2' },
              'web-net': { Gateway: '172.20.0.1', IPAddress: '172.20.0.3' },
            },
          },
        }),
        makeNetMap({
          'db-net': { Name: 'db-net', Driver: 'bridge', Internal: true },
          'web-net': { Name: 'web-net', Driver: 'bridge', Internal: false },
        })
      );
      expect(r.canReachInternet).toBe(true);
      expect(r.canReachIMDS).toBe(true);
    });
  });

  describe('extra_hosts IMDS pin', () => {
    it('flags extra_hosts that pin a name to 169.254.169.254 as critical', () => {
      const r = analyzeContainer(
        makeInspect({ HostConfig: { ExtraHosts: ['metadata:169.254.169.254'] } }),
        makeNetMap({ bridge: { Name: 'bridge', Driver: 'bridge', Internal: false } })
      );
      expect(r.findings.some(f => f.severity === 'critical' && /extra_hosts/.test(f.message))).toBe(true);
      expect(r.score).toBeLessThan(70);
    });

    it('ignores benign extra_hosts entries', () => {
      const r = analyzeContainer(
        makeInspect({ HostConfig: { ExtraHosts: ['myhost:10.0.0.5'] } }),
        makeNetMap({ bridge: { Name: 'bridge', Driver: 'bridge', Internal: false } })
      );
      expect(r.findings.some(f => /extra_hosts.*IMDS/.test(f.message))).toBe(false);
    });
  });

  describe('NET_ADMIN / NET_RAW capability', () => {
    it.each([null, [], ['CHOWN']])('flags default NET_RAW when CapDrop is %j', CapDrop => {
      const result = analyzeContainer(makeInspect({ HostConfig: { CapDrop } }), makeNetMap({}));
      expect(result.findings.some(f => f.severity === 'warning' && /NET_RAW/.test(f.message))).toBe(true);
    });
    it.each(['CAP_NET_RAW', 'net_raw', 'ALL'])('flags re-added %s after dropping ALL', cap => {
      const result = analyzeContainer(makeInspect({ HostConfig: { CapDrop: ['ALL'], CapAdd: [cap] } }), makeNetMap({}));
      expect(result.findings.some(f => /NET_RAW/.test(f.message))).toBe(true);
    });
    it('flags NET_ADMIN as a warning', () => {
      const r = analyzeContainer(
        makeInspect({ HostConfig: { CapAdd: ['NET_ADMIN'] } }),
        makeNetMap({ bridge: { Name: 'bridge', Driver: 'bridge', Internal: false } })
      );
      expect(r.findings.some(f => f.severity === 'warning' && /NET_ADMIN/.test(f.message))).toBe(true);
    });

    it('does not flag generic CapAdd like SYS_NICE', () => {
      const r = analyzeContainer(
        makeInspect({ HostConfig: { CapAdd: ['SYS_NICE'] } }),
        makeNetMap({ bridge: { Name: 'bridge', Driver: 'bridge', Internal: false } })
      );
      expect(r.findings.some(f => /NET_ADMIN|NET_RAW/.test(f.message))).toBe(false);
    });
  });

  describe('custom DNS', () => {
    it('surfaces custom DNS as info, does not reduce score', () => {
      const r1 = analyzeContainer(
        makeInspect({}),
        makeNetMap({ bridge: { Name: 'bridge', Driver: 'bridge', Internal: false } })
      );
      const r2 = analyzeContainer(
        makeInspect({ HostConfig: { Dns: ['8.8.8.8'] } }),
        makeNetMap({ bridge: { Name: 'bridge', Driver: 'bridge', Internal: false } })
      );
      expect(r2.findings.some(f => f.severity === 'info' && /Custom DNS/.test(f.message))).toBe(true);
      expect(r2.score).toBe(r1.score); // DNS by itself doesn't reduce score
    });
  });

  describe('network_mode: container:<id>', () => {
    it('reports neutral (inherits parent container posture)', () => {
      const r = analyzeContainer(
        makeInspect({
          HostConfig: { NetworkMode: 'container:abc123' },
          NetworkSettings: { Networks: {} },
        }),
        makeNetMap({})
      );
      expect(r.networkMode).toBe('container:abc123');
      expect(r.findings.some(f => f.severity === 'info' && /Shares network namespace/.test(f.message))).toBe(true);
    });
  });
});
