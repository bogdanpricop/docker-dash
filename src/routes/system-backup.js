'use strict';

// v8.2.x further-split: extracted from src/routes/system.js.
// 17 routes covering local DB backup config + restore + S3 (v3.x) + pCloud
// (v8.2.0) + audit-dump preview. Mounted by system.js at `/backup`, so
// external URLs like `/api/system/backup/s3-status` are unchanged.

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { pipeline } = require('node:stream/promises');

const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');
const config = require('../config');

const router = Router();
router.use('/storage', require('./storage-backup'));

function configRestorePlan(db, data) {
  const input = data?.settings ?? [];
  if (typeof data?.version !== 'string' || !data.version || !Array.isArray(input)
    || input.length > 5000 || input.some(entry => !entry || typeof entry.key !== 'string'
      || !entry.key || entry.key.length > 512 || typeof entry.value !== 'string')) {
    throw Object.assign(new Error('Invalid backup file'), { status: 400 });
  }
  const settings = [...new Map(input.map(entry => [entry.key, entry.value]))];
  const current = db.prepare('SELECT value FROM settings WHERE key = ?');
  const values = settings.map(([key, value]) => ({ key, value, previous: current.get(key)?.value }));
  const apiKeys = Array.isArray(data.apiKeys) ? data.apiKeys : [];
  const planId = crypto.createHmac('sha256', config.app.secret)
    .update(JSON.stringify({ values, version: data.version })).digest('hex');
  return {
    settings, plan: {
      planId, version: data.version,
      creates: values.filter(entry => entry.previous === undefined).map(entry => entry.key),
      replaces: values.filter(entry => entry.previous !== undefined && entry.previous !== entry.value).map(entry => entry.key),
      unchanged: values.filter(entry => entry.previous === entry.value).length,
      apiKeysSkipped: apiKeys.length,
      usersSkipped: Array.isArray(data.users) ? data.users.length : 0,
    },
  };
}

// ─── Backup Config + Restore ──────────────────────────────
router.get('/config', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const settings = db.prepare('SELECT key, value FROM settings').all();
    const apiKeys = db.prepare('SELECT id, name, key_prefix AS prefix, created_at, user_id AS created_by, last_used_at FROM api_keys').all();
    const users = db.prepare('SELECT id, username, role, totp_enabled AS mfa_enabled, must_change_password, locked_until, failed_attempts, created_at, last_login_at FROM users').all();

    const backup = {
      version: require('../version'),
      exportedAt: new Date().toISOString(),
      settings,
      apiKeys,
      users,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="docker-dash-backup-${new Date().toISOString().substring(0, 10)}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/restore/plan', requireAuth, requireRole('admin'), (req, res) => {
  try { res.json(configRestorePlan(getDb(), req.body).plan); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not prepare the restore plan' }); }
});

router.post('/restore', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.version) return res.status(400).json({ error: 'Invalid backup file' });

    const db = getDb();
    // Configuration exports contain only metadata for identities and API keys.
    // Credential-bearing restores use the separately reviewed database flow.
    const restored = { settings: 0, apiKeys: 0 };
    let reviewed;

    // Lock writers before reviewing the plan again and applying changes.
    db.transaction(() => {
      reviewed = configRestorePlan(db, data);
      if (data.planId !== undefined && data.planId !== reviewed.plan.planId) {
        throw Object.assign(new Error('Settings changed since review. Open a new restore plan.'), { status: 409 });
      }
      const upsertSettings = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value IS NOT excluded.value`);
      for (const [key, value] of reviewed.settings) restored.settings += upsertSettings.run(key, value).changes;
    }).immediate();

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'config_restore', targetType: 'system', targetId: 'backup',
      details: JSON.stringify(restored), ip: getClientIp(req),
    });

    const response = { ok: true, restored, skipped: { apiKeys: reviewed.plan.apiKeysSkipped, users: reviewed.plan.usersSkipped } };
    if (Array.isArray(data.users) && data.users.length > 0) {
      response.note = `${data.users.length} users in the backup file were not restored. User data is exported for inspection/audit purposes only; the backup format omits password_hash and mfa_secret, so restoring would create accounts that cannot authenticate. Re-create users manually after restore.`;
    }
    res.json(response);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Restore failed' });
  }
});

// ─── S3 Backup ─────────────────────────────────────────────
router.get('/s3-status', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const s3Backup = require('../services/s3-backup');
    res.json(s3Backup.getStatus());
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/s3-test', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const s3Backup = require('../services/s3-backup');
    const result = await s3Backup.testConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/s3-upload', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const s3Backup = require('../services/s3-backup');
    const result = await s3Backup.uploadBackup();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/s3-config', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { endpoint, bucket, accessKey, secretKey, region, schedule } = req.body;
    const cfg = require('../config');
    if (endpoint !== undefined) cfg.s3.endpoint = endpoint;
    if (bucket !== undefined) cfg.s3.bucket = bucket;
    if (accessKey !== undefined) cfg.s3.accessKey = accessKey;
    if (secretKey !== undefined) cfg.s3.secretKey = secretKey;
    if (region !== undefined) cfg.s3.region = region || 'us-east-1';
    if (schedule !== undefined) cfg.s3.backupSchedule = schedule || '0 3 * * *';
    cfg.s3.enabled = !!(cfg.s3.endpoint && cfg.s3.bucket && cfg.s3.accessKey && cfg.s3.secretKey);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 's3_config_update', targetType: 'system', targetId: 'backup',
      ip: getClientIp(req),
    });

    res.json({ ok: true, enabled: cfg.s3.enabled });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/s3', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { endpoint, bucket, accessKey, secretKey, region, prefix } = req.body;
    if (!endpoint || !bucket || !accessKey || !secretKey) {
      return res.status(400).json({ error: 'endpoint, bucket, accessKey, and secretKey are required' });
    }

    const dbPath = config.db.path;
    if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database file not found' });

    const fileContent = fs.readFileSync(dbPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `${prefix || 'docker-dash'}/${timestamp}-docker-dash.db`;
    const date = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const dateShort = date.substring(0, 8);
    const reg = region || 'us-east-1';

    const host = endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const isHttps = endpoint.startsWith('https');
    const s3path = `/${bucket}/${key}`;
    const contentHash = crypto.createHash('sha256').update(fileContent).digest('hex');

    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${contentHash}\nx-amz-date:${date}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = `PUT\n${s3path}\n\n${canonicalHeaders}\n${signedHeaders}\n${contentHash}`;
    const credentialScope = `${dateShort}/${reg}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;

    const hmac = (k, data) => crypto.createHmac('sha256', k).update(data).digest();
    const sigKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateShort), reg), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', sigKey).update(stringToSign).digest('hex');

    const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const portMatch = endpoint.match(/:(\d+)(\/|$)/);
    const result = await new Promise((resolve, reject) => {
      const httpModule = isHttps ? https : http;
      const req2 = httpModule.request({
        hostname: host.split(':')[0],
        port: portMatch ? parseInt(portMatch[1]) : (isHttps ? 443 : 80),
        path: s3path,
        method: 'PUT',
        headers: {
          'Host': host,
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileContent.length,
          'x-amz-content-sha256': contentHash,
          'x-amz-date': date,
          'Authorization': auth,
        },
      }, (r) => {
        let data = '';
        r.on('data', d => { data += d; });
        r.on('end', () => {
          if (r.statusCode >= 200 && r.statusCode < 300) {
            resolve({ ok: true, key, size: fileContent.length });
          } else {
            reject(new Error(`S3 error ${r.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });
      req2.on('error', reject);
      req2.setTimeout(30000, () => { req2.destroy(); reject(new Error('S3 upload timeout (30s)')); });
      req2.write(fileContent);
      req2.end();
    });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'backup_s3', details: { bucket, key: result.key, size: result.size },
      ip: getClientIp(req),
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

const localBackupName = /^backup-[^/\\:\x00-\x1f]*\.db(?:\.enc)?$/;
const localBackupLimit = 250;

function backupRevision(stat) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])).digest('hex');
}

function backupDirectories() {
  const local = process.env.DATA_DIR || '/data';
  return { local, scheduled: path.join(local, 'backups') };
}

function isBackupCopy(stat, database) {
  return stat?.isFile() && (!database || stat.dev !== database.dev || stat.ino !== database.ino);
}

function activeDatabaseFile() {
  if (config.db.path !== ':memory:') return fs.statSync(config.db.path, { throwIfNoEntry: false });
}

function validLocalCopy(selection) {
  const { location, name, revision } = selection || {};
  return ['local', 'scheduled'].includes(location) && typeof name === 'string' && localBackupName.test(name)
    && typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision);
}

function reviewLocalCopy({ location, name, revision }, database) {
  const directory = backupDirectories()[location];
  const inspect = location === 'scheduled' ? fs.lstatSync : fs.statSync;
  const file = path.join(directory, name);
  const stat = inspect(directory, { throwIfNoEntry: false })?.isDirectory()
    ? fs.lstatSync(file, { throwIfNoEntry: false }) : undefined;
  if (!isBackupCopy(stat, database)) {
    throw Object.assign(new Error('Local database backup not found'), { code: 'ENOENT' });
  }
  if (backupRevision(stat) !== revision) {
    throw Object.assign(new Error('This backup changed. Review the current copy before deleting it.'), { code: 'STALE_BACKUP' });
  }
  return { file, size: stat.size };
}

function localCopyError(error, operation = 'delete') {
  if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { status: 404, error: 'Local database backup not found' };
  if (error.code === 'STALE_BACKUP') return { status: 409, error: `This backup changed. Review the current copy before you ${operation} it.` };
  if (['EACCES', 'EPERM'].includes(error.code)) {
    return { status: 403, error: `Docker Dash does not have permission to ${operation} this copy` };
  }
  if (['EBUSY', 'EROFS', 'EIO'].includes(error.code)) {
    return { status: 500, error: 'The filesystem could not remove or inspect this copy' };
  }
  throw error;
}

function removeLocalCopy(req, selection, database) {
  const { location, name } = selection;
  const { file, size } = reviewLocalCopy(selection, database);
  fs.unlinkSync(file);
  auditService.log({
    userId: req.user.id, username: req.user.username, action: 'database_backup_deleted',
    targetType: 'database_backup', targetId: name, details: { location, size }, ip: getClientIp(req),
  });
}

router.get('/list', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const directories = backupDirectories();
    const database = activeDatabaseFile();
    const files = [];
    for (const [location, directory] of Object.entries(directories)) {
      const inspect = location === 'scheduled' ? fs.lstatSync : fs.statSync;
      if (!inspect(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const name of fs.readdirSync(directory).filter(name => localBackupName.test(name))) {
        try {
          const stat = fs.lstatSync(path.join(directory, name));
          if (isBackupCopy(stat, database)) files.push({ name, size: stat.size, created: stat.mtime.toISOString(),
            location, encrypted: name.endsWith('.enc'), revision: backupRevision(stat) });
        } catch { /* skip unreadable */ }
      }
    }

    res.json({ files: files.sort((a, b) => b.created.localeCompare(a.created)).slice(0, localBackupLimit), dir: directories.local });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/local/:location/:name/download', requireAuth, requireRole('admin'), async (req, res) => {
  const copy = { ...req.params, revision: req.query.revision };
  res.set('Cache-Control', 'no-store');
  if (!validLocalCopy(copy)) return res.status(400).json({ error: 'Invalid database backup selection' });
  let handle;
  try {
    const database = activeDatabaseFile();
    const { file } = reviewLocalCopy(copy, database);
    const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
    handle = await fs.promises.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = await handle.stat();
    if (!isBackupCopy(stat, activeDatabaseFile()) || backupRevision(stat) !== copy.revision) {
      return res.status(409).json({ error: 'This backup changed. Review the current copy before you download it.' });
    }
    if (req.method !== 'HEAD') {
      auditService.log({
        userId: req.user.id, username: req.user.username, action: 'database_backup_download',
        targetType: 'database_backup', targetId: copy.name, details: { location: copy.location, size: stat.size }, ip: getClientIp(req),
      });
    }
    res.attachment(copy.name).type('application/octet-stream').set('Content-Length', String(stat.size));
    if (req.method === 'HEAD' || stat.size === 0) return res.end();
    await pipeline(handle.createReadStream({ end: stat.size - 1 }), res);
  } catch (error) {
    if (res.destroyed && error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    if (res.headersSent || res.destroyed) throw error;
    if (error.code === 'ELOOP') return res.status(404).json({ error: 'Local database backup not found' });
    const failure = localCopyError(error, 'download');
    res.status(failure.status).json({ error: failure.error });
  } finally {
    await handle?.close();
  }
});

router.delete('/local/bulk', requireAuth, requireRole('admin'), writeable, (req, res) => {
  const copies = req.body?.copies;
  if (!Array.isArray(copies) || copies.length < 1 || copies.length > localBackupLimit || !copies.every(validLocalCopy)
    || new Set(copies.map(({ location, name }) => location + '/' + name)).size !== copies.length) {
    return res.status(400).json({ error: 'Select a valid set of distinct database backups' });
  }

  const database = activeDatabaseFile();
  const conflicts = [];
  for (const copy of copies) {
    try { reviewLocalCopy(copy, database); }
    catch (error) {
      conflicts.push({ location: copy.location, name: copy.name, ...localCopyError(error) });
    }
  }
  if (conflicts.length) {
    return res.status(409).json({ error: 'Some selected backups are unavailable or have changed. Review the current list before deleting.', conflicts });
  }

  const deleted = [];
  const failed = [];
  for (const copy of copies) {
    const { location, name } = copy;
    try {
      removeLocalCopy(req, copy, database);
      deleted.push({ location, name });
    } catch (error) {
      failed.push({ location, name, ...localCopyError(error) });
    }
  }
  res.json({ deleted, failed });
});

router.delete('/local/:location/:name', requireAuth, requireRole('admin'), writeable, (req, res) => {
  const copy = { ...req.params, revision: req.body?.revision };
  if (!validLocalCopy(copy)) {
    return res.status(400).json({ error: 'Invalid database backup selection' });
  }
  try {
    removeLocalCopy(req, copy, activeDatabaseFile());
    res.json({ ok: true });
  } catch (error) {
    const failure = localCopyError(error);
    res.status(failure.status).json({ error: failure.error });
  }
});

// ─── pCloud Backup (v8.2.0) ────────────────────────────────
router.get('/pcloud/status', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const pcloudBackup = require('../services/pcloud-backup');
    res.json(pcloudBackup.getStatus());
  } catch (err) {
    require('../utils/logger')('system')('pCloud status failed', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/pcloud/connect', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { username, password, region } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
    const pcloudBackup = require('../services/pcloud-backup');
    const r = await pcloudBackup.connect({ username, password, region: region || 'eu' });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'pcloud_config_update', targetType: 'system', targetId: 'pcloud',
      details: JSON.stringify({ event: 'connect', region: r.region, email: r.email }),
      ip: getClientIp(req),
    });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Connect failed' });
  }
});

router.post('/pcloud/disconnect', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const pcloudBackup = require('../services/pcloud-backup');
    await pcloudBackup.disconnect();
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'pcloud_config_update', targetType: 'system', targetId: 'pcloud',
      details: JSON.stringify({ event: 'disconnect' }),
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Disconnect failed' });
  }
});

router.post('/pcloud/test', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const pcloudBackup = require('../services/pcloud-backup');
    res.json(await pcloudBackup.testConnection());
  } catch (err) {
    res.status(400).json({ error: err.message || 'Test failed' });
  }
});

router.put('/pcloud/config', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const pcloudBackup = require('../services/pcloud-backup');
    const status = pcloudBackup.updateConfig(req.body || {});
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'pcloud_config_update', targetType: 'system', targetId: 'pcloud',
      details: JSON.stringify({ event: 'update', schedules: status.schedules, keep: status.keep }),
      ip: getClientIp(req),
    });
    res.json(status);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Update failed' });
  }
});

router.post('/pcloud/run/db', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const pcloudBackup = require('../services/pcloud-backup');
    const r = await pcloudBackup.uploadDbBackup({ trigger: 'manual' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message || 'DB upload failed' });
  }
});

router.post('/pcloud/run/stacks', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const stackArchive = require('../jobs/stack-archive');
    const r = await stackArchive.run({ trigger: 'manual' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Stack archive failed' });
  }
});

router.post('/pcloud/run/audit', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const auditDump = require('../jobs/audit-dump');
    const r = await auditDump.run({ trigger: 'manual', month: req.body?.month });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Audit dump failed' });
  }
});

router.get('/audit-dump/preview', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const auditDump = require('../jobs/audit-dump');
    const range = auditDump._previousMonth();
    const r = getDb().prepare(
      'SELECT COUNT(*) as count FROM audit_log WHERE created_at >= ? AND created_at < ?'
    ).get(range.since, range.until);
    res.json({
      yearMonth: range.yearMonth,
      rows: r.count,
      estBytes: r.count * 300,
      estGzBytes: Math.round(r.count * 60),
    });
  } catch (err) {
    res.status(500).json({ error: 'Preview failed' });
  }
});

module.exports = router;
