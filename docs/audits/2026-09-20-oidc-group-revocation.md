# OIDC: grupuri complete si revocarea credentialelor

Status: corectie in sursa dupa `10bedb4`, fara migrare noua. Imaginea 8.96.9
construita anterior nu o include; LAN si VPS nu au fost redeployate in acest checkpoint.

## Defecte demonstrate

Doua teste de regresie au esuat pe sursa initiala: grupurile explicit goale pastrau
rolul admin, iar lipsa grupurilor permitea crearea contului si emiterea sesiunii
chiar daca maparea era configurata. Regula introdusa anterior pentru evitarea
retrogradarilor la erori de provider pastra astfel drepturi care nu mai erau sustinute
de informatia disponibila la conectare.

## Regula aplicata

Cu cel putin o lista de mapare configurata, claim-ul trebuie sa fie complet: array
de string-uri ne-goale sau un string ne-gol. Array-ul gol este valid si inseamna
niciun grup; se aplica `OIDC_DEFAULT_ROLE`, implicit viewer. Un rol implicit admin
configurat explicit ramane o decizie privilegiata a administratorului, nu este
rescris automat de aceasta corectie. Configurarea rolului implicit trebuie revizuita.

Valorile absente, null, obiectele, array-urile cu valori amestecate, string-urile
goale/albe, caracterele de control si indicatoarele de grupuri incomplete refuza
conectarea. Parserul limiteaza lista la 10.000 elemente si fiecare nume la 512
caractere. Nu converteste valori numerice/obiecte in nume de grup. `_claim_names`
pentru claim-ul folosit si `hasgroups=true` pentru claim-ul standard groups sunt
incomplete. O depasire a grupurilor nu invalideaza un claim roles separat si complet.

La refuz, contul deja asociat exact acelui issuer/subject pierde sesiunile, cheile
API personale, provocarile MFA si linkurile de resetare neconsumate. Niciun cont
nou nu este creat. Rolul stocat ramane pentru analiza; nu este emis un nou credential.
Schimbarea unui rol mapat revoca aceleasi credentiale inainte de aplicarea rolului
si de emiterea unei sesiuni noi. Conturile altui issuer sau subject nu sunt afectate.

La grupuri invalide, revocarea are o tranzactie independenta, comisa inainte de audit.
La schimbarea rolului, citirea rolului curent si revocarea sunt sub aceeasi blocare
SQLite `BEGIN IMMEDIATE`. Un savepoint contine noile acordari de drepturi si sesiunea:
esecul lor este prins in tranzactia exterioara, care poate comite revocarea chiar daca
savepoint-ul a revenit la starea anterioara. Nu exista o fereastra de scriere intre
citirea rolului si revocare. Un esec al auditului, schimbarii rolului sau sesiunii
refuza conectarea si nu poate readuce credentialele vechi prin rollback. Daca
auditul revocarii nu se poate salva, raspunsul este 500 si revocarea deja comisa
ramane activa; nu pretindem existenta unui eveniment de audit care nu s-a scris.
O eroare a tranzactiei de revocare refuza conectarea, fara garantii ca stocarea
defecta a reusit sa invalideze credentialele existente.

Dupa corectarea claim-urilor, utilizatorul reia conectarea si creeaza explicit alte
chei API daca sunt necesare. Credentialele revocate nu sunt reactivate. Fara mapare
de grupuri, rolurile administrate local raman aplicabile. Ghidul OIDC, politica de
securitate si help-ul Settings EN/RO descriu noua regula si impactul operational.

## Verificari

- Doua esecuri de regresie pe codul anterior, apoi teste pentru lista goala, claim
  lipsa/null/invalid/incomplet, recuperare dupa corectie fara reactivarea cheilor,
  configuratie fara mapare, esec de audit la refuz si retrogradare, namespace exact,
  golirea MFA/reset si claim roles complet cu overage pentru groups.
- O regresie suplimentara a demonstrat cursa din prima implementare: o modificare
  comisa chiar inaintea tranzactiei lasa cheile vechi active. Testul trece dupa mutarea
  verificarii rolului sub blocarea de scriere. Prima suita completa trecuse, dar aceasta
  dovada a justificat corectia si rerularea suitei/canariilor pe sursa finala.
- 24 cazuri noi, fara eliminarea vreunui test existent. Suita finala: **374 suite,
  4.982 teste trecute, unul omis**, lint trecut si help 60/60. Verificarea npm
  proaspata: zero pachete outdated si zero vulnerabilitati raportate pentru
  dependentele proiectului; constatarile imaginii raman separate. Dovezile sunt
  in JSON-ul alaturat si in logurile locale.
- 33 verificari native pe fiecare host, dintre care patru noi: retrogradare din lista
  goala, refuz pentru grupuri lipsa, revocare persistenta la esec de audit si rollback
  al sesiunii/rolului fara anularea revocarii.
  Canarii folosesc SQLite, HTTP si RSA reale, provider/SMTP simulate, reteaua externa
  dezactivata si containere temporare proprii. Sursele sunt suprapuse si verificate
  SHA-256 peste imaginea 8.96.9 existenta; nu reprezinta o imagine noua publicata.
  Containerele proprii sunt eliminate dupa test.
- Loguri finale: `.git/oidc-role-before.log`, `oidc-role-race-before.log`,
  `oidc-role-full-tests-final.log`, `oidc-role-lint-final.log` si
  `oidc-role-native-{lan,vps}-final.log`, toate sub `.git/`.

## Limite

Grupurile sunt observate la urmatoarea conectare verificata. Nu exista aici polling
continuu, notificari de la provider sau back-channel logout; o revocare neobservata
la IdP nu inchide instantaneu sesiunile existente. Tokenurile independente de serviciu
si workload, create pentru alti principali, nu sunt chei API personale si nu sunt
revocate in acest flux. Lucrarile deja acceptate si comenzile remote nu sunt anulate.
Un provider compromis sau o configuratie care acorda explicit admin nu este remediat
de parser. Rezolvarea grupurilor prin Microsoft Graph, testarea unui tenant real si
validarea infrastructurii HA raman deschise, la fel ca problemele imaginii si LAN 2375.

Microsoft documenteaza [omiterea listei si indicatorii de overage](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference).
Acesta este motivul pentru care un indicator de grupuri incomplete nu este tratat
drept lista goala sau dovada ca rolul anterior poate fi pastrat pentru conectare.
