'use strict';

class ContainerInspector {
  static nextRequest = 0;
  static tail = 250;
  static bufferSize = 1000;

  static label(key, values) {
    return i18n.t('pages.containers.inspector.' + key, values);
  }

  static rowAction(tab, icon, name) {
    const title = Utils.escapeHtml(this.label(tab) + ' · ' + name);
    return `<button type="button" class="action-btn" data-container-inspect="${tab}" title="${title}"
      aria-label="${title}" aria-controls="container-inspector" aria-pressed="false"><i class="fas ${icon}" aria-hidden="true"></i></button>`;
  }

  static renderHost(element, { host, requestedHostId, status, checked, error }) {
    const name = host?.name || (requestedHostId ? this.label('hostNumber', { id: requestedHostId }) : this.label('defaultHost'));
    const connection = element.querySelector('[data-container-host-status]');
    element.querySelector('[data-container-host-name]').textContent = name;
    const transport = { socket: 'transportSocket', tcp: 'transportTcp', tls: 'transportTls', ssh: 'transportSsh', hawser: 'transportAgent' }[host?.connectionType];
    element.querySelector('[data-container-host-transport]').textContent = transport ? this.label(transport) : '';
    const message = status === 'stale' ? this.label('staleHost', { time: checked.toLocaleTimeString() }) : this.label(status);
    if (connection.textContent !== message) connection.textContent = message;
    connection.dataset.status = status;
    connection.title = error || '';
  }

  constructor(workspace, onChange) {
    this.workspace = workspace;
    this.panel = workspace.querySelector('#container-inspector');
    this.onChange = onChange;
    this.search = '';
    this.wrap = true;
    this.tabs = ['overview', 'logs', 'stats'];
    this.panel.innerHTML = `
      <header class="container-inspector-header">
        <div class="container-inspector-host">
          <i class="fas fa-server" aria-hidden="true"></i>
          <strong data-container-host-name></strong>
          <span data-container-host-transport></span>
          <span class="container-connection" data-container-host-status></span>
        </div>
        <div class="container-inspector-title-row">
          <div class="container-inspector-heading">
            <h3 id="container-inspector-title" tabindex="-1"></h3>
            <span data-inspector-state class="badge"></span>
          </div>
          <button class="btn-icon" type="button" data-inspector-close title="${this.label('close')}" aria-label="${this.label('close')}">
            <i class="fas fa-times" aria-hidden="true"></i>
          </button>
        </div>
        <div class="container-inspector-nav">
          <div role="tablist" aria-label="${this.label('view')}">
            ${this.tabs.map(tab => `<button class="btn btn-sm" type="button" role="tab" id="inspector-tab-${tab}" data-inspector-tab="${tab}"
              aria-controls="inspector-content">${this.label(tab)}</button>`).join('')}
          </div>
          <a class="btn btn-sm btn-secondary" data-inspector-full>
            <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i> ${this.label('details')}
          </a>
        </div>
      </header>
      <div id="inspector-content" class="container-inspector-content" role="tabpanel" tabindex="0"></div>`;
    this.content = this.panel.querySelector('#inspector-content');
    this.title = this.panel.querySelector('#container-inspector-title');
    this.buttons = [...this.panel.querySelectorAll('[data-inspector-tab]')];
    this.buttons.forEach(button => button.addEventListener('click', () => this.activate(button.dataset.inspectorTab)));
    this.panel.querySelector('[data-inspector-close]').addEventListener('click', () => this.close());
    this.panel.addEventListener('keydown', event => this.onKey(event));
    this.off = [
      WS.on('_connected', () => this.resetLogSource()),
      WS.on('_disconnected', () => this.resetLogSource()),
      ...['subscribed', 'data', 'error', 'end'].map(type => WS.on('logs:' + type, msg => this.onLogEvent(type, msg))),
    ];
  }

  label(key, values) {
    return ContainerInspector.label(key, values);
  }

  onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.close();
      return;
    }
    const index = this.buttons.indexOf(event.target);
    if (index < 0) return;
    const offset = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const target = offset ? (index + offset + this.tabs.length) % this.tabs.length
      : { Home: 0, End: this.tabs.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    this.activate(this.tabs[target]);
    this.buttons[target].focus();
  }

  sync(items, context) {
    this.context = context;
    if (!this.item) return;
    const current = items.find(item => item.id === this.item.id);
    if (!current) {
      this.close(false);
      return;
    }
    const runningChanged = (this.item.state === 'running') !== (current.state === 'running');
    this.item = current;
    this.updateHeader();
    if (runningChanged && this.tab === 'stats') this.activate('stats', true);
    if (runningChanged && this.tab === 'logs') this.resetLogSource();
  }

  updateHeader() {
    ContainerInspector.renderHost(this.panel, this.context);
    this.title.textContent = this.item.name || Utils.shortId(this.item.id);
    const badge = this.panel.querySelector('[data-inspector-state]');
    badge.className = 'badge ' + Utils.statusBadgeClass(this.item.state);
    badge.textContent = this.item.state;
    this.panel.querySelector('[data-inspector-full]').href = '#/containers/' + encodeURIComponent(this.item.id);
  }

  open(item, tab = this.tab || 'overview', origin) {
    const opening = !this.item;
    const changed = item.id !== this.item?.id;
    this.item = item;
    if (origin) this.originTab = origin.dataset.containerInspect;
    this.panel.hidden = false;
    this.workspace.classList.add('has-container-inspector');
    this.updateHeader();
    this.activate(tab, changed);
    if (opening || origin) this.title.focus({ preventScroll: true });
  }

  close(restoreFocus = true) {
    if (!this.item) return;
    const id = this.item.id;
    this.stopWork();
    this.item = null;
    this.tab = null;
    this.panel.hidden = true;
    this.content.replaceChildren();
    this.workspace.classList.remove('has-container-inspector');
    this.onChange();
    if (restoreFocus) {
      const row = [...this.workspace.querySelectorAll('tr[data-cid]')].find(el => el.dataset.cid === id);
      const button = [...row?.querySelectorAll('[data-container-inspect]') || []]
        .find(el => el.dataset.containerInspect === this.originTab);
      (button || row?.querySelector('[data-container-inspect]') || document.getElementById('container-search'))?.focus();
    }
    this.originTab = null;
  }

  destroy() {
    this.close(false);
    this.off.forEach(off => off());
  }

  activate(tab, force = false) {
    if (tab === this.tab && !force) return;
    this.stopWork();
    this.tab = tab;
    this.buttons.forEach(button => {
      const selected = button.dataset.inspectorTab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    this.content.setAttribute('aria-labelledby', 'inspector-tab-' + tab);
    this.content.scrollTop = 0;
    this.onChange();
    if (tab === 'logs') this.showLogs();
    else if (tab === 'stats') this.showStats();
    else this.showOverview();
  }

  stopWork() {
    this.request?.abort();
    this.request = null;
    clearTimeout(this.timer);
    cancelAnimationFrame(this.logFrame);
    this.logFrame = null;
    if (this.streamId) WS.send('logs:unsubscribe', { containerId: this.streamContainer });
    this.streamId = null;
  }

  async fetchResource(resource, params, signal) {
    const query = new URLSearchParams({ ...params, hostId: this.context.host.id });
    return Api.request('GET', `/containers/${encodeURIComponent(this.item.id)}/${resource}?${query}`, null, { signal });
  }

  startRequest() {
    this.request?.abort();
    this.request = new AbortController();
    return this.request.signal;
  }

  showOverview() {
    const signal = this.startRequest();
    this.content.textContent = this.label('loading');
    this.fetchResource('inspect', {}, signal).then(data => {
      if (signal.aborted) return;
      const ports = Object.keys(data.ports || {}).filter(port => data.ports[port]?.length);
      this.content.replaceChildren(this.metrics([
        ['image', data.image],
        ['created', data.created && new Date(data.created).toLocaleString()],
        ['restarts', data.restartCount],
        ['networks', Object.keys(data.networks || {}).join(', ') || '—'],
        ['ports', ports.join(', ') || '—'],
        ['mounts', data.mounts?.length],
      ]));
    }).catch(error => {
      if (!signal.aborted) this.content.textContent = this.label('requestFailed', { message: error.message });
    });
  }

  metrics(items) {
    const list = document.createElement('dl');
    list.className = 'container-inspector-metrics';
    items.forEach(([key, value]) => {
      const card = document.createElement('div');
      const label = document.createElement('dt');
      const number = document.createElement('dd');
      label.textContent = this.label(key);
      number.textContent = value ?? '—';
      card.append(label, number);
      list.appendChild(card);
    });
    return list;
  }

  showStats() {
    if (this.item.state !== 'running') {
      this.content.textContent = this.label('statsStopped');
      return;
    }
    this.content.innerHTML = '<p class="container-inspector-status" role="status"></p><div data-inspector-metrics></div>';
    this.status = this.content.firstElementChild;
    this.status.textContent = this.label('loading');
    const metrics = this.content.querySelector('[data-inspector-metrics]');
    const percent = value => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + '%' : '—';
    let sampled;
    const tick = async () => {
      const signal = this.startRequest();
      try {
        const data = await this.fetchResource('stats', {}, signal);
        if (signal.aborted) return;
        sampled = new Date().toLocaleTimeString();
        metrics.replaceChildren(this.metrics([
          ['cpu', percent(data.cpuPercent)],
          ['memory', `${Utils.formatBytes(data.memUsage)} / ${Utils.formatBytes(data.memLimit)} · ${percent(data.memPercent)}`],
          ['netRx', Utils.formatBytes(data.netRx)],
          ['netTx', Utils.formatBytes(data.netTx)],
          ['diskRead', Utils.formatBytes(data.blkRead)],
          ['diskWrite', Utils.formatBytes(data.blkWrite)],
          ['pids', data.pids],
        ]));
        this.status.textContent = this.label('sampled', { time: sampled });
      } catch (error) {
        if (signal.aborted) return;
        if ([401, 403, 404].includes(error.status)) {
          sampled = null;
          metrics.replaceChildren();
        }
        this.status.textContent = sampled
          ? this.label('statsStale', { time: sampled, message: error.message })
          : this.label('requestFailed', { message: error.message });
      }
      if (!signal.aborted) this.timer = setTimeout(tick, 4000);
    };
    tick();
  }

  showLogs() {
    this.lines = [];
    this.paused = false;
    this.follow = true;
    this.content.innerHTML = `
      <div class="container-log-tools">
        <input type="search" class="form-control" placeholder="${this.label('search')}" aria-label="${this.label('search')}">
        <label><input type="checkbox" data-log-wrap> ${this.label('wrap')}</label>
        <button type="button" class="btn btn-sm btn-secondary" data-log-pause></button>
        <button type="button" class="btn btn-sm btn-secondary" data-log-follow>${this.label('jumpLatest')}</button>
        <button type="button" class="btn btn-sm btn-secondary" data-log-retry title="${this.label('retry')}" aria-label="${this.label('retry')}"><i class="fas fa-rotate-right" aria-hidden="true"></i></button>
      </div>
      <p class="container-inspector-status" role="status"></p>
      <pre class="container-inspector-log" tabindex="0" aria-label="${this.label('logs')}"></pre>
      <p class="container-log-count text-muted"></p>`;
    this.output = this.content.querySelector('pre');
    this.count = this.content.querySelector('.container-log-count');
    this.status = this.content.querySelector('[role="status"]');
    this.status.textContent = this.label('loading');
    const search = this.content.querySelector('input[type="search"]');
    search.value = this.search;
    search.addEventListener('input', () => {
      this.search = search.value;
      this.paintLogs();
    });
    const wrap = this.content.querySelector('[data-log-wrap]');
    wrap.checked = this.wrap;
    wrap.addEventListener('change', () => {
      this.wrap = wrap.checked;
      this.paintLogs();
    });
    const pause = this.content.querySelector('[data-log-pause]');
    pause.textContent = this.label('pause');
    pause.addEventListener('click', () => {
      this.paused = !this.paused;
      pause.textContent = this.label(this.paused ? 'resume' : 'pause');
      if (this.paused) {
        this.stopWork();
        this.paintLogs();
        this.status.textContent = this.label('paused');
      } else {
        this.resetLogSource();
      }
    });
    this.content.querySelector('[data-log-retry]').addEventListener('click', () => this.resetLogSource());
    this.content.querySelector('[data-log-follow]').addEventListener('click', () => {
      this.follow = true;
      this.output.scrollTop = this.output.scrollHeight;
    });
    this.output.addEventListener('scroll', () => {
      this.follow = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 12;
    });
    this.paintLogs();
    this.resetLogSource();
  }

  resetLogSource() {
    if (this.tab !== 'logs' || this.paused) return;
    this.stopWork();
    this.paintLogs();
    if (!WS.isConnected || this.item.state !== 'running') {
      this.pollLogs();
      return;
    }
    this.streamId = 'inspect-' + ++ContainerInspector.nextRequest;
    this.streamContainer = this.item.id;
    this.status.textContent = this.label('connectingLogs');
    WS.send('logs:subscribe', {
      containerId: this.item.id, hostId: this.context.host.id,
      requestId: this.streamId, tail: ContainerInspector.tail,
    });
    this.timer = setTimeout(() => this.fallback(this.label('logTimeout')), 8000);
  }

  onLogEvent(type, msg) {
    const payload = msg?.data || msg;
    if (!this.streamId || payload?.requestId !== this.streamId || payload.containerId !== this.item.id) return;
    if (payload.hostId !== undefined && payload.hostId !== this.context.host.id) return;
    if (type === 'subscribed') {
      clearTimeout(this.timer);
      this.lines = [];
      this.status.textContent = this.label('live');
      this.paintLogs();
    } else if (type === 'data') {
      this.addLines(payload.lines);
    } else {
      this.fallback(payload.error || this.label('logEnded'));
    }
  }

  fallback(reason) {
    this.stopWork();
    this.pollLogs(reason);
  }

  async pollLogs(reason) {
    const signal = this.startRequest();
    try {
      const data = await this.fetchResource('logs', { tail: ContainerInspector.tail }, signal);
      if (signal.aborted) return;
      this.lines = [];
      this.addLines(data.lines);
      const key = reason ? 'snapshotReason' : (WS.isConnected ? 'snapshot' : 'snapshotOffline');
      this.status.textContent = this.label(key, { message: reason, time: new Date().toLocaleTimeString() });
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403, 404].includes(error.status)) {
        this.lines = [];
        this.paintLogs();
      }
      this.status.textContent = this.label('requestFailed', { message: error.message });
    }
    if (!signal.aborted) this.timer = setTimeout(() => this.pollLogs(reason), 6000);
  }

  addLines(lines) {
    for (const line of lines || []) {
      for (const text of String(line).replace(/\r?\n$/, '').split(/\r?\n/)) {
        this.lines.push(text.length > 4096 ? text.slice(0, 4096) + '…' : text);
      }
    }
    if (this.lines.length > ContainerInspector.bufferSize) {
      this.lines = this.lines.slice(-ContainerInspector.bufferSize);
    }
    if (!this.logFrame) this.logFrame = requestAnimationFrame(() => {
      this.logFrame = null;
      this.paintLogs();
    });
  }

  paintLogs() {
    const query = this.search.trim().toLowerCase();
    const shown = query ? this.lines.filter(line => line.toLowerCase().includes(query)) : this.lines;
    const scroll = this.output.scrollTop;
    this.output.classList.toggle('wrap', this.wrap);
    this.output.textContent = shown.length ? shown.join('\n') : this.label(this.lines.length ? 'noMatches' : 'noLogs');
    this.output.scrollTop = this.follow ? this.output.scrollHeight : scroll;
    this.count.textContent = this.label('lineCount', { shown: shown.length, total: this.lines.length });
  }
}
