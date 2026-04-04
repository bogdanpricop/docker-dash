'use strict';

const SwarmPage = {
  _tab: 'overview',
  _refreshTimer: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title"><i class="fas fa-project-diagram" style="color:var(--accent);margin-right:10px"></i>Docker Swarm</h1>
        </div>
        <div class="page-actions">
          <button class="btn btn-sm btn-secondary" id="swarm-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div class="tabs">
        <button class="tab active" data-tab="overview">Overview</button>
        <button class="tab" data-tab="nodes"><i class="fas fa-server" style="margin-right:4px"></i>Nodes</button>
        <button class="tab" data-tab="services"><i class="fas fa-cubes" style="margin-right:4px"></i>Services</button>
        <button class="tab" data-tab="tasks"><i class="fas fa-tasks" style="margin-right:4px"></i>Tasks</button>
      </div>
      <div id="swarm-content">Loading...</div>
    `;

    container.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        container.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        this._tab = t.dataset.tab;
        this._renderTab();
      });
    });

    container.querySelector('#swarm-refresh').addEventListener('click', () => this._renderTab());
    await this._renderTab();
  },

  async _renderTab() {
    const el = document.getElementById('swarm-content');
    if (!el) return;
    try {
      if (this._tab === 'overview') await this._renderOverview(el);
      else if (this._tab === 'nodes')    await this._renderNodes(el);
      else if (this._tab === 'services') await this._renderServices(el);
      else if (this._tab === 'tasks')    await this._renderTasks(el);
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  // ── Overview ────────────────────────────────────────────────

  async _renderOverview(el) {
    const status = await Api.getSwarmStatus();

    if (!status.active) {
      el.innerHTML = `
        <div class="card" style="max-width:520px;margin:40px auto">
          <div class="card-header">
            <h3><i class="fas fa-project-diagram" style="margin-right:8px;color:var(--accent)"></i>Swarm not initialized</h3>
          </div>
          <div class="card-body">
            <p class="text-sm text-muted" style="margin-bottom:16px">
              This Docker host is not part of a Swarm. Initialize a new Swarm to enable multi-node orchestration, services, and rolling updates.
            </p>
            <div class="form-group">
              <label>Advertise Address <span class="text-muted" style="font-weight:400">(optional)</span></label>
              <input id="swarm-advertise" class="form-control" placeholder="e.g. 192.168.1.100">
              <small class="text-muted">The IP that other nodes use to reach this manager. Auto-detected if blank.</small>
            </div>
            <button class="btn btn-primary" id="swarm-init-btn"><i class="fas fa-play" style="margin-right:6px"></i>Initialize Swarm</button>
          </div>
        </div>
      `;

      el.insertAdjacentHTML('beforeend', this._learnCards());

      el.querySelector('#swarm-init-btn').addEventListener('click', async () => {
        const advertiseAddr = el.querySelector('#swarm-advertise').value.trim() || undefined;
        const btn = el.querySelector('#swarm-init-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Initializing...';
        try {
          await Api.swarmInit({ advertiseAddr });
          Toast.success('Swarm initialized successfully');
          this._tab = 'nodes';
          document.querySelector('[data-tab="nodes"]')?.classList.add('active');
          document.querySelector('[data-tab="overview"]')?.classList.remove('active');
          await this._renderTab();
        } catch (err) {
          Toast.error(err.message);
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-play" style="margin-right:6px"></i>Initialize Swarm';
        }
      });
      return;
    }

    // Swarm is active — show summary
    const swarm = status.swarm;
    const info = status.info;
    const [nodes, services] = await Promise.all([
      Api.getSwarmNodes().catch(() => []),
      Api.getSwarmServices().catch(() => []),
    ]);

    const managers = nodes.filter(n => n.Spec?.Role === 'manager');
    const workers  = nodes.filter(n => n.Spec?.Role === 'worker');
    const healthy  = nodes.filter(n => n.Status?.State === 'ready');
    const runningServices = services.filter(s => (s.ServiceStatus?.RunningTasks || 0) > 0);

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px">
        ${this._statCard('fas fa-project-diagram', 'Swarm ID', swarm.ID?.slice(0,12) + '…', 'var(--accent)')}
        ${this._statCard('fas fa-server', 'Nodes', nodes.length, 'var(--accent)')}
        ${this._statCard('fas fa-crown', 'Managers', managers.length, 'var(--yellow)')}
        ${this._statCard('fas fa-check-circle', 'Healthy', healthy.length + ' / ' + nodes.length, healthy.length === nodes.length ? 'var(--green)' : 'var(--red)')}
        ${this._statCard('fas fa-cubes', 'Services', services.length, 'var(--accent)')}
        ${this._statCard('fas fa-play-circle', 'Running', runningServices.length, 'var(--green)')}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <!-- Swarm details -->
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-info-circle" style="margin-right:8px"></i>Swarm Details</h3></div>
          <div class="card-body">
            <table class="info-table">
              <tr><td>Swarm ID</td><td class="mono text-sm">${Utils.escapeHtml(swarm.ID || '—')}</td></tr>
              <tr><td>Created</td><td>${swarm.CreatedAt ? new Date(swarm.CreatedAt).toLocaleString() : '—'}</td></tr>
              <tr><td>Updated</td><td>${swarm.UpdatedAt ? new Date(swarm.UpdatedAt).toLocaleString() : '—'}</td></tr>
              <tr><td>This node role</td><td><span class="badge ${info.ControlAvailable ? 'badge-info' : ''}">${info.ControlAvailable ? 'Manager' : 'Worker'}</span></td></tr>
              <tr><td>Node ID</td><td class="mono text-sm">${Utils.escapeHtml(info.NodeID || '—')}</td></tr>
            </table>
          </div>
        </div>

        <!-- Join tokens -->
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-key" style="margin-right:8px"></i>Join Tokens</h3>
            <button class="btn btn-sm btn-secondary" id="show-tokens-btn"><i class="fas fa-eye" style="margin-right:4px"></i>Show</button>
          </div>
          <div class="card-body">
            <div id="tokens-area">
              <p class="text-sm text-muted">Click Show to reveal join tokens. Keep these secret — anyone with a token can join the swarm.</p>
            </div>
            <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
              <button class="btn btn-sm btn-danger" id="swarm-leave-btn"><i class="fas fa-sign-out-alt" style="margin-right:4px"></i>Leave Swarm</button>
            </div>
          </div>
        </div>
      </div>
      ${this._learnCards()}
    `;

    el.querySelector('#show-tokens-btn').addEventListener('click', async () => {
      const area = el.querySelector('#tokens-area');
      area.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      try {
        const tokens = await Api.getSwarmJoinToken();
        area.innerHTML = `
          <div class="form-group">
            <label style="font-size:11px">Worker token</label>
            <div style="display:flex;gap:6px">
              <input class="form-control" style="font-size:11px;font-family:var(--mono)" value="${Utils.escapeHtml(tokens.worker || '')}" readonly>
              <button class="btn btn-sm btn-secondary" onclick="Utils.copyToClipboard('${Utils.escapeHtml(tokens.worker || '')}').then(()=>Toast.success('Copied'))"><i class="fas fa-copy"></i></button>
            </div>
          </div>
          <div class="form-group">
            <label style="font-size:11px">Manager token</label>
            <div style="display:flex;gap:6px">
              <input class="form-control" style="font-size:11px;font-family:var(--mono)" value="${Utils.escapeHtml(tokens.manager || '')}" readonly>
              <button class="btn btn-sm btn-secondary" onclick="Utils.copyToClipboard('${Utils.escapeHtml(tokens.manager || '')}').then(()=>Toast.success('Copied'))"><i class="fas fa-copy"></i></button>
            </div>
          </div>
        `;
      } catch (err) { area.innerHTML = `<span class="text-muted text-sm">${Utils.escapeHtml(err.message)}</span>`; }
    });

    el.querySelector('#swarm-leave-btn').addEventListener('click', async () => {
      const ok = await Modal.confirm('Leave the Swarm? This node will no longer be a manager. All running services on this node will be stopped.', { danger: true });
      if (!ok) return;
      try {
        await Api.swarmLeave(true);
        Toast.success('Left the Swarm');
        await this._renderTab();
      } catch (err) { Toast.error(err.message); }
    });
  },

  _learnCards() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:24px">

        <!-- Official docs card -->
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-book-open" style="margin-right:8px;color:var(--accent)"></i>Official Documentation</h3>
          </div>
          <div class="card-body">
            <p class="text-sm text-muted" style="margin-bottom:14px">
              Complete Docker Swarm reference — architecture, tutorials, networking, secrets management and CLI reference.
            </p>
            <div style="display:flex;flex-direction:column;gap:8px">
              <a href="https://docs.docker.com/engine/swarm/" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="justify-content:flex-start;gap:8px">
                <i class="fas fa-external-link-alt"></i> Docker Swarm overview
              </a>
              <a href="https://docs.docker.com/engine/swarm/swarm-tutorial/" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="justify-content:flex-start;gap:8px">
                <i class="fas fa-graduation-cap"></i> Getting started tutorial
              </a>
              <a href="https://docs.docker.com/engine/swarm/services/" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="justify-content:flex-start;gap:8px">
                <i class="fas fa-cubes"></i> Deploy services to a swarm
              </a>
              <a href="https://docs.docker.com/engine/swarm/networking/" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="justify-content:flex-start;gap:8px">
                <i class="fas fa-network-wired"></i> Overlay networking
              </a>
              <a href="https://docs.docker.com/engine/swarm/secrets/" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="justify-content:flex-start;gap:8px">
                <i class="fas fa-key"></i> Manage secrets
              </a>
            </div>
          </div>
        </div>

        <!-- Beginner guide card -->
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-lightbulb" style="margin-right:8px;color:var(--yellow)"></i>What is Docker Swarm?</h3>
          </div>
          <div class="card-body text-sm" style="display:flex;flex-direction:column;gap:14px">

            <p class="text-muted" style="margin:0">
              Docker Swarm turns a group of Docker hosts into a single virtual cluster. You describe <em>what</em> you want to run and Swarm figures out <em>where</em> to run it, restarts containers that crash, and spreads load across machines.
            </p>

            <div>
              <div style="font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px">
                <i class="fas fa-server" style="color:var(--accent);width:16px"></i>Nodes
              </div>
              <p class="text-muted" style="margin:0">
                A <strong>node</strong> is a Docker host (physical or virtual machine) that participates in the swarm.
                <br>• <strong>Manager nodes</strong> — orchestrate the cluster, accept commands, maintain desired state. At least 1 required; 3 or 5 for HA.
                <br>• <strong>Worker nodes</strong> — only run containers assigned by managers.
              </p>
            </div>

            <div>
              <div style="font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px">
                <i class="fas fa-cubes" style="color:var(--accent);width:16px"></i>Services
              </div>
              <p class="text-muted" style="margin:0">
                A <strong>service</strong> is the definition of what to run — image, replicas, ports, environment. Think of it as a blueprint.
                <br>• <strong>Replicated mode</strong> — run exactly N copies spread across nodes (most common).
                <br>• <strong>Global mode</strong> — run exactly 1 copy on <em>every</em> node (good for agents/monitoring).
              </p>
            </div>

            <div>
              <div style="font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px">
                <i class="fas fa-tasks" style="color:var(--accent);width:16px"></i>Tasks
              </div>
              <p class="text-muted" style="margin:0">
                A <strong>task</strong> is one instance of a service running on a specific node — essentially a single container plus its metadata. Swarm recreates failed tasks automatically.
              </p>
            </div>

            <div>
              <div style="font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px">
                <i class="fas fa-network-wired" style="color:var(--accent);width:16px"></i>Overlay Networks &amp; Ingress
              </div>
              <p class="text-muted" style="margin:0">
                Services on different nodes communicate over an <strong>overlay network</strong> — a private virtual network spanning the whole cluster.
                The built-in <strong>ingress</strong> load-balancer routes external traffic to any running replica, no matter which node it's on.
              </p>
            </div>

            <div style="background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.2);border-radius:6px;padding:10px 12px">
              <div style="font-weight:600;margin-bottom:4px"><i class="fas fa-terminal" style="margin-right:6px"></i>Quick example</div>
              <code style="font-size:11px;color:var(--text-dim);white-space:pre-wrap">docker service create \\
  --name web \\
  --replicas 3 \\
  --publish 80:80 \\
  nginx:latest</code>
              <p class="text-muted" style="margin:6px 0 0;font-size:11px">Starts 3 nginx containers spread across the swarm, load-balanced on port 80.</p>
            </div>

          </div>
        </div>

      </div>
    `;
  },

  _statCard(icon, label, value, color) {
    return `
      <div class="card" style="text-align:center;padding:16px">
        <i class="${icon}" style="font-size:22px;color:${color};margin-bottom:8px;display:block"></i>
        <div style="font-size:22px;font-weight:700">${value}</div>
        <div class="text-muted" style="font-size:11px;margin-top:4px">${label}</div>
      </div>`;
  },

  // ── Nodes ────────────────────────────────────────────────────

  async _renderNodes(el) {
    const status = await Api.getSwarmStatus();
    if (!status.active) { el.innerHTML = '<div class="empty-msg">Swarm is not active on this host.</div>'; return; }

    const nodes = await Api.getSwarmNodes();

    const stateColor = s => s === 'ready' ? 'var(--green)' : 'var(--red)';
    const availBadge = a => ({
      active: '<span class="badge" style="background:rgba(74,222,128,.15);color:var(--green)">active</span>',
      pause:  '<span class="badge" style="background:rgba(234,179,8,.15);color:var(--yellow)">pause</span>',
      drain:  '<span class="badge" style="background:rgba(239,68,68,.15);color:var(--red)">drain</span>',
    }[a?.toLowerCase()] || `<span class="badge">${a || '—'}</span>`);

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-server" style="margin-right:8px"></i>Nodes <span class="badge badge-info" style="margin-left:6px">${nodes.length}</span></h3>
        </div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead>
              <tr>
                <th>Hostname</th><th>Role</th><th>State</th><th>Availability</th>
                <th>Engine</th><th>IP</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${nodes.map(n => `
                <tr>
                  <td>
                    <strong>${Utils.escapeHtml(n.Description?.Hostname || n.ID?.slice(0,12))}</strong>
                    ${n.ManagerStatus?.Leader ? '<span class="badge badge-info" style="margin-left:4px;font-size:9px">LEADER</span>' : ''}
                  </td>
                  <td><span class="badge ${n.Spec?.Role === 'manager' ? 'badge-info' : ''}">${n.Spec?.Role || '—'}</span></td>
                  <td><i class="fas fa-circle" style="font-size:8px;margin-right:4px;color:${stateColor(n.Status?.State)}"></i>${n.Status?.State || '—'}</td>
                  <td>${availBadge(n.Spec?.Availability)}</td>
                  <td class="text-sm text-muted">${n.Description?.Engine?.EngineVersion || '—'}</td>
                  <td class="mono text-sm">${Utils.escapeHtml(n.Status?.Addr || '—')}</td>
                  <td>
                    <div class="action-btns">
                      <button class="action-btn" data-action="node-active" data-id="${n.ID}" title="Set Active"><i class="fas fa-play"></i></button>
                      <button class="action-btn" data-action="node-drain" data-id="${n.ID}" title="Drain"><i class="fas fa-hand-paper"></i></button>
                      <button class="action-btn danger" data-action="node-remove" data-id="${n.ID}" title="Remove"><i class="fas fa-trash"></i></button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    el.addEventListener('click', async e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      try {
        if (action === 'node-active') {
          await Api.updateSwarmNode(id, { availability: 'active' });
          Toast.success('Node set to active');
          await this._renderNodes(el);
        } else if (action === 'node-drain') {
          await Api.updateSwarmNode(id, { availability: 'drain' });
          Toast.success('Node draining');
          await this._renderNodes(el);
        } else if (action === 'node-remove') {
          const ok = await Modal.confirm('Remove this node from the Swarm? The node must be drained first.', { danger: true });
          if (!ok) return;
          await Api.removeSwarmNode(id, false);
          Toast.success('Node removed');
          await this._renderNodes(el);
        }
      } catch (err) { Toast.error(err.message); }
    });
  },

  // ── Services ─────────────────────────────────────────────────

  async _renderServices(el) {
    const status = await Api.getSwarmStatus();
    if (!status.active) { el.innerHTML = '<div class="empty-msg">Swarm is not active on this host.</div>'; return; }

    const services = await Api.getSwarmServices();

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-cubes" style="margin-right:8px"></i>Services <span class="badge badge-info" style="margin-left:6px">${services.length}</span></h3>
          <button class="btn btn-sm btn-primary" id="create-service-btn"><i class="fas fa-plus"></i> Create Service</button>
        </div>
        <div class="card-body" style="padding:0">
          ${services.length === 0
            ? '<div class="empty-msg">No services. Create one to start deploying.</div>'
            : `<table class="data-table">
              <thead>
                <tr><th>Name</th><th>Image</th><th>Mode</th><th>Replicas</th><th>Ports</th><th></th></tr>
              </thead>
              <tbody>
                ${services.map(s => {
                  const running = s.ServiceStatus?.RunningTasks ?? '?';
                  const desired = s.ServiceStatus?.DesiredTasks ?? '?';
                  const healthy = running === desired;
                  const image = s.Spec?.TaskTemplate?.ContainerSpec?.Image || '—';
                  const imageShort = image.split('@')[0];
                  const ports = (s.Endpoint?.Ports || []).map(p => `${p.PublishedPort}→${p.TargetPort}`).join(', ');
                  const mode = s.Spec?.Mode?.Replicated ? 'replicated' : s.Spec?.Mode?.Global ? 'global' : '—';
                  return `
                    <tr>
                      <td><strong>${Utils.escapeHtml(s.Spec?.Name || s.ID?.slice(0,12))}</strong></td>
                      <td class="mono text-sm" style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${Utils.escapeHtml(image)}">${Utils.escapeHtml(imageShort)}</td>
                      <td><span class="badge">${mode}</span></td>
                      <td>
                        <span style="color:${healthy ? 'var(--green)' : 'var(--yellow)'}">
                          <i class="fas fa-circle" style="font-size:8px;margin-right:4px"></i>${running} / ${desired}
                        </span>
                      </td>
                      <td class="mono text-sm">${Utils.escapeHtml(ports || '—')}</td>
                      <td>
                        <div class="action-btns">
                          <button class="action-btn" data-action="svc-scale" data-id="${s.ID}" data-name="${Utils.escapeHtml(s.Spec?.Name)}" data-replicas="${desired}" title="Scale"><i class="fas fa-arrows-alt-v"></i></button>
                          <button class="action-btn" data-action="svc-tasks" data-id="${s.ID}" data-name="${Utils.escapeHtml(s.Spec?.Name)}" title="Tasks"><i class="fas fa-tasks"></i></button>
                          <button class="action-btn danger" data-action="svc-remove" data-id="${s.ID}" data-name="${Utils.escapeHtml(s.Spec?.Name)}" title="Remove"><i class="fas fa-trash"></i></button>
                        </div>
                      </td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>`
          }
        </div>
      </div>
    `;

    el.querySelector('#create-service-btn').addEventListener('click', () => this._createServiceDialog(el));

    el.addEventListener('click', async e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      const name = btn.dataset.name;

      if (btn.dataset.action === 'svc-scale') {
        const current = parseInt(btn.dataset.replicas) || 1;
        const result = await Modal.form(`
          <div class="form-group">
            <label>Replicas for <strong>${Utils.escapeHtml(name)}</strong></label>
            <input type="number" id="scale-n" class="form-control" value="${current}" min="0" max="100">
          </div>
        `, {
          title: 'Scale Service',
          width: '340px',
          onSubmit: c => parseInt(c.querySelector('#scale-n').value),
        });
        if (result === false || result === null || result === undefined) return;
        try {
          await Api.scaleSwarmService(id, result);
          Toast.success(`${name} scaled to ${result} replica${result !== 1 ? 's' : ''}`);
          await this._renderServices(el);
        } catch (err) { Toast.error(err.message); }

      } else if (btn.dataset.action === 'svc-tasks') {
        this._tab = 'tasks';
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelector('[data-tab="tasks"]')?.classList.add('active');
        const tasksEl = document.getElementById('swarm-content');
        await this._renderTasks(tasksEl, id, name);

      } else if (btn.dataset.action === 'svc-remove') {
        const ok = await Modal.confirm(`Remove service "${name}"? All its containers will be stopped.`, { danger: true });
        if (!ok) return;
        try {
          await Api.removeSwarmService(id);
          Toast.success(`Service "${name}" removed`);
          await this._renderServices(el);
        } catch (err) { Toast.error(err.message); }
      }
    });
  },

  async _createServiceDialog(el) {
    const result = await Modal.form(`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group" style="grid-column:1/-1">
          <label>Service Name <span class="text-red">*</span></label>
          <input type="text" id="svc-name" class="form-control" placeholder="my-service">
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label>Image <span class="text-red">*</span></label>
          <input type="text" id="svc-image" class="form-control" placeholder="nginx:latest">
        </div>
        <div class="form-group">
          <label>Replicas</label>
          <input type="number" id="svc-replicas" class="form-control" value="1" min="1" max="100">
        </div>
        <div class="form-group">
          <label>Published Port → Container Port</label>
          <input type="text" id="svc-ports" class="form-control" placeholder="8080:80">
          <small class="text-muted">One port mapping (published:target)</small>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label>Environment Variables</label>
          <textarea id="svc-env" class="form-control" rows="3" placeholder="KEY=value&#10;ANOTHER=value"></textarea>
        </div>
      </div>
    `, {
      title: 'Create Swarm Service',
      width: '520px',
      onSubmit: c => {
        const name  = c.querySelector('#svc-name').value.trim();
        const image = c.querySelector('#svc-image').value.trim();
        if (!name || !image) { Toast.warning('Name and image are required'); return false; }
        const portsRaw = c.querySelector('#svc-ports').value.trim();
        const ports = portsRaw ? [{ published: portsRaw.split(':')[0], target: portsRaw.split(':')[1] || portsRaw.split(':')[0] }] : [];
        const env = c.querySelector('#svc-env').value.trim().split('\n').filter(Boolean);
        return { name, image, replicas: parseInt(c.querySelector('#svc-replicas').value) || 1, ports, env };
      },
    });

    if (!result) return;
    try {
      await Api.createSwarmService(result);
      Toast.success(`Service "${result.name}" created`);
      await this._renderServices(el);
    } catch (err) { Toast.error(err.message); }
  },

  // ── Tasks ────────────────────────────────────────────────────

  async _renderTasks(el, serviceId, serviceName) {
    const status = await Api.getSwarmStatus();
    if (!status.active) { el.innerHTML = '<div class="empty-msg">Swarm is not active on this host.</div>'; return; }

    const tasks = await Api.getSwarmTasks(serviceId);
    // Sort: running first, then by UpdatedAt desc
    tasks.sort((a, b) => {
      const stateOrder = { running: 0, starting: 1, ready: 2, assigned: 3, pending: 4, complete: 5, failed: 6, rejected: 7, shutdown: 8 };
      const sa = stateOrder[a.Status?.State] ?? 9;
      const sb = stateOrder[b.Status?.State] ?? 9;
      if (sa !== sb) return sa - sb;
      return new Date(b.Status?.Timestamp || 0) - new Date(a.Status?.Timestamp || 0);
    });

    const stateColor = s => ({ running: 'var(--green)', starting: 'var(--yellow)', ready: 'var(--yellow)', failed: 'var(--red)', rejected: 'var(--red)', shutdown: 'var(--text-dim)', complete: 'var(--text-dim)' }[s] || 'var(--text-dim)');

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-tasks" style="margin-right:8px"></i>Tasks${serviceName ? ` — ${Utils.escapeHtml(serviceName)}` : ''} <span class="badge badge-info" style="margin-left:6px">${tasks.length}</span></h3>
          ${serviceId ? `<button class="btn btn-sm btn-secondary" id="tasks-back"><i class="fas fa-arrow-left" style="margin-right:4px"></i>All Services</button>` : ''}
        </div>
        <div class="card-body" style="padding:0">
          ${tasks.length === 0
            ? '<div class="empty-msg">No tasks found.</div>'
            : `<table class="data-table">
              <thead><tr><th>ID</th><th>Service</th><th>Node</th><th>State</th><th>Error</th><th>Updated</th></tr></thead>
              <tbody>
                ${tasks.map(t => `
                  <tr>
                    <td class="mono text-sm">${Utils.escapeHtml((t.ID || '').slice(0, 12))}</td>
                    <td class="text-sm">${Utils.escapeHtml(t.ServiceID?.slice(0, 12) || '—')}</td>
                    <td class="text-sm">${Utils.escapeHtml(t.NodeID?.slice(0, 12) || '—')}</td>
                    <td>
                      <span style="color:${stateColor(t.Status?.State)}">
                        <i class="fas fa-circle" style="font-size:8px;margin-right:4px"></i>${t.Status?.State || '—'}
                      </span>
                    </td>
                    <td class="text-sm" style="color:var(--red);max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${Utils.escapeHtml(t.Status?.Err || '')}">
                      ${Utils.escapeHtml(t.Status?.Err || '—')}
                    </td>
                    <td class="text-sm text-muted">${t.Status?.Timestamp ? Utils.timeAgo(t.Status.Timestamp) : '—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>`
          }
        </div>
      </div>
    `;

    el.querySelector('#tasks-back')?.addEventListener('click', () => this._renderServices(el));
  },

  destroy() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
  },
};

window.SwarmPage = SwarmPage;
