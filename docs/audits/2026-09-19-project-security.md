# Audit proiect și securitate — 19 septembrie 2026

Stare: modificări locale, pornind de la v8.96.1; fără release sau deploy.
Actualizat: 20 septembrie 2026, după build-urile Docker reale și scanarea imaginii.

## Rezultat

Auditul a închis defecte în funcțiile existente, a actualizat dependențele și a
întărit verificările automate. Nu reprezintă un pentest sau certificarea securității
instanțelor instalate. Extinderile mari din roadmap și validările cu infrastructură
reală sunt enumerate separat, fără a fi declarate finalizate.

| Verificare | Înainte | După |
|---|---|---|
| npm audit, toate dependențele | 21 probleme: 15 high, 4 moderate, 2 low | 0 |
| OSV Scanner 2.6.0, lockfile complet | — | 0 vulnerabilități identificate |
| Imagine Docker completă, Trivy 0.74.0 | neexecutat | 39 High, 25 Medium, 9 Low, 3 Unknown în scanerele incluse; detalii mai jos, release neaprobat |
| Jest | 4.177 trecute, 3 eșecuri, 4 omise | 4.287 trecute, 0 eșecuri, 1 omis; 344 suite; Node 24.21.0; 2 workeri |
| Docker smoke Linux | neexecutat | Pornire/SQLite/health/restart/secrete: trecute; 12 scenarii de autorizare egress: trecute |
| Instalare reproductibilă | — | `npm ci` reușit, fără opțiuni de ignorare a conflictelor |
| ESLint | 14 avertismente la activarea pragului zero | 0 erori, 0 avertismente; backend și frontend |
| Biblioteci în browser | versiuni copiate manual | 100 fișiere verificate contra lockfile-ului; smoke Chromium sub CSP |
| Localizare/accesibilitate | — | 11 limbi; verificările self-service trec |
| Help pentru pagini | — | 60/60 pagini acoperite |
| Catalog funcționalități | 450 | 391 Done, 59 Partial, 0 Open; păstrat fără reclasificări artificiale |

Comenzile și rezultatele brute sunt păstrate local în `.git/audit-*.log` și
`.git/audit-*.json`; nu se includ în imaginea aplicației.

## Defecte închise

- **LDAP login:** prima autentificare și autentificările ulterioare folosesc
  directorul, în locul verificării imposibile contra hash-ului local aleator.
  MFA, blocarea conturilor și dezactivarea utilizatorilor rămân aplicate.
  O respingere LDAP nu permite fallback la parola locală; un utilizator LDAP
  nu poate prelua un cont local cu același nume.
- **LDAP credentials:** parola de bind este criptată AES-256-GCM la salvare.
  Migrarea 174 convertește configurația existentă și este idempotentă.
  Coruperea ciphertext-ului blochează accesul; parolele goale sunt respinse înainte
  de bind. Grupul cerut trebuie să coincidă cu întregul DN, fără substring matching.
- **Read-only:** modificarea/ștergerea configurației LDAP și salvarea setărilor
  generale folosesc middleware-ul de protecție. Endpoint-ul general de setări
  nu mai permite ocolirea salvării securizate a configurației LDAP.
- **TLS outbound:** verificarea certificatelor este activă pentru SMTP, registry,
  Copilot, log forwarding și probele de observabilitate. Pentru CA interne se
  folosește `NODE_EXTRA_CA_CERTS`; excepția LDAP aleasă explicit de admin rămâne.
  Nodemailer nu poate încărca conținutul mesajului din fișiere sau URL-uri.
- **CSRF:** administrarea paginii de status nu mai este exceptată. Excepțiile de
  rutare au limite exacte. Un header Bearer arbitrar nu mai scutește cererile care
  folosesc cookie/SSO; clienții cu Bearer/ApiKey explicit continuă să funcționeze.
- **Criptare:** decriptarea cere IV-ul și tag-ul GCM complete; tag-urile trunchiate
  și reprezentările hex invalide sunt respinse.
- **Retenție registry:** aliasurile unui manifest păstrat/protejat nu mai intră
  în planul de ștergere; inventarele trunchiate sau cu manifeste ilizibile sunt
  refuzate. Modificarea digest-ului între plan și execuție blochează
  ștergerea. Fiecare ștergere de retenție produce acum înregistrarea de audit promisă.
  Concurența între scriitori externi ai registry-ului nu poate fi eliminată atomic
  de Distribution; protecția se bazează pe inventarul evaluat și verificarea digest-ului.
- **Testele Copilot:** testele istoricului nu mai lansează scanări reale asupra
  stației de dezvoltare; păstrează asamblarea contextului din DB și testele anti-leak.
- **Saved inventory views:** revocarea accesului la hostul view-ului default
  revine la view-ul built-in, fără filtrele vechi aplicate altui inventar.
  Schimbarea default-ului invalidează versiunea view-ului anterior și respinge
  actualizările din taburi stale. Chromium verifică CRUD, filtre, sortare, coloane,
  refresh, CSRF, restaurare și revocare cu rute reale și inventar fixture.
- **Egress sidecar:** modul necunoscut nu mai permite traficul; metadata IMDS
  este blocată inclusiv în audit-only, prin alias DNS, trailing dot și IPv4-mapped
  IPv6. Rezoluția DNS se face o singură dată, toate adresele sunt verificate și
  conexiunea folosește IP-ul validat. HTTP scurt nu mai așteaptă 4 KiB/timeout;
  CONNECT deschide un tunel real fără să trimită headerul proxy destinației.
  HTTP folosește implicit portul 80, iar half-close păstrează răspunsul serverului.
- **CI:** verifică toate dependențele npm, OSV production high/critical și advisory-uri
  fără scor, fișierele browser, sintaxa cu propagarea erorilor și help-ul paginilor.
  Rezumatul arată rezultatul real al pașilor, în loc de bife verzi necondiționate.
  Workflow-ul de publicare a imaginii Docker depinde acum de validarea CI reușită.

## Actualizări

Versiunile au fost verificate în registrul npm și în release-urile oficiale.
Actualizările includ better-sqlite3 13.0.3, ldapts 9.2.0, Nodemailer 10.0.10,
ioredis 6.0.0, noVNC 1.7.0, Puppeteer 25.11.0, ESLint 10.11.0, Jest 30.5.2,
sharp 0.35.4, esbuild 0.28.2, YAML 2.9.1 și js-yaml 5.4.2.

Bibliotecile browser sunt urmărite de npm și regenerate reproductibil prin
`npm run build:vendor`. Versiunile complete sunt în
[`public/vendor/versions.json`](../../public/vendor/versions.json).
noVNC este încărcat ca modul înaintea deschiderii conexiunii consolei, pentru a
respecta inițializarea asincronă din 1.7. Chart.js 4.5.1, xterm 6.0.0,
addon-fit 0.11.0 și Font Awesome 7.3.1 au trecut verificarea reală în Chromium.

CodeMirror a fost migrat de la 5.65.21 la **6.0.2**, cu adaptorul YAML 6.1.3.
Bundle-ul self-hosted este generat din surse, cu versiuni și licențe incluse.
Testul Chromium verifică tastarea, undo, navigarea cu Tab, diagnosticele YAML,
sincronizarea/resetarea formularului, read-only, ciclul modalului și fallback-ul
textarea. `npm outdated` nu mai raportează dependențe directe restante.

Excepții explicite:

- ioredis-mock publică încă peer dependency pentru v5. Override-ul este limitat
  la acest mock; suita de cluster trece cu ioredis 6. Producția păstrează RESP2
  prin `protocol: 2`; validarea unui cluster Redis real rămâne necesară la rollout.
- Unele dependențe tranzitive sunt mai vechi/deprecated, conform constrângerilor
  upstream (de exemplu `prebuild-install`, `glob` din instrumentele de test).
  Nu au advisory-uri active raportate de scanările executate; nu s-au forțat
  upgrade-uri majore globale ale acestora.

Docker, `.nvmrc` și CI folosesc Node **24.21.0 LTS** cu npm **11.19.1**.
Instalarea curată a fost verificată cu acest runtime portabil, fără schimbarea
instalării globale Node 24.11.1 de pe stație. `allowScripts` aprobă numai versiuni
explicite ale scripturilor necesare, iar `.npmrc` respinge pachetele nerevizuite.
Excepția npm este deliberată: tag-ul `latest` indică 12.0.2, publicat înainte de
11.19.1. Imaginea cu npm 12.0.2 avea nouă constatări în pachetele incluse în npm
(brace-expansion, ip-address, tar, undici), separate de lockfile-ul aplicației.
Release-ul 11.19.1 include versiunile corectate 5.0.9, 10.5.0, 7.5.22 și 6.28.0.
Instalarea curată cu npm 11.19.1 trece; migrarea la npm 12 rămâne condiționată de
corecțiile sale upstream. [Changelog npm](https://github.com/npm/cli/releases/tag/v11.19.1).

Fallback-ul node-gyp al better-sqlite3 este dezactivat: pachetul distribuie deja
binarele native pentru platformele suportate; postinstall-ul informativ protobufjs
este de asemenea dezactivat.

 Scanerele sunt actualizate la Trivy 0.74.0,
Grype 0.119.0 și Scout 1.24.0, cu verificări SHA-256 înainte de extragere.
Caddy este 2.11.4; sidecar-ul egress este compilat cu Go 1.27.1.
Helper-ul privilegiat pentru regulile egress folosește Alpine 3.24.2 în loc de
ramura 3.19 ieșită din suport. Integrarea nftables trebuie verificată în Docker.
`go vet` și cross-build-urile Linux amd64/arm64 au trecut. Sidecar-ul are acum
teste Go pentru politici, metadata, DNS, parsare HTTP/TLS, CONNECT și TCP half-close,
plus fuzzing SNI. Testele folosesc sockets locale, fără acces la infrastructura
  utilizatorului. Race detector este adăugat în CI, încă neexecutat pe runner.
Acțiunile GitHub sunt actualizate și fixate la SHA-ul commit-ului release-ului.

## Lucru rămas și limite de verificare

1. **Build/deploy Docker:** build-ul `production` și build-ul sidecar-ului au
   reușit pe gazda LAN autorizată. Testele Go, inclusiv transportul Unix socket,
   au trecut în Linux. Nu s-a făcut deploy peste serviciile existente.
   Prima scanare a imaginii complete a găsit probleme în instrumentele incluse,
   deși lockfile-ul aplicației era curat; vezi secțiunea de mai jos.
   Actualizarea unei librării npm nu validează automat pachetele Alpine sau
   pluginurile DNS Caddy compilate în altă imagine.
2. **Integrare reală:** LDAP/AD/LDAPS, Redis HA, SMTP, registries și consolele
   providerilor au teste locale/mocked și smoke pentru clientul browser, fără
   canary pe infrastructura utilizatorului. Testul Cloudflare live rămâne omis în absența tokenului; cele două cazuri
   negative offline și testul de unicitate ACME au fost reactivate.
3. **Roadmap:** cele 59 de funcții Partial și batch-urile R1–R8/R10 sunt urmărite în
   [planul activ](../planning/remaining-market-research-implementation-plan.md).
   Adaptoarele provider, execuția backup/DR/network/storage, canary-urile și
   funcțiile dependente de credențiale/licențe nu sunt închise prin acest audit.
4. **Untagged retention:** Distribution nu oferă inventar standard al manifestelor
   fără tag; preset-ul nefuncțional este acum indicat indisponibil. Nu există o
   implementare completă de enumerare/cleanup untagged; necesită adaptor specific.
5. **Secrete istorice:** migrarea LDAP protejează DB-ul curent, nu rescrie backup-uri
   sau copii WAL vechi. Acestea trebuie protejate, iar parola veche rotită la rollout.
   Valoarea de parolă de dezvoltare din `CLAUDE.md` a fost eliminată; istoricul Git
   nu a fost rescris și configurația locală `.env` nu a fost schimbată.
6. **Încredere în infrastructură:** accesul la Docker socket, SSH și operațiile
   administrative rămâne privilegiat prin natura produsului. Acest audit nu poate
   verifica securitatea host-urilor sau garanta absența altor vulnerabilități.
7. **Izolare egress:** lista globală a fost înlocuită cu schema 2 și autorizare
   live per sursă prin Unix socket. Canary-ul Docker a demonstrat izolarea
   containerelor, intersecția politicilor container/stack, revocarea și refuzul
   moștenirii politicii după reutilizarea IP-ului. Rămân de închis regulile
   nftables (IPv6/UDP și excepții private), înlocuirea atomică, rollback-ul și
   atribuirea logurilor. IP-ul sursă presupune o rețea de încredere; nu este
   identitate criptografică. Domeniul de autorizare acoperă o singură gazdă.
8. **Acces Docker LAN:** API-ul de la `192.168.13.20:2375` permite administrarea
   fără autentificare/TLS din rețeaua stației de audit. Pe VPS nu s-a observat
   listener pe 2375/2376. [Constatări și plan de migrare](2026-09-20-docker-access.md).

## Verificări reale Docker și constatări suplimentare

Containerele, rețelele și volumele de test sunt create cu identificatori și etichete
unice, limite CPU/RAM, fără porturi publicate, și șterse după test. Imaginile de
audit și cache-ul de build sunt păstrate momentan pentru continuarea remedierilor.
Nu s-au modificat containerele existente.
`scripts/smoke-egress-isolation.js` folosește codul real, SQLite și inventarul Docker.
A detectat și eroarea la recrearea unei politici șterse logic: constrângerea UNIQUE
rămânea ocupată. Crearea reactivează acum rândul existent cu noua politică, iar
regresia este acoperită în Jest.

`entrypoint.sh` reutilizează acum secretele persistate la restart, exportă explicit
`ENV_FILE`, scrie atomic cu permisiuni 0600 și nu generează copii `.bak` cu secrete.
Valorile dotenv sunt citite ca date, fără executare shell; variabilele explicite
de mediu păstrează prioritatea. Verificarea Linux reproductibilă este în
`scripts/smoke-production-image.js` și în workflow-ul Docker.

Prima imagine scanată: `sha256:8ef8a8215fa96f0211ff02f313f7e2b8e0a70842d25c8ff076a82d47ac1fc112`.
Trivy a raportat 85 de înregistrări (pot exista CVE-uri repetate între binare):
npm — 9, Scout — 47, Grype — 19, Trivy — 10. Cele trei scanere sunt ultimele
release-uri stabile publicate, dar includ versiuni vulnerabile de Go/dependențe.
Nu sunt ascunse prin ignore-list și nu sunt declarate false positives fără analiză
de aplicabilitate. Corecțiile npm sunt implementate; scanerele necesită remediere
suplimentară sau release-uri upstream corectate.

Rescanarea imaginii `sha256:676f71d5a090b29134c0adcf309900be76e9c3cde5260251c4ba5480ed2a04cd`
confirmă eliminarea tuturor celor nouă constatări npm. Rămân **39 High, 25 Medium,
9 Low și 3 Unknown**, exclusiv în cele trei scanere; [inventarul complet](2026-09-20-image-vulnerabilities.json)
include versiunile și remedierile raportate. Acestea sunt detecții la nivel de
modul; aplicabilitatea pe funcțiile efectiv incluse/rulate trebuie analizată,
mai ales pentru advisory-urile serverului Docker prezente în SDK-ul client.
Pornirea aplicației, migrarea SQLite, endpoint-ul health, restartul cu aceleași
secrete, permisiunile 0600, prioritatea mediului și citirea dotenv fără execuție
shell au trecut pe această imagine. Canary-ul egress a trecut toate cele 12 scenarii.

Analiza independentă `govulncheck 1.8.0 -mode=binary -scan=symbol` raportează
6 advisory-uri în Trivy, 19 în Grype și 44 în Scout. Rezultatele includ înregistrări
wildcard pentru pachete, care nu demonstrează prezența unor funcții concrete.
Verificarea suplimentară a tabelei Go pclntab pentru OpenPGP găsește **0 funcții în
Trivy, 0 în Grype și 198 în Scout**. Constatarea GO-2026-5932 necesită tratare
separată pe binar; nu justifică ignorarea globală a advisory-ului.
Rezultatele și hash-urile sunt în [inventarul de simboluri](2026-09-20-scanner-symbols.json).
Prezența unui simbol nu demonstrează exploatabilitate într-un flux concret.
Binarele Grype și Scout sunt compilate cu Go 1.26.3; Scout folosește modulul
`github.com/docker/scout-cli-plugin`, care nu este codul aplicației Docker Dash.
Referințe: [govulncheck](https://go.dev/doc/security/vuln/),
[advisory OpenPGP](https://pkg.go.dev/vuln/GO-2026-5932).
Separat, analiza source `govulncheck` a sidecar-ului propriu, cu Go 1.27.1, nu a
găsit vulnerabilități. Verificarea cu tool-ul fixat la 1.8.0 este adăugată în CI.

Workflow-ul construiește și încarcă imaginea local, verifică pornirea și persistența
secretelor, apoi scanează înainte de autentificarea la registry. Orice constatare
High/Critical/Unknown oprește publicarea. Sunt publicate exact straturile scanate,
fără un al doilea build. Acest gate va bloca release-ul cât timp rămân constatările
de mai sus; workflow-ul modificat nu a fost încă executat pe GitHub.

## Controlul imaginilor înainte de actualizare — 20 septembrie

Safe update și pipeline refuză acum actualizarea dacă scanarea obligatorie nu poate
fi executată sau verificată, ori raportează Critical/High/Unknown. Imaginea este
exportată prin clientul Docker al hostului selectat; configurația raportată de
Trivy este legată criptografic de digestul Docker prin metadatele arhivei OCI.
Recrearea folosește ID-ul verificat, nu tag-ul modificabil. Eșecul scanării nu
oprește și nu șterge containerul existent. Limitele de timp, dimensiune și
concurență se aplică exportului și scanării; fișierele temporare sunt private.

Testul real pe Docker LAN a blocat imaginea aplicației cu 39 High și 3 Unknown
și a acceptat imaginea builder egress fără constatări. Ambele arhive temporare și
containerul propriu de test au fost eliminate. Cele 48 de teste țintite verifică
și metadate alterate, duplicate, lipsă, platforme ambigue, indisponibilitatea
scannerului și păstrarea containerului original la refuz. Suita completă finală
a trecut cu 4.287 teste și unul omis, inclusiv corecțiile de sănătate și permisiuni.
Imaginea finală de test este
`sha256:a577627bbf803c7265e4f17e333cb4005a94ce099011146588f277fa65d2fe2c`.
Pornirea, persistența secretelor și scanarea reală au trecut pe acest build;
constatările scannerelor rămân 39 High, 25 Medium, 9 Low și 3 Unknown.
Testul reproductibil este `scripts/smoke-image-admission.js`, cu ID-urile explicite
`DD_SMOKE_APP_IMAGE`, `DD_ADMISSION_ALLOW_IMAGE` și `DD_ADMISSION_DENY_IMAGE`.
Acesta creează numai propriul controller, apoi îl șterge; imaginile sunt citite.

Ruta generică de acțiuni nu mai interceptează endpoint-urile nominale precum
safe-update. Un container înlocuit care a ieșit, este unhealthy sau nu poate fi
inspectat marchează pipeline-ul ca eșuat. Rămân deschise înlocuirea tranzacțională,
rollback-ul automat și blocarea operațiilor concurente; scanarea nu le rezolvă.

Restricțiile pe stack sunt aplicate și acțiunilor nominale de actualizare,
rollback, pipeline, redenumire, upload și administrare sandbox, precum și inspect.
Operațiile bulk verifică fiecare container; operatorul nu poate ocoli rolul de
administrator prin bulk remove. Upload-ul respectă modul read-only. Erorile la
citirea permisiunilor, rolurile și nivelurile necunoscute refuză accesul.
Aceste schimbări nu reprezintă încă o verificare completă a tuturor rutelor read
și a tuturor serviciilor care execută operații asupra containerelor.

Legătura manifest–config urmează [specificația OCI](https://github.com/opencontainers/image-spec/blob/main/manifest.md).

## Actualizare finală a instrumentelor — 20 septembrie

Scout este exclus temporar, conform opțiunii confirmate de utilizator, cu
[explicații în produs și documentație](2026-09-20-scout-exclusion.md).
Trivy 0.74.0, Grype 0.119.0 și Docker CLI 29.7.2 sunt recompilate cu Go 1.27.1 și
dependențe corectate, cu sufix `+dd.1` și proveniență verificabilă. Compose este
5.5.1, descărcat din release-ul oficial cu verificare SHA-256. Pachetul GNU wget
nu mai este necesar; healthcheck-ul utilizează curl.

[Raportul detaliat](2026-09-20-scanner-rebuild.md) include imaginea validată
`sha256:85bb9f5e662c7877b062a894b1b951590b35a602f0090fada2395e228439cd33`.
Ultima suită completă: 344 suite, 4.291 teste reușite, unul omis. Verificările în
browser, pornirea Linux, Compose, secretele și scanările reale au trecut.

Scanările brute finale: Trivy — 4 High, 3 Medium, 3 Unknown; Grype — 4 High,
6 Medium. Nicio constatare Critical. Aceste rezultate nu înseamnă securizare
completă: zlib CVE-2026-85091 rămâne deschisă, iar constatările Go sunt analizate
separat, fără ignorări globale. Publicarea este blocată de ambele motoare.
Portul Docker LAN 2375 și celelalte elemente deschise ale auditului rămân distincte;
nu au fost închise prin această schimbare și nu s-a făcut deploy.

## Admitere obligatorie cu două motoare — 20 septembrie

Verificarea anterioară cu un singur motor nu era suficientă: builder-ul egress
acceptat de Trivy are o constatare High zlib în Grype. Safe-Pull și etapa Scan din
pipeline cer acum rapoarte valide de la ambele motoare pentru aceeași arhivă
exportată, platformă și configurație legată de ID-ul imuabil al imaginii.
Critical, High sau Unknown în oricare raport blochează înlocuirea. Un scanner
lipsă/eșuat, un raport filtrat sau nevalid și o bază Grype invalidă/mai veche de
120 de ore refuză admiterea. Quick Deploy rămâne un override explicit care sare
scanarea și verificarea; interfața explică acest lucru.

Configurațiile private și eliminarea variabilelor TRIVY_/GRYPE_/SYFT_ previn
moștenirea filtrelor externe. Grype folosește exclusiv furnizorii de arhive
Docker/OCI, fără rezolvarea unui tag prin daemon sau registry. Execuția este
secvențială, cu trei minute per scanner, opt minute total și cel mult două
admiteri simultane. Totalurile agregate numără constatări ale scannerelor, nu
vulnerabilități unice; aceeași problemă poate apărea în ambele rapoarte.

[Dovezile testului real](2026-09-20-dual-image-admission.json) includ:

- vechea imagine a aplicației: refuzată de ambele motoare;
- un control scratch cu proxy-ul Go 1.27.1: acceptat, zero constatări în ambele;
- builder-ul egress: Trivy zero, Grype 1 High și 3 Medium, admitere refuzată.

Controller-ul verificat a fost
`sha256:dc9c89e982d53bf5a0cf074925fd4146acd4efd1e904b73b45011f59913d8ef6`.
Arhivele temporare și controller-ul au fost șterse; containerele existente nu au
fost modificate. Suita completă: 344 suite, 4.324 teste trecute, unul omis;
77 de teste țintite acoperă admiterea și integrarea deploy-ului. Ulterior au fost
corectate numai explicații în interfață și documentație. Build-ul rezultat,
`sha256:48be023784e80e1a27dc54ff8e52ba7f17c1f744b2f5d0e7021bde723f5b3a7f`,
a trecut pornirea Linux, migrarea SQLite, healthcheck-ul curl, Compose și
persistența/precedența secretelor. [Verificarea scannerelor și CLI-ului instalat](2026-09-20-dual-image-scanners.json)
confirmă hash-urile de proveniență și absența Scout. Scanările reale ale acestui
build raportează în continuare Trivy 4 High / 3 Medium / 3 Unknown și Grype
4 High / 6 Medium, fără Critical. Build-ul rămâne nepublicabil; nu s-a făcut deploy.

Pentru reproducerea celor trei scenarii, scriptul
`scripts/smoke-image-admission.js` primește ID-uri imuabile în
`DD_SMOKE_APP_IMAGE`, `DD_ADMISSION_ALLOW_IMAGE`, `DD_ADMISSION_DENY_IMAGE`
și `DD_ADMISSION_DISAGREEMENT_IMAGE`, plus `DD_SMOKE_DOCKER_URL` pentru host.
Acest control nu închide zlib, accesul Docker 2375, rollback-ul tranzacțional,
concurența operațiilor sau celelalte elemente deschise ale auditului.

Configurația este verificată față de
[documentația Grype](https://oss.anchore.com/docs/reference/grype/configuration/)
și sursa versiunii 0.119.0 folosită în build.

## Restricții pe rutele de citire ale containerelor — 20 septembrie

Rutele nominale pentru izolare, statistici, export, previzualizare deploy,
diagnosticare, dependențe, fișiere, diff, istoric și metadate verifică acum dreptul
de vizualizare pe stack înainte de citire. Statusul pipeline-ului verifică și
hostul și ID-ul canonic al containerului original; un ID de execuție aparținând
altui container sau host primește 404. Pipeline-urile noi păstrează ID-ul canonic,
inclusiv atunci când sunt lansate folosind numele containerului.

Statusul individual cere containerul original existent și ID exact; rândurile
istorice cu ID scurt nu sunt acceptate de acest endpoint. Istoricul după înlocuire
rămâne pe ruta separată de istoric. Cele 59 de teste țintite pentru deploy, acces
și izolare includ refuzul a 16 rute de citire, ID-uri de execuție nevalide,
execuții de pe alt host/container și accesul permis la execuția corectă.
O inspecție de autorizare indisponibilă refuză accesul cu 503 fără detalii de
conexiune; un container lipsă primește 404.

Rollback-ul verifică acum apartenența istoricului la containerul și hostul curent
înainte de citirea imaginii ori oprire. Refuză auto-rollback-ul Docker Dash,
snapshot-urile JSON invalide și restaurarea de către operator a unui stack
istoric interzis sau a unei configurații istorice absente. Istoricul returnat
clientului omite snapshot-ul cu variabile de mediu și mount-uri; copia necesară
rollback-ului rămâne în baza de date. Criptarea și retenția acestor snapshot-uri,
precum și restaurarea tranzacțională, rămân deschise.

Verificarea completă după corecțiile de acces și rollback a trecut: 344 suite,
4.359 teste reușite, unul omis. Lint-ul, sintaxa fișierelor modificate și
`git diff --check` au trecut.

Aceste schimbări sunt ulterioare build-ului Docker de mai sus.
Listele globale, graful de dependențe,
reutilizarea numelor în istoric și celelalte servicii necesită în continuare audit;
nu le declarăm securizate prin aplicarea acestui middleware.

## Identitatea serverelor SSH — 20 septembrie

[Raportul SSH](2026-09-20-ssh-host-identity.md) documentează verificarea obligatorie
a cheii serverului înainte de autentificare în toate conexiunile SSH2 identificate:
Docker, distribuirea cheilor, ESXi, Xen, migrarea Proxmox și distribuirea secretelor.
Formularele includ amprenta și explicația în română/engleză. Configurațiile vechi
fără amprentă refuză conectarea; nu există încredere automată în prima cheie primită.
Git folosește OpenSSH separat; corecția sa ulterioară este descrisă în secțiunea următoare.

Testele cu server SSH local real confirmă că serverul cu altă cheie nu primește
autentificarea. [Verificarea read-only pe LAN și VPS](2026-09-20-ssh-host-identity.json)
a folosit cheia utilizatorului curent și identitățile deja existente în
`known_hosts`: conectare corectă și respingerea amprentei greșite pe ambele hosturi.
Nu s-a modificat configurația hosturilor.

Scriptul temporar de distribuire a secretelor este acum creat exclusiv cu 0600,
iar fragmentele sale nu mai sunt copiate în audit. Endpoint-ul respectă read-only,
decriptează configurația SSH salvată și limitează output-ul. Curățarea completă la
întreruperi și istoricul audit care conținea deja fragmente rămân de revizuit.

Validare: 347 suite, 4.399 teste reușite, unul omis; lint, formulare în browser și
help trecute. Imaginea
`sha256:d56b32a9f1434a024472b40d02893f57920b7d31f7834671cc236aba6742e396`
a trecut pornirea Linux, SQLite, Compose, healthcheck și persistența secretelor.
Nu s-a publicat și nu s-a făcut deploy. Problemele zlib, Docker 2375, Git SSH,
TLS provider, rollback tranzacțional și restul auditului rămân distincte.

## Identitatea serverelor Git SSH — 20 septembrie

[Raportul Git SSH](2026-09-20-git-ssh-trust.md) documentează eliminarea verificării
dezactivate din operațiile Git. Migrarea 175 adaugă cheile de server `known_hosts`
în credentialele SSH, iar formularele explică cerința în română și engleză.
Credentialele existente fără aceste chei refuză conectarea până la configurare.
Toate operațiile folosesc sesiuni temporare separate și cleanup la final.

Testele cu Git/OpenSSH reale au trecut pentru clone, preview, fetch, diff/status,
push și pull. Cheile greșite și serverele necunoscute sunt refuzate înainte de
autentificare. Testul Linux din imaginea
`sha256:1f7025370c93018ee8b715bc67fda5ef155c8c0064890273a54511ea061684cd`
a trecut verificarea SSH, pornirea, SQLite, Compose și persistența secretelor.
Validarea completă: 348 suite, 4.417 teste reușite, unul omis; lint și browser EN/RO
trecute. Nu s-a publicat și nu s-a făcut deploy. Scanarea imaginii anterioare nu
este atribuită acestui build; celelalte probleme deschise rămân în audit.

## Verificarea TLS a providerilor — 20 septembrie

[Raportul TLS](2026-09-20-provider-tls.md) documentează verificarea obligatorie
HTTPS pentru Incus/LXD, Proxmox, vSphere, Kubernetes, Nomad, Xen Orchestra și XAPI.
Formularele acceptă CA-uri private verificate și explică migrarea configurațiilor
vechi. Conexiunile cu `skipTlsVerify: true` și endpoint-urile HTTP sunt refuzate;
Unix local și raw-Xen SSH rămân disponibile. Exportul kubeconfig păstrează
verificarea TLS și serializează sigur valorile YAML.

Serverele HTTPS de test reale confirmă refuzul înainte de orice cerere HTTP
pentru CA absent/greșit, certificat expirat sau nume greșit. mTLS Incus/LXD,
persistența configurației și formularele EN/RO au trecut. Validarea completă:
349 suite, 4.482 teste reușite, unul omis; lint, sintaxă și help trecute.
Imaginea `sha256:ee5bde868cec4a76c23ffbea93b452204de0920fdaea8726e4b6c24cea50a428` a trecut testele Linux de pornire, Git SSH, mTLS și persistență.
Nu s-a publicat sau făcut deploy. Rămâne necesară verificarea pe instalații reale
de provideri; problemele zlib, Docker 2375, alte integrări TLS și snapshot-urile
istorice sunt încă deschise.

## LDAP cu TLS verificat — 20 septembrie

[Raportul LDAP](2026-09-20-ldap-tls.md) documenteaza LDAPS si StartTLS obligatoriu,
refuzul bypass-ului, verificarea CA/numelui/valabilitatii inainte de bind si blocarea
reconectarii necriptate. Negocierea are termen total de cinci secunde, inclusiv
pentru date trimise lent. Formularul si ghidul EN/RO explica migrarea si CA-ul privat.

Validare: 351 suite, 4.519 teste reusite, unul omis; lint, browser si help trecute.
Imaginea `sha256:53b54c7d2d3aefee35fa536cfc68502e03d9e21f6ae77b4ac5797c07c6ca7126`
a trecut testele Linux LDAP, Git SSH, mTLS, SQLite, Compose si restart. Serverele
LDAP izolate verifica protocolul real; integrarea completa cu AD/OpenLDAP ramane
deschisa. Nu s-a publicat sau facut deploy si nu se atribuie acestui build o
scanare efectuata pe alta imagine. Celelalte constatari ale auditului raman active.

## Criptarea istoricului de rollback — 20 septembrie

[Raportul snapshot-urilor](2026-09-20-rollback-snapshot-encryption.md) documenteaza
migrarea 176 si criptarea autentificata a configuratiilor istorice, legata de
host/container/imagine. Update, safe update, pipeline si rollback opresc modificarea
containerului daca salvarea criptata esueaza. Snapshot-urile corupte, cheia gresita
si mutarea datelor in alt context sunt refuzate. API-ul nu expune configuratia.
Au fost corectate si escaparea metadatelor din dialog si ghilimelele in helperul
HTML comun; ghidul EN/RO explica recuperarea cheii si limitele backup-urilor.

Validare: 352 suite, 4.550 teste reusite, unul omis; lint, help si verificarile
browser trecute. Imaginea
`sha256:b21e40cf15e9548154310f82704fe6fe1ad81abfb640cadaf5c1f445e3dc2979`
a trecut migrarea Linux si recuperarea dupa restart. Backup-urile/WAL vechi,
retentia istoricului si inlocuirea tranzactionala raman deschise. Nu s-a publicat
sau facut deploy peste serviciile existente.

Scanarile noi sunt legate de acest ID exact: Trivy raporteaza 4 High / 3 Medium /
3 Unknown, Grype 4 High / 6 Medium, fara Critical. zlib 1.3.2-r0 ramane semnalat
cu `CVE-2026-85091`. Publicarea ramane blocata; nu au fost introduse exceptii globale.
[Rezultatele si hash-urile rapoartelor](2026-09-20-rollback-snapshot-encryption.json)
completeaza dovezile de test, fara sa echivaleze cu securizarea integrala.

## Reproducere

```sh
npm ci
npm run check:vendor
npm run check:browser
npm run check:inventory-browser
npm run check:syntax
npm run lint
npm test -- --runInBand
npm run audit:dependencies
npm run check:self-service-i18n
npm run check:self-service-a11y
npm run check:virtualization-research
npm run check:page-help
```

Referințe: [Node LTS](https://nodejs.org/en/about/previous-releases),
[Nodemailer changelog](https://github.com/nodemailer/nodemailer/blob/master/CHANGELOG.md),
[ioredis 6](https://github.com/redis/ioredis/releases/tag/v6.0.0),
[noVNC](https://github.com/novnc/noVNC/releases),
[OSV](https://github.com/google/osv-scanner/releases/tag/v2.6.0).
Pentru migrarea editorului: [CodeMirror 6](https://codemirror.net/docs/migration/).
Pentru pin-ul IPv6 metadata: [AWS IMDS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html).
