'use strict';

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_AUDIT_BYTES = 4 * 1024;
const MAX_PLAN_BYTES = 100 * 1024;
const MAX_PLAN_STEPS = 500;

class ComposeRunError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ComposeRunError';
    Object.assign(this, details);
  }
}

/**
 * Run Docker Compose without blocking the Node event loop.
 *
 * Output is consumed continuously even after the capture limit is reached so
 * the child process cannot stall on a full pipe. `onData` receives only the
 * bounded portion plus one explicit truncation event.
 */
function runCompose(args, options = {}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    return Promise.reject(new TypeError('Compose arguments must be an array of strings'));
  }
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
  const onData = typeof options.onData === 'function' ? options.onData : () => {};
  const onOutput = typeof options.onOutput === 'function' ? options.onOutput : () => {};
  const commandArgs = ['compose', '--ansi', 'never', ...args];
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('docker', commandArgs, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new ComposeRunError(err.message, { cause: err, exitCode: null }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let forceTimer = null;

    const notify = (event) => {
      try { onData(event); } catch { /* observers cannot break the child process */ }
      try {
        onOutput({ stream: event.stream, data: event.text, truncated: event.truncated });
      } catch { /* observers cannot break the child process */ }
    };

    const capture = (stream, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = Math.max(0, maxBytes - capturedBytes);
      const accepted = buffer.subarray(0, remaining);
      if (accepted.length) {
        const text = accepted.toString('utf8');
        capturedBytes += accepted.length;
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        notify({ stream, text, truncated: false });
      }
      if (buffer.length > remaining && !truncated) {
        truncated = true;
        notify({
          stream: 'system',
          text: `\n[Docker Dash] Output truncated after ${maxBytes} bytes.\n`,
          truncated: true,
        });
      }
    };

    child.stdout?.on('data', chunk => capture('stdout', chunk));
    child.stderr?.on('data', chunk => capture('stderr', chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(new ComposeRunError(err.message, {
        cause: err, stdout, stderr, output: stdout + stderr,
        exitCode: null, timedOut, truncated, durationMs: Date.now() - startedAt,
      }));
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      const output = stdout + stderr;
      if (code !== 0 || timedOut) {
        const reason = timedOut
          ? `Docker Compose timed out after ${timeoutMs} ms`
          : `Docker Compose exited with code ${code}${signal ? ` (${signal})` : ''}`;
        const error = new ComposeRunError(reason, {
          stdout, stderr, output, exitCode: code, signal, timedOut, truncated,
          durationMs: Date.now() - startedAt,
        });
        error.code = timedOut ? 'COMPOSE_TIMEOUT' : 'COMPOSE_FAILED';
        reject(error);
        return;
      }
      resolve({
        stdout, stderr, output, exitCode: code, signal, timedOut: false, truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function redactOutput(output) {
  return String(output || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/([?&](?:token|password|secret|key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(authorization:\s*)(?:bearer|basic)\s+\S+/gi, '$1[REDACTED]')
    .replace(/\/\/([^:/\s]+):([^@\s]+)@/g, '//[REDACTED]@');
}

function auditTail(resultOrError) {
  const output = String(resultOrError?.output
    || [resultOrError?.stdout, resultOrError?.stderr].filter(Boolean).join('\n'));
  const redacted = redactOutput(output);
  return redacted.length > MAX_AUDIT_BYTES ? redacted.slice(-MAX_AUDIT_BYTES) : redacted;
}

function _classifyPlanStep(value) {
  const text = String(value || '').toLowerCase();
  const kind = /\bvolume\b/.test(text) ? 'volume'
    : /\bnetwork\b/.test(text) ? 'network'
      : /\bimage\b|\bpull/.test(text) ? 'image'
        : /\bbuild/.test(text) ? 'build'
          : /\bhealth/.test(text) ? 'health'
            : /\bcontainer\b|\bservice\b/.test(text) ? 'container'
              : 'unknown';
  const operation = /\brestart/.test(text) ? 'restart'
    : /\bremov|\bdelet|\bdown\b/.test(text) ? 'remove'
      : /\bpull/.test(text) ? 'pull'
        : /\bbuild/.test(text) ? 'build'
          : /\bcreat/.test(text) ? 'create'
            : /\bstart/.test(text) ? 'start'
              : /\bwait|\bhealth/.test(text) ? 'wait'
                : /\bnoop|\bunchanged|\bup.to.date/.test(text) ? 'noop'
                  : 'unknown';
  return { kind, operation };
}

/** Normalize newline-delimited Compose JSON progress without depending on its unstable schema. */
function parseComposePlan(result = {}) {
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const redacted = redactOutput(combined);
  const lines = redacted.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const steps = [];

  for (const line of lines.slice(0, MAX_PLAN_STEPS)) {
    let record = null;
    try { record = JSON.parse(line); } catch { /* older Compose emits plain progress */ }
    const resource = String(record?.id || record?.name || record?.resource || '').slice(0, 512);
    const text = String(record?.text || record?.status || record?.message || line).slice(0, 2_000);
    const classification = _classifyPlanStep(`${resource} ${text}`);
    steps.push({
      ...classification,
      resource,
      text,
      status: /\bwarn|\berror|\bfail/i.test(text) ? 'warning' : 'planned',
    });
  }

  const summary = {};
  for (const step of steps) summary[step.operation] = (summary[step.operation] || 0) + 1;
  return {
    steps,
    summary,
    rawOutput: redacted.slice(0, MAX_PLAN_BYTES),
    truncated: Boolean(result.truncated || redacted.length > MAX_PLAN_BYTES || lines.length > MAX_PLAN_STEPS),
  };
}

module.exports = {
  runCompose,
  auditTail,
  redactOutput,
  parseComposePlan,
  ComposeRunError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  MAX_PLAN_BYTES,
  MAX_PLAN_STEPS,
};
