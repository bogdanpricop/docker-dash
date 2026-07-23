'use strict';

// v8.17.0 (Onboarding — Phase 3) — deterministic PRNG for the mock-data generator.
//
// mulberry32: ~10 lines, no dependency, excellent distribution for our purposes.
// EVERY random decision in every entity module flows through ONE instance seeded
// from `seed_datasets.seed`, so a fixed (seed, profile, scenario, locale) tuple
// produces a byte-identical dataset — required for reproducible demos, stable
// screenshots and the determinism acceptance test.
//
// `Math.random()` is FORBIDDEN anywhere under seed/ (a lint-by-review rule the
// determinism test enforces empirically).

const crypto = require('crypto');

/** The raw mulberry32 step function. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fold any seed representation into a stable uint32.
 * A numeric string/number is used directly; anything else is sha256-derived so
 * `seed: 'my-demo'` is as deterministic as `seed: 12345`.
 */
function toUint32(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  const s = String(seed === undefined || seed === null ? '' : seed);
  if (/^\d{1,10}$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n >>> 0;
  }
  return parseInt(crypto.createHash('sha256').update(s).digest('hex').slice(0, 8), 16) >>> 0;
}

/**
 * Derive a stable seed for a tenant/profile/scenario/locale tuple when the caller
 * did not supply one. Same inputs ⇒ same dataset; different tenants differ.
 */
function deriveSeed({ slug, profile, scenario, locale }) {
  return toUint32(`${slug || 'tenant'}:${profile}:${scenario}:${locale || 'en'}`);
}

// ── RFC-reserved address/hostname pools (the synthetic-only chokepoints) ─────
// Every IP the generator ever emits comes from rfc1918()/testNet(); every
// hostname from hostname()/fqdn(). These are the SINGLE audited chokepoints the
// acceptance test asserts against, so a real routable address can never leak in.
const RFC1918_RE = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/;
const TESTNET_RE = /^(192\.0\.2\.\d{1,3}|198\.51\.100\.\d{1,3}|203\.0\.113\.\d{1,3})$/;

/** True if `ip` is inside RFC1918 or TEST-NET-1/2/3 (the only allowed pools). */
function isSyntheticIp(ip) {
  return RFC1918_RE.test(String(ip)) || TESTNET_RE.test(String(ip));
}

class Prng {
  constructor(seed) {
    this.seedValue = toUint32(seed);
    this._next = mulberry32(this.seedValue);
  }

  /** Uniform float in [0,1). */
  float() { return this._next(); }

  /** Uniform integer in [min,max] inclusive. */
  int(min, max) {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this._next() * (max - min + 1));
  }

  /** Uniform float in [min,max). */
  range(min, max) { return min + this._next() * (max - min); }

  /** true with probability p. */
  bool(p = 0.5) { return this._next() < p; }

  /** One element of a non-empty array. */
  pick(arr) {
    if (!Array.isArray(arr) || !arr.length) throw new Error('prng.pick: empty array');
    return arr[Math.floor(this._next() * arr.length)];
  }

  /** Weighted pick from [[value, weight], ...]. */
  weighted(pairs) {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = this._next() * total;
    for (const [value, w] of pairs) { r -= w; if (r <= 0) return value; }
    return pairs[pairs.length - 1][0];
  }

  /** Fisher-Yates on a COPY (never mutates the caller's array). */
  shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** n distinct elements (or the whole array if n >= length). */
  sample(arr, n) { return this.shuffle(arr).slice(0, Math.max(0, n)); }

  /** Box-Muller normal, clamped to [min,max] when supplied. */
  gaussian(mean, sd, min, max) {
    const u = Math.max(1e-9, this._next());
    const v = this._next();
    let x = mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    if (min !== undefined) x = Math.max(min, x);
    if (max !== undefined) x = Math.min(max, x);
    return x;
  }

  /** Lowercase hex string of length n (container ids, uuids, tokens). */
  hex(n) {
    let s = '';
    while (s.length < n) s += Math.floor(this._next() * 0x100000000).toString(16).padStart(8, '0');
    return s.slice(0, n);
  }

  /** RFC-4122-shaped v4 uuid — PRNG-backed (NOT crypto.randomUUID: must replay). */
  uuid() {
    const h = this.hex(32).split('');
    h[12] = '4';
    h[16] = '89ab'[Math.floor(this._next() * 4)];
    const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }

  /** An RFC 1918 address. THE only way the generator produces a host address. */
  rfc1918() {
    return this.weighted([
      [() => `10.20.${this.int(0, 255)}.${this.int(2, 254)}`, 5],
      [() => `172.${this.int(16, 31)}.${this.int(0, 255)}.${this.int(2, 254)}`, 2],
      [() => `192.168.${this.int(0, 255)}.${this.int(2, 254)}`, 3],
    ])();
  }

  /** A TEST-NET-1/2/3 address (RFC 5737) — used for "external" firewall sources. */
  testNet() {
    const base = this.pick(['192.0.2', '198.51.100', '203.0.113']);
    return `${base}.${this.int(1, 254)}`;
  }

  /** A TEST-NET CIDR (documentation-only range, never routable). */
  testNetCidr() {
    const base = this.pick(['192.0.2', '198.51.100', '203.0.113']);
    return `${base}.0/24`;
  }

  /** An RFC 1918 CIDR. */
  rfc1918Cidr() {
    return this.pick([`10.20.${this.int(0, 250)}.0/24`, `172.${this.int(16, 31)}.0.0/16`, `192.168.${this.int(0, 250)}.0/24`]);
  }

  /**
   * A backdated ISO-ish timestamp `YYYY-MM-DD HH:MM:SS` (UTC, matching every
   * table's `datetime('now')` convention) between two epoch-ms bounds.
   */
  dateBetween(fromMs, toMs) {
    return toSqlTime(this.int(0, Math.max(0, toMs - fromMs)) + fromMs);
  }
}

/** epoch-ms → `YYYY-MM-DD HH:MM:SS` (the SQLite datetime('now') shape). */
function toSqlTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** epoch-ms → full ISO-8601 with Z (audit_log.created_at shape). */
function toIso(ms) {
  return new Date(ms).toISOString();
}

module.exports = {
  Prng, mulberry32, toUint32, deriveSeed, isSyntheticIp, toSqlTime, toIso,
  RFC1918_RE, TESTNET_RE,
};
