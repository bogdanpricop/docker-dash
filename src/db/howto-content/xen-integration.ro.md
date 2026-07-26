---
slug: xen-integration
title: Integrare Xen, XCP-ng și XenServer
category: docker-dash
difficulty: advanced
icon: fas fa-cloud
summary: Înregistrează Xen Orchestra, XAPI nativ sau un host Xen Project și operează VM-urile conform capabilităților detectate.
---

## Alege planul de management

Folosește **Xen Orchestra** pentru mai multe pool-uri, **XAPI** pentru acces direct la un pool XCP-ng/XenServer sau **Raw Xen** pentru un dom0 Xen Project independent.

| Opțiune | Credențiale | Recomandat pentru |
|---|---|---|
| Xen Orchestra | token (recomandat) sau user/parolă | administrare centralizată |
| XAPI | user/parolă dedicată | un pool XCP-ng/XenServer |
| Raw Xen | cheie SSH pin-uită + sudo restricționat | `xl`/libxl; fallback legacy `xm` |

## Înregistrare

1. Deschide **Hosts → Non-Docker host**.
2. Selectează **Xen / XCP-ng / XenServer**.
3. Alege planul de management și completează câmpurile lui.
4. Folosește un CA de încredere. **Skip TLS verification** este doar pentru test temporar.
5. Apasă **Test connection**, salvează, apoi deschide **Xen / XCP-ng** din meniu.

Pagina Xen afișează pool-uri, hosturi, VM-uri, storage repositories, rețele și task-uri asincrone. Butoanele de power și snapshot apar numai dacă providerul, versiunea și rolul utilizatorului le permit.

## Checklist de producție

- Creează un cont service cu privilegii minime.
- Pin-uiește CA-ul pentru HTTPS sau amprenta SHA-256 a hostului pentru SSH.
- Păstrează accesul de urgență la consola nativă înainte să testezi operații destructive.
- Verifică toate operațiile de scriere în **Audit Log**.
- Folosește Xend/`xm` doar ca punte de migrare: este obsolete și oferă mai puține capabilități.
