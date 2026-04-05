'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS howto_guides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      title_ro TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      difficulty TEXT DEFAULT 'beginner',
      icon TEXT DEFAULT 'fas fa-book',
      summary TEXT DEFAULT '',
      summary_ro TEXT DEFAULT '',
      content TEXT DEFAULT '',
      content_ro TEXT DEFAULT '',
      is_builtin INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Seed 25 built-in guides
  const guides = [
    { slug: 'install-docker', title: 'How to Install Docker', title_ro: 'Cum instalezi Docker', category: 'basics', difficulty: 'beginner', icon: 'fab fa-docker', summary: 'Install Docker Engine on Ubuntu, Debian, CentOS, or Alpine with step-by-step commands.', summary_ro: 'Instalează Docker Engine pe Ubuntu, Debian, CentOS sau Alpine cu comenzi pas cu pas.' },
    { slug: 'images-vs-containers', title: 'Docker Images vs Containers', title_ro: 'Imagini Docker vs Containere', category: 'basics', difficulty: 'beginner', icon: 'fas fa-th-large', summary: 'Understand the difference between images and containers — the most fundamental Docker concept.', summary_ro: 'Înțelege diferența dintre imagini și containere — cel mai fundamental concept Docker.' },
    { slug: 'docker-volumes', title: 'Docker Volumes Explained', title_ro: 'Volume Docker explicate', category: 'basics', difficulty: 'beginner', icon: 'fas fa-hdd', summary: 'Learn how Docker volumes persist data across container restarts and how to use them.', summary_ro: 'Învață cum volumele Docker persistă datele și cum să le utilizezi.' },
    { slug: 'linux-commands', title: 'Essential Linux Commands', title_ro: 'Comenzi Linux esențiale', category: 'linux', difficulty: 'beginner', icon: 'fas fa-terminal', summary: '20 essential Linux commands every Docker user should know: files, processes, networking.', summary_ro: '20 comenzi Linux esențiale pe care orice utilizator Docker trebuie să le cunoască.' },
    { slug: 'ssh-key-auth', title: 'SSH Key Authentication', title_ro: 'Autentificare SSH cu cheie', category: 'linux', difficulty: 'intermediate', icon: 'fas fa-key', summary: 'Set up passwordless SSH access to remote servers using key pairs.', summary_ro: 'Configurează acces SSH fără parolă folosind perechi de chei.' },
    { slug: 'expose-ports', title: 'Expose Ports Safely', title_ro: 'Expunerea porturilor în siguranță', category: 'networking', difficulty: 'beginner', icon: 'fas fa-plug', summary: 'How Docker port mapping works and common security pitfalls with -p flag.', summary_ro: 'Cum funcționează maparea porturilor Docker și capcanele de securitate cu -p.' },
    { slug: 'reverse-proxy', title: 'Set Up a Reverse Proxy', title_ro: 'Configurare Reverse Proxy', category: 'networking', difficulty: 'intermediate', icon: 'fas fa-shield-alt', summary: 'Configure Nginx, Caddy, or Traefik as reverse proxy for your Docker services.', summary_ro: 'Configurează Nginx, Caddy sau Traefik ca reverse proxy pentru serviciile Docker.' },
    { slug: 'docker-networks', title: 'Docker Networks Guide', title_ro: 'Ghid rețele Docker', category: 'networking', difficulty: 'intermediate', icon: 'fas fa-network-wired', summary: 'Bridge, host, overlay networks — when to use each and how to create custom networks.', summary_ro: 'Rețele bridge, host, overlay — când le folosești și cum creezi rețele custom.' },
    { slug: 'dns-domain-setup', title: 'DNS & Domain Setup', title_ro: 'Configurare DNS și domeniu', category: 'networking', difficulty: 'intermediate', icon: 'fas fa-globe', summary: 'Point a domain to your server and configure DNS records for Docker services.', summary_ro: 'Direcționează un domeniu către server și configurează înregistrări DNS.' },
    { slug: 'tls-certificates', title: 'TLS/SSL Certificates', title_ro: 'Certificate TLS/SSL', category: 'security', difficulty: 'intermediate', icon: 'fas fa-lock', summary: "Get free TLS certificates with Let's Encrypt and configure HTTPS for your services.", summary_ro: "Obține certificate TLS gratuite cu Let's Encrypt și configurează HTTPS." },
    { slug: 'harden-docker', title: 'Harden Your Docker Host', title_ro: 'Securizarea hostului Docker', category: 'security', difficulty: 'advanced', icon: 'fas fa-shield-alt', summary: 'Security best practices: non-root, read-only rootfs, capabilities, seccomp profiles.', summary_ro: 'Best practices securitate: non-root, rootfs read-only, capabilities, profile seccomp.' },
    { slug: 'rootless-docker', title: 'Rootless Docker Setup', title_ro: 'Docker fără root', category: 'security', difficulty: 'advanced', icon: 'fas fa-user-shield', summary: 'Run Docker daemon without root privileges for enhanced security.', summary_ro: 'Rulează Docker daemon fără privilegii root pentru securitate sporită.' },
    { slug: 'compose-first-stack', title: 'Your First Docker Compose Stack', title_ro: 'Primul tău stack Docker Compose', category: 'compose', difficulty: 'beginner', icon: 'fas fa-layer-group', summary: 'Write your first docker-compose.yml file with a web server and database.', summary_ro: 'Scrie primul tău fișier docker-compose.yml cu un server web și o bază de date.' },
    { slug: 'compose-env-vars', title: 'Environment Variables in Compose', title_ro: 'Variabile de mediu în Compose', category: 'compose', difficulty: 'beginner', icon: 'fas fa-key', summary: 'Use .env files and environment variables to configure your Docker Compose stacks.', summary_ro: 'Folosește fișiere .env și variabile de mediu pentru a configura stackurile Compose.' },
    { slug: 'compose-healthchecks', title: 'Health Checks in Compose', title_ro: 'Verificări de sănătate în Compose', category: 'compose', difficulty: 'intermediate', icon: 'fas fa-heartbeat', summary: 'Add health checks to your services so Docker knows when they are ready.', summary_ro: 'Adaugă verificări de sănătate serviciilor ca Docker să știe când sunt pregătite.' },
    { slug: 'update-containers', title: 'Updating Containers Safely', title_ro: 'Actualizare containere în siguranță', category: 'compose', difficulty: 'intermediate', icon: 'fas fa-sync-alt', summary: 'Pull new images and recreate containers without downtime using Compose.', summary_ro: 'Descarcă imagini noi și recreează containere fără downtime folosind Compose.' },
    { slug: 'container-wont-start', title: "Container Won't Start", title_ro: 'Containerul nu pornește', category: 'troubleshooting', difficulty: 'beginner', icon: 'fas fa-exclamation-triangle', summary: 'Debug the most common reasons a container fails to start: exit codes, logs, permissions.', summary_ro: 'Depanează cele mai comune cauze pentru care un container nu pornește.' },
    { slug: 'reading-logs', title: 'Reading Docker Logs', title_ro: 'Citirea logurilor Docker', category: 'troubleshooting', difficulty: 'beginner', icon: 'fas fa-file-alt', summary: 'How to read container logs, filter by time, follow in real-time, and export.', summary_ro: 'Cum citești loguri de container, filtrezi pe timp, urmărești în timp real și exporti.' },
    { slug: 'getting-started-dd', title: 'Getting Started with Docker Dash', title_ro: 'Primii pași cu Docker Dash', category: 'docker-dash', difficulty: 'beginner', icon: 'fas fa-rocket', summary: 'A tour of Docker Dash features: dashboard, containers, security scanning, and more.', summary_ro: 'Un tur al funcționalităților Docker Dash: dashboard, containere, scanare securitate.' },
    { slug: 'multi-host-setup', title: 'Multi-Host Setup Guide', title_ro: 'Ghid configurare Multi-Host', category: 'docker-dash', difficulty: 'intermediate', icon: 'fas fa-server', summary: 'Connect multiple Docker hosts to Docker Dash via TCP, SSH, or Docker Desktop.', summary_ro: 'Conectează mai multe hosturi Docker la Docker Dash via TCP, SSH sau Docker Desktop.' },
    { slug: 'alerts-notifications', title: 'Setting Up Alerts', title_ro: 'Configurare alerte', category: 'docker-dash', difficulty: 'beginner', icon: 'fas fa-bell', summary: 'Configure CPU/memory alerts with Discord, Slack, Telegram, or email notifications.', summary_ro: 'Configurează alerte CPU/memorie cu notificări Discord, Slack, Telegram sau email.' },
    { slug: 'backup-volumes', title: 'Backup Docker Volumes', title_ro: 'Backup volume Docker', category: 'backup', difficulty: 'intermediate', icon: 'fas fa-database', summary: 'Back up named volumes using temporary containers and tar archives.', summary_ro: 'Fă backup volumelor numite folosind containere temporare și arhive tar.' },
    { slug: 'backup-restore-db', title: 'Database Backup & Restore', title_ro: 'Backup și restaurare baze de date', category: 'backup', difficulty: 'intermediate', icon: 'fas fa-undo', summary: 'Backup and restore PostgreSQL, MySQL, and MongoDB databases running in Docker.', summary_ro: 'Backup și restaurare baze de date PostgreSQL, MySQL și MongoDB din Docker.' },
    { slug: 'docker-prune', title: 'Clean Up Docker Resources', title_ro: 'Curățare resurse Docker', category: 'performance', difficulty: 'beginner', icon: 'fas fa-broom', summary: 'Reclaim disk space by pruning unused containers, images, volumes, and networks.', summary_ro: 'Eliberează spațiu pe disc eliminând containere, imagini, volume și rețele neutilizate.' },
    { slug: 'resource-limits', title: 'Container Resource Limits', title_ro: 'Limite de resurse pentru containere', category: 'performance', difficulty: 'intermediate', icon: 'fas fa-tachometer-alt', summary: 'Set CPU and memory limits to prevent containers from consuming all host resources.', summary_ro: 'Setează limite CPU și memorie pentru a preveni consumul excesiv de resurse.' },
  ];

  const insert = db.prepare(`INSERT OR IGNORE INTO howto_guides (slug, title, title_ro, category, difficulty, icon, summary, summary_ro, is_builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  for (const g of guides) {
    insert.run(g.slug, g.title, g.title_ro, g.category, g.difficulty, g.icon, g.summary, g.summary_ro);
  }
};
