'use strict';

// Copilot conversation history (v8.9.45) — persistence + the privacy invariant
// that ONLY the question/answer text is stored, never the assembled context
// bundle (host inventory, findings, audit excerpts) that gets sent to the model.

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

jest.mock('../services/copilot/llm', () => ({ chat: jest.fn() }));

const llm = require('../services/copilot/llm');
const copilot = require('../services/copilot');
const { getDb } = require('../db');

describe('copilot history', () => {
  let db;

  beforeAll(() => {
    db = getDb();
    copilot.setConfig({ enabled: true, base_url: 'http://localhost:11434/v1', model: 'test-model', user: { username: 'tester' } });
  });

  beforeEach(() => {
    db.prepare('DELETE FROM copilot_history').run();
    llm.chat.mockReset();
  });

  test('ask() persists the question and the answer as two chronological turns', async () => {
    llm.chat.mockResolvedValue('Patch the exposed port first.');
    const r = await copilot.ask('What should I fix first?', { userId: 7 });
    expect(r.answer).toBe('Patch the exposed port first.');

    const hist = copilot.history({ limit: 10 });
    expect(hist).toHaveLength(2);
    expect(hist[0]).toMatchObject({ role: 'user', content: 'What should I fix first?', user_id: 7 });
    expect(hist[1]).toMatchObject({ role: 'assistant', content: 'Patch the exposed port first.', user_id: 7 });
    expect(hist[0].id).toBeLessThan(hist[1].id);
  });

  test('a history write failure is swallowed — ask() still returns the answer', async () => {
    llm.chat.mockResolvedValue('ok answer');
    const realPrepare = db.prepare.bind(db);
    const spy = jest.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('INSERT INTO copilot_history')) throw new Error('disk full (simulated)');
      return realPrepare(sql);
    });
    try {
      const r = await copilot.ask('another question');
      expect(r.answer).toBe('ok answer');
    } finally {
      spy.mockRestore();
    }
    // Nothing was persisted because the write failed — confirms best-effort,
    // not a crash that also silently drops the failure.
    expect(copilot.history({ limit: 10 })).toHaveLength(0);
  });

  test('history() returns turns in chronological order and respects limit', async () => {
    llm.chat.mockResolvedValue('a1'); await copilot.ask('q1');
    llm.chat.mockResolvedValue('a2'); await copilot.ask('q2');
    llm.chat.mockResolvedValue('a3'); await copilot.ask('q3');

    const all = copilot.history({ limit: 100 });
    expect(all.map(h => h.content)).toEqual(['q1', 'a1', 'q2', 'a2', 'q3', 'a3']);

    // limit=2 → most recent turn, still chronological within the window.
    const limited = copilot.history({ limit: 2 });
    expect(limited.map(h => h.content)).toEqual(['q3', 'a3']);
  });

  test('history() can filter by userId', async () => {
    llm.chat.mockResolvedValue('for user 1'); await copilot.ask('q-from-user1', { userId: 1 });
    llm.chat.mockResolvedValue('for user 2'); await copilot.ask('q-from-user2', { userId: 2 });

    const u1 = copilot.history({ limit: 10, userId: 1 });
    expect(u1.map(h => h.content)).toEqual(['q-from-user1', 'for user 1']);
    const u2 = copilot.history({ limit: 10, userId: 2 });
    expect(u2.map(h => h.content)).toEqual(['q-from-user2', 'for user 2']);
  });

  test('clearHistory() empties the table', async () => {
    llm.chat.mockResolvedValue('answer');
    await copilot.ask('question');
    expect(copilot.history({ limit: 10 })).toHaveLength(2);
    const r = copilot.clearHistory({});
    expect(r).toEqual({ ok: true });
    expect(copilot.history({ limit: 10 })).toHaveLength(0);
  });

  test('clearHistory({ userId }) only clears that user\'s turns', async () => {
    llm.chat.mockResolvedValue('a1'); await copilot.ask('q1', { userId: 1 });
    llm.chat.mockResolvedValue('a2'); await copilot.ask('q2', { userId: 2 });
    copilot.clearHistory({ userId: 1 });
    expect(copilot.history({ userId: 1 })).toHaveLength(0);
    expect(copilot.history({ userId: 2 })).toHaveLength(2);
  });

  describe('REGRESSION: no secret/context leakage into stored content', () => {
    test('stored rows are exactly the question and answer text — never the context bundle', async () => {
      db.prepare(`INSERT INTO docker_hosts (name, connection_type, socket_path, is_active) VALUES ('topsecret-host-name', 'socket', '/var/run/docker.sock', 1)`).run();
      db.prepare(`INSERT INTO audit_log (action, target_type, username, created_at) VALUES ('secret_action_marker', 'x', 'root', datetime('now'))`).run();

      let capturedContextBundle = null;
      llm.chat.mockImplementation(async ({ messages }) => {
        // messages[1] is the user turn carrying "Estate context ... JSON: {...}\n\nQuestion: ..."
        capturedContextBundle = messages[1].content;
        return 'Everything looks fine, no action needed.';
      });

      const question = 'Summarize the estate for me.';
      await copilot.ask(question);

      // Sanity check: the bundle actually SENT to the model did carry the host
      // name and audit action — otherwise this regression test would be vacuous.
      expect(capturedContextBundle).toContain('topsecret-host-name');
      expect(capturedContextBundle).toContain('secret_action_marker');

      const hist = copilot.history({ limit: 10 });
      expect(hist).toHaveLength(2);
      expect(hist[0].content).toBe(question);
      expect(hist[1].content).toBe('Everything looks fine, no action needed.');

      for (const row of hist) {
        expect(row.content).not.toContain('topsecret-host-name');
        expect(row.content).not.toContain('secret_action_marker');
        expect(row.content).not.toMatch(/"findings"|"hosts"|"score"|"recentAudit"/);
      }
    });
  });
});
