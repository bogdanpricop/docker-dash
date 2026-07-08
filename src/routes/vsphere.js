'use strict';

// v8.9.11-alpha.1 — VMware vSphere / ESXi routes. Read-only in this alpha.

const { Router } = require('express');
const { getDb } = require('../db');
const { fromHostRow } = require('../services/vsphere');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');
const { extractHostId } = require('../middleware/hostId');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);

function _getVSphereHost(req, res) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(req.hostId);
  if (!row) { res.status(404).json({ error: `Host ${req.hostId} not found` }); return null; }
  if (row.daemon_type !== 'vsphere') {
    res.status(400).json({
      error: `Host ${req.hostId} (${row.name}) is not a vSphere daemon (daemon_type=${row.daemon_type})`,
    });
    return null;
  }
  return row;
}

// Cache clients per host id — SOAP login is expensive.
const _clientCache = new Map();

function _invalidateClient(id) {
  const c = _clientCache.get(id);
  _clientCache.delete(id);
  if (c && c.logout) c.logout().catch(() => {});
}

// A cached client's TLS socket or SOAP session can die silently (e.g. the ESXi
// host reboots, or a firewall drops the idle connection). Without this, the
// dead client stays cached for the full 20-min window and every request fails
// with "Client network socket disconnected before secure TLS connection…".
// These errors mean "reconnect and try again", not "host is broken".
function _isStaleConn(err) {
  const m = (err && err.message) || String(err || '');
  return /socket disconnected|before secure TLS|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|socket hang up|network socket|not authenticated|session is not authenticated|NotAuthenticated|login required|session.*expired/i.test(m);
}

// Acquire (or reuse) a logged-in client. Login is lazy — it happens here on a
// cache miss, inside the caller's try/catch.
async function _acquireClient(row) {
  const cached = _clientCache.get(row.id);
  if (cached) return cached;
  const c = fromHostRow(row);
  await c.login();
  _clientCache.set(row.id, c);
  setTimeout(() => {
    _clientCache.delete(row.id);
    c.logout().catch(() => {});
  }, 20 * 60 * 1000).unref();
  return c;
}

// Return a self-healing proxy: any client method that throws a stale
// connection/session error busts the cache, re-logs in, and retries ONCE.
// Transparent to every route — call sites keep doing `(await _getClient(row)).method()`.
function _getClient(row) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined; // don't look thenable to await
      return async (...args) => {
        let c = await _acquireClient(row);
        try {
          return await c[prop](...args);
        } catch (err) {
          if (!_isStaleConn(err)) throw err;
          _invalidateClient(row.id);
          c = await _acquireClient(row); // fresh login
          return await c[prop](...args);
        }
      };
    },
  });
}

// Force a fresh reconnect: drop the cached (possibly dead) client and log in
// again. Backs the "Reconnect" button when a host goes offline mid-session.
router.post('/reconnect', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    _invalidateClient(row.id);
    const c = await _acquireClient(row);
    const info = await c.retrieveServiceContent();
    res.json({ ok: true, version: info.version || null, productFullName: info.productFullName || null });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
}));

router.get('/info', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    const c = await _getClient(row);
    res.json(await c.retrieveServiceContent());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

router.get('/vms', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    const c = await _getClient(row);
    res.json(await c.listVMs());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

router.get('/hosts', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    const c = await _getClient(row);
    res.json(await c.listHosts());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

router.get('/datastores', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    const c = await _getClient(row);
    res.json(await c.listDatastores());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

// v8.9.13-alpha.1 — Networks / Services / Host Info (ported from SOS).
router.get('/networks', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try { res.json(await (await _getClient(row)).listNetworks()); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}));

// Services + host info operate on a specific ESXi host. moref optional —
// defaults to the first host in the inventory (standalone ESXi has one).
router.get('/services', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    const c = await _getClient(row);
    let moref = req.query.moref;
    if (!moref) { const hosts = await c.listHosts(); moref = hosts[0] && hosts[0].moref; }
    if (!moref) return res.json([]);
    res.json(await c.getServices(moref));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}));

router.get('/host-info', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    const c = await _getClient(row);
    let moref = req.query.moref;
    if (!moref) { const hosts = await c.listHosts(); moref = hosts[0] && hosts[0].moref; }
    if (!moref) return res.json(null);
    res.json(await c.getHostInfo(moref));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}));

// v8.9.14-alpha.1 — Datastore browse (read-only) + download (proxy).
router.get('/datastore-browse', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  const { datastore, path: folderPath } = req.query;
  if (!datastore) return res.status(400).json({ error: 'datastore is required' });
  try {
    const c = await _getClient(row);
    res.json(await c.browseDatastore(datastore, folderPath || ''));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}));

router.get('/datastore-download', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  const { datastore, path: filePath } = req.query;
  if (!datastore || !filePath) return res.status(400).json({ error: 'datastore + path are required' });
  try {
    const c = await _getClient(row);
    const dl = await c.datastoreDownload(datastore, filePath);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'vsphere_datastore_download', targetType: 'vsphere_datastore', targetId: datastore,
      details: { hostId: req.hostId, path: filePath }, ip: getClientIp(req),
    });
    const fileName = String(filePath).split('/').filter(Boolean).pop() || 'download';
    res.setHeader('Content-Type', dl.contentType);
    if (dl.contentLength) res.setHeader('Content-Length', dl.contentLength);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^\w.\-]/g, '_')}"`);
    dl.stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    dl.stream.pipe(res);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}));

// v8.9.14-alpha.2 — WRITE ops: upload / delete / service control.
// The upload route streams the raw request body straight to ESXi — the
// global express.json() parser is content-type-gated so it does not consume
// application/octet-stream bodies.
router.put('/datastore-upload', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const row = _getVSphereHost(req, res); if (!row) return;
    const { datastore, path: filePath } = req.query;
    if (!datastore || !filePath) return res.status(400).json({ error: 'datastore + path are required' });
    try {
      const c = await _getClient(row);
      const result = await c.datastoreUpload(datastore, filePath, req, req.headers['content-length']);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'vsphere_datastore_upload', targetType: 'vsphere_datastore', targetId: datastore,
        details: { hostId: req.hostId, path: filePath, bytes: req.headers['content-length'] || null },
        ip: getClientIp(req),
      });
      res.json(result);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  })
);

router.delete('/datastore-file', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const row = _getVSphereHost(req, res); if (!row) return;
    const { datastore, path: filePath } = req.query;
    if (!datastore || !filePath) return res.status(400).json({ error: 'datastore + path are required' });
    try {
      const c = await _getClient(row);
      const result = await c.deleteDatastoreFile(datastore, filePath);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'vsphere_datastore_delete', targetType: 'vsphere_datastore', targetId: datastore,
        details: { hostId: req.hostId, path: filePath }, ip: getClientIp(req),
      });
      res.json(result);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  })
);

router.post('/service/:action', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const row = _getVSphereHost(req, res); if (!row) return;
    const { action } = req.params;
    const { serviceKey } = req.body || {};
    if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'invalid action' });
    if (!serviceKey) return res.status(400).json({ error: 'serviceKey is required' });
    try {
      const c = await _getClient(row);
      let moref = req.body.moref;
      if (!moref) { const hosts = await c.listHosts(); moref = hosts[0] && hosts[0].moref; }
      const result = await c.hostServiceAction(moref, serviceKey, action);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: `vsphere_service_${action}`, targetType: 'vsphere_service', targetId: serviceKey,
        details: { hostId: req.hostId }, ip: getClientIp(req),
      });
      res.json(result);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  })
);

// v8.9.14-alpha.4 — SSH esxcli telemetry (hardware sensors / VIBs / NICs /
// system). Read-only. Requires daemon_config.sshConfig on the host + SSH
// enabled on the ESXi host. Returns { sshConfigured:false } (not an error)
// when no SSH config is present, so the UI can show a setup hint.
router.get('/ssh/telemetry', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  let client;
  try { client = require('../services/vsphere-ssh').fromHostRow(row); }
  catch (err) { return res.json({ sshConfigured: false, reason: err.message }); }
  try {
    res.json({ sshConfigured: true, ...(await client.collectAll()) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}));

router.post('/ssh/test', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  let client;
  try { client = require('../services/vsphere-ssh').fromHostRow(row); }
  catch (err) { return res.json({ ok: false, error: err.message }); }
  try { res.json(await client.testSsh()); }
  catch (err) { res.json({ ok: false, error: err.message }); }
}));

// v8.9.13-alpha.1 — metric history for the Trends tab.
router.get('/history', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  const limit = parseInt(req.query.limit, 10) || 500;
  res.json(require('../services/vsphere-history').getHistory(row.id, limit));
}));

// v8.9.12-alpha.1 — Version / EOL / CVE check (ported from SOS ESXi Monitor).
// Resolves the host's version+build (from the ContainerView host list, which
// now carries productVersion + build) and runs it through the offline
// knowledge base. For vCenter with multiple hosts, checks each host.
router.get('/version-check', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    const { checkVersion } = require('../services/esxi-version-db');
    const c = await _getClient(row);
    const hosts = await c.listHosts();
    const results = hosts.map(h => ({
      hostName: h.name,
      version: h.productVersion || null,
      build: h.build || null,
      check: (h.productVersion && h.build) ? checkVersion(h.productVersion, h.build) : null,
    }));
    res.json({ hosts: results });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

module.exports = router;
