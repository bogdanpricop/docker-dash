// Source for the committed, self-hosted CodeMirror 6 bundle. No build at runtime.
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { yaml } from '@codemirror/lang-yaml';
import { indentUnit, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter } from '@codemirror/lint';
import { tags } from '@lezer/highlight';

const highlighting = HighlightStyle.define([
  { tag: [tags.atom, tags.number, tags.bool, tags.null], color: 'var(--accent, #2563eb)' },
  { tag: [tags.propertyName, tags.definition(tags.variableName)], color: 'var(--purple, #8957e5)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--green, #238636)' },
  { tag: [tags.meta, tags.keyword], color: 'var(--orange, #bc4c00)' },
  { tag: tags.comment, color: 'var(--text-dim, #6e7781)', fontStyle: 'italic' },
]);

export function mount(textarea, { readOnly, minHeight, onChange, validate }) {
  const previousHidden = textarea.hidden;
  const previousDisplay = textarea.style.display;
  const host = document.createElement('div');
  host.className = 'yaml-code-editor';
  textarea.insertAdjacentElement('afterend', host);
  const attributes = { 'aria-label': textarea.getAttribute('aria-label') ||
    Array.from(textarea.labels || [], label => label.textContent.trim()).join(' ') || 'YAML' };
  for (const name of ['aria-labelledby', 'aria-describedby']) {
    if (textarea.hasAttribute(name)) attributes[name] = textarea.getAttribute(name);
  }
  if (readOnly) attributes.tabindex = '0';
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: textarea.value,
      extensions: [
        basicSetup, yaml(), indentUnit.of('  '), EditorState.tabSize.of(2),
        syntaxHighlighting(highlighting),
        EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of(attributes),
        EditorView.theme({
          '&': { height: `${minHeight}px` },
          '.cm-scroller': { overflow: 'auto' },
        }),
        lintGutter(), linter(current => validate(current.state.doc.toString()).errors.map(error => {
          const line = current.state.doc.line(Math.min(current.state.doc.lines, error.line + 1));
          const from = Math.min(line.to, line.from + error.column);
          return { from, to: Math.min(line.to, from + 1), severity: 'error', message: error.message };
        })),
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return;
          textarea.value = update.state.doc.toString();
          onChange();
        }),
      ],
    }),
  });
  textarea.hidden = true;
  textarea.style.display = 'none';
  let destroyed = false;
  let resetTimer;
  const setValue = value => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  const form = textarea.form;
  const reset = event => {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      if (!destroyed && !event.defaultPrevented) setValue(textarea.value);
    }, 0);
  };
  form?.addEventListener('reset', reset);
  return {
    getValue: () => view.state.doc.toString(),
    setValue,
    focus: () => view.focus(),
    refresh: () => view.requestMeasure(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(resetTimer);
      form?.removeEventListener('reset', reset);
      view.destroy();
      host.remove();
      textarea.hidden = previousHidden;
      textarea.style.display = previousDisplay;
    },
  };
}
