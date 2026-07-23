'use strict';

// Step 4 — create_hosts (kind: EXTERNAL).
//
// Registers docker_hosts rows, reusing the SAME encryptSshConfig +
// field-shaping as routes/hosts.js. Classified `external` because docker_hosts
// is a SHARED-POOL table with no tenant_id — it is NOT covered by the
// create_tenant cascade, so rollback needs an EXPLICIT compensation that deletes
// exactly the rows THIS run created (ids tracked in the checkpoint). Host secrets
// (SSH key/password/passphrase, TLS key) are decrypted from the inline
// declaration secret and re-encrypted into docker_hosts via encryptSshConfig —
// they never appear in the run/step JSON in plaintext.
//
// Idempotency: dedupe by host name — an existing row with the same name is
// ADOPTED (reused=true) rather than duplicated, and reused rows are never
// deleted by compensation. Phase 1 does NOT open SSH tunnels or probe
// connectivity (deferred hardening); it only registers the host row.

const { encryptSshConfig } = require('../../host-config-crypto');

const SOCKET_RE = /^\/[a-zA-Z0-9_./-]+$/;
const DEFAULT_SOCKET = '/var/run/docker.sock';

module.exports = {
  key: 'create_hosts',
  kind: 'external',

  async run(ctx) {
    const { db, decl } = ctx;
    const created = [];

    for (const h of decl.hosts) {
      const existing = db.prepare('SELECT id FROM docker_hosts WHERE name = ?').get(h.name);
      if (existing) {
        created.push({ id: existing.id, name: h.name, reused: true });
        continue;
      }

      const s = h.secret || {};
      let sshConfig = null;
      let tlsConfig = null;
      const effectiveSocket = h.sshDockerSocket || DEFAULT_SOCKET;

      if (h.connectionType === 'ssh') {
        if (!SOCKET_RE.test(effectiveSocket)) throw new Error(`host ${h.name}: invalid dockerSocket path`);
        sshConfig = encryptSshConfig({
          host: h.sshHost,
          port: h.sshPort || 22,
          username: h.sshUsername,
          password: ctx.reveal(s.sshPassword) || undefined,
          privateKey: ctx.reveal(s.sshPrivateKey) || undefined,
          passphrase: ctx.reveal(s.sshPassphrase) || undefined,
          dockerSocket: effectiveSocket,
        });
      } else if (h.connectionType === 'tcp' && h.tlsCa) {
        tlsConfig = JSON.stringify({ ca: h.tlsCa, cert: h.tlsCert, key: ctx.reveal(s.tlsKey) });
      }

      const r = db.prepare(`
        INSERT INTO docker_hosts (name, connection_type, socket_path, host, port, tls_config, ssh_config, is_active, is_default)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
      `).run(
        h.name,
        h.connectionType,
        h.socketPath || DEFAULT_SOCKET,
        h.host || null,
        h.port || null,
        tlsConfig,
        sshConfig,
      );
      const id = Number(r.lastInsertRowid);
      created.push({ id, name: h.name, reused: false });
      // Reuse the existing host_create audit action — details carry NO secrets.
      ctx.audit('host_create', 'host', String(id), { name: h.name, connectionType: h.connectionType });
    }

    return { hosts: created };
  },

  async compensate(ctx, cp) {
    const { db } = ctx;
    for (const h of (cp && cp.hosts) || []) {
      if (h.reused) continue; // never delete a row we merely adopted
      try {
        db.prepare('DELETE FROM docker_hosts WHERE id = ?').run(h.id); // idempotent (no-op if gone)
      } catch (err) {
        ctx.log.warn('create_hosts compensate: failed to delete host', { id: h.id, error: err.message });
      }
    }
  },

  estimate(ctx) {
    return { hosts: (ctx.decl && ctx.decl.hosts ? ctx.decl.hosts.length : 0) };
  },
};
