'use strict';

const SecurityTriage = {
  _sort: null,

  async render(element, showSecondary = false) {
    const escape = Utils.escapeHtml;
    const t = key => i18n.t('dgx.' + key);
    const activeHost = Api.getHostId();
    element.innerHTML = `<div class="card" style="padding:12px">
      <div class="schedule-controls">
        <label>Host <select class="form-control" data-triage-host><option value="${activeHost}">Selected host</option></select></label>
        <label>Stack <select class="form-control" data-triage-stack></select></label>
        <label>Image ID <select class="form-control" data-triage-image></select></label>
        <label>Severity <select class="form-control" data-triage-severity><option value="">All</option>
          ${['critical', 'high', 'medium', 'low', 'unknown', 'negligible'].map(value => `<option>${value}</option>`).join('')}</select></label>
        <label>Remediation <select class="form-control" data-triage-fix><option value="">Any</option>
          <option value="fixed">Fix available</option><option value="unfixed">No published fix</option></select></label>
      </div>
      <div class="schedule-controls">
        <button class="btn btn-sm btn-secondary" type="button" data-triage-compare disabled>Compare scans</button>
        <button class="btn btn-sm btn-secondary" type="button" data-triage-export disabled>Export filtered SARIF</button>
        <button class="btn btn-sm btn-primary" type="button" data-triage-dgx hidden disabled>${t('analyze')}</button>
        <span data-triage-dgx-stack-wrap hidden><button class="btn btn-sm btn-primary" type="button" data-triage-dgx-stack disabled>${t('analyzeStack')}</button></span>
        <span class="text-sm text-muted" data-triage-dgx-status role="status"></span>
      </div><p class="text-sm text-muted" data-triage-state role="status"></p><div data-triage-list></div>
    </div>`;
    const host = element.querySelector('[data-triage-host]');
    const stack = element.querySelector('[data-triage-stack]');
    const image = element.querySelector('[data-triage-image]');
    const severity = element.querySelector('[data-triage-severity]');
    const fix = element.querySelector('[data-triage-fix]');
    const list = element.querySelector('[data-triage-list]');
    const status = element.querySelector('[data-triage-state]');
    const compare = element.querySelector('[data-triage-compare]');
    const exportButton = element.querySelector('[data-triage-export]');
    const dgxButton = element.querySelector('[data-triage-dgx]');
    const stackDgxButton = element.querySelector('[data-triage-dgx-stack]');
    const stackDgxWrap = element.querySelector('[data-triage-dgx-stack-wrap]');
    const dgxStatus = element.querySelector('[data-triage-dgx-status]');
    const columns = [['id', 'Vulnerability'], ['severity', 'Severity'], ['package', 'Package'], ['version', 'Installed'],
      ['fixedIn', 'Fixed in'], ['image', 'Image'], ['running', 'Running containers']];
    const severities = ['critical', 'high', 'medium', 'low', 'negligible', 'unknown'];
    let data;
    let scanMap;
    let filtered = [];
    let request = 0;
    let page = 0;
    let dgxBusy = false;
    const options = (select, values) => {
      select.innerHTML = '<option value="">All</option>' + values.map(([value, label]) =>
        `<option value="${escape(value)}">${escape(label)}</option>`).join('');
    };
    const paint = () => {
      if (!data) return;
      filtered = data.findings.filter(finding => {
        const scan = scanMap.get(finding.scanId);
        return (!stack.value || scan.consumers.some(container => container.stack === stack.value))
          && (!image.value || image.value === scan.verified_image_id)
          && (!severity.value || severity.value === finding.severity)
          && (!fix.value || Boolean(finding.fixedIn) === (fix.value === 'fixed'));
      });
      const running = finding => scanMap.get(finding.scanId).consumers.filter(container => container.state === 'running');
      if (this._sort) {
        const { key, direction } = this._sort;
        const value = finding => {
          if (key === 'severity') return severities.indexOf(finding.severity) + 1 || null;
          if (key === 'image') return scanMap.get(finding.scanId).image_name;
          if (key === 'running') return running(finding).length;
          return finding[key];
        };
        filtered.sort((a, b) => TableSort.compare(value(a), value(b), direction));
      }
      const start = page * 100;
      const visible = filtered.slice(start, start + 100);
      status.textContent = `${data.host.name || 'Local Docker'} · ${filtered.length} findings across verified scans${data.truncated ? ' · inventory limit reached' : ''}`;
      exportButton.disabled = !filtered.length;
      dgxButton.hidden = !data.dgxAvailable;
      dgxButton.disabled = dgxBusy || !image.value;
      stackDgxWrap.hidden = !data.dgxAvailable;
      stackDgxButton.disabled = dgxBusy || !data.stacks?.includes(stack.value);
      list.innerHTML = visible.length ? `<div class="file-list-scroll"><table class="data-table compact"><thead>
        <tr>${columns.map(([key, label]) => TableSort.header(key, label)).join('')}</tr>
        </thead><tbody>${visible.map(finding => {
          const scan = scanMap.get(finding.scanId);
          const consumers = running(finding);
          return `<tr><td class="mono">${escape(finding.id)}</td><td><span class="badge">${escape(finding.severity)}</span></td>
            <td>${escape(finding.package)}</td><td class="mono">${escape(finding.version)}</td><td class="mono">${escape(finding.fixedIn || '—')}</td>
            <td>${escape(scan.image_name)}<div class="text-xs mono text-muted" title="${escape(scan.verified_image_id)}">${Utils.shortImageId(scan.verified_image_id)} · ${escape(scan.scanner)}</div></td>
            <td>${consumers.length ? `<details><summary>${consumers.length} running</summary>
              ${consumers.map(container => `<button type="button" class="btn btn-xs btn-secondary" data-triage-container="${escape(container.id)}">${escape(container.name)}</button>`).join('')}</details>` : '—'}</td></tr>`;
        }).join('')}</tbody></table></div>
        <div class="schedule-controls" style="margin-top:10px">
          <button type="button" class="btn btn-xs btn-secondary" data-triage-prev ${page ? '' : 'disabled'}>Previous</button>
          <span>${start + 1}–${start + visible.length} of ${filtered.length}</span>
          <button type="button" class="btn btn-xs btn-secondary" data-triage-next ${start + visible.length < filtered.length ? '' : 'disabled'}>Next</button>
        </div>` : '<div class="empty-msg">No verified findings match the filters. Run a scan for the installed image to establish coverage.</div>';
      list.querySelector('[data-triage-prev]')?.addEventListener('click', () => { page--; paint(); });
      list.querySelector('[data-triage-next]')?.addEventListener('click', () => { page++; paint(); });
      const head = list.querySelector('thead');
      if (head) {
        TableSort.update(head, this._sort);
        TableSort.onClick(head, key => {
          const restoreFocus = head.contains(document.activeElement);
          this._sort = TableSort.next(this._sort, key);
          page = 0;
          paint();
          if (restoreFocus) list.querySelector(`[data-sort-column="${key}"]`)?.focus();
        });
      }
      list.querySelectorAll('[data-triage-container]').forEach(button => button.addEventListener('click', () => {
        const route = '#/containers/' + encodeURIComponent(button.dataset.triageContainer);
        if (data.host.id) App._activateHost(data.host.id, route);
        else location.hash = route;
      }));
    };
    const load = async () => {
      const id = ++request;
      data = null;
      page = 0;
      list.replaceChildren();
      compare.disabled = exportButton.disabled = true;
      dgxButton.hidden = dgxButton.disabled = true;
      stackDgxWrap.hidden = stackDgxButton.disabled = true;
      dgxStatus.textContent = '';
      status.textContent = 'Loading verified scan results…';
      try {
        const response = await Api.get('/images/scan-triage?hostId=' + host.value + (showSecondary ? '' : '&secondary=hide'));
        if (!list.isConnected || id !== request) return;
        data = response;
        scanMap = new Map(data.scans.map(scan => [scan.id, scan]));
        options(stack, [...new Set([...(data.stacks || []), ...data.scans.flatMap(scan => scan.consumers.map(container => container.stack))])].sort().map(name => [name, name]));
        options(image, data.scans.map(scan => [scan.verified_image_id, scan.image_name + ' · ' + Utils.shortImageId(scan.verified_image_id)]));
        compare.disabled = false;
        paint();
      } catch (error) {
        if (list.isConnected && id === request) status.textContent = error.message;
      }
    };
    host.addEventListener('change', load);
    [stack, image, severity, fix].forEach(control => control.addEventListener('change', () => { page = 0; paint(); }));
    compare.addEventListener('click', () => this.compare(data.host.id, showSecondary).catch(error => Toast.error(error.message)));
    exportButton.addEventListener('click', () => this.exportSarif(filtered, scanMap, data.host));
    dgxButton.addEventListener('click', async () => {
      if (!data || !image.value || dgxBusy) return;
      const imageId = image.value;
      const currentRequest = request;
      dgxBusy = dgxButton.disabled = true;
      stackDgxButton.disabled = true;
      dgxStatus.textContent = t('analyzing');
      try {
        const result = await Api.post('/images/scan-triage/dgx?hostId=' + data.host.id +
          (showSecondary ? '' : '&secondary=hide'), { imageId });
        if (list.isConnected && currentRequest === request) {
          dgxStatus.textContent = '';
          this.showDgxProposal(result);
        }
      } catch (error) {
        if (list.isConnected && currentRequest === request) dgxStatus.textContent = error.message;
      } finally {
        dgxBusy = false;
        dgxButton.disabled = !image.value || !data?.dgxAvailable;
        stackDgxButton.disabled = !data?.dgxAvailable || !data.stacks?.includes(stack.value);
      }
    });
    stackDgxButton.addEventListener('click', async () => {
      if (!data?.stacks?.includes(stack.value) || dgxBusy) return;
      const name = stack.value;
      const currentRequest = request;
      dgxBusy = dgxButton.disabled = stackDgxButton.disabled = true;
      dgxStatus.textContent = t('analyzingStack');
      try {
        const result = await Api.post('/images/scan-triage/dgx/stack?hostId=' + data.host.id +
          (showSecondary ? '' : '&secondary=hide'), { stack: name });
        if (list.isConnected && currentRequest === request) {
          dgxStatus.textContent = '';
          this.showDgxStack(result);
        }
      } catch (error) {
        if (list.isConnected && currentRequest === request) dgxStatus.textContent = error.message;
      } finally {
        dgxBusy = false;
        dgxButton.disabled = !image.value || !data?.dgxAvailable;
        stackDgxButton.disabled = !data?.dgxAvailable || !data.stacks?.includes(stack.value);
      }
    });
    try {
      const hosts = (await Api.getHosts()).filter(item => item.isActive && ['docker', 'podman'].includes(item.daemonType || 'docker'));
      if (!list.isConnected) return;
      if (hosts.length) host.innerHTML = hosts.map(item => `<option value="${item.id}" ${item.id === activeHost || (!activeHost && item.isDefault) ? 'selected' : ''}>${escape(item.name)}</option>`).join('');
    } catch { /* keep the active host as the fallback */ }
    if (list.isConnected) await load();
  },

  showDgxProposal(result) {
    const t = (key, values) => i18n.t('dgx.' + key, values);
    const escape = Utils.escapeHtml;
    const rows = result.findings.map(item => `<tr>
      <td>${escape(item.id)}<br><span class="badge">${escape(item.severity)}</span></td>
      <td>${escape(item.package)} <span class="mono">${escape(item.version)}</span></td>
      <td>${item.sources.map(source => `<div>${escape(source.scanner)} #${source.scanId} · ${escape(source.fixedIn || t('noFix'))}</div>`).join('')}</td>
      <td>${t(item.remediation)}<br><span class="text-sm text-muted">${t(item.nextCheck)}</span></td>
    </tr>`).join('');
    Modal.open(`<div class="modal-header"><h3>${t('proposal')}</h3></div>
      <div class="modal-body">
        <p><strong>${escape(result.image)}</strong> · ${escape(Utils.shortImageId(result.imageId))} · ${escape(result.model)}</p>
        <p class="text-sm text-muted">${t('coverage', { shown: result.findings.length, total: result.total })}</p>
        <p class="text-sm text-muted">${result.scans.map(scan => escape(scan.scanner) + ' #' + scan.id + ' · ' + escape(scan.scannedAt)).join(' | ')}</p>
        ${new Set(result.scans.map(scan => scan.scanner)).size < 2 ? `<p>${t('singleScanner')}</p>` : ''}
        ${result.consumers.length ? `<p class="text-sm">${t('consumers')} ${result.consumers.map(container => escape(container.name) + ' (' + escape(container.stack) + ')').join(', ')}</p>` : ''}
        ${rows ? `<div class="file-list-scroll"><table class="data-table compact">
          <thead><tr><th>${t('finding')}</th><th>${t('package')}</th><th>${t('scannerFix')}</th><th>${t('nextSteps')}</th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : `<p>${t('empty')}</p>`}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-dgx-copy type="button">${t('copyRecommendations')}</button>
        <button class="btn btn-secondary" data-dgx-download type="button">${t('download')}</button>
        <button class="btn btn-primary" data-dgx-close type="button">${i18n.t('common.close')}</button>
      </div>`, { width: '1000px' });
    Modal._content.querySelector('[data-dgx-download]').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'dgx-proposal-' + result.imageId.slice(7, 19) + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    Modal._content.querySelector('[data-dgx-close]').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('[data-dgx-copy]').addEventListener('click', () => this.copyDgx([
      result.image, ...result.findings.map(item => this.dgxFindingText(item, t)),
    ].join('\n')));
  },

  dgxFindingText(item, t) {
    const sources = item.sources.map(source => source.scanner + ' #' + source.scanId + ' · ' + (source.fixedIn || t('noFix'))).join(', ');
    return [item.id, item.package + ' ' + item.version, sources, t(item.remediation), t(item.nextCheck)].join(' · ');
  },

  async copyDgx(text) {
    try {
      await Utils.copyToClipboard(text);
      Toast.success(i18n.t('dgx.copied'));
    } catch { Toast.error(i18n.t('dgx.copyFailed')); }
  },

  showDgxStack(result) {
    const t = (key, values) => i18n.t('dgx.' + key, values);
    const escape = Utils.escapeHtml;
    const imageName = id => result.coverage.find(item => item.imageId === id)?.image || id;
    const coverage = result.coverage.map(item => `<li>${escape(item.image)} · ${item.scans.length
      ? item.scans.map(s => escape(s.scanner) + ' #' + s.id + ' · ' + escape(s.scannedAt)).join(' / ') : t('planReason.no_scan')}</li>`).join('');
    const findings = result.findings.map(item => `<li>${escape(imageName(item.imageId))} · ${escape(this.dgxFindingText(item, t))}</li>`).join('');
    const steps = result.plan.map((step, index) => {
      if (!step.change) return `<li><strong>${escape(step.service)}</strong> · ${t('planReason.' + step.reason)}</li>`;
      const { candidate, diff, file, kind, prepareCommands, deployCommands, gitBacked } = step.change;
      return `<li><details open><summary><strong>${escape(step.service)}</strong> · ${escape(kind)} · ${t('fixedCount', { count: candidate.fixed.length })}</summary>
        <p class="mono">${escape(file)} · ${escape(candidate.pinned)}</p>
        <p>${candidate.checks.map(item => escape(item.scanner) + ' #' + item.previousScan + ' → #' + item.candidateScan + ' · ' +
          t('blockerCount', { count: item.blockers })).join(' / ')}</p>
        <p class="text-sm">${candidate.fixed.slice(0, 12).map(item => escape(item.id + ' · ' + item.package)).join(', ')}</p>
        ${kind === 'dockerfile' ? `<p>${t('baseOnly')}</p>` : ''}
        ${gitBacked ? `<p>${t('gitBacked')}</p>` : ''}
        ${!candidate.admissionPassed ? `<p>${t('admissionBlocked')}</p>` : ''}
        <details><summary>${t('diff')}</summary><pre class="file-list-scroll">${escape(diff)}</pre></details>
        <details><summary>${t('prepare')}</summary><pre class="file-list-scroll">${escape(prepareCommands)}</pre>
          <button type="button" class="btn btn-secondary" data-dgx-prepare="${index}">${t('copyLinux')}</button></details>
        ${deployCommands ? `<details><summary>${t('deploy')}</summary><p>${t('deployWarning')}</p>
          <pre class="file-list-scroll">${escape(deployCommands)}</pre>
          <button type="button" class="btn btn-secondary" data-dgx-deploy="${index}">${t('copyLinux')}</button></details>` : ''}
      </details></li>`;
    }).join('');
    Modal.open(`<div class="modal-header"><h3>${t('stackPlan')} · ${escape(result.stack)}</h3></div>
      <div class="modal-body">
        <p>${escape(result.model)} · ${t('coverage', { shown: result.findings.length, total: result.total })}</p>
        <details><summary>${t('stackCoverage')}</summary><ul>${coverage}</ul></details>
        <details><summary>${t('recommendations')}</summary><ul>${findings}</ul></details>
        <ul class="bulk-plan-rows">${steps}</ul>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-dgx-copy-stack>${t('copyRecommendations')}</button>
        <button type="button" class="btn btn-primary" data-dgx-close-stack>${i18n.t('common.close')}</button>
      </div>`, { width: '1050px' });
    const content = Modal._content;
    content.querySelector('[data-dgx-close-stack]').addEventListener('click', () => Modal.close());
    content.querySelector('[data-dgx-copy-stack]').addEventListener('click', () => this.copyDgx([
      t('stackPlan') + ' · ' + result.stack,
      ...result.findings.map(item => imageName(item.imageId) + ' · ' + this.dgxFindingText(item, t)),
      ...result.plan.map(step => step.change
        ? [
          step.service + ' · ' + step.change.candidate.pinned,
          ...step.change.candidate.checks.map(check => check.scanner + ' #' + check.previousScan + ' → #' + check.candidateScan
            + ' · ' + t('blockerCount', { count: check.blockers })),
          ...(step.change.candidate.admissionPassed ? [] : [t('admissionBlocked')]),
          ...(step.change.kind === 'dockerfile' ? [t('baseOnly')] : []),
          ...(step.change.gitBacked ? [t('gitBacked')] : []),
          step.change.diff,
        ].join('\n')
        : step.service + ' · ' + t('planReason.' + step.reason)),
    ].join('\n')));
    content.querySelectorAll('[data-dgx-prepare]').forEach(button => button.addEventListener('click', () => {
      this.copyDgx(result.plan[Number(button.dataset.dgxPrepare)].change.prepareCommands);
    }));
    content.querySelectorAll('[data-dgx-deploy]').forEach(button => button.addEventListener('click', () => {
      this.copyDgx(result.plan[Number(button.dataset.dgxDeploy)].change.deployCommands);
    }));
  },

  async compare(hostId, showSecondary = false) {
    const escape = Utils.escapeHtml;
    const history = (await Api.get(`/images/scan-history?hostId=${hostId}&limit=200${showSecondary ? '' : '&secondary=hide'}`)).filter(scan => scan.verified_image_id);
    if (history.length < 2) { Toast.info('Two verified scans on this host are needed for comparison'); return; }
    const options = history.map(scan => `<option value="${scan.id}">${escape(scan.image_name)} · ${Utils.shortImageId(scan.verified_image_id)} · ${escape(scan.scanner)} · ${escape(scan.scanned_at)}</option>`).join('');
    const choice = await Modal.form(`<div class="form-group"><label for="compare-base-scan">Baseline</label><select class="form-control" id="compare-base-scan">${options}</select></div>
      <div class="form-group"><label for="compare-new-scan">Compared scan</label><select class="form-control" id="compare-new-scan">${options}</select></div>`, {
      title: 'Compare verified scans', submitLabel: 'Compare', width: '740px',
      onMount: content => { content.querySelector('#compare-base-scan').selectedIndex = 1; },
      onSubmit: content => {
        const baseline = content.querySelector('#compare-base-scan').value;
        const compared = content.querySelector('#compare-new-scan').value;
        if (baseline === compared) { Toast.warning('Select two different scans'); return false; }
        return [baseline, compared];
      },
    });
    if (!choice) return;
    const [before, after] = await Promise.all(choice.map(id => Api.get(`/images/scan-history/${id}?hostId=${hostId}`)));
    const fingerprint = finding => JSON.stringify([finding.id, finding.package, finding.type, finding.target]);
    const left = new Map(before.vulnerabilities.map(finding => [fingerprint(finding), finding]));
    const right = new Map(after.vulnerabilities.map(finding => [fingerprint(finding), finding]));
    const added = [...right].filter(([key]) => !left.has(key)).map(([, row]) => row);
    const absent = [...left].filter(([key]) => !right.has(key)).map(([, row]) => row);
    const changed = [...right].flatMap(([key, row]) => {
      const previous = left.get(key);
      return previous && (row.version !== previous.version || row.fixedIn !== previous.fixedIn || row.severity !== previous.severity)
        ? [{ ...row, previous: previous.version }] : [];
    });
    const group = (label, rows) => `<details><summary>${label} · ${rows.length}</summary><ul class="bulk-plan-rows">${rows.map(row =>
      `<li>${escape(row.id)} · ${escape(row.package)} · ${row.previous ? escape(row.previous) + ' → ' : ''}${escape(row.version)} · ${escape(row.severity)}</li>`).join('')}</ul></details>`;
    Modal.open(`<div class="modal-header"><h3>Scan comparison</h3></div><div class="modal-body">
      <p>${escape(before.image_name)} · ${escape(before.scanner)} → ${escape(after.image_name)} · ${escape(after.scanner)}</p>
      ${before.scanner !== after.scanner ? '<p class="text-sm text-muted">Different scanners may report different findings for the same packages.</p>' : ''}
      ${group('New in compared scan', added)}${group('Absent from compared scan', absent)}${group('Changed package or finding', changed)}
      </div><div class="modal-footer"><button class="btn btn-primary" type="button" data-close-comparison>Close</button></div>`, { width: '700px' });
    Modal._content.querySelector('[data-close-comparison]').addEventListener('click', () => Modal.close());
  },

  exportSarif(rows, scans, host) {
    const rules = [...new Set(rows.map(row => row.id))].map(id => ({ id }));
    const documentData = {
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'Docker Dash vulnerability triage', rules } },
        results: rows.map(row => {
          const scan = scans.get(row.scanId);
          return {
            ruleId: row.id,
            level: ['critical', 'high'].includes(row.severity) ? 'error' : row.severity === 'medium' ? 'warning' : 'note',
            message: { text: `${row.package} ${row.version}${row.fixedIn ? ' · fix ' + row.fixedIn : ''}` },
            locations: [{ logicalLocations: [{ name: row.package, fullyQualifiedName: scan.verified_image_id + '/' + row.package }] }],
            properties: { hostId: host.id, image: scan.image_name, imageId: scan.verified_image_id, installedVersion: row.version,
              fixedVersion: row.fixedIn || '', severity: row.severity, scanner: scan.scanner, scanId: scan.id },
          };
        }),
      }],
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(documentData, null, 2)], { type: 'application/sarif+json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'docker-dash-triage.sarif';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
