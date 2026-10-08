# Separarea identitatilor externe de conturile locale

Status: checkpoint in sursa, dupa `f713b4c`, cu migrarea 181. Nu este inclus in
imaginea 8.96.9 construita anterior din `cb492f1` si nu este instalat in productie.

## Problema demonstrata

SSO cauta utilizatorul doar dupa username, cu comparatie fara distinctie intre
majuscule si minuscule. Un profil extern cu numele unui cont local putea primi acel
cont si rolul existent. Cele patru regresii pentru coliziuni local/LDAP/SCIM/proxy
au esuat pe sursa initiala: autentificarea returna exact ID-ul contului existent.

## Corectie

- Migrarea 181 adauga `external_source`, `external_issuer`, `external_subject` si un
  index unic. OIDC foloseste issuer/sub din ID token-ul verificat, cu comparatie
  exacta. Proxy SSO foloseste namespace-ul configurat si username-ul afirmat de
  proxy ca subject. Cele doua surse nu isi pot revendica reciproc conturile.
- Username-ul si emailul nu sunt dovezi de identitate. Daca username-ul este ocupat,
  se creeaza alt cont cu sufix derivat din identitatea externa; rolul vine numai din
  politica aplicabila identitatii noi. O schimbare de nume la provider pastreaza
  contul asociat aceleiasi identitati. Un cont inactiv ramane refuzat chiar daca
  profilul isi schimba numele. Schimbarea auth_source pastreaza asocierea rezervata
  si blocheaza vechea cale de autentificare, fara a crea automat alt cont.
- Emailul OIDC se pastreaza doar daca ID token-ul il marcheaza explicit verificat
  si adresa nu este folosita deja. Adresele de la proxy-ul de incredere sunt date
  de contact; coliziunile nu creeaza asocieri. Campul ramane NULL la conflict.
- Crearea contului/asocierii si actualizarea rolului au audit in aceeasi tranzactie.
  OIDC include sesiunea si auditul conectarii in tranzactia exterioara. Un esec de
  audit anuleaza toate scrierile, inclusiv contul nou. Procese concurente rezolva
  aceeasi identitate la acelasi cont, cu un singur eveniment de creare.
- Rolul proxy SSO urmeaza grupurile afirmate la fiecare cerere. Namespace-ul
  `SSO_IDENTITY_NAMESPACE` are implicit valoarea `trusted-proxy`; toate proxy-urile
  pentru aceeasi autoritate trebuie sa foloseasca aceeasi valoare. La schimbarea
  autoritatii de identitate foloseste un namespace nou. Aceasta setare nu inlocuieste
  allow-list-ul conexiunilor proxy si eliminarea antetelor primite de la client.
- Parolele locale pot fi schimbate/resetate doar pentru `auth_source=local`.
  Resetarea publica nu aloca quota si nu trimite email pentru surse externe.
  Tokenurile de resetare externe deja existente sunt refuzate la citire/consumare.
  Login-ul cu parola refuza OIDC/proxy/legacy/SCIM; LDAP isi verifica directorul.
  Resetarea administrativa aplica si politica `writeable`.
- Modificarea asocierii externe revoca sesiunile, provocarile MFA si linkurile de
  resetare si incrementeaza versiunea credentialelor. Settings afiseaza sursa si
  ascunde actiunile de parola/invitatie locale pentru conturile externe; help EN/RO
  explica separarea, migrarile si rolurile.

## Conturi istorice si impactul upgrade-ului

Conturile marcate anterior cu `SSO_NO_PASSWORD` si sursa local devin `sso_legacy`.
ID-urile, rolurile, permisiunile si datele lor sunt pastrate, dar sesiunile, provocarile
MFA si linkurile de recuperare sunt revocate. Nu exista suficiente dovezi pentru a
deduce issuer/subject; migrarea nu le inventeaza si nu transfera permisiuni automat.
Un login extern nou creeaza un cont separat. Administratorul trebuie sa verifice
identitatea la provider si sa acorde explicit rolul si accesul la resurse pentru
contul nou; istoricul contului vechi ramane atasat ID-ului original. Nu exista in
acest checkpoint o interfata de reunire/reasociere a conturilor.

Conturile SSO istorice carora li s-a inlocuit deja parola nu mai au markerul distinctiv;
migrarea nu le poate identifica sigur si nu modifica arbitrar conturi locale. Ele
necesita analiza istoricului. Revenirea la codul vechi nu este o remediere de securitate;
pastrarea backup-ului este necesara, iar down-ul schemei elimina asocierile externe.

Inspectie read-only la 2026-09-20T08:59:35Z: LAN are 5 conturi locale, VPS are 2;
niciun marker SSO istoric, OIDC si SSO headers dezactivate pe ambele. Versiunea live
este 8.96.8. Inspectia nu a citit/exportat parole, emailuri sau chei. Configuratia si
datele trebuie reverificate la deploy; in prezent nu exista conturi SSO active care
sa fie afectate de migrarea legacy pe aceste doua instante.

## Verificari

- Patru regresii de preluare cont au esuat pe codul anterior.
- 23 cazuri noi: 21 de serviciu/migrare si doua HTTP OIDC. Grupul nou: 48 teste.
- Suita completa: **374 suite, 4.958 teste trecute, unul omis**. Lint si help verificate.
- Canarii LAN/VPS: **29 verificari pe fiecare**, provider si SMTP simulate, reteaua
  externa oprita. Cele patru noi verifica izolarea fata de adminul local, schimbarea
  numelui de profil, rollback la esec de audit si creare concurenta in doua procese.
  Sursele sunt suprapuse peste imaginea existenta si verificate SHA-256; nu se afirma
  ca imaginea existenta include corectiile. Resursele proprii au fost eliminate.
- Loguri: `.git/external-identity-before.log`, `external-identity-new-tests.log`,
  `external-identity-full-tests.log`, `external-identity-lint.log` si
  `external-identity-native-{lan,vps}.log`, toate sub `.git/`. JSON-ul alaturat
  pastreaza identitatea surselor, rezultatele native si inspectia agregata live.

## Limite ramase

Un tenant/provider real, autoritatea proxy reala, rotirea clientului OIDC si HA cu
baza comuna nu sunt certificate de aceste teste. Proxy-ul ramane responsabil pentru
unicitatea si nereutilizarea subject-ului/username-ului sau schimbarea namespace-ului.
SSO nu aplica TOTP local la login: MFA se impune la provider; TOTP local poate fi
folosit pentru step-up. Revocarea rolurilor OIDC cand lipsesc grupurile, limitele
transportului providerului si revocarea sesiunilor la schimbarea configuratiei SSO
raman de analizat. Vulnerabilitatile imaginii si Docker LAN 2375 raman deschise.

Referinta: [OpenID Connect Core 1.0, sectiunea 5.7](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability),
identitatea stabila este perechea issuer/subject, nu username-ul sau emailul.
