/* global Utils */
'use strict';

/**
 * No-build visual editor for the common Docker Compose service fields.
 *
 * The component edits the same YAML document as YamlEditor. It uses the
 * vendored `yaml` browser module so untouched nodes and comments survive a
 * Form -> YAML round-trip. Unsupported service fields are left untouched and
 * called out explicitly in the UI.
 */
const ComposeServiceForm = (() => {
  const SUPPORTED_FIELDS = new Set([
    'image', 'restart', 'ports', 'environment', 'volumes', 'depends_on', 'networks',
  ]);
  const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
  const ENV_NAME = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;
  let yamlModulePromise = null;

  function loadYamlModule() {
    if (!yamlModulePromise) yamlModulePromise = import('/vendor/yaml/browser/index.js');
    return yamlModulePromise;
  }

  function parseDocument(text, YAML) {
    const documentNode = YAML.parseDocument(String(text || ''), {
      keepSourceTokens: true, prettyErrors: true, uniqueKeys: true,
    });
    if (documentNode.errors.length) throw documentNode.errors[0];
    const value = documentNode.toJS() || {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Compose YAML must contain a mapping at the document root');
    }
    if (value.services !== undefined
      && (!value.services || typeof value.services !== 'object' || Array.isArray(value.services))) {
      throw new Error('Compose services must be a mapping');
    }
    return { documentNode, value };
  }

  function listText(value) {
    if (!Array.isArray(value)) return '';
    return value.map(item => typeof item === 'object' && item !== null
      ? JSON.stringify(item) : String(item)).join('\n');
  }

  function mappingText(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    return Object.entries(value).map(([key, item]) => item === null || item === undefined
      ? key : `${key}=${typeof item === 'object' ? JSON.stringify(item) : item}`).join('\n');
  }

  function dependencyText(value) {
    if (Array.isArray(value)) return value.join('\n');
    if (value && typeof value === 'object') return Object.keys(value).join('\n');
    return '';
  }

  function extractServices(text, YAML) {
    const { value } = parseDocument(text, YAML);
    return Object.entries(value.services || {}).map(([name, serviceValue]) => {
      const service = serviceValue && typeof serviceValue === 'object' && !Array.isArray(serviceValue)
        ? serviceValue : {};
      const environmentStyle = service.environment && !Array.isArray(service.environment) ? 'mapping' : 'list';
      const dependsOnStyle = service.depends_on && !Array.isArray(service.depends_on) ? 'mapping' : 'list';
      const networksStyle = service.networks && !Array.isArray(service.networks) ? 'mapping' : 'list';
      return {
        originalName: name,
        name,
        image: service.image === undefined ? '' : String(service.image),
        restart: service.restart === undefined ? '' : String(service.restart),
        portsText: listText(service.ports),
        environmentText: Array.isArray(service.environment)
          ? listText(service.environment) : mappingText(service.environment),
        volumesText: listText(service.volumes),
        dependsOnText: dependencyText(service.depends_on),
        networksText: dependencyText(service.networks),
        environmentStyle,
        dependsOnStyle,
        networksStyle,
        unsupported: Object.keys(service).filter(key => !SUPPORTED_FIELDS.has(key)),
        removed: false,
      };
    });
  }

  function lines(value) {
    return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  }

  function parseStructuredList(value, field, errors, serviceName) {
    return lines(value).map((line, index) => {
      if (line.startsWith('{') || line.startsWith('[')) {
        try { return JSON.parse(line); }
        catch { errors.push({ service: serviceName, field, message: `Line ${index + 1} is not valid JSON` }); }
      }
      return line;
    });
  }

  function parseEnvironment(value, style, errors, serviceName) {
    const entries = lines(value);
    if (style !== 'mapping') {
      for (const [index, entry] of entries.entries()) {
        const key = entry.split('=', 1)[0];
        if (!ENV_NAME.test(key)) {
          errors.push({ service: serviceName, field: 'environment', message: `Line ${index + 1} has an invalid variable name` });
        }
      }
      return entries;
    }
    const result = {};
    for (const [index, entry] of entries.entries()) {
      const separator = entry.indexOf('=');
      const key = separator < 0 ? entry : entry.slice(0, separator);
      if (!ENV_NAME.test(key)) {
        errors.push({ service: serviceName, field: 'environment', message: `Line ${index + 1} has an invalid variable name` });
        continue;
      }
      result[key] = separator < 0 ? null : entry.slice(separator + 1);
    }
    return result;
  }

  function parseNamedCollection(value, style, field, errors, serviceName, previous) {
    const names = lines(value);
    names.forEach((name, index) => {
      if (!SERVICE_NAME.test(name)) {
        errors.push({ service: serviceName, field, message: `Line ${index + 1} has an invalid name` });
      }
    });
    if (style !== 'mapping') return names;
    return Object.fromEntries(names.map(name => [name,
      previous && typeof previous === 'object' && !Array.isArray(previous) && previous[name] !== undefined
        ? previous[name] : null]));
  }

  function validateServices(services) {
    const errors = [];
    const names = new Set();
    for (const [index, service] of services.entries()) {
      if (service.removed) continue;
      const name = String(service.name || '').trim();
      if (!SERVICE_NAME.test(name)) errors.push({ index, service: name || `#${index + 1}`, field: 'name', message: 'Use letters, digits, dot, underscore, or dash' });
      if (names.has(name)) errors.push({ index, service: name, field: 'name', message: 'Service name must be unique' });
      names.add(name);
      if (!service.originalName && !String(service.image || '').trim()) {
        errors.push({ index, service: name, field: 'image', message: 'Image is required for a service created in Form view' });
      }
      const restart = String(service.restart || '').trim();
      if (restart && !/^(no|always|unless-stopped|on-failure(?::\d+)?)$/.test(restart)) {
        errors.push({ index, service: name, field: 'restart', message: 'Unsupported restart policy' });
      }
      lines(service.portsText).forEach((port, lineIndex) => {
        if (!port.startsWith('{') && /\s/.test(port)) {
          errors.push({ index, service: name, field: 'ports', message: `Line ${lineIndex + 1} contains whitespace` });
        }
      });
      lines(service.volumesText).forEach((volume, lineIndex) => {
        if (!volume.startsWith('{') && !volume.includes(':') && !volume.startsWith('/')) {
          errors.push({ index, service: name, field: 'volumes', message: `Line ${lineIndex + 1} needs a container path or source:target` });
        }
      });
    }
    return errors;
  }

  function setOrDelete(documentNode, pathParts, value) {
    const emptyArray = Array.isArray(value) && value.length === 0;
    const emptyObject = value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 0;
    if (value === undefined || value === '' || emptyArray || emptyObject) documentNode.deleteIn(pathParts);
    else documentNode.setIn(pathParts, value);
  }

  function applyChanges(text, services, YAML) {
    const initialErrors = validateServices(services);
    if (initialErrors.length) return { valid: false, errors: initialErrors, yaml: text };
    const { documentNode, value } = parseDocument(text, YAML);
    if (!value.services) documentNode.set('services', documentNode.createNode({}));
    const previousServices = value.services || {};
    const parseErrors = [];
    const renames = new Map(services
      .filter(service => !service.removed && service.originalName && service.originalName !== service.name)
      .map(service => [service.originalName, String(service.name || '').trim()]));

    for (const service of services) {
      const originalName = service.originalName || '';
      const name = String(service.name || '').trim();
      if (service.removed) {
        if (originalName) documentNode.deleteIn(['services', originalName]);
        continue;
      }

      if (originalName && originalName !== name) {
        const originalNode = documentNode.getIn(['services', originalName], true);
        documentNode.deleteIn(['services', originalName]);
        documentNode.setIn(['services', name], originalNode || documentNode.createNode({}));
      } else if (!originalName && !documentNode.hasIn(['services', name])) {
        documentNode.setIn(['services', name], documentNode.createNode({}));
      }

      const previous = previousServices[originalName] || previousServices[name] || {};
      const ports = parseStructuredList(service.portsText, 'ports', parseErrors, name);
      const volumes = parseStructuredList(service.volumesText, 'volumes', parseErrors, name);
      const environment = parseEnvironment(service.environmentText, service.environmentStyle, parseErrors, name);
      const dependsText = lines(service.dependsOnText).map(dependency => renames.get(dependency) || dependency).join('\n');
      const previousDepends = previous.depends_on && !Array.isArray(previous.depends_on)
        ? Object.fromEntries(Object.entries(previous.depends_on)
          .map(([dependency, options]) => [renames.get(dependency) || dependency, options]))
        : previous.depends_on;
      const dependsOn = parseNamedCollection(dependsText, service.dependsOnStyle,
        'depends_on', parseErrors, name, previousDepends);
      const networks = parseNamedCollection(service.networksText, service.networksStyle,
        'networks', parseErrors, name, previous.networks);
      setOrDelete(documentNode, ['services', name, 'image'], String(service.image || '').trim());
      setOrDelete(documentNode, ['services', name, 'restart'], String(service.restart || '').trim());
      setOrDelete(documentNode, ['services', name, 'ports'], ports);
      setOrDelete(documentNode, ['services', name, 'environment'], environment);
      setOrDelete(documentNode, ['services', name, 'volumes'], volumes);
      setOrDelete(documentNode, ['services', name, 'depends_on'], dependsOn);
      setOrDelete(documentNode, ['services', name, 'networks'], networks);
    }
    if (parseErrors.length) return { valid: false, errors: parseErrors, yaml: text };
    return { valid: true, errors: [], yaml: documentNode.toString({ lineWidth: 0 }) };
  }

  function escape(value) {
    return typeof Utils !== 'undefined' && Utils.escapeHtml
      ? Utils.escapeHtml(String(value ?? ''))
      : String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function mount(element, { editor, readOnly = false } = {}) {
    if (!element || !editor) throw new Error('ComposeServiceForm.mount requires an element and YAML editor');
    let services = [];
    let destroyed = false;

    const render = () => {
      if (destroyed) return;
      element.innerHTML = `
        <div class="compose-form-status text-xs text-muted" aria-live="polite"></div>
        <div class="compose-service-list">
          ${services.map((service, index) => service.removed ? '' : `
            <section class="compose-service-card" data-service-index="${index}">
              <div class="compose-service-card-header">
                <strong><i class="fas fa-cube"></i> ${escape(service.name || 'New service')}</strong>
                ${readOnly ? '' : '<button type="button" class="btn btn-xs btn-danger" data-action="remove-service"><i class="fas fa-trash"></i> Remove</button>'}
              </div>
              <div class="form-row">
                <div class="form-group"><label>Service name</label><input class="form-control" data-field="name" value="${escape(service.name)}" ${readOnly ? 'disabled' : ''}></div>
                <div class="form-group"><label>Image</label><input class="form-control" data-field="image" value="${escape(service.image)}" placeholder="nginx:alpine" ${readOnly ? 'disabled' : ''}></div>
              </div>
              <div class="form-group"><label>Restart policy</label>
                <select class="form-control" data-field="restart" ${readOnly ? 'disabled' : ''}>
                  ${(!['', 'no', 'always', 'unless-stopped', 'on-failure'].includes(service.restart) ? [service.restart] : []).concat(['', 'no', 'always', 'unless-stopped', 'on-failure']).map(value => `<option value="${escape(value)}" ${service.restart === value ? 'selected' : ''}>${escape(value || 'Not set')}</option>`).join('')}
                </select>
              </div>
              <div class="compose-service-grid">
                <div class="form-group"><label>Ports <small>one per line</small></label><textarea class="form-control" data-field="portsText" placeholder="8080:80" ${readOnly ? 'disabled' : ''}>${escape(service.portsText)}</textarea></div>
                <div class="form-group"><label>Environment <small>KEY=value</small></label><textarea class="form-control" data-field="environmentText" placeholder="NODE_ENV=production" ${readOnly ? 'disabled' : ''}>${escape(service.environmentText)}</textarea></div>
                <div class="form-group"><label>Volumes <small>one per line</small></label><textarea class="form-control" data-field="volumesText" placeholder="./data:/data" ${readOnly ? 'disabled' : ''}>${escape(service.volumesText)}</textarea></div>
                <div class="form-group"><label>Depends on <small>service names</small></label><textarea class="form-control" data-field="dependsOnText" placeholder="database" ${readOnly ? 'disabled' : ''}>${escape(service.dependsOnText)}</textarea></div>
                <div class="form-group"><label>Networks <small>one per line</small></label><textarea class="form-control" data-field="networksText" placeholder="frontend" ${readOnly ? 'disabled' : ''}>${escape(service.networksText)}</textarea></div>
              </div>
              ${service.unsupported.length ? `<div class="compose-form-warning"><i class="fas fa-exclamation-triangle"></i> Edit these fields in YAML view: ${service.unsupported.map(escape).join(', ')}</div>` : ''}
            </section>
          `).join('') || '<div class="empty-msg">No services yet. Add one below.</div>'}
        </div>
        ${readOnly ? '' : '<button type="button" class="btn btn-sm btn-secondary" data-action="add-service"><i class="fas fa-plus"></i> Add service</button>'}
      `;
    };

    const collect = () => {
      element.querySelectorAll('.compose-service-card').forEach(card => {
        const index = Number(card.dataset.serviceIndex);
        const service = services[index];
        card.querySelectorAll('[data-field]').forEach(input => { service[input.dataset.field] = input.value; });
      });
      return services;
    };

    const showErrors = errors => {
      element.querySelectorAll('.is-invalid').forEach(input => input.classList.remove('is-invalid'));
      const status = element.querySelector('.compose-form-status');
      if (!errors.length) {
        status.textContent = 'Form changes synchronized to YAML.';
        status.className = 'compose-form-status text-xs is-valid';
        return;
      }
      status.textContent = errors.map(error => `${error.service}: ${error.message}`).join(' · ');
      status.className = 'compose-form-status text-xs is-error';
      errors.forEach(error => {
        const card = element.querySelector(`[data-service-index="${error.index ?? services.findIndex(service => service.name === error.service)}"]`);
        card?.querySelector(`[data-field="${error.field}"]`)?.classList.add('is-invalid');
      });
    };

    element.addEventListener('click', event => {
      const button = event.target.closest('[data-action]');
      if (!button || readOnly) return;
      collect();
      if (button.dataset.action === 'remove-service') {
        const index = Number(button.closest('.compose-service-card').dataset.serviceIndex);
        services[index].removed = true;
        render();
      } else if (button.dataset.action === 'add-service') {
        const used = new Set(services.filter(service => !service.removed).map(service => service.name));
        let number = 1;
        let name = 'service';
        while (used.has(name)) { number += 1; name = `service${number}`; }
        services.push({
          originalName: '', name, image: '', restart: '', portsText: '', environmentText: '',
          volumesText: '', dependsOnText: '', networksText: '', environmentStyle: 'list',
          dependsOnStyle: 'list', networksStyle: 'list', unsupported: [], removed: false,
        });
        render();
      }
    });

    return {
      async syncFromYaml() {
        const YAML = await loadYamlModule();
        services = extractServices(editor.getValue(), YAML);
        render();
        return services;
      },
      async applyToYaml() {
        if (readOnly) return { valid: true, errors: [], yaml: editor.getValue() };
        collect();
        const YAML = await loadYamlModule();
        const result = applyChanges(editor.getValue(), services, YAML);
        showErrors(result.errors);
        if (result.valid) editor.setValue(result.yaml);
        return result;
      },
      validate() { collect(); return validateServices(services); },
      destroy() { destroyed = true; element.replaceChildren(); },
    };
  }

  return { mount, extractServices, applyChanges, validateServices };
})();

if (typeof window !== 'undefined') window.ComposeServiceForm = ComposeServiceForm;
if (typeof module !== 'undefined' && module.exports) module.exports = ComposeServiceForm;
