'use strict';

class LogViewer {
  constructor(controls, output, onPause) {
    this.output = output;
    this.onPause = onPause;
    this.follow = true;
    this.paused = false;
    this.index = -1;
    this.matches = [];
    controls.innerHTML = `
      <button type="button" class="btn btn-xs btn-secondary" data-viewer-pause aria-pressed="false">Pause</button>
      <label class="toggle-label"><input type="checkbox" data-viewer-follow checked> Auto-scroll</label>
      <label class="toggle-label"><input type="checkbox" data-viewer-wrap> Wrap</label>
      <button type="button" class="btn btn-xs btn-secondary" data-viewer-prev aria-label="Previous match" disabled>↑</button>
      <button type="button" class="btn btn-xs btn-secondary" data-viewer-next aria-label="Next match" disabled>↓</button>
      <span class="text-xs text-muted" data-viewer-matches aria-live="polite"></span>`;
    this.counter = controls.querySelector('[data-viewer-matches]');
    this.previous = controls.querySelector('[data-viewer-prev]');
    this.next = controls.querySelector('[data-viewer-next]');
    this.followInput = controls.querySelector('[data-viewer-follow]');
    controls.querySelector('[data-viewer-pause]').addEventListener('click', event => {
      this.paused = !this.paused;
      event.currentTarget.textContent = this.paused ? 'Resume' : 'Pause';
      event.currentTarget.setAttribute('aria-pressed', String(this.paused));
      onPause?.(this.paused);
    });
    this.followInput.addEventListener('change', () => {
      this.follow = this.followInput.checked;
      if (this.follow) output.scrollTop = output.scrollHeight;
    });
    controls.querySelector('[data-viewer-wrap]').addEventListener('change', event => {
      output.classList.toggle('log-viewer-wrap', event.currentTarget.checked);
    });
    this.previous.addEventListener('click', () => this.move(-1));
    this.next.addEventListener('click', () => this.move(1));
  }

  set(rows, search, mode = 'single') {
    const output = this.output;
    const scroll = output.scrollTop;
    const fragment = document.createDocumentFragment();
    this.matches = [];
    this.index = -1;
    const term = String(search || '').trim();
    const literal = term && new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const ordered = [...rows].slice(-12500);
    if (mode === 'grouped') ordered.sort((a, b) => String(a.container).localeCompare(String(b.container)));
    let group;
    for (const row of ordered) {
      if (mode === 'grouped' && row.container !== group) {
        group = row.container;
        const heading = document.createElement('strong');
        heading.className = 'log-viewer-group';
        heading.textContent = group || 'Unknown container';
        fragment.append(heading, '\n');
      }
      const line = document.createElement('span');
      line.classList.add('log-line');
      if (['error', 'warn', 'info', 'debug'].includes(row.severity)) line.classList.add('log-' + row.severity);
      const message = String(row.msg ?? '').slice(0, 8192);
      const prefix = [row.ts, mode === 'multi' && row.container ? '[' + row.container + ']' : ''].filter(Boolean).join(' ');
      if (prefix) line.append(prefix + ' ');
      let position = 0;
      if (literal) {
        for (const match of message.matchAll(literal)) {
          if (this.matches.length >= 2500) break;
          line.append(message.slice(position, match.index));
          const mark = document.createElement('mark');
          mark.className = 'log-highlight';
          mark.textContent = match[0];
          line.appendChild(mark);
          this.matches.push(mark);
          position = match.index + match[0].length;
        }
      }
      line.append(message.slice(position));
      fragment.append(line, '\n');
    }
    output.replaceChildren(fragment);
    this.previous.disabled = this.next.disabled = !this.matches.length;
    this.counter.textContent = term ? this.matches.length + ' matches' : '';
    output.scrollTop = this.follow ? output.scrollHeight : scroll;
  }

  move(direction) {
    if (!this.matches.length) return;
    this.matches[this.index]?.classList.remove('log-match-active');
    this.index = this.index < 0 && direction < 0 ? this.matches.length - 1
      : (this.index + direction + this.matches.length) % this.matches.length;
    const match = this.matches[this.index];
    match.classList.add('log-match-active');
    this.follow = this.followInput.checked = false;
    this.output.scrollTop += match.getBoundingClientRect().top - this.output.getBoundingClientRect().top - this.output.clientHeight / 3;
    this.counter.textContent = `${this.index + 1} / ${this.matches.length} matches`;
  }
}
