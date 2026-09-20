'use strict';
Object.assign(process.env, { APP_ENV: 'test', ENCRYPTION_KEY: 'history-fixture-encryption-key', DB_PATH: ':memory:' });
const Database = require('better-sqlite3');
const { spawnSync } = require('node:child_process');
const { PREFIX, sealSnapshot, openSnapshotText, readSnapshot } = require('../utils/history-snapshot');
const migration = require('../db/migrations/176_encrypt_rollback_snapshots');
const context = { host_id: 42, container_name: 'fixture', container_id: 'old-container', image_id: 'sha256:fixture' };
const secret = JSON.stringify({ Env: ['TOKEN=history-fixture-secret'], HostConfig: { Binds: ['/fixture:/data'] } });
let db;
beforeEach(() => { db = new Database(':memory:'); require('../db/migrations/026_rollback_history').up(db); });
afterEach(() => db.close());
function insert(snapshot = secret) {
  return db.prepare(`INSERT INTO container_image_history
    (host_id, container_name, container_id, image_name, image_id, config_snapshot)
    VALUES (?, ?, ?, 'fixture:old', ?, ?)`).run(context.host_id, context.container_name,
    context.container_id, context.image_id, snapshot).lastInsertRowid;
}

test('migration encrypts all existing secret text and preserves usable rollback data', () => {
  insert(); insert(); insert(null); insert(''); insert('{invalid legacy secret');
  db.transaction(() => migration.up(db))();
  const rows = db.prepare('SELECT * FROM container_image_history ORDER BY id').all();
  expect(rows[0].config_snapshot).toMatch(/^dd-history:v1:/);
  expect(rows[0].config_snapshot).not.toContain('history-fixture-secret');
  expect(rows[0].config_snapshot).not.toBe(rows[1].config_snapshot);
  expect(readSnapshot(rows[0])).toEqual(JSON.parse(secret));
  expect(readSnapshot(rows[2])).toBeNull(); expect(readSnapshot(rows[3])).toBeNull();
  expect(openSnapshotText(rows[4].config_snapshot, rows[4])).toBe('{invalid legacy secret');
  expect(() => readSnapshot(rows[4])).toThrow();
  db.transaction(() => migration.up(db))();
  expect(db.prepare('SELECT config_snapshot FROM container_image_history WHERE id = 1').get().config_snapshot).toBe(rows[0].config_snapshot);
});

test('failed migration rolls back every earlier update instead of leaving mixed storage', () => {
  insert(); insert();
  db.exec("CREATE TRIGGER fail_second BEFORE UPDATE ON container_image_history WHEN OLD.id = 2 BEGIN SELECT RAISE(FAIL, 'fixture write failure'); END");
  expect(() => db.transaction(() => migration.up(db))()).toThrow('fixture write failure');
  expect(db.prepare('SELECT config_snapshot FROM container_image_history').all().map(row => row.config_snapshot)).toEqual([secret, secret]);
});

test.each(['host_id', 'container_name', 'container_id', 'image_id'])('ciphertext cannot be transplanted to different %s', field => {
  const value = sealSnapshot(secret, context);
  expect(() => readSnapshot({ ...context, [field]: field === 'host_id' ? 99 : 'different', config_snapshot: value })).toThrow(/identity mismatch/);
});

test('damaged authentication tag is rejected without returning any secret', () => {
  const value = sealSnapshot(secret, context);
  const offset = PREFIX.length + 25;
  const corrupt = value.slice(0, offset) + (value[offset] === '0' ? '1' : '0') + value.slice(offset + 1);
  expect(() => readSnapshot({ ...context, config_snapshot: corrupt })).toThrow();
  insert(corrupt);
  expect(() => db.transaction(() => migration.up(db))()).toThrow();
  expect(db.prepare('SELECT config_snapshot FROM container_image_history').get().config_snapshot).toBe(corrupt);
});

test('a different encryption key cannot open a snapshot', () => {
  const row = { ...context, config_snapshot: sealSnapshot(secret, context) };
  const child = spawnSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict'),fs=require('node:fs');
    const {readSnapshot}=require('./src/utils/history-snapshot');
    assert.throws(()=>readSnapshot(JSON.parse(fs.readFileSync(0,'utf8'))),/authenticate|Unsupported state/);
  `], { cwd: require('node:path').resolve(__dirname, '../..'),
    env: { ...process.env, ENCRYPTION_KEY: 'different-history-fixture-key' }, input: JSON.stringify(row), encoding: 'utf8', timeout: 10000 });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
});

test.each([secret, 'dd-history:v2:anything', 'dd-history:v1:invalid'])('runtime never accepts plaintext or unsupported/damaged ciphertext', value => {
  expect(() => readSnapshot({ ...context, config_snapshot: value })).toThrow();
});

test.each(['null', '[]', '123', '{invalid'])('encrypted invalid JSON/object cannot be restored: %s', value => {
  expect(() => readSnapshot({ ...context, config_snapshot: sealSnapshot(value, context) })).toThrow();
});

test('downgrade to plaintext is not supported', () => { expect(() => migration.down(db)).toThrow(/plaintext/); });
