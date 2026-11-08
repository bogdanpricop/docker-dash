'use strict';

class StackMetrics {
  static fields = ['cpu', 'ram', 'rx', 'tx', 'read', 'write'];
  static batchSize = 200;
  static intervalMs = 15_000;

  constructor(root, hostId, stacks, sort) {
    this.root = root;
    this.hostId = hostId;
    this.sort = sort;
    this.rows = [...root.querySelectorAll('[data-stack-row]')].map((row, index) => {
      const services = row.nextElementSibling;
      return {
        row,
        services: services?.classList.contains('stack-table-services') ? services : null,
        ids: [...new Set((stacks[index].containers || []).filter(container => container.state === 'running')
          .map(container => container.id))],
      };
    });
    this.readings = {};
    this.number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    this.staleAfterMs = 30_000;
    this.visibilityChanged = () => { if (!document.hidden) void this.refresh(); };
    document.addEventListener('visibilitychange', this.visibilityChanged);
    this.timer = setInterval(() => { if (!document.hidden) void this.refresh(); }, StackMetrics.intervalMs);
    void this.refresh();
  }

  destroy() {
    this.request?.abort();
    clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
  }

  async refresh() {
    const ids = [...new Set(this.rows.flatMap(row => row.ids))];
    if (!ids.length || !this.root.isConnected) return;
    const expanded = new Set(this.rows.filter(row => row.services && !row.services.hidden).flatMap(row => row.ids));
    this.request?.abort();
    const request = this.request = new AbortController();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
    const current = () => !request.signal.aborted && this.root.isConnected;
    try {
      const results = [];
      for (let index = 0; index < ids.length; index += StackMetrics.batchSize) {
        const batch = ids.slice(index, index + StackMetrics.batchSize);
        const result = await Api.request('POST', `/stats/stack-metrics?hostId=${this.hostId}`, {
          ids: batch, historyIds: batch.filter(id => expanded.has(id)),
        }, { signal });
        if (!current()) return;
        if (result.hostId !== this.hostId) throw new Error('Metrics host changed');
        results.push(result);
      }
      this.readings = Object.assign({}, ...results.map(result => result.containers));
      this.staleAfterMs = results[0].staleAfterMs;
      this.unavailable = false;
    } catch {
      if (!current()) return;
      this.unavailable = true;
    }
    this.paint();
  }

  paint() {
    for (const entry of this.rows) {
      const { row, services, ids } = entry;
      const readings = ids.map(id => this.readings[id]).filter(Boolean);
      const fresh = this.unavailable ? [] : readings.filter(reading => reading.fresh);
      const totals = {};
      for (const field of StackMetrics.fields) {
        const values = fresh.map(reading => reading.latest[field]);
        totals[field] = values.length && values.length === ids.length && values.every(Number.isFinite)
          ? values.reduce((sum, value) => sum + value, 0) : null;
      }
      entry.totals = totals;
      const cells = row.querySelectorAll('[data-stack-metric]');
      const updated = readings.length ? Math.min(...readings.map(reading => reading.latest.at)) : null;
      const quality = this.unavailable && ids.length ? 'unavailable'
        : fresh.length < ids.length ? (readings.length ? 'incomplete' : 'noSample') : null;
      this.renderValues(cells, totals, updated, quality);
      if (!services || services.hidden) continue;
      services.querySelectorAll('[data-stack-service-metrics]').forEach(el => {
        this.renderService(el, this.readings[el.dataset.stackServiceMetrics]);
      });
    }
    this.sortRows();
  }

  setSort(sort) {
    this.sort = sort;
    this.sortRows();
  }

  sortRows() {
    if (!this.rows.length) return;
    const { field, direction } = this.sort || {};
    const order = field ? [...this.rows].sort((a, b) => {
      const first = a.totals?.[field];
      const second = b.totals?.[field];
      if (!Number.isFinite(first)) return Number.isFinite(second) ? 1 : 0;
      if (!Number.isFinite(second)) return -1;
      return direction === 'ascending' ? first - second : second - first;
    }) : this.rows;
    const body = this.rows[0].row.parentNode;
    const focused = document.activeElement;
    let cursor = body.firstElementChild;
    for (const { row, services } of order) {
      for (const node of services ? [row, services] : [row]) {
        if (node === cursor) cursor = cursor.nextElementSibling;
        else body.insertBefore(node, cursor);
      }
    }
    if (focused !== document.activeElement && this.root.contains(focused)) focused.focus({ preventScroll: true });
  }

  renderValues(cells, values, updated, quality) {
    for (const cell of cells) {
      switch (cell.dataset.stackMetric) {
        case 'cpu': cell.textContent = this.format(values.cpu, 'cpu'); break;
        case 'ram': cell.textContent = this.format(values.ram, 'ram'); break;
        case 'network': cell.textContent = this.pair(values.rx, values.tx, 'rx', 'tx'); break;
        case 'disk': cell.textContent = this.pair(values.read, values.write, 'read', 'write'); break;
        case 'updated': cell.innerHTML = this.timestamp(updated, quality); break;
      }
    }
  }

  renderService(el, reading) {
    const t = key => i18n.t('pages.stacks.metrics.' + key);
    const available = !this.unavailable && reading?.fresh;
    const latest = available ? reading.latest : {};
    const metrics = [
      ['cpu', this.format(latest.cpu, 'cpu'), point => point.cpu],
      ['ram', this.format(latest.ram, 'ram'), point => point.ram],
      ['network', this.pair(latest.rx, latest.tx, 'rx', 'tx'), point => this.totalRate(point.rx, point.tx)],
      ['disk', this.pair(latest.read, latest.write, 'read', 'write'), point => this.totalRate(point.read, point.write)],
    ];
    el.innerHTML = `<div class="stack-service-charts">${metrics.map(([key, value, read]) => `
      <div class="stack-service-chart" data-metric-series="${key}">
        <strong>${t(key)}</strong><span>${Utils.escapeHtml(value)}</span>
        ${available ? this.sparkline(reading.history || [], read, t(key)) : ''}
      </div>`).join('')}</div>
      <div class="text-muted text-sm">${t('updated')} ${this.timestamp(reading?.latest?.at,
        this.unavailable ? 'unavailable' : reading ? (reading.fresh ? null : 'incomplete') : 'noSample')}</div>`;
  }

  totalRate(a, b) {
    return Number.isFinite(a) && Number.isFinite(b) ? a + b : null;
  }

  sparkline(history, read, label) {
    const values = history.map(point => read(point));
    if (values.filter(Number.isFinite).length < 2) return '';
    const max = Math.max(1, ...values.filter(Number.isFinite));
    const first = history[0].at;
    const span = history.at(-1).at - first;
    if (span <= 0) return '';
    let previous = null;
    const path = values.map((value, index) => {
      const at = history[index].at;
      const contiguous = previous !== null && at - previous <= this.staleAfterMs;
      previous = Number.isFinite(value) ? at : null;
      if (previous === null) return '';
      return `${contiguous ? 'L' : 'M'}${((at - first) / span * 98 + 1).toFixed(1)} ${(23 - value / max * 22).toFixed(1)}`;
    }).join(' ');
    return `<svg viewBox="0 0 100 24" preserveAspectRatio="none" role="img"
      aria-label="${Utils.escapeHtml(i18n.t('pages.stacks.metrics.history', { metric: label }))}">
      <path d="${path}" vector-effect="non-scaling-stroke"></path></svg>`;
  }

  timestamp(at, quality) {
    const text = quality ? i18n.t('pages.stacks.metrics.' + quality) : '';
    const time = Number.isFinite(at) ? new Date(at) : null;
    return `${time ? `<time datetime="${time.toISOString()}" title="${Utils.escapeHtml(time.toLocaleString())}">${Utils.escapeHtml(time.toLocaleTimeString())}</time>` : '—'}
      ${text ? `<span class="text-muted stack-metrics-quality">${Utils.escapeHtml(text)}</span>` : ''}`;
  }

  pair(a, b, first, second) {
    const t = key => i18n.t('pages.stacks.metrics.' + key);
    return Number.isFinite(a) || Number.isFinite(b)
      ? `${t(first)} ${this.format(a)} · ${t(second)} ${this.format(b)}` : '—';
  }

  format(value, kind) {
    if (!Number.isFinite(value)) return '—';
    if (kind === 'cpu') return this.number.format(value) + '%';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const unit = Math.max(0, Math.min(units.length - 1, Math.floor(Math.log2(value) / 10)));
    return this.number.format(value / 1024 ** unit) + ' ' + units[unit] + (kind === 'ram' ? '' : '/s');
  }
}
