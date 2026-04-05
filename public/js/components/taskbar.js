'use strict';

const TaskBar = {
  _tasks: [],
  _el: null,
  _maxId: 0,
  _visible: false,

  init() {
    this._el = document.getElementById('taskbar');
    if (!this._el) return;
    this._render();
    // Show/hide based on UI mode
    this._updateVisibility();
  },

  _updateVisibility() {
    if (!this._el) return;
    const isEnterprise = document.documentElement.getAttribute('data-uimode') === 'enterprise';
    this._el.style.display = isEnterprise ? '' : 'none';
    this._visible = isEnterprise;
    // Adjust main content padding when taskbar visible
    const main = document.getElementById('main-content');
    if (main) main.style.paddingBottom = isEnterprise ? '36px' : '';
  },

  add(description, { type = 'info', progress = -1 } = {}) {
    const id = ++this._maxId;
    const task = { id, description, type, progress, state: 'running', startedAt: Date.now() };
    this._tasks.unshift(task);
    if (this._tasks.length > 20) this._tasks.pop(); // keep max 20
    this._render();
    return id;
  },

  update(id, { description, progress, state } = {}) {
    const task = this._tasks.find(t => t.id === id);
    if (!task) return;
    if (description !== undefined) task.description = description;
    if (progress !== undefined) task.progress = progress;
    if (state !== undefined) task.state = state;
    if (state === 'completed' || state === 'error') {
      task.endedAt = Date.now();
      // Auto-remove completed tasks after 8 seconds
      setTimeout(() => {
        this._tasks = this._tasks.filter(t => t.id !== id);
        this._render();
      }, 8000);
    }
    this._render();
  },

  complete(id, description) {
    this.update(id, { state: 'completed', progress: 100, description: description || undefined });
  },

  error(id, description) {
    this.update(id, { state: 'error', description: description || undefined });
  },

  _render() {
    if (!this._el) return;
    const activeTasks = this._tasks.filter(t => t.state === 'running');
    const recentTasks = this._tasks.filter(t => t.state !== 'running').slice(0, 5);
    const allShown = [...activeTasks, ...recentTasks];

    const badge = activeTasks.length > 0 ? `<span class="taskbar-badge">${activeTasks.length}</span>` : '';

    if (allShown.length === 0) {
      this._el.innerHTML = `<div class="taskbar-inner"><span class="taskbar-idle"><i class="fas fa-check-circle" style="margin-right:6px;color:var(--green)"></i>No active operations</span>${badge}</div>`;
      return;
    }

    this._el.innerHTML = `
      <div class="taskbar-inner">
        <div class="taskbar-tasks">
          ${allShown.map(t => {
            const icon = t.state === 'completed' ? 'fa-check-circle' : t.state === 'error' ? 'fa-times-circle' : 'fa-spinner fa-spin';
            const color = t.state === 'completed' ? 'var(--green)' : t.state === 'error' ? 'var(--red)' : 'var(--accent)';
            const elapsed = Math.round(((t.endedAt || Date.now()) - t.startedAt) / 1000);
            const progressBar = t.progress >= 0 && t.state === 'running'
              ? `<div class="taskbar-progress"><div class="taskbar-progress-fill" style="width:${t.progress}%"></div></div>`
              : '';
            return `<div class="taskbar-task ${t.state}">
              <i class="fas ${icon}" style="color:${color};font-size:11px"></i>
              <span class="taskbar-desc">${Utils.escapeHtml(t.description)}</span>
              ${progressBar}
              <span class="taskbar-time">${elapsed}s</span>
            </div>`;
          }).join('')}
        </div>
        ${badge}
      </div>
    `;
  },
};

window.TaskBar = TaskBar;
