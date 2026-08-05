'use strict';

const https = require('https');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUIRED_JOB_INPUTS = Object.freeze([
  'docker_dash_action', 'docker_dash_target_image', 'docker_dash_target_digest',
  'docker_dash_idempotency_key', 'docker_dash_plan_hash', 'docker_dash_approval_ref',
  'docker_dash_maintenance_window_ref',
]);

class ForemanClientError extends Error {
  constructor(message, status = 502, code = 'FOREMAN_ERROR', details) {
    super(message);
    this.name = 'ForemanClientError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(message, status, code, details) {
  return new ForemanClientError(message, status, code, details);
}

function validateBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch { throw fail('Foreman URL is invalid', 400, 'FOREMAN_URL_INVALID'); }
  if (parsed.protocol !== 'https:') throw fail('Foreman URL must use HTTPS', 400, 'FOREMAN_HTTPS_REQUIRED');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw fail('Foreman URL cannot contain credentials, query parameters or fragments', 400, 'FOREMAN_URL_INVALID');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function boundedString(value, field, max = 512, required = false) {
  const normalized = String(value ?? '').trim();
  if (required && !normalized) throw fail(`${field} is required`, 400, 'FOREMAN_INPUT_INVALID');
  if (normalized.length > max) throw fail(`${field} is too long`, 400, 'FOREMAN_INPUT_INVALID');
  return normalized;
}

function safeTraceReference(value, field) {
  const normalized = boundedString(value, field, 255, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,254}$/.test(normalized)) {
    throw fail(`${field} contains unsafe characters`, 409, 'FOREMAN_TRACE_REFERENCE_INVALID');
  }
  return normalized;
}

function safeIdempotencyKey(value) {
  const normalized = boundedString(value, 'Idempotency key', 128, true);
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(normalized)) {
    throw fail('Idempotency key format is invalid', 409, 'FOREMAN_IDEMPOTENCY_KEY_INVALID');
  }
  return normalized;
}

class ForemanClient {
  constructor(connection, secret, options = {}) {
    this.connection = connection;
    this.baseUrl = validateBaseUrl(connection.base_url || connection.baseUrl);
    this.secret = String(secret || '');
    this.timeoutMs = Math.min(120_000, Math.max(5_000, Number(options.timeoutMs) || 30_000));
    this.maxPages = Math.min(100, Math.max(1, Number(options.maxPages) || 20));
    this.maxItems = Math.min(10_000, Math.max(10, Number(options.maxItems) || 2_000));
    this.maxFactHosts = Math.min(2_000, Math.max(0, Number(options.maxFactHosts) || 0));
    this.factConcurrency = Math.min(10, Math.max(1, Number(options.factConcurrency) || 5));
    this.requester = options.requester || this._httpsRequest.bind(this);
  }

  _headers(extra = {}) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...extra };
    if (this.connection.auth_type === 'basic') {
      const username = boundedString(this.connection.username, 'Foreman username', 255, true);
      headers.Authorization = `Basic ${Buffer.from(`${username}:${this.secret}`).toString('base64')}`;
    } else if (this.secret) headers.Authorization = `Bearer ${this.secret}`;
    return headers;
  }

  _httpsRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const body = options.body == null ? null : JSON.stringify(options.body);
      const request = https.request(url, {
        method: options.method || 'GET',
        headers: this._headers(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        timeout: this.timeoutMs,
        rejectUnauthorized: this.connection.tls_verify !== 0 && this.connection.tlsVerify !== false,
        ca: this.connection.ca_pem || this.connection.caPem || undefined,
      }, response => {
        let size = 0;
        const chunks = [];
        response.on('error', error => reject(error instanceof ForemanClientError
          ? error : fail('Foreman response failed', 502, 'FOREMAN_RESPONSE_FAILED')));
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(fail('Foreman response exceeded the 2 MiB limit', 502, 'FOREMAN_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; }
          catch { return reject(fail('Foreman returned invalid JSON', 502, 'FOREMAN_INVALID_JSON')); }
          resolve({ status: response.statusCode, headers: response.headers, body: parsed });
        });
      });
      request.on('error', error => reject(error instanceof ForemanClientError
        ? error : fail('Foreman request failed', 502, 'FOREMAN_REQUEST_FAILED', { reason: error.code || 'network_error' })));
      request.on('timeout', () => request.destroy(fail('Foreman request timed out', 504, 'FOREMAN_TIMEOUT')));
      if (body) request.write(body);
      request.end();
    });
  }

  async request(path, options = {}) {
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) throw fail('Foreman request escaped the configured origin', 400, 'FOREMAN_ORIGIN_MISMATCH');
    const result = await this.requester(url, options);
    const status = Number(result?.status || 0);
    if (status === 401 || status === 403) throw fail('Foreman authentication or authorization failed', 502, 'FOREMAN_AUTH_FAILED');
    if (status === 404 && options.optional) return null;
    if (status < 200 || status >= 300) throw fail(`Foreman returned HTTP ${status || 'unknown'}`, 502, 'FOREMAN_HTTP_ERROR', { status });
    return result.body;
  }

  async paged(path, options = {}) {
    const collected = [];
    for (let page = 1; page <= this.maxPages && collected.length < this.maxItems; page += 1) {
      const url = new URL(path, `${this.baseUrl}/`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', String(Math.min(100, this.maxItems - collected.length)));
      const body = await this.request(`${url.pathname}${url.search}`, { optional: options.optional === true });
      if (body == null) return { results: [], optionalMissing: true };
      const results = Array.isArray(body) ? body : Array.isArray(body.results) ? body.results : [];
      collected.push(...results.slice(0, this.maxItems - collected.length));
      const total = Number(body.total ?? body.subtotal ?? collected.length);
      if (!results.length || collected.length >= total) break;
    }
    return { results: collected, truncated: collected.length >= this.maxItems };
  }

  async status() {
    const body = await this.request('/api/status');
    return { ok: true, version: body?.version || body?.foreman_version || null,
      status: body?.status || body?.result || 'available' };
  }

  async inventory() {
    const [organizations, locations, hostGroups, hosts, contentViews, lifecycleEnvironments] = await Promise.all([
      this.paged('/api/organizations'),
      this.paged('/api/locations'),
      this.paged('/api/hostgroups'),
      this.paged('/api/hosts?thin=false'),
      this.paged('/katello/api/content_views', { optional: true }),
      this.paged('/katello/api/environments', { optional: true }),
    ]);
    const warnings = [];
    if (contentViews.optionalMissing) warnings.push('katello_content_views_unavailable');
    if (lifecycleEnvironments.optionalMissing) warnings.push('katello_lifecycle_environments_unavailable');
    if ([organizations, locations, hostGroups, hosts, contentViews, lifecycleEnvironments].some(item => item.truncated)) {
      warnings.push('inventory_truncated');
    }
    let enrichedHosts = hosts.results;
    if (this.maxFactHosts > 0 && hosts.results.length) {
      const result = await this._enrichHostFacts(hosts.results);
      enrichedHosts = result.hosts;
      if (result.unavailable > 0) warnings.push('host_facts_unavailable');
      if (hosts.results.length > this.maxFactHosts) warnings.push('host_facts_truncated');
    }
    return {
      organizations: organizations.results,
      locations: locations.results,
      hostGroups: hostGroups.results,
      hosts: enrichedHosts,
      contentViews: contentViews.results,
      lifecycleEnvironments: lifecycleEnvironments.results,
      warnings,
    };
  }

  async hostFacts(externalId) {
    const id = encodeURIComponent(boundedString(externalId, 'Foreman host id', 128, true));
    const body = await this.request(`/api/hosts/${id}/facts`, { optional: true });
    if (body == null) return { facts: {}, unavailable: true };
    if (body.facts && typeof body.facts === 'object' && !Array.isArray(body.facts)) {
      return { facts: body.facts, unavailable: false };
    }
    if (Array.isArray(body.results)) {
      const facts = {};
      for (const item of body.results.slice(0, this.maxItems)) {
        if (item && typeof item.name === 'string' && item.name.length <= 128 && item.value !== undefined) {
          facts[item.name] = item.value;
        }
      }
      return { facts, unavailable: false };
    }
    return { facts: {}, unavailable: true };
  }

  async _enrichHostFacts(hosts) {
    const limited = hosts.slice(0, this.maxFactHosts);
    const enriched = [...hosts];
    let cursor = 0;
    let unavailable = 0;
    const worker = async () => {
      while (cursor < limited.length) {
        const index = cursor;
        cursor += 1;
        const host = limited[index];
        try {
          const result = await this.hostFacts(host.id ?? host.uuid);
          if (result.unavailable) unavailable += 1;
          enriched[index] = { ...host, facts: { ...(host.facts || {}), ...result.facts } };
        } catch {
          unavailable += 1;
          enriched[index] = host;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.factConcurrency, limited.length) }, () => worker()));
    return { hosts: enriched, unavailable };
  }

  async runRemoteJob({ templateId, externalId, action, targetImageRef, targetDigest, idempotencyKey,
    planHash, approvalRef, maintenanceWindowRef }) {
    const jobTemplateId = boundedString(templateId, 'Remote job template', 128, true);
    if (!/^\d+$/.test(jobTemplateId)) throw fail('Remote job template id must be numeric', 409, 'FOREMAN_JOB_TEMPLATE_ID_INVALID');
    const hostId = boundedString(externalId, 'Foreman host id', 128, true);
    if (!/^\d+$/.test(hostId)) throw fail('Remote jobs require an exact numeric Foreman host id', 409, 'FOREMAN_HOST_ID_UNSAFE');
    const imageRef = boundedString(targetImageRef, 'Target image reference', 1024, true);
    if (!/^[A-Za-z0-9._:\-\[\]]+(?:\/[A-Za-z0-9._-]+)+@sha256:[a-f0-9]{64}$/i.test(imageRef)) {
      throw fail('Target image reference must be canonical and digest-pinned', 409, 'FOREMAN_IMAGE_REFERENCE_INVALID');
    }
    const target = boundedString(targetDigest, 'Target digest', 80, true).toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(target) || !imageRef.toLowerCase().endsWith(`@${target}`)) {
      throw fail('Target digest does not match the canonical image reference', 409, 'FOREMAN_IMAGE_DIGEST_MISMATCH');
    }
    const workflowAction = boundedString(action, 'Action', 32, true);
    if (!['update', 'rollback'].includes(workflowAction)) throw fail('Action is invalid', 409, 'FOREMAN_ACTION_INVALID');
    const workflowHash = boundedString(planHash, 'Plan hash', 64, true);
    if (!/^[a-f0-9]{64}$/i.test(workflowHash)) throw fail('Plan hash is invalid', 409, 'FOREMAN_PLAN_HASH_INVALID');
    const payload = {
      job_invocation: {
        job_template_id: Number(jobTemplateId),
        targeting_type: 'static_query',
        search_query: `id = ${hostId}`,
        inputs: {
          docker_dash_action: workflowAction,
          docker_dash_target_image: imageRef,
          docker_dash_target_digest: target,
          docker_dash_idempotency_key: safeIdempotencyKey(idempotencyKey),
          docker_dash_plan_hash: workflowHash.toLowerCase(),
          docker_dash_approval_ref: safeTraceReference(approvalRef, 'Approval reference'),
          docker_dash_maintenance_window_ref: safeTraceReference(maintenanceWindowRef, 'Maintenance window reference'),
        },
      },
    };
    const body = await this.request('/api/job_invocations', { method: 'POST', body: payload });
    const taskRef = body?.id ?? body?.job_invocation?.id;
    if (taskRef == null) throw fail('Foreman did not return a remote-job identity', 502, 'FOREMAN_TASK_ID_MISSING');
    return { taskRef: String(taskRef) };
  }

  async jobTemplateContract(templateId) {
    const idValue = boundedString(templateId, 'Remote job template', 128, true);
    if (!/^\d+$/.test(idValue)) throw fail('Remote job template id must be numeric', 409, 'FOREMAN_JOB_TEMPLATE_ID_INVALID');
    const body = await this.request(`/api/job_templates/${encodeURIComponent(idValue)}`);
    const inputs = body?.template_inputs || body?.inputs || body?.job_template?.template_inputs || [];
    const inputNames = [...new Set((Array.isArray(inputs) ? inputs : []).map(item => String(item?.name || item?.input_name || '').trim())
      .filter(Boolean))].sort();
    const missingInputs = REQUIRED_JOB_INPUTS.filter(name => !inputNames.includes(name));
    return { templateId: idValue, name: body?.name || body?.job_template?.name || null,
      inputNames, missingInputs, valid: missingInputs.length === 0, rawTemplateReturned: false };
  }

  async job(taskRef) {
    const id = encodeURIComponent(boundedString(taskRef, 'Task reference', 128, true));
    const body = await this.request(`/api/job_invocations/${id}`);
    const rawState = String(body?.status_label || body?.status || body?.state || 'unknown').toLowerCase();
    const state = /success|succeeded|complete/.test(rawState) ? 'success'
      : /fail|error|cancel/.test(rawState) ? 'failed'
        : /running|pending|queued/.test(rawState) ? 'running' : 'unknown';
    return { taskRef: String(taskRef), state };
  }

  async host(externalId) {
    const id = encodeURIComponent(boundedString(externalId, 'Foreman host id', 128, true));
    const host = await this.request(`/api/hosts/${id}`);
    const result = await this.hostFacts(externalId).catch(() => ({ facts: {}, unavailable: true }));
    return { ...host, facts: { ...(host?.facts || {}), ...result.facts } };
  }
}

module.exports = { ForemanClient, ForemanClientError, validateBaseUrl, MAX_RESPONSE_BYTES, REQUIRED_JOB_INPUTS };
