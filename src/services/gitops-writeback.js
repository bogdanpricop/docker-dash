'use strict';

const crypto = require('crypto');
const YAML = require('yaml');
const diff = require('diff');
const { getDb } = require('../db');
const { now } = require('../utils/helpers');
const git = require('./git');
const sync = require('./gitops-sync');

function _error(message, status = 400, code) { return Object.assign(new Error(message), { status, code }); }
function _hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function _decorate(row) {
  if (!row) return null;
  return { ...row, enabled: !!row.enabled, auto_writeback: !!row.auto_writeback };
}

function list() {
  return getDb().prepare(`
    SELECT m.*, s.stack_name, s.branch, s.repo_url, s.status AS stack_status
    FROM gitops_managed_sources m JOIN git_stacks s ON s.id=m.git_stack_id
    ORDER BY s.stack_name
  `).all().map(_decorate);
}

function get(id) {
  return _decorate(getDb().prepare(`
    SELECT m.*, s.stack_name, s.branch, s.repo_url, s.status AS stack_status
    FROM gitops_managed_sources m JOIN git_stacks s ON s.id=m.git_stack_id
    WHERE m.id=?
  `).get(Number(id)));
}

function configure(input, userId) {
  const stackId = Number(input.git_stack_id ?? input.gitStackId);
  const stack = git.getStack(stackId);
  if (!stack) throw _error('Managed write-back Git stack not found', 404);
  const filePath = String(input.file_path || input.filePath || '.docker-dash/fleet.yaml');
  git._validateComposePath(filePath);
  if (filePath.length > 240) throw _error('Managed write-back path is too long');
  const deploymentFiles = [stack.compose_path, ...(Array.isArray(stack.additional_files)
    ? stack.additional_files : (() => { try { return JSON.parse(stack.additional_files || '[]'); } catch { return []; } })())];
  if (deploymentFiles.includes(filePath)) {
    throw _error('Managed fleet document cannot overwrite a Compose deployment file', 409);
  }
  if (['deploying', 'cloning'].includes(stack.status)) throw _error('Git stack is currently deploying', 409);
  const enabled = input.enabled === true;
  const autoWriteback = input.auto_writeback === true || input.autoWriteback === true;
  if (autoWriteback && !enabled) throw _error('Automatic write-back requires managed mode to be enabled');
  getDb().prepare(`
    INSERT INTO gitops_managed_sources
      (git_stack_id, file_path, enabled, auto_writeback, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(git_stack_id) DO UPDATE SET
      file_path=excluded.file_path, enabled=excluded.enabled,
      auto_writeback=excluded.auto_writeback, updated_at=excluded.updated_at
  `).run(stackId, filePath, enabled ? 1 : 0, autoWriteback ? 1 : 0, userId || null, now());
  return list().find(item => item.git_stack_id === stackId);
}

function _exportDocument() {
  const document = sync.capture();
  // A generated timestamp would make every plan dirty and, worse, would
  // invalidate the hash between review and apply. Managed files are stable.
  delete document.metadata.exportedAt;
  return YAML.stringify(document, { lineWidth: 120, sortMapEntries: false });
}

async function plan(id) {
  const managed = get(id);
  if (!managed) throw _error('Managed GitOps source not found', 404);
  if (!managed.enabled) throw _error('Managed GitOps write-back is disabled', 409);
  const remote = await git.getRemoteStatus(managed.git_stack_id);
  if (!remote.isUpToDate) {
    throw _error('Managed repository is not synchronized with its remote branch', 409, 'REMOTE_CONFLICT');
  }
  let current = '';
  try { current = git.readComposeFile(managed.git_stack_id, managed.file_path).content; }
  catch (err) { if (err.status !== 404) throw err; }
  const desired = _exportDocument();
  const documentHash = _hash(desired);
  const currentHash = _hash(current);
  const planHash = _hash(JSON.stringify({
    managedId: managed.id, stackId: managed.git_stack_id, filePath: managed.file_path,
    localHead: remote.localHead, remoteHead: remote.remoteHead, currentHash, documentHash,
  }));
  const patch = current === desired ? '' : diff.createPatch(managed.file_path, current, desired, 'repository', 'docker-dash');
  return {
    managedId: managed.id, gitStackId: managed.git_stack_id,
    stackName: managed.stack_name, branch: managed.branch, filePath: managed.file_path,
    currentHash, documentHash, planHash, changed: current !== desired,
    localHead: remote.localHead, remoteHead: remote.remoteHead,
    diff: patch.substring(0, 512 * 1024), document: desired,
  };
}

async function apply(id, { planHash, commitMessage, actor } = {}) {
  if (!planHash) throw _error('A reviewed write-back planHash is required');
  const reviewed = await plan(id);
  if (reviewed.planHash !== planHash) throw _error('Managed GitOps write-back plan is stale', 409, 'STALE_PLAN');
  if (!reviewed.changed) return { ok: true, changed: false, planHash };
  const result = await git.pushToGit(reviewed.gitStackId, {
    commitMessage: commitMessage || 'chore(docker-dash): reconcile fleet configuration',
    files: { [reviewed.filePath]: reviewed.document },
    author: actor?.author || 'Docker Dash <noreply@docker-dash.local>',
    forcePush: false,
  });
  getDb().prepare(`UPDATE gitops_managed_sources
    SET last_export_hash=?, last_commit_hash=?, last_written_at=?, updated_at=? WHERE id=?`)
    .run(reviewed.documentHash, result.commitHash, now(), now(), reviewed.managedId);
  return { ok: true, changed: true, planHash, documentHash: reviewed.documentHash, commitHash: result.commitHash };
}

async function autoWriteback({ userId = null, username = 'system' } = {}) {
  const managed = list().filter(item => item.enabled && item.auto_writeback);
  const results = [];
  for (const item of managed) {
    try {
      const reviewed = await plan(item.id);
      const result = await apply(item.id, {
        planHash: reviewed.planHash,
        actor: { author: `${username} <${username}@docker-dash.local>` },
      });
      results.push({ id: item.id, stackName: item.stack_name, ...result });
    } catch (err) {
      results.push({ id: item.id, stackName: item.stack_name, ok: false, error: err.message, code: err.code });
    }
  }
  return { userId, results };
}

module.exports = { list, get, configure, plan, apply, autoWriteback, _exportDocument };
