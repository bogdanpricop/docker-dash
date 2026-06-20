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

const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');
const config = require('../config');

const router = Router();

// ─── Backup Config + Restore ──────────────────────────────
router.get('/config', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const settings = db.prepare('SELECT key, value FROM settings').all();
    const apiKeys = db.prepare('SELECT id, name, prefix, created_at, created_by, last_used_at FROM api_keys').all();
    const users = db.prepare('SELECT id, username, role, mfa_enabled, must_change_password, locked_until, failed_attempts, created_at, last_login_at FROM users').all();

    const backup = {
      version: require('../version'),
      exportedAt: new Date().toISOString(),
      settings,
      apiKeys,
      users,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="docker-dash-backup-${new Date().toISOString().substring(0, 10)}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/restore', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.version) return res.status(400).json({ error: 'Invalid backup file' });

    const db = getDb();
    // v8.7.20 — counters dropped `users` because the route never restored
    // them (the backup exports id/username/role for inspection but omits
    // password_hash/mfa_secret/recovery_codes, so a restored row would be
    // an account that can never log in). Reporting `users: 0` made it
    // look like a silent loss bug; an explicit `note` in the response
    // tells operators the file contains user metadata that was not
    // applied. Hash-bearing fields are deliberately not in the backup
    // format, so restore for users would need a separate flow.
    const restored = { settings: 0, apiKeys: 0 };

    // v8.7.20 RELIABILITY — wrap in a SQLite transaction so a crash mid-
    // restore (process killed by OOM/SIGTERM, file-system error, schema
    // mismatch on a single row) doesn't leave the settings table half-
    // applied. better-sqlite3's db.transaction(fn)() opens BEGIN, calls
    // fn synchronously, COMMITs on return, ROLLBACKs on throw. The
    // apiKeys per-row try/catch is preserved INSIDE the transaction —
    // an individual bad-row error is silently skipped (the previous
    // behavior), but a non-row error (out of disk, prepare failure)
    // rolls back the entire restore.
    db.transaction(() => {
      if (Array.isArray(data.settings)) {
        const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        for (const s of data.settings) {
          upsert.run(s.key, s.value);
          restored.settings++;
        }
      }
      if (Array.isArray(data.apiKeys)) {
        const upsert = db.prepare('INSERT OR REPLACE INTO api_keys (id, name, prefix, created_at, created_by, last_used_at, hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const k of data.apiKeys) {
          try { upsert.run(k.id, k.name, k.prefix, k.created_at, k.created_by, k.last_used_at, k.hash || ''); restored.apiKeys++; } catch { /* skip individual bad row */ }
        }
      }
    })();

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'config_restore', targetType: 'system', targetId: 'backup',
      details: JSON.stringify(restored), ip: getClientIp(req),
    });

    const response = { ok: true, restored };
    if (Array.isArray(data.users) && data.users.length > 0) {
      response.note = `${data.users.length} users in the backup file were not restored. User data is exported for inspection/audit purposes only; the backup format omits password_hash and mfa_secret, so restoring would create accounts that cannot authenticate. Re-create users manually after restore.`;
    }
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: 'Restore failed: ' + err.message });
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

router.get('/list', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const backupDir = process.env.DATA_DIR || '/data';

    const files = [];
    if (fs.existsSync(backupDir)) {
      const entries = fs.readdirSync(backupDir).filter(f => f.startsWith('backup-') && f.endsWith('.db'));
      for (const f of entries.sort().reverse()) {
        try {
          const stat = fs.statSync(path.join(backupDir, f));
          files.push({ name: f, size: stat.size, created: stat.mtime.toISOString() });
        } catch { /* skip unreadable */ }
      }
    }

    res.json({ files, dir: backupDir });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
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
