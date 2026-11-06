'use strict';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

jest.mock('../services/git', () => ({
  getStackByWebhookToken: jest.fn(),
  triggerDeploy: jest.fn(),
  _broadcast: jest.fn(),
}));
jest.mock('../services/preview-environments', () => ({
  queuePullRequest: jest.fn(),
  closePullRequest: jest.fn(),
}));

const git = require('../services/git');
const previews = require('../services/preview-environments');

const app = express();
app.use('/api/git/webhook', require('../routes/gitWebhook'));

const body = {
  action: 'opened', number: 7,
  repository: { full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git' },
  pull_request: {
    head: { ref: 'feature/test', sha: 'a'.repeat(40), repo: { clone_url: 'https://github.com/acme/app.git' } },
  },
};

function signature(secret, payload) {
  return `sha256=${crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  previews.queuePullRequest.mockReturnValue({
    environment: { id: 12, pr_number: 7 }, completion: Promise.resolve(),
  });
});

describe('GitHub preview webhook security', () => {
  it('requires a webhook secret for PR previews even when push deploy is disabled', async () => {
    git.getStackByWebhookToken.mockReturnValue({
      id: 1, webhook_provider: 'github', webhook_secret: null, deploy_on_push: 0,
    });
    await request(app).post('/api/git/webhook/token')
      .set('X-GitHub-Event', 'pull_request').send(body).expect(401);
    expect(previews.queuePullRequest).not.toHaveBeenCalled();
  });

  it('rejects invalid HMAC and queues a valid signed pull request', async () => {
    git.getStackByWebhookToken.mockReturnValue({
      id: 1, webhook_provider: 'github', webhook_secret: 'hook-secret', deploy_on_push: 0,
    });
    await request(app).post('/api/git/webhook/token')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-Hub-Signature-256', 'sha256=invalid')
      .send(body).expect(401);

    const response = await request(app).post('/api/git/webhook/token')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-Hub-Signature-256', signature('hook-secret', body))
      .send(body).expect(202);
    expect(response.body).toMatchObject({ status: 'preview_deploying', previewId: 12, pullRequest: 7 });
    expect(previews.queuePullRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), body);
  });
});

