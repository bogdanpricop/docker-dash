'use strict';

// v8.96.0 — bucketed downsampling for diagnostic sessions.
//
// The deep-spec set this as a gate before the schema was allowed to settle: the
// frontend has no charting framework and no build step, so a session must arrive
// pre-reduced to a fixed pixel budget. Sending 25 series × several thousand raw
// points and reducing in the browser is not an option we have.
//
// Three rules from the deep-spec's failure-mode analysis are encoded here, and
// they are the whole reason this is a module rather than a one-line map:
//
//   1. A GAP MUST LOOK LIKE A GAP. An empty bucket yields `null`, never 0.
//      Rendering missing data as zero is the most common monitoring UI bug and
//      reads as "the workload was idle" when it means "we have no data".
//   2. NEVER INTERPOLATE ACROSS SOURCES. Providers sample at their own cadence;
//      inventing intermediate points produces confident wrong charts. Callers
//      render provider series stepped, and this never fabricates a value.
//   3. CUMULATIVE COUNTERS RESET. net_rx/blk_read are monotonic per container
//      life; a restart returns them to zero. A naive delta then shows a large
//      negative spike. `deltas()` detects the reset and breaks the series.

/** Bucket boundaries covering [from, to) split into `buckets` equal spans. */
function bucketEdges(from, to, buckets) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const n = Math.max(1, Math.min(5000, Math.floor(buckets) || 1));
  const width = (end - start) / n;
  return { start, end, width, count: n };
}

/**
 * Reduce timestamped points to a fixed number of buckets.
 *
 * @param {Array<{t: string|number|Date, v: number|null}>} points
 * @param {object} opts
 * @param {string|number|Date} opts.from
 * @param {string|number|Date} opts.to
 * @param {number} [opts.buckets=600]  pixel budget per series
 * @param {'avg'|'max'|'last'|'sum'} [opts.aggregate='avg']
 * @returns {Array<{t: string, v: number|null}>} one entry per bucket, in order
 */
function downsample(points, { from, to, buckets = 600, aggregate = 'avg' } = {}) {
  const edges = bucketEdges(from, to, buckets);
  if (!edges) return [];

  const sums = new Float64Array(edges.count);
  const counts = new Int32Array(edges.count);
  const maxes = new Float64Array(edges.count).fill(Number.NEGATIVE_INFINITY);
  const lasts = new Float64Array(edges.count);

  for (const p of Array.isArray(points) ? points : []) {
    if (!p) continue;
    // `Number(null)` is 0, so a missing reading would silently become a measured
    // zero — the precise failure this module exists to prevent. Reject the
    // nullish values before any numeric coercion touches them.
    if (p.v === null || p.v === undefined || p.v === '') continue;
    const value = Number(p.v);
    if (!Number.isFinite(value)) continue;
    const ts = new Date(p.t).getTime();
    if (!Number.isFinite(ts) || ts < edges.start || ts >= edges.end) continue;
    const i = Math.min(edges.count - 1, Math.floor((ts - edges.start) / edges.width));
    sums[i] += value;
    counts[i] += 1;
    if (value > maxes[i]) maxes[i] = value;
    lasts[i] = value;                               // points arrive time-ordered
  }

  const out = new Array(edges.count);
  for (let i = 0; i < edges.count; i++) {
    const t = new Date(Math.round(edges.start + i * edges.width)).toISOString();
    if (counts[i] === 0) { out[i] = { t, v: null }; continue; }  // rule 1
    let v;
    if (aggregate === 'max') v = maxes[i];
    else if (aggregate === 'last') v = lasts[i];
    else if (aggregate === 'sum') v = sums[i];
    else v = sums[i] / counts[i];
    out[i] = { t, v };
  }
  return out;
}

/**
 * Convert a cumulative counter series into per-interval deltas.
 *
 * A decrease means the counter reset — the container was recreated — so the
 * delta for that point is unknowable and yields `null` rather than a negative
 * spike or a fabricated zero.
 */
function deltas(points) {
  const out = [];
  let prev = null;
  for (const p of Array.isArray(points) ? points : []) {
    if (!p) continue;
    // Same coercion trap as above: a nullish reading is absent, not zero, and it
    // also invalidates the baseline — the next delta has nothing to subtract from.
    const missing = p.v === null || p.v === undefined || p.v === '';
    const value = missing ? NaN : Number(p.v);
    if (!Number.isFinite(value)) { out.push({ t: p.t, v: null }); prev = null; continue; }
    if (prev === null) { out.push({ t: p.t, v: null }); prev = value; continue; }  // no baseline yet
    out.push({ t: p.t, v: value < prev ? null : value - prev });                    // rule 3
    prev = value;
  }
  return out;
}

/**
 * Largest clock offset between sources, in milliseconds.
 *
 * The deep-spec ranks clock skew as the single highest correctness risk: two
 * series drawn on one axis are only comparable if their clocks agree. This does
 * not correct anything — correcting would hide the problem — it reports the
 * spread so the UI can warn instead of quietly lying.
 *
 * @param {Array<{source: string, latest: string|number|Date}>} observations
 */
function clockSkewMs(observations) {
  const times = (Array.isArray(observations) ? observations : [])
    .map(o => new Date(o && o.latest).getTime())
    .filter(Number.isFinite);
  if (times.length < 2) return 0;
  return Math.max(...times) - Math.min(...times);
}

module.exports = { downsample, deltas, clockSkewMs, _internals: { bucketEdges } };
