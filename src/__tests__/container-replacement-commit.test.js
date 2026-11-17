'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-replacement-commit-'));
const filename = path.join(directory, 'database.sqlite');
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: filename,
  ENCRYPTION_KEY: 'test-encryption-key-for-jest-32chars' });
jest.mock('../services/deployment-security', () => ({ enqueue: jest.fn() }));
const { getDb, closeDb } = require('../db');
const { replace } = require('../services/container-replacement');
const daemon = require('./helpers/replacement-daemon');

afterAll(() => {
  closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a concurrent writer cannot invalidate the replacement audit transaction', async () => {
  const db = getDb();
  db.pragma('journal_mode = WAL');
  const other = new Database(filename, { timeout: 0 });
  const fixture = daemon();
  let writerError;
  try {
    const result = await replace({ docker: fixture.docker, inspect: await fixture.old.inspect(),
      imageId: 'sha256:' + 'b'.repeat(64), hostId: 42, action: 'test-update', username: 'test',
      verification: { stabilizeMs: 0, intervalMs: 1, timeoutMs: 10 }, commit: () => {
        // Audit reads the previous entry before inserting its required next entry.
        db.prepare('SELECT value FROM settings WHERE key=?').get('replacement-commit');
        try {
          other.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('competing-writer', 'written');
        } catch (error) { writerError = error; }
        db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('replacement-commit', 'written');
      } });
    expect(result.cleanupRequired).toBe(false);
    expect(writerError?.code).toBe('SQLITE_BUSY');
    expect(db.prepare('SELECT value FROM settings WHERE key=?').get('replacement-commit').value).toBe('written');
    expect(db.prepare('SELECT phase FROM container_replacements WHERE id=?').get(result.operationId).phase).toBe('complete');
  } finally { other.close(); }
});
