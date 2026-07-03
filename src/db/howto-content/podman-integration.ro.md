---
slug: podman-integration
title: Podman Integration
title_ro: Integrare Podman
category: docker-dash
difficulty: intermediate
icon: fas fa-cube
summary: Run Docker Dash against a Podman socket instead of the Docker daemon.
summary_ro: Rulează Docker Dash împotriva unui socket Podman în loc de daemon Docker.
---

## Prezentare

Docker Dash comunică prin Docker Engine REST API v1.40+. Podman expune un socket REST compatibil Docker care implementează același protocol, deci Docker Dash poate administra host-uri Podman **fără schimbări de cod** — redirectezi doar calea socket-ului montat.

Dashboard-ul detectează Podman automat la runtime și:

- Afișează un badge violet **PODMAN** pe cardul Engine
- Redenumește "Docker Engine" în **Podman** în tabul Info
- Ascunde funcționalitățile Docker-only pe care Podman nu le implementează (Swarm, plugin-uri, endpoint-uri BuildKit)

## Setup Podman rootful (recomandat pentru servere headless)

Activează socket-ul API Podman prin systemd:

```bash
sudo systemctl enable --now podman.socket
```

Verifică că socket-ul există și e compatibil Docker:

```bash
sudo curl --unix-socket /run/podman/podman.sock http://localhost/_ping
# trebuie să afișeze: OK
```

Indică socket-ul Podman în `.env`:

```env
DOCKER_SOCKET=/run/podman/podman.sock
```

Restart:

```bash
docker compose up -d app
```

Deschide **System → Info** — cardul Engine arată acum **Podman** cu versiunea detectată.

## Podman rootless (desktop pentru un singur utilizator / dezvoltare)

Podman rootless rulează socket-ul sub directorul XDG runtime al utilizatorului curent:

```bash
systemctl --user enable --now podman.socket
ls -l "$XDG_RUNTIME_DIR/podman/podman.sock"
# exemplu: /run/user/1000/podman/podman.sock
```

Modul rootless funcționează, dar are aceste avertismente:

- Socket-ul e deținut de utilizator, nu de `root`. Trebuie să rulezi Docker Dash cu același UID sau să faci bind-mount cu owner-ul corespunzător.
- Rețeaua rootless folosește `slirp4netns` implicit — port bindings funcționează dar adresele IP per-container diferă față de rootful.
- Unele storage driver-e se comportă diferit sub user namespaces.

Pentru setup rootless, montează socket-ul utilizatorului în containerul Docker Dash:

```yaml
services:
  app:
    volumes:
      - ${XDG_RUNTIME_DIR}/podman/podman.sock:/var/run/docker.sock:ro
    user: "1000:1000"   # potrivește-l cu UID-ul tău
```

## Note SELinux (Fedora / RHEL / CentOS Stream)

Pe host-uri cu SELinux enforcing, adaugă flag-ul `:Z` la bind mount ca socket-ul să primească un context prietenos pentru container:

```yaml
    volumes:
      - /run/podman/podman.sock:/var/run/docker.sock:ro,Z
```

Dacă Podman refuză conexiunea cu eroare de permisiune, verifică:

```bash
sudo ausearch -m avc -ts recent | grep podman
```

și consideră setarea boolean-ului container_manage_cgroup:

```bash
sudo setsebool -P container_manage_cgroup on
```

## Ce funcționează și ce nu

| Funcționalitate | Docker | Podman | Note |
|---|---|---|---|
| Containere CRUD | Da | Da | Paritate completă |
| Imagini CRUD | Da | Da | Paritate completă |
| Rețele | Da | Da | Podman folosește CNI sau Netavark |
| Volume | Da | Da | Paritate completă |
| Compose | Da | Da | Podman are `podman compose` |
| Mod Swarm | Da | **Nu** | Ascuns în UI pe host-uri Podman |
| Plugin-uri Docker | Da | **Nu** | Ascunse în UI pe host-uri Podman |
| BuildKit | Da | **Nu (folosește Buildah)** | Ascuns în UI; folosește `podman build` din CLI |
| Stream de events Docker | Da | Da | Podman implementează endpoint-ul de events |
| Statistici container | Da | Da | Pot diferi ușor în denumirea câmpurilor |
| Exec în container | Da | Da | Paritate completă |

## Multi-host: amestecul Docker și Podman

Docker Dash detectează tipul daemon-ului **per host**. Poți avea Host A pe Docker și Host B pe Podman în același dashboard. Cardul Engine și elementele de meniu se ajustează per-host — fără configurație suplimentară dincolo de setarea corectă a căii socket-ului când adaugi fiecare host.

## Depanare

**"docker: Cannot connect to the Docker daemon" în UI**

Calea socket-ului e greșită sau fișierul socket are permisiuni restrictive.

- Rootful: verifică `sudo ls -l /run/podman/podman.sock` — trebuie să fie `srw-rw----` root:root
- Rootless: verifică `ls -l "$XDG_RUNTIME_DIR/podman/podman.sock"` — trebuie să fie deținut de user
- SELinux: adaugă `:Z` la bind mount (vezi mai sus)

**"Swarm not available" — dar sunt pe Docker!**

Detecția daemon-ului a raportat host-ul ca Podman. Verifică output-ul `docker version`:

```bash
docker version --format '{{json .Server.Components}}'
```

Dacă câmpul `Name` al vreunei componente conține "Podman", detecția a lucrat corect. Dacă chiar ești pe Docker dar detecția greșește, deschide un issue cu output-ul brut.

**API-ul Podman e mult mai vechi decât Docker Dash**

Podman < 4.x are compatibilitate Docker API mai îngustă. Versiunile recente Podman (4.x, 5.x) acoperă endpoint-urile de care are nevoie Docker Dash. Dacă trebuie neapărat să rulezi Podman mai vechi, unele funcționalități pot returna 404 — asta e upstream, nu un bug Docker Dash.

## Referințe

- Documentația REST API Podman: https://docs.podman.io/en/latest/markdown/podman-system-service.1.html
- Blog Podman REST API vs Docker API: https://podman.io/blogs/2020/07/01/rest-versioning.html
- Tutorial socket activation Podman: https://github.com/containers/podman/blob/main/docs/tutorials/socket_activation.md
