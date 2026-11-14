'use strict';

const SecuritySchedules = {
  path: '/security-schedules',
  kinds: { images: 'Image vulnerabilities', cis: 'CIS Docker Benchmark' },
  states: { queued: 'Queued', running: 'Running', success: 'Completed', partial: 'Partial', error: 'Failed' },
  _runSorts: new Map(),

  summary(run) {
    const s = run?.summary;
    if (!s) return '—';
    if (run.kind === 'cis') return s.score + '% · ' + s.fail + ' failed checks · ' + s.warn + ' warnings · ' + s.checked + '/' + s.selected + ' containers checked';
    return s.total + ' findings · ' + s.fixable + ' with fixes · ' + s.scanned + '/' + s.selected + ' images scanned';
  },

  delivery(run) {
    const labels = { none: 'No channel', pending: 'Pending', sending: 'Sending', sent: 'Sent', error: 'Failed', unknown: 'Unknown' };
    return labels[run.deliveryStatus] || '—';
  },

  async render(el, requestedRun) {
    const { timeZone, schedules } = await Api.get(this.path);
    if (!el.isConnected || SecurityPage._tab !== 'schedules') return;
    const e = Utils.escapeHtml;
    const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone });
    const date = value => value ? formatter.format(new Date(value)) : '—';
    el.innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Scheduled security scans</h3>
          <div class="page-actions"><button class="btn btn-sm btn-secondary" data-scan-list-refresh>Refresh</button>
          <button class="btn btn-sm btn-primary" data-scan-add>Add schedule</button></div></div>
        <div class="card-body">
          <p class="text-muted text-sm">Scheduler timezone · ${e(timeZone)}</p>
          ${schedules.length ? `<div class="file-list-scroll"><table class="data-table compact" data-scan-schedules>
            <thead><tr>${[['name', 'Schedule'], ['host', 'Docker host'], ['next', 'Next run'], ['result', 'Last result'],
              ['channel', 'Report channel']].map(([key, label]) => TableSort.header(key, label)).join('')}<th>Actions</th></tr></thead>
            <tbody>${schedules.map(s => `<tr>
              <td><strong>${e(s.name)}</strong><div class="text-muted text-sm">${this.kinds[s.kind]} · <code>${e(s.cron)}</code></div></td>
              <td>${e(s.hostName || 'Removed host')}</td>
              <td>${s.enabled ? e(date(s.nextRunAt)) : 'Paused'}</td>
              <td>${s.lastRun ? `<strong>${e(this.states[s.lastRun.status])}</strong><div class="text-muted text-sm">${e(this.summary(s.lastRun))}</div>` : 'Never run'}</td>
              <td>${e(s.channelName || 'In-app only')}${s.channelName && s.reportFormat === 'detailed' ? '<div class="text-muted text-sm">Detailed attachment</div>' : ''}</td>
              <td>${[['run', 'Run now'], ['history', 'History'], ['edit', 'Edit'], ['delete', 'Delete']].map(([action, label]) =>
                `<button class="btn btn-xs btn-secondary" data-scan-action="${action}" data-id="${s.id}" ${action === 'run' && (!s.hostId || ['running','queued'].includes(s.lastRun?.status)) ? 'disabled' : ''}>${label}</button>`).join(' ')}
              </td></tr>`).join('')}</tbody></table></div>` : '<p class="text-muted">No security scans scheduled.</p>'}
        </div>
      </div>
      <div id="security-schedule-history"></div>`;
    const table = el.querySelector('[data-scan-schedules]');
    if (table) TableSort.bind(table, schedules.map(s => ({ name: s.name, host: s.hostName,
      next: s.enabled ? Date.parse(s.nextRunAt) : null, result: this.states[s.lastRun?.status], channel: s.channelName })),
    this._scheduleSort, sort => { this._scheduleSort = sort; });
    el.querySelector('[data-scan-list-refresh]').addEventListener('click', () => this.render(el).catch(error => Toast.error(error.message)));
    el.querySelector('[data-scan-add]').addEventListener('click', () => {
      this.edit(el, timeZone).catch(error => Toast.error(error.message));
    });
    el.querySelectorAll('[data-scan-action]').forEach(button => {
      button.addEventListener('click', async () => {
        const item = schedules.find(s => s.id === Number(button.dataset.id));
        const action = button.dataset.scanAction;
        button.disabled = true;
        try {
          if (action === 'edit') await this.edit(el, timeZone, item);
          if (action === 'history') await this.history(el, item, date);
          if (action === 'run') {
            await Api.post(this.path + '/' + item.id + '/run-now');
            Toast.success('Scan queued');
            await this.render(el);
          }
          if (action === 'delete' && await Modal.confirm('Delete this schedule and its run history?', { danger: true, confirmText: 'Delete' })) {
            await Api.delete(this.path + '/' + item.id);
            await this.render(el);
          }
        } catch (error) { Toast.error(error.message); }
        finally { button.disabled = false; }
      });
    });
    if (requestedRun) await this.report(requestedRun);
  },

  async edit(el, timeZone, schedule) {
    const [hosts, channels] = await Promise.all([Api.getHosts(), Api.getNotificationChannels()]);
    if (!el.isConnected || SecurityPage._tab !== 'schedules') return;
    const e = Utils.escapeHtml;
    const hostId = schedule?.hostId ?? (Api.getHostId() || hosts.find(host => host.isDefault)?.id);
    const eligibleChannels = channels.filter(channel => channel.is_active && channel.usage !== 'general');
    const options = (rows, selected) => rows.map(([id, label]) =>
      `<option value="${e(id)}" ${String(id) === String(selected) ? 'selected' : ''}>${e(label)}</option>`).join('');
    const select = (key, label, rows, selected, required = '') => `<div class="form-group"><label for="sec-scan-${key}">${label}</label>
      <select class="form-control" id="sec-scan-${key}" name="${key}" ${required}>${options(rows, selected)}</select></div>`;
    const frequencies = [['','Custom'],['0 * * * *','Hourly'],['0 2 * * *','Daily at 02:00'],['0 2 * * 1','Mondays at 02:00']];
    const cron = schedule?.cron || '0 2 * * 1';
    Modal.open(`<div class="modal-header"><h3>${schedule ? 'Edit schedule' : 'Schedule a security scan'}</h3>
      <button type="button" class="modal-close-btn" data-close-scan-modal>×</button></div>
      <form id="security-schedule-form">
        <div class="modal-body">
          <div class="form-group"><label for="sec-scan-name">Name</label>
            <input class="form-control" id="sec-scan-name" name="name" required maxlength="80" value="${e(schedule?.name || '')}"></div>
          ${select('host', 'Docker host', [['', 'Select host'], ...hosts.filter(h => h.isActive && ['docker','podman'].includes(h.daemonType || 'docker')).map(h => [h.id,h.name])], hostId, 'required')}
          ${select('kind', 'Scan', Object.entries(this.kinds), schedule?.kind || 'images')}
          <div id="sec-scan-image-options">
            ${select('scope', 'Images', [['running', 'Images used by running containers'], ['all', 'All installed images']], schedule?.imageScope || 'running')}
            ${select('scanner', 'Scanner', [['auto','Automatic'],['trivy','Trivy'],['grype','Grype']], schedule?.scanner || 'auto')}
          </div>
          ${select('frequency', 'Frequency', frequencies, frequencies.some(([value]) => value === cron) ? cron : '')}
          <div class="form-group"><label for="sec-scan-cron">Cron expression · ${e(timeZone)}</label>
            <input class="form-control mono" id="sec-scan-cron" name="cron" required maxlength="120" value="${e(cron)}">
            <button type="button" class="btn btn-xs btn-secondary" data-scan-preview>Preview next runs</button>
            <div id="sec-scan-preview" class="text-muted text-sm" role="status"></div></div>
          ${select('channel', 'Send report to', [['', 'In-app only'], ...eligibleChannels.map(c => [c.id,c.name])], schedule?.channelId)}
          ${schedule?.channelId && !eligibleChannels.some(c => c.id === schedule.channelId) ? '<p class="text-warning text-sm">The previous channel no longer accepts scheduled reports. Select another channel to resume delivery.</p>' : ''}
          <div id="sec-scan-report-options" hidden>
            ${select('reportFormat', 'Email report', [['summary', 'Summary only'], ['detailed', 'Summary and detailed attachment']], schedule?.reportFormat || 'summary')}
            <p class="text-muted text-sm">The HTML attachment groups findings by image and shows CVEs, severity, installed versions and published fixes.</p>
          </div>
          <label class="toggle-label"><input name="enabled" type="checkbox" ${schedule?.enabled !== false ? 'checked' : ''}> Enabled</label>
          <p id="sec-scan-error" class="text-danger text-sm" role="alert"></p>
        </div>
        <div class="modal-footer"><button type="button" class="btn btn-secondary" data-close-scan-modal>Cancel</button>
          <button type="submit" class="btn btn-primary">Save schedule</button></div>
      </form>`);
    const form = document.querySelector('#security-schedule-form');
    form.parentElement.querySelectorAll('[data-close-scan-modal]').forEach(b => b.addEventListener('click', () => Modal.close()));
    const fields = form.elements;
    const updateOptions = () => {
      const images = fields.kind.value === 'images';
      const channel = eligibleChannels.find(c => c.id === Number(fields.channel.value));
      form.querySelector('#sec-scan-image-options').hidden = !images;
      form.querySelector('#sec-scan-report-options').hidden = !(images && channel?.provider === 'email');
      fields.reportFormat.disabled = !(images && channel?.provider === 'email');
    };
    fields.kind.addEventListener('change', updateOptions);
    fields.channel.addEventListener('change', updateOptions);
    updateOptions();
    fields.frequency.addEventListener('change', () => { if (fields.frequency.value) fields.cron.value = fields.frequency.value; });
    fields.cron.addEventListener('input', () => { fields.frequency.value = frequencies.some(([v]) => v === fields.cron.value) ? fields.cron.value : ''; });
    form.querySelector('[data-scan-preview]').addEventListener('click', async () => {
      const result = form.querySelector('#sec-scan-preview');
      try {
        const preview = await Api.get(this.path + '/preview?cron=' + encodeURIComponent(fields.cron.value));
        const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone });
        result.textContent = preview.nextRuns.map(value => fmt.format(new Date(value))).join(' · ') || 'No upcoming run';
      } catch (error) { result.textContent = error.message; }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      const values = { name: fields.name.value, hostId: Number(fields.host.value), kind: fields.kind.value,
        imageScope: fields.scope.value, scanner: fields.scanner.value, cron: fields.cron.value,
        channelId: fields.channel.value ? Number(fields.channel.value) : null, enabled: fields.enabled.checked,
        reportFormat: fields.reportFormat.disabled ? 'summary' : fields.reportFormat.value };
      try {
        if (schedule) await Api.put(this.path + '/' + schedule.id, values);
        else await Api.post(this.path, values);
      } catch (error) {
        form.querySelector('#sec-scan-error').textContent = error.message;
        button.disabled = false;
        return;
      }
      if (form.isConnected) Modal.close();
      try { await this.render(el); } catch (error) { Toast.error(error.message); }
    });
  },

  async history(el, schedule, date) {
    const root = el.querySelector('#security-schedule-history');
    const runs = await Api.get(this.path + '/' + schedule.id + '/history');
    if (!root?.isConnected) return;
    const e = Utils.escapeHtml;
    root.innerHTML = `<div class="card"><div class="card-header"><h3>${e(schedule.name)} · Run history</h3>
      <button class="btn btn-xs btn-secondary" data-scan-refresh>Refresh</button></div>
      <div class="card-body">
        ${runs.length ? `<div class="file-list-scroll"><table class="data-table compact">
          <thead><tr>${[['queued', 'Queued'], ['trigger', 'Trigger'], ['result', 'Result'], ['delivery', 'Delivery']]
            .map(([key, label]) => TableSort.header(key, label)).join('')}<th></th></tr></thead>
          <tbody>${runs.map(run => `<tr><td>${e(date(run.queuedAt))}</td><td>${e(run.trigger)}</td>
            <td>${e(this.states[run.status])}<div class="text-muted text-sm">${e(this.summary(run))}</div></td>
            <td>${e(this.delivery(run))}</td><td><button class="btn btn-xs btn-secondary" data-scan-report="${run.id}">View run</button></td></tr>`).join('')}
          </tbody></table></div>` : '<p class="text-muted">No runs yet.</p>'}
      </div></div>`;
    const table = root.querySelector('table');
    if (table) TableSort.bind(table, runs.map(run => ({ queued: Date.parse(run.queuedAt), trigger: run.trigger,
      result: this.states[run.status], delivery: this.delivery(run) })), this._runSorts.get(schedule.id),
    sort => this._runSorts.set(schedule.id, sort));
    root.querySelector('[data-scan-refresh]').addEventListener('click', () => this.history(el, schedule, date).catch(error => Toast.error(error.message)));
    root.querySelectorAll('[data-scan-report]').forEach(button => button.addEventListener('click', () =>
      this.report(Number(button.dataset.scanReport)).catch(error => Toast.error(error.message))));
  },

  async report(id) {
    const run = await Api.get(this.path + '/runs/' + id);
    if (SecurityPage._tab !== 'schedules' || !document.getElementById('security-schedule-history')) return;
    const e = Utils.escapeHtml;
    const report = run.report;
    const imageRows = report?.images?.map(item => `<tr><td class="mono">${e(item.name)}</td>
      <td>${e(item.error || item.scanner)}</td><td>${item.summary?.critical ?? '—'}</td><td>${item.summary?.high ?? '—'}</td>
      <td>${item.summary?.total ?? '—'}</td><td>${item.fixable ?? '—'}</td>
      <td>${item.scanId && run.hostId ? `<button class="btn btn-xs btn-secondary" data-scan-image="${item.scanId}">Findings</button>` : ''}</td></tr>`).join('');
    Modal.open(`<div class="modal-header"><h3>${e(this.kinds[run.kind])} · ${e(run.hostName)}</h3>
      <button type="button" class="modal-close-btn" id="security-report-close">×</button></div>
      <div class="modal-body" id="security-report-body">
        <p><strong>${e(this.states[run.status])}</strong> · ${e(this.summary(run))}</p>
        <p class="text-muted text-sm">Report delivery · ${e(this.delivery(run))}${run.reportFormat === 'detailed' ? ' · Detailed email attachment' : ''}</p>
        ${[run.error, run.deliveryError, report?.summary?.error].filter(Boolean).map(error => `<p class="text-danger">${e(error)}</p>`).join('')}
        ${report?.summary?.skipped ? `<p>${report.summary.skipped} images skipped.</p>` : ''}
        ${imageRows ? `<div class="file-list-scroll"><table class="data-table compact" data-report-images><thead><tr>
          ${[['name', 'Image'], ['outcome', 'Scanner / error'], ['critical', 'Critical'], ['high', 'High'], ['total', 'Total'],
            ['fixable', 'With fixes']].map(([key, label]) => TableSort.header(key, label)).join('')}<th></th>
          </tr></thead><tbody>${imageRows}</tbody></table></div>` : ''}
        ${report?.checks?.length ? `<div class="file-list-scroll"><table class="data-table compact" data-report-checks><thead><tr>
          ${TableSort.header('title', 'Check')}${TableSort.header('status', 'Result')}${TableSort.header('details', 'Details and remediation')}
          </tr></thead><tbody>${report.checks.map(check => `<tr><td>${e(check.title)}</td><td>${e(check.status)}</td>
          <td>${e(check.details || '')}${check.remediation ? `<div class="text-muted">${e(check.remediation)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div>
      <div class="modal-footer">${report ? '<button type="button" class="btn btn-secondary" id="security-report-download">Download JSON</button>' : ''}</div>`, { width: '1050px' });
    const images = document.querySelector('[data-report-images]');
    if (images) TableSort.bind(images, report.images.map(item => ({ name: item.name, outcome: item.error || item.scanner,
      ...item.summary, fixable: item.fixable })));
    const checks = document.querySelector('[data-report-checks]');
    if (checks) TableSort.bind(checks, report.checks);
    document.querySelector('#security-report-close').addEventListener('click', () => Modal.close());
    document.querySelector('#security-report-download')?.addEventListener('click', () => Utils.downloadBlob(
      'security-scan-' + run.id + '.json', new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' })));
    document.querySelectorAll('[data-scan-image]').forEach(button => button.addEventListener('click', () => {
      const scanId = Number(button.dataset.scanImage);
      Modal.close();
      SecurityPage._viewScanDetail(scanId, run.hostId);
    }));
  },
};
