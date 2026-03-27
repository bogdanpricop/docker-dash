'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const express = require('express');
const gitService = require('../services/git');
const { hmacSign } = require('../utils/crypto');
const log = require('../utils/logger')('git-webhook');

const router = Router();

// Raw body middleware for HMAC verification
const rawBodyParser = express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
});

router.post('/:token', rawBodyParser, async (req, res) => {
  const { token } = req.params;

  try {
    // 1. Look up stack by webhook token
    const stack = gitService.getStackByWebhookToken(token);
    if (!stack) return res.status(404).json({ error: 'Not found' });

    // 2. Validate signature
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const provider = stack.webhook_provider || 'github';
    const secret = stack.webhook_secret;

    if (secret) {
      const valid = validateSignature(provider, rawBody, secret, req.headers);
      if (!valid) {
        log.warn('Webhook signature invalid', { stackId: stack.id, provider });
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // 3. Parse payload
    const payload = parsePayload(provider, req.body);

    // 4. Branch filtering
    if (payload.branch !== stack.branch) {
      log.debug('Webhook ignored: branch mismatch', { stackId: stack.id, expected: stack.branch, received: payload.branch });
      return res.status(200).json({ status: 'ignored', reason: 'branch_mismatch' });
    }

    // 5. Deploy or notify
    if (stack.deploy_on_push) {
      try {
        const deploymentId = await gitService.triggerDeploy(stack.id, 'webhook');
        log.info('Webhook triggered deploy', { stackId: stack.id, commit: payload.commitHash?.substring(0, 7) });
        return res.status(202).json({ status: 'deploying', deploymentId, commitHash: payload.commitHash });
      } catch (err) {
        if (err.status === 409) return res.status(200).json({ status: 'already_deploying' });
        throw err;
      }
    } else {
      gitService._broadcast('git:update:available', {
        stack_id: stack.id, stack_name: stack.stack_name,
        commit_hash: payload.commitHash?.substring(0, 7),
      });
      return res.status(200).json({ status: 'update_available', commitHash: payload.commitHash });
    }

  } catch (err) {
    log.error('Webhook processing error', { token: token.substring(0, 8) + '...', error: err.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Signature Validation ──────────────────────────────

function validateSignature(provider, rawBody, secret, headers) {
  try {
    switch (provider) {
      case 'github':
      case 'generic': {
        const sig = headers['x-hub-signature-256'] || headers['x-signature-256'];
        if (!sig) return false;
        const expected = 'sha256=' + hmacSign(rawBody, secret);
        return timingSafeCompare(sig, expected);
      }
      case 'gitlab': {
        const headerToken = headers['x-gitlab-token'];
        if (!headerToken) return false;
        return timingSafeCompare(headerToken, secret);
      }
      case 'gitea': {
        const sig = headers['x-gitea-signature'];
        if (!sig) return false;
        const expected = hmacSign(rawBody, secret);
        return timingSafeCompare(sig, expected);
      }
      case 'bitbucket': {
        const sig = headers['x-hub-signature'];
        if (!sig) return false;
        const expected = 'sha256=' + hmacSign(rawBody, secret);
        return timingSafeCompare(sig, expected);
      }
      default:
        return true; // Unknown provider, skip validation
    }
  } catch {
    return false;
  }
}

function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ─── Payload Parsing ───────────────────────────────────

function parsePayload(provider, body) {
  switch (provider) {
    case 'gitlab': return parseGitLab(body);
    case 'gitea': return parseGitea(body);
    case 'bitbucket': return parseBitbucket(body);
    default: return parseGitHub(body);
  }
}

function parseGitHub(body) {
  const ref = body.ref || '';
  const headCommit = body.head_commit || {};
  return {
    branch: ref.replace('refs/heads/', ''),
    commitHash: headCommit.id || body.after || '',
    commitMessage: (headCommit.message || '').split('\n')[0],
    commitAuthor: headCommit.author?.name || headCommit.author?.username || '',
    sender: body.sender?.login || '',
  };
}

function parseGitLab(body) {
  const ref = body.ref || '';
  const commits = body.commits || [];
  const headCommit = commits[commits.length - 1] || {};
  return {
    branch: ref.replace('refs/heads/', ''),
    commitHash: body.checkout_sha || body.after || headCommit.id || '',
    commitMessage: (headCommit.message || '').split('\n')[0],
    commitAuthor: headCommit.author?.name || body.user_name || '',
    sender: body.user_username || '',
  };
}

function parseGitea(body) {
  const ref = body.ref || '';
  const commits = body.commits || [];
  const headCommit = commits[commits.length - 1] || {};
  return {
    branch: ref.replace('refs/heads/', ''),
    commitHash: body.after || headCommit.id || '',
    commitMessage: (headCommit.message || '').split('\n')[0],
    commitAuthor: headCommit.author?.name || '',
    sender: body.sender?.login || '',
  };
}

function parseBitbucket(body) {
  const change = body.push?.changes?.[0] || {};
  const newTarget = change.new?.target || {};
  return {
    branch: change.new?.name || '',
    commitHash: newTarget.hash || '',
    commitMessage: (newTarget.message || '').split('\n')[0],
    commitAuthor: newTarget.author?.raw || '',
    sender: body.actor?.display_name || '',
  };
}

module.exports = router;
