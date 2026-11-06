'use strict';

// v8.96.0 — the three rules the deep-spec identified as what breaks this class
// of feature. Each is a real monitoring-UI bug, not a hypothetical.

const { downsample, deltas, clockSkewMs } = require('../services/diagnostics/downsample');

const FROM = '2026-08-11T00:00:00.000Z';
const TO = '2026-08-11T00:10:00.000Z';
const at = (min, sec = 0) => new Date(Date.parse(FROM) + (min * 60 + sec) * 1000).toISOString();

describe('downsample — a gap must look like a gap', () => {
  it('yields null for empty buckets, never zero', () => {
    const out = downsample([{ t: at(0), v: 42 }], { from: FROM, to: TO, buckets: 10 });
    expect(out).toHaveLength(10);
    expect(out[0].v).toBe(42);
    expect(out.slice(1).every(b => b.v === null)).toBe(true);
    // The distinction the whole rule exists for.
    expect(out.some(b => b.v === 0)).toBe(false);
  });

  it('treats a null or NaN reading as absent, not as zero', () => {
    const out = downsample(
      [{ t: at(0), v: null }, { t: at(1), v: NaN }, { t: at(2), v: 5 }],
      { from: FROM, to: TO, buckets: 10 }
    );
    expect(out[0].v).toBeNull();
    expect(out[1].v).toBeNull();
    expect(out[2].v).toBe(5);
  });

  it('distinguishes a real zero reading from missing data', () => {
    const out = downsample([{ t: at(0), v: 0 }], { from: FROM, to: TO, buckets: 10 });
    expect(out[0].v).toBe(0);      // measured idle
    expect(out[1].v).toBeNull();   // no measurement
  });
});

describe('downsample — bucketing', () => {
  it('averages by default', () => {
    const out = downsample([{ t: at(0), v: 10 }, { t: at(0, 30), v: 20 }], { from: FROM, to: TO, buckets: 10 });
    expect(out[0].v).toBe(15);
  });

  it('supports max, last and sum', () => {
    const pts = [{ t: at(0), v: 10 }, { t: at(0, 30), v: 20 }];
    const o = (aggregate) => downsample(pts, { from: FROM, to: TO, buckets: 10, aggregate })[0].v;
    expect(o('max')).toBe(20);
    expect(o('last')).toBe(20);
    expect(o('sum')).toBe(30);
  });

  it('drops points outside the window rather than clamping them in', () => {
    const out = downsample([
      { t: '2026-08-10T23:00:00.000Z', v: 99 },
      { t: '2026-08-11T01:00:00.000Z', v: 99 },
      { t: at(5), v: 7 },
    ], { from: FROM, to: TO, buckets: 10 });
    expect(out.filter(b => b.v !== null)).toEqual([expect.objectContaining({ v: 7 })]);
  });

  it('returns exactly the requested bucket count on a shared axis', () => {
    const a = downsample([{ t: at(1), v: 1 }], { from: FROM, to: TO, buckets: 600 });
    const b = downsample([{ t: at(9), v: 2 }], { from: FROM, to: TO, buckets: 600 });
    expect(a).toHaveLength(600);
    expect(b).toHaveLength(600);
    // Same axis: bucket i means the same instant for every series.
    expect(a.map(x => x.t)).toEqual(b.map(x => x.t));
  });

  it('returns an empty axis, not an empty array, when there are no points', () => {
    // The axis exists even when nothing was recorded on it — that is what makes
    // "no data" visible rather than absent.
    const out = downsample(null, { from: FROM, to: TO, buckets: 10 });
    expect(out).toHaveLength(10);
    expect(out.every(b => b.v === null)).toBe(true);
  });

  it('returns nothing when the window itself is unusable', () => {
    expect(downsample([], { from: 'nonsense', to: TO })).toEqual([]);
    expect(downsample([], { from: TO, to: FROM })).toEqual([]);  // inverted window
  });
});

describe('deltas — a counter reset must break the series', () => {
  it('returns null at the reset instead of a negative spike', () => {
    // A container restart returns net_rx to zero. Naive subtraction draws a cliff.
    expect(deltas([{ t: 1, v: 100 }, { t: 2, v: 150 }, { t: 3, v: 10 }, { t: 4, v: 40 }]).map(d => d.v))
      .toEqual([null, 50, null, 30]);
  });

  it('has no baseline for the first point', () => {
    expect(deltas([{ t: 1, v: 100 }]).map(d => d.v)).toEqual([null]);
  });

  it('never emits a negative delta', () => {
    const out = deltas([{ t: 1, v: 500 }, { t: 2, v: 1 }, { t: 3, v: 2 }]);
    expect(out.every(d => d.v === null || d.v >= 0)).toBe(true);
  });

  it('resets its baseline after a missing reading', () => {
    expect(deltas([{ t: 1, v: 10 }, { t: 2, v: null }, { t: 3, v: 50 }]).map(d => d.v))
      .toEqual([null, null, null]);
  });
});

describe('clockSkewMs — report, never correct', () => {
  it('measures the spread between sources', () => {
    expect(clockSkewMs([
      { source: 'docker', latest: '2026-08-11T00:00:00Z' },
      { source: 'vsphere', latest: '2026-08-11T00:00:07Z' },
    ])).toBe(7000);
  });

  it('is zero with fewer than two sources', () => {
    expect(clockSkewMs([{ source: 'docker', latest: FROM }])).toBe(0);
    expect(clockSkewMs([])).toBe(0);
    expect(clockSkewMs(null)).toBe(0);
  });

  it('ignores unparseable timestamps rather than reporting a wild skew', () => {
    expect(clockSkewMs([
      { source: 'a', latest: 'not a date' },
      { source: 'b', latest: '2026-08-11T00:00:00Z' },
    ])).toBe(0);
  });
});

describe('downsample — the rendering gate', () => {
  it('reduces 25 series of 15-minute 1s data within the frame budget', () => {
    const from = FROM;
    const to = new Date(Date.parse(FROM) + 15 * 60 * 1000).toISOString();
    const raw = [];
    for (let i = 0; i < 900; i++) raw.push({ t: new Date(Date.parse(from) + i * 1000).toISOString(), v: i % 97 });

    const started = Date.now();
    let total = 0;
    for (let s = 0; s < 25; s++) total += downsample(raw, { from, to, buckets: 600 }).length;
    const elapsed = Date.now() - started;

    expect(total).toBe(25 * 600);
    // Generous ceiling: measured at ~20ms. This asserts the order of magnitude,
    // which is what the deep-spec gated the schema on.
    expect(elapsed).toBeLessThan(2000);
  });
});
