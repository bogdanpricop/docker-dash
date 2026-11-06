# SCIM: autorizare si limitele resurselor administrate

Checkpoint de sursa dupa `37d4686`, fara migrare noua. Imaginea 8.96.10 pregatita
anterior nu include aceasta corectie; instantele live raman pe 8.96.8.

## Probleme demonstrate

Patru regresii au esuat pe codul anterior. Un viewer sau operator autentificat
putea modifica un cont local prin SCIM, inclusiv dezactiva un administrator.
Serviciul permitea si preluarea unui utilizator local sau a unei echipe locale
prin replace. Verificarea scope-ului returna succes pentru orice identitate care
nu era token de serviciu, iar rutele nu verificau separat rolul utilizatorului.

## Reguli aplicate

Rutele SCIM necesita token global de serviciu cu scope explicit scim.read sau
scim.write, conform feature-spec-ului V4.6b. Sesiunile utilizatorilor, inclusiv
administratorii, cheile API personale si scope-urile generice api.read/api.write
nu substituie credentialul SCIM. Flag-ul governance si politica read-only raman
obligatorii. Specificatia: docs/planning/virtualization-platform/V4.6b-identity-policy-governance-feature-spec.md.

Un token cu tenantId este refuzat: modelul SCIM actual are utilizatori/echipe
globale si nu poate garanta izolarea tenantului. Aceasta nu implementeaza SCIM
multi-tenant si nu reprezinta o dovada ca toate celelalte API-uri aplica tenantId.

Listele si accesul individual includ numai resurse cu mapping SCIM; utilizatorii
trebuie sa aiba si auth_source=scim. Un mapping ramas dupa schimbarea sursei de
autentificare nu permite recapturarea contului. Resursele neadministrate raspund
404. Grupurile pot contine numai utilizatori SCIM; modificarea esuata nu sterge
membrii existenti. Stergerea unui grup elimina si mapping-ul, pentru a nu lasa
proprietate reziduala asupra unui identificator reutilizat.

Mutatiile serviciului folosesc o tranzactie de scriere imediata de la citirea
starii curente pana la salvarea resursei si mapping-ului. Astfel, duplicatele de
externalId nu lasa conturi create partial. Rutele includ auditul in tranzactie,
cu actiunile scim_user_* si scim_group_*, actorul si identificatorul tokenului de
serviciu, fara corpul cererii sau secrete. Daca auditul esueaza, operatia raspunde
500 si toate modificarile sunt anulate, inclusiv dezactivarea ceruta; clientul
trebuie sa trateze operatia ca nereusita si sa o reia dupa remediere. Nu pretindem
o revocare comisa cand tranzactia a revenit la starea anterioara.

## Verificari

Suita finala: 377 suite, 5.075 teste trecute, unul omis; 23 teste noi. Lint trecut,
help 60/60, iar fiecare host a trecut toate cele 46 de verificari native. Nu sunt
eliminate teste existente pentru a obtine aceste rezultate.

- Teste HTTP reale pentru viewer/operator, scope read-only, tenantId, resurse
  locale, provisioning autorizat si audit, read-only global si rollback la esec.
- Verificari de serviciu pentru membri locali, mapping stale, externalId duplicat
  si eliminarea proprietatii grupurilor. Dezactivarea unui utilizator SCIM revoca
  sesiunea si cheia API prin trigger-ele deja introduse.
- Trei canarii noi pe LAN/VPS: viewer nu poate dezactiva administratorul; limita
  resurselor administrate; provisioning si audit atomic. Se folosesc SQLite/HTTP
  reale, fara date live. Canariile ruleaza surse suprapuse verificate SHA-256 pe
  imaginea 8.96.10; nu reprezinta un deploy sau o imagine reconstruita.
- Loguri locale `.git/scim-security-before.log`, `scim-security-focused.log`,
  `scim-security-full-tests-final.log`, `scim-security-lint-final.log` si
  `scim-security-native-{lan,vps}-final.log`, toate sub `.git/`.
  Rezultatele finale sunt in JSON.

Citirea agregata live din 20 septembrie, 10:08 UTC, arata governance activ pe
ambele instante, dar zero utilizatori SCIM, zero mapping-uri SCIM si zero tokenuri
de serviciu active. Nu au fost exportate credentiale, nume sau emailuri.

## Limite si compatibilitate

Integrarile care foloseau sesiuni de utilizator, chei API personale, scope-uri
API generice, tokenuri cu tenantId sau
adoptarea unor conturi/echipe locale vor primi refuz. Configurati un credential
global autorizat doar daca integrarea trebuie sa administreze global SCIM.
Migrarea explicita a conturilor existente si asocierea lor cu identitati OIDC
raman lucrari distincte, fara asociere automata dupa email sau nume.

Resursele cu mapping SCIM existent si auth_source=scim sunt tratate drept
administrate. Codul vechi putea crea aceste marcaje prin operatii neautorizate;
absenta auditului anterior impiedica atribuirea si corectarea automata a tuturor
schimbarilor istorice. Administratorul trebuie sa revizuiasca datele suspecte.
Nu sunt modificate automat conturi sau grupuri live in acest checkpoint.

Aceasta corectie nu rezolva restul limitelor auditului, constatarile imaginii sau
Docker LAN 2375. Help-ul Identity & Policy explica noul contract in EN/RO.
