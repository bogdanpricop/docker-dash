'use strict';

const AIComputePage = {
  _charts: [],
  _e(value) { return Utils.escapeHtml(String(value ?? '')); },
  _bytes(value) { return Number.isFinite(value) ? Utils.formatBytes(value) : 'Unavailable'; },
  _url(path) { return `/ai-compute/${path}${path.includes('?') ? '&' : '?'}hostId=${this._hostId}`; },

  async render(container) {
    this.destroy();
    this._container = container;
    this._token = {};
    this._probes = new Map();
    const token = this._token;
    if (App.user?.role !== 'admin') { container.innerHTML = '<p>AI Compute requires administrator access.</p>'; return; }
    container.innerHTML = '<p role="status">Loading configured AI hosts…</p>';
    try { this._hosts = await Api.get('/ai-compute/hosts'); }
    catch (err) {
      if (this._token === token) container.innerHTML = `<p role="alert">${this._e(err.message)}</p>`;
      return;
    }
    if (this._token !== token) return;
    const saved = Number(localStorage.getItem('dd-ai-compute-host'));
    const target = this._hosts.find(h => h.id === saved) || this._hosts.find(h => h.recommended)
      || this._hosts.find(h => h.id === Api.getHostId()) || this._hosts[0];
    if (!target) { container.innerHTML = '<p>No active Docker hosts configured. <a href="#/hosts">Add a host</a> to use AI Compute.</p>'; return; }
    this._hostId = target.id;
    localStorage.setItem('dd-ai-compute-host', this._hostId);
    this._hours = Number(localStorage.getItem(`dd-ai-compute-range-${this._hostId}`)) || 1;
    if (![1, 24, 168, 720].includes(this._hours)) this._hours = 1;
    this._filter = localStorage.getItem(`dd-ai-compute-filter-${this._hostId}`) || '';
    container.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-microchip"></i> AI Compute</h2>
      <div class="page-subtitle">Capacity, models and controlled engine switching · independent of the sidebar host</div></div>
      <div class="page-actions"><label for="compute-target">AI host</label><select id="compute-target" class="form-control" style="width:auto;max-width:360px" title="AI Compute uses its own host selection">
        ${this._hosts.map(h => `<option value="${h.id}" ${h.id === this._hostId ? 'selected' : ''}>${this._e(h.name)} · ${this._e(h.reason)}</option>`).join('')}</select>
      <button type="button" class="btn btn-sm btn-secondary" id="compute-refresh">Refresh</button></div></div>
      <div class="stack-list-host" id="compute-host" role="status">Connecting to the selected host…</div>
      <div id="compute-error" role="alert"></div>
      <div id="compute-metrics" class="stat-cards" style="margin:16px 0"></div>
      <div class="card"><div class="card-header" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center"><h3>Resource history</h3>
        <label>Range <select id="compute-range" class="form-control input-sm" style="width:auto;display:inline-block">${[[1,'1 hour'],[24,'24 hours'],[168,'7 days'],[720,'30 days']].map(([v,label]) => `<option value="${v}" ${v === this._hours ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label><input type="checkbox" id="compute-monitor"> Record every minute</label>
        <span class="text-muted text-sm">30-day retention · missing measurements remain gaps</span></div>
        <div class="card-body" id="compute-history" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px"></div></div>
      <div class="card" style="margin-top:16px"><div class="card-header" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><h3>AI workloads</h3>
        <input type="search" id="compute-filter" class="form-control" style="max-width:320px" aria-label="Filter AI workloads" placeholder="Filter workloads or models…" value="${this._e(this._filter)}"></div>
        <div class="card-body" id="compute-workloads" style="overflow:auto"></div></div>
      <div class="card" style="margin-top:16px"><div class="card-header"><h3>Model catalog</h3></div>
        <div class="card-body"><p class="text-muted text-sm">Standard recipes use pinned model revisions, a reviewed NVIDIA ARM64 runtime and a shared model cache. Memory/disk budgets are estimates; live checks run before starting. APIs bind to host loopback.</p>
        <div id="compute-catalog" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px"></div></div></div>
      <div class="card" style="margin-top:16px"><div class="card-header"><h3>Operation history</h3></div><div class="card-body" id="compute-jobs" aria-live="polite"></div></div>`;
    container.querySelector('#compute-refresh').addEventListener('click', () => this.render(container));
    container.querySelector('#compute-target').addEventListener('change', event => {
      localStorage.setItem('dd-ai-compute-host', event.target.value);
      this.render(container);
    });
    container.querySelector('#compute-range').addEventListener('change', async event => {
      this._hours = Number(event.target.value);
      localStorage.setItem(`dd-ai-compute-range-${this._hostId}`, this._hours);
      try { await this._history(token); } catch (err) { this._error(err); }
    });
    container.querySelector('#compute-filter').addEventListener('input', event => {
      this._filter = event.target.value;
      localStorage.setItem(`dd-ai-compute-filter-${this._hostId}`, this._filter);
      this._workloads();
    });
    container.querySelector('#compute-monitor').addEventListener('change', async event => {
      const input = event.target, enabled = input.checked;
      input.disabled = true;
      try { await Api.post(this._url('monitoring'), { enabled }); }
      catch (err) { input.checked = !enabled; this._error(err); }
      finally { input.disabled = false; }
    });
    await this._refresh();
    if (this._token === token) this._timer = setInterval(() => this._refresh(), 15000);
  },

  _error(err) {
    const el = this._container?.querySelector('#compute-error');
    if (el) el.innerHTML = `<p class="text-danger">${this._e(err.message)}</p>`;
  },
  async _refresh() {
    if (this._loading) return;
    const token = this._token;
    this._loading = true;
    try {
      const [inventory, sample, jobs, catalog] = await Promise.all([
        Api.get(this._url('inventory')), Api.get(this._url('metrics')),
        Api.get(this._url('jobs')), Api.get(this._url('catalog')),
      ]);
      if (token !== this._token) return;
      this._inventory = inventory;
      this._activeJob = jobs.find(job => ['queued', 'running', 'needs_review'].includes(job.status));
      this._catalogEntries = catalog;
      const host = this._hosts.find(h => h.id === this._hostId);
      this._container.querySelector('#compute-host').innerHTML = `<i class="fas fa-server"></i> Host <strong>${this._e(host?.name || inventory.hostName || inventory.hostId)}</strong> · Connected · ${this._e(inventory.architecture)} · Last sample ${this._e(new Date(sample.sampledAt).toLocaleString())}`;
      this._container.querySelector('#compute-error').innerHTML = sample.warning ? `<p class="text-warning">${this._e(sample.warning)}</p>` : '';
      this._container.querySelector('#compute-monitor').checked = inventory.monitoring;
      this._metrics(sample);
      this._workloads();
      this._catalog(catalog);
      this._jobs(jobs);
      await this._history(token);
    } catch (err) {
      if (token === this._token) {
        this._error(err);
        const name = this._inventory?.hostName || this._hosts.find(h => h.id === this._hostId)?.name || this._hostId;
        this._container.querySelector('#compute-host').textContent = `Host ${name} · Connection unavailable · last successful values retained below`;
      }
    } finally { if (token === this._token) this._loading = false; }
  },
  _metrics(sample) {
    const percent = value => Number.isFinite(value) ? value.toFixed(1) + '%' : 'Collecting…';
    const values = [
      ['CPU', percent(sample.cpuPercent), `${sample.cpus || '?'} cores`],
      [sample.unified ? 'Unified memory' : 'Host memory', this._bytes(sample.memory?.usedBytes), `${this._bytes(sample.memory?.availableBytes)} available · ${this._bytes(sample.memory?.totalBytes)} total`],
      ['GPU', percent(sample.gpu?.utilizationPercent), sample.gpu ? `${sample.gpu.name} · ${sample.gpu.temperatureC ?? '?'} °C · ${sample.gpu.powerWatts ?? '?'} W` : 'NVIDIA metrics unavailable'],
      ['Root disk free', this._bytes(sample.disk?.availableBytes), `${this._bytes(sample.disk?.totalBytes)} total · model cache: ${this._bytes(sample.cacheDisk?.availableBytes)} free`],
    ];
    this._container.querySelector('#compute-metrics').innerHTML = values.map(([title,value,detail]) => `<div class="stat-card"><div class="stat-body"><div class="stat-label">${this._e(title)}</div><div class="stat-value" style="font-size:24px">${this._e(value)}</div><div class="text-muted text-sm">${this._e(detail)}</div></div></div>`).join('');
  },
  async _history(token) {
    const hours = this._hours, points = await Api.get(this._url(`history?hours=${hours}`));
    if (token !== this._token || hours !== this._hours) return;
    this._charts.forEach(chart => chart.destroy());
    this._charts = [];
    const host = this._container.querySelector('#compute-history');
    if (!points.length) { host.innerHTML = '<p class="text-muted">No measurements yet. Enable recording to build history.</p>'; return; }
    host.innerHTML = ['CPU %', 'Memory GiB', 'GPU %', 'Root disk free GiB'].map((title,i) => `<div><h4>${title}</h4><div style="height:160px"><canvas id="compute-chart-${i}" role="img" aria-label="${title} history"></canvas></div></div>`).join('');
    // An interrupted collector must produce a visible gap, not a fabricated connecting trend.
    const data = [];
    points.forEach((point,i) => {
      if (i && Date.parse(point.sampledAt) - Date.parse(points[i-1].sampledAt) > Math.max(180000, hours * 3600000 / 200)) data.push({ sampledAt: new Date(Date.parse(point.sampledAt) - 1).toISOString() });
      data.push(point);
    });
    const getters = [p => p.cpuPercent, p => p.memory ? p.memory.usedBytes / 1024 ** 3 : null, p => p.gpu?.utilizationPercent, p => p.disk ? p.disk.availableBytes / 1024 ** 3 : null];
    getters.forEach((get,i) => this._charts.push(new Chart(host.querySelector(`#compute-chart-${i}`), {
      type: 'line', data: { datasets: [{ data: data.map(p => ({ x: Date.parse(p.sampledAt), y: get(p) ?? null })), borderColor: ['#4c8dff','#a78bfa','#22c55e','#eab308'][i], borderWidth: 2, pointRadius: data.length < 3 ? 2 : 0, spanGaps: false }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: items => new Date(items[0].parsed.x).toLocaleString() } } },
        scales: { x: { type: 'linear', min: Date.now() - hours * 3600000, max: Date.now(), ticks: { maxTicksLimit: 3, callback: value => new Date(value).toLocaleString() } }, y: { min: 0, ...(i % 2 === 0 ? { max: 100 } : {}) } } },
    })));
  },
  _workloads() {
    const rows = (this._inventory?.containers || []).filter(c => `${c.name} ${c.model || ''}`.toLowerCase().includes(this._filter.toLowerCase()));
    const el = this._container.querySelector('#compute-workloads');
    if (!rows.length) { el.innerHTML = '<p class="text-muted">No matching AI workloads. Choose a standard catalog recipe below or register a detected engine.</p>'; return; }
    el.innerHTML = `${this._activeJob ? `<p role="status">${this._activeJob.status === 'needs_review' ? 'An interrupted operation needs review' : 'An AI operation is in progress'}. See Operation history below. Service controls are temporarily unavailable.</p>` : ''}<table class="data-table"><thead><tr><th>Workload / model</th><th>Container state</th><th>Memory budget</th><th>Profile / API</th><th>Actions</th></tr></thead><tbody>${rows.map(c => `<tr>
      <td><strong>${this._e(c.name)}</strong><div class="text-muted text-sm">${this._e(c.engine)} · ${this._e(c.model || 'Model not identified')}</div></td>
      <td>${this._e(c.state)}<div class="text-muted text-sm">Health: ${this._e(c.health || 'No Docker healthcheck')}</div></td>
      <td>${this._bytes(c.memoryBytes)}<div class="text-muted text-sm">${c.profileId ? 'Configured reservation' : 'Estimated · review on registration'}</div></td>
      <td>${c.profileName ? `<div class="text-sm">${this._e(c.profileName)}</div>` : ''}<button type="button" class="btn btn-xs btn-secondary" data-register="${c.id}">${c.profileId ? 'Edit profile' : 'Register profile'}</button> <button type="button" class="btn btn-xs btn-secondary" data-probe="${c.id}">Check API</button> <button type="button" class="btn btn-xs btn-secondary" data-cache="${c.id}">Cached models</button><div id="probe-${c.id}" class="text-sm" role="status">${this._e(this._probes?.get(c.id) || 'API not checked')}</div></td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="btn btn-xs btn-secondary" data-logs="${c.id}">Logs</button> ${(c.state === 'running' ? ['stop','restart'] : ['start', ...(c.exclusive && ['created','exited'].includes(c.state) ? ['switch'] : [])]).map(action => {
        const supported = ['running','created','exited'].includes(c.state);
        const hint = this._activeJob ? 'Review Operation history before another action' : !supported ? `Service is ${c.state}. Manage this state in Containers first.` : c.profileId ? 'Review and confirm this service operation' : 'Review the service profile, then confirm the operation';
        return `<button type="button" class="btn btn-xs ${action === 'stop' ? 'btn-danger' : 'btn-secondary'}" data-operation="${action}" data-workload="${c.id}" ${!supported || this._activeJob ? 'disabled' : ''} title="${this._e(hint)}">${action[0].toUpperCase()+action.slice(1)}</button>`;
      }).join(' ')}</div></td></tr>`).join('')}</tbody></table>`;
    el.querySelectorAll('[data-logs]').forEach(b => b.addEventListener('click', async () => {
      const token = this._token, hostId = this._hostId;
      const c = rows.find(c => c.id === b.dataset.logs);
      b.disabled = true;
      try {
        const result = await Api.get(`/containers/${c.id}/logs?tail=200&hostId=${hostId}`);
        if (token !== this._token) return;
        Modal.open(`<div class="modal-header"><h2>${this._e(c.name)} · Logs</h2></div><div class="modal-body"><p>Host: ${this._e(this._hosts.find(h => h.id === hostId)?.name)} · Last 200 lines${result.truncated ? ' · Truncated' : ''}</p><pre style="white-space:pre-wrap;overflow:auto;max-height:60vh">${this._e(result.lines.join('\n') || 'No log lines available.')}</pre></div><div class="modal-footer"><button type="button" class="btn btn-primary" id="compute-full-logs" title="Switch sidebar host and open the complete log viewer">Open full logs on this host</button><button type="button" class="btn btn-secondary" id="compute-logs-close">Close</button></div>`, { width: '900px' });
        Modal._content.querySelector('#compute-logs-close').addEventListener('click', () => Modal.close());
        Modal._content.querySelector('#compute-full-logs').addEventListener('click', async () => {
          try {
            await App._initHostSelector();
            if (token !== this._token) return;
            Modal.close();
            App._activateHost(hostId, `#/containers/${c.id}/logs`);
          } catch (err) { if (token === this._token) this._error(err); }
        });
      } catch (err) { if (token === this._token) this._error(err); }
      finally { b.disabled = false; }
    }));
    el.querySelectorAll('[data-register]').forEach(b => b.addEventListener('click', () => this._register(b.dataset.register)));
    el.querySelectorAll('[data-operation]').forEach(b => b.addEventListener('click', async () => {
      const c = rows.find(c => c.id === b.dataset.workload);
      b.disabled = true;
      try {
        if (c.profileId) await this._preview({ action: b.dataset.operation, profileId: c.profileId });
        else this._register(c.id, b.dataset.operation);
      } finally { if (b.isConnected && !this._activeJob) b.disabled = false; }
    }));
    el.querySelectorAll('[data-cache]').forEach(b => b.addEventListener('click', async () => {
      const token = this._token, url = this._url('cache'); b.disabled = true;
      try {
        const result = await Api.post(url, { containerId: b.dataset.cache });
        if (token !== this._token) return;
        Modal.open(`<div class="modal-header"><h2>Cached models</h2></div><div class="modal-body"><p>${this._e(result.note)}</p>${result.models.length ? result.models.map(m => `<p><strong>${this._e(m.model)}</strong> · ${this._e(m.state)}<br><span class="text-muted text-sm">${this._e(m.cachedRevisions.join(', '))}</span></p>`).join('') : '<p>No cached Hugging Face weights found in this container.</p>'}<p class="text-muted text-sm">${this._e(new Date(result.checkedAt).toLocaleString())}</p></div><div class="modal-footer"><button type="button" class="btn btn-secondary" id="cache-close">Close</button></div>`);
        Modal._content.querySelector('#cache-close').addEventListener('click', () => Modal.close());
      } catch (err) { if (token === this._token) this._error(err); }
      finally { b.disabled = false; }
    }));
    el.querySelectorAll('[data-probe]').forEach(b => b.addEventListener('click', async () => {
      const token = this._token, hostUrl = this._url('probe'); b.disabled = true;
      try {
        const result = await Api.post(hostUrl, { containerId: b.dataset.probe });
        if (token === this._token) {
          const message = `${result.ready ? 'Ready' : 'Not ready'} · ${result.detail} · ${new Date(result.checkedAt).toLocaleTimeString()}`;
          this._probes.set(b.dataset.probe, message);
          if (b.isConnected) el.querySelector(`#probe-${b.dataset.probe}`).textContent = message;
        }
      } catch (err) { if (token === this._token) this._error(err); }
      finally { b.disabled = false; }
    }));
  },
  _form(title, body, submit, submitText = 'Continue') {
    Modal.open(`<form id="compute-form"><div class="modal-header"><h2>${this._e(title)}</h2></div><div class="modal-body">${body}<p id="compute-form-error" class="text-danger" role="alert"></p></div><div class="modal-footer"><button type="button" class="btn btn-secondary" id="compute-cancel">Cancel</button><button type="submit" class="btn btn-primary">${this._e(submitText)}</button></div></form>`, { width: '600px' });
    const form = Modal._content.querySelector('#compute-form');
    form.querySelector('#compute-cancel').addEventListener('click', () => Modal.close());
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('[type=submit]'); button.disabled = true;
      try { await submit(new FormData(form)); }
      catch (err) { form.querySelector('#compute-form-error').textContent = err.message; }
      finally { button.disabled = false; }
    });
  },
  _register(id, nextAction = null) {
    const c = this._inventory.containers.find(c => c.id === id), token = this._token, url = this._url('profiles');
    this._form(nextAction ? `Set up ${c.name} controls` : 'AI workload profile', `${nextAction ? `<p>First use: review this service profile so its memory budget and restart policy are saved for future starts. Next, review and confirm <strong>${this._e(nextAction)}</strong>. Saving this profile does not start or stop the service.</p>` : ''}<p>Review the memory reservation. Switch plans can stop other exclusive LLMs; other speech services are preserved.</p>
      <div class="form-group"><label for="compute-name">Profile name</label><input type="text" class="form-control" id="compute-name" name="name" required maxlength="120" value="${this._e(c.profileName || c.name)}"></div>
      <div class="form-group"><label for="compute-memory">Memory budget (GiB)</label><input class="form-control" id="compute-memory" name="memory" type="number" min="1" max="2048" step="0.5" required value="${Math.ceil((c.memoryBytes || 8 * 1024 ** 3) / 1024 ** 3)}"></div>
      <div class="form-group"><label for="compute-port">API port inside container (optional; requires Python 3)</label><input class="form-control" id="compute-port" name="port" type="number" min="1" max="65535" value="${c.readyPort || ''}"></div>
      <label><input name="exclusive" type="checkbox" ${c.exclusive ? 'checked' : ''} ${c.engine === 'speech' ? 'disabled' : ''}> Exclusive LLM</label>`, async data => {
      if (token !== this._token) throw new Error('The selected host changed. Close this dialog and try again.');
      const inventory = await Api.post(url, { containerId: id, name: data.get('name'), memoryGiB: Number(data.get('memory')), readyPort: data.get('port'), exclusive: data.has('exclusive') });
      if (token !== this._token) throw new Error('The selected host changed. The profile was saved on the original host; no operation was submitted.');
      const profile = inventory.containers.find(row => row.id === id);
      if (nextAction && !profile?.profileId) throw new Error('The service profile could not be verified. Refresh and try again.');
      this._inventory = inventory;
      this._workloads();
      Modal.close();
      if (nextAction) await this._preview({ action: nextAction, profileId: profile.profileId });
      else await this._refresh();
    }, nextAction ? `Save profile and review ${nextAction}` : 'Save profile');
  },
  _catalog(entries) {
    const el = this._container.querySelector('#compute-catalog');
    el.innerHTML = entries.map(entry => `<div class="card"><div class="card-body"><span class="badge ${entry.deployable ? 'badge-success' : 'badge-warning'}">${entry.deployable ? 'Standard recipe' : 'Experimental'}</span><h3>${this._e(entry.name)}</h3>
      <p class="text-sm">${entry.memoryBytes ? `${this._bytes(entry.memoryBytes)} memory · ${this._bytes(entry.diskBytes)} disk (estimates)` : 'Resources require qualification'}</p>
      <p class="text-muted text-sm">${this._e(entry.reason || `${entry.license} · pinned weights · ARM64 NVIDIA`)}</p>
      <a href="${this._e(entry.source)}" target="_blank" rel="noopener noreferrer">Project / model card</a>
      ${entry.deployable ? `<button type="button" class="btn btn-sm btn-primary" data-deploy="${entry.id}" style="margin-left:12px">Plan deploy</button>` : ''}</div></div>`).join('');
    el.querySelectorAll('[data-deploy]').forEach(b => b.addEventListener('click', () => {
      const entry = entries.find(e => e.id === b.dataset.deploy), token = this._token;
      this._form(`Deploy ${entry.name}`, `<p>The API is exposed on host loopback only. Review the exact containers to stop in the next step.</p>
        <div class="form-group"><label for="deploy-context">Context length</label><select class="form-control" id="deploy-context" name="context">${entry.contextLengths.map(n => `<option value="${n}">${n} tokens</option>`).join('')}</select></div>
        <div class="form-group"><label for="deploy-port">Host loopback port</label><input class="form-control" id="deploy-port" name="port" type="number" min="1024" max="65535" value="18000" required></div>
        <label><input type="checkbox" name="stop"> Include stopping other exclusive LLMs in the plan</label>`, async data => {
        if (token !== this._token) throw new Error('The selected host changed. Close this dialog and try again.');
        const payload = { action: 'deploy', catalogId: entry.id, contextLength: Number(data.get('context')), port: Number(data.get('port')), stopConflicts: data.has('stop') };
        await this._preview(payload, true);
      });
    }));
  },
  async _preview(payload, fromForm = false) {
    const token = this._token, hostId = this._hostId;
    try {
      const result = await Api.post(this._url('plans'), payload);
      if (token !== this._token) throw new Error('Host changed. The plan was not submitted.');
      const plan = result.plan;
      const message = `<p><strong>${this._e(result.action.toUpperCase())} · ${this._e(plan.target.name)}</strong></p><p>Host: ${this._e(this._container.querySelector('#compute-host').textContent)}</p>
        ${payload.action === 'stop' ? '<p>This stops the AI service and unloads all models it serves. Requests to this service will be interrupted until it is started again. Cached model files are retained.</p>' : `<p>Memory reservation: ${this._bytes(plan.target.memoryBytes)} · 4 GiB additional host reserve.</p>${payload.action === 'restart' ? '<p>Requests to this service will be interrupted while its models reload.</p>' : ''}`}
        <p>${plan.stop.length ? 'These engines will stop:' : 'No other engines will stop.'}</p><ul>${plan.stop.map(c => `<li>${this._e(c.name)} <code>${this._e(c.id.slice(0,12))}</code></li>`).join('')}</ul>
        <p>${payload.action === 'stop' ? 'The service stays stopped until you start it again.' : this._e(plan.warning)}</p><p class="text-muted text-sm">Plan expires ${this._e(new Date(plan.expiresAt).toLocaleTimeString())}. Other speech services and gateway containers are excluded from automatic conflict stopping.</p>`;
      const label = { start: 'Start service', stop: 'Stop service', restart: 'Restart service' }[payload.action] || 'Execute plan';
      if (await Modal.confirm(message, { title: 'Review AI operation', html: true, danger: plan.stop.length > 0 || ['stop','restart'].includes(payload.action), confirmText: label, width: '620px' })) {
        if (token !== this._token) throw new Error('Host changed. Create a fresh plan.');
        await Api.post(`/ai-compute/plans/${result.id}/execute?hostId=${hostId}`, {});
        await this._refresh();
      }
    } catch (err) { if (fromForm) throw err; if (token === this._token) this._error(err); }
  },
  _jobs(jobs) {
    const el = this._container.querySelector('#compute-jobs');
    el.innerHTML = jobs.length ? jobs.map(job => `<div style="padding:10px 0;border-bottom:1px solid var(--border)"><strong>${this._e(job.action)} · ${this._e(job.plan.target.name)}</strong> <span class="badge">${this._e(job.status.replaceAll('_',' '))}</span>
      <span class="text-muted text-sm">${this._e(new Date(job.updatedAt).toLocaleString())}</span>${job.error ? `<p class="text-danger">${this._e(job.error)}</p>` : ''}
      ${job.status === 'needs_review' ? `<button type="button" class="btn btn-sm btn-secondary" data-rollback="${job.id}">Review and restore previous engines</button>` : ''}</div>`).join('') : '<p class="text-muted">No AI operations on this host yet.</p>';
    el.querySelectorAll('[data-rollback]').forEach(b => b.addEventListener('click', async () => {
      const token = this._token, url = this._url(`jobs/${b.dataset.rollback}/rollback`);
      const job = jobs.find(j => j.id === b.dataset.rollback);
      if (!await Modal.confirm(`Restore previously running engines: ${job.stopped.map(s => s.name).join(', ') || 'none'}. The newly started engine will stop. Review current host activity before proceeding.`, { title: 'Recover interrupted operation', confirmText: 'Restore engines', danger: true })) return;
      if (token !== this._token) return;
      try { await Api.post(url, {}); await this._refresh(); } catch (err) { this._error(err); }
    }));
  },
  destroy() {
    clearInterval(this._timer);
    this._token = null;
    this._loading = false;
    this._activeJob = null;
    this._charts.forEach(chart => chart.destroy());
    this._charts = [];
  },
};
