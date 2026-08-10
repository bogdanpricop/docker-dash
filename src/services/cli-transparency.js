'use strict';

// v8.94.0 — CLI Transparency. Derives the `docker` / `docker compose` command
// that a Docker Dash action is equivalent to, so the UI can show it BEFORE the
// action runs and the audit log can record it after.
//
// Origin: the "web UIs mask the underlying complexity" criticism levelled at
// Proxmox. The answer is not to become a CLI — it is to stop being a black box.
// See plans/feature-spec-cli-transparency.md.
//
// This module is PURE. No DB, no Docker API, no fs, no child_process. Input is a
// plain object; output is a string. That is what makes it safe to expose on a
// read-only endpoint and cheap to test exhaustively.
//
// It NEVER accepts a caller-supplied command string. Callers pass an action key
// from the fixed table below plus typed params; anything else is rejected. A
// "render this command for me" API would be command injection wearing a hat.

const { _internals } = require('./secret-reference-admission');

// Same pattern the manifest admission layer uses — deliberately shared so the
// two can't drift apart. See the export comment in secret-reference-admission.js.
const SECRET_KEY = _internals.SECRET_KEY;

// Arguments made only of these characters carry no meaning to a POSIX shell, so
// they are emitted bare for readability. Everything else is single-quoted.
const BARE_SAFE = /^[A-Za-z0-9._:/@=-]+$/;

// Bulk actions render one line per subject. The cap keeps a pathological request
// from producing a megabyte of text on a read-only endpoint.
const MAX_BULK_SUBJECTS = 100;

const CONTINUATION = ' \\\n  ';

/**
 * Quote a value so a POSIX shell receives it as exactly one argument.
 *
 * Single-quoting is the only general rule that needs no per-character allowlist:
 * inside single quotes the shell interprets nothing. The embedded-quote dance
 * (`'\''`) closes the quote, emits an escaped quote, and reopens.
 *
 * @param {*} value
 * @returns {string} shell-safe token
 */
function shellEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s === '') return "''";
  if (BARE_SAFE.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Mask the value of a `KEY=VALUE` pair when KEY looks like a secret.
 *
 * The key stays visible — an operator needs to know DB_PASSWORD is being set.
 * The value is replaced outright, never hashed and never truncated: a truncated
 * secret is still a secret.
 *
 * @param {string} pair
 * @returns {{ text: string, redacted: boolean }}
 */
function redactEnvPair(pair) {
  const s = pair === null || pair === undefined ? '' : String(pair);
  const eq = s.indexOf('=');
  if (eq <= 0) return { text: s, redacted: false };
  const key = s.slice(0, eq);
  if (!SECRET_KEY.test(key)) return { text: s, redacted: false };
  return { text: `${key}=<redacted>`, redacted: true };
}

function _subject(params) {
  const v = params && (params.name || params.id);
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function _flag(condition, flag) {
  return condition ? ` ${flag}` : '';
}

// ─── Container lifecycle ──────────────────────────────────────────────────────
// These map 1:1 onto a docker verb, which is exactly why they are in v1: there
// is no translation ambiguity to get wrong.

const LIFECYCLE_VERBS = {
  'container.start': 'start',
  'container.stop': 'stop',
  'container.restart': 'restart',
  'container.pause': 'pause',
  'container.unpause': 'unpause',
  'container.kill': 'kill',
};

function _lifecycle(verb) {
  return (params) => {
    const subject = _subject(params);
    return subject ? `docker ${verb} ${shellEscape(subject)}` : null;
  };
}

function _containerRemove(params) {
  const subject = _subject(params);
  if (!subject) return null;
  return `docker rm${_flag(params.force, '-f')}${_flag(params.volumes, '-v')} ${shellEscape(subject)}`;
}

function _containerRename(params) {
  const subject = _subject(params);
  const next = params && params.newName ? String(params.newName).trim() : '';
  if (!subject || !next) return null;
  return `docker rename ${shellEscape(subject)} ${shellEscape(next)}`;
}

function _containerBulk(params, state) {
  const verb = params && params.action ? String(params.action).trim() : '';
  const inner = verb ? `container.${verb}` : '';
  const subjects = Array.isArray(params && params.subjects) ? params.subjects : [];
  if (!subjects.length) return null;
  if (verb === 'bulk') return null; // a bulk of bulks is not a thing
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, inner)) return null;

  const shown = subjects.slice(0, MAX_BULK_SUBJECTS);
  const lines = [];
  for (const s of shown) {
    const line = ACTIONS[inner](typeof s === 'object' && s !== null ? s : { name: s }, state);
    if (line) lines.push(line);
  }
  if (!lines.length) return null;
  if (subjects.length > shown.length) {
    lines.push(`# ... and ${subjects.length - shown.length} more`);
  }
  return lines.join('\n');
}

/**
 * Render a `docker run` for a NORMALIZED container definition.
 *
 * Deliberately not Docker's inspect wire format — the caller maps into this
 * shape. Keeping the wire format out of here is what lets the same function
 * serve a create dialog, a clone preview and (eventually) container export.
 *
 * @param {object} params
 * @param {string} params.image
 * @param {string} [params.name]
 * @param {string[]} [params.env]           `KEY=VALUE` pairs; secret values masked
 * @param {Array}   [params.ports]          `{ host, container, proto }`
 * @param {Array}   [params.volumes]        `{ source, target, readOnly }`
 * @param {string[]}[params.networks]
 * @param {object}  [params.labels]
 * @param {string}  [params.restart]
 * @param {string}  [params.memory]
 * @param {number}  [params.cpus]
 * @param {boolean} [params.detach=true]
 * @param {string[]}[params.command]
 */
function _containerRun(params, state) {
  const image = params && params.image ? String(params.image).trim() : '';
  if (!image) return null;

  const parts = [`docker run${params.detach === false ? '' : ' -d'}`];
  const name = _subject(params);
  if (name) parts.push(`--name ${shellEscape(name)}`);
  if (params.restart && params.restart !== 'no') parts.push(`--restart ${shellEscape(params.restart)}`);

  for (const pair of Array.isArray(params.env) ? params.env : []) {
    const { text, redacted } = redactEnvPair(pair);
    if (redacted) state.redacted = true;
    parts.push(`-e ${shellEscape(text)}`);
  }

  for (const p of Array.isArray(params.ports) ? params.ports : []) {
    if (!p || p.container === undefined || p.container === null) continue;
    const proto = p.proto && p.proto !== 'tcp' ? `/${p.proto}` : '';
    const host = p.host === undefined || p.host === null || p.host === '' ? '' : `${p.host}:`;
    parts.push(`-p ${shellEscape(`${host}${p.container}${proto}`)}`);
  }

  for (const v of Array.isArray(params.volumes) ? params.volumes : []) {
    if (!v || !v.source || !v.target) continue;
    parts.push(`-v ${shellEscape(`${v.source}:${v.target}${v.readOnly ? ':ro' : ''}`)}`);
  }

  for (const n of Array.isArray(params.networks) ? params.networks : []) {
    if (n) parts.push(`--network ${shellEscape(n)}`);
  }

  if (params.memory) parts.push(`--memory ${shellEscape(params.memory)}`);
  if (params.cpus) parts.push(`--cpus ${shellEscape(params.cpus)}`);

  for (const [k, v] of Object.entries(params.labels || {})) {
    const { text, redacted } = redactEnvPair(`${k}=${v}`);
    if (redacted) state.redacted = true;
    parts.push(`--label ${shellEscape(text)}`);
  }

  parts.push(shellEscape(image));
  for (const c of Array.isArray(params.command) ? params.command : []) {
    parts.push(shellEscape(c));
  }
  return parts.join(CONTINUATION);
}

// ─── Images, volumes, networks, prune ─────────────────────────────────────────

function _imagePull(params) {
  const ref = params && params.ref ? String(params.ref).trim() : '';
  return ref ? `docker pull ${shellEscape(ref)}` : null;
}

function _imageRemove(params) {
  const ref = (params && (params.ref || params.id)) ? String(params.ref || params.id).trim() : '';
  return ref ? `docker rmi${_flag(params.force, '-f')} ${shellEscape(ref)}` : null;
}

function _volumeRemove(params) {
  const subject = _subject(params);
  return subject ? `docker volume rm${_flag(params.force, '-f')} ${shellEscape(subject)}` : null;
}

function _networkRemove(params) {
  const subject = _subject(params);
  return subject ? `docker network rm ${shellEscape(subject)}` : null;
}

function _prune(object) {
  return (params) => `docker ${object} prune -f${_flag(object === 'image' && params && params.all, '-a')}`;
}

// ─── Compose stacks ───────────────────────────────────────────────────────────

function _compose(tail) {
  return (params) => {
    const file = params && params.file ? String(params.file).trim() : '';
    if (!file) return null;
    const project = params.project ? ` -p ${shellEscape(String(params.project))}` : '';
    return `docker compose${project} -f ${shellEscape(file)} ${tail}`;
  };
}

// ─── Action table ─────────────────────────────────────────────────────────────
// The allowlist. An action absent from here has NO CLI equivalent as far as this
// module is concerned — we say so honestly rather than guessing a command that an
// operator might paste into a production shell.

const ACTIONS = {
  'container.remove': _containerRemove,
  'container.rename': _containerRename,
  'container.bulk': _containerBulk,
  'container.run': _containerRun,
  'image.pull': _imagePull,
  'image.remove': _imageRemove,
  'volume.remove': _volumeRemove,
  'network.remove': _networkRemove,
  'prune.containers': _prune('container'),
  'prune.images': _prune('image'),
  'prune.volumes': _prune('volume'),
  'prune.networks': _prune('network'),
  'prune.buildcache': _prune('builder'),
  'stack.up': _compose('up -d'),
  'stack.down': _compose('down'),
  'stack.restart': _compose('restart'),
  'stack.pull': _compose('pull'),
};

for (const [key, verb] of Object.entries(LIFECYCLE_VERBS)) ACTIONS[key] = _lifecycle(verb);

function _unavailable(reason) {
  return { available: false, command: null, hostLabel: null, redacted: false, reason };
}

/**
 * Derive the CLI command an action is equivalent to.
 *
 * Never throws — an unknown action or malformed params yields
 * `{ available: false, reason }`. A transparency feature must never be able to
 * block the action it describes.
 *
 * @param {string} actionKey one of `listActions()`
 * @param {object} [params]  action-specific; `hostName` is common to all
 * @returns {{available: boolean, command: string|null, hostLabel: string|null,
 *            redacted: boolean, reason: string|null}}
 */
function describe(actionKey, params) {
  const key = typeof actionKey === 'string' ? actionKey.trim() : '';
  // hasOwnProperty, not `in` — `__proto__` and `constructor` are not actions.
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, key)) return _unavailable('unknown-action');

  const p = params && typeof params === 'object' ? params : {};
  const state = { redacted: false };
  let command = null;
  try { command = ACTIONS[key](p, state); }
  catch { return _unavailable('invalid-params'); }
  if (!command) return _unavailable('invalid-params');

  return {
    available: true,
    command,
    hostLabel: p.hostName ? String(p.hostName) : null,
    redacted: state.redacted,
    reason: null,
  };
}

/** Every action key this module can render. Used by the route's allowlist check. */
function listActions() {
  return Object.keys(ACTIONS).sort();
}

module.exports = {
  describe,
  listActions,
  shellEscape,
  redactEnvPair,
  _internals: { BARE_SAFE, MAX_BULK_SUBJECTS, LIFECYCLE_VERBS },
};
