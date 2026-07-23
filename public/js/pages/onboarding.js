/* ═══════════════════════════════════════════════════
   pages/onboarding.js — Onboarding & Provisioning Wizard (v8.15.0, Phase 1)
   ═══════════════════════════════════════════════════ */
'use strict';

// Drives POST /api/onboarding/{plan,apply} and GET/POST /api/onboarding/runs/*
// (src/routes/onboarding.js) through the generic Wizard primitive
// (components/wizard.js). Builds an onboarding-declaration v1 document
// exactly per src/services/provisioning/declaration.js and never persists a
// secret client-side — plaintext secret values live only in this in-memory
// state for the duration of the session and are sent once, over the wire, to
// the admin-only apply endpoint (encrypted server-side on ingest).
//
// Phase 1 backend reality (adapts the aspirational UX spec in
// plans/onboarding-ux.md to what actually exists):
//   - No draft-persistence endpoint exists yet — there is no POST that
//     creates a "pending" provisioning_runs row before apply(). So this
//     wizard's builder steps (0-5) live in memory only; "persist" debounces
//     a NON-secret snapshot to sessionStorage (survives a same-tab reload,
//     never a secret). The one true "Resume" the backend supports is of an
//     already-started run (GET /runs/active) — i.e. resuming PROVISIONING
//     PROGRESS, not resuming mid-edit of the builder.
//   - No slug/username uniqueness-check endpoints exist. Slug format is
//     validated client-side only; create_tenant.js actually ADOPTS an
//     existing tenant with the same slug (idempotent upsert) rather than
//     rejecting it, so there is no "taken" error to surface at all.
//   - declaration.js only allows hosts[].connectionType in
//     {socket, tcp, ssh} — no hypervisor daemon types in Phase 1.
//   - There is no "invite" flow in Phase 1 (create_hosts/create_users run
//     synchronously inside apply()) — every NEW user needs a set password.

// ── Module catalog (mirrors src/services/provisioning/catalog.js) ─────────
const ONBOARDING_MODULE_CATALOG = [
  { key: 'hosts', requires: [], core: true, defaultOn: true },
  { key: 'firewall', requires: ['hosts'], defaultOn: true },
  { key: 'posture', requires: ['hosts'], defaultOn: true },
  { key: 'reconciler', requires: ['hosts'], defaultOn: true },
  { key: 'registries', requires: [], defaultOn: false },
  { key: 'git', requires: [], defaultOn: false },
  { key: 'teams', requires: [], defaultOn: false },
  { key: 'copilot', requires: [], defaultOn: false },
];

// The saga's step order (src/services/provisioning/steps/index.js) — used to
// render the Provision checklist even before any provisioning_steps rows exist.
// `seed_mock_data` is CONDITIONAL: the server only builds it for demo/trial runs
// (steps/index.js STEP_PREDICATES), so the checklist mirrors that.
const ONBOARDING_RUN_STEP_KEYS = [
  'create_tenant', 'set_regional', 'seed_nomenclatures', 'enable_modules', 'create_hosts',
  'create_users', 'grant_permissions', 'finalize',
];
function _obRunStepKeys(mode) {
  if (mode === 'production') return ONBOARDING_RUN_STEP_KEYS;
  const keys = ONBOARDING_RUN_STEP_KEYS.slice();
  keys.splice(keys.indexOf('finalize'), 0, 'seed_mock_data');
  return keys;
}

// Mock-data presets. Volume can ONLY be chosen from these fixed profiles (a
// free-form row count would be an unbounded-volume vector); the server validates
// the same closed sets in declaration.js.
const ONBOARDING_SEED_PROFILES = ['small', 'medium', 'large'];
const ONBOARDING_SEED_SCENARIOS = ['healthy-shop', 'busy-estate', 'multi-daemon-plant'];

// Reserved template keys the server treats as "no template" (template-merge.js
// RESERVED_NOOP_KEYS). `custom` is what the picker sends for "Custom / blank".
const ONBOARDING_NOOP_TEMPLATE = 'custom';

// ── small helpers ───────────────────────────────────────────────────────────

function _obUuid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function _obSlugify(name) {
  let s = (name || '').toString().toLowerCase().trim()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length < 2) s = (s + '-org').slice(0, 20);
  return s.slice(0, 63);
}

function _obDeriveRegionalDefaults() {
  let locale = 'en-US';
  let timezone = 'UTC';
  try {
    const opts = Intl.DateTimeFormat().resolvedOptions();
    if (opts.locale) locale = opts.locale;
    if (opts.timeZone) timezone = opts.timeZone;
  } catch { /* Intl not fully available — keep fallbacks */ }
  const region = (locale.split('-')[1] || '').toUpperCase();
  const CURRENCY_BY_REGION = {
    US: 'USD', GB: 'GBP', RO: 'RON', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR',
    PT: 'EUR', NL: 'EUR', IE: 'EUR', JP: 'JPY', CN: 'CNY', KR: 'KRW', CA: 'CAD',
    AU: 'AUD', CH: 'CHF', IN: 'INR', BR: 'BRL', MX: 'MXN', PL: 'PLN',
  };
  const currency = CURRENCY_BY_REGION[region] || 'USD';
  const unitSystem = (region === 'US' || region === 'LR' || region === 'MM') ? 'imperial' : 'metric';
  const dateFormat = region === 'US' ? 'MM/DD/YYYY' : (region === 'GB' ? 'DD/MM/YYYY' : (region ? 'DD.MM.YYYY' : 'YYYY-MM-DD'));
  let numberFormat = '1,234.56';
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234.5);
    const group = (parts.find((p) => p.type === 'group') || {}).value;
    const decimal = (parts.find((p) => p.type === 'decimal') || {}).value;
    if (group === '.' && decimal === ',') numberFormat = '1.234,56';
    else if (group === ' ' && decimal === ',') numberFormat = '1 234,56';
  } catch { /* keep default */ }
  return { locale, timezone, currency, unitSystem, dateFormat, numberFormat };
}

let _obHostSeq = 0;
function _obBlankHostRow() {
  _obHostSeq += 1;
  return {
    _rid: _obHostSeq,
    name: `host-${_obHostSeq}`,
    connectionType: 'socket',
    socketPath: '/var/run/docker.sock',
    host: '', port: 2376,
    tlsCa: '', tlsCert: '', tlsKey: '',
    sshHost: '', sshPort: 22, sshUsername: 'root', sshPassword: '', sshPrivateKey: '', sshPassphrase: '',
    sshDockerSocket: '/var/run/docker.sock',
    _probe: { status: 'idle' },
  };
}

let _obUserSeq = 0;
function _obBlankUserRow() {
  _obUserSeq += 1;
  return { _rid: _obUserSeq, username: '', displayName: '', email: '', role: 'viewer', isOwner: false, password: '', _confirmPassword: '' };
}

function _obOwnerRow() {
  const u = (window.App && App.user) || {};
  return {
    _rid: 0, username: u.username || 'admin', displayName: u.displayName || u.username || '', email: u.email || '',
    role: 'admin', isOwner: true, password: '', _confirmPassword: '', _existing: true,
  };
}

/** Build the exact onboarding-declaration v1 document (declaration.js contract). */
function buildOnboardingDeclaration(state) {
  const hosts = state.hosts.map((h) => {
    const out = { name: h.name, connectionType: h.connectionType };
    const secret = {};
    if (h.connectionType === 'socket') {
      out.socketPath = h.socketPath || '/var/run/docker.sock';
    } else if (h.connectionType === 'tcp') {
      out.host = h.host || '';
      out.port = h.port ? Number(h.port) : 2376;
      if (h.tlsCa) {
        out.tlsCa = h.tlsCa;
        out.tlsCert = h.tlsCert || '';
        if (h.tlsKey) secret.tlsKey = h.tlsKey;
      }
    } else if (h.connectionType === 'ssh') {
      out.sshHost = h.sshHost || '';
      out.sshPort = h.sshPort ? Number(h.sshPort) : 22;
      out.sshUsername = h.sshUsername || '';
      out.sshDockerSocket = h.sshDockerSocket || '/var/run/docker.sock';
      if (h.sshPassword) secret.sshPassword = h.sshPassword;
      if (h.sshPrivateKey) secret.sshPrivateKey = h.sshPrivateKey;
      if (h.sshPassphrase) secret.sshPassphrase = h.sshPassphrase;
    }
    if (Object.keys(secret).length) out.secret = secret;
    return out;
  });

  const users = state.users.map((u) => {
    const out = { username: u.username, role: u.role, isOwner: !!u.isOwner };
    if (u.displayName) out.displayName = u.displayName;
    if (u.email) out.email = u.email;
    if (!u._existing && u.password) out.password = u.password;
    return out;
  });

  const permissions = (state.permissions || []).map((p) => ({ username: p.username, hostName: p.hostName, permission: p.permission }));

  // The mock-data block exists ONLY for demo/trial — declaration.js rejects it
  // outright in production, so never send it there.
  const mockData = state.mode === 'production' ? undefined : {
    profile: state.mockData.profile,
    scenario: state.mockData.scenario,
    ...(state.mockData.seed ? { seed: String(state.mockData.seed) } : {}),
  };

  return {
    version: 1,
    kind: 'onboarding-declaration',
    idempotencyKey: state.idempotencyKey,
    template: state.templateKey || ONBOARDING_NOOP_TEMPLATE,
    mode: state.mode,
    tenant: { slug: state.tenant.slug, name: state.tenant.name, kind: state.tenant.kind },
    regional: { ...state.regional },
    ...(mockData ? { mockData } : {}),
    modules: state.modules.map((m) => ({ key: m.key, enabled: !!m.enabled })),
    // Sent explicitly so what the user SAW on the Regional step is exactly what
    // is applied; the server merges the template's own list underneath anyway
    // (template-merge.js) — same (kind, code) entries collapse, ours win.
    nomenclatures: (state.nomenclatures || []).map((n) => ({ kind: n.kind, code: n.code, label: n.label, sort: n.sort || 0 })),
    hosts,
    users,
    permissions,
  };
}

// ── template helpers ────────────────────────────────────────────────────────

/** The currently-selected template record, or null for "Custom / blank". */
function _obSelectedTemplate(state) {
  if (!state.templateKey || state.templateKey === ONBOARDING_NOOP_TEMPLATE) return null;
  return (state._templates || []).find((t) => t.key === state.templateKey) || null;
}

/**
 * Reflect a template's defaults in the UI. The AUTHORITATIVE merge is
 * server-side (template-merge.js); this only mirrors it so the later steps
 * aren't blank. User edits made after this point still win — the server merges
 * the template UNDER whatever the declaration carries.
 */
function _obApplyTemplateToState(state, tpl) {
  state.templateKey = tpl ? tpl.key : ONBOARDING_NOOP_TEMPLATE;
  state.nomenclatures = [];
  if (!tpl) return;
  const spec = tpl.spec || {};
  if (spec.tenant && spec.tenant.kind && !state._kindManuallyEdited) state.tenant.kind = spec.tenant.kind;
  if (spec.regional) state.regional = Object.assign({}, state.regional, spec.regional);
  if (Array.isArray(spec.modules) && spec.modules.length) {
    const wanted = new Map(spec.modules.map((m) => [m.key, m.enabled !== false]));
    state.modules = ONBOARDING_MODULE_CATALOG.map((m) => ({
      key: m.key,
      enabled: wanted.has(m.key) ? wanted.get(m.key) : false,
    }));
    // Close the dependency graph client-side so the checkboxes agree with the
    // server's resolveDependencies() closure.
    ONBOARDING_MODULE_CATALOG.forEach((m) => {
      const on = state.modules.find((x) => x.key === m.key);
      if (on && on.enabled) (m.requires || []).forEach((dep) => {
        const d = state.modules.find((x) => x.key === dep);
        if (d) d.enabled = true;
      });
    });
  }
  if (Array.isArray(spec.nomenclatures)) {
    state.nomenclatures = spec.nomenclatures.map((n) => ({ kind: n.kind, code: n.code, label: n.label, sort: n.sort || 0 }));
  }
}

function _obHostProbeBadge(probe) {
  const p = probe || { status: 'idle' };
  if (p.status === 'testing') return `<span class="badge badge-info"><i class="fas fa-spinner fa-spin"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.servers.testing'))}</span>`;
  if (p.status === 'ok') return `<span class="badge badge-running"><i class="fas fa-check"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.servers.connected'))}${p.message ? ` — ${Utils.escapeHtml(p.message)}` : ''}</span>`;
  if (p.status === 'failed') return `<span class="badge badge-stopped"><i class="fas fa-times"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.servers.failed'))}${p.message ? ` — ${Utils.escapeHtml(p.message)}` : ''}</span>`;
  return `<span class="badge">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.notTested'))}</span>`;
}

function _obModePillFor(state) {
  const cls = state.mode === 'demo' ? 'badge-warning' : state.mode === 'trial' ? 'badge-info' : 'badge-running';
  return { text: i18n.t(`pages.onboarding.mode.${state.mode}`), className: cls };
}

function _obGuessStepForWarning(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('owner') || m.includes('user')) return 'users';
  if (m.includes('host')) return 'servers';
  if (m.includes('mode')) return 'mode';
  return null;
}

function _obNonSecretSnapshot(state) {
  // Strips every secret-bearing field before anything touches sessionStorage.
  return {
    idempotencyKey: state.idempotencyKey,
    mode: state.mode,
    templateKey: state.templateKey,
    tenant: state.tenant,
    regional: state.regional,
    modules: state.modules,
    nomenclatures: state.nomenclatures,
    hosts: state.hosts.map((h) => ({ name: h.name, connectionType: h.connectionType, socketPath: h.socketPath, host: h.host, port: h.port, sshHost: h.sshHost, sshPort: h.sshPort, sshUsername: h.sshUsername, sshDockerSocket: h.sshDockerSocket })),
    users: state.users.map((u) => ({ username: u.username, displayName: u.displayName, email: u.email, role: u.role, isOwner: u.isOwner, _existing: u._existing })),
    permissions: state.permissions,
    // Mock-data choices carry no secret and no PII — safe to draft-persist.
    mockData: state.mockData ? { profile: state.mockData.profile, scenario: state.mockData.scenario, seed: state.mockData.seed } : undefined,
  };
}

// ── step 0 — mode & template ────────────────────────────────────────────────
const _stepMode = {
  key: 'mode',
  get title() { return i18n.t('pages.onboarding.mode.title'); },
  onEnter(state, wiz) {
    if (state._templates || state._templatesLoading) return;
    state._templatesLoading = true;
    state._templatesError = null;
    (async () => {
      try {
        const r = await Api.listOnboardingTemplates();
        state._templates = (r && r.templates) || [];
      } catch (err) {
        state._templates = [];
        state._templatesError = err.message;
      } finally {
        state._templatesLoading = false;
        wiz.render();
      }
    })();
  },
  render(body, state, wiz) {
    // v8.17.0 (Phase 3) — demo and trial are live. Selecting either activates
    // wizard step 7 (Mock data); switching back to production deactivates it and
    // the declaration drops the mockData block entirely.
    const modes = ['production', 'trial', 'demo'];
    const icon = { production: 'fa-server', trial: 'fa-hourglass-half', demo: 'fa-flask' };
    body.innerHTML = `
      <p class="wiz-step-help">${Utils.escapeHtml(i18n.t('pages.onboarding.mode.help'))}</p>
      <div class="wiz-radio-group" role="radiogroup" aria-label="${Utils.escapeHtml(i18n.t('pages.onboarding.mode.title'))}">
        ${modes.map((m) => `
          <label class="wiz-radio-card ${state.mode === m ? 'is-selected' : ''}">
            <input type="radio" name="ob-mode" value="${m}" ${state.mode === m ? 'checked' : ''}>
            <div class="wiz-radio-card-title"><i class="fas ${icon[m]}"></i> ${Utils.escapeHtml(i18n.t(`pages.onboarding.mode.${m}`))}</div>
            <div class="wiz-radio-card-desc">${Utils.escapeHtml(i18n.t(`pages.onboarding.mode.${m}Desc`))}</div>
          </label>`).join('')}
      </div>
      ${state.mode !== 'production' ? `
      <div class="alert" style="background:var(--surface2);padding:10px 14px;border-radius:var(--radius-sm);margin-top:10px">
        <i class="fas fa-flask"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.mode.syntheticNotice'))}
      </div>` : ''}
      <label style="display:block;margin:20px 0 8px;font-size:11px;font-weight:600;color:var(--text-dim)">${Utils.escapeHtml(i18n.t('pages.onboarding.mode.template'))}</label>
      <div class="wiz-radio-group" role="radiogroup" aria-label="${Utils.escapeHtml(i18n.t('pages.onboarding.mode.template'))}">
        <label class="wiz-radio-card ${state.templateKey === ONBOARDING_NOOP_TEMPLATE ? 'is-selected' : ''}">
          <input type="radio" name="ob-template" value="${ONBOARDING_NOOP_TEMPLATE}" ${state.templateKey === ONBOARDING_NOOP_TEMPLATE ? 'checked' : ''}>
          <div class="wiz-radio-card-title"><i class="fas fa-sliders"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.mode.templateCustom'))}</div>
          <div class="wiz-radio-card-desc">${Utils.escapeHtml(i18n.t('pages.onboarding.mode.templateCustomDesc'))}</div>
        </label>
        ${(state._templates || []).map((t) => `
          <label class="wiz-radio-card ${state.templateKey === t.key ? 'is-selected' : ''}">
            <input type="radio" name="ob-template" value="${Utils.escapeHtml(t.key)}" ${state.templateKey === t.key ? 'checked' : ''}>
            <div class="wiz-radio-card-title"><i class="fas fa-layer-group"></i> ${Utils.escapeHtml(t.name)}
              ${t.industry ? `<span class="badge badge-info" style="margin-left:6px">${Utils.escapeHtml(t.industry)}</span>` : ''}
              ${t.isBuiltin ? '' : `<span class="badge" style="margin-left:6px">${Utils.escapeHtml(i18n.t('pages.onboarding.mode.templateCustomBadge'))}</span>`}
            </div>
            <div class="wiz-radio-card-desc">${Utils.escapeHtml(t.description || '')}</div>
            <div class="text-sm text-dim">${Utils.escapeHtml(i18n.t('pages.onboarding.mode.templateMeta', {
              version: t.version,
              modules: ((t.spec && t.spec.modules) || []).length,
              nomenclatures: ((t.spec && t.spec.nomenclatures) || []).length,
            }))}</div>
          </label>`).join('')}
      </div>
      ${state._templatesLoading ? `<div class="text-sm text-dim"><i class="fas fa-spinner fa-spin"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.mode.templatesLoading'))}</div>` : ''}
      ${state._templatesError ? `<div class="text-sm" style="color:var(--yellow)"><i class="fas fa-triangle-exclamation"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.mode.templatesError', { error: state._templatesError }))}</div>` : ''}
    `;
    body.querySelectorAll('input[name="ob-mode"]').forEach((r) => r.addEventListener('change', () => {
      if (r.disabled || !r.checked) return;
      state.mode = r.value;
      // Sensible per-mode default volume: trial is "real but empty-ish", demo is
      // the populated showcase (plans/onboarding-ux.md step 7 defaults).
      state.mockData.profile = r.value === 'trial' ? 'small' : 'medium';
      state._seedCatalog = null; // re-estimate for the new default
      state._plan = null;
      wiz.render();
    }));
    body.querySelectorAll('input[name="ob-template"]').forEach((r) => r.addEventListener('change', () => {
      if (r.disabled || !r.checked) return;
      const tpl = (state._templates || []).find((t) => t.key === r.value) || null;
      _obApplyTemplateToState(state, tpl);
      state._plan = null; // the impact estimate changes with the template
      wiz.render();
    }));
  },
  validate() { return { ok: true }; },
};

// ── step 1 — organization & tenant identity ─────────────────────────────────
const _stepIdentity = {
  key: 'identity',
  get title() { return i18n.t('pages.onboarding.identity.title'); },
  get help() { return i18n.t('pages.onboarding.identity.help'); },
  render(body, state, wiz) {
    body.innerHTML = `
      <div class="form-group">
        <label for="ob-id-name">${Utils.escapeHtml(i18n.t('pages.onboarding.identity.name'))}</label>
        <input type="text" id="ob-id-name" class="form-control" value="${Utils.escapeHtml(state.tenant.name)}">
      </div>
      <div class="form-group">
        <label for="ob-id-slug">${Utils.escapeHtml(i18n.t('pages.onboarding.identity.slug'))}</label>
        <input type="text" id="ob-id-slug" class="form-control mono" value="${Utils.escapeHtml(state.tenant.slug)}" aria-describedby="ob-id-slug-help">
        <small id="ob-id-slug-help" class="text-muted">${Utils.escapeHtml(i18n.t('pages.onboarding.identity.slugHelp'))}</small>
      </div>
      <div class="form-group">
        <label for="ob-id-kind">${Utils.escapeHtml(i18n.t('pages.onboarding.identity.kind'))}</label>
        <select id="ob-id-kind" class="form-control">
          <option value="internal" ${state.tenant.kind === 'internal' ? 'selected' : ''}>${Utils.escapeHtml(i18n.t('pages.onboarding.identity.kindInternal'))}</option>
          <option value="client" ${state.tenant.kind === 'client' ? 'selected' : ''}>${Utils.escapeHtml(i18n.t('pages.onboarding.identity.kindClient'))}</option>
          <option value="plant" ${state.tenant.kind === 'plant' ? 'selected' : ''}>${Utils.escapeHtml(i18n.t('pages.onboarding.identity.kindPlant'))}</option>
        </select>
      </div>
    `;
    const nameEl = body.querySelector('#ob-id-name');
    const slugEl = body.querySelector('#ob-id-slug');
    const kindEl = body.querySelector('#ob-id-kind');
    nameEl.addEventListener('input', () => {
      state.tenant.name = nameEl.value;
      if (!state._slugManuallyEdited) {
        state.tenant.slug = _obSlugify(nameEl.value);
        slugEl.value = state.tenant.slug;
      }
    });
    slugEl.addEventListener('input', () => {
      state._slugManuallyEdited = true;
      state.tenant.slug = slugEl.value.toLowerCase();
    });
    kindEl.addEventListener('change', () => { state.tenant.kind = kindEl.value; state._kindManuallyEdited = true; });
  },
  validate(state) {
    const errors = [];
    const name = (state.tenant.name || '').trim();
    if (name.length < 2 || name.length > 80) errors.push(i18n.t('pages.onboarding.errors.nameInvalid'));
    const slug = (state.tenant.slug || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) errors.push(i18n.t('pages.onboarding.errors.slugInvalid'));
    if (!['client', 'plant', 'internal'].includes(state.tenant.kind)) errors.push(i18n.t('pages.onboarding.errors.kindInvalid'));
    return { ok: errors.length === 0, errors };
  },
  onLeave(state) { state._plan = null; },
};

// ── step 2 — regional ────────────────────────────────────────────────────────
const _stepRegional = {
  key: 'regional',
  get title() { return i18n.t('pages.onboarding.regional.title'); },
  get help() { return i18n.t('pages.onboarding.regional.help'); },
  onEnter(state) {
    if (!state.regional || !state.regional.locale) {
      state.regional = Object.assign(_obDeriveRegionalDefaults(), state.regional || {});
    }
  },
  render(body, state, wiz) {
    const r = state.regional;
    const currencies = ['USD', 'EUR', 'GBP', 'RON', 'JPY', 'CNY', 'CHF', 'CAD', 'AUD', 'INR', 'BRL', 'MXN', 'PLN', 'KRW'];
    body.innerHTML = `
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:160px">
          <label for="ob-rg-locale">${Utils.escapeHtml(i18n.t('pages.onboarding.regional.locale'))}</label>
          <input type="text" id="ob-rg-locale" class="form-control" value="${Utils.escapeHtml(r.locale)}" placeholder="en-US">
        </div>
        <div class="form-group" style="flex:1;min-width:160px">
          <label for="ob-rg-timezone">${Utils.escapeHtml(i18n.t('pages.onboarding.regional.timezone'))}</label>
          <input type="text" id="ob-rg-timezone" class="form-control" value="${Utils.escapeHtml(r.timezone)}" placeholder="Europe/Bucharest">
        </div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:140px">
          <label for="ob-rg-currency">${Utils.escapeHtml(i18n.t('pages.onboarding.regional.currency'))}</label>
          <select id="ob-rg-currency" class="form-control">
            ${currencies.map((c) => `<option value="${c}" ${r.currency === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="flex:1;min-width:160px">
          <label>${Utils.escapeHtml(i18n.t('pages.onboarding.regional.unitSystem'))}</label>
          <div style="display:flex;gap:6px">
            <button type="button" class="btn btn-sm ${r.unitSystem === 'metric' ? 'btn-primary' : 'btn-secondary'}" data-unit="metric">${Utils.escapeHtml(i18n.t('pages.onboarding.regional.metric'))}</button>
            <button type="button" class="btn btn-sm ${r.unitSystem === 'imperial' ? 'btn-primary' : 'btn-secondary'}" data-unit="imperial">${Utils.escapeHtml(i18n.t('pages.onboarding.regional.imperial'))}</button>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:160px">
          <label for="ob-rg-dateformat">${Utils.escapeHtml(i18n.t('pages.onboarding.regional.dateFormat'))}</label>
          <select id="ob-rg-dateformat" class="form-control">
            ${['DD.MM.YYYY', 'MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'].map((f) => `<option value="${f}" ${r.dateFormat === f ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="flex:1;min-width:160px">
          <label for="ob-rg-numberformat">${Utils.escapeHtml(i18n.t('pages.onboarding.regional.numberFormat'))}</label>
          <select id="ob-rg-numberformat" class="form-control">
            ${['1,234.56', '1.234,56', '1 234,56'].map((f) => `<option value="${f}" ${r.numberFormat === f ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
        </div>
      </div>
      ${_obRenderNomenclatures(state)}
    `;
    body.querySelector('#ob-rg-locale').addEventListener('input', (e) => { r.locale = e.target.value; });
    body.querySelector('#ob-rg-timezone').addEventListener('input', (e) => { r.timezone = e.target.value; });
    body.querySelector('#ob-rg-currency').addEventListener('change', (e) => { r.currency = e.target.value; });
    body.querySelector('#ob-rg-dateformat').addEventListener('change', (e) => { r.dateFormat = e.target.value; });
    body.querySelector('#ob-rg-numberformat').addEventListener('change', (e) => { r.numberFormat = e.target.value; });
    body.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => { r.unitSystem = b.getAttribute('data-unit'); wiz.render(); }));
  },
  validate(state) {
    const r = state.regional || {};
    const errors = [];
    if (!r.locale) errors.push(i18n.t('pages.onboarding.errors.localeRequired'));
    if (!r.timezone) errors.push(i18n.t('pages.onboarding.errors.timezoneRequired'));
    if (!r.currency || r.currency.length !== 3) errors.push(i18n.t('pages.onboarding.errors.currencyInvalid'));
    if (!['metric', 'imperial'].includes(r.unitSystem)) errors.push(i18n.t('pages.onboarding.errors.unitsInvalid'));
    return { ok: errors.length === 0, errors };
  },
  onLeave(state) { state._plan = null; },
};

/**
 * Read-only view of the nomenclatures the selected template will seed. They are
 * applied by the server's `seed_nomenclatures` step; editing them is Phase 4.
 */
function _obRenderNomenclatures(state) {
  const list = state.nomenclatures || [];
  if (!list.length) return '';
  const tpl = _obSelectedTemplate(state);
  const byKind = {};
  list.forEach((n) => { (byKind[n.kind] = byKind[n.kind] || []).push(n); });
  return `
    <hr style="border-color:var(--border);margin:18px 0">
    <h3 style="font-size:14px;margin-bottom:4px">${Utils.escapeHtml(i18n.t('pages.onboarding.regional.nomenclaturesTitle'))}</h3>
    <p class="text-sm text-dim">${Utils.escapeHtml(i18n.t('pages.onboarding.regional.nomenclaturesHelp', {
      template: (tpl && tpl.name) || '—', count: list.length,
    }))}</p>
    <table class="data-table"><tbody>
      ${Object.keys(byKind).sort().map((kind) => `
        <tr>
          <td style="white-space:nowrap"><span class="badge badge-info">${Utils.escapeHtml(kind)}</span></td>
          <td>${byKind[kind].map((n) => `<span class="badge" style="margin:2px" title="${Utils.escapeHtml(n.code)}">${Utils.escapeHtml(n.label)}</span>`).join('')}</td>
        </tr>`).join('')}
    </tbody></table>
  `;
}

// ── step 3 — modules ─────────────────────────────────────────────────────────
const _stepModules = {
  key: 'modules',
  get title() { return i18n.t('pages.onboarding.modules.title'); },
  get help() { return i18n.t('pages.onboarding.modules.help'); },
  render(body, state, wiz) {
    body.innerHTML = `
      <div class="wiz-module-grid">
        ${ONBOARDING_MODULE_CATALOG.map((m) => {
          const modState = state.modules.find((x) => x.key === m.key);
          const enabled = !!(modState && modState.enabled);
          const requiredBy = ONBOARDING_MODULE_CATALOG.filter((d) => d.requires.includes(m.key) && state.modules.find((x) => x.key === d.key && x.enabled));
          return `
          <label class="wiz-module-card ${enabled ? 'is-on' : ''}">
            <input type="checkbox" data-module="${m.key}" ${enabled ? 'checked' : ''} ${requiredBy.length ? 'disabled' : ''}>
            <div class="wiz-module-title"><i class="fas fa-cube"></i> ${Utils.escapeHtml(i18n.t(`pages.onboarding.modules.catalog.${m.key}.label`))}</div>
            <div class="wiz-module-desc">${Utils.escapeHtml(i18n.t(`pages.onboarding.modules.catalog.${m.key}.desc`))}</div>
            ${m.requires.length ? `<div class="text-sm text-dim">${Utils.escapeHtml(i18n.t('pages.onboarding.modules.dependsOn', { modules: m.requires.join(', ') }))}</div>` : ''}
            ${requiredBy.length ? `<span class="badge badge-info" style="margin-top:4px">${Utils.escapeHtml(i18n.t('pages.onboarding.modules.requiredBy', { modules: requiredBy.map((d) => d.key).join(', ') }))}</span>` : ''}
            ${(m.key === 'copilot' && enabled) ? `<div class="text-sm" style="color:var(--yellow);margin-top:4px"><i class="fas fa-triangle-exclamation"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.modules.aiExternalWarning'))}</div>` : ''}
          </label>`;
        }).join('')}
      </div>
    `;
    body.querySelectorAll('[data-module]').forEach((cb) => cb.addEventListener('change', () => _obToggleModule(cb.getAttribute('data-module'), cb.checked, state, wiz)));
  },
  validate(state) {
    const errors = [];
    if (!state.modules.some((m) => m.enabled)) errors.push(i18n.t('pages.onboarding.errors.modulesRequired'));
    return { ok: errors.length === 0, errors };
  },
  onLeave(state) { state._plan = null; },
};

function _obToggleModule(key, on, state, wiz) {
  const modState = state.modules.find((m) => m.key === key);
  if (!modState) return;
  modState.enabled = on;
  if (on) {
    const cat = ONBOARDING_MODULE_CATALOG.find((m) => m.key === key);
    (cat.requires || []).forEach((dep) => {
      const depState = state.modules.find((m) => m.key === dep);
      if (depState) depState.enabled = true;
    });
    wiz.render();
    return;
  }
  const dependents = ONBOARDING_MODULE_CATALOG.filter((m) => m.requires.includes(key) && state.modules.find((x) => x.key === m.key && x.enabled));
  if (!dependents.length) { wiz.render(); return; }
  Modal.confirm(i18n.t('pages.onboarding.modules.disableDependentsConfirm', { modules: dependents.map((d) => d.key).join(', ') }), { danger: false }).then((ok) => {
    if (ok) dependents.forEach((d) => { const s = state.modules.find((x) => x.key === d.key); if (s) s.enabled = false; });
    else modState.enabled = true;
    wiz.render();
  });
}

// ── step 4 — servers & connections ──────────────────────────────────────────
const _stepServers = {
  key: 'servers',
  get title() { return i18n.t('pages.onboarding.servers.title'); },
  get help() { return i18n.t('pages.onboarding.servers.help'); },
  active() { return true; },
  optional(state) { return state.mode !== 'production'; },
  render(body, state, wiz) {
    body.innerHTML = `
      <div id="ob-host-rows">${state.hosts.map((h, i) => _obRenderHostRow(h, i, state)).join('')}</div>
      <button type="button" class="btn btn-sm btn-primary" id="ob-host-add"><i class="fas fa-plus"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.servers.addHost'))}</button>
      ${state.mode === 'production' ? `<div class="text-sm text-dim" style="margin-top:10px">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.prodNeedsHost'))}</div>` : ''}
      <div class="text-sm text-dim" style="margin-top:6px" id="ob-host-summary"></div>
    `;
    _obWireHostRows(body, state, wiz);
    _obUpdateHostSummary(body, state);
    body.querySelector('#ob-host-add').addEventListener('click', () => { state.hosts.push(_obBlankHostRow()); wiz.render(); });
  },
  validate(state) {
    const errors = [];
    const names = new Set();
    state.hosts.forEach((h) => {
      const name = (h.name || '').trim();
      if (!name) errors.push(i18n.t('pages.onboarding.errors.hostNameRequired'));
      else if (names.has(name.toLowerCase())) errors.push(i18n.t('pages.onboarding.errors.hostNameDuplicate', { name }));
      names.add(name.toLowerCase());
      if (h.connectionType === 'tcp' && !h.host) errors.push(i18n.t('pages.onboarding.errors.hostAddressRequired', { name: name || '?' }));
      if (h.connectionType === 'ssh' && (!h.sshHost || !h.sshUsername)) errors.push(i18n.t('pages.onboarding.errors.hostSshRequired', { name: name || '?' }));
    });
    if (state.mode === 'production' && !state.hosts.some((h) => h._probe && h._probe.status === 'ok')) {
      errors.push(i18n.t('pages.onboarding.errors.prodNeedsHostBlock'));
    }
    return { ok: errors.length === 0, errors };
  },
  onLeave(state) { state._plan = null; },
};

function _obRenderHostRow(row, i, state) {
  const ct = row.connectionType;
  return `
    <div class="card wiz-row-card" data-row-idx="${i}">
      <div class="card-body">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div class="form-group" style="flex:1;min-width:160px;margin-bottom:10px">
            <label for="ob-host-name-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.hostName'))}</label>
            <input type="text" id="ob-host-name-${i}" class="form-control" value="${Utils.escapeHtml(row.name)}">
          </div>
          <div class="form-group" style="flex:1;min-width:160px;margin-bottom:10px">
            <label for="ob-host-type-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.connectionType'))}</label>
            <select id="ob-host-type-${i}" class="form-control">
              <option value="socket" ${ct === 'socket' ? 'selected' : ''}>${Utils.escapeHtml(i18n.t('pages.onboarding.servers.connSocket'))}</option>
              <option value="tcp" ${ct === 'tcp' ? 'selected' : ''}>${Utils.escapeHtml(i18n.t('pages.onboarding.servers.connTcp'))}</option>
              <option value="ssh" ${ct === 'ssh' ? 'selected' : ''}>${Utils.escapeHtml(i18n.t('pages.onboarding.servers.connSsh'))}</option>
            </select>
          </div>
          ${state.hosts.length > 1 ? `<button type="button" class="btn btn-sm btn-secondary" data-remove-host="${i}" style="margin-bottom:10px" title="${Utils.escapeHtml(i18n.t('pages.onboarding.servers.remove'))}"><i class="fas fa-trash"></i></button>` : ''}
        </div>
        ${ct === 'socket' ? `
        <div class="form-group">
          <label for="ob-host-socket-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.socketPath'))}</label>
          <input type="text" id="ob-host-socket-${i}" class="form-control mono" value="${Utils.escapeHtml(row.socketPath)}">
        </div>` : ''}
        ${ct === 'tcp' ? `
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <div class="form-group" style="flex:2;min-width:160px"><label for="ob-host-host-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.host'))}</label><input type="text" id="ob-host-host-${i}" class="form-control" value="${Utils.escapeHtml(row.host)}" placeholder="192.168.1.100"></div>
          <div class="form-group" style="flex:1;min-width:100px"><label for="ob-host-port-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.port'))}</label><input type="number" id="ob-host-port-${i}" class="form-control" value="${row.port || 2376}"></div>
        </div>
        <div class="form-group"><label for="ob-host-tlsca-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.tlsCa'))}</label><textarea id="ob-host-tlsca-${i}" class="form-control mono" rows="2">${Utils.escapeHtml(row.tlsCa)}</textarea></div>
        ${row.tlsCa ? `
        <div class="form-group"><label for="ob-host-tlscert-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.tlsCert'))}</label><textarea id="ob-host-tlscert-${i}" class="form-control mono" rows="2">${Utils.escapeHtml(row.tlsCert)}</textarea></div>
        <div class="form-group"><label for="ob-host-tlskey-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.tlsKey'))}</label><textarea id="ob-host-tlskey-${i}" class="form-control mono" rows="2">${Utils.escapeHtml(row.tlsKey)}</textarea></div>
        ` : ''}` : ''}
        ${ct === 'ssh' ? `
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <div class="form-group" style="flex:2;min-width:160px"><label for="ob-host-sshhost-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.sshHost'))}</label><input type="text" id="ob-host-sshhost-${i}" class="form-control" value="${Utils.escapeHtml(row.sshHost)}" placeholder="192.168.1.100"></div>
          <div class="form-group" style="flex:1;min-width:90px"><label for="ob-host-sshport-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.sshPort'))}</label><input type="number" id="ob-host-sshport-${i}" class="form-control" value="${row.sshPort || 22}"></div>
          <div class="form-group" style="flex:1;min-width:120px"><label for="ob-host-sshuser-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.sshUsername'))}</label><input type="text" id="ob-host-sshuser-${i}" class="form-control" value="${Utils.escapeHtml(row.sshUsername)}" placeholder="root"></div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <div class="form-group" style="flex:1;min-width:160px"><label for="ob-host-sshpass-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.sshPassword'))}</label><input type="password" id="ob-host-sshpass-${i}" class="form-control" value="${Utils.escapeHtml(row.sshPassword)}" autocomplete="new-password"></div>
          <div class="form-group" style="flex:1;min-width:160px"><label for="ob-host-sshkey-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.sshPrivateKey'))}</label><textarea id="ob-host-sshkey-${i}" class="form-control mono" rows="2">${Utils.escapeHtml(row.sshPrivateKey)}</textarea></div>
        </div>
        <div class="form-group"><label for="ob-host-sshsock-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.servers.sshDockerSocket'))}</label><input type="text" id="ob-host-sshsock-${i}" class="form-control mono" value="${Utils.escapeHtml(row.sshDockerSocket)}"></div>
        ` : ''}
        <div style="display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap">
          <button type="button" class="btn btn-sm btn-secondary" data-test-host="${i}"><i class="fas fa-plug"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.servers.test'))}</button>
          <span id="ob-host-status-${i}">${_obHostProbeBadge(row._probe)}</span>
        </div>
      </div>
    </div>
  `;
}

function _obWireHostRows(body, state, wiz) {
  state.hosts.forEach((row, i) => {
    const $ = (sel) => body.querySelector(sel);
    const bindText = (sel, key) => { const el = $(sel); if (el) el.addEventListener('input', () => { row[key] = el.value; }); };
    const nameEl = $(`#ob-host-name-${i}`);
    if (nameEl) nameEl.addEventListener('input', () => { row.name = nameEl.value; });
    const typeEl = $(`#ob-host-type-${i}`);
    if (typeEl) typeEl.addEventListener('change', () => { row.connectionType = typeEl.value; wiz.render(); });
    bindText(`#ob-host-socket-${i}`, 'socketPath');
    bindText(`#ob-host-host-${i}`, 'host');
    const portEl = $(`#ob-host-port-${i}`);
    if (portEl) portEl.addEventListener('input', () => { row.port = parseInt(portEl.value, 10) || 2376; });
    const tlsCaEl = $(`#ob-host-tlsca-${i}`);
    if (tlsCaEl) tlsCaEl.addEventListener('input', () => { row.tlsCa = tlsCaEl.value; });
    if (tlsCaEl) tlsCaEl.addEventListener('blur', () => { wiz.render(); });
    bindText(`#ob-host-tlscert-${i}`, 'tlsCert');
    bindText(`#ob-host-tlskey-${i}`, 'tlsKey');
    bindText(`#ob-host-sshhost-${i}`, 'sshHost');
    const sshPortEl = $(`#ob-host-sshport-${i}`);
    if (sshPortEl) sshPortEl.addEventListener('input', () => { row.sshPort = parseInt(sshPortEl.value, 10) || 22; });
    bindText(`#ob-host-sshuser-${i}`, 'sshUsername');
    bindText(`#ob-host-sshpass-${i}`, 'sshPassword');
    bindText(`#ob-host-sshkey-${i}`, 'sshPrivateKey');
    bindText(`#ob-host-sshsock-${i}`, 'sshDockerSocket');

    const removeBtn = body.querySelector(`[data-remove-host="${i}"]`);
    if (removeBtn) removeBtn.addEventListener('click', () => { state.hosts.splice(i, 1); wiz.render(); });

    const testBtn = body.querySelector(`[data-test-host="${i}"]`);
    if (testBtn) testBtn.addEventListener('click', () => _obTestHostRow(row, i, body, state));
  });
}

async function _obTestHostRow(row, i, body, state) {
  const statusEl = body.querySelector(`#ob-host-status-${i}`);
  row._probe = { status: 'testing' };
  if (statusEl) statusEl.innerHTML = _obHostProbeBadge(row._probe);
  const payload = {
    connectionType: row.connectionType,
    socketPath: row.socketPath, host: row.host, port: row.port,
    tlsCa: row.tlsCa, tlsCert: row.tlsCert, tlsKey: row.tlsKey,
    sshHost: row.sshHost, sshPort: row.sshPort, sshUsername: row.sshUsername,
    sshPassword: row.sshPassword, sshPrivateKey: row.sshPrivateKey, sshPassphrase: row.sshPassphrase,
  };
  try {
    const r = await Api.testHostConnection(payload);
    row._probe = (r && r.ok)
      ? { status: 'ok', message: r.dockerVersion || '', latency: r.latency }
      : { status: 'failed', message: (r && r.error) || 'Failed' };
  } catch (err) {
    row._probe = { status: 'failed', message: err.message };
  }
  if (statusEl) statusEl.innerHTML = _obHostProbeBadge(row._probe);
  _obUpdateHostSummary(body, state);
}

function _obUpdateHostSummary(body, state) {
  const el = body.querySelector('#ob-host-summary');
  if (!el) return;
  const total = state.hosts.length;
  const reachable = state.hosts.filter((h) => h._probe && h._probe.status === 'ok').length;
  el.textContent = i18n.t('pages.onboarding.servers.reachableSummary', { reachable, total });
}

// ── step 5 — users, roles & permissions ─────────────────────────────────────
const _stepUsers = {
  key: 'users',
  get title() { return i18n.t('pages.onboarding.users.title'); },
  get help() { return i18n.t('pages.onboarding.users.help'); },
  render(body, state, wiz) {
    const ownerIdx = state.users.findIndex((u) => u.isOwner);
    const nonOwnerEntries = state.users.map((u, i) => ({ u, i })).filter(({ u }) => !u.isOwner);
    const nonOwner = nonOwnerEntries.map(({ u }) => u);
    body.innerHTML = `
      <div id="ob-user-rows">
        ${ownerIdx >= 0 ? _obRenderUserRow(state.users[ownerIdx], ownerIdx, state, true) : ''}
        ${nonOwnerEntries.map(({ u, i }) => _obRenderUserRow(u, i, state, false)).join('')}
      </div>
      <button type="button" class="btn btn-sm btn-primary" id="ob-user-add"><i class="fas fa-plus"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.users.addUser'))}</button>
      <p class="text-sm text-dim" style="margin-top:8px">${Utils.escapeHtml(i18n.t('pages.onboarding.users.atomicNote'))}</p>
      <hr style="border-color:var(--border);margin:18px 0">
      <h3 style="font-size:14px;margin-bottom:6px">${Utils.escapeHtml(i18n.t('pages.onboarding.users.grantsTitle'))}</h3>
      <p class="text-sm text-dim">${Utils.escapeHtml(i18n.t('pages.onboarding.users.grantsHelp'))}</p>
      <div id="ob-grant-rows">${(state.permissions || []).map((p, i) => _obRenderGrantRow(p, i, state)).join('')}</div>
      <button type="button" class="btn btn-sm btn-secondary" id="ob-grant-add" ${(state.hosts.length === 0 || nonOwner.length === 0) ? 'disabled' : ''}>
        <i class="fas fa-plus"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.users.addGrant'))}
      </button>
    `;
    _obWireUserRows(body, state, wiz);
    body.querySelector('#ob-user-add').addEventListener('click', () => { state.users.push(_obBlankUserRow()); wiz.render(); });
    body.querySelectorAll('[data-remove-grant]').forEach((btn) => btn.addEventListener('click', () => {
      state.permissions.splice(parseInt(btn.getAttribute('data-remove-grant'), 10), 1);
      wiz.render();
    }));
    const addGrantBtn = body.querySelector('#ob-grant-add');
    if (addGrantBtn) addGrantBtn.addEventListener('click', () => {
      state.permissions = state.permissions || [];
      state.permissions.push({ username: nonOwner[0].username || '', hostName: state.hosts[0].name || '', permission: 'view' });
      wiz.render();
    });
  },
  validate(state) {
    const errors = [];
    const names = new Set();
    let ownerCount = 0;
    state.users.forEach((u) => {
      const uname = (u.username || '').trim();
      if (u.isOwner) ownerCount++;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(uname)) errors.push(i18n.t('pages.onboarding.errors.usernameInvalid', { username: uname || '?' }));
      else if (names.has(uname.toLowerCase())) errors.push(i18n.t('pages.onboarding.errors.usernameDuplicate', { username: uname }));
      names.add(uname.toLowerCase());
      if (!['viewer', 'operator', 'admin'].includes(u.role)) errors.push(i18n.t('pages.onboarding.errors.roleInvalid'));
      if (u.role === 'admin' && state.mode !== 'production') errors.push(i18n.t('pages.onboarding.errors.adminNotAllowed'));
      if (!u._existing) {
        if (!u.password || u.password.length < 8) errors.push(i18n.t('pages.onboarding.errors.passwordShort', { username: uname || '?' }));
        else if (!/\d/.test(u.password)) errors.push(i18n.t('pages.onboarding.errors.passwordNoNumber', { username: uname || '?' }));
        if (u.password !== u._confirmPassword) errors.push(i18n.t('pages.onboarding.errors.passwordMismatch', { username: uname || '?' }));
      }
    });
    if (ownerCount !== 1) errors.push(i18n.t('pages.onboarding.errors.ownerRequired'));
    return { ok: errors.length === 0, errors };
  },
  onLeave(state) { state._plan = null; },
};

function _obRenderUserRow(u, i, state, isOwner) {
  const roleOptions = ['viewer', 'operator', 'admin'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${Utils.escapeHtml(i18n.t(`pages.onboarding.users.role${r.charAt(0).toUpperCase()}${r.slice(1)}`))}</option>`).join('');
  return `
    <div class="card wiz-row-card" data-row-idx="${i}">
      <div class="card-body">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div class="form-group" style="flex:1;min-width:140px;margin-bottom:10px">
            <label for="ob-user-name-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.users.username'))}</label>
            <input type="text" id="ob-user-name-${i}" class="form-control" value="${Utils.escapeHtml(u.username)}" ${isOwner ? 'disabled' : ''}>
          </div>
          <div class="form-group" style="flex:1;min-width:140px;margin-bottom:10px">
            <label for="ob-user-disp-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.users.displayName'))}</label>
            <input type="text" id="ob-user-disp-${i}" class="form-control" value="${Utils.escapeHtml(u.displayName)}" ${isOwner ? 'disabled' : ''}>
          </div>
          <div class="form-group" style="flex:1;min-width:140px;margin-bottom:10px">
            <label for="ob-user-role-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.users.role'))}</label>
            <select id="ob-user-role-${i}" class="form-control" ${isOwner ? 'disabled' : ''}>${roleOptions}</select>
          </div>
          ${!isOwner ? `<button type="button" class="btn btn-sm btn-secondary" data-remove-user="${i}" style="margin-bottom:10px" title="${Utils.escapeHtml(i18n.t('pages.onboarding.users.remove'))}"><i class="fas fa-trash"></i></button>` : ''}
        </div>
        <div class="form-group">
          <label for="ob-user-email-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.users.email'))}</label>
          <input type="email" id="ob-user-email-${i}" class="form-control" value="${Utils.escapeHtml(u.email)}" ${isOwner ? 'disabled' : ''}>
        </div>
        ${isOwner
          ? `<span class="badge badge-running"><i class="fas fa-crown"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.users.ownerNote'))}</span>`
          : `<div style="display:flex;gap:10px;flex-wrap:wrap">
              <div class="form-group" style="flex:1;min-width:160px"><label for="ob-user-pass-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.users.password'))}</label><input type="password" id="ob-user-pass-${i}" class="form-control" value="${Utils.escapeHtml(u.password)}" autocomplete="new-password"></div>
              <div class="form-group" style="flex:1;min-width:160px"><label for="ob-user-confirm-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.users.confirmPassword'))}</label><input type="password" id="ob-user-confirm-${i}" class="form-control" value="${Utils.escapeHtml(u._confirmPassword)}" autocomplete="new-password"></div>
            </div>
            <small class="text-muted">${Utils.escapeHtml(i18n.t('pages.onboarding.users.passwordHelp'))}</small>
            ${u.role === 'admin' ? `<div class="text-sm" style="color:var(--yellow);margin-top:4px"><i class="fas fa-triangle-exclamation"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.users.adminWarning'))}</div>` : ''}
          `}
      </div>
    </div>
  `;
}

function _obRenderGrantRow(p, i, state) {
  const nonOwner = state.users.filter((u) => !u.isOwner);
  return `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px" data-grant-idx="${i}">
      <div class="form-group" style="flex:1;min-width:120px;margin-bottom:0">
        <label for="ob-grant-user-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.users.grantUser'))}</label>
        <select id="ob-grant-user-${i}" class="form-control">${nonOwner.map((u) => `<option value="${Utils.escapeHtml(u.username)}" ${p.username === u.username ? 'selected' : ''}>${Utils.escapeHtml(u.username || '—')}</option>`).join('')}</select>
      </div>
      <div class="form-group" style="flex:1;min-width:120px;margin-bottom:0">
        <label for="ob-grant-host-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.users.grantHost'))}</label>
        <select id="ob-grant-host-${i}" class="form-control">${state.hosts.map((h) => `<option value="${Utils.escapeHtml(h.name)}" ${p.hostName === h.name ? 'selected' : ''}>${Utils.escapeHtml(h.name || '—')}</option>`).join('')}</select>
      </div>
      <div class="form-group" style="flex:1;min-width:100px;margin-bottom:0">
        <label for="ob-grant-perm-${i}">${Utils.escapeHtml(i18n.t('pages.onboarding.users.grantPermission'))}</label>
        <select id="ob-grant-perm-${i}" class="form-control">
          ${['view', 'operate', 'admin'].map((perm) => `<option value="${perm}" ${p.permission === perm ? 'selected' : ''}>${Utils.escapeHtml(i18n.t(`pages.onboarding.users.perm${perm.charAt(0).toUpperCase()}${perm.slice(1)}`))}</option>`).join('')}
        </select>
      </div>
      <button type="button" class="btn btn-sm btn-secondary" data-remove-grant="${i}"><i class="fas fa-trash"></i></button>
    </div>
  `;
}

function _obWireUserRows(body, state, wiz) {
  state.users.forEach((u, i) => {
    const $ = (sel) => body.querySelector(sel);
    const nameEl = $(`#ob-user-name-${i}`);
    if (nameEl && !nameEl.disabled) nameEl.addEventListener('input', () => { u.username = nameEl.value; });
    const dispEl = $(`#ob-user-disp-${i}`);
    if (dispEl && !dispEl.disabled) dispEl.addEventListener('input', () => { u.displayName = dispEl.value; });
    const emailEl = $(`#ob-user-email-${i}`);
    if (emailEl && !emailEl.disabled) emailEl.addEventListener('input', () => { u.email = emailEl.value; });
    const roleEl = $(`#ob-user-role-${i}`);
    if (roleEl && !roleEl.disabled) roleEl.addEventListener('change', () => { u.role = roleEl.value; wiz.render(); });
    const passEl = $(`#ob-user-pass-${i}`);
    if (passEl) passEl.addEventListener('input', () => { u.password = passEl.value; });
    const confirmEl = $(`#ob-user-confirm-${i}`);
    if (confirmEl) confirmEl.addEventListener('input', () => { u._confirmPassword = confirmEl.value; });
    const removeBtn = body.querySelector(`[data-remove-user="${i}"]`);
    if (removeBtn) removeBtn.addEventListener('click', () => {
      const removedName = u.username;
      state.users.splice(i, 1);
      state.permissions = (state.permissions || []).filter((p) => p.username !== removedName);
      wiz.render();
    });
  });
  (state.permissions || []).forEach((p, i) => {
    const $ = (sel) => body.querySelector(sel);
    const uEl = $(`#ob-grant-user-${i}`);
    if (uEl) uEl.addEventListener('change', () => { p.username = uEl.value; });
    const hEl = $(`#ob-grant-host-${i}`);
    if (hEl) hEl.addEventListener('change', () => { p.hostName = hEl.value; });
    const pEl = $(`#ob-grant-perm-${i}`);
    if (pEl) pEl.addEventListener('change', () => { p.permission = pEl.value; });
  });
}

// ── step 6 — preview & impact (dry-run) ─────────────────────────────────────
// ── step 6 — mock data (demo/trial ONLY) ────────────────────────────────────
// Hard-inactive in production: the step is filtered out of the rail entirely
// (active() === false), the declaration omits the mockData block, and the server
// rejects it anyway. Three independent layers, per onboarding-security.md §3.
const _stepMockData = {
  key: 'mockdata',
  get title() { return i18n.t('pages.onboarding.mockdata.title'); },
  get help() { return i18n.t('pages.onboarding.mockdata.help'); },
  active(state) { return state.mode !== 'production'; },
  onEnter(state, wiz) {
    if (state._seedCatalog || state._seedCatalogLoading) return;
    state._seedCatalogLoading = true;
    state._seedCatalogError = null;
    (async () => {
      try {
        const r = await Api.getSeedCatalog(state.mockData.scenario);
        state._seedCatalog = r || null;
      } catch (err) {
        state._seedCatalog = null;
        state._seedCatalogError = err.message;
      } finally {
        state._seedCatalogLoading = false;
        wiz.render();
      }
    })();
  },
  render(body, state, wiz) {
    const cat = state._seedCatalog;
    const byProfile = {};
    ((cat && cat.profiles) || []).forEach((p) => { byProfile[p.profile] = p; });
    const chosen = byProfile[state.mockData.profile];

    body.innerHTML = `
      <div class="alert" style="background:var(--surface2);padding:12px 14px;border-radius:var(--radius-sm);margin-bottom:14px">
        <i class="fas fa-shield-halved"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.safetyNote'))}
      </div>

      <label style="display:block;margin-bottom:8px;font-size:11px;font-weight:600;color:var(--text-dim)">${Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.volume'))}</label>
      <div class="wiz-radio-group" role="radiogroup" aria-label="${Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.volume'))}">
        ${ONBOARDING_SEED_PROFILES.map((p) => {
          const est = byProfile[p];
          return `
          <label class="wiz-radio-card ${state.mockData.profile === p ? 'is-selected' : ''}">
            <input type="radio" name="ob-seed-profile" value="${p}" ${state.mockData.profile === p ? 'checked' : ''}>
            <div class="wiz-radio-card-title"><i class="fas fa-database"></i> ${Utils.escapeHtml(i18n.t(`pages.onboarding.mockdata.profiles.${p}.label`))}</div>
            <div class="wiz-radio-card-desc">${Utils.escapeHtml(i18n.t(`pages.onboarding.mockdata.profiles.${p}.desc`))}</div>
            <div class="text-sm text-dim">${est
              ? Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.rowEstimate', { rows: est.total, tables: est.tables.length }))
              : Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.estimating'))}</div>
          </label>`;
        }).join('')}
      </div>

      <label style="display:block;margin:18px 0 8px;font-size:11px;font-weight:600;color:var(--text-dim)">${Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.scenario'))}</label>
      <div class="wiz-radio-group" role="radiogroup" aria-label="${Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.scenario'))}">
        ${ONBOARDING_SEED_SCENARIOS.map((s) => `
          <label class="wiz-radio-card ${state.mockData.scenario === s ? 'is-selected' : ''}">
            <input type="radio" name="ob-seed-scenario" value="${s}" ${state.mockData.scenario === s ? 'checked' : ''}>
            <div class="wiz-radio-card-title"><i class="fas fa-diagram-project"></i> ${Utils.escapeHtml(i18n.t(`pages.onboarding.mockdata.scenarios.${s}.label`))}</div>
            <div class="wiz-radio-card-desc">${Utils.escapeHtml(i18n.t(`pages.onboarding.mockdata.scenarios.${s}.desc`))}</div>
          </label>`).join('')}
      </div>

      <div class="form-group" style="margin-top:18px;max-width:320px">
        <label for="ob-seed-seed">${Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.seed'))}</label>
        <input type="text" id="ob-seed-seed" class="form-control mono" value="${Utils.escapeHtml(state.mockData.seed || '')}"
               placeholder="${Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.seedAuto'))}" aria-describedby="ob-seed-seed-help">
        <small id="ob-seed-seed-help" class="text-muted">${Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.seedHelp'))}</small>
      </div>

      ${chosen ? `
      <h3 style="font-size:14px;margin:18px 0 4px">${Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.impactTitle'))}</h3>
      <div style="max-height:220px;overflow:auto">
        <table class="data-table"><tbody>
          ${chosen.tables.map((t) => `<tr><td class="mono">${Utils.escapeHtml(t.name)}</td><td style="text-align:right">${Utils.escapeHtml(String(t.count))}</td></tr>`).join('')}
        </tbody></table>
      </div>` : ''}
      ${state._seedCatalogError ? `<div class="text-sm" style="color:var(--yellow)"><i class="fas fa-triangle-exclamation"></i> ${Utils.escapeHtml(state._seedCatalogError)}</div>` : ''}

      <label style="display:flex;gap:8px;align-items:center;margin-top:16px">
        <input type="checkbox" id="ob-seed-ack" ${state.mockData.ack ? 'checked' : ''}>
        ${Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.ack'))}
      </label>
    `;

    body.querySelectorAll('input[name="ob-seed-profile"]').forEach((r) => r.addEventListener('change', () => {
      if (!r.checked) return;
      state.mockData.profile = r.value;
      state._plan = null;
      wiz.render();
    }));
    body.querySelectorAll('input[name="ob-seed-scenario"]').forEach((r) => r.addEventListener('change', () => {
      if (!r.checked) return;
      state.mockData.scenario = r.value;
      state._plan = null;
      wiz.render();
    }));
    body.querySelector('#ob-seed-seed').addEventListener('input', (e) => {
      state.mockData.seed = e.target.value.trim();
      state._plan = null;
    });
    body.querySelector('#ob-seed-ack').addEventListener('change', (e) => { state.mockData.ack = e.target.checked; });
  },
  validate(state) {
    const errors = [];
    if (!ONBOARDING_SEED_PROFILES.includes(state.mockData.profile)) errors.push(i18n.t('pages.onboarding.errors.seedProfileInvalid'));
    if (!ONBOARDING_SEED_SCENARIOS.includes(state.mockData.scenario)) errors.push(i18n.t('pages.onboarding.errors.seedScenarioInvalid'));
    if (state.mockData.seed && !/^[A-Za-z0-9._-]{1,64}$/.test(state.mockData.seed)) errors.push(i18n.t('pages.onboarding.errors.seedValueInvalid'));
    if (!state.mockData.ack) errors.push(i18n.t('pages.onboarding.errors.seedAckRequired'));
    return { ok: errors.length === 0, errors };
  },
  onLeave(state) { state._plan = null; },
};

const _stepPreview = {
  key: 'preview',
  get title() { return i18n.t('pages.onboarding.preview.title'); },
  get help() { return i18n.t('pages.onboarding.preview.help'); },
  onEnter(state, wiz) {
    if (state._plan || state._planLoading) return;
    state._planLoading = true;
    state._planError = null;
    wiz.render(); // paint the loading spinner immediately — the fetch below is fire-and-forget
    (async () => {
      try {
        const decl = buildOnboardingDeclaration(state);
        state._plan = await Api.onboardingPlan(decl);
      } catch (err) {
        state._planError = err.message;
      } finally {
        state._planLoading = false;
        wiz.render();
      }
    })();
  },
  render(body, state, wiz) {
    if (state._planLoading) {
      body.innerHTML = `<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>${Utils.escapeHtml(i18n.t('pages.onboarding.preview.loading'))}</div>`;
      return;
    }
    if (state._planError) {
      body.innerHTML = `
        <div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(state._planError)}</div>
        <div style="text-align:center"><button type="button" class="btn btn-sm btn-secondary" id="ob-preview-retry">${Utils.escapeHtml(i18n.t('common.retry'))}</button></div>
      `;
      body.querySelector('#ob-preview-retry').addEventListener('click', () => { state._plan = null; state._planError = null; wiz.render(); });
      return;
    }
    const plan = state._plan || { impact: { creates: {} }, warnings: [] };
    const creates = plan.impact && plan.impact.creates ? plan.impact.creates : {};
    const enabledModules = state.modules.filter((m) => m.enabled).map((m) => i18n.t(`pages.onboarding.modules.catalog.${m.key}.label`));
    const ownerRow = state.users.find((u) => u.isOwner);

    body.innerHTML = `
      <div class="card" style="margin-bottom:12px"><div class="card-header"><h3>${Utils.escapeHtml(i18n.t('pages.onboarding.preview.identitySection'))}</h3></div>
        <div class="card-body">
          <table class="info-table"><tbody>
            <tr><td>${Utils.escapeHtml(i18n.t('pages.onboarding.identity.name'))}</td><td>${Utils.escapeHtml(state.tenant.name)}</td></tr>
            <tr><td>${Utils.escapeHtml(i18n.t('pages.onboarding.identity.slug'))}</td><td class="mono">${Utils.escapeHtml(state.tenant.slug)}</td></tr>
            <tr><td>${Utils.escapeHtml(i18n.t('pages.onboarding.identity.kind'))}</td><td>${Utils.escapeHtml(state.tenant.kind)}</td></tr>
          </tbody></table>
        </div>
      </div>
      <div class="card" style="margin-bottom:12px"><div class="card-header"><h3>${Utils.escapeHtml(i18n.t('pages.onboarding.preview.regionalSection'))}</h3></div>
        <div class="card-body text-sm">${Utils.escapeHtml(state.regional.locale)} · ${Utils.escapeHtml(state.regional.timezone)} · ${Utils.escapeHtml(state.regional.currency)} · ${Utils.escapeHtml(state.regional.unitSystem)} · ${Utils.escapeHtml(state.regional.dateFormat)} · ${Utils.escapeHtml(state.regional.numberFormat)}</div>
      </div>
      <div class="card" style="margin-bottom:12px"><div class="card-header"><h3>${Utils.escapeHtml(i18n.t('pages.onboarding.preview.modulesSection'))}</h3></div>
        <div class="card-body text-sm">${enabledModules.length ? enabledModules.map((m) => `<span class="badge badge-info" style="margin:2px">${Utils.escapeHtml(m)}</span>`).join('') : `<span class="text-dim">${Utils.escapeHtml(i18n.t('common.noData'))}</span>`}</div>
      </div>
      <div class="card" style="margin-bottom:12px"><div class="card-header"><h3>${Utils.escapeHtml(i18n.t('pages.onboarding.preview.hostsSection'))}</h3></div>
        <div class="card-body">${state.hosts.length ? `<table class="data-table"><tbody>${state.hosts.map((h) => `
          <tr><td>${Utils.escapeHtml(h.name)}</td><td class="text-sm text-dim">${Utils.escapeHtml(h.connectionType)}</td><td>${_obHostProbeBadge(h._probe)}</td></tr>
        `).join('')}</tbody></table>` : `<span class="text-dim">${Utils.escapeHtml(i18n.t('common.noData'))}</span>`}</div>
      </div>
      <div class="card" style="margin-bottom:12px"><div class="card-header"><h3>${Utils.escapeHtml(i18n.t('pages.onboarding.preview.usersSection'))}</h3></div>
        <div class="card-body text-sm">${i18n.t('pages.onboarding.preview.usersSummary', { count: state.users.length, owner: (ownerRow && ownerRow.username) || '?' })}</div>
      </div>
      <div class="alert" style="background:var(--surface2);padding:12px 14px;border-radius:var(--radius-sm);margin-bottom:12px">
        <i class="fas fa-cubes"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.preview.willCreate', {
          tenants: creates.tenants || 0, modules: creates.modules || 0, hosts: creates.hosts || 0,
          users: creates.users || 0, grants: creates.grants || 0, nomenclatures: creates.nomenclatures || 0,
        }))}
        ${creates.syntheticRows ? `<div style="margin-top:4px"><i class="fas fa-flask"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.preview.willCreateSynthetic', {
          rows: creates.syntheticRows, tables: creates.syntheticTables || 0,
          profile: state.mockData.profile, scenario: state.mockData.scenario,
        }))}</div>` : ''}
      </div>
      ${(plan.warnings || []).length ? `
      <div class="alert alert-warning" style="background:var(--yellow-dim);border-left:3px solid var(--yellow);padding:12px 14px;border-radius:var(--radius-sm);margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:6px;color:var(--yellow)"><i class="fas fa-triangle-exclamation"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.preview.warningsTitle'))}</div>
        ${plan.warnings.map((w) => {
          const jump = _obGuessStepForWarning(w);
          return `<div style="margin:2px 0">${Utils.escapeHtml(w)} ${jump ? `<a href="#" data-jump="${jump}">${Utils.escapeHtml(i18n.t('pages.onboarding.preview.fixJump'))}</a>` : ''}</div>`;
        }).join('')}
      </div>
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <input type="checkbox" id="ob-preview-ack" ${state._reviewedAck ? 'checked' : ''}>
        ${Utils.escapeHtml(i18n.t('pages.onboarding.preview.reviewedAck'))}
      </label>` : ''}
      <p class="text-sm text-dim"><i class="fas fa-lock"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.preview.secretsRedacted'))}</p>
    `;
    const ack = body.querySelector('#ob-preview-ack');
    if (ack) ack.addEventListener('change', () => { state._reviewedAck = ack.checked; });
    body.querySelectorAll('[data-jump]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); wiz.goTo(a.getAttribute('data-jump')); }));
  },
  validate(state) {
    if (state._planError) return { ok: false, errors: [state._planError] };
    if (!state._plan) return { ok: false, errors: [i18n.t('pages.onboarding.preview.loading')] };
    if ((state._plan.warnings || []).length && !state._reviewedAck) {
      return { ok: false, errors: [i18n.t('pages.onboarding.errors.mustAcknowledge')] };
    }
    return { ok: true };
  },
  footer() { return { nextLabel: i18n.t('pages.onboarding.preview.provisionBtn') }; },
};

// ── step 7 — provision (live progress, resumable, rollback) ─────────────────
const _stepProvision = {
  key: 'provision',
  get title() { return i18n.t('pages.onboarding.provision.title'); },
  get help() { return i18n.t('pages.onboarding.provision.help'); },
  onEnter(state, wiz) {
    if (state._run && state._run.status === 'completed') return; // already done (e.g. re-entered after Back+Next)
    if (state._applying) return; // an apply/resume is already in flight
    if (!state._runId) {
      // Fresh flow: the explicit confirm already happened on the Preview step.
      // Fire-and-forget — _obStartApply calls wiz.render() itself as it
      // progresses; onEnter must NOT block the first paint on the network call.
      _obStartApply(state, wiz);
    }
    // Else: this is a resumed run (state._runId set by the Resume card) —
    // wait for the user to click "Continue provisioning" in the body.
  },
  render(body, state, wiz) {
    const run = state._run;
    const rows = (run && run.steps && run.steps.length) ? run.steps : _obRunStepKeys(state.mode).map((k) => ({ step_key: k, status: 'pending' }));
    body.innerHTML = `
      <ol class="wiz-checklist" aria-live="polite">
        ${rows.map((s) => {
          const label = i18n.t(`pages.onboarding.provision.stepLabels.${s.step_key}`);
          const icon = s.status === 'completed' ? 'fa-circle-check' : s.status === 'running' ? 'fa-spinner fa-spin' : s.status === 'failed' ? 'fa-circle-xmark' : s.status === 'compensated' ? 'fa-rotate-left' : 'fa-circle';
          const cls = s.status === 'completed' ? 'is-done' : s.status === 'failed' ? 'is-error' : s.status === 'running' ? 'is-active' : s.status === 'compensated' ? 'is-warn' : '';
          return `<li class="wiz-checklist-item ${cls}"><i class="fas ${icon}"></i> ${Utils.escapeHtml(label)}
            ${s.status === 'failed' && s.error ? `<div class="text-sm" style="color:var(--red)" role="alert">${Utils.escapeHtml(s.error)}</div>` : ''}
          </li>`;
        }).join('')}
      </ol>
      <div id="ob-provision-actions"></div>
    `;
    const actions = body.querySelector('#ob-provision-actions');
    if (state._applying) {
      actions.innerHTML = `<div class="text-sm text-dim"><i class="fas fa-spinner fa-spin"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.provision.running'))} — ${Utils.escapeHtml(i18n.t('pages.onboarding.provision.doNotClose'))}</div>`;
    } else if (!run || run.status === 'pending' || run.status === 'running') {
      // Resumed run that hasn't been continued yet (or was left mid-flight by
      // a server crash) — resume() re-attaches using the STORED declaration;
      // never rebuild+re-apply here (would trip the idempotency fingerprint guard).
      actions.innerHTML = `<button type="button" class="btn btn-primary" id="ob-provision-continue">${Utils.escapeHtml(i18n.t('pages.onboarding.provision.continueBtn'))}</button>`;
      actions.querySelector('#ob-provision-continue').addEventListener('click', () => _obRetryRun(state, wiz));
    } else if (run.status === 'failed') {
      actions.innerHTML = `
        <div class="alert alert-danger" style="background:var(--red-dim);border-left:3px solid var(--red);padding:10px 14px;border-radius:var(--radius-sm);margin-bottom:10px;color:var(--red)"><i class="fas fa-circle-exclamation"></i> ${Utils.escapeHtml(run.error || state._applyError || '')}</div>
        <p class="text-sm text-dim">${Utils.escapeHtml(i18n.t('pages.onboarding.provision.safeRetry'))}</p>
        <button type="button" class="btn btn-primary" id="ob-provision-retry">${Utils.escapeHtml(i18n.t('pages.onboarding.provision.retryStep'))}</button>
        <button type="button" class="btn btn-danger" id="ob-provision-rollback">${Utils.escapeHtml(i18n.t('pages.onboarding.provision.rollBack'))}</button>
      `;
      actions.querySelector('#ob-provision-retry').addEventListener('click', () => _obRetryRun(state, wiz));
      actions.querySelector('#ob-provision-rollback').addEventListener('click', () => _obRollbackRun(state, wiz));
    } else if (run.status === 'rolled_back') {
      actions.innerHTML = `
        <div class="empty-msg"><i class="fas fa-rotate-left"></i>${Utils.escapeHtml(i18n.t('pages.onboarding.provision.rolledBack'))}</div>
        <div style="text-align:center"><button type="button" class="btn btn-primary" id="ob-provision-startover">${Utils.escapeHtml(i18n.t('pages.onboarding.resume.startOverBtn'))}</button></div>
      `;
      actions.querySelector('#ob-provision-startover').addEventListener('click', () => { if (window.OnboardingPage) OnboardingPage._startFresh(); });
    } else if (run.status === 'completed') {
      actions.innerHTML = `<div class="text-sm" style="color:var(--green)"><i class="fas fa-circle-check"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.provision.completedIn'))}</div>`;
    }
  },
  validate(state) {
    if (state._run && state._run.status === 'completed') return { ok: true };
    return { ok: false, errors: [i18n.t('pages.onboarding.provision.notDoneYet')] };
  },
  footer(state) {
    const done = state._run && state._run.status === 'completed';
    return { hideBack: true, hideNext: !done };
  },
};

async function _obStartApply(state, wiz) {
  state._applying = true;
  state._applyError = null;
  wiz.render();
  const decl = buildOnboardingDeclaration(state);
  const pollTimer = setInterval(async () => {
    try {
      const r = await Api.getActiveOnboardingRun();
      if (r && r.run) { state._run = r.run; state._runId = r.run.id; wiz.render(); }
    } catch { /* transient — next tick retries */ }
  }, 1500);
  try {
    const result = await Api.onboardingApply(decl);
    clearInterval(pollTimer);
    state._applying = false;
    state._run = result;
    state._runId = result.id;
    wiz.render();
    if (result.status === 'completed') setTimeout(() => wiz.next(), 1000);
  } catch (err) {
    clearInterval(pollTimer);
    state._applying = false;
    const body = err.body || {};
    state._applyError = body.error || err.message;
    if (body.runId) {
      state._runId = body.runId;
      try { state._run = await Api.getOnboardingRun(body.runId); } catch { /* show the error alone */ }
    }
    wiz.render();
  }
}

async function _obRetryRun(state, wiz) {
  state._applying = true;
  wiz.render();
  const pollTimer = setInterval(async () => {
    try { const r = await Api.getOnboardingRun(state._runId); if (r) { state._run = r; wiz.render(); } } catch { /* ignore */ }
  }, 1500);
  try {
    const result = await Api.resumeOnboardingRun(state._runId);
    clearInterval(pollTimer);
    state._applying = false;
    state._run = result;
    wiz.render();
    if (result.status === 'completed') setTimeout(() => wiz.next(), 1000);
  } catch (err) {
    clearInterval(pollTimer);
    state._applying = false;
    state._applyError = (err.body && err.body.error) || err.message;
    try { state._run = await Api.getOnboardingRun(state._runId); } catch { /* keep prior */ }
    wiz.render();
  }
}

async function _obRollbackRun(state, wiz) {
  const ok = await Modal.confirm(i18n.t('pages.onboarding.provision.rollbackConfirm'), { danger: true, confirmText: i18n.t('pages.onboarding.provision.rollBack') });
  if (!ok) return;
  try {
    state._run = await Api.rollbackOnboardingRun(state._runId);
    Toast.success(i18n.t('pages.onboarding.provision.rolledBack'));
    wiz.render();
  } catch (err) { Toast.error(err.message); }
}

// ── step 8 — summary & handoff ──────────────────────────────────────────────
const _stepSummary = {
  key: 'summary',
  get title() { return i18n.t('pages.onboarding.summary.title'); },
  get help() { return i18n.t('pages.onboarding.summary.help'); },
  onEnter(state, wiz) {
    // Demo/trial only: load the live batches + the promotion-gate verdict so the
    // Reset/Regenerate/Purge actions and the promotion warning can render.
    const tenantId = (state._run && state._run.tenantId) || null;
    if (state.mode === 'production' || !tenantId || state._seedStateLoading) return;
    if (state._seedState !== undefined && state._seedState !== null) return;
    state._seedStateLoading = true;
    (async () => {
      try {
        const [seedRes, gate] = await Promise.all([
          Api.getTenantSeed(tenantId),
          Api.getTenantPromotion(tenantId).catch(() => null),
        ]);
        state._seedState = { datasets: (seedRes && seedRes.datasets) || [], gate };
      } catch (err) {
        state._seedState = { datasets: [], gate: null, error: err.message };
      } finally {
        state._seedStateLoading = false;
        wiz.render();
      }
    })();
  },
  render(body, state, wiz) {
    const run = state._run || {};
    const result = run.result || {};
    const steps = run.steps || [];
    body.innerHTML = `
      <div class="card" style="margin-bottom:12px"><div class="card-header"><h3>${Utils.escapeHtml(i18n.t('pages.onboarding.summary.stepReport'))}</h3></div>
        <div class="card-body">
          <table class="data-table"><tbody>${steps.map((s) => `
            <tr><td>${Utils.escapeHtml(i18n.t(`pages.onboarding.provision.stepLabels.${s.step_key}`))}</td>
                <td><span class="badge ${s.status === 'completed' ? 'badge-running' : 'badge-warning'}">${Utils.escapeHtml(s.status)}</span></td>
                <td class="text-sm text-dim">${s.started_at && s.finished_at ? `${Math.max(0, new Date(s.finished_at) - new Date(s.started_at))}ms` : '—'}</td>
            </tr>`).join('')}
          </tbody></table>
        </div>
      </div>
      ${(result.warnings || []).length ? `
      <div class="alert alert-warning" style="background:var(--yellow-dim);border-left:3px solid var(--yellow);padding:12px 14px;border-radius:var(--radius-sm);margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:6px;color:var(--yellow)"><i class="fas fa-triangle-exclamation"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.warningsCarried'))}</div>
        ${result.warnings.map((w) => `<div>${Utils.escapeHtml(w)}</div>`).join('')}
      </div>` : ''}
      ${_obRenderDemoDataCard(state)}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-sm btn-secondary" id="ob-summary-export"><i class="fas fa-file-export"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.exportJson'))}</button>
        <button type="button" class="btn btn-sm btn-secondary" id="ob-summary-save-template"><i class="fas fa-layer-group"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.saveAsTemplate'))}</button>
        <button type="button" class="btn btn-sm btn-secondary" id="ob-summary-copy"><i class="fas fa-copy"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.copyApi'))}</button>
      </div>
      <p class="text-sm text-dim" style="margin-top:8px"><i class="fas fa-lock"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.templateNoSecrets'))}</p>
    `;
    body.querySelector('#ob-summary-export').addEventListener('click', () => {
      const url = Api.exportOnboardingRunUrl(run.id);
      const a = document.createElement('a');
      a.href = url; a.download = `onboarding-run-${run.id}.json`;
      document.body.appendChild(a); a.click(); a.remove();
    });
    _obWireDemoDataCard(body, state, wiz);
    body.querySelector('#ob-summary-save-template').addEventListener('click', () => _obSaveAsTemplate(state, run));
    body.querySelector('#ob-summary-copy').addEventListener('click', () => {
      const snippet = `curl -sS -X POST "$DOCKER_DASH_URL/api/onboarding/apply" \\\n  -H "Content-Type: application/json" \\\n  --cookie "<admin session cookie>" \\\n  -d @<(curl -sS "$DOCKER_DASH_URL${Api.exportOnboardingRunUrl(run.id)}")`;
      Utils.copyToClipboard(snippet).then(() => Toast.success(i18n.t('pages.onboarding.summary.copied')));
    });
  },
  validate() { return { ok: true }; },
  footer() { return { hideBack: true }; },
};

/**
 * Demo-data control panel on the Summary step (demo/trial only).
 * Renders the live batch(es), the Reset / Regenerate / Purge actions, and the
 * PROMOTION WARNING — the same server-side gate verdict the API enforces, so the
 * user learns here (not at the moment of promotion) that synthetic rows block
 * production.
 */
function _obRenderDemoDataCard(state) {
  if (state.mode === 'production') return '';
  const tenantId = (state._run && state._run.tenantId) || null;
  if (!tenantId) return '';
  const s = state._seedState;
  if (!s) {
    return `<div class="card" style="margin-bottom:12px"><div class="card-body text-sm text-dim">
      <i class="fas fa-spinner fa-spin"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.demoDataLoading'))}
    </div></div>`;
  }
  const live = (s.datasets || []).filter((d) => d.status === 'active');
  const totalRows = live.reduce((acc, d) => acc + (d.rowCount || 0), 0);
  const gate = s.gate;
  return `
    <div class="card" style="margin-bottom:12px">
      <div class="card-header"><h3><i class="fas fa-flask"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.demoDataTitle'))}</h3></div>
      <div class="card-body">
        ${live.length ? `
          <table class="data-table"><tbody>
            ${live.map((d) => `<tr>
              <td><span class="badge badge-info">${Utils.escapeHtml(d.profile)}</span> ${Utils.escapeHtml(d.scenario || '')}</td>
              <td class="text-sm text-dim mono">${Utils.escapeHtml(i18n.t('pages.onboarding.summary.demoDataSeed', { seed: d.seed }))}</td>
              <td style="text-align:right">${Utils.escapeHtml(i18n.t('pages.onboarding.summary.demoDataRows', { rows: d.rowCount, tables: (d.tables || []).length }))}</td>
            </tr>`).join('')}
          </tbody></table>
        ` : `<p class="text-sm text-dim">${Utils.escapeHtml(i18n.t('pages.onboarding.summary.demoDataNone'))}</p>`}
        <p class="text-sm text-dim" style="margin-top:8px"><i class="fas fa-shield-halved"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.mockdata.safetyNote'))}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <button type="button" class="btn btn-sm btn-secondary" id="ob-seed-reset" ${live.length ? '' : 'disabled'}><i class="fas fa-rotate-left"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.demoDataReset'))}</button>
          <button type="button" class="btn btn-sm btn-secondary" id="ob-seed-regen"><i class="fas fa-dice"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.demoDataRegenerate'))}</button>
          <button type="button" class="btn btn-sm btn-danger" id="ob-seed-purge" ${live.length ? '' : 'disabled'}><i class="fas fa-trash"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.demoDataPurge'))}</button>
        </div>
        ${gate && !gate.ok ? `
        <div class="alert alert-warning" style="background:var(--yellow-dim);border-left:3px solid var(--yellow);padding:10px 14px;border-radius:var(--radius-sm);margin-top:12px">
          <div style="font-weight:600;color:var(--yellow)"><i class="fas fa-triangle-exclamation"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.promotionBlockedTitle'))}</div>
          ${gate.blockers.map((b) => `<div class="text-sm" style="margin-top:4px">${Utils.escapeHtml(b.message)}<br><span class="text-dim">${Utils.escapeHtml(b.remediation)}</span></div>`).join('')}
        </div>` : ''}
        ${gate && gate.ok ? `<p class="text-sm" style="color:var(--green);margin-top:10px"><i class="fas fa-circle-check"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.summary.promotionReady'))}</p>` : ''}
      </div>
    </div>
  `;
}

function _obWireDemoDataCard(body, state, wiz) {
  const tenantId = (state._run && state._run.tenantId) || null;
  if (!tenantId) return;
  const refresh = () => { state._seedState = null; wiz.render(); };
  const call = async (fn, successKey, confirmKey, danger) => {
    if (confirmKey) {
      const ok = await Modal.confirm(i18n.t(confirmKey), { danger: !!danger });
      if (!ok) return;
    }
    try {
      const r = await fn();
      Toast.success(i18n.t(successKey, { rows: r.total || 0 }));
      refresh();
    } catch (err) { Toast.error((err.body && err.body.error) || err.message); }
  };
  const resetBtn = body.querySelector('#ob-seed-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => call(
    () => Api.resetTenantSeed(tenantId),
    'pages.onboarding.summary.demoDataResetDone',
    'pages.onboarding.summary.demoDataResetConfirm',
  ));
  const regenBtn = body.querySelector('#ob-seed-regen');
  if (regenBtn) regenBtn.addEventListener('click', () => call(
    () => Api.regenerateTenantSeed(tenantId, {
      profile: state.mockData.profile,
      scenario: state.mockData.scenario,
      locale: state.regional && state.regional.locale,
    }),
    'pages.onboarding.summary.demoDataRegenerateDone',
    'pages.onboarding.summary.demoDataRegenerateConfirm',
  ));
  const purgeBtn = body.querySelector('#ob-seed-purge');
  if (purgeBtn) purgeBtn.addEventListener('click', () => call(
    () => Api.purgeTenantSeed(tenantId),
    'pages.onboarding.summary.demoDataPurgeDone',
    'pages.onboarding.summary.demoDataPurgeConfirm',
    true,
  ));
}

/**
 * "Save as template": POST the just-applied declaration to /templates. The
 * SERVER derives the spec (specFromDeclaration) so hosts are dropped wholesale
 * and no credential can ever reach the template — the client never has to be
 * trusted to strip anything.
 */
async function _obSaveAsTemplate(state, run) {
  const suggestedKey = _obSlugify(`${state.tenant.slug || 'tenant'}-template`);
  const html = `
    <div class="modal-header"><h3><i class="fas fa-layer-group" style="margin-right:8px;color:var(--accent)"></i>${Utils.escapeHtml(i18n.t('pages.onboarding.summary.saveAsTemplate'))}</h3>
      <button class="modal-close-btn" id="ob-tpl-x"><i class="fas fa-times"></i></button></div>
    <div class="modal-body">
      <p class="text-sm text-dim">${Utils.escapeHtml(i18n.t('pages.onboarding.summary.saveAsTemplateHelp'))}</p>
      <div class="form-group">
        <label for="ob-tpl-key">${Utils.escapeHtml(i18n.t('pages.onboarding.summary.templateKey'))}</label>
        <input type="text" id="ob-tpl-key" class="form-control mono" value="${Utils.escapeHtml(suggestedKey)}">
      </div>
      <div class="form-group">
        <label for="ob-tpl-name">${Utils.escapeHtml(i18n.t('pages.onboarding.summary.templateName'))}</label>
        <input type="text" id="ob-tpl-name" class="form-control" value="${Utils.escapeHtml(state.tenant.name || suggestedKey)}">
      </div>
      <div class="form-group">
        <label for="ob-tpl-desc">${Utils.escapeHtml(i18n.t('pages.onboarding.summary.templateDescription'))}</label>
        <input type="text" id="ob-tpl-desc" class="form-control" value="">
      </div>
      <div class="form-group">
        <label for="ob-tpl-industry">${Utils.escapeHtml(i18n.t('pages.onboarding.summary.templateIndustry'))}</label>
        <input type="text" id="ob-tpl-industry" class="form-control" value="">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" id="ob-tpl-cancel">${Utils.escapeHtml(i18n.t('common.cancel'))}</button>
      <button class="btn btn-primary" id="ob-tpl-save">${Utils.escapeHtml(i18n.t('common.save'))}</button>
    </div>
  `;
  Modal.open(html, { width: '520px' });
  Modal._content.querySelector('#ob-tpl-x').addEventListener('click', () => Modal.close());
  Modal._content.querySelector('#ob-tpl-cancel').addEventListener('click', () => Modal.close());
  Modal._content.querySelector('#ob-tpl-save').addEventListener('click', async () => {
    const key = (Modal._content.querySelector('#ob-tpl-key').value || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(key)) { Toast.error(i18n.t('pages.onboarding.errors.templateKeyInvalid')); return; }
    const declaration = (run && run.declaration) || buildOnboardingDeclaration(state);
    try {
      await Api.saveOnboardingTemplate({
        key,
        name: (Modal._content.querySelector('#ob-tpl-name').value || key).trim(),
        description: (Modal._content.querySelector('#ob-tpl-desc').value || '').trim(),
        industry: (Modal._content.querySelector('#ob-tpl-industry').value || '').trim(),
        declaration,
      });
      Modal.close();
      state._templates = null; // force a refetch next time the picker opens
      Toast.success(i18n.t('pages.onboarding.summary.templateSaved', { key }));
    } catch (err) {
      Toast.error((err.body && err.body.error) || err.message);
    }
  });
}

// _stepMockData sits between Users and Preview and is mode-gated: active() is
// false in production, so the Wizard primitive drops it from the rail entirely.
const ONBOARDING_STEPS = [
  _stepMode, _stepIdentity, _stepRegional, _stepModules, _stepServers, _stepUsers,
  _stepMockData, _stepPreview, _stepProvision, _stepSummary,
];

// ── the page / launcher ──────────────────────────────────────────────────────
const OnboardingPage = {
  async render(container) {
    const isAdmin = !!(window.App && App.user && App.user.role === 'admin');
    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-rocket"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.launcher.title'))}</h2>
          <div class="page-subtitle">${Utils.escapeHtml(i18n.t('pages.onboarding.launcher.desc'))}</div>
        </div>
        <div class="page-actions">
          ${isAdmin ? `<button class="btn btn-primary" id="ob-launch-btn"><i class="fas fa-play"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.launcher.launchBtn'))}</button>` : ''}
        </div>
      </div>
      <div class="empty-msg">
        ${isAdmin
          ? `<i class="fas fa-server"></i><p>${Utils.escapeHtml(i18n.t('pages.onboarding.launcher.desc'))}</p>`
          : `<i class="fas fa-lock"></i><p>${Utils.escapeHtml(i18n.t('pages.onboarding.launcher.adminOnly'))}</p>`}
      </div>
    `;
    container.querySelector('#ob-launch-btn')?.addEventListener('click', () => this._launch());
    if (isAdmin) await this._launch();
  },

  destroy() { Wizard.close(); },

  async _launch() {
    if (!(window.App && App.user && App.user.role === 'admin')) { Toast.error(i18n.t('pages.onboarding.launcher.adminOnly')); return; }
    let active = null;
    try { const r = await Api.getActiveOnboardingRun(); active = r && r.run; } catch { /* treat as no active run */ }
    if (active) { this._showResumeCard(active); return; }
    this._startFresh();
  },

  _showResumeCard(run) {
    const decl = run.declaration || {};
    const tenantLabel = (decl.tenant && decl.tenant.name) || `#${run.tenantId || '?'}`;
    const lastStepKey = (run.steps || []).slice().reverse().find((s) => s.status !== 'pending');
    const lastStepLabel = lastStepKey ? i18n.t(`pages.onboarding.provision.stepLabels.${lastStepKey.step_key}`) : i18n.t('pages.onboarding.resume.notStarted');
    const html = `
      <div class="modal-header"><h3><i class="fas fa-rotate" style="margin-right:8px;color:var(--accent)"></i>${Utils.escapeHtml(i18n.t('pages.onboarding.resume.title'))}</h3>
        <button class="modal-close-btn" id="ob-resume-x"><i class="fas fa-times"></i></button></div>
      <div class="modal-body">
        <p>${Utils.escapeHtml(i18n.t('pages.onboarding.resume.body', { tenant: tenantLabel, mode: run.mode, step: lastStepLabel, time: Utils.timeAgo(run.startedAt || run.createdAt) }))}</p>
        ${run.error ? `<div class="alert alert-danger" style="background:var(--red-dim);border-left:3px solid var(--red);padding:10px 14px;border-radius:var(--radius-sm);color:var(--red)"><i class="fas fa-circle-exclamation"></i> ${Utils.escapeHtml(run.error)}</div>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-danger" id="ob-resume-startover">${Utils.escapeHtml(i18n.t('pages.onboarding.resume.startOverBtn'))}</button>
        <button class="btn btn-primary" id="ob-resume-go">${Utils.escapeHtml(i18n.t('pages.onboarding.resume.resumeBtn'))}</button>
      </div>
    `;
    Modal.open(html, { width: '520px' });
    Modal._content.querySelector('#ob-resume-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#ob-resume-go').addEventListener('click', () => { Modal.close(); this._resumeRun(run); });
    Modal._content.querySelector('#ob-resume-startover').addEventListener('click', async () => {
      const ok = await Modal.confirm(i18n.t('pages.onboarding.resume.startOverConfirm'), { danger: true, confirmText: i18n.t('pages.onboarding.resume.startOverBtn') });
      if (!ok) return;
      Modal.close();
      try { await Api.rollbackOnboardingRun(run.id); } catch (err) { Toast.error(err.message); }
      this._startFresh();
    });
  },

  _resumeRun(run) {
    const state = this._newState();
    state.mode = run.mode || state.mode;
    state.templateKey = run.templateKey || state.templateKey;
    state.idempotencyKey = run.idempotencyKey || state.idempotencyKey;
    state._run = run;
    state._runId = run.id;
    this._openWizard(state, 'provision');
  },

  _startFresh() {
    this._openWizard(this._newState(), 'mode');
  },

  _newState() {
    let stored = null;
    try {
      const raw = sessionStorage.getItem('dd-onboarding-draft');
      if (raw) stored = JSON.parse(raw);
    } catch { /* ignore corrupt/absent draft */ }
    const base = {
      idempotencyKey: _obUuid(),
      mode: 'production',
      templateKey: ONBOARDING_NOOP_TEMPLATE,
      _slugManuallyEdited: false,
      _kindManuallyEdited: false,
      tenant: { name: '', slug: '', kind: 'internal' },
      regional: {},
      modules: ONBOARDING_MODULE_CATALOG.map((m) => ({ key: m.key, enabled: !!m.defaultOn })),
      nomenclatures: [],
      hosts: [_obBlankHostRow()],
      users: [_obOwnerRow()],
      permissions: [],
      // Phase 3 — demo/trial mock data. Only sent for demo/trial declarations.
      mockData: { profile: 'medium', scenario: 'healthy-shop', seed: '', ack: false },
      _templates: null, _templatesLoading: false, _templatesError: null,
      _seedCatalog: null, _seedCatalogLoading: false, _seedCatalogError: null,
      _seedState: null, _seedStateLoading: false,
      _plan: null, _planError: null, _planLoading: false, _reviewedAck: false,
      _run: null, _runId: null, _applying: false, _applyError: null,
    };
    if (stored && stored.tenant) {
      Object.assign(base, {
        idempotencyKey: stored.idempotencyKey || base.idempotencyKey,
        // v8.17.0 (Phase 3): demo/trial are real modes now, so the draft's mode is
        // restored — but only from the closed allow-list, never trusted verbatim.
        mode: ['production', 'trial', 'demo'].includes(stored.mode) ? stored.mode : 'production',
        templateKey: stored.templateKey || base.templateKey,
        tenant: stored.tenant,
        regional: stored.regional || {},
        modules: stored.modules && stored.modules.length ? stored.modules : base.modules,
        nomenclatures: stored.nomenclatures || [],
        // The ack is deliberately NOT restored — the user re-confirms every session.
        mockData: {
          profile: ONBOARDING_SEED_PROFILES.includes(stored.mockData && stored.mockData.profile) ? stored.mockData.profile : base.mockData.profile,
          scenario: ONBOARDING_SEED_SCENARIOS.includes(stored.mockData && stored.mockData.scenario) ? stored.mockData.scenario : base.mockData.scenario,
          seed: (stored.mockData && typeof stored.mockData.seed === 'string') ? stored.mockData.seed : '',
          ack: false,
        },
        hosts: (stored.hosts && stored.hosts.length ? stored.hosts : [_obBlankHostRow()]).map((h) => ({ ..._obBlankHostRow(), ...h, _probe: { status: 'idle' } })),
        users: (stored.users && stored.users.length ? stored.users : [_obOwnerRow()]).map((u) => (u.isOwner ? _obOwnerRow() : { ..._obBlankUserRow(), ...u, password: '', _confirmPassword: '' })),
        permissions: stored.permissions || [],
      });
    }
    return base;
  },

  _openWizard(state, startIndex) {
    Wizard.open({
      steps: ONBOARDING_STEPS,
      state,
      title: i18n.t('pages.onboarding.shell.title'),
      pill: _obModePillFor,
      startIndex,
      persist: async (s) => {
        try { sessionStorage.setItem('dd-onboarding-draft', JSON.stringify(_obNonSecretSnapshot(s))); } catch { /* storage full/unavailable — non-fatal */ }
      },
      onFinish: () => {
        try { sessionStorage.removeItem('dd-onboarding-draft'); } catch { /* ignore */ }
        Wizard.close();
        Toast.success(i18n.t('pages.onboarding.summary.finish'));
        App.navigate('/dashboard');
      },
      onExit: () => {
        Toast.info(i18n.t('pages.onboarding.shell.savedExit'));
      },
    });
  },
};

window.OnboardingPage = OnboardingPage;
