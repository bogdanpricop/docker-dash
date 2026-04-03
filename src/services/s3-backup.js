'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../utils/logger')('s3-backup');
const { getDb } = require('../db');

// ─── State ─────────────────────────────────────────────
let _lastBackup = { time: null, status: null, error: null, size: 0, key: null };

// ─── Minimal AWS Signature V4 Implementation ───────────
function _hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data).digest(encoding || undefined);
}

function _sha256(data, encoding) {
  return crypto.createHash('sha256').update(data).digest(encoding || 'hex');
}

function _getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = _hmac('AWS4' + secretKey, dateStamp);
  const kRegion = _hmac(kDate, region);
  const kService = _hmac(kRegion, service);
  return _hmac(kService, 'aws4_request');
}

/**
 * Sign and upload a buffer to S3 using AWS Signature V4.
 * Works with AWS S3, MinIO, Backblaze B2, and any S3-compatible storage.
 */
function _s3Put(bucket, objectKey, body, contentType = 'application/octet-stream') {
  return new Promise((resolve, reject) => {
    const s3 = config.s3;
    if (!s3 || !s3.enabled) return reject(new Error('S3 not configured'));

    const endpoint = s3.endpoint.replace(/\/$/, '');
    const region = s3.region || 'us-east-1';
    const accessKey = s3.accessKey;
    const secretKey = s3.secretKey;

    // Parse endpoint URL
    let parsedUrl;
    try { parsedUrl = new URL(endpoint); } catch { return reject(new Error('Invalid S3_ENDPOINT URL')); }

    const isHttps = parsedUrl.protocol === 'https:';
    const hostname = parsedUrl.hostname;
    const port = parsedUrl.port || (isHttps ? 443 : 80);

    // Path-style URL: endpoint/bucket/key
    const reqPath = `/${bucket}/${objectKey}`;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const dateStamp = amzDate.substring(0, 8);

    const bodyHash = _sha256(body, 'hex');

    const headers = {
      'Host': hostname + (port !== 443 && port !== 80 ? ':' + port : ''),
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      'x-amz-content-sha256': bodyHash,
      'x-amz-date': amzDate,
    };

    // Canonical request
    const signedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
    const signedHeaders = signedHeaderKeys.join(';');
    const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[k.split('-').map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join('-') || k]}`);

    // Build canonical headers properly
    const canonicalHeaderStr = signedHeaderKeys.map(k => {
      const orig = Object.keys(headers).find(h => h.toLowerCase() === k);
      return `${k}:${headers[orig].trim()}`;
    }).join('\n') + '\n';

    const canonicalRequest = [
      'PUT',
      reqPath,
      '', // query string
      canonicalHeaderStr,
      signedHeaders,
      bodyHash,
    ].join('\n');

    // String to sign
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      _sha256(canonicalRequest, 'hex'),
    ].join('\n');

    // Signing key & signature
    const signingKey = _getSignatureKey(secretKey, dateStamp, region, 's3');
    const signature = _hmac(signingKey, stringToSign, 'hex');

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const transport = isHttps ? https : http;
    const req = transport.request({
      method: 'PUT',
      hostname,
      port: parseInt(port),
      path: reqPath,
      headers,
      rejectUnauthorized: isHttps, // Allow self-signed for MinIO in dev
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: data });
        } else {
          reject(new Error(`S3 PUT failed: HTTP ${res.statusCode} — ${data.substring(0, 500)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('S3 PUT timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Test S3 connectivity by uploading a small test object.
 */
async function testConnection() {
  const testKey = `docker-dash-test-${Date.now()}.txt`;
  const testBody = Buffer.from('Docker Dash S3 connectivity test — ' + new Date().toISOString());
  await _s3Put(config.s3.bucket, testKey, testBody, 'text/plain');
  return { ok: true, key: testKey, message: 'S3 connection successful' };
}

/**
 * Upload the SQLite database backup to S3.
 */
async function uploadBackup() {
  const db = getDb();
  const backupDir = process.env.DATA_DIR || '/data';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tempFile = path.join(backupDir, `s3-backup-${ts}.db`);

  try {
    // Create a backup file
    await db.backup(tempFile);
    const stat = fs.statSync(tempFile);
    const body = fs.readFileSync(tempFile);

    const objectKey = `docker-dash/backup-${ts}.db`;
    await _s3Put(config.s3.bucket, objectKey, body, 'application/octet-stream');

    _lastBackup = {
      time: new Date().toISOString(),
      status: 'success',
      error: null,
      size: stat.size,
      key: objectKey,
    };

    log.info('S3 backup uploaded', { key: objectKey, size: stat.size });
    return _lastBackup;
  } catch (err) {
    _lastBackup = {
      time: new Date().toISOString(),
      status: 'error',
      error: err.message,
      size: 0,
      key: null,
    };
    log.error('S3 backup failed', err.message);
    throw err;
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
  }
}

/**
 * Get last backup status.
 */
function getStatus() {
  return {
    enabled: config.s3?.enabled || false,
    schedule: config.s3?.backupSchedule || '0 3 * * *',
    lastBackup: _lastBackup,
  };
}

module.exports = { testConnection, uploadBackup, getStatus };
