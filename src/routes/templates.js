'use strict';

const { Router } = require('express');
const https = require('https');
const http = require('http');
const { requireAuth, requireRole, writeable, requireFeature } = require('../middleware/auth');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');
const asyncHandler = require('../utils/asyncHandler');

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
// v8.3.0-prep — Trust signals for built-in templates.
// Maintainer reviews each template against the current upstream image and
// confirms it deploys cleanly. The date here is the LAST verification time.
// UI flags any template with no entry, or stale > 180 days, accordingly.
const BUILTIN_VERIFICATION = {
  // Verified 2026-05-05 (v8.2.0 release sweep)
  'private-registry':            { verified_at: '2026-05-05' },
  'private-registry-with-cache': { verified_at: '2026-05-05' },
  'ai-ollama':                   { verified_at: '2026-05-05' },
  'ai-ollama-openwebui':         { verified_at: '2026-05-05' },
  'ai-rag-stack':                { verified_at: '2026-05-05' },
  'ai-vllm':                     { verified_at: '2026-05-05' },
  'ai-stable-diffusion':         { verified_at: '2026-05-05' },
  'ai-comfyui':                  { verified_at: '2026-05-05' },
  'ai-whisper':                  { verified_at: '2026-05-05' },
  'ai-langflow':                 { verified_at: '2026-05-05' },
  'ai-anything-llm':             { verified_at: '2026-05-05' },
  'ai-n8n':                      { verified_at: '2026-05-05' },
  'ai-litellm':                  { verified_at: '2026-05-05' },
  'ai-flowise':                  { verified_at: '2026-05-05' },
  // Verified 2026-05-27
  'unifi-network-application':   { verified_at: '2026-05-27' },
  // Older built-ins — not re-verified yet. UI shows neutral state, no warning.
  // Add entries here as you re-validate.
};

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
    const v = BUILTIN_VERIFICATION[t.id] || {};
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
        verified_at: v.verified_at || null,
        deprecated_in_favor_of: v.deprecated_in_favor_of || null,
      };
    }
    return {
      ...t, isBuiltin: true,
      logoUrl: TEMPLATE_LOGOS[t.id] || null,
      verified_at: v.verified_at || null,
      deprecated_in_favor_of: v.deprecated_in_favor_of || null,
    };
  });

  // Custom templates carry their own verified_at / deprecated_in_favor_of from DB
  const customWithVerification = customOnly.map(c => {
    const row = customRows.find(r => r.id === c.id);
    return {
      ...c,
      verified_at: row?.verified_at || null,
      deprecated_in_favor_of: row?.deprecated_in_favor_of || null,
    };
  });

  return [...merged, ...customWithVerification];
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
  {
    // v7.5.0 — Private OCI Image Registry (Docker Distribution).
    // Single container + 1 volume + htpasswd auth. After deploy:
    //   1. Generate htpasswd:
    //      docker run --rm --entrypoint htpasswd httpd:2 -Bbn youruser yourpass > ./auth/htpasswd
    //   2. Configure as a Registry credential in Settings → Registries (URL: http://<host>:5000)
    //   3. Push images via the Images page → Push to Registry action.
    // For TLS, front it with the Caddy compose profile (--profile tls) — don't expose :5000 publicly without it.
    id: 'private-registry', name: 'Private Registry (Distribution)', category: 'DevOps', icon: 'fas fa-warehouse',
    description: 'Self-hosted OCI image registry. Single container + htpasswd auth. Compatible with docker push/pull and the Docker Dash push-to-registry action.',
    compose: `services:\n  registry:\n    image: registry:3\n    container_name: docker-registry\n    restart: unless-stopped\n    ports:\n      - "5000:5000"\n    environment:\n      REGISTRY_AUTH: htpasswd\n      REGISTRY_AUTH_HTPASSWD_REALM: "Docker Dash Registry"\n      REGISTRY_AUTH_HTPASSWD_PATH: /auth/htpasswd\n      REGISTRY_STORAGE_DELETE_ENABLED: "true"\n    volumes:\n      - registry-data:/var/lib/registry\n      - ./auth:/auth:ro\nvolumes:\n  registry-data:`,
  },
  {
    // v8.1.0 — Private Registry + Cache (3 containers). Solves Docker Hub
    // rate-limits + offline operation after first cache. Uses Distribution's
    // proxy mode (one upstream per container, hard constraint of registry:3),
    // with Caddy doing path-prefix routing for the virtual aggregator URL.
    //
    // After deploy:
    //   1. Generate htpasswd:
    //      docker run --rm --entrypoint htpasswd httpd:2 -Bbn youruser yourpass > ./auth/htpasswd
    //   2. Recreate the 3 registry containers to pick up auth.
    //   3. In Docker Dash: Settings → Registries → New, URL = http://<host>:5000
    //   4. Browse → Repositories tab → register 3 repos:
    //        local           type=local
    //        dockerhub       type=remote, upstream=https://registry-1.docker.io
    //        ghcr            type=remote, upstream=https://ghcr.io
    //   5. Pull via the virtual URLs:
    //        docker pull <host>:5000/dockerhub/library/nginx:alpine
    //        docker pull <host>:5000/ghcr/some-org/some-image:tag
    //        docker pull <host>:5000/myteam/myapp:v1     ← falls through to local
    id: 'private-registry-with-cache', name: 'Private Registry + Cache (3 containers)', category: 'DevOps', icon: 'fas fa-warehouse',
    description: 'Self-hosted Distribution registry + caching proxies for Docker Hub and GHCR + Caddy virtual-repo router. Solves Docker Hub rate-limits and offline operation. 4 containers total. After deploy: generate htpasswd then register 3 repos in Docker Dash.',
    compose: `services:\n  registry-local:\n    image: registry:3\n    container_name: docker-registry-local\n    restart: unless-stopped\n    environment:\n      REGISTRY_AUTH: htpasswd\n      REGISTRY_AUTH_HTPASSWD_REALM: "Docker Dash Registry — local"\n      REGISTRY_AUTH_HTPASSWD_PATH: /auth/htpasswd\n      REGISTRY_STORAGE_DELETE_ENABLED: "true"\n    volumes:\n      - registry-local-data:/var/lib/registry\n      - ./auth:/auth:ro\n\n  registry-proxy-dockerhub:\n    image: registry:3\n    container_name: docker-registry-proxy-dockerhub\n    restart: unless-stopped\n    environment:\n      REGISTRY_PROXY_REMOTEURL: https://registry-1.docker.io\n      REGISTRY_AUTH: htpasswd\n      REGISTRY_AUTH_HTPASSWD_REALM: "Docker Dash Registry — Docker Hub proxy"\n      REGISTRY_AUTH_HTPASSWD_PATH: /auth/htpasswd\n    volumes:\n      - registry-proxy-dockerhub-data:/var/lib/registry\n      - ./auth:/auth:ro\n\n  registry-proxy-ghcr:\n    image: registry:3\n    container_name: docker-registry-proxy-ghcr\n    restart: unless-stopped\n    environment:\n      REGISTRY_PROXY_REMOTEURL: https://ghcr.io\n      REGISTRY_AUTH: htpasswd\n      REGISTRY_AUTH_HTPASSWD_REALM: "Docker Dash Registry — GHCR proxy"\n      REGISTRY_AUTH_HTPASSWD_PATH: /auth/htpasswd\n    volumes:\n      - registry-proxy-ghcr-data:/var/lib/registry\n      - ./auth:/auth:ro\n\n  registry-router:\n    image: caddy:2-alpine\n    container_name: docker-registry-router\n    restart: unless-stopped\n    ports:\n      - "5000:5000"\n    volumes:\n      - ./registry-virtual.Caddyfile:/etc/caddy/Caddyfile:ro\n      - registry-router-data:/data\n    depends_on:\n      - registry-local\n      - registry-proxy-dockerhub\n      - registry-proxy-ghcr\n\nvolumes:\n  registry-local-data:\n  registry-proxy-dockerhub-data:\n  registry-proxy-ghcr-data:\n  registry-router-data:`,
    extraFiles: [
      {
        filename: 'registry-virtual.Caddyfile',
        content: `:5000 {\n  handle / {\n    respond "Docker Registry Router (Docker Dash v8.1.0)" 200\n  }\n  handle /v2/dockerhub/* {\n    uri strip_prefix /dockerhub\n    reverse_proxy registry-proxy-dockerhub:5000\n  }\n  handle /v2/ghcr/* {\n    uri strip_prefix /ghcr\n    reverse_proxy registry-proxy-ghcr:5000\n  }\n  handle /v2/* {\n    reverse_proxy registry-local:5000\n  }\n}\n`,
      },
    ],
  },

  // ─── v8.0.1 — AI Workload Pack ─────────────────────────────────────
  // Curated compose snippets for self-hosted AI. All ship with `:latest` tags
  // (operator pins to a specific version when deploying for production).
  // GPU passthrough requires `nvidia-container-toolkit` on the host — see
  // the "GPU passthrough" how-to guide for setup. Templates with GPU support
  // include the `deploy.resources.reservations.devices` block; remove it if
  // running CPU-only.

  {
    id: 'ai-ollama', name: 'Ollama (LLM runtime)', category: 'AI', icon: 'fas fa-brain',
    description: 'Local LLM runtime — runs Llama, Qwen, DeepSeek, Mistral, etc. on your hardware. CPU works; GPU recommended for >7B models. After deploy: `docker exec ollama ollama pull qwen2.5-coder:7b`. Use as the AI provider in Settings → AI for Docker Dash itself.',
    compose: `services:\n  ollama:\n    image: ollama/ollama:latest\n    container_name: ollama\n    restart: unless-stopped\n    ports:\n      - "11434:11434"\n    volumes:\n      - ollama-data:/root/.ollama\n    # Uncomment for GPU support (requires nvidia-container-toolkit on host):\n    # deploy:\n    #   resources:\n    #     reservations:\n    #       devices:\n    #         - driver: nvidia\n    #           count: all\n    #           capabilities: [gpu]\nvolumes:\n  ollama-data:`,
  },
  {
    id: 'ai-ollama-openwebui', name: 'Ollama + Open WebUI', category: 'AI', icon: 'fas fa-comments',
    description: 'Full local ChatGPT-style stack: Ollama backend + Open WebUI frontend. Web UI at :3000, Ollama API at :11434. After deploy: open :3000, create an account, pull a model from the UI. Privacy-first — nothing leaves your network.',
    compose: `services:\n  ollama:\n    image: ollama/ollama:latest\n    container_name: ollama\n    restart: unless-stopped\n    volumes:\n      - ollama-data:/root/.ollama\n    # Uncomment for GPU support (requires nvidia-container-toolkit on host):\n    # deploy:\n    #   resources:\n    #     reservations:\n    #       devices:\n    #         - driver: nvidia\n    #           count: all\n    #           capabilities: [gpu]\n\n  open-webui:\n    image: ghcr.io/open-webui/open-webui:main\n    container_name: open-webui\n    restart: unless-stopped\n    ports:\n      - "3000:8080"\n    environment:\n      OLLAMA_BASE_URL: http://ollama:11434\n      WEBUI_AUTH: "true"\n    volumes:\n      - openwebui-data:/app/backend/data\n    depends_on:\n      - ollama\nvolumes:\n  ollama-data:\n  openwebui-data:`,
  },
  {
    id: 'ai-rag-stack', name: 'RAG Stack (Ollama + Qdrant + Open WebUI)', category: 'AI', icon: 'fas fa-database',
    description: 'Retrieval-augmented generation: Ollama for inference + Qdrant vector DB for embeddings + Open WebUI for chat. Upload docs in Open WebUI, they get embedded into Qdrant, queries cite sources. Self-contained, no cloud.',
    compose: `services:\n  ollama:\n    image: ollama/ollama:latest\n    container_name: ollama-rag\n    restart: unless-stopped\n    volumes:\n      - ollama-rag-data:/root/.ollama\n\n  qdrant:\n    image: qdrant/qdrant:latest\n    container_name: qdrant\n    restart: unless-stopped\n    ports:\n      - "6333:6333"\n    volumes:\n      - qdrant-data:/qdrant/storage\n\n  open-webui:\n    image: ghcr.io/open-webui/open-webui:main\n    container_name: open-webui-rag\n    restart: unless-stopped\n    ports:\n      - "3000:8080"\n    environment:\n      OLLAMA_BASE_URL: http://ollama-rag:11434\n      RAG_EMBEDDING_ENGINE: ollama\n      VECTOR_DB: qdrant\n      QDRANT_URI: http://qdrant:6333\n      WEBUI_AUTH: "true"\n    volumes:\n      - openwebui-rag-data:/app/backend/data\n    depends_on:\n      - ollama\n      - qdrant\nvolumes:\n  ollama-rag-data:\n  qdrant-data:\n  openwebui-rag-data:`,
  },
  {
    id: 'ai-vllm', name: 'vLLM (high-throughput inference)', category: 'AI', icon: 'fas fa-tachometer-alt',
    description: 'Production-grade LLM inference server with PagedAttention. Higher throughput than Ollama for concurrent requests. Requires NVIDIA GPU. Set MODEL env var to a HuggingFace model ID. OpenAI-compatible API at :8000/v1.',
    compose: `services:\n  vllm:\n    image: vllm/vllm-openai:latest\n    container_name: vllm\n    restart: unless-stopped\n    ports:\n      - "8000:8000"\n    environment:\n      MODEL: meta-llama/Llama-3.2-3B-Instruct\n      HUGGING_FACE_HUB_TOKEN: \${HF_TOKEN:-}\n    volumes:\n      - vllm-cache:/root/.cache/huggingface\n    command: --model \${MODEL:-meta-llama/Llama-3.2-3B-Instruct} --host 0.0.0.0\n    deploy:\n      resources:\n        reservations:\n          devices:\n            - driver: nvidia\n              count: all\n              capabilities: [gpu]\n    ipc: host\nvolumes:\n  vllm-cache:`,
  },
  {
    id: 'ai-stable-diffusion', name: 'Stable Diffusion WebUI', category: 'AI', icon: 'fas fa-image',
    description: 'AUTOMATIC1111 Stable Diffusion WebUI — image generation with SD 1.5/2.x/SDXL/Flux. Requires NVIDIA GPU with 6GB+ VRAM. First boot downloads SD 1.5 (~4GB). Web UI at :7860.',
    compose: `services:\n  stable-diffusion:\n    image: ghcr.io/abdbarho/stable-diffusion-webui-docker/auto:latest\n    container_name: stable-diffusion\n    restart: unless-stopped\n    ports:\n      - "7860:7860"\n    volumes:\n      - sd-models:/data/models\n      - sd-output:/output\n      - sd-config:/data/config\n    environment:\n      CLI_ARGS: --listen --no-half-vae --xformers\n    deploy:\n      resources:\n        reservations:\n          devices:\n            - driver: nvidia\n              count: all\n              capabilities: [gpu]\nvolumes:\n  sd-models:\n  sd-output:\n  sd-config:`,
  },
  {
    id: 'ai-comfyui', name: 'ComfyUI (node-based image gen)', category: 'AI', icon: 'fas fa-project-diagram',
    description: 'Node-based image generation workflow editor. Power users prefer ComfyUI over Stable Diffusion WebUI for complex pipelines (img2img, ControlNet, animation, video). Requires NVIDIA GPU. Web UI at :8188.',
    compose: `services:\n  comfyui:\n    image: yanwk/comfyui-boot:latest\n    container_name: comfyui\n    restart: unless-stopped\n    ports:\n      - "8188:8188"\n    volumes:\n      - comfyui-storage:/root\n    deploy:\n      resources:\n        reservations:\n          devices:\n            - driver: nvidia\n              count: all\n              capabilities: [gpu]\nvolumes:\n  comfyui-storage:`,
  },
  {
    id: 'ai-whisper', name: 'Whisper (speech-to-text)', category: 'AI', icon: 'fas fa-microphone',
    description: 'OpenAI Whisper transcription server (faster-whisper backend). REST API at :9000 — POST audio file, get transcript. CPU works; GPU is 5-10× faster. Multilingual.',
    compose: `services:\n  whisper:\n    image: onerahmet/openai-whisper-asr-webservice:latest\n    container_name: whisper\n    restart: unless-stopped\n    ports:\n      - "9000:9000"\n    environment:\n      ASR_MODEL: base\n      ASR_ENGINE: faster_whisper\n    volumes:\n      - whisper-cache:/root/.cache\n    # Uncomment for GPU:\n    # deploy:\n    #   resources:\n    #     reservations:\n    #       devices:\n    #         - driver: nvidia\n    #           count: all\n    #           capabilities: [gpu]\nvolumes:\n  whisper-cache:`,
  },
  {
    id: 'ai-langflow', name: 'Langflow (visual LangChain)', category: 'AI', icon: 'fas fa-sitemap',
    description: 'Visual editor for LangChain workflows. Drag-and-drop nodes for prompt chains, RAG, agents. Connect to Ollama/OpenAI/Anthropic. Web UI at :7860.',
    compose: `services:\n  langflow:\n    image: langflowai/langflow:latest\n    container_name: langflow\n    restart: unless-stopped\n    ports:\n      - "7860:7860"\n    environment:\n      LANGFLOW_AUTO_LOGIN: "false"\n      LANGFLOW_SUPERUSER: admin\n      LANGFLOW_SUPERUSER_PASSWORD: changeme\n    volumes:\n      - langflow-data:/app/langflow\nvolumes:\n  langflow-data:`,
  },
  {
    id: 'ai-anything-llm', name: 'AnythingLLM (full-stack RAG)', category: 'AI', icon: 'fas fa-book',
    description: 'Multi-user RAG application — workspaces, document upload, multi-source ingestion (websites, GitHub, Confluence, etc.), chat with citations. Connects to Ollama/OpenAI/Anthropic. Web UI at :3001.',
    compose: `services:\n  anything-llm:\n    image: mintplexlabs/anythingllm:latest\n    container_name: anything-llm\n    restart: unless-stopped\n    ports:\n      - "3001:3001"\n    environment:\n      STORAGE_DIR: /app/server/storage\n      JWT_SECRET: changeme-generate-strong-secret-min-12-chars\n    volumes:\n      - anythingllm-data:/app/server/storage\n      - anythingllm-hotdir:/app/collector/hotdir\nvolumes:\n  anythingllm-data:\n  anythingllm-hotdir:`,
  },
  {
    id: 'ai-n8n', name: 'n8n (workflow automation with AI)', category: 'AI', icon: 'fas fa-cogs',
    description: 'Workflow automation tool with native AI nodes (OpenAI, Ollama, vector stores, agents). Visual editor — connect APIs without writing code. Self-hosted alternative to Zapier with AI superpowers. Web UI at :5678.',
    compose: `services:\n  n8n:\n    image: n8nio/n8n:latest\n    container_name: n8n\n    restart: unless-stopped\n    ports:\n      - "5678:5678"\n    environment:\n      N8N_BASIC_AUTH_ACTIVE: "true"\n      N8N_BASIC_AUTH_USER: admin\n      N8N_BASIC_AUTH_PASSWORD: changeme\n      N8N_HOST: localhost\n      N8N_PORT: 5678\n      WEBHOOK_URL: http://localhost:5678/\n    volumes:\n      - n8n-data:/home/node/.n8n\nvolumes:\n  n8n-data:`,
  },
  {
    id: 'ai-litellm', name: 'LiteLLM Proxy (unified LLM gateway)', category: 'AI', icon: 'fas fa-route',
    description: 'OpenAI-compatible proxy that unifies 100+ LLM providers (OpenAI, Anthropic, Cohere, Bedrock, local Ollama). Apps point here; you switch backends without touching app code. Cost tracking + rate limiting. API at :4000.',
    compose: `services:\n  litellm:\n    image: ghcr.io/berriai/litellm:main-latest\n    container_name: litellm\n    restart: unless-stopped\n    ports:\n      - "4000:4000"\n    environment:\n      LITELLM_MASTER_KEY: sk-changeme-generate-strong-secret\n    command: --config /app/config.yaml --port 4000\n    volumes:\n      # Mount your config.yaml here. Example:\n      #   model_list:\n      #     - model_name: gpt-4o-mini\n      #       litellm_params:\n      #         model: openai/gpt-4o-mini\n      #         api_key: os.environ/OPENAI_API_KEY\n      - ./litellm-config.yaml:/app/config.yaml:ro`,
  },
  {
    id: 'ai-flowise', name: 'Flowise (drag-drop LLM apps)', category: 'AI', icon: 'fas fa-stream',
    description: 'Drag-and-drop builder for LLM applications: chatbots, agents, RAG. Similar to Langflow but more polished UX. 100+ integrations. Web UI at :3000.',
    compose: `services:\n  flowise:\n    image: flowiseai/flowise:latest\n    container_name: flowise\n    restart: unless-stopped\n    ports:\n      - "3000:3000"\n    environment:\n      FLOWISE_USERNAME: admin\n      FLOWISE_PASSWORD: changeme\n    volumes:\n      - flowise-data:/root/.flowise\n    command: /bin/sh -c "sleep 3; flowise start"\nvolumes:\n  flowise-data:`,
  },
  {
    // v8.6.x — UniFi Network Application (self-hosted Ubiquiti controller).
    //
    // Built on linuxserver.io's image since Ubiquiti discontinued the official
    // Docker controller. Two services: the controller + a dedicated MongoDB
    // 7.0 (highest supported by UniFi <9.0). A Compose `configs:` block ships
    // the mongo user-creation script inline so the stack is self-contained
    // (no host file to mount). Requires Docker Compose 2.23+ for `content:`.
    //
    // After deploy:
    //   1. Open https://<host>:8443 — accept the self-signed cert, run the
    //      setup wizard (create the first admin account).
    //   2. UniFi devices: set Inform URL to http://<host>:8080 (Settings →
    //      System → Advanced) or via SSH `set-inform`.
    //   3. **CHANGE THE MONGO PASSWORD** before first deploy: replace
    //      `changeme` in BOTH MONGO_PASS env vars AND in the init-mongo.js
    //      `pwd:` fields — they must match. The script runs ONCE on first
    //      Mongo start; rotating later means either dropping the unifi-db
    //      volume OR updating the user via mongosh.
    //
    // Notes:
    //   - Mongo image pinned (never `latest`) per LSIO guidance.
    //   - Mongo >4.4 on x86-64 needs a CPU with AVX (most modern hardware).
    //   - Self-signed cert by default; if fronted by a reverse proxy, allow
    //     unverified upstream.
    //   - In-place migration from the legacy `unifi-controller` image is NOT
    //     supported by upstream — backup in the old, restore in the new.
    id: 'unifi-network-application', name: 'UniFi Network Application', category: 'Networking', icon: 'fas fa-wifi',
    description: 'Self-hosted Ubiquiti UniFi controller (LinuxServer.io image) with a dedicated MongoDB 7.0 sidecar. Inline init script auto-creates the unifi DB user on first start, healthcheck gates the controller until Mongo is ready. Web UI at https://<host>:8443.',
    compose: [
      '# UniFi Network Application (LinuxServer.io) + dedicated MongoDB 7.0.',
      '# CHANGE every "changeme" before first deploy. MONGO_PASS and the init-mongo',
      '# pwd fields MUST match — the init script runs ONCE on first Mongo start.',
      '',
      'configs:',
      '  init-mongo.js:',
      '    content: |',
      '      db.getSiblingDB("unifi").createUser({user: "unifi", pwd: "changeme", roles: [{role: "dbOwner", db: "unifi"}]});',
      '      db.getSiblingDB("unifi_stat").createUser({user: "unifi", pwd: "changeme", roles: [{role: "dbOwner", db: "unifi_stat"}]});',
      '',
      'services:',
      '  unifi-db:',
      '    image: mongo:7.0',
      '    container_name: unifi-db',
      '    restart: unless-stopped',
      '    volumes:',
      '      - unifi-db:/data/db',
      '    configs:',
      '      - source: init-mongo.js',
      '        target: /docker-entrypoint-initdb.d/init-mongo.js',
      '    healthcheck:',
      '      test: ["CMD", "mongosh", "--quiet", "--eval", "db.runCommand({ ping: 1 }).ok"]',
      '      interval: 10s',
      '      timeout: 5s',
      '      retries: 6',
      '      start_period: 40s',
      '',
      '  unifi-network-application:',
      '    image: lscr.io/linuxserver/unifi-network-application:latest',
      '    container_name: unifi-network-application',
      '    restart: unless-stopped',
      '    depends_on:',
      '      unifi-db:',
      '        condition: service_healthy',
      '    environment:',
      '      - PUID=1000',
      '      - PGID=1000',
      '      - TZ=Etc/UTC',
      '      - MONGO_HOST=unifi-db',
      '      - MONGO_PORT=27017',
      '      - MONGO_USER=unifi',
      '      - MONGO_PASS=changeme',
      '      - MONGO_DBNAME=unifi',
      '      - MEM_LIMIT=1024',
      '      - MEM_STARTUP=1024',
      '    volumes:',
      '      - unifi-config:/config',
      '    ports:',
      '      - "8443:8443"          # Web admin UI — required',
      '      - "8080:8080"          # Device communication — required',
      '      - "3478:3478/udp"      # STUN — required for AP discovery',
      '      - "10001:10001/udp"    # AP discovery — required',
      '      - "1900:1900/udp"      # L2 discovery — optional',
      '      - "8843:8843"          # Guest portal HTTPS — optional',
      '      - "8880:8880"          # Guest portal HTTP — optional',
      '      - "6789:6789"          # Mobile throughput test — optional',
      '      - "5514:5514/udp"      # Remote syslog — optional',
      '',
      'volumes:',
      '  unifi-db:',
      '  unifi-config:',
    ].join('\n'),
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
router.post('/', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
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
}));

// Update template (custom or override built-in)
router.put('/:id', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
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
}));

// Reset built-in template to original
router.post('/:id/reset', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
  const isBuiltin = !!TEMPLATES.find(t => t.id === req.params.id);
  if (!isBuiltin) return res.status(400).json({ error: 'Only built-in templates can be reset' });

  const db = getDb();
  db.prepare('DELETE FROM custom_templates WHERE id = ? AND is_builtin_override = 1').run(req.params.id);

  auditService.log({ userId: req.user.id, username: req.user.username,
    action: 'template_reset', targetType: 'template', targetId: req.params.id, ip: getClientIp(req) });

  res.json({ ok: true });
}));

// Delete custom template (cannot delete built-in)
router.delete('/:id', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
  const isBuiltin = !!TEMPLATES.find(t => t.id === req.params.id);
  if (isBuiltin) return res.status(400).json({ error: 'Cannot delete built-in templates. Use PUT to override or POST /reset to restore.' });

  const db = getDb();
  const result = db.prepare('DELETE FROM custom_templates WHERE id = ? AND is_builtin_override = 0').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Custom template not found' });

  auditService.log({ userId: req.user.id, username: req.user.username,
    action: 'template_delete', targetType: 'template', targetId: req.params.id, ip: getClientIp(req) });

  res.json({ ok: true });
}));

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
router.post('/:id/deploy', requireAuth, requireRole('admin', 'operator'), writeable, requireFeature('create'), asyncHandler(async (req, res) => {
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
}));

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
router.post('/import/preview', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
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
}));

// Import selected Portainer templates (save to DB)
router.post('/import', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
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
}));

module.exports = router;
// Test surface: expose pure helpers + the verification map so the
// post-v8.2.0 template-verification gap-closure test suite can read them
// without standing up the full express stack.
module.exports.getMergedTemplates = getMergedTemplates;
module.exports.BUILTIN_VERIFICATION = BUILTIN_VERIFICATION;
