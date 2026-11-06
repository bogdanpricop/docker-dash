# OIDC: transport limitat si cache validat

Checkpoint dupa `4c39160`, fara migrare noua. Schema ramane 182. Corectiile sunt
in sursa; imaginea candidata 8.96.9 existenta nu le include. LAN/VPS nu sunt
redeployate in acest checkpoint.

## Defecte demonstrate si remediere

Trei regresii au esuat pe implementarea anterioara: un corp peste 1 MiB era
acceptat, absenta unui raspuns nu avea deadline independent de evenimentul idle,
iar discovery putea memora un raspuns HTTP 503 ca metadate. Bufferul vechi crestea
prin concatenare fara limita, iar UTF-8 impartit intre chunk-uri putea fi alterat.

Modulul `src/utils/oidc-http.js` stabileste un timer de 10 secunde inaintea
cererii: include DNS, conectare, TLS si citirea corpului. Traficul nu reseteaza
timerul. Sunt permise maximum opt cereri simultane per proces; cererile in exces
sunt refuzate imediat, fara coada. Fiecare raspuns are maximum 1 MiB de corp si
16 KiB de headere. Content-Length excesiv este refuzat inaintea citirii, iar
numararea efectiva a octetilor acopera si transferul chunked.

Cererea necesita HTTPS fara userinfo, fragment sau caractere de control/spatiu;
TLS 1.2 minim si verificarea certificatului sunt explicite. Nu urmareste
redirecturi, accepta numai HTTP 200 si application/json ori application/jwk-set+json,
si refuza compresia. JSON trebuie sa fie un obiect, decodat UTF-8 strict dupa
reunirea octetilor. Abandonul, stream-ul incomplet, erorile si deadline-ul distrug
cererea/raspunsul, elibereaza bufferul si slotul. Mesajele fixe nu includ tokenuri,
corpuri, URL-uri ori erorile brute ale socket-ului.

Discovery verifica issuer-ul exact si endpointurile HTTPS pentru autorizare,
token, JWKS si userinfo daca acesta exista. JWKS necesita HTTP 200 si o lista
ne-goala de maximum 100 obiecte; verificarile criptografice existente raman
obligatorii. Numai rezultatele validate intra in cache. Cererile concurente
pentru acelasi issuer impart descarcarea discovery/JWKS in curs, inclusiv rotatia
cheilor. TTL-ul de o ora si cooldown-ul refresh-ului de un minut sunt pastrate.

## Dovezi

- Trei regresii initiale in `.git/oidc-transport-before.log`.
- 31 teste noi; suita completa: 376 suite, 5.052 teste trecute, unul omis.
  Lint trecut si help verificat pentru 60/60 pagini. Verificarea npm proaspata
  raporteaza zero pachete outdated si zero vulnerabilitati ale dependentelor
  proiectului; aceasta nu invalideaza constatarile separate ale imaginii Docker.
- Teste focalizate pentru validare, byte limit, deadline, intreruperi, JSON, UTF-8,
  concurrency, recuperarea sloturilor, issuer/endpoints si cache single-flight.
  Fixture-urile vechi au primit discovery complet si issuer explicit, fara
  eliminarea verificarilor existente.
- 43 verificari native pe fiecare host folosesc HTTPS/TLS reale cu o CA publica de
  test, limitata la procesul copil disposable prin NODE_EXTRA_CA_CERTS. Sase cazuri
  noi verifica UTF-8, corp chunked excesiv, redirect refuzat, certificat cu nume
  gresit inainte de HTTP, opt conexiuni simultane si un flux activ oprit dupa circa
  10 secunde. Providerul real si SMTP nu sunt contactate; reteaua externa este
  dezactivata. Certificatele sunt fixture-uri publice, nu credentiale live.
- Sursele suprapuse sunt verificate SHA-256. Containerele proprii sunt eliminate.
  Loguri: `.git/oidc-transport-{focused,full-tests,lint}.log` si
  `.git/oidc-transport-native-{lan,vps}.log`. Rezultatele finale si hashurile sunt
  in JSON-ul alaturat.

## Compatibilitate si limite

Furnizorii cu issuer generic/placeholder, metadate incomplete, MIME gresit,
redirecturi obligatorii sau raspunsuri foarte mari/lente trebuie corectati.
Pentru Entra se foloseste issuer-ul tenantului concret. CA private sunt acceptate
prin trust store-ul Node configurat la pornire. Help-ul Settings EN/RO si ghidul
OIDC descriu cerintele.

Limita de timp este per cerere, nu pentru intreaga conectare: un flux poate
include discovery, token, JWKS, refresh si userinfo secvential. Limita simultana
este per proces, nu distribuita intre replici. Endpointurile private ale
furnizorilor raman permise; acest checkpoint nu implementeaza o politica DNS/IP
anti-SSRF pentru configuratii administrative compromise. Nu valideaza un provider
real, nu certifica toate functiile proiectului si nu rezolva constatarile imaginii
ori expunerea Docker LAN 2375 documentate anterior.

Surse primare: [Node HTTP timeout si stream lifecycle](https://nodejs.org/api/http.html#requestsettimeouttimeout-callback)
si [OpenID Connect Discovery, validarea configuratiei](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfigValidation).
