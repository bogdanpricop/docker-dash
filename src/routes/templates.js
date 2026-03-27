'use strict';

const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');

const router = Router();

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
];

// Get all templates (grouped by category)
router.get('/', requireAuth, (req, res) => {
  const { category, search } = req.query;
  let filtered = TEMPLATES;
  if (category) filtered = filtered.filter(t => t.category.toLowerCase() === category.toLowerCase());
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
  }

  const categories = [...new Set(TEMPLATES.map(t => t.category))].sort();
  res.json({ templates: filtered, categories, total: TEMPLATES.length });
});

// Get single template
router.get('/:id', requireAuth, (req, res) => {
  const t = TEMPLATES.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  res.json(t);
});

module.exports = router;
