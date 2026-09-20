# Egress: refuzul capabilitatii NET_RAW implicite

## Defect confirmat

Verificarea accepta containere fara NET_ADMIN/SYS_ADMIN, dar verifica doar
capabilitatile adaugate. Docker include NET_RAW in setul implicit. Un proces cu
aceasta capabilitate poate folosi AF_PACKET, care ocoleste lanturile firewall
IP input/output. Surse primare: [Docker, capabilitati implicite](https://docs.docker.com/engine/containers/run/)
si [Linux packet(7), Notes](https://man7.org/linux/man-pages/man7/packet.7.html).

Reproducerea pe LAN si VPS a instalat o politica OUTPUT drop intr-un container
temporar propriu. Trimiterea UDP normala a fost refuzata cu EPERM; un singur frame
AF_PACKET a ajuns la receptorul temporar. Frame-ul folosea adresa IP/MAC reala a
expeditorului si adresa receptorului propriu, fara spoofing sau tinte externe.
Eliminarea explicita a NET_RAW a produs EPERM la crearea socket-ului AF_PACKET.

## Corectie

- Aplicarea filtrului si autorizarea fiecarei conexiuni proxy cer acum
  `cap_drop: [NET_RAW]` sau `[ALL]`, fara reintroducerea NET_RAW/ALL in cap_add.
  Aliasurile CAP_NET_RAW si variantele de litere sunt normalizate. Un utilizator
  non-root nu constituie dovada eliminarii capabilitatii din configuratie.
- Un membru nesigur refuza aplicarea intregului stack inaintea primei mutatii.
- Inspectarea si eliminarea regulilor vechi raman disponibile. Statusul expune
  `safeToFilter: false` si `safetyError`; prezenta tabelei nu certifica siguranta.
  Restrictiile pentru namespace host/shared si containere privilegiate raman.
- Auditul egress afiseaza si NET_RAW implicit, cu instructiuni pentru eliminare.
- Documentatia EN/RO explica recrearea containerului si reaplicarea politicii
  pe identitatea curenta. Aplicatia nu recreeaza automat workload-uri existente.

La upgrade, conexiunile proxy noi ale tintelor legacy cu NET_RAW sunt refuzate.
Operatorul trebuie sa elimine capabilitatea explicit. Verificarea read-only a
instalatiilor LAN/VPS la acest checkpoint a gasit zero politici egress active si
niciun endpoint sidecar configurat. Corectia a fost instalata prin [deploy-ul 8.96.6](2026-09-20-deployment-8.96.6.md),
fara recrearea workload-urilor filtrate.

## Validare

355 suite, 4.639 teste trecute, un test live existent omis; lint fara avertismente.
Help 60/60. Testele includ implicite/null, eliminare ALL/NET_RAW, reintroducere,
aliasuri, autorizare, HTTP 422, propagarea avertismentului in status si recuperare.

Pe fiecare host au trecut opt verificari reale: blocare UDP normala, reproducere
AF_PACKET, refuzul socket-ului dupa cap_drop, refuz implicit/reintrodus, refuz
stack, refuz autorizare, inspectare/eliminare legacy si apply/remove pentru tinta
corect configurata. Cele sase scenarii de tranzactie nftables au fost repetate
pe ambele hosturi dupa schimbare. Toate resursele temporare proprii au fost eliminate.

Reproducere cu helper-ul preconstruit disponibil pe daemonul de test:

```sh
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o /tmp/egress-packet-probe ./scripts/fixtures/egress-packet-probe.go
DD_PACKET_PROBE_BINARY=/tmp/egress-packet-probe \
DD_EGRESS_HELPER_IMAGE=sha256:ID_HELPER_VERIFICAT \
DD_SMOKE_DOCKER_URL=http://127.0.0.1:2375 node scripts/smoke-egress-capabilities.js
```

URL-ul trebuie sa indice daemonul de test autorizat sau un forward SSH local;
nu este o instructiune de a expune un port Docker nou. VPS-ul a fost accesat
printr-un forward SSH cu verificarea cheii hostului.

[Dovezi structurate](2026-09-20-egress-net-raw.json).
Raman deschise IPv6/non-TCP, exceptiile private/DNS, revocarea conexiunilor
existente, restart reconciliation si celelalte limite din auditul egress.
Eliminarea NET_RAW nu certifica izolarea completa fata de un administrator al
hostului sau fata de alte containere privilegiate din retea.
