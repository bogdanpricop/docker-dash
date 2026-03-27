/* ═══════════════════════════════════════════════════
   utils.js — Helper functions
   ═══════════════════════════════════════════════════ */
'use strict';

const Utils = {
  // Format bytes to human readable
  formatBytes(bytes, decimals = 1) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
  },

  // Format percentage
  formatPct(val, decimals = 1) {
    if (val == null || isNaN(val)) return '0%';
    return parseFloat(val).toFixed(decimals) + '%';
  },

  // Format uptime/duration from seconds
  formatDuration(seconds) {
    if (!seconds || seconds < 0) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}${i18n.t('time.days')} ${h}${i18n.t('time.hours')}`;
    if (h > 0) return `${h}${i18n.t('time.hours')} ${m}${i18n.t('time.minutes')}`;
    if (m > 0) return `${m}${i18n.t('time.minutes')}`;
    return `${Math.floor(seconds)}${i18n.t('time.seconds')}`;
  },

  // Relative time from ISO string
  timeAgo(dateStr) {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = (now - date) / 1000;
    if (diff < 60) return i18n.t('time.justNow');
    if (diff < 3600) return i18n.t('time.minutesAgo', { n: Math.floor(diff / 60) });
    if (diff < 86400) return i18n.t('time.hoursAgo', { n: Math.floor(diff / 3600) });
    if (diff < 604800) return i18n.t('time.daysAgo', { n: Math.floor(diff / 86400) });
    return date.toLocaleDateString();
  },

  // Format date
  formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString();
  },

  // Short container ID
  shortId(id) {
    if (!id) return '—';
    return id.substring(0, 12);
  },

  // Short image ID (remove sha256:)
  shortImageId(id) {
    if (!id) return '—';
    return id.replace('sha256:', '').substring(0, 12);
  },

  // Container status to badge class
  statusBadgeClass(state) {
    if (!state) return 'badge-info';
    state = state.toLowerCase();
    const map = {
      running: 'badge-running',
      exited: 'badge-exited',
      stopped: 'badge-stopped',
      paused: 'badge-paused',
      created: 'badge-created',
      dead: 'badge-dead',
      removing: 'badge-removing',
      restarting: 'badge-warning',
    };
    return map[state] || 'badge-info';
  },

  // Get container name (remove leading /)
  containerName(names) {
    if (Array.isArray(names) && names.length > 0) {
      return names[0].replace(/^\//, '');
    }
    if (typeof names === 'string') return names.replace(/^\//, '');
    return '—';
  },

  // Get port mappings (backend maps to lowercase: public, private, type)
  formatPorts(ports) {
    if (!ports || !Array.isArray(ports) || ports.length === 0) return '';
    return ports
      .filter(p => p.public || p.PublicPort)
      .map(p => `${p.public || p.PublicPort}→${p.private || p.PrivatePort}/${p.type || p.Type}`)
      .join(', ');
  },

  // Color for CPU percentage
  cpuColor(pct) {
    if (pct >= 80) return '#f85149';
    if (pct >= 50) return '#d29922';
    return '#3fb950';
  },

  // Color for memory percentage
  memColor(pct) {
    if (pct >= 90) return '#f85149';
    if (pct >= 70) return '#d29922';
    return '#388bfd';
  },

  // Escape HTML
  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  },

  // Debounce
  debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  },

  // Create element with HTML
  el(tag, attrs = {}, html = '') {
    const elem = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') elem.className = v;
      else if (k === 'dataset') Object.assign(elem.dataset, v);
      else if (k.startsWith('on')) elem.addEventListener(k.slice(2).toLowerCase(), v);
      else elem.setAttribute(k, v);
    }
    if (html) elem.innerHTML = html;
    return elem;
  },

  // DOM query shortcuts
  $(selector, parent = document) { return parent.querySelector(selector); },
  $$(selector, parent = document) { return [...parent.querySelectorAll(selector)]; },

  // Parse Docker image name
  parseImage(image) {
    if (!image) return { repo: '—', tag: 'latest' };
    const parts = image.split(':');
    return {
      repo: parts[0].split('/').pop(),
      tag: parts[1] || 'latest',
    };
  },

  // Generate chart colors
  chartColors: [
    '#388bfd', '#3fb950', '#d29922', '#f85149', '#a371f7',
    '#db6d28', '#39d0d8', '#ec4899', '#8b5cf6', '#14b8a6',
  ],

  // Chart.js defaults
  configureChartDefaults() {
    if (typeof Chart === 'undefined') return;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    Chart.defaults.color = isLight ? '#64748b' : '#6e7681';
    Chart.defaults.borderColor = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(48,54,61,0.3)';
    Chart.defaults.font.family = "'JetBrains Mono', monospace";
    Chart.defaults.font.size = 11;
    Chart.defaults.plugins.legend.display = false;
    Chart.defaults.animation.duration = 600;
    Chart.defaults.elements.line.tension = 0.35;
    Chart.defaults.elements.line.borderWidth = 2;
    Chart.defaults.elements.point.radius = 0;
    Chart.defaults.elements.point.hoverRadius = 4;
    Chart.defaults.scales.linear = Chart.defaults.scales.linear || {};
  },
  // ─── Plain-English Container Status ──────────────
  exitCodeMessage(exitCode) {
    const codes = {
      0: 'Exited normally (success)',
      1: 'Application error (general failure)',
      2: 'Shell misuse or missing command',
      126: 'Command not executable (permission denied)',
      127: 'Command not found (missing binary)',
      128: 'Invalid exit signal',
      130: 'Terminated by Ctrl+C (SIGINT)',
      137: 'Killed by system — out of memory (OOM) or docker kill (SIGKILL)',
      139: 'Segmentation fault (SIGSEGV) — application crash',
      143: 'Graceful shutdown (SIGTERM) — docker stop',
      255: 'Exit status out of range',
    };
    if (exitCode >= 129 && exitCode <= 165) {
      const sig = exitCode - 128;
      const signals = { 1:'SIGHUP',2:'SIGINT',3:'SIGQUIT',6:'SIGABRT',9:'SIGKILL',11:'SIGSEGV',15:'SIGTERM' };
      return codes[exitCode] || `Killed by signal ${signals[sig] || sig} (exit ${exitCode})`;
    }
    return codes[exitCode] || `Exit code ${exitCode}`;
  },

  containerStatusMessage(state, exitCode, health, restartCount) {
    const messages = [];
    if (state === 'running') {
      if (health === 'unhealthy') messages.push('Running but health check failing');
      else if (health === 'starting') messages.push('Starting up (health check pending)');
      else messages.push('Running normally');
    } else if (state === 'exited') {
      messages.push(this.exitCodeMessage(exitCode || 0));
    } else if (state === 'restarting') {
      messages.push('Restarting — may be crash-looping');
    } else if (state === 'paused') {
      messages.push('Paused — container frozen, not using CPU');
    } else if (state === 'dead') {
      messages.push('Dead — failed to stop cleanly, may need force removal');
    } else if (state === 'created') {
      messages.push('Created but never started');
    }
    if (restartCount > 5) messages.push(`Restarted ${restartCount} times — possible instability`);
    return messages.join('. ');
  },

  // ─── Container Health Score (0-100) ────────────────
  containerHealthScore({ state, exitCode, health, restartCount, cpuPercent, memPercent, imageAge, vulnCount }) {
    let score = 100;

    // State penalty
    if (state === 'exited') score -= (exitCode === 0 ? 30 : 50);
    else if (state === 'dead') score -= 70;
    else if (state === 'restarting') score -= 40;
    else if (state === 'paused') score -= 10;
    else if (state === 'created') score -= 20;

    // Health check
    if (health === 'unhealthy') score -= 30;
    else if (health === 'starting') score -= 5;

    // Restarts
    if (restartCount > 20) score -= 25;
    else if (restartCount > 10) score -= 15;
    else if (restartCount > 3) score -= 8;

    // Resource usage
    if (cpuPercent > 90) score -= 15;
    else if (cpuPercent > 70) score -= 5;
    if (memPercent > 95) score -= 20;
    else if (memPercent > 85) score -= 10;
    else if (memPercent > 70) score -= 3;

    // Image age (days)
    if (imageAge > 365) score -= 10;
    else if (imageAge > 180) score -= 5;

    // Vulnerabilities
    if (vulnCount > 50) score -= 15;
    else if (vulnCount > 10) score -= 8;
    else if (vulnCount > 0) score -= 3;

    return Math.max(0, Math.min(100, score));
  },

  healthScoreColor(score) {
    if (score >= 80) return '#3fb950';
    if (score >= 60) return '#d29922';
    if (score >= 40) return '#db6d28';
    return '#f85149';
  },

  healthScoreLabel(score) {
    if (score >= 90) return 'Excellent';
    if (score >= 75) return 'Good';
    if (score >= 50) return 'Fair';
    if (score >= 25) return 'Poor';
    return 'Critical';
  },

  copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for HTTP (non-secure contexts)
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return Promise.resolve();
    } catch {
      return Promise.reject(new Error('Copy failed'));
    } finally {
      document.body.removeChild(textarea);
    }
  },
};

// Make globally available
window.Utils = Utils;
window.$ = Utils.$;
window.$$ = Utils.$$;
