# Git SSH: verificarea obligatorie a serverului

Audit si validare: 20 septembrie 2026. Modificarile sunt locale, fara publicare
sau deploy al aplicatiei existente.

## Corectie

Au fost eliminate toate cele patru configurari OpenSSH care foloseau
`StrictHostKeyChecking=no` si `UserKnownHostsFile=/dev/null`. Credentialele Git
SSH contin acum intrari `known_hosts` verificate, persistate prin migrarea 175.
Conectarea necesita atat cheia privata administrata de aplicatie, cat si cheile
publice ale serverului. Credentialele vechi raman editabile, dar nu se conecteaza
pana cand administratorul adauga identitatea verificata a serverului.

Formularele de creare/editare explica cerinta in romana si engleza. Actualizarea
`known_hosts` pastreaza cheia privata criptata existenta. Lista credentialelor
expune cheile publice ale serverului, fara cheia privata. Intrarea este limitata
la 64 KiB si 128 de inregistrari; cheile publice sunt decodate si validate.
Sunt acceptate nume exacte, `[host]:port`, adrese IP si nume OpenSSH hash-uite;
nu sunt acceptate wildcard-uri sau marcaje de incredere extinsa.

Fiecare operatie foloseste un director temporar distinct 0700 si fisiere create
exclusiv cu 0600. Cleanup-ul ruleaza in `finally`, inclusiv pentru probe, clone,
preview, fetch/pull, diff/status, push si rollback. Certificatele CA temporare
folosesc acelasi mecanism. Cheile vechi `repos/.ssh-keys/key-<id>` si `key-test`
sunt eliminate la pornire, fara a urmari un director simbolic sau a sterge alte
nume de fisiere. O oprire brutala a procesului poate lasa directorul temporar
0700 pana la curatarea sistemului; nu pretindem stergere garantata dupa SIGKILL.

OpenSSH foloseste verificare stricta, numai fisierul de incredere configurat,
fara agent, parole, configuratie SSH a utilizatorului/sistemului sau acceptare
si actualizare automata a cheilor. Variabilele Git/SSH mostenite sunt eliminate,
iar configuratia Git globala este dezactivata. Operatiile HTTPS fara credential
SSH nu pot prelua identitatea implicita a utilizatorului printr-o rescriere URL.
Identitatea committer-ului aplicatiei este explicita, astfel incat push-ul nu
depinde de configuratia Git globala a hostului.

Versiunea actualizata simple-git blocheaza implicit variabilele cu comenzi SSH
si cai de configurare. Sunt permise explicit doar aceste doua categorii pentru
comanda generata de aplicatie si configuratia globala `/dev/null`; celelalte
protectii simple-git raman active. Comanda nu este furnizata de utilizator.

## Validare

- 348 suite Jest trecute, 4.417 teste reusite, unul omis. Lint si verificarea
  whitespace trecute; toate cele 60 de pagini au help.
- 18 teste dedicate: baza SQLite reala, conservarea cheii private, validarea
  intrarilor, izolarea sesiunilor concurente si transport Git/OpenSSH real.
- Repository temporar real: clone, preview, fetch, diff/status, push si pull.
  Doar etapa de deploy Docker este simulata; transportul Git nu este simulat.
- Cheie gresita sau server necunoscut: refuz inainte de autentificare.
  Verificari suplimentare pentru cleanup dupa eroare si cai cu spatii/apostrofuri.
- Browser real cu CSP, romana/engleza: creare, editare fara inlocuirea cheii
  private, refuzul campului gol si escaparea continutului.
- Imagine Linux construita pe Docker LAN:
  `sha256:1f7025370c93018ee8b715bc67fda5ef155c8c0064890273a54511ea061684cd`.
  Pornire, migrari SQLite, Compose, healthcheck si persistenta secretelor trecute.
  Git/OpenSSH din aceasta imagine au confirmat identitatea serverului, refuzul
  cheii gresite inainte de autentificare, permisiunile 0700/0600 si cleanup-ul.
  Containerul temporar, fara socket Docker, porturi publicate sau retea externa,
  a fost eliminat dupa test.

Comenzi de reproducere:

```sh
npx jest --runInBand --testPathPatterns=git
node scripts/check-git-ssh-browser.js
npm run lint
npm test -- --runInBand
DD_SMOKE_APP_IMAGE=<immutable-image-id> node scripts/smoke-production-image.js
```

## Limite ramase

Acest rezultat nu certifica securitatea integrala a produsului sau imaginii.
Imaginea noua a trecut testele functionale de mai sus; scanarea duala publicata
anterior are alt ID de imagine si nu este prezentata ca scanare a acestui build.
Problemele zlib, API Docker neautentificat pe LAN, TLS provider, snapshot-uri
istorice si tranzactiile de actualizare/rollback raman deschise separat.
Exceptiile TLS configurabile ale repository-urilor nu sunt eliminate aici.

Surse primare: [OpenSSH StrictHostKeyChecking](https://man.openbsd.org/ssh_config#StrictHostKeyChecking),
[Git GIT_SSH_COMMAND](https://git-scm.com/docs/git#Documentation/git.txt-codeGITSSHCOMMANDcode).
