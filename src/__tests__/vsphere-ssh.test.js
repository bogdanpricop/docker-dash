'use strict';

// v8.9.x-alpha — ESXi SSH telemetry parser tests.
//
// PURE PARSERS ONLY. No real SSH connection is ever opened here — every test
// feeds a fixture built from a real esxcli --formatter=json (or text) shape and
// asserts the parsed JS structure. Fixtures deliberately mix key casing/spacing
// (e.g. "ProductName" vs "Product Name", "SensorState" vs "State") to prove the
// tolerant pick() lookup holds across ESXi 6.7 / 7.0 / 8.0.

process.env.APP_SECRET = 'test-vsphere-ssh';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const vsphereSsh = require('../services/vsphere-ssh');
const { fromHostRow, CMD, _internals } = vsphereSsh;
const { encryptDaemonConfig } = require('../services/vsphere');

const {
  parseJson, pick, asArray, firstRow,
  parseVersion, parseHostname, parsePlatform, parseCpu, parseMemory, parseSystem,
  parseVibs, parseNics, parseSensors, _sensorSeverity,
  _validateSshConfig, _friendlySshError, _cmdError,
} = _internals;

describe('vsphere-ssh — command catalog', () => {
  it('every command is a static read-only esxcli JSON command', () => {
    for (const cmd of Object.values(CMD)) {
      expect(cmd).toMatch(/^esxcli --formatter=json /);
      // read-only: must end in a get or list verb, never a set/remove/etc.
      expect(cmd).toMatch(/\b(get|list)$/);
      expect(cmd).not.toMatch(/\b(set|remove|add|install|update|reboot|destroy)\b/);
    }
  });
});

describe('vsphere-ssh — fromHostRow', () => {
  it('rejects a non-vsphere row', () => {
    expect(() => fromHostRow({ daemon_type: 'docker' })).toThrow(/not a vSphere/);
  });

  it('throws when the vsphere host has no sshConfig', () => {
    const enc = encryptDaemonConfig({ endpoint: 'https://esxi', username: 'root', password: 'x' });
    expect(() => fromHostRow({ daemon_type: 'vsphere', daemon_config: enc })).toThrow(/sshConfig/);
  });

  it('returns a bound client when sshConfig is present', () => {
    const enc = encryptDaemonConfig({
      endpoint: 'https://esxi', username: 'root', password: 'x',
      sshConfig: { host: '10.0.0.5', user: 'root', privateKey: 'KEY' },
    });
    const client = fromHostRow({ daemon_type: 'vsphere', daemon_config: enc });
    expect(client.sshConfig).toMatchObject({ host: '10.0.0.5', user: 'root' });
    expect(typeof client.testSsh).toBe('function');
    expect(typeof client.collectAll).toBe('function');
  });
});

describe('vsphere-ssh — parseJson', () => {
  it('parses a JSON array string', () => {
    expect(parseJson('[{"Name":"vmnic0"}]')).toEqual([{ Name: 'vmnic0' }]);
  });
  it('passes through an already-parsed object', () => {
    const obj = { a: 1 };
    expect(parseJson(obj)).toBe(obj);
  });
  it('tolerates a leading shell banner before the JSON body', () => {
    const withBanner = 'Warning: something\n[{"Name":"vmnic1"}]';
    expect(parseJson(withBanner)).toEqual([{ Name: 'vmnic1' }]);
  });
  it('returns null for empty or non-JSON output', () => {
    expect(parseJson('')).toBeNull();
    expect(parseJson('not json at all')).toBeNull();
    expect(parseJson(null)).toBeNull();
  });
});

describe('vsphere-ssh — pick / asArray / firstRow', () => {
  it('pick matches keys case- and space-insensitively', () => {
    const row = { 'Product Name': 'PowerEdge', VendorName: 'Dell' };
    expect(pick(row, ['ProductName'])).toBe('PowerEdge');
    expect(pick(row, ['vendor', 'VendorName'])).toBe('Dell');
    expect(pick(row, ['missing'], 'dflt')).toBe('dflt');
  });
  it('pick returns falsy-but-present values (0/false) and skips empty strings', () => {
    const row = { Reading: 0, Enabled: false, Blank: '' };
    expect(pick(row, ['Reading'])).toBe(0);
    expect(pick(row, ['Enabled'])).toBe(false);
    expect(pick(row, ['Blank'], 'fallback')).toBe('fallback');
  });
  it('asArray wraps a single object; firstRow unwraps a one-element array', () => {
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(asArray([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(asArray(null)).toEqual([]);
    expect(firstRow([{ a: 1 }, { a: 2 }])).toEqual({ a: 1 });
    expect(firstRow({ a: 9 })).toEqual({ a: 9 });
    expect(firstRow(null)).toBeNull();
  });
});

describe('vsphere-ssh — system parsers', () => {
  it('parseVersion (array-wrapped, as esxcli returns it)', () => {
    const fixture = '[{"Build":"Releasebuild-17167734","Patch":"0","Product":"VMware ESXi","Update":"0","Version":"7.0.1"}]';
    expect(parseVersion(parseJson(fixture))).toEqual({
      product: 'VMware ESXi', version: '7.0.1', build: 'Releasebuild-17167734', update: '0', patch: '0',
    });
  });

  it('parseHostname', () => {
    const fixture = { DomainName: 'lab.local', FullyQualifiedDomainName: 'esxi01.lab.local', HostName: 'esxi01' };
    expect(parseHostname(fixture)).toEqual({ hostname: 'esxi01', fqdn: 'esxi01.lab.local', domain: 'lab.local' });
  });

  it('parsePlatform (CamelCase keys)', () => {
    const fixture = {
      ProductName: 'PowerEdge R640', VendorName: 'Dell Inc.', SerialNumber: 'ABC1234',
      UUID: '4c4c-1234', EnclosureSerialNumber: 'ENC1', IPMISupported: true,
    };
    expect(parsePlatform(fixture)).toEqual({
      vendor: 'Dell Inc.', model: 'PowerEdge R640', serial: 'ABC1234',
      uuid: '4c4c-1234', enclosureSerial: 'ENC1', ipmiSupported: true,
    });
  });

  it('parsePlatform (spaced keys — older ESXi text->json quirk)', () => {
    const fixture = { 'Product Name': 'HPE ProLiant DL380', 'Vendor Name': 'HPE', 'Serial Number': 'S1', 'IPMI Supported': 'true' };
    const p = parsePlatform(fixture);
    expect(p.model).toBe('HPE ProLiant DL380');
    expect(p.vendor).toBe('HPE');
    expect(p.serial).toBe('S1');
    expect(p.ipmiSupported).toBe(true);
  });

  it('parseCpu combines global counts with the list brand', () => {
    const global = { CPUCores: 20, CPUPackages: 2, CPUThreads: 40, HyperthreadingActive: true };
    const list = [{ Id: 0, Brand: 'Intel(R) Xeon(R) Gold 6230 CPU @ 2.10GHz' }, { Id: 1, Brand: 'x' }];
    expect(parseCpu(global, list)).toEqual({
      model: 'Intel(R) Xeon(R) Gold 6230 CPU @ 2.10GHz',
      cores: 20, threads: 40, packages: 2, hyperthreadingActive: true,
    });
  });

  it('parseMemory extracts PhysicalMemory bytes (tolerating a "Bytes" suffix)', () => {
    expect(parseMemory({ NUMANodeCount: 2, PhysicalMemory: 137397563392 }))
      .toEqual({ memoryBytes: 137397563392, numaNodes: 2 });
    expect(parseMemory({ 'Physical Memory': '68719476736 Bytes', 'NUMA Node Count': 1 }))
      .toEqual({ memoryBytes: 68719476736, numaNodes: 1 });
  });

  it('parseSystem composes the full card', () => {
    const sys = parseSystem({
      version: [{ Product: 'VMware ESXi', Version: '8.0.0', Build: 'Releasebuild-20513097' }],
      hostname: { HostName: 'esxi01', FullyQualifiedDomainName: 'esxi01.lab.local', DomainName: 'lab.local' },
      platform: { ProductName: 'PowerEdge R640', VendorName: 'Dell Inc.', SerialNumber: 'ABC1234' },
      cpuGlobal: { CPUCores: 20, CPUThreads: 40, CPUPackages: 2 },
      cpuList: [{ Brand: 'Intel Xeon Gold 6230' }],
      memory: { PhysicalMemory: 137397563392 },
    });
    expect(sys).toMatchObject({
      version: '8.0.0', product: 'VMware ESXi', hostname: 'esxi01', fqdn: 'esxi01.lab.local',
      platform: { vendor: 'Dell Inc.', model: 'PowerEdge R640', serial: 'ABC1234' },
      cpu: { model: 'Intel Xeon Gold 6230', cores: 20, threads: 40, packages: 2 },
      memoryBytes: 137397563392,
    });
  });

  it('parseSystem returns null when every sub-command failed', () => {
    expect(parseSystem({})).toBeNull();
    expect(parseSystem({ version: null, hostname: null, platform: null, cpuGlobal: null, cpuList: null, memory: null })).toBeNull();
  });
});

describe('vsphere-ssh — parseVibs', () => {
  it('maps VIB rows', () => {
    const fixture = JSON.stringify([
      {
        AcceptanceLevel: 'VMwareCertified', CreationDate: '2020-10-22',
        ID: 'VMware_bootbank_vsan_7.0.1-0.0.16850804', InstallDate: '2021-01-15',
        Name: 'vsan', Status: '', Vendor: 'VMW', Version: '7.0.1-0.0.16850804',
      },
      {
        AcceptanceLevel: 'PartnerSupported', CreationDate: '2021-02-01',
        ID: 'DEL_bootbank_dell-configuration-vib', InstallDate: '2021-02-02',
        Name: 'dell-configuration-vib', Vendor: 'DEL', Version: '1.0',
      },
    ]);
    const vibs = parseVibs(parseJson(fixture));
    expect(vibs).toHaveLength(2);
    expect(vibs[0]).toEqual({
      name: 'vsan', version: '7.0.1-0.0.16850804', vendor: 'VMW',
      acceptanceLevel: 'VMwareCertified', installDate: '2021-01-15',
      creationDate: '2020-10-22', id: 'VMware_bootbank_vsan_7.0.1-0.0.16850804',
    });
    expect(vibs[1].name).toBe('dell-configuration-vib');
  });

  it('drops rows with no name', () => {
    expect(parseVibs([{ Version: '1.0' }, { Name: 'ok', Version: '2.0' }])).toHaveLength(1);
  });
});

describe('vsphere-ssh — parseNics', () => {
  it('maps NIC rows with numeric speed', () => {
    const fixture = JSON.stringify([{
      AdminStatus: 'Up', Description: 'Intel(R) Ethernet Controller X710', Driver: 'i40en',
      Duplex: 'Full', Link: 'Up', LinkStatus: 'Up', MACAddress: '00:11:22:33:44:55',
      MTU: 1500, Name: 'vmnic0', PCIDevice: '0000:19:00.0', Speed: 10000,
    }]);
    const nics = parseNics(parseJson(fixture));
    expect(nics).toHaveLength(1);
    expect(nics[0]).toEqual({
      name: 'vmnic0', driver: 'i40en', link: 'Up', speedMbps: 10000, duplex: 'Full',
      mac: '00:11:22:33:44:55', description: 'Intel(R) Ethernet Controller X710',
      mtu: 1500, pciDevice: '0000:19:00.0', adminStatus: 'Up',
    });
  });

  it('handles a down NIC (speed 0)', () => {
    const nics = parseNics([{ Name: 'vmnic1', Driver: 'ne1000', Link: 'Down', Speed: 0, Duplex: 'Half' }]);
    expect(nics[0]).toMatchObject({ name: 'vmnic1', link: 'Down', speedMbps: 0 });
  });
});

describe('vsphere-ssh — parseSensors', () => {
  const fixture = JSON.stringify([
    { Name: 'Fan1', SensorType: 'Fan', Reading: 4560, Units: 'RPM', SensorState: 'Normal' },
    { Name: 'Fan2', SensorType: 'Fan', Reading: 0, Units: 'RPM', SensorState: 'Critical' },
    { Name: 'Inlet Temp', SensorType: 'Temperature', Reading: 22, Units: 'Celsius', SensorState: 'Normal' },
    { Name: 'CPU1 Voltage', SensorType: 'Voltage', Reading: 1.2, Units: 'Volts', SensorState: 'Normal' },
    { Name: 'PS1 Status', SensorType: 'Power Supply', Reading: 120, Units: 'Watts', SensorState: 'Normal' },
    { Name: 'System Board 1', SensorType: 'System Event', Reading: null, Units: '', SensorState: 'Normal' },
  ]);

  it('buckets sensors by type', () => {
    const s = parseSensors(parseJson(fixture));
    expect(s.fans).toHaveLength(2);
    expect(s.temperatures).toHaveLength(1);
    expect(s.voltages).toHaveLength(1);
    expect(s.powerSupplies).toHaveLength(1);
    expect(s.other).toHaveLength(1);
    expect(s.fans[0]).toMatchObject({ name: 'Fan1', reading: 4560, units: 'RPM', severity: 'ok' });
  });

  it('computes overall health from sensor states', () => {
    const s = parseSensors(parseJson(fixture));
    expect(s.overall.total).toBe(6);
    expect(s.overall.healthy).toBe(false);
    expect(s.overall.status).toBe('red');
    expect(s.overall.degraded).toContain('Fan2');
  });

  it('reports green when all sensors are normal', () => {
    const s = parseSensors([
      { Name: 'Fan1', SensorType: 'Fan', Reading: 3000, SensorState: 'Normal' },
      { Name: 'Temp', SensorType: 'Temperature', Reading: 30, SensorState: 'ok' },
    ]);
    expect(s.overall.status).toBe('green');
    expect(s.overall.healthy).toBe(true);
    expect(s.overall.degraded).toEqual([]);
  });

  it('reports yellow when the worst sensor is a warning', () => {
    const s = parseSensors([
      { Name: 'Fan1', SensorType: 'Fan', Reading: 1200, SensorState: 'Warning' },
      { Name: 'Temp', SensorType: 'Temperature', Reading: 30, SensorState: 'Normal' },
    ]);
    expect(s.overall.status).toBe('yellow');
  });

  it('unknown when there are no sensor records (consumer hardware / no BMC)', () => {
    const s = parseSensors([]);
    expect(s.overall).toMatchObject({ total: 0, status: 'unknown', healthy: false });
  });

  it('tolerates alternate key names (SensorName / Type / SensorReading / State)', () => {
    const s = parseSensors([{ SensorName: 'Fan3', Type: 'Fan', SensorReading: '3000 RPM', State: 'ok' }]);
    expect(s.fans).toHaveLength(1);
    expect(s.fans[0]).toMatchObject({ name: 'Fan3', reading: 3000, severity: 'ok' });
  });
});

describe('vsphere-ssh — _sensorSeverity', () => {
  it('classifies states', () => {
    expect(_sensorSeverity('Normal')).toBe('ok');
    expect(_sensorSeverity('ok')).toBe('ok');
    expect(_sensorSeverity('Critical')).toBe('critical');
    expect(_sensorSeverity('Non-Recoverable')).toBe('critical');
    expect(_sensorSeverity('Warning')).toBe('warning');
    expect(_sensorSeverity('')).toBe('unknown');
    expect(_sensorSeverity(null)).toBe('unknown');
  });
});

describe('vsphere-ssh — error mapping', () => {
  it('_validateSshConfig rejects a missing config and missing fields', () => {
    expect(() => _validateSshConfig(null)).toThrow(/sshConfig/);
    expect(() => _validateSshConfig({ host: 'h' })).toThrow(/host, user/);
    expect(() => _validateSshConfig({ host: 'h', user: 'root' })).toThrow(/privateKey or password/);
    expect(() => _validateSshConfig({ host: 'h', user: 'root', password: 'p' })).not.toThrow();
  });

  it('_friendlySshError maps connection refused to "SSH not enabled"', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(_friendlySshError(err, { host: '10.0.0.5', port: 22 }).message).toMatch(/SSH not enabled/i);
  });

  it('_friendlySshError maps unreachable + auth failures', () => {
    expect(_friendlySshError(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }), { host: 'h' }).message).toMatch(/unreachable/i);
    expect(_friendlySshError(new Error('All configured authentication methods failed'), { host: 'h', user: 'root' }).message).toMatch(/authentication failed/i);
  });

  it('_cmdError flags "esxcli not found" as unavailable', () => {
    expect(_cmdError('esxcli ...', 127, 'sh: esxcli: not found').message).toMatch(/unavailable/i);
    expect(_cmdError('esxcli ...', 1, 'Permission denied').message).toMatch(/Permission denied/i);
    expect(_cmdError('esxcli ...', 2, '').message).toMatch(/exited 2/);
  });
});
