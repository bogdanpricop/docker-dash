/* ═══════════════════════════════════════════════════
   components/template-configurator.js — Template Configurator
   Interactive configuration form with live YAML preview
   ═══════════════════════════════════════════════════ */
'use strict';

const TemplateConfigurator = {

  /**
   * Open the configurator modal for a template
   * @param {Object} template - template object with { id, name, icon, compose, ... }
   * @param {Object} opts - { mode: 'view'|'deploy', onDeploy: fn, onCancel: fn }
   */
  open(template, opts = {}) {
    const mode = opts.mode || 'view';
    const onDeploy = opts.onDeploy || null;
    const onCancel = opts.onCancel || null;

    // Parse the compose YAML into configurable fields
    const fields = this._parseCompose(template.compose);
    const originalYaml = template.compose;

    // Build the modal HTML
    const el = document.createElement('div');
    el.className = 'tpl-configurator-root';
    el.innerHTML = `
      <div class="modal-header">
        <h3><i class="${template.icon || 'fas fa-cube'}" style="margin-right:8px;color:var(--accent)"></i>Configure: ${Utils.escapeHtml(template.name)}</h3>
        <button class="modal-close-btn" id="tplc-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="tpl-configurator">
        <div class="tpl-config-form">
          ${mode === 'deploy' ? `
          <div class="tpl-field-group">
            <div class="tpl-field-group-title"><i class="fas fa-tag"></i> Stack Name</div>
            <div class="form-group" style="margin-bottom:0">
              <input type="text" id="tplc-stack-name" class="form-control" value="${Utils.escapeHtml(template.id)}" placeholder="my-stack">
              <small class="text-muted">Letters, numbers, dashes and underscores only</small>
            </div>
          </div>` : ''}
          <div id="tplc-fields"></div>
          <div id="tplc-warnings" class="tpl-warnings"></div>
        </div>
        <div class="tpl-config-preview">
          <div class="tpl-preview-header">
            <span><i class="fas fa-file-code"></i> docker-compose.yml</span>
            <button class="btn btn-xs btn-secondary" id="tplc-copy" title="Copy YAML"><i class="fas fa-copy"></i> Copy</button>
          </div>
          <pre class="tpl-preview-yaml" id="tplc-yaml"></pre>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="tplc-cancel">${mode === 'deploy' ? 'Cancel' : 'Close'}</button>
        <button class="btn btn-secondary" id="tplc-synology" title="Export a Synology DSM Container Manager-friendly compose.yml (strips configs/secrets/healthcheck, rewrites volumes to /volume1/docker/<stack>/<service>/ bind mounts)"><i class="fas fa-server"></i> Synology export</button>
        ${mode === 'deploy' ? '<button class="btn btn-primary" id="tplc-deploy"><i class="fas fa-rocket"></i> Deploy</button>' : ''}
      </div>
    `;

    Modal.open(el, { width: '900px' });

    // Render fields
    const fieldsContainer = el.querySelector('#tplc-fields');
    this._renderFields(fieldsContainer, fields);

    // Initial YAML render
    this._updatePreview(el, fields, originalYaml);

    // Bind events
    el.querySelector('#tplc-close').addEventListener('click', () => { Modal.close(); if (onCancel) setTimeout(onCancel, 250); });
    el.querySelector('#tplc-cancel').addEventListener('click', () => { Modal.close(); if (onCancel) setTimeout(onCancel, 250); });

    el.querySelector('#tplc-copy').addEventListener('click', () => {
      const yaml = this._buildYaml(fields, originalYaml);
      Utils.copyToClipboard(yaml).then(() => Toast.success('Copied!'));
    });

    // Synology export — convert the live YAML to a DSM Container Manager-friendly form
    el.querySelector('#tplc-synology').addEventListener('click', () => {
      const nameInput = el.querySelector('#tplc-stack-name');
      const stackName = (nameInput && nameInput.value.trim()) || template.id;
      const yaml = this._buildYaml(fields, originalYaml);
      const synYaml = this._toSynologyCompose(yaml, stackName);
      this._showSynologyExport(stackName, synYaml);
    });

    // Live preview updates
    fieldsContainer.addEventListener('input', () => {
      this._syncFieldValues(fieldsContainer, fields);
      this._updatePreview(el, fields, originalYaml);
    });
    fieldsContainer.addEventListener('change', () => {
      this._syncFieldValues(fieldsContainer, fields);
      this._updatePreview(el, fields, originalYaml);
    });

    // Deploy button
    if (mode === 'deploy' && el.querySelector('#tplc-deploy')) {
      el.querySelector('#tplc-deploy').addEventListener('click', async () => {
        const nameInput = el.querySelector('#tplc-stack-name');
        const stackName = nameInput ? nameInput.value.trim() : template.id;
        if (!stackName || !/^[a-zA-Z0-9_-]+$/.test(stackName)) {
          Toast.error('Invalid stack name — letters, numbers, dashes, underscores only');
          if (nameInput) nameInput.focus();
          return;
        }

        // Check for validation issues
        const issues = this._validate(fields);
        if (issues.some(w => w.level === 'error')) {
          Toast.error('Fix errors before deploying');
          return;
        }

        const yaml = this._buildYaml(fields, originalYaml);
        Modal.close();

        if (onDeploy) {
          onDeploy({ name: stackName, compose: yaml });
        }
      });
    }

    // Length sliders — update label on drag
    fieldsContainer.querySelectorAll('.tplc-gen-length').forEach(slider => {
      slider.addEventListener('input', () => {
        const label = slider.closest('.tpl-field-generate-row')?.querySelector(`.tplc-gen-length-label[data-field-id="${slider.dataset.fieldId}"]`);
        if (label) label.textContent = slider.value;
      });
    });

    // Generate buttons
    fieldsContainer.querySelectorAll('.tplc-generate-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fieldItem = btn.closest('.tpl-field-item');
        const input = fieldItem?.querySelector('input.tplc-input');
        if (input) {
          const lengthSlider = fieldItem.querySelector('.tplc-gen-length');
          const len = lengthSlider ? parseInt(lengthSlider.value) || 32 : 32;
          const generated = this._generatePassword(len);
          input.value = generated;
          input.type = 'text'; // show generated password
          // Update the field object directly
          const fieldId = btn.dataset.fieldId;
          const field = fields.find(f => f.id === fieldId);
          if (field) field.value = generated;
          // Update strength bar + warning
          const warningEl = fieldItem.querySelector('.tpl-field-warning');
          if (warningEl) warningEl.remove();
          const strengthContainer = fieldItem.querySelector('.tpl-password-strength');
          if (strengthContainer) {
            const strength = this._passwordStrength(generated);
            const colors = { weak: '#f85149', fair: '#d29922', good: '#3fb950', strong: '#58a6ff' };
            const widths = { weak: '25%', fair: '50%', good: '75%', strong: '100%' };
            const fill = strengthContainer.querySelector('.tpl-strength-fill');
            if (fill) { fill.style.width = widths[strength]; fill.style.background = colors[strength]; }
            const label = strengthContainer.querySelector('span');
            if (label) { label.textContent = strength; label.style.color = colors[strength]; }
          }
          // Trigger preview update
          this._updatePreview(el, fields, originalYaml);
          fieldItem.classList.add('tpl-field-generated');
          setTimeout(() => fieldItem.classList.remove('tpl-field-generated'), 1200);
        }
      });
    });

    // Toggle password visibility
    fieldsContainer.querySelectorAll('.tplc-toggle-vis').forEach(btn => {
      btn.addEventListener('click', () => {
        const fieldId = btn.dataset.fieldId;
        const input = fieldsContainer.querySelector(`input.tplc-input[data-field-id="${fieldId}"]`);
        if (input) {
          const isPass = input.type === 'password';
          input.type = isPass ? 'text' : 'password';
          btn.innerHTML = isPass ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
        }
      });
    });
  },

  // ─── YAML Parser ─────────────────────────────────────────

  _parseCompose(yaml) {
    const fields = [];
    const lines = yaml.split('\n');
    let currentService = null;
    let inEnvironment = false;
    let inPorts = false;
    let inVolumes = false;
    let inTopVolumes = false;
    let envIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;

      // Track services
      if (/^services:\s*$/.test(trimmed)) {
        currentService = null;
        inEnvironment = false;
        inPorts = false;
        inVolumes = false;
        inTopVolumes = false;
        continue;
      }

      // Top-level volumes section
      if (/^volumes:\s*$/.test(trimmed) && indent === 0) {
        inTopVolumes = true;
        inEnvironment = false;
        inPorts = false;
        inVolumes = false;
        currentService = null;
        continue;
      }

      // Service name detection (indent 2 under services)
      if (indent === 2 && trimmed.endsWith(':') && !inTopVolumes) {
        const svcName = trimmed.slice(0, -1);
        if (svcName && !['environment', 'ports', 'volumes', 'depends_on', 'command', 'labels', 'cap_add', 'sysctls', 'networks'].includes(svcName)) {
          currentService = svcName;
          inEnvironment = false;
          inPorts = false;
          inVolumes = false;

          // Add container_name field if the line defines it explicitly
          continue;
        }
      }

      if (!currentService && !inTopVolumes) continue;

      // Detect sections within a service
      if (indent === 4 && currentService) {
        if (trimmed === 'environment:') { inEnvironment = true; inPorts = false; inVolumes = false; envIndent = 6; continue; }
        if (trimmed === 'ports:') { inPorts = true; inEnvironment = false; inVolumes = false; continue; }
        if (trimmed === 'volumes:') { inVolumes = true; inEnvironment = false; inPorts = false; continue; }
        if (trimmed.endsWith(':') || trimmed.match(/^\w+:/)) {
          inEnvironment = false;
          inPorts = false;
          inVolumes = false;
        }
      }

      // Parse image tag
      if (indent === 4 && currentService && /^image:\s*(.+)$/.test(trimmed)) {
        const imageVal = trimmed.replace(/^image:\s*/, '');
        fields.push({
          id: `${currentService}__image`,
          service: currentService,
          type: 'image',
          label: 'Image',
          key: 'image',
          value: imageVal,
          original: imageVal,
          line: i,
        });
        continue;
      }

      // Parse container_name
      if (indent === 4 && currentService && /^container_name:\s*(.+)$/.test(trimmed)) {
        const nameVal = trimmed.replace(/^container_name:\s*/, '');
        fields.push({
          id: `${currentService}__container_name`,
          service: currentService,
          type: 'text',
          label: 'Container Name',
          key: 'container_name',
          value: nameVal,
          original: nameVal,
          line: i,
          group: 'general',
        });
        continue;
      }

      // Parse environment variables (both map and list format)
      if (inEnvironment && indent >= envIndent && currentService) {
        let envKey, envVal;
        // Map format: KEY: value
        const mapMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
        // List format: - KEY=value
        const listMatch = trimmed.match(/^-\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        // List format without value: - KEY (boolean flag)
        const listFlagMatch = trimmed.match(/^-\s*([A-Za-z_][A-Za-z0-9_]*)$/);

        if (mapMatch) {
          envKey = mapMatch[1];
          envVal = mapMatch[2].replace(/^["']|["']$/g, '');
        } else if (listMatch) {
          envKey = listMatch[1];
          envVal = listMatch[2].replace(/^["']|["']$/g, '');
        } else if (listFlagMatch) {
          envKey = listFlagMatch[1];
          envVal = 'true';
        } else {
          continue;
        }

        const fieldType = this._detectFieldType(envKey, envVal);
        fields.push({
          id: `${currentService}__env__${envKey}`,
          service: currentService,
          type: fieldType,
          label: envKey,
          key: envKey,
          value: envVal,
          original: envVal,
          line: i,
          group: 'env',
          category: this._detectCategory(envKey),
        });
        continue;
      }

      // Parse port mappings
      if (inPorts && indent >= 6 && currentService) {
        const portMatch = trimmed.match(/^-\s*"?(\d+):(\d+)(?:\/(\w+))?"?$/);
        if (portMatch) {
          const hostPort = portMatch[1];
          const containerPort = portMatch[2];
          const proto = portMatch[3] || 'tcp';
          fields.push({
            id: `${currentService}__port__${containerPort}_${proto}`,
            service: currentService,
            type: 'port',
            label: `Port (${containerPort}/${proto})`,
            key: `${containerPort}/${proto}`,
            value: hostPort,
            original: hostPort,
            containerPort,
            proto,
            line: i,
            group: 'ports',
          });
        }
        continue;
      }

      // Parse volume mounts (only host-path mounts, not named volumes)
      if (inVolumes && indent >= 6 && currentService) {
        const volMatch = trimmed.match(/^-\s*(.+):(.+?)(?::(\w+))?$/);
        if (volMatch) {
          const src = volMatch[1];
          const dest = volMatch[2];
          const mode = volMatch[3] || '';
          // Only show editable fields for host-path mounts (start with . or /)
          if (src.startsWith('.') || src.startsWith('/')) {
            fields.push({
              id: `${currentService}__vol__${i}`,
              service: currentService,
              type: 'path',
              label: `Volume (${dest})`,
              key: dest,
              value: src,
              original: src,
              dest,
              mode,
              line: i,
              group: 'volumes',
            });
          }
        }
        continue;
      }
    }

    return fields;
  },

  // Comprehensive password / credential detection. Misses here = no Generate
  // button on a real password field; false positive = an extra Generate button
  // on a non-password (harmless — user just won't click). Bias toward catching.
  _isSecretKey(key) {
    const k = key.toUpperCase();
    // word boundary-ish matches so BYPASS / PASSPORT / KEYSTORE don't match
    if (/(^|[_-])(PASSWORD|PASSWD|PASS|PWD|PW|PASSPHRASE|SECRET|SECRETS|TOKEN|API_?KEY|APIKEY|MASTER_?KEY|PRIVATE_?KEY|JWT|SALT|CREDENTIALS?)([_-]|$)/.test(k)) return true;
    // also any *_KEY when the suffix isn't STORE/FILE/PATH/ALG (catches FLASK_SECRET_KEY, APP_KEY, JWT_KEY, …)
    if (/_KEY([_-]|$)/.test(k) && !/_KEY_?(STORE|FILE|PATH|ALG|ALGORITHM|TYPE)([_-]|$)/.test(k)) return true;
    return false;
  },

  // Treat as password by value too: if the default LOOKS like a placeholder
  // password ("changeme", "your-secret", "changeme123", base64:CHANGE…), it
  // is one — even if the KEY doesn't say PASSWORD anywhere.
  _looksLikePasswordValue(value) {
    if (typeof value !== 'string' || !value) return false;
    const v = value.toLowerCase();
    if (/^(changeme|change_?me|change-?me|your-?secret|password|secret123?|admin123?|rootchangeme)/i.test(v)) return true;
    if (/changeme|change_me|change-me/.test(v)) return true;
    if (/^base64:.*change/i.test(value)) return true;
    if (/generate[_-]?(strong|random|secure)|generate[_-]?with[_-]?openssl|generate.{0,4}(secret|key|chars?|bytes?)/i.test(value)) return true;
    return false;
  },

  _detectFieldType(key, value) {
    if (this._isSecretKey(key)) return 'password';
    if (this._looksLikePasswordValue(value)) return 'password';
    const k = key.toUpperCase();
    if (k.includes('PORT')) return 'port';
    if (k.includes('URL') || k.includes('HOST') || k.includes('DOMAIN')) return 'url';
    if (k.includes('EMAIL') || k.includes('MAIL_TO') || k.includes('SMTP_FROM')) return 'email';
    if (k.includes('USER') || k.includes('USERNAME')) return 'text';
    if (k.includes('_DB') || k.includes('DATABASE')) return 'text';
    if (value === 'true' || value === 'false') return 'toggle';
    if (/^\d+$/.test(value)) return 'number';
    return 'text';
  },

  _detectCategory(key) {
    if (this._isSecretKey(key)) return 'security';
    const k = key.toUpperCase();
    if (k.includes('AUTH')) return 'security';
    if (k.includes('PORT')) return 'ports';
    if (k.includes('URL') || k.includes('HOST') || k.includes('DOMAIN') || k.includes('TRUSTED') || k.includes('ADDRESS')) return 'network';
    if (k.includes('DB') || k.includes('DATABASE') || k.includes('MYSQL') || k.includes('POSTGRES') || k.includes('MONGO') || k.includes('REDIS')) return 'database';
    if (k.includes('USER') || k.includes('ADMIN') || k.includes('EMAIL')) return 'identity';
    if (k.includes('JAVA') || k.includes('MEMORY') || k.includes('CPU') || k.includes('LIMIT')) return 'resources';
    return 'general';
  },

  // ─── Field Rendering ─────────────────────────────────────

  _renderFields(container, fields) {
    // Group fields by service, then by category
    const grouped = {};
    for (const f of fields) {
      const svc = f.service || '_global';
      if (!grouped[svc]) grouped[svc] = {};
      const cat = f.group === 'ports' ? 'ports' : f.group === 'volumes' ? 'storage' : (f.category || 'general');
      if (!grouped[svc][cat]) grouped[svc][cat] = [];
      grouped[svc][cat][cat] = grouped[svc][cat] || [];
      grouped[svc][cat].push(f);
    }

    const categoryLabels = {
      ports: { icon: 'fas fa-plug', label: 'Ports' },
      security: { icon: 'fas fa-shield-alt', label: 'Security' },
      identity: { icon: 'fas fa-user', label: 'Identity' },
      database: { icon: 'fas fa-database', label: 'Database' },
      network: { icon: 'fas fa-network-wired', label: 'Network' },
      storage: { icon: 'fas fa-hdd', label: 'Storage' },
      resources: { icon: 'fas fa-microchip', label: 'Resources' },
      general: { icon: 'fas fa-cog', label: 'Configuration' },
    };
    const catOrder = ['ports', 'security', 'identity', 'database', 'network', 'storage', 'resources', 'general'];

    let html = '';
    const serviceNames = Object.keys(grouped);

    for (const svc of serviceNames) {
      if (serviceNames.length > 1) {
        html += `<div class="tpl-service-header"><i class="fas fa-cube"></i> ${Utils.escapeHtml(svc)}</div>`;
      }

      const cats = grouped[svc];
      for (const cat of catOrder) {
        if (!cats[cat] || cats[cat].length === 0) continue;
        const meta = categoryLabels[cat] || categoryLabels.general;
        html += `<div class="tpl-field-group">`;
        html += `<div class="tpl-field-group-title"><i class="${meta.icon}"></i> ${meta.label}</div>`;
        for (const f of cats[cat]) {
          html += this._renderField(f);
        }
        html += `</div>`;
      }
    }

    if (fields.length === 0) {
      html = '<div class="empty-msg" style="padding:24px;text-align:center"><i class="fas fa-info-circle"></i> No configurable fields detected in this template.</div>';
    }

    container.innerHTML = html;
  },

  _renderField(f) {
    let inputHtml = '';
    const escaped = Utils.escapeHtml(f.value);
    const labelText = f.group === 'env' ? f.key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/ /g, ' ') : f.label;

    switch (f.type) {
      case 'password': {
        const warnHtml = this._isWeakDefault(f.value) ? `<div class="tpl-field-warning" style="margin:4px 0"><i class="fas fa-exclamation-triangle"></i> Default password — change before deploying</div>` : '';
        inputHtml = `<div style="flex:1;min-width:0">
  <input type="password" class="form-control tplc-input" data-field-id="${f.id}" value="${escaped}" autocomplete="new-password" style="width:100%;box-sizing:border-box;font-family:var(--mono);font-size:12px">
  <div class="tpl-field-generate-row" style="display:flex;align-items:center;gap:6px;margin-top:6px">
    <button type="button" class="btn btn-xs btn-secondary tplc-toggle-vis" data-field-id="${f.id}" title="Show/hide"><i class="fas fa-eye"></i></button>
    <span class="text-xs text-muted">Length:</span>
    <input type="range" class="tplc-gen-length" data-field-id="${f.id}" min="8" max="256" value="32" style="width:80px">
    <span class="tplc-gen-length-label text-xs mono" data-field-id="${f.id}" style="min-width:24px;text-align:right">32</span>
    <button type="button" class="btn btn-xs btn-accent tplc-generate-btn" data-field-id="${f.id}" title="Generate random" style="white-space:nowrap"><i class="fas fa-sync-alt"></i> Generate</button>
  </div>
  ${warnHtml}
  ${this._renderStrengthBar(f.value)}
</div>`;
        break;
      }

      case 'port':
        inputHtml = `<input type="number" class="form-control tplc-input" data-field-id="${f.id}" value="${escaped}" min="1" max="65535" style="max-width:120px">`;
        break;

      case 'toggle':
        const isOn = f.value === 'true';
        inputHtml = `
          <label class="tpl-toggle">
            <input type="checkbox" class="tplc-input tplc-toggle-input" data-field-id="${f.id}" ${isOn ? 'checked' : ''}>
            <span class="tpl-toggle-slider"></span>
            <span class="tpl-toggle-label">${isOn ? 'true' : 'false'}</span>
          </label>`;
        break;

      case 'number':
        inputHtml = `<input type="number" class="form-control tplc-input" data-field-id="${f.id}" value="${escaped}" style="max-width:150px">`;
        break;

      case 'email':
        inputHtml = `<input type="email" class="form-control tplc-input" data-field-id="${f.id}" value="${escaped}" placeholder="user@example.com">`;
        break;

      case 'url':
        inputHtml = `<input type="text" class="form-control tplc-input" data-field-id="${f.id}" value="${escaped}" placeholder="http://localhost">`;
        break;

      case 'path':
        inputHtml = `
          <div class="tpl-field-path-row">
            <input type="text" class="form-control tplc-input" data-field-id="${f.id}" value="${escaped}" placeholder="/path/to/data">
            <span class="text-muted text-sm"><i class="fas fa-folder"></i></span>
          </div>`;
        break;

      case 'image':
        const parts = f.value.split(':');
        const imgName = parts.slice(0, -1).join(':') || f.value;
        const imgTag = parts.length > 1 ? parts[parts.length - 1] : 'latest';
        inputHtml = `
          <div class="tpl-field-image-row">
            <input type="text" class="form-control tplc-input" data-field-id="${f.id}" value="${escaped}" style="font-family:var(--mono);font-size:12px">
          </div>`;
        break;

      default:
        inputHtml = `<input type="text" class="form-control tplc-input" data-field-id="${f.id}" value="${escaped}">`;
    }

    return `
      <div class="tpl-field-item" data-field-id="${f.id}">
        <label class="tpl-field-label" title="${Utils.escapeHtml(f.key)}">${Utils.escapeHtml(labelText)}</label>
        ${inputHtml}
      </div>`;
  },

  _renderStrengthBar(password) {
    const strength = this._passwordStrength(password);
    const colors = { weak: '#f85149', fair: '#d29922', good: '#3fb950', strong: '#58a6ff' };
    const widths = { weak: '25%', fair: '50%', good: '75%', strong: '100%' };
    return `<div class="tpl-password-strength">
      <div class="tpl-strength-bar"><div class="tpl-strength-fill" style="width:${widths[strength]};background:${colors[strength]}"></div></div>
      <span class="text-sm" style="color:${colors[strength]}">${strength}</span>
    </div>`;
  },

  _passwordStrength(pw) {
    if (!pw || pw.length < 6) return 'weak';
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (pw.length >= 20) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^a-zA-Z0-9]/.test(pw)) score++;
    if (this._isWeakDefault(pw)) return 'weak';
    if (score <= 2) return 'fair';
    if (score <= 4) return 'good';
    return 'strong';
  },

  _isWeakDefault(val) {
    const weak = ['changeme', 'admin', 'password', 'secret', 'root', 'test', 'dev-secret', 'changeme123',
      'changeme-generate-strong-secret', 'changeme_generate_64_chars', 'rootchangeme'];
    return weak.includes(val.toLowerCase());
  },

  // ─── Value Sync ──────────────────────────────────────────

  _syncFieldValues(container, fields) {
    for (const f of fields) {
      const input = container.querySelector(`input[data-field-id="${f.id}"], select[data-field-id="${f.id}"]`);
      if (!input) continue;
      if (f.type === 'toggle') {
        f.value = input.checked ? 'true' : 'false';
        const label = input.closest('.tpl-toggle')?.querySelector('.tpl-toggle-label');
        if (label) label.textContent = f.value;
      } else {
        f.value = input.value || '';
      }
    }
  },

  // ─── YAML Builder ────────────────────────────────────────

  _buildYaml(fields, originalYaml) {
    const lines = originalYaml.split('\n');

    for (const f of fields) {
      if (f.value === undefined || f.value === null) f.value = '';
      const line = lines[f.line];
      if (!line) continue;
      const indent = line.length - line.trimStart().length;
      const trimmed = line.trim();

      if (f.group === 'env') {
        // Map format: KEY: value
        const mapMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*/);
        if (mapMatch) {
          const needsQuote = this._needsYamlQuote(f.value);
          lines[f.line] = ' '.repeat(indent) + f.key + ': ' + (needsQuote ? '"' + f.value.replace(/"/g, '\\"') + '"' : f.value);
          continue;
        }
        // List format: - KEY=value
        const listMatch = trimmed.match(/^-\s*([A-Za-z_][A-Za-z0-9_]*)=/);
        if (listMatch) {
          lines[f.line] = ' '.repeat(indent) + '- ' + f.key + '=' + f.value;
          continue;
        }
      }

      if (f.group === 'ports' || f.type === 'port') {
        const portMatch = trimmed.match(/^-\s*"?(\d+):(\d+)(?:\/(\w+))?"?$/);
        if (portMatch) {
          const proto = portMatch[3];
          const portStr = proto ? `"${f.value}:${f.containerPort}/${proto}"` : `"${f.value}:${f.containerPort}"`;
          lines[f.line] = ' '.repeat(indent) + '- ' + portStr;
          continue;
        }
      }

      if (f.type === 'path' && f.group === 'volumes') {
        const modeStr = f.mode ? ':' + f.mode : '';
        lines[f.line] = ' '.repeat(indent) + '- ' + f.value + ':' + f.dest + modeStr;
        continue;
      }

      if (f.type === 'image') {
        lines[f.line] = ' '.repeat(indent) + 'image: ' + f.value;
        continue;
      }

      if (f.key === 'container_name') {
        lines[f.line] = ' '.repeat(indent) + 'container_name: ' + f.value;
        continue;
      }
    }

    return lines.join('\n');
  },

  _needsYamlQuote(val) {
    if (!val) return true;
    // Quote if starts/ends with space, contains special chars, or looks like a number/bool
    if (/^[\s]|[\s]$/.test(val)) return true;
    if (/^(true|false|yes|no|null|~)$/i.test(val)) return true;
    if (/[:#\[\]{}&*!|>'"`,@]/.test(val)) return true;
    return false;
  },

  // ─── Preview ─────────────────────────────────────────────

  _updatePreview(root, fields, originalYaml) {
    const yaml = this._buildYaml(fields, originalYaml);
    const previewEl = root.querySelector('#tplc-yaml');
    if (!previewEl) return;

    // Highlight changed lines
    const origLines = originalYaml.split('\n');
    const newLines = yaml.split('\n');
    let html = '';
    for (let i = 0; i < newLines.length; i++) {
      const line = newLines[i];
      const changed = origLines[i] !== undefined && origLines[i] !== line;
      const escaped = Utils.escapeHtml(line);
      if (changed) {
        html += `<span class="tpl-preview-changed">${escaped}</span>\n`;
      } else {
        html += escaped + '\n';
      }
    }
    previewEl.innerHTML = html;

    // Update warnings
    this._updateWarnings(root, fields);
  },

  // ─── Validation / Warnings ───────────────────────────────

  _validate(fields) {
    const issues = [];
    const usedPorts = {};

    for (const f of fields) {
      // Weak passwords
      if (f.type === 'password' && this._isWeakDefault(f.value)) {
        issues.push({ level: 'warn', message: `${f.key} is still a default password` });
      }

      // Port validation
      if (f.type === 'port' || (f.group === 'ports')) {
        const p = parseInt(f.value, 10);
        if (isNaN(p) || p < 1 || p > 65535) {
          issues.push({ level: 'error', message: `${f.label}: port must be 1-65535` });
        } else if (usedPorts[p]) {
          issues.push({ level: 'error', message: `Port ${p} is used by both ${usedPorts[p]} and ${f.service}` });
        } else {
          usedPorts[p] = f.service;
        }
      }

      // Empty required fields (passwords, env vars)
      if (f.group === 'env' && !f.value && f.type !== 'toggle') {
        issues.push({ level: 'warn', message: `${f.key} is empty` });
      }
    }

    return issues;
  },

  _updateWarnings(root, fields) {
    const container = root.querySelector('#tplc-warnings');
    if (!container) return;

    const issues = this._validate(fields);
    if (issues.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = issues.map(w => {
      const icon = w.level === 'error' ? 'fa-times-circle' : 'fa-exclamation-triangle';
      const cls = w.level === 'error' ? 'tpl-warning-error' : 'tpl-warning-warn';
      return `<div class="tpl-warning-item ${cls}"><i class="fas ${icon}"></i> ${Utils.escapeHtml(w.message)}</div>`;
    }).join('');
  },

  // ─── Password Generator ──────────────────────────────────

  _generatePassword(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*_-+=';
    const arr = new Uint32Array(length);
    crypto.getRandomValues(arr);
    return Array.from(arr, v => chars[v % chars.length]).join('');
  },

  /**
   * Convert a docker-compose YAML to a Synology DSM Container Manager-friendly
   * form. DSM accepts compose v3 but does not apply: top-level configs/secrets,
   * per-service configs/secrets/healthcheck/deploy.resources, and prefers bind
   * mounts under /volume1/docker/<stack>/<service>/ over named volumes (so they
   * show up in File Station and back up cleanly). Hand-rolled line transformer
   * — fine because the source is OUR controlled templates' regular indent.
   */
  _toSynologyCompose(composeYaml, stackName) {
    const lines = composeYaml.split('\n');
    const out = [];
    let topBlock = null;
    let skipUntilIndent = -1;
    let currentService = null;

    for (const line of lines) {
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;

      if (skipUntilIndent >= 0) {
        if (trimmed === '' || indent > skipUntilIndent) continue;
        skipUntilIndent = -1;
        // fall through to re-process this line
      }

      // Top-level keys (indent 0, key:)
      if (indent === 0 && /^[\w-]+:\s*$/.test(trimmed)) {
        const key = trimmed.slice(0, -1);
        topBlock = key;
        currentService = null;
        if (['volumes', 'configs', 'secrets'].includes(key)) {
          skipUntilIndent = 0;
          continue;
        }
        out.push(line);
        continue;
      }

      // Service name (indent 2 under services:)
      if (topBlock === 'services' && indent === 2 && /^[\w-]+:\s*$/.test(trimmed)) {
        currentService = trimmed.slice(0, -1);
        out.push(line);
        continue;
      }

      // Per-service blocks DSM can't apply
      if (topBlock === 'services' && currentService && indent === 4
          && /^(configs|secrets|healthcheck|deploy):\s*$/.test(trimmed)) {
        skipUntilIndent = 4;
        continue;
      }

      // Volume rewrite inside a service's volumes: list.
      // Match "- src:/dest[:mode]" where src is NOT an absolute path
      // (i.e. named volume or ./relative). Skip socket mounts (/var/run/...).
      if (currentService && indent >= 6 && /^- /.test(trimmed)) {
        const m = trimmed.match(/^- (.+?):(\/[^:]+)(:[a-zA-Z,]+)?$/);
        if (m) {
          const src = m[1].trim().replace(/^['"]|['"]$/g, '');
          const dest = m[2];
          const mode = m[3] || '';
          if (src && !src.startsWith('/')) {
            const cleanSrc = src.startsWith('./') ? src.substring(2) : src;
            const newSrc = `/volume1/docker/${stackName}/${currentService}/${cleanSrc}`;
            out.push(' '.repeat(indent) + `- ${newSrc}:${dest}${mode}`);
            continue;
          }
        }
      }

      out.push(line);
    }

    // Trim trailing blank lines
    while (out.length && !out[out.length - 1].trim()) out.pop();

    const header = [
      `# Generated for Synology DSM Container Manager (Docker package).`,
      `# Import: Container Manager → Project → Create → "Create docker-compose.yml" → paste this content.`,
      `# Before deploying, create these folders in File Station (one per service):`,
      `#   /volume1/docker/${stackName}/<service>/`,
      `# Stripped (DSM does not apply): top-level volumes/configs/secrets, per-service`,
      `# configs/secrets/healthcheck/deploy. If your stack needed a healthcheck-gated`,
      `# depends_on (condition: service_healthy), it will start on plain restart-loop`,
      `# behavior — usually fine with restart: unless-stopped.`,
      ``,
    ].join('\n');
    return header + out.join('\n') + '\n';
  },

  _showSynologyExport(stackName, syn) {
    const filename = `compose.${stackName}.synology.yml`;
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-server" style="color:var(--accent);margin-right:8px"></i>Synology DSM compose — ${Utils.escapeHtml(stackName)}</h3>
        <button class="modal-close-btn" id="syn-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <p class="text-muted text-sm" style="margin-bottom:8px">Paste this into Container Manager → Project → Create → "Create docker-compose.yml". Volume folders must exist in File Station first (see header).</p>
        <pre class="inspect-json" style="max-height:60vh;overflow:auto;white-space:pre;font-size:12px;border:1px solid var(--border);border-radius:4px;padding:10px">${Utils.escapeHtml(syn)}</pre>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="syn-download"><i class="fas fa-download"></i> Download .yml</button>
        <button class="btn btn-secondary" id="syn-copy"><i class="fas fa-copy"></i> Copy</button>
        <button class="btn btn-primary" id="syn-ok">Close</button>
      </div>
    `;
    const sub = Modal.openSub(html, { width: 'min(900px, 95vw)' });
    sub.querySelector('#syn-x').addEventListener('click', () => Modal.closeSub());
    sub.querySelector('#syn-ok').addEventListener('click', () => Modal.closeSub());
    sub.querySelector('#syn-copy').addEventListener('click', () => {
      Utils.copyToClipboard(syn).then(() => Toast.success('Copied!'));
    });
    sub.querySelector('#syn-download').addEventListener('click', () => {
      Utils.downloadBlob(filename, new Blob([syn], { type: 'text/yaml;charset=utf-8' }));
    });
  },
};

window.TemplateConfigurator = TemplateConfigurator;
