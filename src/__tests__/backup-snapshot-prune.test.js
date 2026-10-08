'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { pruneBackupSnapshots } = require('../jobs');

/**
 * Regression cover for the VPS disk-fill found 2026-09-03: 18 unrotated
 * `predeploy-*.db` snapshots of a ~450MB database had taken 11GB, growing by
 * one snapshot per release because nothing owned their retention.
 */
describe('pruneBackupSnapshots', () => {
  let root;
  let backupDir;
  let originalDataDir;

  /** Write `name` with an explicit mtime so ordering is deterministic. */
  function snapshot(name, minutesAgo, body = 'x') {
    const p = path.join(backupDir, name);
    fs.writeFileSync(p, body);
    const when = new Date(Date.now() - minutesAgo * 60 * 1000);
    fs.utimesSync(p, when, when);
  }

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prune-'));
    backupDir = path.join(root, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    process.env.DATA_DIR = root;
  });

  afterEach(() => {
    process.env.DATA_DIR = originalDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the newest N snapshots and removes the rest', () => {
    snapshot('predeploy-v8.96.0-aaaaaaa.db', 1);
    snapshot('predeploy-v8.95.0-bbbbbbb.db', 2);
    snapshot('predeploy-v8.94.0-ccccccc.db', 3);
    snapshot('predeploy-v8.93.0-ddddddd.db', 4);
    snapshot('predeploy-v8.92.0-eeeeeee.db', 5);

    pruneBackupSnapshots('predeploy-', 3);

    expect(fs.readdirSync(backupDir).sort()).toEqual([
      'predeploy-v8.94.0-ccccccc.db',
      'predeploy-v8.95.0-bbbbbbb.db',
      'predeploy-v8.96.0-aaaaaaa.db',
    ]);
  });

  it('orders by mtime, not filename', () => {
    // Lexicographically v8.9.0 > v8.10.0, so a name sort would keep the wrong
    // file. v8.10.0 is the newer release and must survive.
    snapshot('predeploy-v8.10.0-newer.db', 1);
    snapshot('predeploy-v8.9.0-older.db', 60);

    pruneBackupSnapshots('predeploy-', 1);

    expect(fs.readdirSync(backupDir)).toEqual(['predeploy-v8.10.0-newer.db']);
  });

  it('removes -wal and -shm companions with their parent', () => {
    snapshot('predeploy-v8.96.0-keep.db', 1);
    snapshot('predeploy-v8.95.0-drop.db', 2);
    snapshot('predeploy-v8.95.0-drop.db-wal', 2);
    snapshot('predeploy-v8.95.0-drop.db-shm', 2);

    pruneBackupSnapshots('predeploy-', 1);

    expect(fs.readdirSync(backupDir)).toEqual(['predeploy-v8.96.0-keep.db']);
  });

  it('leaves other backup classes alone', () => {
    snapshot('backup-daily-2026-09-01.db', 10);
    snapshot('backup-daily-2026-09-02.db', 5);
    snapshot('backup-daily-2026-09-03.db', 1);
    snapshot('predeploy-v8.96.0-aaaaaaa.db', 2);
    snapshot('predeploy-v8.95.0-bbbbbbb.db', 3);

    pruneBackupSnapshots('predeploy-', 1);

    expect(fs.readdirSync(backupDir).sort()).toEqual([
      'backup-daily-2026-09-01.db',
      'backup-daily-2026-09-02.db',
      'backup-daily-2026-09-03.db',
      'predeploy-v8.96.0-aaaaaaa.db',
    ]);
  });

  it('handles encrypted snapshots', () => {
    snapshot('predeploy-v8.96.0-aaaaaaa.db.enc', 1);
    snapshot('predeploy-v8.95.0-bbbbbbb.db.enc', 2);

    pruneBackupSnapshots('predeploy-', 1);

    expect(fs.readdirSync(backupDir)).toEqual(['predeploy-v8.96.0-aaaaaaa.db.enc']);
  });

  it('is a no-op when the backup directory does not exist', () => {
    fs.rmSync(backupDir, { recursive: true, force: true });
    expect(() => pruneBackupSnapshots('predeploy-', 3)).not.toThrow();
  });

  it('does nothing when fewer snapshots exist than the retention count', () => {
    snapshot('predeploy-v8.96.0-aaaaaaa.db', 1);
    pruneBackupSnapshots('predeploy-', 3);
    expect(fs.readdirSync(backupDir)).toEqual(['predeploy-v8.96.0-aaaaaaa.db']);
  });
});
