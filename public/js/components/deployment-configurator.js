/* ═══════════════════════════════════════════════════
   components/deployment-configurator.js — Deployment recipe configurator
   ═══════════════════════════════════════════════════
   v8.7.7 — Live-preview wizard for generating a docker-compose.yml suited to
   the user's deployment setup (reverse proxy, mode, NAS layout). The 7 recipe
   templates here are the single source of truth: scripts/generate-deployment-
   examples.js renders each with sensible defaults and writes the static
   examples under examples/deployments/<recipe>.yml so they are browsable on
   GitHub. The Tools-tab card "Deployment Configurator" opens this wizard.

   Each recipe is a small object: { id, name, description, fields, defaults,
   render(opts) }. The render fn returns the compose YAML string. Pure (no
   DOM), so the same code generates both the live UI preview and the static
   example files, and the unit tests can parse every recipe through yaml.
*/
'use strict';

const DeploymentConfigurator = (() => {

  // ─── helpers ─────────────────────────────────────────────────────────
  const _esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yamlString = (s) => /[:#\-{}\[\]&*?|>!%@`,]/.test(String(s)) || String(s).trim() !== String(s)
    ? `"${String(s).replace(/"/g, '\\"')}"`
    : String(s);

  // ─── recipes ─────────────────────────────────────────────────────────
  // Note: image is fixed across recipes; user can edit afterwards.
  const IMAGE = 'ghcr.io/bogdanpricop/docker-dash:latest';

  const RECIPES = [
    {
      id: 'standalone',
      name: 'Standalone (no reverse proxy)',
      description: 'Simplest setup: docker-dash exposes its HTTP port directly. Good for trying it out, local dev, or behind an existing LAN-only reverse proxy.',
      fields: ['port', 'adminPassword'],
      defaults: { port: 8101, adminPassword: 'changeme' },
      render(o) {
        return [
          '# Docker Dash — STANDALONE (no reverse proxy)',
          `# Open http://<host>:${o.port} after deploy. First login: admin / ${o.adminPassword} (forced change on first use).`,
          '',
          'services:',
          '  docker-dash:',
          '    image: ' + IMAGE,
          '    container_name: docker-dash',
          '    restart: unless-stopped',
          '    ports:',
          `      - "${o.port}:8101"`,
          '    environment:',
          `      - ADMIN_PASSWORD=${o.adminPassword}`,
          '      - ENCRYPTION_KEY=changeme-32-chars-minimum-edit-this',
          '    volumes:',
          '      - /var/run/docker.sock:/var/run/docker.sock:ro',
          '      - docker-dash-data:/data',
          '',
          'volumes:',
          '  docker-dash-data:',
        ].join('\n');
      },
    },

    {
      id: 'caddy',
      name: 'Caddy (auto-HTTPS sidecar)',
      description: 'Caddy as a sidecar — gives you HTTPS in one line via Let\'s Encrypt, zero config. Easiest path to a real domain.',
      fields: ['domain', 'email'],
      defaults: { domain: 'dockerdash.example.com', email: 'admin@example.com' },
      render(o) {
        return [
          '# Docker Dash + Caddy auto-HTTPS sidecar.',
          `# DNS for ${o.domain} must point at this host, and ports 80 + 443 must be open.`,
          '',
          'services:',
          '  docker-dash:',
          '    image: ' + IMAGE,
          '    container_name: docker-dash',
          '    restart: unless-stopped',
          '    environment:',
          '      - ADMIN_PASSWORD=changeme',
          '      - ENCRYPTION_KEY=changeme-32-chars-minimum-edit-this',
          `      - PUBLIC_URL=https://${o.domain}`,
          '    volumes:',
          '      - /var/run/docker.sock:/var/run/docker.sock:ro',
          '      - docker-dash-data:/data',
          '',
          '  caddy:',
          '    image: caddy:2-alpine',
          '    container_name: docker-dash-caddy',
          '    restart: unless-stopped',
          '    depends_on:',
          '      - docker-dash',
          '    ports:',
          '      - "80:80"',
          '      - "443:443"',
          '    volumes:',
          '      - caddy-data:/data',
          '      - caddy-config:/config',
          '    configs:',
          '      - source: caddyfile',
          '        target: /etc/caddy/Caddyfile',
          '',
          'configs:',
          '  caddyfile:',
          '    content: |',
          `      ${o.domain} {`,
          `        tls ${o.email}`,
          '        reverse_proxy docker-dash:8101',
          '      }',
          '',
          'volumes:',
          '  docker-dash-data:',
          '  caddy-data:',
          '  caddy-config:',
        ].join('\n');
      },
    },

    {
      id: 'traefik',
      name: 'Traefik v3 (labels, non-Swarm)',
      description: 'For users already running Traefik v3 as their cluster-wide reverse proxy + ACME. Plain Compose (no Swarm).',
      fields: ['domain', 'network', 'certResolver'],
      defaults: { domain: 'dockerdash.example.com', network: 'proxy', certResolver: 'letsencrypt' },
      render(o) {
        return [
          '# Docker Dash behind a pre-existing Traefik v3 instance.',
          `# Prereq: Traefik is running, attached to the external network "${o.network}",`,
          `# and has a certResolver named "${o.certResolver}" configured for ACME.`,
          '',
          'services:',
          '  docker-dash:',
          '    image: ' + IMAGE,
          '    container_name: docker-dash',
          '    restart: unless-stopped',
          '    environment:',
          '      - ADMIN_PASSWORD=changeme',
          '      - ENCRYPTION_KEY=changeme-32-chars-minimum-edit-this',
          `      - PUBLIC_URL=https://${o.domain}`,
          '    volumes:',
          '      - /var/run/docker.sock:/var/run/docker.sock:ro',
          '      - docker-dash-data:/data',
          '    networks:',
          `      - ${o.network}`,
          '    labels:',
          '      - "traefik.enable=true"',
          `      - "traefik.http.routers.dockerdash.rule=Host(\`${o.domain}\`)"`,
          '      - "traefik.http.routers.dockerdash.entrypoints=websecure"',
          `      - "traefik.http.routers.dockerdash.tls.certresolver=${o.certResolver}"`,
          '      - "traefik.http.services.dockerdash.loadbalancer.server.port=8101"',
          '',
          'volumes:',
          '  docker-dash-data:',
          '',
          'networks:',
          `  ${o.network}:`,
          '    external: true',
        ].join('\n');
      },
    },

    {
      id: 'npm',
      name: 'Nginx Proxy Manager (NPM)',
      description: 'For homelabs running NPM as the UI-based reverse proxy. Exposes the container on a chosen host port; you create the Proxy Host in NPM pointing at it.',
      fields: ['port', 'network'],
      defaults: { port: 8101, network: 'npm_network' },
      render(o) {
        return [
          '# Docker Dash behind Nginx Proxy Manager.',
          '# After deploy:',
          '#   NPM → Hosts → Proxy Hosts → Add Proxy Host:',
          '#     - Domain Names: your.domain.example',
          '#     - Forward Hostname / IP: docker-dash      (if NPM is on the same network)',
          '#                              OR <host-ip>     (if on host network)',
          `#     - Forward Port: ${o.port}`,
          '#     - SSL: request Let\'s Encrypt certificate, Force SSL ON',
          '',
          'services:',
          '  docker-dash:',
          '    image: ' + IMAGE,
          '    container_name: docker-dash',
          '    restart: unless-stopped',
          '    ports:',
          `      - "${o.port}:8101"`,
          '    environment:',
          '      - ADMIN_PASSWORD=changeme',
          '      - ENCRYPTION_KEY=changeme-32-chars-minimum-edit-this',
          '    volumes:',
          '      - /var/run/docker.sock:/var/run/docker.sock:ro',
          '      - docker-dash-data:/data',
          '    networks:',
          `      - ${o.network}`,
          '',
          'volumes:',
          '  docker-dash-data:',
          '',
          'networks:',
          `  ${o.network}:`,
          '    external: true',
        ].join('\n');
      },
    },

    {
      id: 'swarm-traefik',
      name: 'Docker Swarm + Traefik',
      description: 'Swarm-managed Docker Dash behind Traefik. Pins to a manager node (needs Docker socket access for cluster-wide ops). Use `docker stack deploy`.',
      fields: ['domain', 'network', 'certResolver'],
      defaults: { domain: 'dockerdash.example.com', network: 'proxy', certResolver: 'letsencrypt' },
      render(o) {
        return [
          '# Docker Dash on Docker Swarm behind Traefik v3.',
          `# Deploy: docker stack deploy -c compose.yml docker-dash`,
          '# Prereqs: Swarm initialized, Traefik already running on the cluster attached',
          `# to the external overlay network "${o.network}", certResolver "${o.certResolver}" configured.`,
          '',
          'services:',
          '  docker-dash:',
          '    image: ' + IMAGE,
          '    environment:',
          '      - ADMIN_PASSWORD=changeme',
          '      - ENCRYPTION_KEY=changeme-32-chars-minimum-edit-this',
          `      - PUBLIC_URL=https://${o.domain}`,
          '    volumes:',
          '      - /var/run/docker.sock:/var/run/docker.sock:ro',
          '      - docker-dash-data:/data',
          '    networks:',
          `      - ${o.network}`,
          '    deploy:',
          '      placement:',
          '        constraints:',
          '          - node.role == manager',
          '      replicas: 1',
          '      restart_policy:',
          '        condition: any',
          '        delay: 10s',
          '      resources:',
          '        limits:',
          '          cpus: "1.0"',
          '          memory: 512M',
          '      labels:',
          '        - "traefik.enable=true"',
          `        - "traefik.http.routers.dockerdash.rule=Host(\`${o.domain}\`)"`,
          '        - "traefik.http.routers.dockerdash.entrypoints=websecure"',
          `        - "traefik.http.routers.dockerdash.tls.certresolver=${o.certResolver}"`,
          '        - "traefik.http.services.dockerdash.loadbalancer.server.port=8101"',
          `        - "traefik.docker.network=${o.network}"`,
          '',
          'volumes:',
          '  docker-dash-data:',
          '',
          'networks:',
          `  ${o.network}:`,
          '    external: true',
        ].join('\n');
      },
    },

    {
      id: 'ha',
      name: 'HA (2 replicas + Redis leader election)',
      description: 'High-availability mode: 2 docker-dash replicas behind a load balancer of your choice, with Redis-backed leader election so background jobs run on exactly one replica.',
      fields: ['port', 'redisPassword'],
      defaults: { port: 8101, redisPassword: 'changeme-redis-strong-secret' },
      render(o) {
        return [
          '# Docker Dash in HA mode (2 replicas + Redis leader election).',
          '# Cron jobs, drift scans, image pulls etc. run only on the leader — safe to scale.',
          '# Put your reverse proxy (Caddy / Traefik / NPM / nginx) IN FRONT of dd-1 and dd-2.',
          `# Both replicas serve all read + write requests on host port ${o.port}/${o.port + 1}.`,
          '',
          'services:',
          '  dd-redis:',
          '    image: redis:7-alpine',
          '    container_name: dd-redis',
          '    restart: unless-stopped',
          `    command: ["redis-server", "--appendonly", "yes", "--requirepass", "${o.redisPassword}"]`,
          '    volumes:',
          '      - dd-redis-data:/data',
          '',
          '  dd-1:',
          '    image: ' + IMAGE,
          '    container_name: dd-1',
          '    restart: unless-stopped',
          '    depends_on:',
          '      - dd-redis',
          '    ports:',
          `      - "${o.port}:8101"`,
          '    environment:',
          '      - DD_MODE=ha',
          '      - REDIS_URL=redis://:' + o.redisPassword + '@dd-redis:6379',
          '      - ADMIN_PASSWORD=changeme',
          '      - ENCRYPTION_KEY=changeme-32-chars-minimum-edit-this',
          '    volumes:',
          '      - /var/run/docker.sock:/var/run/docker.sock:ro',
          '      - docker-dash-data:/data',
          '',
          '  dd-2:',
          '    image: ' + IMAGE,
          '    container_name: dd-2',
          '    restart: unless-stopped',
          '    depends_on:',
          '      - dd-redis',
          '    ports:',
          `      - "${o.port + 1}:8101"`,
          '    environment:',
          '      - DD_MODE=ha',
          '      - REDIS_URL=redis://:' + o.redisPassword + '@dd-redis:6379',
          '      - ADMIN_PASSWORD=changeme',
          '      - ENCRYPTION_KEY=changeme-32-chars-minimum-edit-this',
          '    volumes:',
          '      - /var/run/docker.sock:/var/run/docker.sock:ro',
          '      - docker-dash-data:/data',
          '',
          'volumes:',
          '  dd-redis-data:',
          '  docker-dash-data:',
        ].join('\n');
      },
    },

    {
      id: 'synology',
      name: 'Synology DSM (Container Manager)',
      description: 'Synology-friendly: bind mounts under /volume1/docker/docker-dash/ so config + data show up in File Station and back up cleanly.',
      fields: ['port', 'stackPath'],
      defaults: { port: 8101, stackPath: '/volume1/docker/docker-dash' },
      render(o) {
        return [
          '# Docker Dash for Synology DSM Container Manager.',
          '# Before deploy: in File Station, create these folders:',
          `#   ${o.stackPath}/data`,
          '# Import: Container Manager → Project → Create → "Create docker-compose.yml" → paste this.',
          '',
          'services:',
          '  docker-dash:',
          '    image: ' + IMAGE,
          '    container_name: docker-dash',
          '    restart: unless-stopped',
          '    ports:',
          `      - "${o.port}:8101"`,
          '    environment:',
          '      - ADMIN_PASSWORD=changeme',
          '      - ENCRYPTION_KEY=changeme-32-chars-minimum-edit-this',
          '    volumes:',
          '      - /var/run/docker.sock:/var/run/docker.sock:ro',
          `      - ${o.stackPath}/data:/data`,
        ].join('\n');
      },
    },
  ];

  function _render(recipeId, userOpts) {
    const recipe = RECIPES.find(r => r.id === recipeId);
    if (!recipe) throw new Error(`Unknown recipe: ${recipeId}`);
    const opts = Object.assign({}, recipe.defaults, userOpts || {});
    return recipe.render(opts);
  }

  // ─── UI ──────────────────────────────────────────────────────────────
  function _fieldHtml(recipe, opts) {
    const f = (id, label, type, val, hint) => `
      <div class="form-group">
        <label style="display:block;margin-bottom:4px;font-size:12px;color:var(--text-dim)">${_esc(label)}</label>
        <input type="${type}" class="form-control depcfg-input" data-key="${id}" value="${_esc(val)}">
        ${hint ? `<div style="font-size:11px;color:var(--text-dim);margin-top:3px">${_esc(hint)}</div>` : ''}
      </div>`;
    const labels = {
      port: ['Host port', 'number', 'Host port that maps to docker-dash 8101'],
      adminPassword: ['Admin password (first login)', 'text', 'Forced password change on first login. Change before deploy.'],
      domain: ['Domain', 'text', 'FQDN whose DNS points at this host'],
      email: ['ACME email', 'text', 'Used by Let\'s Encrypt for cert expiry notices'],
      network: ['External Docker network', 'text', 'Must already exist and be attached to your reverse proxy'],
      certResolver: ['Traefik certResolver name', 'text', 'Matches the resolver name in your Traefik config'],
      redisPassword: ['Redis password', 'text', 'Strong shared secret used by both replicas + Redis'],
      stackPath: ['Synology stack path', 'text', 'Base folder visible in File Station'],
    };
    return recipe.fields.map(key => {
      const [label, type, hint] = labels[key] || [key, 'text', ''];
      return f(key, label, type, opts[key], hint);
    }).join('');
  }

  function open() {
    let activeId = RECIPES[0].id;
    let opts = Object.assign({}, RECIPES[0].defaults);

    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-rocket" style="color:var(--accent);margin-right:8px"></i>Deployment Configurator</h3>
        <button class="modal-close-btn" id="depcfg-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" style="padding:0">
        <div style="display:grid;grid-template-columns:340px 1fr;gap:0;min-height:520px">
          <div style="padding:16px;border-right:1px solid var(--border);background:var(--surface2);overflow-y:auto;max-height:72vh">
            <div class="form-group">
              <label style="display:block;margin-bottom:4px;font-size:12px;color:var(--text-dim)">Recipe</label>
              <select class="form-control" id="depcfg-recipe">
                ${RECIPES.map(r => `<option value="${r.id}">${_esc(r.name)}</option>`).join('')}
              </select>
              <div id="depcfg-desc" style="font-size:11px;color:var(--text-dim);margin-top:6px;line-height:1.4"></div>
            </div>
            <div style="height:1px;background:var(--border);margin:10px 0"></div>
            <div id="depcfg-fields"></div>
          </div>
          <div style="display:flex;flex-direction:column;min-width:0">
            <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;background:var(--surface2)">
              <i class="fas fa-file-code text-muted"></i>
              <span style="font-size:12px;color:var(--text-dim)">docker-compose.yml</span>
              <span style="flex:1"></span>
              <button class="btn btn-xs btn-secondary" id="depcfg-copy"><i class="fas fa-copy"></i> Copy</button>
              <button class="btn btn-xs btn-primary" id="depcfg-download"><i class="fas fa-download"></i> Download</button>
            </div>
            <pre id="depcfg-preview" class="inspect-json" style="margin:0;padding:14px;overflow:auto;flex:1;max-height:72vh;white-space:pre;font-size:12px;border:none;border-radius:0"></pre>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="depcfg-close">Close</button>
      </div>
    `;
    Modal.open(html, { width: 'min(1200px, 96vw)' });

    const root = Modal._content;
    const recipeSel = root.querySelector('#depcfg-recipe');
    const fieldsEl = root.querySelector('#depcfg-fields');
    const descEl = root.querySelector('#depcfg-desc');
    const preview = root.querySelector('#depcfg-preview');

    const rebuildFields = () => {
      const recipe = RECIPES.find(r => r.id === activeId);
      opts = Object.assign({}, recipe.defaults, opts);
      // strip opts that aren't part of this recipe's fields, to avoid leaking
      const keep = new Set(recipe.fields);
      Object.keys(opts).forEach(k => { if (!keep.has(k)) delete opts[k]; });
      Object.assign(opts, Object.fromEntries(recipe.fields.map(k => [k, opts[k] != null ? opts[k] : recipe.defaults[k]])));
      descEl.textContent = recipe.description;
      fieldsEl.innerHTML = _fieldHtml(recipe, opts);
      // wire field inputs
      fieldsEl.querySelectorAll('.depcfg-input').forEach(inp => {
        inp.addEventListener('input', () => {
          const k = inp.dataset.key;
          const v = inp.type === 'number' ? Number(inp.value) || 0 : inp.value;
          opts[k] = v;
          updatePreview();
        });
      });
      updatePreview();
    };
    const updatePreview = () => {
      try { preview.textContent = _render(activeId, opts); }
      catch (e) { preview.textContent = '# render error: ' + e.message; }
    };

    recipeSel.addEventListener('change', () => { activeId = recipeSel.value; rebuildFields(); });
    root.querySelector('#depcfg-x').addEventListener('click', () => Modal.close());
    root.querySelector('#depcfg-close').addEventListener('click', () => Modal.close());
    root.querySelector('#depcfg-copy').addEventListener('click', () => {
      Utils.copyToClipboard(preview.textContent).then(() => Toast.success('Copied!'));
    });
    root.querySelector('#depcfg-download').addEventListener('click', () => {
      const filename = `compose.${activeId}.yml`;
      Utils.downloadBlob(filename, new Blob([preview.textContent], { type: 'text/yaml;charset=utf-8' }));
    });

    rebuildFields();
  }

  return { open, RECIPES, _render };
})();

if (typeof window !== 'undefined') window.DeploymentConfigurator = DeploymentConfigurator;
if (typeof module !== 'undefined' && module.exports) module.exports = DeploymentConfigurator;
