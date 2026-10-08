# Helper egress: runtime redus, versiunea 8.96.5

Helper-ul implicit este acum `docker-dash-egress-helper:local`, construit prin
profilul Compose `egress`. Un helper lipsa produce o eroare explicita de configurare.
Instalarea nftables la executie ramane disponibila numai pentru imagini legacy
selectate explicit. Deploy-urile de audit fixeaza helper-ul prin ID imuabil.

Imaginea pastreaza nftables, shell-ul si dependentele lor. Dupa instalare elimina
apk-tools, libapk, ca-certificates-bundle, ssl_client, zlib, libssl3 si libcrypto3.
Alpine pastreaza alpine-keys ca dependenta a alpine-release. Baza de date reala a
pachetelor ramane disponibila scannerelor: 17 pachete, fara ascunderea inventarului.
Verificarea legaturilor dinamice si testele nftables confirma ca zlib nu este
necesar acestui runtime. Nu se modifica imaginea principala prin aceasta masura.

Helper verificat: `sha256:386bdd5b2c87f4b04867083eb9d771aab0a9446d531c05ae08212f8bb123a8d5`.
Trivy: zero constatari. Grype: doua Medium pentru BusyBox (CVE-2025-60876),
zero High/Critical. Identitatea manifest/config si ordinea celor doua straturi
sunt verificate; nicio exceptie de scanare nu a fost adaugata.

Pe LAN si VPS au trecut cele sase scenarii reale de tranzactie nftables:
respingere atomica, restaurarea politicilor unui stack, reapply fara afectarea
altor tabele, rezervare concurenta, restaurarea absentei unei tabele si pastrarea
snapshot-ului dupa recuperare esuata. Au fost modificate numai namespace-uri
temporare proprii, eliminate la final.

Un test Compose separat, pe fiecare host, verifica definitia serviciului helper
din proiect si dependenta `service_completed_successfully`: bootstrap fara retea,
read-only, fara capabilitati, urmat de verificarea nftables, absentei apk/zlib si
pastrarii inventarului. Acest test nu porneste sidecar-ul real de productie.

Regresie aplicatie: 355 suite, 4.615 teste trecute, un test live existent omis;
lint fara avertismente si npm audit fara vulnerabilitati. Dovezile structurate
sunt in [JSON](2026-09-20-egress-helper-runtime.json).

Raman deschise constatarile Medium ale helper-ului, constatarile imaginii
principale, acoperirea IPv6/non-TCP si limitarile documentate ale politicii egress.
Portul Docker 2375 din LAN nu este securizat prin acest deploy.
