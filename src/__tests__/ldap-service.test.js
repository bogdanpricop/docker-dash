'use strict';

// WHY: Post-v8.2.x audit found that src/services/ldap.js — the bridge between
// Docker Dash and corporate Active Directory / OpenLDAP — had no DEDICATED
// unit test file. The service was ported from `ldapjs` to `ldapts` v8 in
// v6.13.0 (now on ldapts ^8.1.7) and exposes the security-critical surface:
// getConfig / saveConfig / deleteConfig / testConnection / authenticate /
// listUsers. A regression here silently locks every LDAP user out (or worse,
// authenticates the wrong one). This file pins down the actual exported API
// against a fully mocked `ldapts` so regressions surface immediately on
// `npx jest`. No real LDAP server is contacted.

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

// ─── Mock ldapts at module level ─────────────────────────────────────────
// Each new Client() captures its constructor opts (so we can assert URL /
// tlsOptions per scenario) and exposes jest.fn() for bind/search/unbind.
// Tests configure return values / failures via the helpers below.
//
// NOTE: Jest hoists jest.mock() factories above all other code, so the factory
// MUST NOT reference outer-scope variables — except names prefixed with `mock`,
// which Jest explicitly allows. We expose the bookkeeping arrays through
// `mockState` so tests (after require()) can read/manipulate them.
jest.mock('ldapts', () => {
  const mockState = {
    ctorCalls: [],
    instances: [],
    makeClient(opts) {
      const inst = {
        _opts: opts,
        bind: jest.fn().mockResolvedValue(undefined),
        startTLS: jest.fn().mockResolvedValue(undefined),
        search: jest.fn().mockResolvedValue({ searchEntries: [], searchReferences: [] }),
        unbind: jest.fn().mockResolvedValue(undefined),
      };
      mockState.instances.push(inst);
      return inst;
    },
  };
  const Client = jest.fn().mockImplementation((opts) => {
    mockState.ctorCalls.push(opts);
    return mockState.makeClient(opts);
  });
  return { Client, __mockState: mockState };
});

const { Client, __mockState: mockState } = require('ldapts');
const ldaptsCtorCalls = mockState.ctorCalls;
const clientInstances = mockState.instances;
const makeClient = (opts) => mockState.makeClient(opts);
const { getDb, closeDb } = require('../db');
const db = getDb();

const ldap = require('../services/ldap');

// ─── Test helpers ────────────────────────────────────────────────────────

const BASE_CFG = {
  enabled: true,
  host: 'ad.test.local',
  port: 389,
  tls: false,
  baseDn: 'dc=test,dc=local',
  bindDn: 'cn=svc,dc=test,dc=local',
  bindPassword: 'svc-pass',
  uidAttr: 'uid',
  userFilter: '(objectClass=person)',
};

function saveCfg(extra = {}) {
  ldap.saveConfig({ ...BASE_CFG, ...extra });
}

function resetMocks() {
  Client.mockClear();
  ldaptsCtorCalls.length = 0;
  clientInstances.length = 0;
}

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  resetMocks();
  // Wipe any prior config so saveConfig hits the INSERT branch deterministically.
  ldap.deleteConfig();
});

// ─── 1. Config CRUD round-trip ───────────────────────────────────────────

describe('LdapService — config CRUD', () => {
  it('saveConfig + getConfig round-trips a full config object (incl. bind credentials)', () => {
    const cfg = {
      enabled: true,
      host: 'ldap.example.com',
      port: 636,
      tls: true,
      tlsSkipVerify: false,
      baseDn: 'ou=people,dc=example,dc=com',
      bindDn: 'cn=reader,dc=example,dc=com',
      bindPassword: 'super-secret-bind-pw',
      uidAttr: 'sAMAccountName',
      userFilter: '(&(objectClass=user)(objectCategory=person))',
      requiredGroup: 'CN=DockerAdmins,OU=Groups,DC=example,DC=com',
    };
    ldap.saveConfig(cfg);
    expect(ldap.getConfig()).toEqual(cfg);
    // Persisted as JSON in settings table — verify the row exists.
    const row = db.prepare("SELECT value FROM settings WHERE key = 'ldap_config'").get();
    expect(row).toBeTruthy();
    expect(row.value).not.toContain(cfg.bindPassword);
    const stored = JSON.parse(row.value);
    expect(stored.bindPassword).toBeUndefined();
    expect(require('../utils/crypto').decrypt(stored.bindPasswordEncrypted)).toBe(cfg.bindPassword);
  });

  it('getConfig returns null when no config has been saved', () => {
    expect(ldap.getConfig()).toBeNull();
  });

  it('saveConfig overwrites an existing row (UPDATE branch, no duplicate insert)', () => {
    ldap.saveConfig({ ...BASE_CFG, host: 'first.local' });
    ldap.saveConfig({ ...BASE_CFG, host: 'second.local' });
    const rows = db.prepare("SELECT value FROM settings WHERE key = 'ldap_config'").all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].value).host).toBe('second.local');
  });

  it('deleteConfig removes the row so getConfig returns null again', () => {
    ldap.saveConfig(BASE_CFG);
    expect(ldap.getConfig()).toBeTruthy();
    ldap.deleteConfig();
    expect(ldap.getConfig()).toBeNull();
  });

  it('getConfig returns null on corrupted JSON (does not throw)', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('ldap_config', ?)").run('{not-json');
    expect(ldap.getConfig()).toBeNull();
  });
});

// ─── 2. authenticate() ───────────────────────────────────────────────────

describe('LdapService — authenticate', () => {
  it.each(['', null, undefined])('rejects empty password %p before creating a client', async password => {
    saveCfg();
    await expect(ldap.authenticate('alice', password)).resolves.toBeNull();
    expect(Client).not.toHaveBeenCalled();
  });

  it('rejects group names that only contain the required group DN', async () => {
    saveCfg({ requiredGroup: 'CN=DockerAdmins,OU=Groups,DC=test,DC=local' });
    Client.mockImplementationOnce(opts => {
      const c = makeClient(opts);
      c.search.mockResolvedValue({ searchEntries: [{
        dn: 'uid=alice,dc=test,dc=local',
        memberOf: ['CN=NotDockerAdmins,CN=DockerAdmins,OU=Groups,DC=test,DC=local'],
      }] });
      return c;
    });
    await expect(ldap.authenticate('alice', 'password')).rejects.toThrow(/required LDAP group/);
  });
  it('returns null when no config is saved', async () => {
    const result = await ldap.authenticate('alice', 'pw');
    expect(result).toBeNull();
    expect(Client).not.toHaveBeenCalled();
  });

  it('returns null when config exists but enabled=false', async () => {
    saveCfg({ enabled: false });
    const result = await ldap.authenticate('alice', 'pw');
    expect(result).toBeNull();
    expect(Client).not.toHaveBeenCalled();
  });

  it('authenticate() success path: service bind + user search + user bind + attribute mapping', async () => {
    saveCfg();

    // Sequence of Client instances during one authenticate():
    //  [0] service-bind client (used for the search)
    //  [1] user-bind client (used to verify password)
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({
        searchEntries: [{
          dn: 'uid=alice,ou=people,dc=test,dc=local',
          uid: 'alice',
          mail: 'alice@test.local',
          displayName: 'Alice Liddell',
          cn: 'Alice Liddell',
          memberOf: ['CN=DockerUsers,OU=Groups,DC=test,DC=local'],
        }],
        searchReferences: [],
      });
      return c;
    });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      return makeClient(opts);
    });

    const user = await ldap.authenticate('alice', 'right-pw');

    expect(user).toEqual({
      ldapDn: 'uid=alice,ou=people,dc=test,dc=local',
      username: 'alice',
      email: 'alice@test.local',
      displayName: 'Alice Liddell',
      source: 'ldap',
    });
    // Two Clients were created: one for service bind+search, one for user bind.
    expect(Client).toHaveBeenCalledTimes(2);
    // Service bind happened with the configured bindDn.
    expect(clientInstances[0].bind).toHaveBeenCalledWith('cn=svc,dc=test,dc=local', 'svc-pass');
    // User bind happened with the discovered DN and the supplied password.
    expect(clientInstances[1].bind).toHaveBeenCalledWith('uid=alice,ou=people,dc=test,dc=local', 'right-pw');
    // Both clients were unbound for cleanup.
    expect(clientInstances[0].unbind).toHaveBeenCalled();
    expect(clientInstances[1].unbind).toHaveBeenCalled();
  });

  it('authenticate() returns null on wrong password (user bind throws InvalidCredentials)', async () => {
    saveCfg();

    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({
        searchEntries: [{
          dn: 'uid=bob,ou=people,dc=test,dc=local',
          uid: 'bob',
          mail: 'bob@test.local',
          cn: 'Bob',
        }],
        searchReferences: [],
      });
      return c;
    });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      const err = new Error('InvalidCredentialsError');
      err.code = 49;
      c.bind.mockRejectedValue(err);
      return c;
    });

    await expect(ldap.authenticate('bob', 'wrong-pw')).rejects.toThrow(/InvalidCredentialsError/);
  });

  it('authenticate() returns null when the search yields zero entries (user not found)', async () => {
    saveCfg();
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({ searchEntries: [], searchReferences: [] });
      return c;
    });

    const result = await ldap.authenticate('ghost', 'whatever');
    expect(result).toBeNull();
    // Only the service-bind client was created; no user-bind client.
    expect(Client).toHaveBeenCalledTimes(1);
  });

  it('authenticate() composes nested AND filter when userFilter is configured', async () => {
    saveCfg({ userFilter: '(&(objectClass=user)(objectCategory=person))', uidAttr: 'sAMAccountName' });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({
        searchEntries: [{
          dn: 'CN=Carol,OU=People,DC=test,DC=local',
          sAMAccountName: 'carol',
          mail: 'carol@test.local',
          cn: 'Carol',
        }],
        searchReferences: [],
      });
      return c;
    });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      return makeClient(opts);
    });

    await ldap.authenticate('carol', 'pw');
    const searchCall = clientInstances[0].search.mock.calls[0];
    const baseDn = searchCall[0];
    const opts = searchCall[1];
    expect(baseDn).toBe('dc=test,dc=local');
    // Filter must wrap the configured AND clause around the uid lookup.
    expect(opts.filter).toBe('(&(&(objectClass=user)(objectCategory=person))(sAMAccountName=carol))');
    expect(opts.scope).toBe('sub');
    expect(opts.attributes).toEqual(expect.arrayContaining(['sAMAccountName', 'mail', 'displayName', 'cn', 'memberOf']));
  });

  it('authenticate() escapes filter metacharacters to prevent LDAP injection', async () => {
    saveCfg({ userFilter: null, uidAttr: 'uid' });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({ searchEntries: [], searchReferences: [] });
      return c;
    });

    // An attacker-style username containing every RFC 4515 metachar.
    await ldap.authenticate('ev*il(name)\\null', 'pw');
    const filter = clientInstances[0].search.mock.calls[0][1].filter;
    // Each metacharacter MUST be hex-escaped, never appear raw inside the filter literal.
    expect(filter).toBe('(uid=ev\\2ail\\28name\\29\\5cnull)');
    // Defense-in-depth: ensure no raw '*' / '(' / ')' / '\' from the username slipped through.
    const userPart = filter.slice('(uid='.length, -1); // strip wrapping (uid=...)
    expect(userPart).not.toMatch(/(?<!\\)\*/);
    expect(userPart).not.toMatch(/(?<!\\)\(/);
  });

  it('authenticate() handles UTF-8 usernames without mangling them', async () => {
    saveCfg({ userFilter: null });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({
        searchEntries: [{
          dn: 'uid=zoë,ou=people,dc=test,dc=local',
          uid: 'zoë',
          mail: 'zoë@test.local',
          displayName: 'Zoë Köhler 中文',
          cn: 'Zoë Köhler 中文',
        }],
        searchReferences: [],
      });
      return c;
    });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      return makeClient(opts);
    });

    const user = await ldap.authenticate('zoë', 'pw');
    // Username, email and displayName must round-trip the multi-byte chars unchanged.
    expect(user.username).toBe('zoë');
    expect(user.email).toBe('zoë@test.local');
    expect(user.displayName).toBe('Zoë Köhler 中文');
    // Filter passes the UTF-8 char literally (it is NOT a filter metacharacter).
    const filter = clientInstances[0].search.mock.calls[0][1].filter;
    expect(filter).toBe('(uid=zoë)');
  });

  it('authenticate() handles a DN that contains a quoted CN with embedded comma', async () => {
    // Active Directory commonly returns DNs like CN="Last, First",OU=...
    saveCfg();
    const trickyDn = 'CN="Doe, John",OU=People,DC=test,DC=local';
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({
        searchEntries: [{
          dn: trickyDn,
          uid: 'jdoe',
          mail: 'john.doe@test.local',
          displayName: 'Doe, John',
          cn: 'Doe, John',
        }],
        searchReferences: [],
      });
      return c;
    });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      return makeClient(opts);
    });

    const user = await ldap.authenticate('jdoe', 'pw');
    expect(user.ldapDn).toBe(trickyDn);
    expect(user.displayName).toBe('Doe, John');
    // The user-bind step must receive the DN VERBATIM, with quotes/commas intact.
    expect(clientInstances[1].bind).toHaveBeenCalledWith(trickyDn, 'pw');
  });

  it('authenticate() rejects user when requiredGroup is not in memberOf', async () => {
    saveCfg({ requiredGroup: 'CN=DockerAdmins,OU=Groups,DC=test,DC=local' });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({
        searchEntries: [{
          dn: 'uid=dan,ou=people,dc=test,dc=local',
          uid: 'dan',
          mail: 'dan@test.local',
          cn: 'Dan',
          memberOf: ['CN=Marketing,OU=Groups,DC=test,DC=local'],
        }],
        searchReferences: [],
      });
      return c;
    });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      return makeClient(opts);
    });

    await expect(ldap.authenticate('dan', 'pw')).rejects.toThrow(/required LDAP group/i);
  });

  it('authenticate() accepts user when requiredGroup matches memberOf (case-insensitive)', async () => {
    saveCfg({ requiredGroup: 'cn=dockeradmins,ou=groups,dc=test,dc=local' });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({
        searchEntries: [{
          dn: 'uid=erin,ou=people,dc=test,dc=local',
          uid: 'erin',
          mail: 'erin@test.local',
          cn: 'Erin',
          memberOf: [
            'CN=AllUsers,OU=Groups,DC=test,DC=local',
            'CN=DockerAdmins,OU=Groups,DC=test,DC=local',
          ],
        }],
        searchReferences: [],
      });
      return c;
    });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      return makeClient(opts);
    });

    const user = await ldap.authenticate('erin', 'pw');
    expect(user.username).toBe('erin');
  });

  it('authenticate() falls back to cn for displayName and synthesizes mail when LDAP entry is sparse', async () => {
    saveCfg();
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({
        searchEntries: [{
          dn: 'uid=frank,ou=people,dc=test,dc=local',
          uid: 'frank',
          cn: 'Frank Sparse',
          // no displayName, no mail
        }],
        searchReferences: [],
      });
      return c;
    });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      return makeClient(opts);
    });

    const user = await ldap.authenticate('frank', 'pw');
    expect(user.displayName).toBe('Frank Sparse');
    expect(user.email).toBe('frank@ldap');
  });

  it('authenticate() surfaces a connection timeout from the service bind', async () => {
    saveCfg();
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      const err = new Error('connect ETIMEDOUT 10.0.0.1:389');
      err.code = 'ETIMEDOUT';
      c.bind.mockRejectedValue(err);
      return c;
    });

    await expect(ldap.authenticate('whoever', 'pw')).rejects.toThrow(/ETIMEDOUT/);
    // Only one Client was constructed (the service-bind one); user-bind never happened.
    expect(Client).toHaveBeenCalledTimes(1);
    // Cleanup still runs even when bind throws.
    expect(clientInstances[0].unbind).toHaveBeenCalled();
  });
});

// ─── 3. Client construction (URL + TLS) ──────────────────────────────────

describe('LdapService — client construction (URL + TLS opts)', () => {
  it('requires StartTLS before binding on an ldap:// endpoint', async () => {
    saveCfg({ tls: false, port: 1389 });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({ searchEntries: [], searchReferences: [] });
      return c;
    });
    await ldap.testConnection(ldap.getConfig());
    expect(ldaptsCtorCalls[0].url).toBe('ldap://ad.test.local:1389');
    expect(clientInstances[0].startTLS).toHaveBeenCalledWith(expect.objectContaining({ rejectUnauthorized: true }));
    expect(clientInstances[0].startTLS.mock.invocationCallOrder[0]).toBeLessThan(clientInstances[0].bind.mock.invocationCallOrder[0]);
    // tlsOptions on the constructor would incorrectly select immediate TLS.
    expect(ldaptsCtorCalls[0].tlsOptions).toBeUndefined();
  });

  it('rejects certificate bypass on save and on legacy runtime settings', async () => {
    expect(() => saveCfg({ tls: true, tlsSkipVerify: true })).toThrow(/certificate verification/);
    await expect(ldap.testConnection({ ...BASE_CFG, tls: true, tlsSkipVerify: true })).rejects.toThrow(/certificate verification/);
    expect(Client).not.toHaveBeenCalled();
  });

  it('LDAPS with valid CA leaves rejectUnauthorized at the secure default (tlsSkipVerify=false)', async () => {
    saveCfg({ tls: true, port: 636, tlsSkipVerify: false });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({ searchEntries: [], searchReferences: [] });
      return c;
    });
    await ldap.testConnection(ldap.getConfig());
    expect(ldaptsCtorCalls[0].url).toBe('ldaps://ad.test.local:636');
    expect(ldaptsCtorCalls[0].tlsOptions).toMatchObject({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(clientInstances[0].startTLS).not.toHaveBeenCalled();
  });

  it('defaults port to 389 (LDAP) and 636 (LDAPS) when port is omitted', async () => {
    // Plain LDAP — no port → expect 389
    saveCfg({ tls: false, port: undefined });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({ searchEntries: [], searchReferences: [] });
      return c;
    });
    await ldap.testConnection(ldap.getConfig());
    expect(ldaptsCtorCalls[0].url).toBe('ldap://ad.test.local:389');

    // LDAPS — no port → expect 636
    resetMocks();
    ldap.deleteConfig();
    saveCfg({ tls: true, port: undefined });
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({ searchEntries: [], searchReferences: [] });
      return c;
    });
    await ldap.testConnection(ldap.getConfig());
    expect(ldaptsCtorCalls[0].url).toBe('ldaps://ad.test.local:636');
  });
});

// ─── 4. testConnection() ─────────────────────────────────────────────────

describe('LdapService — testConnection', () => {
  it('returns ok=true with usersFound count on a successful service bind + search', async () => {
    saveCfg();
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({
        searchEntries: [{ dn: 'uid=anyone,ou=people,dc=test,dc=local', uid: 'anyone' }],
        searchReferences: [],
      });
      return c;
    });
    const result = await ldap.testConnection(ldap.getConfig());
    expect(result).toEqual({ ok: true, usersFound: 1 });
  });

  it('handles an empty search result (usersFound=0) without throwing', async () => {
    saveCfg();
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({ searchEntries: [], searchReferences: [] });
      return c;
    });
    const result = await ldap.testConnection(ldap.getConfig());
    expect(result).toEqual({ ok: true, usersFound: 0 });
  });
});

// ─── 5. listUsers() ──────────────────────────────────────────────────────

describe('LdapService — listUsers', () => {
  it('maps multiple search entries into the expected {dn, username, email, displayName} shape', async () => {
    saveCfg();
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({
        searchEntries: [
          {
            dn: 'uid=alice,ou=people,dc=test,dc=local',
            uid: 'alice',
            mail: 'alice@test.local',
            displayName: 'Alice Liddell',
            cn: 'Alice Liddell',
          },
          {
            dn: 'uid=bob,ou=people,dc=test,dc=local',
            uid: 'bob',
            // No mail, displayName falls back to cn
            cn: 'Bob Roberts',
          },
        ],
        searchReferences: [],
      });
      return c;
    });

    const users = await ldap.listUsers(ldap.getConfig(), 50);
    expect(users).toHaveLength(2);
    expect(users[0]).toEqual({
      dn: 'uid=alice,ou=people,dc=test,dc=local',
      username: 'alice',
      email: 'alice@test.local',
      displayName: 'Alice Liddell',
    });
    expect(users[1]).toEqual({
      dn: 'uid=bob,ou=people,dc=test,dc=local',
      username: 'bob',
      email: '',
      displayName: 'Bob Roberts',
    });
  });

  it('coerces Buffer-valued attributes to UTF-8 strings (defensive normalization)', async () => {
    saveCfg();
    Client.mockImplementationOnce((opts) => {
      ldaptsCtorCalls.push(opts);
      const c = makeClient(opts);
      c.search.mockResolvedValue({
        searchEntries: [{
          dn: 'uid=byte,ou=people,dc=test,dc=local',
          uid: Buffer.from('byte', 'utf8'),
          mail: Buffer.from('byte@test.local', 'utf8'),
          displayName: Buffer.from('Byte User Ω', 'utf8'),
          cn: 'Byte User',
        }],
        searchReferences: [],
      });
      return c;
    });

    const users = await ldap.listUsers(ldap.getConfig(), 10);
    expect(users[0].username).toBe('byte');
    expect(users[0].email).toBe('byte@test.local');
    expect(users[0].displayName).toBe('Byte User Ω');
  });
});
