# Chei API personale: expirare, politica parolei si revocare

Checkpoint de sursa dupa `f246228`, cu migrarea 182. Imaginea 8.96.9 construita
anterior nu include modificarile; instantele LAN/VPS raman pe 8.96.8.

## Probleme si corectii

Cinci regresii au esuat pe implementarea anterioara: trei expirari invalide erau
acceptate, obligatia schimbarii parolei putea fi ocolita prin cheie API, iar o
cheie putea emite alte chei. Validarea refuza acum expirarea neinterpretabila sau
depasita prin comparatia SQLite UTC. Cheile istorice fara expirare raman acceptate.
Permisiunile persistate trebuie sa fie o lista ne-goala cu read, write sau *;
JSON invalid sau alte valori refuza autentificarea fara actualizarea last_used_at.

Emiterea valideaza numele, permisiunile si o expirare ISO viitoare cu fus orar,
inclusiv data calendaristica. Omisiunea/null pastreaza optiunea fara expirare.
Contul activ si politica parolei sunt verificate in aceeasi tranzactie de scriere
cu emiterea. Ruta cuprinde si auditul in tranzactie: un audit esuat nu lasa cheia
activa. Administrarea necesita autentificare de utilizator (sesiune sau proxy
SSO de incredere); cheile API si tokenurile de serviciu nu pot emite/revoca chei.
Modul read-only blocheaza ambele mutatii. Revocarea este limitata la proprietar;
un identificator strain/inactiv raspunde 404. Revocarea se comite inainte de audit:
daca acesta esueaza, raspunsul este 500, dar cheia ramane revocata.

Cheile si sesiunile folosesc aceeasi politica pentru schimbarea obligatorie si
vechimea parolei locale. Timestamp-urile SQLite fara fus sunt interpretate UTC;
absenta password_changed_at foloseste crearea contului. Metadatele invalide sau
cu peste un minut in viitor cer schimbarea parolei cand politica de vechime este
activa. Conturile externe nu primesc limita parolelor locale, dar respecta un flag
explicit de schimbare obligatorie. Politica nu reprezinta o verificare MFA noua
la fiecare apel API.

Migrarea 182 revoca permanent cheile la modificarea reala a parolei, sursei de
autentificare, activarii contului sau identitatii externe. Backfill-ul revoca
cheile conturilor inactive si sso_legacy. Reactivarea contului ori revenirea
migrarii nu reactiveaza cheile. Automatizarile trebuie configurate cu chei noi
dupa o astfel de schimbare. Schimbarile istorice de parola nu pot fi reconstruite;
nu pretindem revocarea retroactiva a tuturor cheilor potential vechi.

## Verificari si limite

- 39 teste focalizate: expirare, permisiuni invalide, politica parolei, izolarea
  proprietarului, backfill, revocare persistenta, read-only si esecuri de audit.
- Suita completa: 375 suite, 5.021 teste trecute, unul omis; lint fara erori si
  verificarea help-ului pentru toate cele 60 de pagini trecuta.
- 37 verificari native pe fiecare host, cu SQLite si HTTP reale. Cele patru noi
  verifica expirari, restrictii de administrare, UTC in trei fusuri de proces si
  audit/revocare la schimbarea parolei. Providerul si SMTP sunt simulate; reteaua
  externa a containerelor este dezactivata. Resursele proprii sunt eliminate.
- Sursele sunt suprapuse si verificate SHA-256 peste imaginea candidata existenta,
  nu este o imagine noua publicata. Rezultatele suitei complete, lint si impactul
  agregat din instantele live sunt in JSON-ul alaturat. Nu sunt exportate chei,
  hashuri de parole, nume de conturi sau emailuri.
- Loguri locale: `.git/api-key-{before,focused,full-tests,lint}.log` si
  `.git/api-key-native-{lan,vps}.log`.

Citirea agregata live din 20 septembrie, 09:36 UTC, a gasit zero chei API personale
pe ambele instante si politica passwordMaxAgeDays=0. Endpointurile publice de
health au raspuns HTTP 200, status ok, versiunea 8.96.8. Aceasta observatie nu
exclude emiterea unor chei ulterior; preflight-ul trebuie repetat la deploy.

Validarea unei cereri nu anuleaza operatiuni deja incepute. Tokenurile independente
de serviciu au un ciclu de viata separat. Reteaua Docker LAN 2375 si constatarile
imaginii documentate anterior raman deschise. Deploy-ul necesita reconstruirea
imaginii, verificarea migrarii din schema live si URL-urile publice pentru email,
solicitate deja utilizatorului. Help-ul Settings EN/RO descrie impactul cheilor.
