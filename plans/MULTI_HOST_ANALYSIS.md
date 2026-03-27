# Multi-Host Docker Management — Analiza Tehnica

## 1. Context

Docker Dash gestioneaza in prezent un singur Docker Engine (prin socket local `/var/run/docker.sock`).
Scopul acestei analize este sa evalueze ce ar insemna sa conectam **mai multe servere Docker** si **Docker Desktop** la aceeasi instanta Docker Dash.

---

## 2. Ce exista deja in cod (fundatia)

Surprinzator, codebase-ul are deja o fundatie partiala (~30% implementata):

| Component | Status | Detalii |
|-----------|--------|---------|
| `docker_hosts` table | ✅ Exista | Migrarea `006_multihost.js` creaza tabela cu `name, connection_type (socket/tcp/ssh), host, port, tls_config, ssh_config` |
| `DockerService.getDocker(hostId)` | ✅ Exista | Toate metodele accepta `hostId = 0` ca parametru |
| Stats tables cu `host_id` | ✅ Exista | `container_stats`, `container_stats_1m`, `container_stats_1h`, `health_events` — toate au coloana `host_id` |
| `docker_events.host_id` | ✅ Exista | Foreign key catre `docker_hosts` |
| Feature flag `ENABLE_MULTI_HOST` | ✅ Exista | In `config/index.js`, dar nu e folosit nicaieri |
| Route-uri cu hostId | ❌ Lipsa | Niciun route nu extrage/trimite hostId |
| Conexiuni multiple Dockerode | ❌ Lipsa | `getDocker()` returneaza mereu acelasi socket local |
| Stats collection multi-host | ❌ Lipsa | Un singur collector, ruleaza doar pe host 0 |
| Event streams multi-host | ❌ Lipsa | Un singur event stream |
| Frontend host selector | ❌ Lipsa | Zero UI pentru selectia host-ului |

---

## 3. Tipuri de conexiune Docker

### 3.1 Docker Socket (Unix/Named Pipe)
- **Cum**: `/var/run/docker.sock` (Linux/Mac) sau `//./pipe/docker_engine` (Windows)
- **Cand**: Docker Engine ruleaza local sau socket-ul e montat in container
- **Dockerode**: `new Docker({ socketPath: '/var/run/docker.sock' })`
- **Securitate**: Acces root implicit, nu necesita autentificare
- **Latenta**: ~0ms (IPC)

### 3.2 Docker TCP (cu TLS)
- **Cum**: `tcp://192.168.1.100:2376` (cu TLS) sau `:2375` (fara TLS)
- **Cand**: Docker Engine configurat cu `-H tcp://0.0.0.0:2376 --tlsverify`
- **Dockerode**: `new Docker({ host: '192.168.1.100', port: 2376, ca, cert, key })`
- **Securitate**: TLS mutual authentication (ca + cert + key). **Fara TLS = acces neautorizat total**
- **Latenta**: ~1-50ms (retea locala), ~50-200ms (WAN)
- **Setup pe server**:
  ```bash
  # Generare certificate
  openssl genrsa -aes256 -out ca-key.pem 4096
  openssl req -new -x509 -days 365 -key ca-key.pem -out ca.pem
  # + server cert + client cert (procedura completa ~20 comenzi)

  # Docker daemon config (/etc/docker/daemon.json)
  {
    "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"],
    "tls": true,
    "tlscacert": "/etc/docker/certs/ca.pem",
    "tlscert": "/etc/docker/certs/server-cert.pem",
    "tlskey": "/etc/docker/certs/server-key.pem",
    "tlsverify": true
  }
  ```

### 3.3 Docker via SSH
- **Cum**: `ssh://user@192.168.1.100`
- **Cand**: Nu vrei sa expui TCP, ai deja acces SSH
- **Dockerode**: Nu suporta SSH nativ. Optiuni:
  - SSH tunnel local: `ssh -L 2375:/var/run/docker.sock user@host` → apoi `tcp://localhost:2375`
  - Biblioteca `ssh2` pentru tunnel programatic
  - `DOCKER_HOST=ssh://user@host docker ps` (doar CLI)
- **Securitate**: Autentificare SSH (password sau key-based)
- **Latenta**: ~50-300ms (overhead SSH handshake + encryption)
- **Complexitate**: **MARE** — necesita management de tuneluri SSH, reconnect, key management

### 3.4 Docker Desktop API
- **Cum**: Docker Desktop expune acelasi Docker Engine API
- **Windows**: Named pipe `//./pipe/docker_engine` sau TCP `localhost:2375` (daca activat in Settings)
- **Mac**: Socket `/var/run/docker.sock` (symlink) sau `~/.docker/run/docker.sock`
- **Diferente fata de Docker Engine pur**:
  - Docker Desktop are propriul VM (WSL2 pe Windows, LinuxKit pe Mac)
  - API-ul e identic cu Docker Engine (aceeasi specificatie)
  - Poate fi expus pe TCP prin Settings → General → "Expose daemon on tcp://localhost:2375 without TLS"
  - **Extensii Docker Desktop**: Docker Dash ar putea fi si extensie DD, dar asta e un proiect separat
- **Conectare remote la Docker Desktop**: Posibila doar daca:
  - Userul activeaza TCP in Docker Desktop Settings
  - Se configureaza TLS (altfel e nesecurizat)
  - Se face port forwarding daca e pe alta masina

---

## 4. Arhitectura propusa

### 4.1 Model: Hub & Spoke

```
                    ┌─────────────────────┐
                    │   Docker Dash Hub    │
                    │   (Node.js + SQLite) │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────┴───────┐ ┌─────┴──────┐ ┌───────┴────────┐
     │ Host 0 (local) │ │ Host 1     │ │ Host 2         │
     │ Socket          │ │ TCP+TLS    │ │ SSH Tunnel     │
     │ /var/run/...    │ │ :2376      │ │ ssh://user@... │
     └────────────────┘ └────────────┘ └────────────────┘
```

Docker Dash ramane **o singura instanta centrala** care se conecteaza la N hosturi Docker.
Nu instalam nimic pe hosturile remote — doar configuram accesul Docker API.

### 4.2 Alternativa: Agent Model (ca Portainer)

```
     ┌────────────────┐          ┌────────────────┐
     │ Docker Dash    │◄────────►│ DD Agent       │
     │ Central Server │          │ (pe Host 1)    │
     └────────────────┘          └────────────────┘
                                         │
                                 ┌───────┴───────┐
                                 │ Docker Engine  │
                                 └───────────────┘
```

- Un mic container "agent" pe fiecare host remote
- Agentul expune un API securizat (API key + TLS)
- Avantaje: nu trebuie sa expui Docker API direct, agentul poate face health checks local
- Dezavantaje: complexitate mai mare, trebuie mentinut agentul

**Recomandare**: Implementam **Hub & Spoke** (fara agent) in prima faza, cu optiunea de agent in viitor.

---

## 5. Ce trebuie modificat — Impact pe componente

### 5.1 Backend — Docker Service (`src/services/docker.js`)

**Efort: MARE** | ~300 linii noi

```javascript
// Acum:
getDocker(hostId = 0) {
  if (!this._connections.has(hostId)) {
    this._connections.set(hostId, new Docker({ socketPath: config.docker.socketPath }));
  }
  return this._connections.get(hostId);
}

// Trebuie sa devina:
getDocker(hostId = 0) {
  if (!this._connections.has(hostId)) {
    const host = this._getHostConfig(hostId); // din DB
    const opts = this._buildDockerodeOptions(host);
    this._connections.set(hostId, new Docker(opts));
  }
  return this._connections.get(hostId);
}

_buildDockerodeOptions(host) {
  switch (host.connection_type) {
    case 'socket': return { socketPath: host.socket_path };
    case 'tcp': return {
      host: host.host, port: host.port,
      ca: host.tls_config?.ca,
      cert: host.tls_config?.cert,
      key: host.tls_config?.key,
    };
    case 'ssh': return { /* SSH tunnel management */ };
  }
}
```

Necesar:
- Connection pooling cu health check periodic
- Reconnect automat la pierderea conexiunii
- Timeout-uri per host (remote = mai lent)
- Cache invalidation cand host config se schimba
- SSH tunnel manager (start/stop/reconnect) — cel mai complex

### 5.2 Route-uri (`src/routes/*.js`)

**Efort: MEDIU** | ~50 modificari punctuale

Fiecare route trebuie sa extraga hostId:

```javascript
// Middleware:
function extractHostId(req, res, next) {
  req.hostId = parseInt(req.query.hostId || req.headers['x-docker-host'] || 0);
  // Validare: hostul exista si e activ
  next();
}

// In fiecare route:
router.get('/', async (req, res) => {
  const containers = await dockerService.listContainers(req.hostId);
  // ...
});
```

Toate cele ~52 endpoint-uri din 6 fisiere de route trebuie actualizate.

### 5.3 Stats Collection (`src/services/stats.js`)

**Efort: MEDIU** | ~80 linii noi

```javascript
// Acum: un singur collector
start() {
  this._interval = setInterval(() => this.collect(0), 10000);
}

// Trebuie:
start() {
  this._intervals = new Map();
  this._startCollectorForHost(0); // local
  // + porneste collectori pentru fiecare host activ din DB
}

async _refreshHosts() {
  const hosts = db.prepare('SELECT id FROM docker_hosts WHERE is_active = 1').all();
  // start/stop collectors dupa necesitate
}
```

### 5.4 Event Streams (`src/ws/index.js`)

**Efort: MEDIU** | ~60 linii noi

```javascript
// Acum: un singur event stream
_startEventStream() {
  const stream = dockerService.getEventStream();
  stream.on('data', (event) => this.broadcast('docker:event', event));
}

// Trebuie: stream per host
_startEventStreams() {
  const hosts = getActiveHosts();
  hosts.forEach(h => {
    const stream = dockerService.getEventStream(h.id);
    stream.on('data', (event) => {
      event.hostId = h.id;
      event.hostName = h.name;
      this.broadcast('docker:event', event);
    });
  });
}
```

### 5.5 Frontend — API Client (`public/js/api.js`)

**Efort: MIC** | ~20 linii noi

```javascript
// Global state
let _currentHostId = 0;

// Interceptor pe toate request-urile
async _fetch(url, options) {
  const separator = url.includes('?') ? '&' : '?';
  url += `${separator}hostId=${_currentHostId}`;
  return fetch(url, options);
}
```

### 5.6 Frontend — UI Components

**Efort: MARE** | ~400 linii noi

#### Host Selector (header/sidebar)
```
┌──────────────────────────────────┐
│ 🟢 Production Server  ▼         │
│   🟢 Production Server          │
│   🟢 Dev Server                 │
│   🟡 Docker Desktop (local)     │
│   🔴 Staging (offline)          │
│   ─────────────────────────     │
│   + Add Docker Host             │
│   ⚙ Manage Hosts               │
└──────────────────────────────────┘
```

#### Host Management Page
- Lista hosturi cu status (online/offline/error)
- Add host form (connection type selector, credentials, test connection)
- Edit/Remove host
- Connection health & latency display

#### Dashboard updates
- Stats per host sau agregate
- Host status overview cards

#### Toate paginile existente
- Container/Image/Volume/Network lists — afiseaza hostul curent
- Optional: view "All Hosts" cu coloana host name

---

## 6. Docker Desktop — Specificatii

### Ce e Docker Desktop?
Docker Desktop este o aplicatie GUI (Windows/Mac/Linux) care include:
- Docker Engine (ruleaza intr-un VM — WSL2 sau LinuxKit)
- Docker CLI
- Docker Compose
- Kubernetes (optional)
- Extension marketplace

### Cum ne conectam de la Docker Dash?

| Scenariu | Metoda | Complexitate |
|----------|--------|-------------|
| DD pe aceeasi masina cu Docker Dash | Socket/Named Pipe | Simpla |
| DD pe alta masina, retea locala | TCP (activat in DD Settings) | Medie |
| DD pe alta masina, remote | TCP + TLS sau SSH tunnel | Complexa |

#### Setup Docker Desktop pentru acces remote:
1. Docker Desktop → Settings → General → ✅ "Expose daemon on tcp://localhost:2375 without TLS"
2. (Recomandat) Configureaza TLS in loc de acces deschis
3. Daca e pe alta masina, necesita port forwarding sau VPN

#### Limitari Docker Desktop vs Docker Engine:
- **Docker Desktop necesita licenta comerciala** pentru companii >250 angajati sau >$10M revenue
- API-ul este identic (aceeasi Docker Engine API specification)
- Performanta poate fi mai slaba (overhead VM pe Windows/Mac)
- Volumele au performanta redusa pe Mac (virtiofs) si Windows (WSL2 mount)
- Nu toate feature-urile Docker Engine sunt expuse (ex: cgroup limits limitati de VM)

### Docker Desktop Extensions — alternativa?
Docker Dash ar putea fi distribuita si ca **Docker Desktop Extension**, dar:
- E un proiect separat (SDK diferit, UI intr-un iframe)
- Limitat la masina locala
- Nu inlocuieste multi-host management
- Util doar ca "quick view" pentru DD users

---

## 7. Estimare efort & prioritizare

### Faza 1: TCP + TLS (cea mai utila)
| Task | Efort estimat | Prioritate |
|------|---------------|-----------|
| Host CRUD API + pagina management | 1-2 zile | P0 |
| DockerService multi-connection (TCP+TLS) | 1-2 zile | P0 |
| Route middleware hostId extraction | 0.5 zile | P0 |
| Host selector in UI header | 0.5 zile | P0 |
| Stats collector multi-host | 1 zi | P1 |
| Event stream multi-host | 0.5 zile | P1 |
| Frontend pages update (host context) | 1 zi | P1 |
| **Total Faza 1** | **~6-8 zile** | |

### Faza 2: SSH Tunnels
| Task | Efort estimat | Prioritate |
|------|---------------|-----------|
| SSH tunnel manager (ssh2 library) | 2 zile | P2 |
| SSH key management UI | 1 zi | P2 |
| Tunnel health monitoring & reconnect | 1 zi | P2 |
| **Total Faza 2** | **~4 zile** | |

### Faza 3: Advanced
| Task | Efort estimat | Prioritate |
|------|---------------|-----------|
| "All Hosts" aggregated view | 2 zile | P3 |
| Cross-host operations (migrate container) | 3 zile | P3 |
| Docker Dash Agent (optional) | 5 zile | P3 |
| Docker Desktop Extension | 3 zile | P3 |
| **Total Faza 3** | **~13 zile** | |

---

## 8. Riscuri si consideratii

### Securitate
- **Stocare credentiale**: TLS certificates si SSH keys trebuie stocate securizat (encrypted at rest in SQLite, nu plaintext)
- **Network exposure**: TCP fara TLS = acces root pe masina remote. Trebuie **obligat** TLS in UI
- **SSH keys**: Private keys nu trebuie sa iasa din container. Mount ca volume, nu copiate in DB
- **RBAC**: Cine are voie sa adauge/stearga hosturi? Doar admin

### Performanta
- **Latenta**: Operatii pe hosturi remote sunt mai lente. UI trebuie sa arate loading states
- **Stats collection**: N hosturi × stats interval = N× load pe Docker Dash. Trebuie interval configurabil per host
- **WebSocket fan-out**: Mai multe event streams = mai mult CPU/memorie pe hub
- **SQLite**: Cu N hosturi, baza de date creste de N ori mai repede. Cleanup-ul devine si mai important

### Reliability
- **Host offline**: Ce se intampla cand un host e offline? UI trebuie sa arate clar, fara sa blocheze altele
- **Reconnect**: TCP/SSH connections se pot pierde. Retry logic cu backoff exponential
- **Partial failures**: Daca 1 din 5 hosturi e down, dashboard-ul trebuie sa functioneze pentru celelalte 4

### UX
- **Context switching**: User-ul trebuie sa stie mereu pe ce host lucreaza. Host name vizibil permanent
- **Container ID conflicts**: Acelasi short ID poate exista pe 2 hosturi. Trebuie prefixat cu host name
- **Search cross-host**: "Gaseste container X" — cauta pe toate hosturile sau doar pe cel selectat?

---

## 9. Concluzie

### Ce avem:
- ~30% din fundatie exista (DB schema, hostId params, feature flag)
- Dockerode suporta nativ TCP+TLS, deci conexiunea e simpla

### Ce lipseste:
- Logica de conexiune multipla in DockerService
- Propagarea hostId prin toate route-urile
- Multi-host stats/events collection
- Intreaga interfata de management hosturi
- SSH tunnel management (complex)

### Recomandare:
1. **Incepe cu Faza 1** (TCP+TLS) — acopera 80% din use cases (servere Linux cu Docker Engine)
2. Docker Desktop se conecteaza prin aceeasi metoda TCP — nu necesita cod special
3. SSH tunnels (Faza 2) — adauga daca userii nu vor sa expuna TCP
4. Agent model (Faza 3) — doar daca hub & spoke devine insuficient

### Comparatie cu Portainer:
| Feature | Portainer CE | Docker Dash (acum) | Docker Dash (dupa Faza 1) |
|---------|-------------|-------------------|--------------------------|
| Local Docker | ✅ | ✅ | ✅ |
| Remote TCP+TLS | ✅ | ❌ | ✅ |
| Remote SSH | ❌ (doar BE) | ❌ | ❌ (Faza 2) |
| Agent-based | ✅ (Portainer Agent) | ❌ | ❌ (Faza 3) |
| Docker Desktop | ✅ (prin TCP) | ❌ | ✅ (prin TCP) |
| Edge Agent (NAT) | ✅ (BE only) | ❌ | ❌ |
| Kubernetes | ✅ | ❌ | ❌ |
