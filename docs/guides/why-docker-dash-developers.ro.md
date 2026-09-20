# Docker Dash pentru developeri care folosesc Git

**Public țintă:** developeri care folosesc git zilnic, probabil n-au intrat încă deplin în Docker, și vor să știe de ce Docker Dash specific — nu Portainer, nu Dockge, nu scripturi bash.
**Timp de citire:** ~5 minute.

> ⏪ [Înapoi la README](../../README.md) · 🇬🇧 [English version](why-docker-dash-developers.md)

---

## "Știu git. De ce să mă apuc de Docker?"

Git îți versionează **codul**. Docker îți versionează **mediul în care rulează codul**.

Modelul mental dacă deja folosești git:

| Git | Docker |
|---|---|
| `git commit` | image (snapshot imutabil) |
| branch / tag | image tag (`v1.2.0`, `latest`, `staging`) |
| `git clone` | `docker pull` |
| GitHub / GitLab | Docker registry (Docker Hub, GHCR, Harbor) |
| `package.json` | `docker-compose.yml` |
| diff între commits | image layers (fiecare `RUN` / `COPY` = un layer) |
| `git revert` | `docker compose up image:v1.1.0` (rollback instant) |

Dacă ai trăit vreodată "merge pe local, nu merge pe server" sau "trebuie să convingem ops să-ți instaleze Redis" — Docker e răspunsul. **Compose-ul devine sursa adevărului pentru toată infrastructura ta de runtime**, exact cum `package.json` e sursa adevărului pentru dependențe.

## Cele 5 locuri unde dev-ii care folosesc git se blochează la Docker

1. **Volume vs bind mounts** — *"unde naiba îmi trăiește baza de date după restart"*
2. **Networking** — *"de ce nu se poate conecta containerul `web` la `db` deși sunt amândouă pornite"*
3. **Compose vs Swarm vs Kubernetes** — *"îmi trebuie K8s pentru 3 container-e?"* (nu, niciodată)
4. **Image hygiene** — *"de ce am 1.2 GB pentru un app Node de 12 MB"*
5. **Secrete** — `.env` în git, păcatul originar

Un UI bun pentru Docker rezolvă vizual #1, #2, #5 — nu mai trebuie să-ți amintești comenzi `docker network inspect` la 2 noaptea.

## "OK, dar de ce Docker Dash și nu Portainer / Dockge / scripturi bash?"

### Portainer

- **Tot ce contează pentru orice firmă reală e paywall:** OIDC, SSO, LDAP, audit log, RBAC granular, MFA. Costă **$95/server/an**.
- Stack-urile compose **trăiesc într-o bază internă a Portainer** — dacă pică Portainer, configurațiile tale dispar din vedere până-l reînvii.
- Issue [#3582 pe GitHub](https://github.com/portainer/portainer/issues/3582) e plin de utilizatori furioși că un PR comunitar de OAuth a fost transformat în feature plătit.

### Dockge

- Excelent pentru *"compose, frumos, simplu"*. Compose pe disc, nu în DB — exact ce vrei.
- **Limitat:** fără audit log, fără MFA, fără RBAC, fără multi-host serios, fără scanări de imagini.
- Dacă ai 3 container-e în homelab — perfect. Dacă ai un server de producție — rămâi în urmă.

### Scripturi bash + SSH

- Funcționează până în ziua în care îți trebuie audit (*"cine a oprit container-ul de prod la 3 dimineața?"*) sau RBAC (*"dezvoltatorul nou să poată reporni dar nu să șteargă"*).
- Suporți tu mental tot statusul cluster-ului. Distractiv pentru 5 servicii, neglijabil periculos pentru 50.

### Docker Dash

Docker Scout este exclus temporar din motive de securitate; [explicatia si conditiile de revenire](../audits/2026-09-20-scout-exclusion.md).

- **Tot ce paywall-uiește Portainer Business, free, în același pachet:** OIDC, LDAP, SSO via header, audit log cu hash chain SHA-256 (compliance-friendly), RBAC pe trei niveluri, MFA cu cod de recuperare, scanare imagini cu Trivy / Grype, CIS Docker Benchmark integrat.
- **Multi-host prin tunel SSH** — fără agent pe serverul remote. Adaugi un host nou cu cheie SSH, gata.
- **Stack-urile Compose pleacă din git repo:** conectezi un repo, alegi branch, deploy-ul rulează `docker compose up -d` cu webhook auto-pull. Rollback un click.
- **Secrets Wizard** — paste un `.env` complet, primește un script bash hardenat care creează fișiere `*_FILE` cu permisiuni `600`, owner `root:docker`, opțional cu deploy SSH automat. Plus un **Rotation Tracker** care te bate la cap când expiră secretele.
- **Certificate Manager** — track la PEM-uri, expirare, generator CSR (RSA 4096 / EC P-256).
- **Single binary feel** — un container, fără DB externă, fără Redis, fără build step. **80 MB image, 50 MB RAM.** Merge pe N100 sau pe c5.large fără diferență.
- **MIT licensed**, fără telemetrie, fără signup, fără *"register your instance"*.

## Workflow-ul tău cu Docker Dash dacă deja folosești git

```
1. Push la repo cu docker-compose.yml
2. Docker Dash detectează prin webhook
3. Pull la cod, docker compose up -d cu noua imagine
4. Audit log: "deploy webhook → user X → commit abc123 → success în 12s"
5. Dacă ceva crapă: rollback la versiunea anterioară din UI, un click
```

Ai **GitOps fără Argo CD, fără K8s, fără YAML kafka-esc**.

## De unde să începi

- 👉 [Quick Start](../../README.md#quick-start) — instalează Docker Dash în 2 minute
- Deschide **Stacks** din meniul stâng — conectează primul tău git repo
- Deschide **Hosts** — adaugă un server remote cu o cheie SSH (fără instalare de agent)
- Deschide **System → Secrets → Audit & Wizard** — paste un `.env` real și uită-te cum clasifică 20+ tipuri de secrete și generează scriptul de setup hardenat
- Deschide **System → Audit Log** — vezi tot hash-chain-ul fiecărei acțiuni din momentul instalării

---

> E prima dată când auzi de Docker în general? Citește mai întâi [Ghidul pentru începători](why-docker-dash-beginners.ro.md) — acoperă metafora rețetă-și-bucătărie și basic-urile pe care ghidul ăsta le presupune deja înțelese.
