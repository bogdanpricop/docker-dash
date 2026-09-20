/* ═══════════════════════════════════════════════════
   pages/procedures.js — Ordered operational runbooks
   ═══════════════════════════════════════════════════ */
'use strict';

const ProceduresPage = {
  _isAdmin: false,
  _runCleanup: null,

  async render(container) {
    this._isAdmin = App.user?.role === 'admin'
      || (Array.isArray(App.user?.roles) && App.user.roles.includes('admin'));
    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-list-check" style="color:var(--accent)"></i> Procedures</h2>
          <div class="page-subtitle">Reusable operational runbooks with staged parallelism, dependencies, live progress, and audit history.</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-sm btn-secondary" id="proc-refresh" title="Refresh"><i class="fas fa-sync-alt"></i></button>
          ${this._isAdmin ? '<button class="btn btn-sm btn-secondary" id="proc-template"><i class="fas fa-copy"></i> From template</button>' : ''}
          ${this._isAdmin ? '<button class="btn btn-sm btn-primary" id="proc-create"><i class="fas fa-plus"></i> New procedure</button>' : ''}
        </div>
      </div>
      <div class="alert alert-info" style="margin-bottom:16px">
        <i class="fas fa-circle-info"></i> Stages execute in order; independent steps in the same stage run concurrently up to the procedure limit. Dependencies and error policies control what advances.
      </div>
      <div id="proc-list"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div></div>`;

    container.querySelector('#proc-refresh').addEventListener('click', () => this._load());
    container.querySelector('#proc-create')?.addEventListener('click', () => this._editProcedure());
    container.querySelector('#proc-template')?.addEventListener('click', () => this._chooseTemplate());
    await this._load();
  },

  async _load() {
    const el = document.getElementById('proc-list');
    if (!el) return;
    try {
      const procedures = await Api.getProcedures();
      if (!procedures.length) {
        el.innerHTML = `<div class="empty-msg" style="padding:48px">
          <i class="fas fa-list-check" style="font-size:48px;opacity:.3"></i>
          <p>No procedures are available${this._isAdmin ? '. Create one or start from a template.' : ' for your assigned hosts.'}</p>
        </div>`;
        return;
      }
      el.innerHTML = `<div class="info-grid" style="margin-top:0">${procedures.map(proc => `
        <div class="card" data-procedure-id="${proc.id}">
          <div class="card-header">
            <h3><i class="fas fa-list-ol" style="color:var(--accent);margin-right:8px"></i>${Utils.escapeHtml(proc.name)}</h3>
            <span class="badge ${proc.is_active ? 'badge-running' : 'badge-stopped'}">${proc.is_active ? 'active' : 'disabled'}</span>
          </div>
          <div class="card-body">
            <p class="text-sm text-muted" style="min-height:36px">${Utils.escapeHtml(proc.description || 'No description')}</p>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">
              <span class="badge badge-info"><i class="fas fa-list" style="margin-right:4px"></i>${proc.steps.length} step${proc.steps.length === 1 ? '' : 's'}</span>
              <span class="badge"><i class="fas fa-layer-group" style="margin-right:4px"></i>${new Set(proc.steps.map(step => step.stage)).size} stage${new Set(proc.steps.map(step => step.stage)).size === 1 ? '' : 's'} · max ${proc.max_parallel}</span>
              ${proc.last_run_status ? `<span class="badge ${this._statusClass(proc.last_run_status)}">last: ${Utils.escapeHtml(proc.last_run_status)}</span>` : '<span class="badge">never run</span>'}
            </div>
            ${proc.last_run_at ? `<div class="text-xs text-muted" style="margin-bottom:10px">Last run ${Utils.timeAgo(proc.last_run_at)}</div>` : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-xs btn-primary proc-run" ${!proc.is_active || proc.last_run_status === 'running' ? 'disabled' : ''}><i class="fas fa-play"></i> Run</button>
              <button class="btn btn-xs btn-secondary proc-history"><i class="fas fa-clock-rotate-left"></i> History</button>
              ${this._isAdmin ? '<button class="btn btn-xs btn-secondary proc-edit"><i class="fas fa-pen"></i> Edit</button>' : ''}
              ${this._isAdmin ? '<button class="btn btn-xs btn-danger proc-delete"><i class="fas fa-trash"></i></button>' : ''}
            </div>
          </div>
        </div>`).join('')}</div>`;

      el.querySelectorAll('[data-procedure-id]').forEach(card => {
        const id = Number(card.dataset.procedureId);
        card.querySelector('.proc-run').addEventListener('click', () => this._startRun(id));
        card.querySelector('.proc-history').addEventListener('click', () => this._showHistory(id));
        card.querySelector('.proc-edit')?.addEventListener('click', () => this._editProcedure(id));
        card.querySelector('.proc-delete')?.addEventListener('click', () => this._deleteProcedure(id));
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg" style="color:var(--red)"><i class="fas fa-triangle-exclamation"></i> ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _chooseTemplate() {
    try {
      const templates = await Api.getProcedureTemplates();
      const selected = await Modal.form(`
        <div class="form-group"><label>Template</label><select id="proc-template-select" class="form-control">
          ${templates.map((template, index) => `<option value="${index}">${Utils.escapeHtml(template.name)} — ${Utils.escapeHtml(template.description)}</option>`).join('')}
        </select></div>`, {
        title: 'Create from template',
        onSubmit: content => Number(content.querySelector('#proc-template-select').value),
      });
      if (selected !== null && templates[selected]) this._editProcedure(null, templates[selected]);
    } catch (err) { Toast.error(err.message); }
  },

  async _editProcedure(id = null, seed = null) {
    try {
      const [procedure, hostsRaw, gitStacks, channels] = await Promise.all([
        id ? Api.getProcedure(id) : Promise.resolve(seed),
        Api.getHosts(), Api.getGitStacks().catch(() => []), Api.getNotificationChannels().catch(() => []),
      ]);
      const hosts = hostsRaw.filter(host => host.isActive && ['docker', 'podman'].includes(host.daemonType || 'docker'));
      if (!hosts.length) { Toast.warning('At least one active Docker or Podman host is required'); return; }
      const defaultHost = hosts.find(host => host.isDefault) || hosts[0];
      const steps = JSON.parse(JSON.stringify(procedure?.steps || [this._newStep(defaultHost.id)]));
      steps.forEach((step, index) => {
        if (this._needsHost(step.action_type) && !step.target_host_id) step.target_host_id = defaultHost.id;
        step.action_config ||= {};
        step.on_error ||= 'stop';
        step.id ||= `step-${index + 1}`;
        step.stage = Number(step.stage) || index + 1;
        step.needs = Array.isArray(step.needs) ? step.needs : [];
        step.enabled = step.enabled !== false;
      });

      const result = await Modal.form(`
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px">
          <div class="form-group"><label>Name *</label><input id="proc-name" class="form-control" maxlength="100" value="${Utils.escapeHtml(procedure?.name || '')}"></div>
          <div class="form-group"><label>Status</label><select id="proc-active" class="form-control"><option value="true" ${procedure?.is_active !== false ? 'selected' : ''}>Active</option><option value="false" ${procedure?.is_active === false ? 'selected' : ''}>Disabled</option></select></div>
          <div class="form-group"><label>Max parallel</label><input id="proc-max-parallel" type="number" min="1" max="10" value="${Number(procedure?.max_parallel) || 4}" class="form-control"></div>
        </div>
        <div class="form-group"><label>Description</label><textarea id="proc-description" class="form-control" rows="2" maxlength="1000">${Utils.escapeHtml(procedure?.description || '')}</textarea></div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin:16px 0 8px">
          <strong>Stages and steps</strong><button type="button" class="btn btn-xs btn-secondary" id="proc-add-step"><i class="fas fa-plus"></i> Add step</button>
        </div>
        <div id="proc-step-builder"></div>`, {
        title: id ? 'Edit procedure' : 'New procedure', width: '820px',
        onMount: content => {
          const builder = content.querySelector('#proc-step-builder');
          const render = () => this._renderStepBuilder(builder, steps, { hosts, gitStacks, channels });
          render();
          content.querySelector('#proc-add-step').addEventListener('click', () => {
            this._syncAllSteps(builder, steps);
            const nextStage = Math.max(0, ...steps.map(step => Number(step.stage) || 0)) + 1;
            let sequence = 1;
            const ids = new Set(steps.map(step => step.id));
            while (ids.has(`step-${sequence}`)) sequence++;
            steps.push(this._newStep(defaultHost.id, 'pull_image', sequence - 1, nextStage));
            render();
          });
          builder.addEventListener('click', event => {
            const button = event.target.closest('[data-step-action]');
            if (!button) return;
            this._syncAllSteps(builder, steps);
            const index = Number(button.closest('[data-step-index]').dataset.stepIndex);
            const action = button.dataset.stepAction;
            if (action === 'remove' && steps.length === 1) return Toast.warning('A procedure needs at least one step');
            if (action === 'remove') steps.splice(index, 1);
            if (action === 'up' && index > 0) [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
            if (action === 'down' && index < steps.length - 1) [steps[index + 1], steps[index]] = [steps[index], steps[index + 1]];
            render();
          });
          builder.addEventListener('change', event => {
            const card = event.target.closest('[data-step-index]');
            if (!card) return;
            const index = Number(card.dataset.stepIndex);
            if (event.target.matches('[data-field="action_type"]')) {
              const structure = {
                id: steps[index].id, stage: steps[index].stage,
                needs: steps[index].needs, enabled: steps[index].enabled,
              };
              steps[index] = { ...this._newStep(defaultHost.id, event.target.value, index, steps[index].stage), ...structure };
              render();
            } else {
              this._syncStep(card, steps[index]);
            }
          });
          builder.addEventListener('input', event => {
            const card = event.target.closest('[data-step-index]');
            if (card) this._syncStep(card, steps[Number(card.dataset.stepIndex)]);
          });
        },
        onSubmit: content => {
          try {
            const name = content.querySelector('#proc-name').value.trim();
            if (!name) throw new Error('Name is required');
            this._syncAllSteps(content.querySelector('#proc-step-builder'), steps);
            for (const [index, step] of steps.entries()) {
              if (step.action_type === 'webhook') {
                try { step.action_config.payload = JSON.parse(step.action_config.payload_text || '{}'); }
                catch { throw new Error(`Step ${index + 1}: webhook payload is not valid JSON`); }
                delete step.action_config.payload_text;
              }
            }
            return {
              name, description: content.querySelector('#proc-description').value.trim(),
              is_active: content.querySelector('#proc-active').value === 'true',
              max_parallel: Number(content.querySelector('#proc-max-parallel').value), steps,
            };
          } catch (err) { Toast.warning(err.message); return false; }
        },
      });
      if (!result) return;
      if (id) await Api.updateProcedure(id, result);
      else await Api.createProcedure(result);
      Toast.success(id ? 'Procedure updated' : 'Procedure created');
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  _renderStepBuilder(builder, steps, resources) {
    builder.innerHTML = steps.map((step, index) => `
      <div class="card" data-step-index="${index}" style="margin-bottom:10px;border-left:3px solid ${step.enabled === false ? 'var(--text-muted)' : 'var(--accent)'}">
        <div class="card-header" style="padding:10px 12px">
          <strong>Step ${index + 1} <span class="badge badge-info" style="margin-left:6px">stage ${Number(step.stage) || index + 1}</span></strong>
          <div style="display:flex;gap:4px">
            <button type="button" class="btn btn-xs btn-secondary" data-step-action="up" ${index === 0 ? 'disabled' : ''} title="Move up"><i class="fas fa-arrow-up"></i></button>
            <button type="button" class="btn btn-xs btn-secondary" data-step-action="down" ${index === steps.length - 1 ? 'disabled' : ''} title="Move down"><i class="fas fa-arrow-down"></i></button>
            <button type="button" class="btn btn-xs btn-danger" data-step-action="remove" title="Remove"><i class="fas fa-trash"></i></button>
          </div>
        </div>
        <div class="card-body" style="padding:12px">
          <div style="display:grid;grid-template-columns:1fr 100px 2fr 110px;gap:10px">
            <div class="form-group"><label>Step ID</label><input class="form-control" maxlength="64" data-field="id" value="${Utils.escapeHtml(step.id || `step-${index + 1}`)}"></div>
            <div class="form-group"><label>Stage</label><input class="form-control" type="number" min="1" max="50" data-field="stage" value="${Number(step.stage) || index + 1}"></div>
            <div class="form-group"><label>Needs (comma-separated IDs)</label><input class="form-control" data-field="needs" value="${Utils.escapeHtml((step.needs || []).join(', '))}" placeholder="step-1, check-health"></div>
            <div class="form-group"><label>&nbsp;</label><label style="display:block;padding:9px 0"><input type="checkbox" data-field="enabled" ${step.enabled !== false ? 'checked' : ''}> Enabled</label></div>
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px">
            <div class="form-group"><label>Action</label><select class="form-control" data-field="action_type">${this._actionOptions(step.action_type)}</select></div>
            ${this._needsHost(step.action_type) ? `<div class="form-group"><label>Target host</label><select class="form-control" data-field="target_host_id">${resources.hosts.map(host => `<option value="${host.id}" ${Number(step.target_host_id) === host.id ? 'selected' : ''}>${Utils.escapeHtml(host.name)}</option>`).join('')}</select></div>` : '<div></div>'}
            <div class="form-group"><label>On error</label><select class="form-control" data-field="on_error"><option value="stop" ${step.on_error === 'stop' ? 'selected' : ''}>Stop run</option><option value="continue" ${step.on_error === 'continue' ? 'selected' : ''}>Continue</option></select></div>
          </div>
          ${this._actionFields(step, resources)}
        </div>
      </div>`).join('');
  },

  _actionFields(step, { gitStacks, channels }) {
    const cfg = step.action_config || {};
    const input = (label, field, value, placeholder = '') => `<div class="form-group"><label>${label}</label><input class="form-control" data-config="${field}" value="${Utils.escapeHtml(value || '')}" placeholder="${Utils.escapeHtml(placeholder)}"></div>`;
    if (step.action_type === 'pull_image') return input('Image *', 'image', cfg.image, 'nginx:latest');
    if (['restart_container', 'stop_container', 'start_container'].includes(step.action_type)) return input('Container ID or name *', 'container_id', cfg.container_id, 'web');
    if (step.action_type === 'deploy_stack') return input('Compose stack name *', 'stack_name', cfg.stack_name, 'my-stack');
    if (step.action_type === 'wait_seconds') return `<div class="form-group"><label>Seconds (0–3600)</label><input type="number" min="0" max="3600" step="0.1" class="form-control" data-config="seconds" value="${Number(cfg.seconds) || 0}"></div>`;
    if (step.action_type === 'run_git_stack') return `<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px"><div class="form-group"><label>Git stack *</label><select class="form-control" data-config="git_stack_id"><option value="">Select...</option>${gitStacks.map(stack => `<option value="${stack.id}" ${Number(cfg.git_stack_id) === stack.id ? 'selected' : ''}>${Utils.escapeHtml(stack.stack_name)}</option>`).join('')}</select></div><div class="form-group"><label>&nbsp;</label><label style="display:block;padding:9px"><input type="checkbox" data-config="force" ${cfg.force ? 'checked' : ''}> Force deploy</label></div></div>`;
    if (step.action_type === 'notify_channel') return `<div style="display:grid;grid-template-columns:1fr 2fr;gap:10px"><div class="form-group"><label>Channel</label><select class="form-control" data-config="channel_id"><option value="">All enabled channels</option>${channels.map(channel => `<option value="${channel.id}" ${Number(cfg.channel_id) === channel.id ? 'selected' : ''}>${Utils.escapeHtml(channel.name)}</option>`).join('')}</select></div>${input('Message', 'message', cfg.message, 'Procedure step completed')}</div>`;
    if (step.action_type === 'webhook') return `${input('Webhook URL *', 'url', cfg.url, 'https://example.net/hook')}<div class="form-group"><label>JSON payload</label><textarea class="form-control" data-config="payload_text" rows="3">${Utils.escapeHtml(cfg.payload_text ?? JSON.stringify(cfg.payload || {}, null, 2))}</textarea></div>`;
    return '';
  },

  _actionOptions(selected) {
    const actions = [
      ['pull_image', 'Pull image'], ['restart_container', 'Restart container'],
      ['stop_container', 'Stop container'], ['start_container', 'Start container'],
      ['deploy_stack', 'Deploy local Compose stack'], ['run_git_stack', 'Deploy Git stack'],
      ['notify_channel', 'Send notification'], ['webhook', 'Call webhook'], ['wait_seconds', 'Wait'],
    ];
    return actions.map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
  },

  _newStep(hostId, actionType = 'pull_image', index = 0, stage = index + 1) {
    const configs = {
      pull_image: { image: '' }, restart_container: { container_id: '' }, stop_container: { container_id: '' },
      start_container: { container_id: '' }, deploy_stack: { stack_name: '' }, run_git_stack: { git_stack_id: '', force: false },
      notify_channel: { channel_id: '', message: 'Procedure step completed' }, webhook: { url: '', payload_text: '{}' },
      wait_seconds: { seconds: 5 },
    };
    const step = {
      id: `step-${index + 1}`, stage, needs: [], enabled: true,
      action_type: actionType, action_config: configs[actionType] || {}, on_error: 'stop',
    };
    if (this._needsHost(actionType)) step.target_host_id = hostId;
    return step;
  },

  _needsHost(actionType) {
    return ['pull_image', 'restart_container', 'stop_container', 'start_container', 'deploy_stack'].includes(actionType);
  },

  _syncAllSteps(builder, steps) {
    builder.querySelectorAll('[data-step-index]').forEach(card => this._syncStep(card, steps[Number(card.dataset.stepIndex)]));
  },

  _syncStep(card, step) {
    step.action_type = card.querySelector('[data-field="action_type"]').value;
    step.on_error = card.querySelector('[data-field="on_error"]').value;
    step.id = card.querySelector('[data-field="id"]').value.trim();
    step.stage = Number(card.querySelector('[data-field="stage"]').value);
    step.needs = card.querySelector('[data-field="needs"]').value.split(',')
      .map(value => value.trim()).filter(Boolean);
    step.enabled = card.querySelector('[data-field="enabled"]').checked;
    const host = card.querySelector('[data-field="target_host_id"]');
    if (host) step.target_host_id = Number(host.value);
    else delete step.target_host_id;
    step.action_config ||= {};
    card.querySelectorAll('[data-config]').forEach(field => {
      let value = field.type === 'checkbox' ? field.checked : field.value;
      if (['seconds', 'git_stack_id', 'channel_id'].includes(field.dataset.config) && value !== '') value = Number(value);
      step.action_config[field.dataset.config] = value;
    });
  },

  async _deleteProcedure(id) {
    const proc = await Api.getProcedure(id).catch(() => null);
    if (!proc) return;
    const ok = await Modal.confirm(`Delete procedure “${proc.name}”? Run history will be retained.`, { danger: true, confirmText: 'Delete' });
    if (!ok) return;
    try { await Api.deleteProcedure(id); Toast.success('Procedure deleted'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },

  async _startRun(id) {
    try {
      const run = await Api.runProcedure(id);
      this._openRun(run);
      this._load();
    } catch (err) { Toast.error(err.message); }
  },

  _openRun(initialRun) {
    this._cleanupRunMonitor();
    const runId = initialRun.id;
    Modal.open(`<div class="modal-header"><h3><i class="fas fa-person-running" style="color:var(--accent);margin-right:8px"></i>Procedure run #${runId}</h3><button class="modal-close-btn" id="proc-run-close"><i class="fas fa-times"></i></button></div><div class="modal-body" id="proc-run-body"></div>`, {
      width: '760px', onClose: () => { this._cleanupRunMonitor(); this._load(); },
    });
    Modal._content.querySelector('#proc-run-close').addEventListener('click', () => Modal.close());
    let current = initialRun;
    const render = run => {
      current = run;
      const body = document.getElementById('proc-run-body');
      if (!body) return;
      const percent = run.total_steps ? Math.round((run.current_step / run.total_steps) * 100) : 0;
      body.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div><strong>${Utils.escapeHtml(run.procedure_name)}</strong><div class="text-xs text-muted">Started ${Utils.formatDate(run.started_at)}</div></div>
          <span class="badge ${this._statusClass(run.status)}">${Utils.escapeHtml(run.status)}</span>
        </div>
        <div style="height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;margin-bottom:6px"><div style="height:100%;width:${Math.min(percent, 100)}%;background:var(--accent);transition:width .2s"></div></div>
        <div class="text-xs text-muted" style="margin-bottom:14px">${run.current_step} of ${run.total_steps} steps completed${run.current_stage ? ` · stage ${run.current_stage}` : ''}${run.cancel_requested ? ' · cancellation requested' : ''}</div>
        ${run.error ? `<div class="alert alert-danger">${Utils.escapeHtml(run.error)}</div>` : ''}
        <div style="max-height:390px;overflow:auto;border:1px solid var(--border);border-radius:6px">
          ${(run.logs || []).length ? run.logs.map(log => {
            const meta = run.step_results?.[Number(log.step_index)] || {};
            return `<div style="display:grid;grid-template-columns:72px 1fr auto;gap:10px;padding:9px 10px;border-bottom:1px solid var(--border)"><span class="badge ${this._statusClass(log.status)}">${Utils.escapeHtml(log.status)}</span><span class="text-sm"><span class="text-muted">Stage ${meta.stage || '?'} · ${Utils.escapeHtml(meta.id || `step-${Number(log.step_index) + 1}`)}</span><br>${Utils.escapeHtml(log.message)}</span><span class="text-xs text-muted">${log.duration_ms === null ? '' : `${log.duration_ms} ms`}</span></div>`;
          }).join('') : '<div class="text-muted" style="padding:16px">Waiting for the first update...</div>'}
        </div>
        ${run.status === 'running' ? '<div style="text-align:right;margin-top:14px"><button class="btn btn-sm btn-danger" id="proc-cancel-run"><i class="fas fa-stop"></i> Cancel run</button></div>' : ''}`;
      body.querySelector('#proc-cancel-run')?.addEventListener('click', async event => {
        event.currentTarget.disabled = true;
        try { render(await Api.cancelProcedureRun(runId)); }
        catch (err) { Toast.error(err.message); }
      });
    };
    render(current);
    const channel = `procedure:run:${runId}`;
    WS.subscribe(channel);
    const off = WS.on('procedure:run:update', message => {
      const run = message?.data || message;
      if (Number(run?.id) === runId) render(run);
    });
    const timer = setInterval(async () => {
      try {
        const run = await Api.getProcedureRun(runId);
        render(run);
        if (run.status !== 'running') clearInterval(timer);
      } catch { /* transient polling error; WebSocket may still be active */ }
    }, 2500);
    this._runCleanup = () => { clearInterval(timer); off(); WS.unsubscribe(channel); this._runCleanup = null; };
  },

  async _showHistory(id) {
    try {
      const data = await Api.getProcedureRuns(id, { limit: 100 });
      Modal.open(`<div class="modal-header"><h3><i class="fas fa-clock-rotate-left" style="margin-right:8px;color:var(--accent)"></i>${Utils.escapeHtml(data.procedure.name)} — history</h3><button class="modal-close-btn" id="proc-history-close"><i class="fas fa-times"></i></button></div><div class="modal-body">
        ${(data.runs || []).length ? `<div style="max-height:520px;overflow:auto"><table class="data-table"><thead><tr><th>Run</th><th>Status</th><th>Progress</th><th>Started</th><th></th></tr></thead><tbody>${data.runs.map(run => `<tr><td>#${run.id}</td><td><span class="badge ${this._statusClass(run.status)}">${Utils.escapeHtml(run.status)}</span></td><td>${run.current_step}/${run.total_steps}</td><td>${Utils.formatDate(run.started_at)}</td><td><button class="btn btn-xs btn-secondary proc-view-run" data-run-id="${run.id}"><i class="fas fa-eye"></i></button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-msg">This procedure has not run yet.</div>'}
      </div>`, { width: '760px' });
      Modal._content.querySelector('#proc-history-close').addEventListener('click', () => Modal.close());
      Modal._content.querySelectorAll('.proc-view-run').forEach(button => button.addEventListener('click', async () => {
        try { this._openRun(await Api.getProcedureRun(Number(button.dataset.runId))); }
        catch (err) { Toast.error(err.message); }
      }));
    } catch (err) { Toast.error(err.message); }
  },

  _statusClass(status) {
    return ({ running: 'badge-info', success: 'badge-running', partial: 'badge-warning', failed: 'badge-stopped', cancelled: 'badge-stopped', skipped: 'badge-warning', disabled: 'badge-stopped', info: 'badge-info' })[status] || '';
  },

  _cleanupRunMonitor() {
    if (this._runCleanup) this._runCleanup();
  },

  destroy() {
    this._cleanupRunMonitor();
  },
};

window.ProceduresPage = ProceduresPage;
