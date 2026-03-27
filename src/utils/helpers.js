'use strict';

/** Format bytes to human-readable */
function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

/** Paginate query results */
function paginate(query, params, page = 1, limit = 50) {
  const offset = (page - 1) * limit;
  return { ...params, _limit: limit, _offset: offset };
}

/** Sanitize container ID (prevent injection) */
function sanitizeId(id) {
  if (!id || typeof id !== 'string') return null;
  return id.replace(/[^a-f0-9]/gi, '').substring(0, 64);
}

/** Get client IP from request */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

/** Safe JSON parse */
function tryParseJson(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/** Current ISO datetime */
function now() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

module.exports = { formatBytes, paginate, sanitizeId, getClientIp, tryParseJson, now };
