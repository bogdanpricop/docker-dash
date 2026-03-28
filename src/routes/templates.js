'use strict';

const { Router } = require('express');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { requireAuth, requireRole, writeable, requireFeature } = require('../middleware/auth');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');

const router = Router();

/** Merge built-in templates with DB overrides and custom templates */
function getMergedTemplates() {
  const db = getDb();
  const customRows = db.prepare('SELECT * FROM custom_templates').all();
  const overrideMap = {};
  const customOnly = [];
  for (const row of customRows) {
    if (row.is_builtin_override) {
      overrideMap[row.id] = row;
    } else {
      customOnly.push({
        id: row.id, name: row.name, category: row.category,
        icon: row.icon, description: row.description, compose: row.compose,
        isCustom: true,
        createdBy: row.created_by, createdAt: row.created_at,
        updatedBy: row.updated_by, updatedAt: row.updated_at,
      });
    }
  }

  const merged = TEMPLATES.map(t => {
    const override = overrideMap[t.id];
    if (override) {
      return {
        ...t,
        name: override.name, category: override.category,
        icon: override.icon, description: override.description,
        compose: override.compose,
        isModified: true, isBuiltin: true,
        updatedBy: override.updated_by, updatedAt: override.updated_at,
        originalCompose: t.compose,
      };
    }
    return { ...t, isBuiltin: true };
  });

  return [...merged, ...customOnly];
}

/** Find a template by id (merged) */
function findTemplate(id) {
  return getMergedTemplates().find(t => t.id === id);
}

// Curated app templates — no external dependency, ships with Docker Dash
const TEMPLATES = [
  {
    id: 'nginx', name: 'Nginx', category: 'Web Server', icon: 'fas fa-globe',
    description: 'High-performance web server and reverse proxy',
    compose: `services:\n  nginx:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n    volumes:\n      - ./html:/usr/share/nginx/html:ro\n    restart: unless-stopped`,
  },
  {
    id: 'postgres', name: 'PostgreSQL', category: 'Database', icon: 'fas fa-database',
    description: 'Advanced open-source relational database',
    compose: `services:\n  postgres:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_PASSWORD: changeme\n      POSTGRES_DB: myapp\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n    ports:\n      - "5432:5432"\n    restart: unless-stopped\nvolumes:\n  pgdata:`,
  },
  {
    id: 'redis', name: 'Redis', category: 'Database', icon: 'fas fa-bolt',
    description: 'In-memory data store for caching and messaging',
    compose: `services:\n  redis:\n    image: redis:7-alpine\n    command: redis-server --appendonly yes\n    volumes:\n      - redis-data:/data\n    ports:\n      - "6379:6379"\n    restart: unless-stopped\nvolumes:\n  redis-data:`,
  },
  {
    id: 'mariadb', name: 'MariaDB', category: 'Database', icon: 'fas fa-database',
    description: 'Community-developed fork of MySQL',
    compose: `services:\n  mariadb:\n    image: mariadb:11\n    environment:\n      MYSQL_ROOT_PASSWORD: changeme\n      MYSQL_DATABASE: myapp\n    volumes:\n      - mariadb-data:/var/lib/mysql\n    ports:\n      - "3306:3306"\n    restart: unless-stopped\nvolumes:\n  mariadb-data:`,
  },
  {
    id: 'mongo', name: 'MongoDB', category: 'Database', icon: 'fas fa-leaf',
    description: 'NoSQL document database',
    compose: `services:\n  mongo:\n    image: mongo:7\n    environment:\n      MONGO_INITDB_ROOT_USERNAME: admin\n      MONGO_INITDB_ROOT_PASSWORD: changeme\n    volumes:\n      - mongo-data:/data/db\n    ports:\n      - "27017:27017"\n    restart: unless-stopped\nvolumes:\n  mongo-data:`,
  },
  {
    id: 'uptime-kuma', name: 'Uptime Kuma', category: 'Monitoring', icon: 'fas fa-heartbeat',
    description: 'Self-hosted monitoring tool like Uptime Robot',
    compose: `services:\n  uptime-kuma:\n    image: louislam/uptime-kuma:1\n    volumes:\n      - uptime-data:/app/data\n    ports:\n      - "3001:3001"\n    restart: unless-stopped\nvolumes:\n  uptime-data:`,
  },
  {
    id: 'grafana', name: 'Grafana', category: 'Monitoring', icon: 'fas fa-chart-area',
    description: 'Observability platform for metrics and dashboards',
    compose: `services:\n  grafana:\n    image: grafana/grafana:latest\n    volumes:\n      - grafana-data:/var/lib/grafana\n    ports:\n      - "3000:3000"\n    restart: unless-stopped\nvolumes:\n  grafana-data:`,
  },
  {
    id: 'prometheus', name: 'Prometheus', category: 'Monitoring', icon: 'fas fa-fire',
    description: 'Systems monitoring and alerting toolkit',
    compose: `services:\n  prometheus:\n    image: prom/prometheus:latest\n    volumes:\n      - ./prometheus.yml:/etc/prometheus/prometheus.yml\n      - prom-data:/prometheus\n    ports:\n      - "9090:9090"\n    restart: unless-stopped\nvolumes:\n  prom-data:`,
  },
  {
    id: 'traefik', name: 'Traefik', category: 'Reverse Proxy', icon: 'fas fa-random',
    description: 'Modern HTTP reverse proxy and load balancer',
    compose: `services:\n  traefik:\n    image: traefik:v3.0\n    command:\n      - "--api.dashboard=true"\n      - "--providers.docker=true"\n      - "--entrypoints.web.address=:80"\n      - "--entrypoints.websecure.address=:443"\n    ports:\n      - "80:80"\n      - "443:443"\n      - "8080:8080"\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n    restart: unless-stopped`,
  },
  {
    id: 'caddy', name: 'Caddy', category: 'Reverse Proxy', icon: 'fas fa-lock',
    description: 'Automatic HTTPS web server',
    compose: `services:\n  caddy:\n    image: caddy:2-alpine\n    ports:\n      - "80:80"\n      - "443:443"\n    volumes:\n      - ./Caddyfile:/etc/caddy/Caddyfile\n      - caddy-data:/data\n      - caddy-config:/config\n    restart: unless-stopped\nvolumes:\n  caddy-data:\n  caddy-config:`,
  },
  {
    id: 'nextcloud', name: 'Nextcloud', category: 'Cloud Storage', icon: 'fas fa-cloud',
    description: 'Self-hosted productivity platform and file sync',
    compose: `services:\n  nextcloud:\n    image: nextcloud:latest\n    volumes:\n      - nextcloud-data:/var/www/html\n    ports:\n      - "8080:80"\n    restart: unless-stopped\nvolumes:\n  nextcloud-data:`,
  },
  {
    id: 'gitea', name: 'Gitea', category: 'Development', icon: 'fab fa-git-alt',
    description: 'Lightweight self-hosted Git service',
    compose: `services:\n  gitea:\n    image: gitea/gitea:latest\n    environment:\n      - USER_UID=1000\n      - USER_GID=1000\n    volumes:\n      - gitea-data:/data\n    ports:\n      - "3000:3000"\n      - "2222:22"\n    restart: unless-stopped\nvolumes:\n  gitea-data:`,
  },
  {
    id: 'n8n', name: 'n8n', category: 'Automation', icon: 'fas fa-project-diagram',
    description: 'Workflow automation tool (Zapier alternative)',
    compose: `services:\n  n8n:\n    image: n8nio/n8n:latest\n    environment:\n      - N8N_BASIC_AUTH_ACTIVE=true\n      - N8N_BASIC_AUTH_USER=admin\n      - N8N_BASIC_AUTH_PASSWORD=changeme\n    volumes:\n      - n8n-data:/home/node/.n8n\n    ports:\n      - "5678:5678"\n    restart: unless-stopped\nvolumes:\n  n8n-data:`,
  },
  {
    id: 'vaultwarden', name: 'Vaultwarden', category: 'Security', icon: 'fas fa-key',
    description: 'Bitwarden-compatible password manager server',
    compose: `services:\n  vaultwarden:\n    image: vaultwarden/server:latest\n    volumes:\n      - vw-data:/data\n    ports:\n      - "8080:80"\n    restart: unless-stopped\nvolumes:\n  vw-data:`,
  },
  {
    id: 'adminer', name: 'Adminer', category: 'Database', icon: 'fas fa-table',
    description: 'Lightweight database management UI',
    compose: `services:\n  adminer:\n    image: adminer:latest\n    ports:\n      - "8080:8080"\n    restart: unless-stopped`,
  },
  {
    id: 'minio', name: 'MinIO', category: 'Storage', icon: 'fas fa-hdd',
    description: 'S3-compatible object storage',
    compose: `services:\n  minio:\n    image: minio/minio:latest\n    command: server /data --console-address ":9001"\n    environment:\n      MINIO_ROOT_USER: admin\n      MINIO_ROOT_PASSWORD: changeme123\n    volumes:\n      - minio-data:/data\n    ports:\n      - "9000:9000"\n      - "9001:9001"\n    restart: unless-stopped\nvolumes:\n  minio-data:`,
  },
  {
    id: 'pihole', name: 'Pi-hole', category: 'Networking', icon: 'fas fa-shield-alt',
    description: 'Network-wide ad blocker and DNS sinkhole',
    compose: `services:\n  pihole:\n    image: pihole/pihole:latest\n    environment:\n      WEBPASSWORD: changeme\n    volumes:\n      - pihole-etc:/etc/pihole\n      - pihole-dns:/etc/dnsmasq.d\n    ports:\n      - "53:53/tcp"\n      - "53:53/udp"\n      - "8080:80"\n    restart: unless-stopped\nvolumes:\n  pihole-etc:\n  pihole-dns:`,
  },
  {
    id: 'homeassistant', name: 'Home Assistant', category: 'IoT', icon: 'fas fa-home',
    description: 'Open-source home automation platform',
    compose: `services:\n  homeassistant:\n    image: ghcr.io/home-assistant/home-assistant:stable\n    volumes:\n      - ha-config:/config\n    ports:\n      - "8123:8123"\n    restart: unless-stopped\nvolumes:\n  ha-config:`,
  },
  {
    id: 'wordpress', name: 'WordPress', category: 'CMS', icon: 'fab fa-wordpress',
    description: 'Popular content management system',
    compose: `services:\n  wordpress:\n    image: wordpress:latest\n    environment:\n      WORDPRESS_DB_HOST: db\n      WORDPRESS_DB_USER: wp\n      WORDPRESS_DB_PASSWORD: changeme\n      WORDPRESS_DB_NAME: wordpress\n    volumes:\n      - wp-data:/var/www/html\n    ports:\n      - "8080:80"\n    depends_on:\n      - db\n    restart: unless-stopped\n  db:\n    image: mariadb:11\n    environment:\n      MYSQL_ROOT_PASSWORD: rootchangeme\n      MYSQL_DATABASE: wordpress\n      MYSQL_USER: wp\n      MYSQL_PASSWORD: changeme\n    volumes:\n      - wp-db:/var/lib/mysql\n    restart: unless-stopped\nvolumes:\n  wp-data:\n  wp-db:`,
  },
  {
    id: 'dozzle', name: 'Dozzle', category: 'Monitoring', icon: 'fas fa-scroll',
    description: 'Real-time Docker log viewer (7MB)',
    compose: `services:\n  dozzle:\n    image: amir20/dozzle:latest\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n    ports:\n      - "8080:8080"\n    restart: unless-stopped`,
  },
  {
    id: 'portainer', name: 'Portainer CE', category: 'Management', icon: 'fas fa-columns',
    description: 'Docker management UI (for comparison testing)',
    compose: `services:\n  portainer:\n    image: portainer/portainer-ce:latest\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n      - portainer-data:/data\n    ports:\n      - "9443:9443"\n    restart: unless-stopped\nvolumes:\n  portainer-data:`,
  },
  {
    id: 'elasticsearch', name: 'Elasticsearch', category: 'Search', icon: 'fas fa-search',
    description: 'Distributed search and analytics engine',
    compose: `services:\n  elasticsearch:\n    image: elasticsearch:8.12.0\n    environment:\n      - discovery.type=single-node\n      - xpack.security.enabled=false\n      - ES_JAVA_OPTS=-Xms512m -Xmx512m\n    volumes:\n      - es-data:/usr/share/elasticsearch/data\n    ports:\n      - "9200:9200"\n    restart: unless-stopped\nvolumes:\n  es-data:`,
  },
  {
    id: 'rabbitmq', name: 'RabbitMQ', category: 'Messaging', icon: 'fas fa-exchange-alt',
    description: 'Message broker with management UI',
    compose: `services:\n  rabbitmq:\n    image: rabbitmq:3-management-alpine\n    environment:\n      RABBITMQ_DEFAULT_USER: admin\n      RABBITMQ_DEFAULT_PASS: changeme\n    volumes:\n      - rabbitmq-data:/var/lib/rabbitmq\n    ports:\n      - "5672:5672"\n      - "15672:15672"\n    restart: unless-stopped\nvolumes:\n  rabbitmq-data:`,
  },
  {
    id: 'mailhog', name: 'MailHog', category: 'Development', icon: 'fas fa-envelope',
    description: 'Email testing tool — catches outgoing emails',
    compose: `services:\n  mailhog:\n    image: mailhog/mailhog:latest\n    ports:\n      - "1025:1025"\n      - "8025:8025"\n    restart: unless-stopped`,
  },
  {
    id: 'plausible', name: 'Plausible Analytics', category: 'Analytics', icon: 'fas fa-chart-line',
    description: 'Privacy-friendly web analytics (Google Analytics alternative)',
    compose: `services:\n  plausible:\n    image: plausible/analytics:latest\n    ports:\n      - "8000:8000"\n    environment:\n      - BASE_URL=http://localhost:8000\n      - SECRET_KEY_BASE=changeme_generate_64_chars\n    volumes:\n      - plausible-data:/var/lib/plausible\n    restart: unless-stopped\nvolumes:\n  plausible-data:`,
  },
  {
    id: 'filebrowser', name: 'File Browser', category: 'Storage', icon: 'fas fa-folder-open',
    description: 'Web-based file manager with sharing',
    compose: `services:\n  filebrowser:\n    image: filebrowser/filebrowser:latest\n    volumes:\n      - /path/to/files:/srv\n      - filebrowser-db:/database\n    ports:\n      - "8080:80"\n    restart: unless-stopped\nvolumes:\n  filebrowser-db:`,
  },
  {
    id: 'watchtower', name: 'Watchtower', category: 'Management', icon: 'fas fa-binoculars',
    description: 'Auto-update Docker containers (Docker Dash has native safe-pull)',
    compose: `services:\n  watchtower:\n    image: containrrr/watchtower:latest\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n    environment:\n      - WATCHTOWER_CLEANUP=true\n      - WATCHTOWER_POLL_INTERVAL=86400\n    restart: unless-stopped`,
  },
  {
    id: 'drone', name: 'Drone CI', category: 'CI/CD', icon: 'fas fa-rocket',
    description: 'Self-hosted continuous integration platform',
    compose: `services:\n  drone:\n    image: drone/drone:latest\n    environment:\n      - DRONE_SERVER_HOST=localhost\n      - DRONE_SERVER_PROTO=http\n    volumes:\n      - drone-data:/data\n    ports:\n      - "8080:80"\n    restart: unless-stopped\nvolumes:\n  drone-data:`,
  },
  {
    id: 'ghost', name: 'Ghost', category: 'CMS', icon: 'fas fa-ghost',
    description: 'Modern publishing platform (blogging)',
    compose: `services:\n  ghost:\n    image: ghost:5-alpine\n    environment:\n      url: http://localhost:2368\n    volumes:\n      - ghost-data:/var/lib/ghost/content\n    ports:\n      - "2368:2368"\n    restart: unless-stopped\nvolumes:\n  ghost-data:`,
  },
  {
    id: 'wireguard', name: 'WireGuard', category: 'VPN', icon: 'fas fa-lock',
    description: 'Modern VPN tunnel',
    compose: `services:\n  wireguard:\n    image: lscr.io/linuxserver/wireguard:latest\n    cap_add:\n      - NET_ADMIN\n      - SYS_MODULE\n    environment:\n      - PEERS=3\n      - SERVERURL=auto\n    volumes:\n      - wg-config:/config\n    ports:\n      - "51820:51820/udp"\n    sysctls:\n      - net.ipv4.conf.all.src_valid_mark=1\n    restart: unless-stopped\nvolumes:\n  wg-config:`,
  },
];

// Get all templates (built-in + custom, with overrides merged)
router.get('/', requireAuth, (req, res) => {
  const { category, search } = req.query;
  let all = getMergedTemplates();
  if (category) all = all.filter(t => t.category.toLowerCase() === category.toLowerCase());
  if (search) {
    const q = search.toLowerCase();
    all = all.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
  }
  const categories = [...new Set(getMergedTemplates().map(t => t.category))].sort();
  res.json({ templates: all, categories, total: all.length });
});

// Get single template
router.get('/:id', requireAuth, (req, res) => {
  const t = findTemplate(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  res.json(t);
});

// Create custom template
router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { id, name, category, icon, description, compose } = req.body;
    if (!id || !name || !compose) return res.status(400).json({ error: 'id, name, and compose are required' });
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: 'id must be alphanumeric with dashes/underscores' });

    // Check if id conflicts with built-in
    if (TEMPLATES.find(t => t.id === id)) {
      return res.status(409).json({ error: 'A built-in template with this id already exists. Use PUT to override it.' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM custom_templates WHERE id = ?').get(id);
    if (existing) return res.status(409).json({ error: 'A custom template with this id already exists' });

    db.prepare(`INSERT INTO custom_templates (id, name, category, icon, description, compose, is_builtin_override, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
      id, name, category || 'Custom', icon || 'fas fa-cube', description || '', compose,
      req.user.username, req.user.username
    );

    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'template_create', targetType: 'template', targetId: id, ip: getClientIp(req) });

    res.status(201).json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update template (custom or override built-in)
router.put('/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { name, category, icon, description, compose } = req.body;
    if (!name || !compose) return res.status(400).json({ error: 'name and compose are required' });

    const db = getDb();
    const isBuiltin = !!TEMPLATES.find(t => t.id === req.params.id);
    const existing = db.prepare('SELECT id FROM custom_templates WHERE id = ?').get(req.params.id);

    if (existing) {
      // Update existing override/custom
      db.prepare(`UPDATE custom_templates SET name=?, category=?, icon=?, description=?, compose=?,
        updated_by=?, updated_at=datetime('now') WHERE id=?`).run(
        name, category || 'Custom', icon || 'fas fa-cube', description || '', compose,
        req.user.username, req.params.id
      );
    } else if (isBuiltin) {
      // Create override for built-in
      db.prepare(`INSERT INTO custom_templates (id, name, category, icon, description, compose, is_builtin_override, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        req.params.id, name, category || 'Custom', icon || 'fas fa-cube', description || '', compose,
        req.user.username, req.user.username
      );
    } else {
      return res.status(404).json({ error: 'Template not found' });
    }

    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'template_update', targetType: 'template', targetId: req.params.id, ip: getClientIp(req) });

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reset built-in template to original
router.post('/:id/reset', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const isBuiltin = !!TEMPLATES.find(t => t.id === req.params.id);
    if (!isBuiltin) return res.status(400).json({ error: 'Only built-in templates can be reset' });

    const db = getDb();
    db.prepare('DELETE FROM custom_templates WHERE id = ? AND is_builtin_override = 1').run(req.params.id);

    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'template_reset', targetType: 'template', targetId: req.params.id, ip: getClientIp(req) });

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete custom template (cannot delete built-in)
router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const isBuiltin = !!TEMPLATES.find(t => t.id === req.params.id);
    if (isBuiltin) return res.status(400).json({ error: 'Cannot delete built-in templates. Use PUT to override or POST /reset to restore.' });

    const db = getDb();
    const result = db.prepare('DELETE FROM custom_templates WHERE id = ? AND is_builtin_override = 0').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Custom template not found' });

    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'template_delete', targetType: 'template', targetId: req.params.id, ip: getClientIp(req) });

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deploy a template (writes temp compose file, runs docker compose up)
router.post('/:id/deploy', requireAuth, requireRole('admin', 'operator'), writeable, requireFeature('create'), async (req, res) => {
  try {
    const t = findTemplate(req.params.id);
    if (!t) return res.status(404).json({ error: 'Template not found' });

    const stackName = req.body.name || t.id;
    // Validate stack name: only alphanumeric, dash, underscore
    if (!/^[a-zA-Z0-9_-]+$/.test(stackName)) {
      return res.status(400).json({ error: 'Stack name must contain only letters, numbers, dashes, underscores' });
    }

    // Replace service name in compose YAML
    let compose = t.compose;
    // Replace first service name with custom name
    compose = compose.replace(/^(services:\n  )\S+:/m, `$1${stackName}:`);

    // Write temp compose file
    const tmpDir = path.join(os.tmpdir(), `dd-template-${stackName}-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const composeFile = path.join(tmpDir, 'docker-compose.yml');
    fs.writeFileSync(composeFile, compose, 'utf8');

    // Run docker compose up
    const output = execFileSync('docker', ['compose', '-f', composeFile, '-p', stackName, 'up', '-d'], {
      timeout: 120000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Cleanup temp file
    try { fs.unlinkSync(composeFile); fs.rmdirSync(tmpDir); } catch {}

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'template_deploy', targetType: 'template', targetId: t.id,
      details: { template: t.name, stackName }, ip: getClientIp(req),
    });

    res.json({ ok: true, stackName, output });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

module.exports = router;
