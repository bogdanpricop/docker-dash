'use strict';

const SecurityTriage = {
  async render(element, showSecondary = false) {
    const escape = Utils.escapeHtml;
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
    let data;
    let scanMap;
    let filtered = [];
    let request = 0;
    let page = 0;
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
      const start = page * 100;
      const visible = filtered.slice(start, start + 100);
      status.textContent = `${data.host.name || 'Local Docker'} · ${filtered.length} findings across verified scans${data.truncated ? ' · inventory limit reached' : ''}`;
      exportButton.disabled = !filtered.length;
      list.innerHTML = visible.length ? `<div class="file-list-scroll"><table class="data-table compact"><thead>
        <tr><th>Vulnerability</th><th>Severity</th><th>Package</th><th>Installed</th><th>Fixed in</th><th>Image</th><th>Running containers</th></tr>
        </thead><tbody>${visible.map(finding => {
          const scan = scanMap.get(finding.scanId);
          const running = scan.consumers.filter(container => container.state === 'running');
          return `<tr><td class="mono">${escape(finding.id)}</td><td><span class="badge">${escape(finding.severity)}</span></td>
            <td>${escape(finding.package)}</td><td class="mono">${escape(finding.version)}</td><td class="mono">${escape(finding.fixedIn || '—')}</td>
            <td>${escape(scan.image_name)}<div class="text-xs mono text-muted" title="${escape(scan.verified_image_id)}">${Utils.shortImageId(scan.verified_image_id)} · ${escape(scan.scanner)}</div></td>
            <td>${running.length ? `<details><summary>${running.length} running</summary>
              ${running.map(container => `<button type="button" class="btn btn-xs btn-secondary" data-triage-container="${escape(container.id)}">${escape(container.name)}</button>`).join('')}</details>` : '—'}</td></tr>`;
        }).join('')}</tbody></table></div>
        <div class="schedule-controls" style="margin-top:10px">
          <button type="button" class="btn btn-xs btn-secondary" data-triage-prev ${page ? '' : 'disabled'}>Previous</button>
          <span>${start + 1}–${start + visible.length} of ${filtered.length}</span>
          <button type="button" class="btn btn-xs btn-secondary" data-triage-next ${start + visible.length < filtered.length ? '' : 'disabled'}>Next</button>
        </div>` : '<div class="empty-msg">No verified findings match the filters. Run a scan for the installed image to establish coverage.</div>';
      list.querySelector('[data-triage-prev]')?.addEventListener('click', () => { page--; paint(); });
      list.querySelector('[data-triage-next]')?.addEventListener('click', () => { page++; paint(); });
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
      status.textContent = 'Loading verified scan results…';
      try {
        const response = await Api.get('/images/scan-triage?hostId=' + host.value + (showSecondary ? '' : '&secondary=hide'));
        if (!list.isConnected || id !== request) return;
        data = response;
        scanMap = new Map(data.scans.map(scan => [scan.id, scan]));
        options(stack, [...new Set(data.scans.flatMap(scan => scan.consumers.map(container => container.stack)))].sort().map(name => [name, name]));
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
    try {
      const hosts = (await Api.getHosts()).filter(item => item.isActive && ['docker', 'podman'].includes(item.daemonType || 'docker'));
      if (!list.isConnected) return;
      if (hosts.length) host.innerHTML = hosts.map(item => `<option value="${item.id}" ${item.id === activeHost || (!activeHost && item.isDefault) ? 'selected' : ''}>${escape(item.name)}</option>`).join('');
    } catch { /* keep the active host as the fallback */ }
    if (list.isConnected) await load();
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
