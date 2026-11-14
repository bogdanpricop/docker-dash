'use strict';

// Tests for src/services/eventNotifier.js
// Mocks notificationChannels and workflows to avoid real I/O.
//
// NOTE: The module-level `cooldowns` Map inside eventNotifier is not exported,
// so it persists across tests. Each test uses a unique actorName to avoid
// hitting the 60-second cooldown from a previous test.

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.DB_PATH = ':memory:';

jest.resetModules();

jest.mock('../services/notificationChannels', () => ({
  sendToAll: jest.fn().mockResolvedValue(undefined),
  send: jest.fn().mockResolvedValue(undefined),
  hasGeneralChannels: jest.fn(),
}));

jest.mock('../services/workflows', () => ({
  evaluate: jest.fn().mockResolvedValue(undefined),
}));

describe('EventNotifier', () => {
  let notifier, channelMock, workflowMock;

  beforeAll(() => {
    notifier = require('../services/eventNotifier');
    channelMock = require('../services/notificationChannels');
    workflowMock = require('../services/workflows');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    channelMock.hasGeneralChannels.mockReturnValue(false);
  });

  // ─── helper to activate a channel so _isEnabled() returns true ────────────
  function enableChannel() {
    channelMock.hasGeneralChannels.mockReturnValue(true);
  }

  // ─── _isEnabled ───────────────────────────────────────────────────────────
  describe('_isEnabled', () => {
    it('returns false when no active channels exist', () => {
      expect(notifier._isEnabled()).toBe(false);
    });

    it('returns true when at least one active channel exists', () => {
      enableChannel();
      expect(notifier._isEnabled()).toBe(true);
    });
  });

  // ─── processEvent — ignored events ────────────────────────────────────────
  describe('processEvent — non-notifiable events', () => {
    it('does not send notification for unrecognized event type', async () => {
      enableChannel();
      await notifier.processEvent({ type: 'network', action: 'create', actorId: 'net1', actorName: 'net-ignored' });
      expect(channelMock.sendToAll).not.toHaveBeenCalled();
    });

    it('does not send notification when no active channels', async () => {
      // no channels seeded
      await notifier.processEvent({ type: 'container', action: 'die', actorId: 'abc123', actorName: 'no-channels-app', attributes: {} });
      expect(channelMock.sendToAll).not.toHaveBeenCalled();
    });
  });

  // ─── processEvent — notifiable events ─────────────────────────────────────
  describe('processEvent — notifiable events', () => {
    it('sends notification for container:die with severity critical', async () => {
      enableChannel();
      await notifier.processEvent({
        type: 'container', action: 'die',
        actorId: 'die-app-001', actorName: 'die-app-001',
        attributes: { exitCode: '1' },
      });
      expect(channelMock.sendToAll).toHaveBeenCalledTimes(1);
      const msg = channelMock.sendToAll.mock.calls[0][0];
      expect(msg.severity).toBe('critical');
      expect(msg.event).toBe('container:die');
      expect(msg.text).toContain('die-app-001');
    });

    it('sends notification for container:start with severity info', async () => {
      enableChannel();
      await notifier.processEvent({
        type: 'container', action: 'start',
        actorId: 'start-worker-001', actorName: 'start-worker-001',
        attributes: {},
      });
      expect(channelMock.sendToAll).toHaveBeenCalledTimes(1);
      const msg = channelMock.sendToAll.mock.calls[0][0];
      expect(msg.severity).toBe('info');
    });

    it('sends notification for container:oom with severity critical', async () => {
      enableChannel();
      await notifier.processEvent({
        type: 'container', action: 'oom',
        actorId: 'oom-heavy-001', actorName: 'oom-heavy-001',
        attributes: {},
      });
      expect(channelMock.sendToAll).toHaveBeenCalledTimes(1);
      const msg = channelMock.sendToAll.mock.calls[0][0];
      expect(msg.severity).toBe('critical');
    });

    it('downgrades die to info and marks clean exit for exit code 0', async () => {
      enableChannel();
      await notifier.processEvent({
        type: 'container', action: 'die',
        actorId: 'clean-exit-001', actorName: 'clean-exit-001',
        attributes: { exitCode: '0' },
      });
      expect(channelMock.sendToAll).toHaveBeenCalledTimes(1);
      const msg = channelMock.sendToAll.mock.calls[0][0];
      expect(msg.severity).toBe('info');
      expect(msg.title.toLowerCase()).toContain('clean');
    });

    it('adds OOM/kill annotation text for exit code 137', async () => {
      enableChannel();
      await notifier.processEvent({
        type: 'container', action: 'die',
        actorId: 'oom137-app-001', actorName: 'oom137-app-001',
        attributes: { exitCode: '137' },
      });
      expect(channelMock.sendToAll).toHaveBeenCalledTimes(1);
      const msg = channelMock.sendToAll.mock.calls[0][0];
      expect(msg.text).toContain('137');
    });

    it('includes host info in message text when hostName is not "Local"', async () => {
      enableChannel();
      await notifier.processEvent({
        type: 'container', action: 'start',
        actorId: 'remote-svc-001', actorName: 'remote-svc-001',
        hostName: 'prod-server',
        attributes: {},
      });
      expect(channelMock.sendToAll).toHaveBeenCalledTimes(1);
      const msg = channelMock.sendToAll.mock.calls[0][0];
      expect(msg.text).toContain('prod-server');
    });

    it('omits host info when hostName is "Local"', async () => {
      enableChannel();
      await notifier.processEvent({
        type: 'container', action: 'start',
        actorId: 'local-svc-001', actorName: 'local-svc-001',
        hostName: 'Local',
        attributes: {},
      });
      expect(channelMock.sendToAll).toHaveBeenCalledTimes(1);
      const msg = channelMock.sendToAll.mock.calls[0][0];
      expect(msg.text).not.toContain('Local');
    });

    it('uses truncated actorId (12 chars) when actorName is absent', async () => {
      enableChannel();
      await notifier.processEvent({
        type: 'container', action: 'stop',
        actorId: 'abcdef123456789xyz',
        attributes: {},
      });
      expect(channelMock.sendToAll).toHaveBeenCalledTimes(1);
      const msg = channelMock.sendToAll.mock.calls[0][0];
      expect(msg.text).toContain('abcdef123456');
    });
  });

  // ─── cooldown suppression ─────────────────────────────────────────────────
  describe('cooldown suppression', () => {
    it('fires once then suppresses repeated identical events within 60 s', async () => {
      enableChannel();
      // Use a unique actorName so no other test has already used this cooldown key
      const evt = {
        type: 'container', action: 'kill',
        actorId: 'cooldown-unique-99', actorName: 'cooldown-unique-99',
        attributes: {},
      };
      await notifier.processEvent(evt);
      await notifier.processEvent(evt); // same cooldown key → suppressed
      expect(channelMock.sendToAll).toHaveBeenCalledTimes(1);
    });
  });

  // ─── evaluateWorkflows ────────────────────────────────────────────────────
  describe('evaluateWorkflows', () => {
    it('calls workflowService.evaluate with mapped container stats for die', async () => {
      await notifier.evaluateWorkflows({
        type: 'container', action: 'die',
        actorId: 'wf-container', actorName: 'wf-app',
        attributes: { exitCode: '1' },
        hostId: 5,
      });
      expect(workflowMock.evaluate).toHaveBeenCalledTimes(1);
      const [statsArg] = workflowMock.evaluate.mock.calls[0];
      expect(Array.isArray(statsArg)).toBe(true);
      expect(statsArg[0].container_name).toBe('wf-app');
      expect(statsArg[0].state).toBe('exited');
      expect(statsArg[0].host_id).toBe(5);
    });

    it('maps start action to "running" state', async () => {
      await notifier.evaluateWorkflows({
        type: 'container', action: 'start', actorName: 'wf-svc', attributes: {},
      });
      const [statsArg] = workflowMock.evaluate.mock.calls[0];
      expect(statsArg[0].state).toBe('running');
    });

    it('does not throw when workflowService rejects', async () => {
      workflowMock.evaluate.mockRejectedValueOnce(new Error('workflow error'));
      await expect(
        notifier.evaluateWorkflows({ type: 'container', action: 'die', actorName: 'wf-err', attributes: {} })
      ).resolves.toBeUndefined();
    });
  });
});
