'use strict';

const { Router } = require('express');
const https = require('https');
const http = require('http');
const { requireAuth, requireRole, writeable, requireFeature } = require('../middleware/auth');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');

const router = Router();

// Logo URLs from walkxcode/dashboard-icons (PNG, CDN-hosted)
// Using jsdelivr CDN for reliability — fallback to FontAwesome icon if image fails to load
const LOGO_BASE = 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons@main/png';
const TEMPLATE_LOGOS = {
  'nginx':              `${LOGO_BASE}/nginx.png`,
  'postgres':           `${LOGO_BASE}/postgresql.png`,
  'redis':              `${LOGO_BASE}/redis.png`,
  'mariadb':            `${LOGO_BASE}/mariadb.png`,
  'mongo':              `${LOGO_BASE}/mongodb.png`,
  'uptime-kuma':        `${LOGO_BASE}/uptime-kuma.png`,
  'grafana':            `${LOGO_BASE}/grafana.png`,
  'prometheus':         `${LOGO_BASE}/prometheus.png`,
  'traefik':            `${LOGO_BASE}/traefik.png`,
  'caddy':              `${LOGO_BASE}/caddy.png`,
  'nextcloud':          `${LOGO_BASE}/nextcloud.png`,
  'gitea':              `${LOGO_BASE}/gitea.png`,
  'n8n':                `${LOGO_BASE}/n8n.png`,
  'vaultwarden':        `${LOGO_BASE}/vaultwarden.png`,
  'adminer':            `${LOGO_BASE}/adminer.png`,
  'minio':              `${LOGO_BASE}/minio.png`,
  'pihole':             `${LOGO_BASE}/pi-hole.png`,
  'homeassistant':      `${LOGO_BASE}/home-assistant.png`,
  'wordpress':          `${LOGO_BASE}/wordpress.png`,
  'dozzle':             `${LOGO_BASE}/dozzle.png`,
  'portainer':          `${LOGO_BASE}/portainer.png`,
  'elasticsearch':      `${LOGO_BASE}/elasticsearch.png`,
  'rabbitmq':           `${LOGO_BASE}/rabbitmq.png`,
  'mailhog':            `${LOGO_BASE}/mailhog.png`,
  'plausible':          `${LOGO_BASE}/plausible.png`,
  'filebrowser':        `${LOGO_BASE}/filebrowser.png`,
  'watchtower':         `${LOGO_BASE}/watchtower.png`,
  'drone':              `${LOGO_BASE}/drone.png`,
  'ghost':              `${LOGO_BASE}/ghost.png`,
  'wireguard':          `${LOGO_BASE}/wireguard.png`,
  'eurooffice':         `${LOGO_BASE}/onlyoffice.png`,
  'eurooffice-nextcloud': `${LOGO_BASE}/nextcloud.png`,
  'eurooffice-dev':     `${LOGO_BASE}/onlyoffice.png`,
};

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
    return { ...t, isBuiltin: true, logoUrl: TEMPLATE_LOGOS[t.id] || null };
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
  {
    id: 'eurooffice', name: 'Euro-Office Document Server', category: 'Office', icon: 'fas fa-file-word',
    description: 'Self-hosted office suite — edit Word, Excel, PowerPoint in browser (OnlyOffice-compatible)',
    compose: `services:\n  eurooffice:\n    image: ghcr.io/euro-office/documentserver:latest\n    ports:\n      - "8080:80"\n    environment:\n      JWT_SECRET: changeme-generate-strong-secret\n      ALLOW_PRIVATE_IP_ADDRESS: "true"\n    volumes:\n      - eo-data:/var/lib/eurooffice\n    restart: unless-stopped\nvolumes:\n  eo-data:`,
  },
  {
    id: 'eurooffice-nextcloud', name: 'Euro-Office + Nextcloud', category: 'Office', icon: 'fas fa-cloud',
    description: 'Complete self-hosted office: Euro-Office document editing + Nextcloud file storage and collaboration',
    compose: `services:\n  eurooffice:\n    image: ghcr.io/euro-office/documentserver:latest\n    container_name: eurooffice\n    ports:\n      - "8080:80"\n    environment:\n      JWT_SECRET: changeme-generate-strong-secret\n      ALLOW_PRIVATE_IP_ADDRESS: "true"\n    volumes:\n      - eo-data:/var/lib/eurooffice\n    restart: unless-stopped\n\n  nextcloud:\n    image: nextcloud:latest\n    container_name: nextcloud\n    ports:\n      - "8081:80"\n    environment:\n      NEXTCLOUD_ADMIN_USER: admin\n      NEXTCLOUD_ADMIN_PASSWORD: changeme\n      NEXTCLOUD_TRUSTED_DOMAINS: "localhost 172.18.0.1"\n    volumes:\n      - nc-data:/var/www/html\n    depends_on:\n      - eurooffice\n    restart: unless-stopped\n\nvolumes:\n  eo-data:\n  nc-data:`,
  },
  {
    id: 'eurooffice-dev', name: 'Euro-Office Dev Stack', category: 'Development', icon: 'fas fa-code',
    description: 'Euro-Office + OnlyOffice side-by-side for comparison testing and development',
    compose: `services:\n  eurooffice:\n    image: ghcr.io/euro-office/documentserver:latest\n    container_name: eurooffice-dev\n    ports:\n      - "8080:80"\n    environment:\n      JWT_SECRET: dev-secret\n      ALLOW_PRIVATE_IP_ADDRESS: "true"\n      USE_UNAUTHORIZED_STORAGE: "true"\n    restart: unless-stopped\n\n  onlyoffice:\n    image: onlyoffice/documentserver:latest\n    container_name: onlyoffice-compare\n    ports:\n      - "8082:80"\n    environment:\n      JWT_SECRET: dev-secret\n      ALLOW_PRIVATE_IP_ADDRESS: "true"\n      USE_UNAUTHORIZED_STORAGE: "true"\n    restart: unless-stopped\n\n  nextcloud:\n    image: nextcloud:latest\n    container_name: nextcloud-dev\n    ports:\n      - "8081:80"\n    environment:\n      NEXTCLOUD_ADMIN_USER: admin\n      NEXTCLOUD_ADMIN_PASSWORD: admin\n      SQLITE_DATABASE: nextcloud\n    volumes:\n      - nc-dev-data:/var/www/html\n    restart: unless-stopped\n\nvolumes:\n  nc-dev-data:`,
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

/** Parse simple compose YAML into service objects (no external YAML library needed) */
function _parseComposeServices(yaml) {
  const services = [];
  const lines = yaml.split('\n');
  let currentService = null;
  let inEnvironment = false;
  let inPorts = false;
  let inVolumes = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    // Detect service names (children of 'services:')
    if (trimmed === 'services:') continue;
    if (indent === 2 && trimmed.endsWith(':') && !trimmed.includes(' ')) {
      if (currentService) services.push(currentService);
      currentService = { name: trimmed.slice(0, -1), image: '', env: [], ports: [], volumes: [], restart: 'unless-stopped' };
      inEnvironment = false; inPorts = false; inVolumes = false;
      continue;
    }

    if (!currentService) continue;

    // Service properties
    if (indent === 4) {
      inEnvironment = false; inPorts = false; inVolumes = false;
      if (trimmed.startsWith('image:')) currentService.image = trimmed.split(':').slice(1).join(':').trim().replace(/['"]/g, '');
      else if (trimmed.startsWith('restart:')) currentService.restart = trimmed.split(':')[1].trim().replace(/['"]/g, '');
      else if (trimmed === 'environment:') inEnvironment = true;
      else if (trimmed === 'ports:') inPorts = true;
      else if (trimmed === 'volumes:') inVolumes = true;
    }

    // List items under environment/ports/volumes
    if (indent >= 6 && trimmed.startsWith('-')) {
      const val = trimmed.slice(1).trim().replace(/^["']|["']$/g, '');
      if (inPorts) currentService.ports.push(val);
      else if (inVolumes) currentService.volumes.push(val);
      else if (inEnvironment) currentService.env.push(val);
    }
    // Map-style environment (KEY: value)
    if (indent >= 6 && inEnvironment && !trimmed.startsWith('-') && trimmed.includes(':')) {
      const [k, ...v] = trimmed.split(':');
      currentService.env.push(`${k.trim()}=${v.join(':').trim().replace(/^["']|["']$/g, '')}`);
    }
  }
  if (currentService) services.push(currentService);
  return services;
}

// Deploy a template via Docker API (dockerode — works on any host)
router.post('/:id/deploy', requireAuth, requireRole('admin', 'operator'), writeable, requireFeature('create'), async (req, res) => {
  try {
    const t = findTemplate(req.params.id);
    if (!t) return res.status(404).json({ error: 'Template not found' });

    const stackName = req.body.name || t.id;
    if (!/^[a-zA-Z0-9_-]+$/.test(stackName)) {
      return res.status(400).json({ error: 'Stack name must contain only letters, numbers, dashes, underscores' });
    }

    const compose = (req.body.compose && typeof req.body.compose === 'string') ? req.body.compose : t.compose;

    // Parse compose YAML to extract services
    const services = _parseComposeServices(compose);
    if (services.length === 0) return res.status(400).json({ error: 'No services found in compose YAML' });

    const dockerService = require('../services/docker');
    const docker = dockerService.getDocker(req.hostId);
    const results = [];

    for (const svc of services) {
      const containerName = services.length === 1 ? stackName : `${stackName}-${svc.name}`;

      // Remove existing container with same name (if any)
      try {
        const existing = docker.getContainer(containerName);
        const info = await existing.inspect();
        if (info) {
          try { await existing.stop(); } catch { /* may already be stopped */ }
          await existing.remove({ force: true });
        }
      } catch { /* container doesn't exist — good */ }

      // Pull image
      try {
        await new Promise((resolve, reject) => {
          docker.pull(svc.image, (err, stream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (err2) => err2 ? reject(err2) : resolve());
          });
        });
      } catch (pullErr) {
        // Image might already exist locally
      }

      // Build container config — do NOT set Cmd (let image default apply)
      const createOpts = {
        name: containerName,
        Image: svc.image,
        Labels: { 'com.docker.compose.project': stackName, 'com.docker.compose.service': svc.name, 'docker-dash.template': t.id },
        HostConfig: {
          RestartPolicy: { Name: svc.restart || 'unless-stopped' },
          PortBindings: {},
          Binds: [],
        },
      };
      // Only set Env if non-empty
      if (svc.env && svc.env.length > 0) createOpts.Env = svc.env;
      // Only set ExposedPorts if we have ports
      if (svc.ports && svc.ports.length > 0) createOpts.ExposedPorts = {};

      // Ports
      for (const p of (svc.ports || [])) {
        const [hostPort, containerPort] = p.split(':');
        const proto = containerPort.includes('/') ? '' : '/tcp';
        const cPort = containerPort.replace(/\/(tcp|udp)/, '') + proto;
        createOpts.ExposedPorts[cPort] = {};
        createOpts.HostConfig.PortBindings[cPort] = [{ HostPort: hostPort }];
      }

      // Volumes
      for (const v of (svc.volumes || [])) {
        if (v.includes(':')) {
          createOpts.HostConfig.Binds.push(v);
        }
      }

      // Create and start
      const container = await docker.createContainer(createOpts);
      await container.start();
      results.push({ name: containerName, id: container.id });
    }

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'template_deploy', targetType: 'template', targetId: t.id,
      details: { template: t.name, stackName, containers: results.map(r => r.name) }, ip: getClientIp(req),
    });

    res.json({ ok: true, stackName, containers: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Portainer Template Import ─────────────────────────────

/** Fetch JSON from a URL using built-in https/http */
function _fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000, headers: { 'User-Agent': 'DockerDash/5.0' } }, (res) => {
      // Follow redirects (up to 3)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return _fetchJson(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

/** Convert a Portainer type-1 (container) template to compose YAML */
function _portainerContainerToCompose(t) {
  const svcName = (t.name || 'app').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const lines = ['services:', `  ${svcName}:`];
  lines.push(`    image: ${t.image || 'unknown'}`);

  if (t.env && t.env.length > 0) {
    lines.push('    environment:');
    for (const e of t.env) {
      const val = e.default || e.preset || '';
      lines.push(`      ${e.name}: "${val}"`);
    }
  }

  if (t.ports && t.ports.length > 0) {
    lines.push('    ports:');
    for (const p of t.ports) {
      const hp = p.split(':')[0] || p.split('/')[0];
      const cp = p.includes(':') ? p.split(':')[1] : p;
      lines.push(`      - "${hp}:${cp}"`);
    }
  }

  if (t.volumes && t.volumes.length > 0) {
    lines.push('    volumes:');
    const namedVolumes = [];
    for (const v of t.volumes) {
      const bind = v.bind || v.container;
      if (bind) {
        if (v.bind && !v.bind.startsWith('/')) {
          // Named volume
          lines.push(`      - ${v.bind}:${v.container}`);
          namedVolumes.push(v.bind);
        } else {
          const volName = svcName + '-data' + (namedVolumes.length ? namedVolumes.length : '');
          lines.push(`      - ${volName}:${v.container}${v.readonly ? ':ro' : ''}`);
          namedVolumes.push(volName);
        }
      }
    }
    if (namedVolumes.length > 0) {
      lines.push('volumes:');
      for (const n of namedVolumes) lines.push(`  ${n}:`);
    }
  }

  lines.push('    restart: unless-stopped');
  return lines.join('\n');
}

/** Convert Portainer template to Docker Dash format */
function _convertPortainerTemplate(t) {
  const id = (t.name || 'imported').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 48);

  let compose = '';
  const type = t.type || 1;

  if (type === 1) {
    compose = _portainerContainerToCompose(t);
  } else if (type === 2) {
    // Stack — compose may be in stackfile field or repository
    compose = t.stackfile || '';
    if (!compose && t.repository?.stackfile) {
      compose = `# Fetch from: ${t.repository.url}\n# File: ${t.repository.stackfile}\nservices:\n  app:\n    image: ${t.image || 'placeholder'}\n    restart: unless-stopped`;
    }
    if (!compose) {
      compose = `services:\n  app:\n    image: ${t.image || 'placeholder'}\n    restart: unless-stopped`;
    }
  } else if (type === 3) {
    compose = t.stackfile || t.compose || '';
    if (!compose) {
      compose = `services:\n  app:\n    image: ${t.image || 'placeholder'}\n    restart: unless-stopped`;
    }
  }

  // Map categories
  const categoryMap = { 'Databases': 'Database', 'Webservers': 'Web Server', 'Monitoring': 'Monitoring' };
  const cats = t.categories || [];
  const category = categoryMap[cats[0]] || cats[0] || 'Imported';

  return {
    id,
    name: t.title || t.name || id,
    category,
    icon: 'fas fa-file-import',
    description: t.description || '',
    compose,
    type,
    logo: t.logo || '',
  };
}

// Preview Portainer templates (fetch + convert, no save)
router.post('/import/preview', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    // Basic URL validation
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ error: 'URL must start with http:// or https://' });
    }

    const data = await _fetchJson(url);

    // Portainer templates can be { version: "2", templates: [...] } or just an array
    const rawTemplates = Array.isArray(data) ? data : (data.templates || []);

    if (!rawTemplates.length) {
      return res.status(400).json({ error: 'No templates found at the provided URL' });
    }

    // Check which IDs already exist
    const db = getDb();
    const existingBuiltin = new Set(TEMPLATES.map(t => t.id));
    const existingCustom = new Set(
      db.prepare('SELECT id FROM custom_templates').all().map(r => r.id)
    );

    const converted = rawTemplates.map(t => {
      const c = _convertPortainerTemplate(t);
      c.alreadyExists = existingBuiltin.has(c.id) || existingCustom.has(c.id);
      return c;
    });

    res.json({
      total: converted.length,
      templates: converted,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import selected Portainer templates (save to DB)
router.post('/import', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { templates: toImport } = req.body;
    if (!Array.isArray(toImport) || toImport.length === 0) {
      return res.status(400).json({ error: 'templates array is required' });
    }

    const db = getDb();
    const existingBuiltin = new Set(TEMPLATES.map(t => t.id));
    const existingCustom = new Set(
      db.prepare('SELECT id FROM custom_templates').all().map(r => r.id)
    );

    const insert = db.prepare(`INSERT INTO custom_templates (id, name, category, icon, description, compose, is_builtin_override, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`);

    let imported = 0;
    let skipped = 0;
    const importMany = db.transaction(() => {
      for (const t of toImport) {
        // Deduplicate: append suffix if needed
        let id = t.id;
        if (existingBuiltin.has(id) || existingCustom.has(id)) {
          // Try with -imported suffix
          id = id + '-imported';
          if (existingBuiltin.has(id) || existingCustom.has(id)) {
            skipped++;
            continue;
          }
        }
        existingCustom.add(id);
        insert.run(
          id, t.name, t.category || 'Imported', t.icon || 'fas fa-file-import',
          (t.description || '').substring(0, 500), t.compose,
          req.user.username, req.user.username
        );
        imported++;
      }
    });
    importMany();

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'template_import', targetType: 'template', targetId: 'portainer',
      details: { imported, skipped, total: toImport.length }, ip: getClientIp(req),
    });

    res.json({ ok: true, imported, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
