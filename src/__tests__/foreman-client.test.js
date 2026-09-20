'use strict';

const { ForemanClient, validateBaseUrl, REQUIRED_JOB_INPUTS } = require('../services/foreman-client');

describe('Foreman client', () => {
  test('accepts HTTPS only and rejects credential-bearing URLs', () => {
    expect(validateBaseUrl('https://foreman.example.test/')).toBe('https://foreman.example.test');
    expect(() => validateBaseUrl('http://foreman.example.test')).toThrow(expect.objectContaining({ code: 'FOREMAN_HTTPS_REQUIRED' }));
    expect(() => validateBaseUrl('https://user:pass@foreman.example.test')).toThrow(expect.objectContaining({ code: 'FOREMAN_URL_INVALID' }));
  });

  test('inventory paginates core resources and treats missing Katello APIs as partial evidence', async () => {
    const requests = [];
    const requester = jest.fn(async (url, options) => {
      requests.push({ path: url.pathname, page: url.searchParams.get('page'), method: options.method || 'GET' });
      if (url.pathname.startsWith('/katello/')) return { status: 404, body: null };
      return { status: 200, body: { total: 1, results: [{ id: 1, name: url.pathname }] } };
    });
    const client = new ForemanClient({ base_url: 'https://foreman.example.test', auth_type: 'token', tls_verify: 1 }, 'secret', {
      requester, maxPages: 2, maxItems: 100,
    });
    const result = await client.inventory();
    expect(result.hosts).toEqual([{ id: 1, name: '/api/hosts' }]);
    expect(result.warnings).toEqual(expect.arrayContaining(['katello_content_views_unavailable', 'katello_lifecycle_environments_unavailable']));
    expect(requests.filter(item => item.path === '/api/hosts')).toHaveLength(1);
  });

  test('remote job payload is allowlist-ready and returns only task identity', async () => {
    const requester = jest.fn(async (_url, options) => ({ status: 201, body: { id: 9001, echoed: options.body } }));
    const client = new ForemanClient({ base_url: 'https://foreman.example.test', auth_type: 'token', tls_verify: 1 }, 'secret', { requester });
    await expect(client.runRemoteJob({ templateId: '101', externalId: '42', action: 'update',
      targetImageRef: `registry.example.test/eu-os/image@sha256:${'a'.repeat(64)}`,
      targetDigest: `sha256:${'a'.repeat(64)}`, idempotencyKey: 'update-0001', planHash: 'b'.repeat(64),
      approvalRef: 'CHG-42', maintenanceWindowRef: 'MW-42' })).resolves.toEqual({ taskRef: '9001' });
    expect(requester).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/api/job_invocations' }),
      expect.objectContaining({ method: 'POST', body: { job_invocation: expect.objectContaining({ job_template_id: 101,
        targeting_type: 'static_query', search_query: 'id = 42',
        inputs: expect.objectContaining({ docker_dash_target_image: expect.stringContaining('@sha256:'),
          docker_dash_plan_hash: 'b'.repeat(64), docker_dash_approval_ref: 'CHG-42',
          docker_dash_maintenance_window_ref: 'MW-42' }) }) } }));
  });

  test('qualifies the exact remote-job template input contract without returning its body', async () => {
    const requester = jest.fn(async _url => ({ status: 200, body: { id: 101, name: 'Docker Dash bootc',
      template_inputs: REQUIRED_JOB_INPUTS.map(name => ({ name })) } }));
    const client = new ForemanClient({ base_url: 'https://foreman.example.test', auth_type: 'token', tls_verify: 1 }, 'secret', { requester });
    await expect(client.jobTemplateContract('101')).resolves.toMatchObject({ templateId: '101',
      valid: true, missingInputs: [], rawTemplateReturned: false });
    expect(requester).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/api/job_templates/101' }), expect.any(Object));
  });

  test('enriches only the bounded host subset with selected facts evidence', async () => {
    const requester = jest.fn(async url => {
      if (url.pathname === '/api/hosts') return { status: 200, body: { total: 2, results: [{ id: 1, name: 'ws-1' }, { id: 2, name: 'ws-2' }] } };
      if (url.pathname === '/api/hosts/1/facts') return { status: 200, body: { results: [{ name: 'secure_boot', value: true }] } };
      if (url.pathname.startsWith('/katello/')) return { status: 404, body: null };
      return { status: 200, body: { total: 0, results: [] } };
    });
    const client = new ForemanClient({ base_url: 'https://foreman.example.test', auth_type: 'token', tls_verify: 1 }, 'secret', {
      requester, maxFactHosts: 1, factConcurrency: 1,
    });
    const result = await client.inventory();
    expect(result.hosts[0]).toMatchObject({ id: 1, facts: { secure_boot: true } });
    expect(result.hosts[1].facts).toBeUndefined();
    expect(result.warnings).toContain('host_facts_truncated');
    expect(requester).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: '/api/hosts/2/facts' }), expect.anything());
  });

  test('remote jobs reject non-numeric host selectors before network I/O', async () => {
    const requester = jest.fn();
    const client = new ForemanClient({ base_url: 'https://foreman.example.test', auth_type: 'token', tls_verify: 1 }, 'secret', { requester });
    await expect(client.runRemoteJob({ templateId: '101', externalId: '42 OR id=1', action: 'update',
      targetImageRef: `registry.example.test/eu-os/image@sha256:${'a'.repeat(64)}`,
      targetDigest: `sha256:${'a'.repeat(64)}`, idempotencyKey: 'unsafe' }))
      .rejects.toMatchObject({ code: 'FOREMAN_HOST_ID_UNSAFE' });
    expect(requester).not.toHaveBeenCalled();
  });

  test('remote jobs reject unsafe template trace inputs before network I/O', async () => {
    const requester = jest.fn();
    const client = new ForemanClient({ base_url: 'https://foreman.example.test', auth_type: 'token', tls_verify: 1 }, 'secret', { requester });
    await expect(client.runRemoteJob({ templateId: '101', externalId: '42', action: 'update',
      targetImageRef: `registry.example.test/eu-os/image@sha256:${'a'.repeat(64)}`,
      targetDigest: `sha256:${'a'.repeat(64)}`, idempotencyKey: 'unsafe;reboot', planHash: 'b'.repeat(64),
      approvalRef: 'CHG-42', maintenanceWindowRef: 'MW-42' }))
      .rejects.toMatchObject({ code: 'FOREMAN_IDEMPOTENCY_KEY_INVALID' });
    expect(requester).not.toHaveBeenCalled();
  });
});
