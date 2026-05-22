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

  // ─── Tabular export (CSV + real .xlsx, zero dependencies) ──────────
  // headers: string[]   rows: Array<Array<string|number>>

  downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  exportCsv(filename, headers, rows) {
    const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [headers.map(esc).join(',')];
    for (const r of rows) lines.push(r.map(esc).join(','));
    // Leading BOM so Excel reads UTF-8 correctly.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    this.downloadBlob(filename, blob);
  },

  _xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  crc32(bytes) {
    if (!Utils._crcTable) {
      const t = new Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
      }
      Utils._crcTable = t;
    }
    const t = Utils._crcTable;
    let crc = -1;
    for (let i = 0; i < bytes.length; i++) crc = t[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  },

  // Build a minimal-but-valid .xlsx (OOXML) using stored (uncompressed) ZIP
  // entries — no external library, no build step. One sheet; numbers are
  // emitted as numeric cells, everything else as inline strings.
  exportXlsx(filename, sheetName, headers, rows) {
    const enc = new TextEncoder();
    const colLetter = (n) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
    const cellXml = (val, ci, ri) => {
      const ref = colLetter(ci) + ri;
      if (typeof val === 'number' && isFinite(val)) return `<c r="${ref}"><v>${val}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${this._xmlEsc(val)}</t></is></c>`;
    };
    const allRows = [headers, ...rows];
    let body = '';
    allRows.forEach((r, ri) => {
      body += `<row r="${ri + 1}">${r.map((v, ci) => cellXml(v, ci, ri + 1)).join('')}</row>`;
    });
    const safeSheet = (sheetName || 'Sheet1').replace(/[\\/?*[\]:]/g, ' ').substring(0, 31) || 'Sheet1';
    const files = {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${this._xmlEsc(safeSheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`,
    };
    const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF];
    const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
      const nameBytes = enc.encode(name);
      const data = enc.encode(content);
      const crc = this.crc32(data);
      const local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0));
      chunks.push(new Uint8Array(local), nameBytes, data);
      const cen = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push({ header: new Uint8Array(cen), nameBytes });
      offset += local.length + nameBytes.length + data.length;
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) { chunks.push(c.header, c.nameBytes); cdSize += c.header.length + c.nameBytes.length; }
    chunks.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0))));
    this.downloadBlob(filename, new Blob(chunks, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  },
  // Guess a Font Awesome 6 Solid unicode glyph for a container based on image/name
  // Used in canvas-based Topology and Dependency Map visualizations
  guessContainerIcon(image, name) {
    const s = ((image || '') + ' ' + (name || '')).toLowerCase();
    // Databases
    if (/mysql|mariadb|postgres|pgsql|pgadmin|mongo|couchdb|influxdb|cassandra|cockroach/i.test(s)) return '\uf1c0'; // database
    if (/redis|memcache|keydb|valkey|dragonfly/i.test(s)) return '\uf0e7'; // bolt (fast cache)
    if (/elastic|opensearch|solr|meilisearch/i.test(s)) return '\uf002'; // search
    // Web servers / proxies
    if (/nginx|apache|httpd|caddy|traefik|haproxy|envoy/i.test(s)) return '\uf0ac'; // globe
    // Message brokers
    if (/rabbit|kafka|nats|mosquitto|mqtt|pulsar|activemq/i.test(s)) return '\uf0e0'; // envelope
    // Monitoring
    if (/grafana|prometheus|loki|jaeger|zipkin|tempo|alertmanager/i.test(s)) return '\uf201'; // chart-line
    if (/zabbix|nagios|icinga|checkmk|datadog/i.test(s)) return '\uf201'; // chart-line
    // CI/CD / Git
    if (/jenkins|gitlab|gitea|drone|woodpecker|github|argocd/i.test(s)) return '\uf126'; // code-branch
    // Container management
    if (/portainer|docker-dash|dockge|yacht|watchtower/i.test(s)) return '\uf1b3'; // cubes
    // Node.js / API
    if (/node|express|nestjs|fastify|next|nuxt|api|gateway|backend|graphql/i.test(s)) return '\uf121'; // code
    // Python
    if (/python|flask|django|fastapi|celery|gunicorn|uvicorn/i.test(s)) return '\uf121'; // code
    // PHP
    if (/php|laravel|symfony|wordpress|drupal|joomla/i.test(s)) return '\uf121'; // code
    // Worker / queue
    if (/worker|cron|scheduler|sidekiq|resque|bull/i.test(s)) return '\uf085'; // cogs
    // Mail
    if (/mail|smtp|postfix|dovecot|roundcube/i.test(s)) return '\uf0e0'; // envelope
    // Storage / S3
    if (/minio|s3|storage|backup|restic|borg|duplicati/i.test(s)) return '\uf0a0'; // hdd
    // Auth / SSO
    if (/keycloak|auth|oauth|ldap|openldap|authentik|authelia/i.test(s)) return '\uf023'; // lock
    // DNS
    if (/pihole|adguard|dns|unbound|coredns/i.test(s)) return '\uf0e8'; // sitemap
    // VPN / network
    if (/wireguard|openvpn|tailscale|headscale/i.test(s)) return '\uf3ed'; // shield-alt
    // Media
    if (/plex|jellyfin|emby|sonarr|radarr|lidarr/i.test(s)) return '\uf008'; // film
    // Default: cube
    return '\uf1b2'; // cube
  },
};

// Make globally available
window.Utils = Utils;
window.$ = Utils.$;
window.$$ = Utils.$$;
