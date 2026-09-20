# Deploy verificat 8.96.4 - LAN si VPS

Ambele instalari ruleaza imaginea production a commit-ului
`ee84152ce9b8cd2d5e568fdb62c9e1820a5c7574`, disponibil pe
`origin/agent/advanced-compose-gitops`. Commit-ul ulterior `af18699` imbunatateste
doar scriptul de canary executat din workspace; nu modifica imaginea aplicatiei.

- Imagine: `docker-dash:8.96.4-audit-ee84152`.
- ID: `sha256:4d9f24d916ab6f588064d07a237cc63281cf1183ed57f0debd3b84ea77cb7811`.
- LAN `192.168.13.20`: Docker healthy, HTTP 200 / ok / 8.96.4.
- VPS `89.37.212.66`: Docker healthy, HTTP 200 / ok / 8.96.4.
- Aceleasi chei si fisiere `.env`; migrarea 177 ramane aplicata. LAN pastreaza
  5 utilizatori / 7 hosturi, VPS 2 utilizatori / 1 host. Listarea Docker locala
  functioneaza: 148, respectiv 89 containere active la verificare.

Checkpoint-ul instaleaza [corectia scripturilor cu secrete](2026-09-20-remote-secret-execution.md)
si [Compose 5.5.1+dd.1](2026-09-20-compose-rebuild.md). Se folosesc fisierele Compose
din etichetele containerului curent, plus noul override privat al checkpoint-ului.
Volumele, retelele si porturile existente sunt pastrate; codul ruleaza din imagine.

## Validare si backup

Testele upstream Compose lifecycle/API/CLI au trecut. Regresia recenta a aplicatiei
are 354 suite / 4.605 teste trecute, un test live existent omis; la acest checkpoint
s-au repetat cele 32 teste SSH/secrete, toate trecute. Lint fara avertismente,
help 60/60, i18n si npm audit fara vulnerabilitati raportate.

Imaginea exacta a trecut pe ambele hosturi verificarea Linux pentru pornire,
SQLite, HTTP, restart, persistenta cheilor, Git/OpenSSH, LDAP verificat si mTLS.
Canary-ul Compose verifica hash-ul binarului, pornirea/health, executia, restartul,
recrearea fortata si persistenta continutului unui volum. Resursele temporare au
fost eliminate. Testarea retelei implicite LAN a identificat pool-uri de adrese
epuizate; canary-ul final foloseste `network_mode: none` si nu pretinde validarea
alocarii unei retele noi. Infrastructura de retea existenta nu a fost modificata.

Inaintea fiecarei inlocuiri, aplicatia a fost oprita pentru backup consistent.
Copierea bazei s-a facut in blocuri de 8 MiB cu fdatasync, apoi consolidare WAL,
SQLite integrity_check si SHA-256. Directoare private 0700, fisiere 0600:
LAN 3.942.309.888 bytes, VPS 615.849.984 bytes. Ambele backup-uri au trecut;
RSS raportat aproximativ 71 MiB LAN / 83 MiB VPS. Helper-ele s-au terminat cu
exit 0, fara OOM, si au fost eliminate. Backup-urile si imaginea precedenta raman
disponibile; secretele nu sunt incluse in Git.

Imaginea a fost transferata din LAN pe VPS prin SSH cu verificarea cheii hostului.
Identitatea imaginii si commit-ul au fost verificate dupa incarcare. Verificarea
post-deploy confirma din nou imaginea, cheile/configuratia, conturile, migrarea,
Docker healthy si accesul HTTP extern pe ambele adrese.

## Limite deschise

Trivy: 4 High / 2 Medium / 3 Unknown. Grype: 4 High / 5 Medium. Niciun Critical;
fiecare scanner are un Medium mai putin fata de 8.96.3, prin actualizarea containerd
din Compose. Scanarile sunt legate de manifestul/configuratia OCI si cele 20 de
straturi ale imaginii exacte. Nu s-au adaugat exceptii de scanare, dezactivat praguri
de admitere sau publicat imaginea in registrul public.

Expunerea Docker TCP 2375 din LAN, credentialele anterior indecriptabile,
pool-urile de retea epuizate si restul lucrarilor auditului raman deschise.
Nu s-a restartat/reconfigurat daemonul Docker si nu s-au modificat alte servicii.

[Dovezi deploy](2026-09-20-deployment-8.96.4.json) si
[scanari/provenienta/canary](2026-09-20-image-8.96.4.json).
