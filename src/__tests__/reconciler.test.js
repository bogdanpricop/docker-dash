'use strict';

const reconciler = require('../services/reconciler');
const { _ruleKey, _diff } = reconciler._internals;

describe('reconciler rule identity + diff', () => {
  test('key is uuid/backend-independent and normalizes defaults', () => {
    expect(_ruleKey({ scope: 'host', action: 'allow', destination_port: 443, protocol: 'tcp' }))
      .toBe(_ruleKey({ scope: 'host', action: 'allow', destination_port: 443 })); // protocol defaults to tcp
    expect(_ruleKey({ scope: 'host', action: 'allow', source_ip: '1.2.3.4' }))
      .not.toBe(_ruleKey({ scope: 'host', action: 'allow', source_ip: '5.6.7.8' }));
  });

  test('diff: create missing, remove extras, keep in-sync', () => {
    const desired = [
      { scope: 'host', action: 'allow', destination_port: 443, protocol: 'tcp' },   // in sync
      { scope: 'docker', action: 'allow', source_ip: '9.9.9.9', destination_port: 8082, protocol: 'tcp' }, // to create
    ];
    const actual = [
      { rule_uuid: 'u1', scope: 'host', action: 'allow', destination_port: 443, protocol: 'tcp' }, // in sync
      { rule_uuid: 'u2', scope: 'host', action: 'block', source_ip: '6.6.6.6', protocol: 'tcp' },  // to remove
    ];
    const d = _diff(desired, actual);
    expect(d.toCreate).toHaveLength(1);
    expect(d.toCreate[0].source_ip).toBe('9.9.9.9');
    expect(d.toRemove).toHaveLength(1);
    expect(d.toRemove[0].rule_uuid).toBe('u2');
    expect(d.inSync).toHaveLength(1);
  });

  test('empty desired removes all actual; empty actual creates all desired', () => {
    const rule = { scope: 'host', action: 'allow', destination_port: 22, protocol: 'tcp' };
    expect(_diff([], [{ rule_uuid: 'x', ...rule }]).toRemove).toHaveLength(1);
    expect(_diff([rule], []).toCreate).toHaveLength(1);
  });
});

describe('reconciler validateDoc', () => {
  test('accepts a valid doc and normalizes rules', () => {
    const out = reconciler.validateDoc({ version: 1, hosts: { 2: { firewall: [{ action: 'allow', scope: 'host', destination_port: '443' }] } } });
    expect(out.kind).toBe('estate-blueprint');
    expect(out.hosts['2'].firewall[0]).toMatchObject({ action: 'allow', scope: 'host', destination_port: 443, protocol: 'tcp' });
  });
  test('rejects wrong version', () => {
    expect(() => reconciler.validateDoc({ version: 2, hosts: {} })).toThrow(/version/);
  });
  test('rejects a bad rule with per-rule context', () => {
    expect(() => reconciler.validateDoc({ version: 1, hosts: { 3: { firewall: [{ action: 'nuke', scope: 'host', destination_port: 22 }] } } }))
      .toThrow(/host 3 firewall\[0\]/);
  });
  test('accepts container ensure-running and rejects bad container name/state', () => {
    const out = reconciler.validateDoc({ version: 1, hosts: { 2: { containers: [{ name: 'web-1', state: 'running' }] } } });
    expect(out.hosts['2'].containers).toEqual([{ name: 'web-1', state: 'running' }]);
    expect(() => reconciler.validateDoc({ version: 1, hosts: { 2: { containers: [{ name: 'bad name!', state: 'running' }] } } })).toThrow(/invalid name/);
    expect(() => reconciler.validateDoc({ version: 1, hosts: { 2: { containers: [{ name: 'web', state: 'stopped' }] } } })).toThrow(/only state "running"/);
  });
});
