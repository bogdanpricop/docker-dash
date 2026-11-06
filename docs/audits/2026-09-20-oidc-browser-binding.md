# OIDC: legarea conectarii de browser

Status: corectie in sursa dupa candidatul 8.96.9 construit din `cb492f1`.
Imaginea existenta nu include aceasta corectie. Instantele live raman pe 8.96.8;
deploy-ul asteapta URL-urile de resetare si un candidat reconstruit/verificat.

## Probleme confirmate

- `state` exista numai in baza de date. Un callback din alt browser putea consuma
  state-ul si ajunge la schimbul de cod, fara dovada browserului initiator.
- Un ID token absent sau respins putea fi inlocuit prin endpoint-ul `userinfo`.
  Nu exista nonce sau PKCE, iar userinfo putea suprascrie inclusiv claim-urile de rol.
- Erorile furnizorului erau reflectate in raspunsuri HTML; exceptiile interne erau
  returnate clientului. Unele claim-uri de timp acceptau valori nenumerice.

Testul de regresie pentru browser strain a esuat pe codul anterior (500, in loc
de refuzul 400 inaintea accesului la provider). Testul foloseste numai un domeniu
fictiv; dupa corectie verifica si lipsa cererilor catre provider si pastrarea state-ului.

## Comportament nou

- Cookie HttpOnly, host-only, SameSite=Lax, cinci minute. HTTPS foloseste Secure si
  prefixul `__Host-`. Selectia HTTPS foloseste configuratia si `req.secure`, fara
  incredere directa intr-un antet X-Forwarded-Proto nevalidat de Express.
- Cookie-ul contine un verificator PKCE aleator de 256 biti. HMAC-SHA256 cu etichete
  diferite deriva state si nonce, legate de issuer, client ID si callback. State si
  nonce nu dezvaluie verificatorul. Baza pastreaza doar state-ul si expirarea.
- Callback-ul compara dovada browserului inainte sa consume atomic state-ul.
  Expirarea/valoarea invalida, alt cookie sau configuratia schimbata refuza cererea.
  Inclusiv anularea de la provider consuma state-ul valid si sterge cookie-ul.
- S256 este trimis la autorizare, iar verificatorul la schimbul de cod. ID token-ul
  RS256 este obligatoriu: semnatura, issuer, audience/azp, subject, exp/nbf/iat si
  nonce sunt verificate. Userinfo nu poate recupera un token invalid; subject-ul
  trebuie sa coincida, iar numai campurile de profil lipsa sunt completate.
- Raspunsurile fluxului sunt `no-store`, callback-ul are `no-referrer`, iar erorile
  publice sunt fixe. Niciun mesaj HTML primit de la provider nu este reflectat.
- Nu exista migrare noua. Conectarile incepute inaintea actualizarii trebuie reluate;
  sesiunile deja emise nu sunt revocate. O noua conectare in acelasi browser/cookie
  o inlocuieste pe cea precedenta. Callback-ul trebuie sa revina pe acelasi host.

## Verificari

- 25 teste noi cu HTTP real in proces, SQLite si tokenuri semnate RSA; 68 teste in
  grupul OIDC/expirare. Inclusiv browsere diferite, PKCE, nonce absent/gresit, ID token
  absent/malformat/semnatura invalida, claim-uri invalide, subject userinfo diferit,
  roluri neescaladate, callback concurent, expirare, configuratie schimbata si erori.
- Suita completa: **373 suite, 4.935 teste trecute, unul omis**. Lint complet trecut.
- Canarii Docker cu reteaua externa dezactivata, pe LAN si VPS: cele 21 verificari
  de autentificare existente plus 4 OIDC folosind HTTP, SQLite si RSA reale, provider
  simulat. Sursele locale sunt suprapuse peste imaginea 8.96.9 si verificate SHA-256;
  acestea nu sunt dovezi ca imaginea veche include corectia.
- Prima rulare nativa a folosit aceeasi adresa fictiva ca testul de recuperare si a
  incalcat constrangerea UNIQUE pentru email. Fixture-ul OIDC foloseste acum o adresa
  proprie; testele au fost reluate. Resursele proprii sunt eliminate si la esec.

Loguri locale: `.git/oidc-flow-before.log`, `.git/oidc-flow-focused.log`,
`.git/oidc-flow-full-tests.log`, `.git/oidc-flow-lint.log` si
`.git/oidc-flow-native-{lan,vps}-final.log`. Dovezi structurate in JSON-ul alaturat.

## Limite deschise

Nu s-a conectat un tenant Entra/Okta real si nu s-a certificat rutarea HTTPS sau
politica browserelor din productie. Pe HTTP cookie-ul nu protejeaza impotriva
interceptarii traficului; productia necesita HTTPS. O cerere capturata impreuna cu
cookie-ul complet sau un browser compromis raman in afara protectiei.

Asocierea conturilor SSO dupa username, separarea identitatilor issuer/subject de
conturile locale, tranzactia dintre creare cont/sesiune/audit, MFA locala pentru SSO,
revocarea rolurilor cand lipsesc grupurile si limitele raspunsurilor de la provider
raman de auditat/remediat. Acest checkpoint nu certifica intregul subsistem SSO.
Vulnerabilitatile imaginii si expunerea Docker LAN 2375 raman deschise.

Referinta: [RFC 9700, sectiunile 2.1 si 4.7](https://www.rfc-editor.org/rfc/rfc9700.html),
legarea state/nonce/PKCE de tranzactie si de browserul initiator.
