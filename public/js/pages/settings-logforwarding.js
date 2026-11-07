/* ═══════════════════════════════════════════════════
   pages/settings-logforwarding.js — Settings Logforwarding tab
   Extracted from settings.js v8.2.x further-split.
   ═══════════════════════════════════════════════════ */
'use strict';

const SettingsPageLogforwarding = {
  async _renderLogForwarding(el) {
    try {
      const forwarders = await Api.get('/log-forwarders');
      if (!el.isConnected || this._tab !== 'log-forwarding') return;
      const deliveries = new Map(forwarders.map(f => [f.id, f.delivery]));
      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-share-alt" style="margin-right:8px"></i>Log Forwarding</h3>
            <button class="btn btn-sm btn-primary" id="lf-create"><i class="fas fa-plus"></i> Add Forwarder</button>
          </div>
          <div class="card-body">
            <p class="text-muted mb-md">Enabled forwarders stream new container logs to Grafana Loki, Elasticsearch, HTTP webhooks, or Syslog. Delivery status updates automatically and reflects container logs. Use Test to send a sample message separately.</p>
            ${forwarders.length === 0
              ? '<div class="empty-msg">No log forwarders configured.</div>'
              : `<table class="data-table">
                <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Last delivery</th><th>Created</th><th>Actions</th></tr></thead>
                <tbody>${forwarders.map(f => `
                  <tr>
                    <td class="mono">${Utils.escapeHtml(f.name)}</td>
                    <td><span class="badge badge-info">${Utils.escapeHtml(f.type)}</span></td>
                    <td>${f.enabled ? '<span class="text-green">Enabled</span>' : '<span class="text-muted">Disabled</span>'}</td>
                    <td class="text-sm" data-lf-delivery="${f.id}">${this._logDeliveryCell(f)}</td>
                    <td class="text-sm">${Utils.timeAgo(f.created_at)}</td>
                    <td>
                      <div class="action-btns">
                        <button class="action-btn" data-action="toggle-lf" data-id="${f.id}" title="${f.enabled ? 'Disable' : 'Enable'}"><i class="fas fa-${f.enabled ? 'pause' : 'play'}"></i></button>
                        <button class="action-btn" data-action="test-lf" data-id="${f.id}" title="Test"><i class="fas fa-vial"></i></button>
                        <button class="action-btn" data-action="edit-lf" data-id="${f.id}" title="Edit"><i class="fas fa-edit"></i></button>
                        <button class="action-btn danger" data-action="delete-lf" data-id="${f.id}" data-name="${Utils.escapeHtml(f.name)}" title="Delete"><i class="fas fa-trash"></i></button>
                      </div>
                    </td>
                  </tr>
                `).join('')}</tbody>
              </table>`}
          </div>
        </div>
      `;

      el.querySelector('#lf-create').addEventListener('click', () => this._openLogForwarder());

      const card = el.querySelector('.card');
      const cells = [...card.querySelectorAll('[data-lf-delivery]')];
      const current = () => card.isConnected && this._tab === 'log-forwarding';
      const refresh = async () => {
        if (!current()) return;
        try {
          if (!document.hidden) {
            const rows = new Map((await Api.get('/log-forwarders')).map(f => [f.id, f]));
            if (!current()) return;
            for (const cell of cells) {
              const id = Number(cell.dataset.lfDelivery);
              const row = rows.get(id);
              if (!row || JSON.stringify(deliveries.get(id)) === JSON.stringify(row.delivery)) continue;
              deliveries.set(id, row.delivery);
              const focused = cell.contains(document.activeElement);
              cell.innerHTML = this._logDeliveryCell(row);
              if (focused) cell.querySelector('button')?.focus();
            }
          }
        } catch { /* Keep the last known result until the next refresh. */ }
        if (current()) setTimeout(refresh, 10000);
      };
      if (cells.length) setTimeout(refresh, 10000);

      card.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const id = parseInt(btn.dataset.id);

        if (btn.dataset.action === 'delivery-error-lf') {
          this._showLogDeliveryError(forwarders.find(f => f.id === id)?.name, deliveries.get(id));
        } else if (btn.dataset.action === 'toggle-lf') {
          btn.disabled = true;
          try {
            await Api.put('/log-forwarders/' + id, { enabled: !forwarders.find(f => f.id === id)?.enabled });
            Toast.success('Forwarder updated');
            await this._renderTab();
          } catch (err) { Toast.error(err.message); }
          finally { btn.disabled = false; }
        } else if (btn.dataset.action === 'test-lf') {
          btn.disabled = true;
          try {
            Toast.info('Sending test log...');
            const result = await Api.post('/log-forwarders/' + id + '/test');
            Toast.success(result.message || 'Test successful');
          } catch (err) {
            const details = err.body?.details || {};
            const status = details.httpStatus ? `HTTP ${details.httpStatus}` : details.code;
            Toast.error(['Test failed: ' + err.message, status,
              details.retryAfterSeconds != null ? `Retry after ${details.retryAfterSeconds} s` : ''].filter(Boolean).join(' · '));
          } finally { btn.disabled = false; }
        } else if (btn.dataset.action === 'edit-lf') {
          try {
            await this._openLogForwarder(await Api.get('/log-forwarders/' + id));
          } catch (err) { Toast.error(err.message); }
        } else if (btn.dataset.action === 'delete-lf') {
          const ok = await Modal.confirm('Delete forwarder "' + btn.dataset.name + '"?', { danger: true });
          if (!ok) return;
          try {
            await Api.delete('/log-forwarders/' + id);
            Toast.success('Forwarder deleted');
            this._renderTab();
          } catch (err) { Toast.error(err.message); }
        }
      });
    } catch (err) {
      if (el.isConnected && this._tab === 'log-forwarding') {
        el.innerHTML = '<div class="empty-msg">Error: ' + Utils.escapeHtml(err.message) + '</div>';
      }
    }
  },

  _logDeliveryCell({ id, type, delivery = {} }) {
    const { lastSuccessAt, lastErrorAt, lastError } = delivery;
    const esc = Utils.escapeHtml;
    const success = lastSuccessAt
      ? `<time datetime="${esc(lastSuccessAt)}">${esc(Utils.formatDate(lastSuccessAt))}</time>
         ${type === 'syslog' ? '<div class="text-muted">Sent without collector confirmation</div>' : ''}`
      : '<span class="text-muted">No successful delivery yet</span>';
    const error = lastError
      ? `<div><button type="button" class="btn btn-sm btn-secondary" data-action="delivery-error-lf" data-id="${id}">
          ${lastSuccessAt && lastSuccessAt > lastErrorAt ? 'Previous failure' : 'View delivery error'}
        </button></div>`
      : '';
    return success + error;
  },

  _showLogDeliveryError(name, delivery) {
    if (!delivery?.lastError) return;
    const esc = Utils.escapeHtml;
    const { lastError: details, lastErrorAt } = delivery;
    const entries = [
      ['Destination', name],
      ['Failed at', Utils.formatDate(lastErrorAt)],
      ['Reason', details.reason],
      ['Error code', details.code],
      ['HTTP status', details.httpStatus],
      ['Batch size', details.batchSize],
      ['Attempt', details.attempt],
      ['Rejected entries', details.rejected],
      ['Elasticsearch item statuses', details.itemStatuses?.join(', ')],
      ['Collector retry delay', details.retryAfterSeconds != null ? `${details.retryAfterSeconds} s` : null],
      ['Retry was scheduled for', details.retryAt ? Utils.formatDate(details.retryAt) : null],
    ].filter(([, value]) => value != null);
    Modal.open(`
      <div class="modal-header"><h3>Log delivery error</h3></div>
      <div class="modal-body"><dl>
        ${entries.map(([label, value]) => `<dt><strong>${esc(label)}</strong></dt><dd>${esc(String(value))}</dd>`).join('')}
      </dl></div>
      <div class="modal-footer"><button type="button" class="btn btn-primary" id="lf-error-close">Close</button></div>
    `, { width: '520px' });
    Modal._content.querySelector('#lf-error-close').addEventListener('click', () => Modal.close());
  },

  async _openLogForwarder(forwarder = null) {
    const esc = Utils.escapeHtml;
    const types = { loki: 'Grafana Loki', elasticsearch: 'Elasticsearch', http: 'HTTP Webhook', syslog: 'Syslog' };
    const cfg = forwarder?.config || {};
    const options = Object.entries(types).map(([value, label]) =>
      `<option value="${value}" ${value === forwarder?.type ? 'selected' : ''}>${label}</option>`).join('');
    const saved = await Modal.form(`
      <div class="form-group"><label for="lf-name">Name</label>
        <input id="lf-name" class="form-control" value="${esc(forwarder?.name || '')}" required></div>
      <div class="form-group"><label for="lf-type">Type</label>
        <select id="lf-type" class="form-control" ${forwarder ? 'disabled' : ''}>${options}</select></div>
      <div id="lf-config-fields"></div>
      ${!forwarder ? '<label><input type="checkbox" id="lf-enabled" checked> Enable forwarder</label>' : ''}
    `, {
      title: forwarder ? 'Edit Log Forwarder' : 'Add Log Forwarder',
      onMount: content => {
        const type = content.querySelector('#lf-type');
        const fields = content.querySelector('#lf-config-fields');
        const render = () => {
          fields.innerHTML = type.value === 'syslog' ? `
            <div class="form-group"><label for="lf-host">Host</label>
              <input id="lf-host" class="form-control" value="${esc(cfg.host || '')}" placeholder="syslog.example.com" required></div>
            <div class="form-group"><label for="lf-port">Port</label>
              <input id="lf-port" type="number" class="form-control" min="1" max="65535" value="${esc(cfg.port || 514)}" required></div>
            <div class="form-group"><label for="lf-protocol">Protocol</label>
              <select id="lf-protocol" class="form-control"><option value="udp">UDP</option>
                <option value="tcp" ${cfg.protocol === 'tcp' ? 'selected' : ''}>TCP</option></select></div>
          ` : `
            <div class="form-group"><label for="lf-url">URL</label>
              <input id="lf-url" type="url" class="form-control" value="${esc(cfg.url || '')}" placeholder="${type.value === 'loki' ? 'http://loki:3100' : 'https://logs.example.com'}" required></div>
            <div class="form-group"><label for="lf-headers">Custom Headers (JSON, optional)</label>
              <input id="lf-headers" class="form-control" autocomplete="off" value="${esc(cfg.headers ? JSON.stringify(cfg.headers) : '')}" placeholder='{"X-Token":"…"}'></div>
            ${type.value === 'elasticsearch' ? `<div class="form-group"><label for="lf-index">Elasticsearch index</label>
              <input id="lf-index" class="form-control" value="${esc(cfg.index || 'docker-dash-logs')}" required></div>` : ''}
          `;
        };
        type.addEventListener('change', render);
        render();
      },
      onSubmit: async content => {
        const field = id => content.querySelector('#lf-' + id);
        const name = field('name');
        const type = field('type').value;
        const destination = field(type === 'syslog' ? 'host' : 'url');
        name.value = name.value.trim();
        destination.value = destination.value.trim();
        if (!name.reportValidity() || !destination.reportValidity()) return false;
        const config = { ...cfg };
        if (type === 'syslog') {
          if (!field('port').reportValidity()) return false;
          Object.assign(config, { host: destination.value, port: field('port').valueAsNumber, protocol: field('protocol').value });
        } else {
          if (!/^https?:\/\//i.test(destination.value)) { Toast.error('Enter an HTTP or HTTPS URL'); return false; }
          try {
            config.headers = JSON.parse(field('headers').value.trim() || '{}');
            if (!config.headers || Array.isArray(config.headers) || typeof config.headers !== 'object') throw new Error();
          } catch {
            Toast.error('Custom headers must be a JSON object');
            return false;
          }
          config.url = destination.value;
          if (type === 'elasticsearch') {
            field('index').value = field('index').value.trim();
            if (!field('index').reportValidity()) return false;
            config.index = field('index').value;
          }
        }
        const submit = content.querySelector('#modal-submit');
        submit.disabled = true;
        try {
          if (forwarder) await Api.put('/log-forwarders/' + forwarder.id, { name: name.value, config });
          else await Api.post('/log-forwarders', { name: name.value, type, config, enabled: field('enabled').checked });
          return true;
        } catch (err) {
          Toast.error(err.message);
          submit.disabled = false;
          return false;
        }
      },
    });
    if (saved) {
      Toast.success(forwarder ? 'Forwarder updated' : 'Log forwarder created');
      await this._renderTab();
    }
  },

};

if (typeof window !== 'undefined') window.SettingsPageLogforwarding = SettingsPageLogforwarding;
