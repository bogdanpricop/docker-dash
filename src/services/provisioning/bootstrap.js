'use strict';

// v8.16.0 (Onboarding — Phase 2) — "Onboarding as code": DD_ONBOARD_FILE.
//
// ┌─ THE SECURITY CONTRACT ────────────────────────────────────────────────────┐
// │ This is the ONE provisioning path with no session behind it. It exists so  │
// │ a fresh Compose deployment can come up pre-configured — and for NOTHING    │
// │ else. It is therefore gated to an EMPTY INSTANCE, hard:                    │
// │                                                                            │
// │   !authService.isSetupComplete()                                           │
// │   AND no non-default tenant exists                                         │
// │   AND no provisioning run has ever completed                               │
// │                                                                            │
// │ On a populated instance it REFUSES: logs a clear warning, writes nothing,  │
// │ and returns — it never throws (a bad DD_ONBOARD_FILE must not brick a      │
// │ boot) and never provisions. The authenticated, admin-gated                 │
// │ POST /api/onboarding/apply is the only way to provision a populated        │
// │ instance.                                                                  │
// │                                                                            │
// │ On success it calls authService.completeSetup(), which flips the first     │
// │ gate condition false — so the very same file on the very next boot is a    │
// │ refusal, not a re-apply. Belt (idempotency_key) and braces (the gate).     │
// │                                                                            │
// │ See plans/onboarding-security.md T9 / C7 / TC-06.                          │
// └────────────────────────────────────────────────────────────────────────────┘
//
// The file's CONTENTS are never logged and never audited: a declaration carries
// SSH keys and passwords. Only the tenant slug, the run id and the status are.

const fs = require('fs');
const { getDb } = require('../../db');
const auditService = require('../audit');
const log = require('../../utils/logger')('onboarding-bootstrap');

const MAX_FILE_BYTES = 1024 * 1024;   // 1 MB — a declaration is small; anything larger is abuse
const BOOTSTRAP_ACTOR = 'system-bootstrap';

/**
 * Is this instance still EMPTY, i.e. may an unauthenticated bootstrap run?
 *
 * All three conditions must hold. Any DB error is treated as "not empty"
 * (fail closed) — an unreadable instance is never assumed to be a fresh one.
 *
 * @returns {{empty:boolean, reason?:string}}
 */
function isEmptyInstance() {
  const authService = require('../auth');
  try {
    if (authService.isSetupComplete()) {
      return { empty: false, reason: 'initial setup already completed (setup_completed=true)' };
    }
    const db = getDb();
    const tenants = db.prepare('SELECT COUNT(*) c FROM tenants WHERE is_default = 0').get();
    if (tenants && tenants.c > 0) {
      return { empty: false, reason: `${tenants.c} non-default tenant(s) already exist` };
    }
    const runs = db.prepare("SELECT COUNT(*) c FROM provisioning_runs WHERE status = 'completed'").get();
    if (runs && runs.c > 0) {
      return { empty: false, reason: `${runs.c} provisioning run(s) already completed` };
    }
    return { empty: true };
  } catch (err) {
    return { empty: false, reason: `instance state could not be verified (${err.message})` };
  }
}

/** Read + JSON-parse the declaration file. Throws with context; never logs content. */
function _readDeclarationFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`file not readable: ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`not a regular file: ${filePath}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`file not readable: ${err.code || err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // Deliberately does NOT include the parser's excerpt — it would echo file content.
    throw new Error('file is not valid JSON');
  }
}

/**
 * Apply DD_ONBOARD_FILE if — and only if — the instance is empty.
 * NEVER throws: every outcome is a resolved status object so `start()` can carry
 * on booting.
 *
 * @returns {Promise<{applied:boolean, reason:string, runId?:number, status?:string}>}
 */
async function maybeBootstrap(opts = {}) {
  const filePath = opts.filePath !== undefined ? opts.filePath : process.env.DD_ONBOARD_FILE;
  if (!filePath) return { applied: false, reason: 'not-configured' };

  // ── GATE ──────────────────────────────────────────────────────────────────
  const gate = isEmptyInstance();
  if (!gate.empty) {
    log.warn(
      'REFUSING headless onboarding: DD_ONBOARD_FILE is set but this instance is already provisioned. '
      + `Reason: ${gate.reason}. Nothing was written. `
      + 'Use POST /api/onboarding/apply (admin session) to provision a populated instance, '
      + 'or unset DD_ONBOARD_FILE to silence this warning.',
      { file: filePath },
    );
    return { applied: false, reason: `refused: ${gate.reason}` };
  }

  let declaration;
  try {
    declaration = _readDeclarationFile(filePath);
  } catch (err) {
    log.error('Headless onboarding aborted: DD_ONBOARD_FILE could not be read', { file: filePath, error: err.message });
    return { applied: false, reason: `unreadable: ${err.message}` };
  }

  const provisioning = require('./engine');
  const user = { id: null, username: BOOTSTRAP_ACTOR, role: 'admin' };
  try {
    // validateDeclaration (inside apply) rejects a wire-supplied tenant_id, any
    // proto-polluted key, an over-privileged non-production user, etc. — the file
    // gets EXACTLY the same validation as the REST body.
    const run = await provisioning.apply({ declaration, user, ip: null });
    const authService = require('../auth');
    authService.completeSetup(); // one-shot: the next boot's gate refuses

    auditService.log({
      userId: null,
      username: BOOTSTRAP_ACTOR,
      action: 'onboarding_headless_apply',
      targetType: 'provisioning_run',
      targetId: String(run.id),
      details: {
        source: 'DD_ONBOARD_FILE',
        status: run.status,
        tenantId: run.tenantId,
        tenantSlug: (run.declaration && run.declaration.tenant && run.declaration.tenant.slug) || null,
        // NEVER the file path contents / secrets — the act, not the value.
      },
      ip: null,
    });
    log.info('Headless onboarding applied', { runId: run.id, status: run.status, tenantId: run.tenantId });
    return { applied: true, reason: 'applied', runId: run.id, status: run.status };
  } catch (err) {
    // A failed apply leaves a resumable run; the operator finishes it from the
    // admin UI. Boot continues either way. The message may name a FIELD but the
    // validator never embeds a secret VALUE in its errors.
    log.error('Headless onboarding failed', { file: filePath, error: err.message, runId: err.runId, step: err.step });
    auditService.log({
      userId: null,
      username: BOOTSTRAP_ACTOR,
      action: 'onboarding_headless_apply',
      targetType: 'provisioning_run',
      targetId: err.runId != null ? String(err.runId) : null,
      details: { source: 'DD_ONBOARD_FILE', ok: false, step: err.step || null, error: err.message },
      ip: null,
    });
    return { applied: false, reason: `failed: ${err.message}`, runId: err.runId };
  }
}

module.exports = { maybeBootstrap, isEmptyInstance, BOOTSTRAP_ACTOR, MAX_FILE_BYTES };
