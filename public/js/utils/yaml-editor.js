/* global CodeMirror, jsyaml */
'use strict';

/**
 * Small no-build YAML editor adapter used by Compose surfaces.
 *
 * `YamlEditor.mount(element, { value, onChange, readOnly, minHeight })` accepts
 * a textarea or a container and returns `{ getValue, setValue, validate,
 * focus, refresh, destroy }`. CodeMirror is progressively enhanced: if its
 * vendored bundle is unavailable, the textarea remains fully usable and YAML
 * validation still runs through the vendored js-yaml parser.
 */
const YamlEditor = (() => {
  function validateText(value) {
    if (typeof jsyaml === 'undefined' || typeof jsyaml.load !== 'function') {
      return { valid: false, errors: [{ message: 'YAML parser is unavailable', line: 0, column: 0 }] };
    }
    try {
      const document = jsyaml.load(String(value || ''));
      return { valid: true, errors: [], document };
    } catch (err) {
      return {
        valid: false,
        errors: [{
          message: err.reason || err.message || 'Invalid YAML',
          line: err.mark?.line || 0,
          column: err.mark?.column || 0,
        }],
      };
    }
  }

  function mount(element, options = {}) {
    const { onChange = null, readOnly = false, minHeight = 320 } = options;
    if (!element) throw new Error('YamlEditor.mount requires an element');
    let textarea = element;
    if (String(element.tagName).toLowerCase() !== 'textarea') {
      textarea = document.createElement('textarea');
      textarea.className = 'form-control yaml-editor-fallback';
      element.appendChild(textarea);
    }
    const initialValue = Object.prototype.hasOwnProperty.call(options, 'value')
      ? options.value : textarea.value;
    textarea.value = String(initialValue ?? '');
    textarea.readOnly = !!readOnly;
    textarea.setAttribute('spellcheck', 'false');

    const status = document.createElement('div');
    status.className = 'yaml-editor-status text-xs';
    status.setAttribute('aria-live', 'polite');
    textarea.insertAdjacentElement('afterend', status);

    let editor = null;
    let validationTimer = null;
    let destroyed = false;

    const currentValue = () => editor ? editor.getValue() : textarea.value;
    const showValidation = () => {
      const result = validateText(currentValue());
      status.classList.toggle('is-error', !result.valid);
      status.classList.toggle('is-valid', result.valid);
      if (result.valid) {
        status.innerHTML = '<i class="fas fa-check-circle"></i> Valid YAML';
      } else {
        const first = result.errors[0];
        status.textContent = `Line ${first.line + 1}, column ${first.column + 1}: ${first.message}`;
      }
      return result;
    };
    const changed = () => {
      clearTimeout(validationTimer);
      validationTimer = setTimeout(showValidation, 220);
      if (typeof onChange === 'function') onChange(currentValue());
    };

    if (typeof CodeMirror !== 'undefined' && typeof CodeMirror.fromTextArea === 'function') {
      editor = CodeMirror.fromTextArea(textarea, {
        mode: 'yaml', lineNumbers: true, lineWrapping: false,
        matchBrackets: true, autoCloseBrackets: true,
        lint: !readOnly, gutters: ['CodeMirror-linenumbers', 'CodeMirror-lint-markers'],
        readOnly: readOnly ? 'nocursor' : false,
        tabSize: 2, indentUnit: 2, indentWithTabs: false,
        viewportMargin: 20,
      });
      editor.setSize('100%', minHeight);
      editor.on('change', changed);
      setTimeout(() => editor?.refresh(), 0);
    } else {
      textarea.style.minHeight = `${minHeight}px`;
      textarea.addEventListener('input', changed);
    }
    showValidation();

    return {
      getValue: currentValue,
      setValue(next) {
        if (editor) editor.setValue(String(next ?? ''));
        else textarea.value = String(next ?? '');
        showValidation();
      },
      validate: showValidation,
      focus() { if (editor) editor.focus(); else textarea.focus(); },
      refresh() { editor?.refresh(); },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(validationTimer);
        if (editor) {
          // A modal may already have detached the textarea and CodeMirror DOM.
          // Disposal must remain harmless in that lifecycle.
          try { editor.toTextArea(); } catch { /* already detached */ }
        } else textarea.removeEventListener('input', changed);
        status.remove();
      },
    };
  }

  return { mount, validateText };
})();

if (typeof window !== 'undefined') window.YamlEditor = YamlEditor;
if (typeof module !== 'undefined' && module.exports) module.exports = YamlEditor;
