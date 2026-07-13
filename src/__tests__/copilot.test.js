'use strict';

const brief = require('../services/copilot/brief');
const { _internals: llmInternals } = require('../services/copilot/llm');
const copilot = require('../services/copilot');

describe('copilot rule-based briefing', () => {
  test('recommend ranks criticals first and carries the remediation link', () => {
    const ctx = {
      findings: [
        { severity: 'medium', title: 'M', detail: 'm', remediation: { label: 'Fix M', link: '#/firewall' } },
        { severity: 'critical', title: 'C', detail: 'c', remediation: { label: 'Fix C', link: '#/posture' } },
      ],
      blueprints: [{ name: 'bp', create: 2, remove: 1 }],
    };
    const recs = brief.recommend(ctx);
    expect(recs[0].severity).toBe('critical');
    expect(recs[0].link).toBe('#/posture');
    // blueprint drift becomes a recommendation
    expect(recs.some(r => /drifted/.test(r.title))).toBe(true);
  });
  test('summaryLine reflects counts', () => {
    expect(brief.summaryLine({ grade: 'C', score: 60, counts: { critical: 1, high: 0, medium: 2 }, hosts: [{}, {}] }))
      .toMatch(/grade C \(60\/100\).*1 critical.*2 medium.*2 host/);
  });
});

describe('copilot LLM request options', () => {
  test('adds a Bearer header only when an api key is set', () => {
    expect(llmInternals._reqOptions({ apiKey: 'sk-x' }, 10, 5000).headers.Authorization).toBe('Bearer sk-x');
    expect(llmInternals._reqOptions({}, 10, 5000).headers.Authorization).toBeUndefined();
    expect(llmInternals._reqOptions({}, 10, 5000).headers['Content-Length']).toBe(10);
  });
});

describe('copilot context sent to the model is trimmed + secret-free', () => {
  test('_contextForModel includes score/findings but no detail/evidence/keys', () => {
    const ctx = {
      score: 84, grade: 'B', counts: { critical: 0 },
      findings: [{ severity: 'high', title: 'X', host: 'h1', detail: 'SENSITIVE detail', evidence: 'SECRET evidence', remediation: { link: '#/x' } }],
      hosts: [{ name: 'h1', type: 'docker', transport: 'ssh' }],
      recentAudit: [],
    };
    const s = copilot._internals._contextForModel(ctx);
    const parsed = JSON.parse(s);
    expect(parsed.score).toBe(84);
    expect(parsed.findings[0]).toEqual({ severity: 'high', title: 'X', host: 'h1' });
    expect(s).not.toContain('SENSITIVE');
    expect(s).not.toContain('SECRET');
    expect(s).not.toMatch(/api_key/i);
  });
});
