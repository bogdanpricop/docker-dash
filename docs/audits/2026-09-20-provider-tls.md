# Verificarea TLS a providerilor

Audit: 20 septembrie 2026. Modificari locale, fara publicare sau deploy peste
serviciile existente. Configuratia daemonului Docker LAN nu a fost modificata.

## Probleme corectate

Incus/LXD dezactiva implicit verificarea serverului si confunda autentificarea
clientului cu autentificarea serverului. Formularele Proxmox/vSphere preselectau
dezactivarea verificarii. Exportul kubeconfig genera automat
`insecure-skip-tls-verify: true` cand lipsea un CA explicit, chiar daca aplicatia
verifica certificatul. Nomad si Xen acceptau endpoint-uri HTTP.

Clientii Incus/LXD, Proxmox, vSphere, Kubernetes, Nomad, Xen Orchestra si XAPI
necesita acum HTTPS verificat. Sunt verificate lantul de certificate, valabilitatea
si numele serverului; versiunea minima este TLS 1.2. Certificatele private sunt
acceptate prin `caCert` verificat independent. Nu exista acceptare automata a
certificatului primit. Conexiunile Unix locale si raw-Xen prin SSH raman distincte.

Helperul comun valideaza maximum 128 KiB / 32 de certificate PEM. Respinge
continutul invalid, cheile private amestecate cu certificatele, HTTP, credentialele
incluse in URL si setarile `skipTlsVerify` diferite de false. Xen refuza si caile
de cerere care schimba originea sau protocolul; descriptorii de consola includ
verificarea stricta si CA-ul configurat.

Kubeconfig foloseste CA-ul configurat sau certificatele implicite de incredere.
Configuratiile vechi nesigure refuza exportul pana la migrare. Exportul foloseste
serializarea YAML, astfel incat un token cu linii noi nu poate introduce campuri
precum un plugin exec. Numele numerice ale clusterelor raman siruri de caractere.

## Migrarea configuratiilor existente

In **Hosts**, editeaza hostul si foloseste un endpoint HTTPS valid. Pentru PKI
privat, introdu CA-ul emitent verificat sau certificatul de server autosemnat de
incredere, valid pentru numele endpoint-ului. Obtine certificatul printr-un canal
de administrare deja verificat; nu transforma o eroare TLS in incredere automata.
Testeaza conexiunea si salveaza. Configuratiile vechi cu `skipTlsVerify: true`
refuza conectarea pana la aceasta migrare.

CA-ul gol pastreaza configuratia existenta, la fel ca parolele si tokenurile.
Controlul explicit de eliminare a CA-ului trece la certificatele sistemului;
verificarea ramane activa. Configuratia decriptata gresit nu mai este inlocuita
cu input partial: editarea/testarea raporteaza eroarea si pastreaza datele.
Explicatiile si formularele sunt disponibile in romana si engleza.

Au fost corectate ghidurile curente care recomandau bypass TLS pentru acesti
provideri, inclusiv ghidul Nomad dev: agentul HTTP trebuie migrat la HTTPS inainte
de conectarea din Docker Dash. Instructiunile Incus folosesc formularul existent
si salvarea criptata a credentialelor.

## Dovezi

Validarea completa: **349 suite, 4.482 teste reusite, unul omis**.
[Rezultatul sintetic](2026-09-20-provider-tls.json) consemneaza si ID-ul imaginii.

- Servere HTTPS reale pentru toti cei opt clienti: CA privat corect acceptat;
  CA absent/gresit, certificat expirat sau nume gresit refuzat inainte de orice
  cerere HTTP. Certificatul client Incus/LXD este verificat de serverul mTLS.
- SQLite/Express reale pentru sase tipuri de host: validare CA, refuzul bypass-ului,
  pastrarea credentialelor si CA-ului, eliminare explicita CA si refuzul editarii
  datelor care nu pot fi decriptate. Test separat pentru descriptorul consolei Xen.
- Browser real cu CSP, EN/RO: formulare pentru toate tipurile remote, CA nou,
  pastrare/eliminare CA, migrarea flag-ului vechi si payload-ul testarii la editare.
- Lint, verificare sintaxa si help pentru toate cele 60 de pagini trecute.
- Imaginea Linux finala `sha256:ee5bde868cec4a76c23ffbea93b452204de0920fdaea8726e4b6c24cea50a428` a trecut pornirea, SQLite, Compose, healthcheck,
  verificarea Git/OpenSSH, mTLS cu CA corect si refuzul CA-ului gresit, precum si
  persistenta secretelor dupa restart. Containerul de test a fost eliminat.

Acestea sunt teste reale de transport si teste ale aplicatiei. Nu reprezinta
validare end-to-end pe instalatii reale Proxmox/vSphere/Kubernetes/Nomad/Incus/Xen:
nu avem inca un asemenea mediu disposable configurat. Nici scanarea imaginii
anterioare nu este atribuita automat acestui nou ID.

## Puncte ramase deschise

API Docker neautentificat pe LAN, vulnerabilitatea zlib din imagine, exceptiile
TLS ale altor integrari (inclusiv LDAP), snapshot-urile istorice si actualizarea/
rollback-ul tranzactional raman in audit. Modificarea transportului providerilor
nu demonstreaza securitatea integrala a proiectului.

Surse primare pentru modelul de incredere:
[Node TLS](https://nodejs.org/api/tls.html#tlscreatesecurecontextoptions),
[autentificare Incus](https://linuxcontainers.org/incus/docs/main/authentication/),
[kubeconfig](https://kubernetes.io/docs/reference/config-api/kubeconfig.v1/) si
[configurarea TLS Nomad](https://developer.hashicorp.com/nomad/docs/configuration/tls).
