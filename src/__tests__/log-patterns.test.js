'use strict';

// Unit tests for the log pattern matching engine.
// Pure functions — no DB, no Docker, no mocks needed.

const { analyzeLog, generateAIPrompt, PATTERNS } = require('../services/log-patterns');

describe('Log Pattern Analyzer — analyzeLog()', () => {
  // ── OOM pattern ────────────────────────────────────────────
  it('should match OOM kill pattern', () => {
    const result = analyzeLog('Killed process 1234 oom-kill (node)');
    expect(result.patterns.length).toBeGreaterThanOrEqual(1);
    const oom = result.patterns.find(p => p.category === 'memory');
    expect(oom).toBeTruthy();
    expect(oom.title).toContain('OOM');
    expect(oom.severity).toBe('critical');
    expect(oom.fixes.length).toBeGreaterThan(0);
  });

  it('should match "out of memory" text', () => {
    const result = analyzeLog('Fatal error: out of memory');
    const oom = result.patterns.find(p => p.title.includes('OOM'));
    expect(oom).toBeTruthy();
    expect(oom.severity).toBe('critical');
  });

  it('should match "Killed process" as Process Killed signal', () => {
    // "Killed process 1234 (node)" without OOM keywords matches the runtime kill pattern
    const result = analyzeLog('Killed process 1234 (node)');
    const killed = result.patterns.find(p => p.title.includes('Killed'));
    expect(killed).toBeTruthy();
    expect(killed.category).toBe('runtime');
  });

  // ── Connection refused ─────────────────────────────────────
  it('should match ECONNREFUSED pattern', () => {
    const result = analyzeLog('ECONNREFUSED 127.0.0.1:5432');
    const match = result.patterns.find(p => p.title === 'Connection Refused');
    expect(match).toBeTruthy();
    expect(match.category).toBe('network');
    expect(match.severity).toBe('warning');
  });

  // ── Permission denied ──────────────────────────────────────
  it('should match EACCES permission denied', () => {
    const result = analyzeLog('EACCES: permission denied');
    const match = result.patterns.find(p => p.title === 'Permission Denied');
    expect(match).toBeTruthy();
    expect(match.category).toBe('filesystem');
  });

  // ── Disk full ──────────────────────────────────────────────
  it('should match "No space left on device"', () => {
    const result = analyzeLog('No space left on device');
    const match = result.patterns.find(p => p.title === 'Disk Full');
    expect(match).toBeTruthy();
    expect(match.severity).toBe('critical');
    expect(match.category).toBe('filesystem');
  });

  // ── DNS failure ────────────────────────────────────────────
  it('should match DNS resolution failure', () => {
    const result = analyzeLog('getaddrinfo ENOTFOUND some-host');
    const match = result.patterns.find(p => p.title === 'DNS Resolution Failed');
    expect(match).toBeTruthy();
    expect(match.category).toBe('network');
  });

  // ── Normal log line (no match) ─────────────────────────────
  it('should return no patterns for normal log line', () => {
    const result = analyzeLog('Server started on port 3000');
    expect(result.patterns).toEqual([]);
    expect(result.severity).toBe('ok');
    expect(result.diagnosis).toContain('No known error patterns');
  });

  // ── Case insensitivity ─────────────────────────────────────
  it('should match patterns case-insensitively', () => {
    const result1 = analyzeLog('CONNECTION REFUSED on port 8080');
    expect(result1.patterns.find(p => p.title === 'Connection Refused')).toBeTruthy();

    const result2 = analyzeLog('econnrefused localhost:3000');
    expect(result2.patterns.find(p => p.title === 'Connection Refused')).toBeTruthy();
  });

  // ── Empty / null / undefined inputs ────────────────────────
  it('should handle empty string gracefully', () => {
    const result = analyzeLog('');
    expect(result.patterns).toEqual([]);
    expect(result.severity).toBe('ok');
    expect(result.diagnosis).toBe('No log content to analyze.');
  });

  it('should handle null input gracefully', () => {
    const result = analyzeLog(null);
    expect(result.patterns).toEqual([]);
    expect(result.severity).toBe('ok');
  });

  it('should handle undefined input gracefully', () => {
    const result = analyzeLog(undefined);
    expect(result.patterns).toEqual([]);
    expect(result.severity).toBe('ok');
  });

  // ── Multiple patterns in one log ───────────────────────────
  it('should detect multiple patterns in multi-line log', () => {
    const log = [
      'Starting application...',
      'ECONNREFUSED 127.0.0.1:5432',
      'No space left on device',
      'Killed process 999 (app) total-vm:1024kB',
    ].join('\n');

    const result = analyzeLog(log);
    expect(result.patterns.length).toBeGreaterThanOrEqual(3);
    expect(result.severity).toBe('critical');
    expect(result.diagnosis).toContain('issue(s)');
  });

  // ── Severity ordering ──────────────────────────────────────
  it('should set overall severity to critical when any critical pattern matches', () => {
    const result = analyzeLog('out of memory: cannot allocate memory');
    expect(result.severity).toBe('critical');
  });

  it('should set severity to warning when only warning patterns match', () => {
    const result = analyzeLog('ECONNREFUSED 10.0.0.1:80');
    expect(result.severity).toBe('warning');
  });

  // ── Pattern output shape ───────────────────────────────────
  it('should return correct shape for matched patterns', () => {
    const result = analyzeLog('EACCES: permission denied, open /data/file.txt');
    const match = result.patterns[0];
    expect(match).toHaveProperty('category');
    expect(match).toHaveProperty('severity');
    expect(match).toHaveProperty('title');
    expect(match).toHaveProperty('explanation');
    expect(match).toHaveProperty('fixes');
    expect(match).toHaveProperty('matchedLine');
    expect(match).toHaveProperty('lineNumber');
    expect(Array.isArray(match.fixes)).toBe(true);
    expect(typeof match.lineNumber).toBe('number');
  });

  // ── Line number tracking ───────────────────────────────────
  it('should track correct line numbers', () => {
    const log = 'line 1 ok\nline 2 ok\nECONNREFUSED on line 3';
    const result = analyzeLog(log);
    expect(result.patterns[0].lineNumber).toBe(3);
  });

  // ── Deduplication ──────────────────────────────────────────
  it('should not duplicate same pattern found on multiple lines', () => {
    const log = 'ECONNREFUSED localhost:5432\nECONNREFUSED localhost:6379';
    const result = analyzeLog(log);
    const connRefused = result.patterns.filter(p => p.title === 'Connection Refused');
    expect(connRefused.length).toBe(1);
  });
});

describe('Log Pattern Analyzer — generateAIPrompt()', () => {
  it('should return a string containing container context', () => {
    const containerInfo = { name: 'my-app', image: 'node:18', stateStatus: 'running' };
    const prompt = generateAIPrompt(containerInfo, null, null, null);
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('my-app');
    expect(prompt).toContain('node:18');
    expect(prompt).toContain('running');
  });

  it('should include diagnosis steps when provided', () => {
    const containerInfo = { name: 'test', image: 'test:1' };
    const diagnoseResult = {
      steps: [{ title: 'Memory Check', status: 'warning', detail: 'High usage', suggestion: 'Increase limit' }],
    };
    const prompt = generateAIPrompt(containerInfo, diagnoseResult, null, null);
    expect(prompt).toContain('Memory Check');
    expect(prompt).toContain('Increase limit');
  });

  it('should include detected log patterns when provided', () => {
    const containerInfo = { name: 'test', image: 'test:1' };
    const logAnalysis = {
      patterns: [{ severity: 'critical', title: 'OOM Kill', category: 'memory', explanation: 'Process killed', matchedLine: 'Killed process 123' }],
    };
    const prompt = generateAIPrompt(containerInfo, null, logAnalysis, null);
    expect(prompt).toContain('OOM Kill');
    expect(prompt).toContain('Detected Log Patterns');
  });

  it('should include recent logs when provided', () => {
    const containerInfo = { name: 'test', image: 'test:1' };
    const prompt = generateAIPrompt(containerInfo, null, null, 'Some log output here');
    expect(prompt).toContain('Some log output here');
    expect(prompt).toContain('Recent Logs');
  });

  it('should always include the question section', () => {
    const containerInfo = { name: 'test', image: 'test:1' };
    const prompt = generateAIPrompt(containerInfo, null, null, null);
    expect(prompt).toContain('root cause');
    expect(prompt).toContain('actionable fix steps');
  });
});

describe('Log Pattern Analyzer — PATTERNS export', () => {
  it('should export a non-empty PATTERNS array', () => {
    expect(Array.isArray(PATTERNS)).toBe(true);
    expect(PATTERNS.length).toBeGreaterThan(10);
  });

  it('should have valid structure for each pattern', () => {
    for (const p of PATTERNS) {
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(typeof p.category).toBe('string');
      expect(typeof p.severity).toBe('string');
      expect(typeof p.title).toBe('string');
      expect(typeof p.explanation).toBe('string');
      expect(Array.isArray(p.fixes)).toBe(true);
      expect(p.fixes.length).toBeGreaterThan(0);
    }
  });
});
