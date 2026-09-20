# Deploy verificat 8.96.3 — LAN si VPS

Ambele instalari ruleaza imaginea production a commit-ului
`9cfa369ca101ef1d5dd34f4feb215f56ee7ea412`, urcat pe
`origin/agent/advanced-compose-gitops`.

- Imagine: `docker-dash:8.96.3-audit-9cfa369`.
- ID: `sha256:cecc9a75b71ed5b471a08e87a296dfa8cca08a10dea0563f85e391845528e4a3`.
- LAN: `192.168.13.20`, Docker healthy, HTTP `/api/health` ok / 8.96.3.
- VPS: `89.37.212.66`, Docker healthy, HTTP `/api/health` ok / 8.96.3.
- Migrarea 177 aplicata pe ambele; aceleasi chei si fisiere `.env`.
  LAN pastreaza 5 utilizatori / 7 hosturi, VPS 2 utilizatori / 1 host.
  Listarea Docker locala functioneaza: 148, respectiv 89 containere active.

Configuratia Compose efectiva include override-ul checkpoint-ului anterior si
un override nou pentru 8.96.3. Volumele, porturile si retelele instalatiei sunt
pastrate. Codul este cel din imagine, fara bind mount peste `src` sau `public`.
Pentru urmatorul deploy se folosesc fisierele din etichetele Compose ale
containerului activ, nu doar fisierul de baza care poate selecta o imagine veche.

## Validare

353 suite / 4.580 teste reusite, un test live existent omis. Dupa ultima ajustare
si bump, 95 teste specifice au trecut din nou. Lint fara avertismente, sintaxa JS
si help 60/60 trecute; browser/YAML editor verificate sub CSP. Imaginea exacta a
trecut smoke Linux pentru pornire, SQLite, HTTP, restart, chei persistente, Git SSH,
LDAP verificat si mTLS provider. Canary-urile de inlocuire si recuperare sunt
[documentate separat](2026-09-20-container-replacement.md).

Aceeasi imagine a fost exportata din LAN si incarcata pe VPS prin SSH verificat.
Verificarea post-deploy a confirmat ID-ul, versiunea si eticheta de commit, starea
healthy, migrarile, conturile si hash-urile cheilor/configuratiei. Nu s-a publicat
imaginea in registrul public si nu s-au dezactivat pragurile de securitate.

## Backup si incidentul controlat din LAN

Inainte de inlocuire, aplicatia a fost oprita pentru o copie consistenta a bazei
si configuratiei, intr-un director privat 0700, fisiere 0600. Backup final LAN:
3.942.309.888 bytes; VPS: 615.849.984 bytes. Ambele au trecut SQLite integrity_check,
consolidarea WAL si verificarea SHA-256. Contin secrete si nu sunt incluse in Git.

Doua incercari LAN cu copierea nativa a fisierului au depasit memoria containerului
auxiliar (512 MiB, apoi 1 GiB). Originalul 8.96.2 a fost repornit automat dupa
fiecare esec; niciun deploy nu a continuat fara backup verificat. Al doilea helper
a confirmat explicit `OOMKilled=true`, exit 137. Copierea a fost schimbata in
blocuri de 8 MiB cu fdatasync dupa fiecare bloc. Metoda a fost verificata separat
pe 2,68 GB, prin hash, cu aproximativ 89 MB RSS, inainte de noua oprire a aplicatiei.

Copierea finala se face pe baza oprita, intr-o zona privata; SQLite aplica WAL-ul
copiat, verifica integritatea si inchide conexiunea inaintea redenumirii atomice
in `database.sqlite`. Hash-ul se calculeaza incremental. RSS final raportat:
aproximativ 116 MB LAN / 86 MB VPS. Containerele auxiliare si cele trei copii
incomplete/de test au fost eliminate dupa confirmarea backup-ului final. Backup-ul
verificat, configuratia de recuperare si imaginea anterioara sunt pastrate.

## Scanarea imaginii exacte si limite

Trivy: 4 High, 3 Medium, 3 Unknown. Grype: 4 High, 6 Medium. Niciun Critical.
Aceste constatari raman deschise; nu se afirma ca intreaga imagine este securizata.
Trivy raporteaza manifestul OCI, Grype configuratia imaginii. Exportul a confirmat
SHA-256 pentru ambele, legatura manifest-config, platforma linux/amd64 si toate cele
20 de straturi in ordine. [Dovezile scanarii](2026-09-20-image-8.96.3.json) sunt
legate de acest ID, nu preluate automat de la imaginea precedenta.

Expunerea Docker TCP 2375 din LAN, credentialele anterior indecriptabile si restul
lucrarilor auditului raman documentate separat. Nu s-a modificat/restartat daemonul
Docker si nu s-au schimbat celelalte servicii ale hosturilor.

[Dovezi sanitizate ale deploy-ului](2026-09-20-deployment-8.96.3.json).
