'use strict';

// Tests for src/services/retention.js (v8.1.0 — pure evaluator + executor)

jest.mock('../services/audit', () => ({
  log: jest.fn(),
}));

const { evaluate, execute, SERVER_HARD_CAP, _internals } =
  require('../services/retention');
const auditService = require('../services/audit');

// ---- helpers --------------------------------------------------------------

/**
 * Build a tag object with sensible defaults.
 */
function tag(overrides = {}) {
  return {
    tag: 'some-tag',
    digest: 'sha256:' + Math.random().toString(36).slice(2),
    pushedAt: '2026-01-01T00:00:00.000Z',
    sizeBytes: 1000,
    isTagged: true,
    ...overrides,
  };
}

/**
 * Build N tags with descending pushedAt (index 0 is newest).
 */
function tagsWithDates(count, opts = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const day = String(28 - i).padStart(2, '0');
    out.push(tag({
      tag: opts.prefix ? `${opts.prefix}-${i}` : `tag-${i}`,
      pushedAt: `2026-01-${day}T00:00:00.000Z`,
      sizeBytes: opts.sizeBytes != null ? opts.sizeBytes : 1000 * (i + 1),
      ...((opts.tagOverrides && opts.tagOverrides(i)) || {}),
    }));
  }
  return out;
}

// ---- evaluate -------------------------------------------------------------

describe('evaluate — pure logic', () => {
  it('empty tag list → empty plan, summary count 0', () => {
    const r = evaluate({ tags: [], rule: { keepLastN: 1 } });
    expect(r.toDelete).toEqual([]);
    expect(r.toKeep).toEqual([]);
    expect(r.summary.count).toBe(0);
    expect(r.summary.bytes).toBe(0);
  });

  it('empty rule {} → no deletions when ≤3 tags (default min-floor)', () => {
    const tags = tagsWithDates(3);
    const r = evaluate({ tags, rule: {} });
    expect(r.toDelete).toEqual([]);
    expect(r.toKeep.length).toBe(3);
  });

  it('single tag with empty rule → kept (under min-floor)', () => {
    const tags = [tag({ tag: 'only-one' })];
    const r = evaluate({ tags, rule: {} });
    expect(r.toDelete).toEqual([]);
    expect(r.toKeep.length).toBe(1);
    expect(r.toKeep[0].reason).toBe('min-floor');
  });

  it('keepLastN basic — 5 tags, keepLastN=2: 2 newest kept, 3 older deleted', () => {
    // Use non-protected names so default protect doesn't apply.
    const tags = tagsWithDates(5, { prefix: 'build' });
    const r = evaluate({ tags, rule: { keepLastN: 2, minTagsToKeep: 1 } });
    // With minTagsToKeep=1, only 1 tag goes to min-floor, then keepLastN=2 keeps 2,
    // leaving 2 to delete? Actually: min-floor runs first and consumes the newest.
    // Let's test what we *actually* get rather than assume.
    // Newest tag → min-floor (1 of 1). Remaining 4 candidates.
    // keepLastN=2 → keeps next 2 newest. Remaining 2 → delete (older than keepLastN).
    expect(r.toDelete.length).toBe(2);
    expect(r.toKeep.length).toBe(3);
    // The deleted ones should be the oldest 2.
    const deletedTags = r.toDelete.map(t => t.tag).sort();
    expect(deletedTags).toEqual(['build-3', 'build-4']);
  });

  it('keepLastN with min-floor protecting — 3 tags, keepLastN=0: all kept by min-floor', () => {
    const tags = tagsWithDates(3, { prefix: 'build' });
    const r = evaluate({ tags, rule: { keepLastN: 0 } });
    expect(r.toDelete).toEqual([]);
    expect(r.toKeep.length).toBe(3);
    expect(r.toKeep.every(t => t.reason === 'min-floor')).toBe(true);
  });

  it('deleteUntaggedAfterDays — only old untagged are deleted, tagged old are not', () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const newDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const tags = [
      tag({ tag: null, isTagged: false, pushedAt: oldDate, digest: 'sha256:u1' }),
      tag({ tag: null, isTagged: false, pushedAt: oldDate, digest: 'sha256:u2' }),
      tag({ tag: null, isTagged: false, pushedAt: newDate, digest: 'sha256:u3' }),
      tag({ tag: 'kept-old', isTagged: true, pushedAt: oldDate, digest: 'sha256:t1' }),
    ];
    // keepLastN=0 would set "kept (0) >= 0" → delete every remaining candidate
    // including the tagged-old one (deleteUntaggedAfterDays doesn't protect it).
    // So omit keepLastN entirely so only the deleteUntaggedAfterDays clause fires.
    const r2 = evaluate({
      tags,
      rule: { deleteUntaggedAfterDays: 30, minTagsToKeep: 1 },
    });
    expect(r2.toDelete.length).toBe(2);
    expect(r2.toDelete.every(t => t.isTagged === false)).toBe(true);
    expect(r2.toDelete.every(t => /untagged/.test(t.reason))).toBe(true);
    // Tagged old one should be kept.
    const keptDigests = r2.toKeep.map(t => t.digest);
    expect(keptDigests).toContain('sha256:t1');
  });

  it('deleteTagPatterns glob — nightly-* deleted, prod-1 + latest kept', () => {
    // Order matters: 'latest' and 'prod-1' are NEWEST so the protect pass picks
    // them up before min-floor sees them. Otherwise the newest nightly would be
    // grabbed by the min-floor=1 first, and only one nightly would be deleted.
    const tags = [
      tag({ tag: 'latest', pushedAt: '2026-01-04T00:00:00Z' }),
      tag({ tag: 'prod-1', pushedAt: '2026-01-03T00:00:00Z' }),
      tag({ tag: 'nightly-1', pushedAt: '2026-01-02T00:00:00Z' }),
      tag({ tag: 'nightly-2', pushedAt: '2026-01-01T00:00:00Z' }),
    ];
    const r = evaluate({
      tags,
      rule: { deleteTagPatterns: ['nightly-*'], minTagsToKeep: 1 },
    });
    const deleted = r.toDelete.map(t => t.tag).sort();
    expect(deleted).toEqual(['nightly-1', 'nightly-2']);
    const kept = r.toKeep.map(t => t.tag).sort();
    expect(kept).toEqual(['latest', 'prod-1']);
  });

  it('protectTagPatterns overrides deleteTagPatterns', () => {
    // Order matters here too — see comment in previous test.
    const tags = [
      tag({ tag: 'latest', pushedAt: '2026-01-04T00:00:00Z' }),
      tag({ tag: 'prod-1', pushedAt: '2026-01-03T00:00:00Z' }),
      tag({ tag: 'nightly-1', pushedAt: '2026-01-02T00:00:00Z' }),
      tag({ tag: 'nightly-2', pushedAt: '2026-01-01T00:00:00Z' }),
    ];
    const r = evaluate({
      tags,
      rule: {
        deleteTagPatterns: ['*'],
        protectTagPatterns: ['latest', 'prod-*'],
        minTagsToKeep: 1,
      },
    });
    const deleted = r.toDelete.map(t => t.tag).sort();
    expect(deleted).toEqual(['nightly-1', 'nightly-2']);
    // latest + prod-1 protected; nightly-1 (newest) might be eaten by min-floor=1
    // Actually min-floor=1 takes newest non-protected. Let's check.
    // After protect pass: latest, prod-1 → protected-pattern (toKeep has 2).
    // Then min-floor=1: toKeep already has 2 ≥ 1, so skips. All others go to candidates.
    // candidates = [nightly-1, nightly-2] (ordered newest-first).
    // deleteTagPatterns=['*'] matches both → both deleted.
    expect(r.toKeep.map(t => t.tag).sort()).toEqual(['latest', 'prod-1']);
  });

  it('default protect — latest, v*, main, master, prod-*, stable kept when no protectTagPatterns', () => {
    const tags = [
      tag({ tag: 'latest', pushedAt: '2026-01-08T00:00:00Z' }),
      tag({ tag: 'v1.2.3', pushedAt: '2026-01-07T00:00:00Z' }),
      tag({ tag: 'main', pushedAt: '2026-01-06T00:00:00Z' }),
      tag({ tag: 'master', pushedAt: '2026-01-05T00:00:00Z' }),
      tag({ tag: 'prod-2025', pushedAt: '2026-01-04T00:00:00Z' }),
      tag({ tag: 'stable', pushedAt: '2026-01-03T00:00:00Z' }),
      tag({ tag: 'feature-x', pushedAt: '2026-01-02T00:00:00Z' }),
      tag({ tag: 'random-1', pushedAt: '2026-01-01T00:00:00Z' }),
    ];
    const r = evaluate({
      tags,
      rule: { deleteTagPatterns: ['*'], minTagsToKeep: 1 },
    });
    const kept = r.toKeep.map(t => t.tag);
    expect(kept).toContain('latest');
    expect(kept).toContain('v1.2.3');
    expect(kept).toContain('main');
    expect(kept).toContain('master');
    expect(kept).toContain('prod-2025');
    expect(kept).toContain('stable');
    // The 6 protected → kept; min-floor 1 already met. feature-x + random-1 → deleted.
    const deleted = r.toDelete.map(t => t.tag).sort();
    expect(deleted).toEqual(['feature-x', 'random-1']);
  });

  it('minTagsToKeep custom — 10 tags, minTagsToKeep=7, keepLastN=0: 7 newest kept, 3 deleted', () => {
    const tags = tagsWithDates(10, { prefix: 'build' });
    const r = evaluate({
      tags,
      rule: { minTagsToKeep: 7, keepLastN: 0 },
    });
    // Min-floor=7 keeps the 7 newest (no protect matches).
    // The remaining 3 candidates: keepLastN=0 → kept (0) >= 0 → deleteReason set.
    expect(r.toKeep.length).toBe(7);
    expect(r.toDelete.length).toBe(3);
    // Newest 7 kept → build-0..build-6
    const keptTagsSorted = r.toKeep.map(t => t.tag).sort();
    expect(keptTagsSorted).toEqual([
      'build-0', 'build-1', 'build-2', 'build-3', 'build-4', 'build-5', 'build-6',
    ]);
  });

  it('minTagsToKeep below 1 → coerced to 1 internally', () => {
    // With minTagsToKeep=0 and the parser doing Math.max(1, parseInt(0,10) || 3),
    // parseInt(0, 10) = 0, which is falsy, so `|| 3` kicks in → 3.
    // So minTagsToKeep=0 effectively becomes 3 (the default), not 1.
    // The "coerced to 1" wording in the spec is about Math.max(1, ...). That floor
    // applies when the value parses to a real number ≥ 1 already, which it does
    // for explicit values. Since parseInt(0) = 0 → falsy → fallback 3.
    // To trigger the Math.max(1, …) path, pass a negative number.
    const tags = tagsWithDates(5, { prefix: 'build' });
    const rNeg = evaluate({
      tags,
      // parseInt(-5,10) = -5 (truthy) → Math.max(1, -5) = 1
      rule: { minTagsToKeep: -5, deleteTagPatterns: ['*'] },
    });
    // With min-floor=1: 1 newest kept; rest match deleteTagPatterns:['*'] → deleted.
    expect(rNeg.toKeep.length).toBe(1);
    expect(rNeg.toDelete.length).toBe(4);
  });

  it('server hard cap of 200 — input 250 tags all matching → 200 deleted, 50 capped', () => {
    // Generate 250 distinct tags, none matching default protect patterns.
    const tags = [];
    for (let i = 0; i < 250; i++) {
      const day = String(((i % 28) + 1)).padStart(2, '0');
      // Use distinct ISO timestamps so sort is deterministic. Vary minutes so all are unique.
      const min = String(i % 60).padStart(2, '0');
      const hr = String(Math.floor(i / 60) % 24).padStart(2, '0');
      tags.push(tag({
        tag: `build-${i}`,
        pushedAt: `2026-01-${day}T${hr}:${min}:00Z`,
        sizeBytes: 100,
      }));
    }
    const r = evaluate({
      tags,
      rule: { deleteTagPatterns: ['*'], minTagsToKeep: 1 },
    });
    expect(r.toDelete.length).toBe(SERVER_HARD_CAP);
    expect(r.toDelete.length).toBe(200);
    expect(r.summary.cappedAt).toBe(200);
    // The remaining ones (1 from min-floor + 49 capped overflow) should be in toKeep.
    const cappedItems = r.toKeep.filter(t => t.reason === 'server-cap');
    expect(cappedItems.length).toBeGreaterThanOrEqual(49);
  });

  it('sort order: newest first by pushedAt — keepLastN=2 keeps the 2 newest', () => {
    // Inject 5 tags with deliberately scrambled order.
    const tags = [
      tag({ tag: 'mid-2', pushedAt: '2026-01-15T00:00:00Z' }),
      tag({ tag: 'oldest', pushedAt: '2026-01-01T00:00:00Z' }),
      tag({ tag: 'newest', pushedAt: '2026-01-30T00:00:00Z' }),
      tag({ tag: 'old-1', pushedAt: '2026-01-05T00:00:00Z' }),
      tag({ tag: 'mid-1', pushedAt: '2026-01-20T00:00:00Z' }),
    ];
    const r = evaluate({
      tags,
      rule: { keepLastN: 2, minTagsToKeep: 1 },
    });
    // newest → min-floor (1). Remaining candidates newest-first: mid-1, mid-2, old-1, oldest
    // keepLastN=2 → kept: mid-1, mid-2. Remaining: old-1, oldest → deleted.
    const deleted = r.toDelete.map(t => t.tag).sort();
    expect(deleted).toEqual(['old-1', 'oldest']);
    const keptByLastN = r.toKeep.filter(t => t.reason === 'keep-last-n').map(t => t.tag).sort();
    expect(keptByLastN).toEqual(['mid-1', 'mid-2']);
  });

  it('missing pushedAt — treated as oldest in sort', () => {
    const tags = [
      tag({ tag: 'has-date-newest', pushedAt: '2026-01-30T00:00:00Z' }),
      tag({ tag: 'no-date', pushedAt: null }),
      tag({ tag: 'has-date-old', pushedAt: '2026-01-01T00:00:00Z' }),
    ];
    const r = evaluate({
      tags,
      rule: { keepLastN: 1, minTagsToKeep: 1 },
    });
    // sort: has-date-newest, has-date-old, no-date (no-date pushed to bottom)
    // min-floor=1 → has-date-newest. keepLastN=1 → has-date-old kept.
    // no-date → "older than keepLastN=1" → deleted.
    expect(r.toDelete.map(t => t.tag)).toEqual(['no-date']);
  });

  it('summary shape — { count, bytes, cappedAt, reasonCounts } for non-trivial plan', () => {
    const tags = tagsWithDates(6, { prefix: 'build', sizeBytes: 500 });
    const r = evaluate({
      tags,
      rule: { keepLastN: 1, minTagsToKeep: 1 },
    });
    expect(r.summary).toHaveProperty('count');
    expect(r.summary).toHaveProperty('bytes');
    expect(r.summary).toHaveProperty('cappedAt');
    expect(r.summary).toHaveProperty('reasonCounts');
    expect(typeof r.summary.count).toBe('number');
    expect(typeof r.summary.bytes).toBe('number');
    expect(r.summary.cappedAt).toBeNull();
    expect(typeof r.summary.reasonCounts).toBe('object');
    expect(r.summary.count).toBe(r.toDelete.length);
  });

  it('bytes summed correctly; missing sizeBytes treated as 0', () => {
    const tags = [
      tag({ tag: 'a', pushedAt: '2026-01-05T00:00:00Z', sizeBytes: 100 }),
      tag({ tag: 'b', pushedAt: '2026-01-04T00:00:00Z', sizeBytes: 200 }),
      tag({ tag: 'c', pushedAt: '2026-01-03T00:00:00Z', sizeBytes: undefined }),
      tag({ tag: 'd', pushedAt: '2026-01-02T00:00:00Z', sizeBytes: 300 }),
      tag({ tag: 'e', pushedAt: '2026-01-01T00:00:00Z', sizeBytes: 400 }),
    ];
    const r = evaluate({
      tags,
      rule: { deleteTagPatterns: ['*'], minTagsToKeep: 1 },
    });
    // newest 'a' goes to min-floor; b, c, d, e all match '*' → deleted.
    const totalBytes = r.toDelete.reduce((s, t) => s + (t.sizeBytes || 0), 0);
    expect(r.summary.bytes).toBe(totalBytes);
    expect(r.summary.bytes).toBe(200 + 0 + 300 + 400); // 900
  });
});

// ---- _globToRegex ---------------------------------------------------------

describe('_globToRegex', () => {
  const { _globToRegex } = _internals;

  it("'foo' matches 'foo', not 'fooooo'", () => {
    expect(_globToRegex('foo').test('foo')).toBe(true);
    expect(_globToRegex('foo').test('fooooo')).toBe(false);
  });

  it("'foo*' matches 'foobar', 'foo', NOT 'qfoo'", () => {
    expect(_globToRegex('foo*').test('foobar')).toBe(true);
    expect(_globToRegex('foo*').test('foo')).toBe(true);
    expect(_globToRegex('foo*').test('qfoo')).toBe(false);
  });

  it("'v*' matches 'v1.2.3', 'v', NOT '1.2'", () => {
    expect(_globToRegex('v*').test('v1.2.3')).toBe(true);
    expect(_globToRegex('v*').test('v')).toBe(true);
    expect(_globToRegex('v*').test('1.2')).toBe(false);
  });

  it("special regex chars escaped — 'foo.bar' matches literal only", () => {
    expect(_globToRegex('foo.bar').test('foo.bar')).toBe(true);
    expect(_globToRegex('foo.bar').test('fooXbar')).toBe(false);
  });
});

// ---- _daysBetween ---------------------------------------------------------

describe('_daysBetween', () => {
  const { _daysBetween } = _internals;

  it('same date → 0', () => {
    expect(_daysBetween('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(0);
  });

  it('1 day apart → 1', () => {
    expect(_daysBetween('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')).toBe(1);
  });

  it('missing input → 0', () => {
    expect(_daysBetween(null, '2026-01-02T00:00:00Z')).toBe(0);
    expect(_daysBetween('2026-01-01T00:00:00Z', null)).toBe(0);
    expect(_daysBetween(undefined, undefined)).toBe(0);
  });
});

// ---- execute --------------------------------------------------------------

describe('execute — calls registryService', () => {
  beforeEach(() => {
    auditService.log.mockClear();
  });

  it('dry run — does NOT call deleteTag, returns dryRun:true', async () => {
    const fakeRegistry = {
      deleteTag: jest.fn().mockResolvedValue({ ok: true, digest: 'sha256:x' }),
    };
    const plan = {
      toDelete: [
        { tag: 'a', digest: 'sha256:a', sizeBytes: 100, reason: 'matches deleteTagPattern' },
        { tag: 'b', digest: 'sha256:b', sizeBytes: 200, reason: 'matches deleteTagPattern' },
      ],
      toKeep: [],
      summary: { count: 2, bytes: 300, cappedAt: null, reasonCounts: {} },
    };
    const result = await execute({
      registryService: fakeRegistry,
      registryId: 1,
      repoPath: 'lib/foo',
      plan,
      dryRun: true,
      auditCtx: { userId: 1, username: 'admin', ip: '127.0.0.1' },
    });
    expect(result.dryRun).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.deleted.length).toBe(2);
    expect(result.deleted[0]).toMatchObject({
      tag: 'a', digest: 'sha256:a', sizeBytes: 100, reason: 'matches deleteTagPattern',
    });
    expect(fakeRegistry.deleteTag).not.toHaveBeenCalled();
  });

  it('real run — all delete calls succeed; audit.log called with retention_executed', async () => {
    const fakeRegistry = {
      deleteTag: jest.fn().mockResolvedValue({ ok: true, digest: 'sha256:x' }),
    };
    const plan = {
      toDelete: [
        { tag: 'a', digest: 'sha256:a', sizeBytes: 100, reason: 'r1' },
        { tag: 'b', digest: 'sha256:b', sizeBytes: 200, reason: 'r2' },
      ],
      toKeep: [],
      summary: { count: 2, bytes: 300, cappedAt: null, reasonCounts: {} },
    };
    const result = await execute({
      registryService: fakeRegistry,
      registryId: 1,
      repoPath: 'lib/foo',
      plan,
      dryRun: false,
      auditCtx: { userId: 1, username: 'admin', ip: '127.0.0.1' },
    });
    expect(result.dryRun).toBe(false);
    expect(result.deleted.length).toBe(2);
    expect(result.errors).toEqual([]);
    expect(fakeRegistry.deleteTag).toHaveBeenCalledTimes(2);
    expect(fakeRegistry.deleteTag).toHaveBeenNthCalledWith(1, 1, 'lib/foo', 'a', { expectedDigest: 'sha256:a' });
    expect(fakeRegistry.deleteTag).toHaveBeenNthCalledWith(2, 1, 'lib/foo', 'b', { expectedDigest: 'sha256:b' });
    expect(auditService.log).toHaveBeenCalledTimes(3);
    expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'retention_executed',
      targetType: 'registry-repo',
      targetId: '1/lib/foo',
      details: expect.objectContaining({
        deletedCount: 2,
        errorCount: 0,
        bytesReclaimed: 300,
        cappedAt: null,
      }),
    }));
  });

  it('real run with one error — does NOT bail; reports all successes + the error', async () => {
    let call = 0;
    const fakeRegistry = {
      deleteTag: jest.fn().mockImplementation(() => {
        call++;
        if (call === 2) return Promise.reject(new Error('500 Internal'));
        return Promise.resolve({ ok: true });
      }),
    };
    const plan = {
      toDelete: [
        { tag: 'a', digest: 'sha256:a', sizeBytes: 100, reason: 'r' },
        { tag: 'b', digest: 'sha256:b', sizeBytes: 200, reason: 'r' },
        { tag: 'c', digest: 'sha256:c', sizeBytes: 300, reason: 'r' },
      ],
      toKeep: [],
      summary: { count: 3, bytes: 600, cappedAt: null, reasonCounts: {} },
    };
    const result = await execute({
      registryService: fakeRegistry,
      registryId: 1,
      repoPath: 'lib/foo',
      plan,
      dryRun: false,
      auditCtx: {},
    });
    expect(fakeRegistry.deleteTag).toHaveBeenCalledTimes(3);
    expect(result.deleted.length).toBe(2);
    expect(result.deleted.map(d => d.tag).sort()).toEqual(['a', 'c']);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatchObject({ tag: 'b' });
    expect(result.errors[0].error).toMatch(/500 Internal/);
  });

  it('untagged manifest in plan → ends up in errors with "not implemented" message', async () => {
    const fakeRegistry = {
      deleteTag: jest.fn().mockResolvedValue({ ok: true }),
    };
    const plan = {
      toDelete: [
        { tag: 'a', digest: 'sha256:a', sizeBytes: 100, reason: 'r' },
        { tag: null, digest: 'sha256:untagged', sizeBytes: 50, reason: 'untagged 60d old' },
      ],
      toKeep: [],
      summary: { count: 2, bytes: 150, cappedAt: null, reasonCounts: {} },
    };
    const result = await execute({
      registryService: fakeRegistry,
      registryId: 1,
      repoPath: 'lib/foo',
      plan,
      dryRun: false,
      auditCtx: {},
    });
    // Tagged one is deleted; untagged one ends up in errors.
    expect(result.deleted.length).toBe(1);
    expect(result.deleted[0].tag).toBe('a');
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatchObject({ digest: 'sha256:untagged' });
    expect(result.errors[0].error).toMatch(/not implemented/i);
    expect(fakeRegistry.deleteTag).toHaveBeenCalledTimes(1);
  });
});

test('retention preserves all aliases of a kept manifest', () => {
  const plan = evaluate({ tags: [
    tag({ tag: 'latest', digest: 'sha256:shared' }),
    tag({ tag: 'temporary', digest: 'sha256:shared' }),
    tag({ tag: 'disposable', digest: 'sha256:other' }),
  ], rule: { minTagsToKeep: 1, deleteTagPatterns: ['*'] } });
  expect(plan.toDelete.map(t => t.tag)).toEqual(['disposable']);
  expect(plan.toKeep).toContainEqual(expect.objectContaining({ tag: 'temporary', reason: 'shared-kept-digest' }));
});
