'use strict';

// v8.94.0 — CLI Transparency.
//
// Renders the `docker` / `docker compose` command an action is equivalent to,
// as a collapsed row inside an EXISTING confirmation dialog. Collapsed by
// default: the operator who doesn't care must not pay a click for the operator
// who does.
//
// Origin: the "web UIs mask the underlying complexity" criticism of Proxmox.
// We answer it by showing the command, not by becoming a CLI.
//
// Never blocks. If the preview endpoint is slow, errors, or has no equivalent
// for the action, `html()` returns '' and the dialog renders exactly as before —
// a transparency feature must never be able to break the action it describes.

const CliPreview = {
  /**
   * Build the collapsed preview markup for an action.
   * @param {string} action  a cli-transparency action key, e.g. 'container.remove'
   * @param {object} params  action params; `hostName` is rendered as a label
   * @returns {Promise<string>} HTML, or '' when there is nothing worth showing
   */
  async html(action, params = {}) {
    let r;
    try {
      r = await Api.getCliPreview(action, params);
    } catch {
      return ''; // the dialog is more important than the explanation
    }
    if (!r || !r.available || !r.command) return '';

    const cmd = Utils.escapeHtml(r.command);
    const label = i18n.t('cliPreview.label');
    const onHost = r.hostLabel
      ? `<span class="text-sm" style="color:var(--text-muted)"> — ${Utils.escapeHtml(i18n.t('cliPreview.onHost', { host: r.hostLabel }))}</span>`
      : '';
    const redacted = r.redacted
      ? `<p class="text-sm" style="color:var(--yellow);margin:6px 0 0">
           <i class="fas fa-eye-slash"></i> ${Utils.escapeHtml(i18n.t('cliPreview.redacted'))}
         </p>`
      : '';

    return `
      <details class="cli-preview" style="margin-top:12px">
        <summary style="cursor:pointer;color:var(--text-muted);font-size:12px">
          <i class="fas fa-terminal"></i> ${Utils.escapeHtml(label)}${onHost}
        </summary>
        <div style="margin-top:8px;position:relative">
          <pre id="cli-preview-cmd" tabindex="0" style="background:var(--bg-input);border:1px solid var(--border);border-radius:4px;padding:10px 40px 10px 10px;overflow-x:auto;font-size:12px;margin:0;white-space:pre">${cmd}</pre>
          <button type="button" class="btn btn-sm btn-secondary" id="cli-preview-copy"
                  aria-label="${Utils.escapeHtml(i18n.t('cliPreview.copy'))}"
                  title="${Utils.escapeHtml(i18n.t('cliPreview.copy'))}"
                  style="position:absolute;top:6px;right:6px">
            <i class="fas fa-copy"></i>
          </button>
          ${redacted}
        </div>
      </details>
    `;
  },

  /**
   * Attach the copy handler. Call after the markup is in the DOM.
   * No inline handlers — CSP `script-src-attr 'none'` blocks them (invariant 7).
   * @param {ParentNode} root
   */
  mount(root) {
    if (!root) return;
    const btn = root.querySelector('#cli-preview-copy');
    const pre = root.querySelector('#cli-preview-cmd');
    if (!btn || !pre) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      Utils.copyToClipboard(pre.textContent);
    });
  },
};
