/* ═══════════════════════════════════════════════════
   pages/settings-ai.js — Settings Ai tab
   Extracted from settings.js v8.2.x further-split.
   ═══════════════════════════════════════════════════ */
'use strict';

const SettingsPageAi = {
  async _renderAiSettings(el) {
    let providers = [];
    let settings = null;
    try {
      [providers, settings] = await Promise.all([
        Api.get('/ai/providers'),
        Api.get('/ai/settings'),
      ]);
    } catch (err) {
      el.innerHTML = `<div class="empty-msg is-error">${Utils.escapeHtml(err.message)}</div>`;
      return;
    }

    const sel = settings.provider || providers[0]?.id;
    let dirty = false, testing = false;

    el.innerHTML = `
      <div class="card" style="max-width:760px">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <h3><i class="fas fa-robot" style="color:var(--accent);margin-right:8px"></i> AI Features
            <span class="badge" style="margin-left:10px;background:${settings.enabled ? 'var(--green)' : 'var(--surface2)'};color:${settings.enabled ? '#000' : 'var(--text-dim)'};font-size:11px;padding:3px 10px;border-radius:10px">
              ${settings.enabled ? 'Enabled' : 'Off'}
            </span>
          </h3>
          <a href="https://github.com/bogdanpricop/docker-dash/blob/main/docs/features/ai.md" target="_blank" rel="noopener" class="btn btn-sm btn-secondary" style="text-decoration:none"><i class="fas fa-book"></i> Docs</a>
        </div>
        <div class="card-body">
          <p class="text-muted text-sm" style="margin-bottom:14px">
            <i class="fas fa-info-circle"></i>
            Off by default. Bring your own API key or run a local Ollama instance — Docker Dash ships zero credentials.
            Every AI call is audited; the redactor strips secrets before any payload leaves the host.
          </p>

          <label style="display:flex;align-items:center;gap:10px;margin-bottom:18px;cursor:pointer">
            <input type="checkbox" id="ai-enabled" ${settings.enabled ? 'checked' : ''}>
            <strong>Enable AI features</strong>
          </label>

          <div class="form-group">
            <label>Provider</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${providers.map(p => `
                <label style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid ${p.id === sel ? 'var(--accent)' : 'var(--border)'};border-radius:var(--radius-sm);cursor:pointer;background:${p.id === sel ? 'rgba(56,139,253,0.08)' : 'transparent'}">
                  <input type="radio" name="ai-provider" value="${p.id}" ${p.id === sel ? 'checked' : ''}>
                  ${Utils.escapeHtml(p.name)}
                </label>
              `).join('')}
            </div>
          </div>

          <div id="ai-provider-fields"></div>

          <div style="display:flex;gap:8px;margin:18px 0">
            <button class="btn btn-primary" id="ai-save"><i class="fas fa-save"></i> Save</button>
            <button class="btn btn-secondary" id="ai-test"><i class="fas fa-plug"></i> Test connection</button>
            <span id="ai-test-result" role="status" style="margin-left:10px;align-self:center;font-size:12px"></span>
          </div>

          <details style="margin-top:18px">
            <summary style="cursor:pointer;font-weight:600;user-select:none"><i class="fas fa-shield-alt" style="color:var(--green);margin-right:6px"></i> Privacy: what gets sent</summary>
            <div style="margin-top:10px;padding:12px;background:var(--bg-dim);border-radius:var(--radius-sm);font-size:12px;line-height:1.6">
              <p><strong>When you use an AI feature, this leaves the host:</strong></p>
              <ul style="margin:6px 0 12px;padding-left:22px">
                <li>The query/data for that specific call (after redaction)</li>
                <li>Provider/model identifier in audit log</li>
              </ul>
              <p><strong>Never leaves the host:</strong></p>
              <ul style="margin:6px 0 12px;padding-left:22px">
                <li>Container logs/inspect content (this release)</li>
                <li>Stored secrets / registry credentials</li>
                <li>Audit log row content (queries are NL, results stay local)</li>
              </ul>
              <p>Audit log records every AI call — query <code>action=ai_call</code> in the Audit page. Each record includes provider, model, token count, and a SHA-256 hash of the original payload (for compliance evidence).</p>
            </div>
          </details>

          <details style="margin-top:14px">
            <summary style="cursor:pointer;font-weight:600;user-select:none"><i class="fas fa-eraser" style="color:var(--text-dim);margin-right:6px"></i> Custom redaction patterns (advanced)</summary>
            <div style="margin-top:10px">
              <p class="text-sm text-muted" style="margin-bottom:8px">Built-in patterns catch Bearer tokens, env-style secrets (<code>*PASSWORD*=val</code>, <code>*API_KEY*=val</code>), connection strings (<code>postgres://user:pass@host</code>), high-entropy tokens, IPs, and emails. Add your own regex below for site-specific patterns (internal hostnames, etc.). One per line.</p>
              <textarea id="ai-custom-patterns" class="form-control mono" rows="4" style="font-family:'JetBrains Mono',monospace;font-size:11px" placeholder="Example:&#10;\\binternal-vpn-\\w+\\b">${Utils.escapeHtml((settings.customRedactionPatterns || []).join('\n'))}</textarea>
              <p class="text-sm text-muted" style="margin-top:6px;font-size:11px"><i class="fas fa-exclamation-triangle" style="color:var(--yellow);margin-right:4px"></i> Bad regex (catastrophic backtracking) aborts the AI call rather than sending unredacted data. Privacy beats utility.</p>
            </div>
          </details>
        </div>
      </div>
    `;

    const renderProviderFields = (providerId) => {
      const p = providers.find(x => x.id === providerId);
      const fields = document.getElementById('ai-provider-fields');
      if (!p) { fields.innerHTML = ''; return; }
      const selectedModel = settings.provider === p.id && settings.model ? settings.model : p.recommendedModel;
      const custom = Boolean(selectedModel && !p.models.some(model => model.id === selectedModel));

      fields.innerHTML = `
        <div class="form-group">
          <label for="ai-model">Model
            ${p.recommendedModel ? `<span class="text-muted text-sm" style="margin-left:6px;font-weight:normal">recommended: <code>${Utils.escapeHtml(p.recommendedModel)}</code></span>` : ''}
          </label>
          <select id="ai-model" class="form-control">
            ${p.models.map(m => `<option value="${Utils.escapeHtml(m.id)}" ${m.id === selectedModel ? 'selected' : ''}>${Utils.escapeHtml(m.label)}</option>`).join('')}
            <option value="" ${custom ? 'selected' : ''}>Custom model ID…</option>
          </select>
          <div id="ai-custom-model-wrap" ${custom ? '' : 'hidden'}>
            <input id="ai-custom-model" class="form-control" aria-label="Custom model ID" placeholder="Enter the provider's exact model ID"
              maxlength="200" value="${Utils.escapeHtml(custom ? selectedModel : '')}">
          </div>
        </div>
        ${p.requiresApiKey ? `
          <div class="form-group">
            <label>API Key</label>
            <div style="display:flex;gap:6px">
              <input type="password" id="ai-api-key" class="form-control" placeholder="${settings.hasApiKey && settings.provider === p.id ? '(saved — leave blank to keep)' : 'Paste your API key'}" autocomplete="new-password">
              ${settings.hasApiKey && settings.provider === p.id ? `<button class="btn btn-sm btn-secondary" id="ai-clear-key" type="button">Clear</button>` : ''}
            </div>
            <p class="text-sm text-muted" style="margin-top:4px;font-size:11px">Get a key: <a href="${Utils.escapeHtml(p.apiKeyHelpUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">${Utils.escapeHtml(p.apiKeyHelpUrl)}</a></p>
          </div>
        ` : ''}
        ${p.requiresEndpoint ? `
          <div class="form-group">
            <label>Endpoint URL</label>
            <input type="text" id="ai-endpoint" class="form-control" value="${Utils.escapeHtml(settings.endpointUrl || '')}" placeholder="${Utils.escapeHtml(p.endpointPlaceholder || '')}">
            <p class="text-sm text-muted" style="margin-top:4px;font-size:11px"><i class="fas fa-info-circle"></i> ${Utils.escapeHtml(p.privacyNote || '')}</p>
          </div>
        ` : `
          <p class="text-sm text-muted" style="margin-top:-6px;margin-bottom:10px;font-size:11px"><i class="fas fa-info-circle"></i> ${Utils.escapeHtml(p.privacyNote || '')}</p>
        `}
      `;

      document.getElementById('ai-clear-key')?.addEventListener('click', () => {
        document.getElementById('ai-api-key').value = '';
        document.getElementById('ai-api-key').dataset.cleared = '1';
        markDirty();
      });
      document.getElementById('ai-model').addEventListener('change', event => {
        document.getElementById('ai-custom-model-wrap').hidden = Boolean(event.target.value);
      });
    };

    const testButton = el.querySelector('#ai-test');
    const testResult = el.querySelector('#ai-test-result');
    const markDirty = () => {
      dirty = true;
      testButton.disabled = true;
      testResult.textContent = 'Save your changes before testing the connection.';
    };
    if (!settings.provider) {
      testButton.disabled = true;
      testResult.textContent = 'Save a provider before testing the connection.';
    }
    el.querySelector('.card').addEventListener('input', markDirty);
    el.querySelector('.card').addEventListener('change', markDirty);
    renderProviderFields(sel);

    el.querySelectorAll('input[name="ai-provider"]').forEach(r => {
      r.addEventListener('change', () => renderProviderFields(r.value));
    });

    document.getElementById('ai-save').addEventListener('click', async () => {
      const enabled = document.getElementById('ai-enabled').checked;
      const provider = el.querySelector('input[name="ai-provider"]:checked')?.value;
      const model = document.getElementById('ai-model')?.value || document.getElementById('ai-custom-model')?.value.trim();
      if (!model || !/^[!-~]{1,200}$/.test(model)) {
        Toast.error('Enter a valid model ID without spaces');
        return;
      }
      const apiKeyInput = document.getElementById('ai-api-key');
      const endpointInput = document.getElementById('ai-endpoint');
      const patternsRaw = document.getElementById('ai-custom-patterns').value || '';
      const customRedactionPatterns = patternsRaw.split('\n').map(l => l.trim()).filter(Boolean);

      const updates = { enabled, provider, model, customRedactionPatterns };
      if (apiKeyInput) {
        const v = apiKeyInput.value.trim();
        if (v) updates.apiKey = v;
        else if (apiKeyInput.dataset.cleared === '1') updates.apiKey = null;
        // else: undefined → leave alone
      }
      if (endpointInput) updates.endpointUrl = endpointInput.value.trim();

      const btn = document.getElementById('ai-save');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';
      try {
        await Api.put('/ai/settings', updates);
        Toast.success('AI settings saved');
        await this._renderAiSettings(el);
      } catch (err) {
        Toast.error(err.message);
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save"></i> Save';
      }
    });

    testButton.addEventListener('click', async () => {
      if (dirty || testing) return;
      testing = true;
      testButton.disabled = true;
      testButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing…';
      testResult.textContent = '';
      try {
        const r = await Api.post('/ai/test', {});
        if (dirty) return;
        if (r.ok) {
          testResult.textContent = ['Model available', r.modelEcho || r.model, Number.isFinite(r.latencyMs) ? `${r.latencyMs} ms` : ''].filter(Boolean).join(' · ');
        } else {
          testResult.textContent = [r.error || 'Connection test failed', r.httpStatus ? `HTTP ${r.httpStatus}` : r.code].filter(Boolean).join(' · ');
        }
      } catch (err) {
        if (!dirty) testResult.textContent = err.message;
      } finally {
        testing = false;
        testButton.disabled = dirty;
        testButton.innerHTML = '<i class="fas fa-plug"></i> Test connection';
      }
    });
  },
};

if (typeof window !== 'undefined') window.SettingsPageAi = SettingsPageAi;
