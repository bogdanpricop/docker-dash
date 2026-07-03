---
slug: incus-integration
title: Incus Integration (alpha)
title_ro: Integrare Incus (alpha)
category: docker-dash
difficulty: advanced
icon: fas fa-cubes
summary: Add an Incus (LXC + KVM) daemon as a host in Docker Dash. Alpha — read carefully before deploying.
summary_ro: Adaugă un daemon Incus (LXC + KVM) ca host în Docker Dash. Alpha — citește atent înainte de deploy.
---

## Ce este Incus

[Incus](https://github.com/lxc/incus) e un "manager de containere de sistem și mașini virtuale". E fork-ul comunitar al LXD (creat după ce Canonical a re-licențiat LXD cu un CLA restrictiv). Administrează **containere LXC de sistem** (containere care rulează systemd și sshd, arată ca mini-VMs) și **mașini virtuale KVM** prin același API REST.

Publicul e diferit de Docker: mulți self-hosteri preferă Incus pentru servicii ca Nextcloud, PostgreSQL, mail server, pentru că un container de sistem se comportă mai "server-like" decât un container Docker.

## Status alpha

Integrarea Incus în Docker Dash e în **alpha** (v8.9.0-alpha.x). Ce livrează:

- IncusClient (wrapper subțire HTTP peste `http`/`https`)
- Rute backend: read (list instances, snapshots, images, projects) + write (start, stop, restart, freeze, unfreeze, delete instanță; create/restore/delete snapshot)
- Pagina frontend: lista de instanțe cu status, IP-uri, memorie, CPU + acțiuni Start/Stop/Restart/Delete
- Migrația `daemon_type` pe tabelul `docker_hosts` (coloanele `daemon_type` + `daemon_config`)

Ce NU livrează încă:

- Consolă prin WebSocket (streaming `exec` LXC, noVNC/SPICE pentru VMs)
- Formular de creare instanță (folosește `incus launch` din CLI)
- UI pentru snapshot management (rutele backend există; UI în v8.9.0 proper)
- Management pentru profiles / networks / storage pools
- Rutare cluster-aware (cluster-uri Incus expun un API dar routing per-nod)

Nu folosi în producție încă. Testează în dev, raportează probleme.

## Prerequisite

- Incus 6.x instalat pe host (Debian 12 / Ubuntu 24.04 / Fedora / Arch — vezi [pachete distribuite](https://linuxcontainers.org/incus/getting-started/))
- Incus inițializat (`incus admin init`) și pornit
- Acces la modificare `docker-compose.yml` pe hostul docker-dash

## Setup (rootful, același host)

Cazul cel mai simplu: docker-dash și Incus rulează pe același host fizic. docker-dash trebuie să vadă socket-ul Unix al Incus.

### 1. Bind-mount socket-ul Incus

Editează `docker-compose.yml` și adaugă socket-ul Incus la volumele docker-dash:

```yaml
services:
  app:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - docker-dash-data:/data
      # v8.9.0-alpha: bind-mount socket-ul Incus ca să poată vorbi cu el
      - /var/lib/incus/unix.socket:/var/lib/incus/unix.socket
```

Socket-ul e deținut de `root:incus-admin` pe majoritatea distribuțiilor. Dacă docker-dash rulează ca non-root:

- Adaugă UID-ul docker-dash la grupul `incus-admin`, sau
- Bind-mount cu flag-uri permissive (nerecomandat), sau
- Rulează docker-dash ca root (default în compose-ul livrat)

Restart:

```bash
docker compose up -d app
```

### 2. Înregistrează hostul în Docker Dash

Nu există UI pentru adăugat host-uri non-Docker încă (limitare alpha). Înregistrează rândul manual. Log în containerul docker-dash:

```bash
docker exec -it docker-dash sh
```

Apoi rulează SQL-ul pe SQLite DB:

```bash
sqlite3 /data/docker-dash.db <<'SQL'
INSERT INTO docker_hosts (name, connection_type, daemon_type, daemon_config, is_default, is_active)
VALUES (
  'Local Incus',
  'socket',
  'incus',
  '{"transport":"unix","socket":"/var/lib/incus/unix.socket"}',
  0,  -- not default
  1   -- active
);
SQL
```

### 3. Verifică

Din interiorul containerului, lovește endpoint-ul de health:

```bash
docker exec docker-dash node -e '
const { getDb } = require("/app/src/db");
const { fromHostRow } = require("/app/src/services/incus");
const row = getDb().prepare("SELECT * FROM docker_hosts WHERE daemon_type = ?").get("incus");
if (!row) { console.error("no incus row"); process.exit(1); }
fromHostRow(row).info().then(i => console.log(JSON.stringify(i.metadata, null, 2)));
'
```

Ar trebui să vezi info-ul serverului Incus (versiune, kernel, extensii API).

### 4. Folosește UI-ul

- Deschide Docker Dash
- Folosește host selector-ul (sus în sidebar) să treci la "Local Incus"
- Click pe **Incus (alpha)** în sidebar
- Instanțele apar cu status, IP-uri, memorie, CPU; acțiunile pe rânduri funcționează

## Setup (Incus remote prin HTTPS)

Dacă Incus e pe altă mașină și expune REST API pe portul 8443, folosește HTTPS + client cert auth.

### 1. Activează API-ul remote

Pe hostul Incus:

```bash
incus config set core.https_address :8443
```

### 2. Creează un trust token în Incus

```bash
incus config trust add-certificate --projects default -- name=docker-dash
```

Urmează prompt-urile ca să obții un trust token. Apoi, pe hostul docker-dash, generează cert client:

```bash
openssl req -x509 -newkey rsa:4096 -keyout /tmp/incus.key -out /tmp/incus.crt -sha384 -days 3650 -nodes \
  -subj "/CN=docker-dash"
```

### 3. Înregistrează hostul

JSON-ul `daemon_config` are nevoie de endpoint + PEM cert + key inline:

```json
{
  "transport": "https",
  "endpoint": "https://incus.example.com:8443",
  "cert": "-----BEGIN CERTIFICATE-----\nMIIF...\n-----END CERTIFICATE-----\n",
  "key": "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
  "skipTlsVerify": false
}
```

Inserează în DB la fel ca la cazul local. **Notă**: cheia e stocată necriptată în alpha; criptarea-at-rest pentru credențialele Incus ajunge într-un release următor.

## Ce funcționează și ce nu

| Funcționalitate | Status |
|---|---|
| Listă instanțe (containere + VMs) | Funcționează |
| Detaliu instanță | Funcționează |
| Start / Stop / Restart | Funcționează |
| Freeze / Unfreeze | API funcționează; fără buton UI în alpha |
| Delete instanță | Funcționează |
| Listă snapshot | Funcționează (API) |
| Create / Restore / Delete snapshot | Funcționează (API); fără UI în alpha |
| Consolă (LXC exec) | Neimplementată |
| Consolă (VM noVNC/SPICE) | Neimplementată |
| Formular create instanță | Neimplementat (folosește `incus launch`) |
| CRUD Profiles | Neimplementat |
| Storage pools | Neimplementat |
| Networks | Neimplementat |
| Cluster routing | Neimplementat (merge pe un singur nod) |
| Criptare credențiale at rest | Neimplementat (amânat) |

## Depanare

**"Host X is not an Incus daemon" din API**

E selectat host greșit. Folosește host selector-ul să treci la rândul Incus.

**"ECONNREFUSED /var/lib/incus/unix.socket"**

Bind-mount-ul lipsește din `docker-compose.yml`, calea e greșită, sau Incus nu rulează. Verifică:

```bash
sudo ls -l /var/lib/incus/unix.socket
sudo curl --unix-socket /var/lib/incus/unix.socket http://localhost/1.0
```

Unele versiuni Incus folosesc `/run/incus/incus.socket` în loc. Ajustează bind-mount-ul.

**"Permission denied" pe socket**

UID-ul docker-dash trebuie să fie în grupul `incus-admin`, SAU docker-dash trebuie să ruleze ca root (default), SAU socket-ul are nevoie de write pe grup.

**Operațiile fac timeout**

Operațiile pe VMs pot dura 30-60 s legitim. Client-ul așteaptă până la 5 min. Dacă vezi timeout-uri mai scurte, verifică latența spre API-ul Incus.

**Cluster arată doar instanțele unui nod**

Alpha nu face cluster-aware routing. Înregistrează fiecare membru al cluster-ului ca rând separat cu `daemon_config.endpoint` diferit.

## Referințe

- [Documentația Incus](https://linuxcontainers.org/incus/docs/main/)
- [Referința REST API Incus](https://linuxcontainers.org/incus/docs/main/api/)
- [Deep-spec Docker Dash Incus](../../plans/deep-spec-sprint-3-incus.md) (roadmap intern proiect)
