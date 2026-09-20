# Checkpoint 8.96.2: Git si deploy LAN/VPS

Utilizatorul a autorizat commit/push si deploy periodic pe cele doua instalari,
la etape verificate ale auditului. Nu este un job automat la interval fix.

## Cod si imagine

- Branch: `agent/advanced-compose-gitops`.
- Commit: `36fa8e66d2f084ed9a8bf166350ee8f8cff067fd`, urcat pe origin.
- Versiune: `8.96.2`; changelog si pagina What's New actualizate.
- Imagine: `docker-dash:8.96.2-audit-36fa8e6`.
- ID: `sha256:41eb39119c9ef7557e4a5c9643403df2f17213f95fee51477db0e1e234e82395`.
- Build production cu eticheta OCI pentru commit; aceeasi imagine transferata
  prin SSH pe VPS si verificata dupa incarcare. Fara push de imagine in registrul
  public si fara dezactivarea pragurilor CI de vulnerabilitati.

Codul functional al auditului a trecut 352 suite / 4.550 teste, cu un test live
omis. Metadatele versiunii si Compose au fost verificate separat dupa bump;
lint a trecut. Imaginea noua a trecut smoke-ul Linux pentru startup, SQLite,
LDAP, Git SSH, mTLS, rollback criptat si pastrarea secretelor dupa restart.

## Procedura pe host

Pregatirea verifica configuratia Compose efectiva fata de containerul existent.
Se pastreaza variabilele aplicatiei, volumele de date, porturile si retelele.
Doar versiunea, imaginea, modul production, comanda si healthcheck-ul sunt
inlocuite. Sursa montata peste `/app/src` si `/app/public` pe VPS este eliminata
din noua configuratie efectiva; noul container foloseste codul din imagine.

Inainte de inlocuire se opreste aplicatia si se salveaza o copie SQLite consistenta,
plus fisierele de configuratie pentru recuperare. Backup-urile sunt private,
cu fisiere mode 0600 si director mode 0700. Contin date si secrete de productie;
nu sunt incluse in Git. Baza LAN are aproximativ 4 GB; verificarea hash-ului
citeste incremental, cu memoria containerului auxiliar limitata la 512 MiB.
O prima incercare nereusita de verificare a backup-ului a repornit versiunea veche
inainte de reluarea procedurii.

Un override Compose per checkpoint fixeaza imaginea si foloseste volumele existente
prin numele lor externe. Verificarea finala cere health HTTP/Docker, versiunea si
ID-ul imaginii, aceleasi chei, `.env` neschimbat, utilizatori/hosturi pastrate si
migrarea 176 aplicata. Inlocuirea celorlalte servicii nu face parte din acest deploy.

## Evidenta finala

Ambele instalari au trecut verificarile Docker si HTTP, inclusiv accesul din
statia de lucru, si ruleaza exact imaginea de mai sus. [Evidenta JSON](2026-09-20-checkpoint-deployment.json)
include containerele, commitul, migrarea, hash-urile backup-urilor si configuratia Compose efectiva.

| Host | Versiune | Health | Utilizatori / hosturi salvate | Backup DB |
| --- | --- | --- | --- | --- |
| LAN 192.168.13.20 | 8.96.2 | ok / healthy | 5 / 7 | 3.942.309.888 bytes |
| VPS 89.37.212.66 | 8.96.2 | ok / healthy | 2 / 1 | 615.849.984 bytes |

Cheile si fisierele `.env` au ramas neschimbate. Migrarea 176 este aplicata pe
ambele baze. Accesul aplicatiei la Docker local a fost verificat: 148 containere
pe LAN si 89 pe VPS. Nu mai exista bind mount-uri de sursa peste `/app`.

Pe VPS, SQLite a avut nevoie sa refaca indexul WAL; deschiderea volumului read-only
nu a permis aceasta operatie. Procedura a repornit aplicatia veche, apoi a reluat
backup-ul folosind o copie privata a bazei si WAL-ului, cu aplicatia oprita.
Validarea si deploy-ul ulterior au trecut. Backup-ul verificat nu necesita
modificarea volumului de productie. Un probe HTTP extern a expirat temporar;
reverificarea ambelor adrese si verificarile locale au returnat HTTP 200 / 8.96.2.

## Limite si urmatoarele checkpoint-uri

Constatarile imaginii raman in audit, inclusiv zlib si diferentele de potrivire
ale advisory-urilor Go. Deploy-ul autorizat pe aceste doua instalari nu echivaleaza
cu trecerea pragului pentru publicarea generala a imaginii. API-ul Docker LAN 2375
nu a fost reconfigurat si daemonul nu a fost repornit.

Preflight-ul LAN a gasit deja credentale SSH/provider imposibil de decriptat
pentru hosturile 2, 4, 5, 6, 7 si 8. Datele sunt pastrate; actualizarea aplicatiei
nu recupereaza cheia veche si nu inventeaza alte credentiale. VPS are doar hostul
Docker local. Nu exista configuratie LDAP sau credentiale Git salvate pe aceste
doua instalari la preflight.

Pentru urmatorul deploy se citesc fisierele Compose din eticheta containerului
curent, inclusiv override-ul acestui checkpoint. Rularea numai a vechiului Compose
de baza ar selecta din nou imaginea veche. Se pastreaza un backup verificat si
imaginea precedenta pana la stabilizarea noii versiuni; copiile mai vechi se trateaza
conform politicii de retentie, fara a sterge automat datele utilizatorului.
