# Deploy verificat 8.96.6 - LAN si VPS

Ambele instalari ruleaza imaginea production a commit-ului
`6ffc13da88d3d934e0220b2db5d2e53db6e79bdf`, urcat pe `origin/agent/advanced-compose-gitops`.

- Imagine: `docker-dash:8.96.6-audit-6ffc13d`.
- ID: `sha256:8bb32b9be7ca066e21fbe1fa09c302c7c5545548d7a226664cecbf6dbb43e5fb`.
- LAN `192.168.13.20`: Docker healthy, HTTP 200 / ok / 8.96.6.
- VPS `89.37.212.66`: Docker healthy, HTTP 200 / ok / 8.96.6.
- Helper egress fixat pe ambele instalari: `sha256:386bdd5b2c87f4b04867083eb9d771aab0a9446d531c05ae08212f8bb123a8d5`.

Checkpoint-ul instaleaza [protectia NET_RAW](2026-09-20-egress-net-raw.md),
[pastrarea filtrelor suprapuse](2026-09-20-egress-overlap.md), [tranzactiile nftables si recuperarea](2026-09-20-egress-transactions.md)
si [helper-ul preconstruit cu runtime redus](2026-09-20-egress-helper-runtime.md).
Helper-ul exista pe ambele daemone testate. Un alt daemon administrat trebuie sa
primeasca separat imaginea configurata; lipsa ei refuza operatia cu eroare explicita.

## Validare

356 suite / 4.668 teste trecute, un test live existent omis. Lint fara avertismente,
npm audit zero vulnerabilitati, help 60/60 si verificarea i18n trecute.
Imaginea exacta a trecut pe LAN si VPS testele Linux pentru pornire, SQLite,
restart, chei persistente, Git/OpenSSH cu identitate verificata, TLS provider si LDAP.
Canary-ul Compose verifica hash-ul binarului, config/up/health/exec/restart/recreate
si persistenta volumului, cu retea none. Resursele proprii au fost eliminate.
Opt scenarii NET_RAW si sapte scenarii de suprapunere au trecut pe fiecare host.
Cele sase scenarii nftables si testul dependentei profilului helper au trecut anterior
separat pe fiecare host; nu pretind testarea sidecar-ului real de productie.

Scanari imagine principala: Trivy 4 High / 2 Medium / 3 Unknown; Grype 4 High /
5 Medium, fara Critical, aceleasi totaluri ca la 8.96.5. Identitatea manifestului,
configuratia OCI si cele 20 de straturi sunt verificate. Helper: Trivy zero,
Grype doua Medium si zero High/Critical. Nicio exceptie de scanare sau prag de
admitere dezactivat; imaginea nu a fost publicata intr-un registru public.

## Backup si pastrarea configuratiei

Aplicatia a fost oprita pe rand pe fiecare host pentru backup consistent, apoi
inlocuita prin Compose folosind configuratia existenta si un override privat.
Copiere in blocuri de 8 MiB, consolidare WAL, integrity_check ok si SHA-256:
LAN 3942309888 bytes, VPS 615849984 bytes. Directoare 0700,
fisiere 0600. Helper-ele backup au iesit cu cod 0, fara OOM, si au fost eliminate.
Backup-urile si imaginile anterioare sunt pastrate. Nu exista secrete in aceste dovezi.

Cheile, fisierele .env, volumele, porturile si retelele sunt pastrate. Configuratia
pentru helper pastreaza DD_EGRESS_HELPER_IMAGE la imaginea
verificata. Migrarea 177 este prezenta; LAN pastreaza 5 utilizatori /
7 hosturi, VPS 2 utilizatori / 1 host.
Verificarea post-deploy confirma imaginea, helper-ul configurat, Docker healthy,
accesul Docker local si raspunsurile HTTP externe.

## Probleme ramase

Constatarile scannerelor de mai sus, expunerea Docker TCP 2375 din LAN,
credentialele anterior indecriptabile, pool-urile LAN de retea epuizate si
limitarile egress IPv6/non-TCP/private raman deschise. Nu s-a reconfigurat sau
restartat daemonul Docker. Acest checkpoint nu certifica securitatea completa.

[Dovezi deploy](2026-09-20-deployment-8.96.6.json),
[scanari/provenienta/canary](2026-09-20-image-8.96.6.json).
