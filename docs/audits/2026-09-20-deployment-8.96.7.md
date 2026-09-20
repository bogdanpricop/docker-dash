# Deploy verificat 8.96.7 - LAN si VPS

Ambele instalari ruleaza commit-ul `cbd4dd564a5a9ab1f2345982228d8712772da460`, urcat pe Git.
Imagine: `docker-dash:8.96.7-audit-cbd4dd5`, ID `sha256:5fffc3d18ed6c444d43e87b6c38729c78fb7d8be7d2bf364713442f78e283cf8`.

- LAN: Docker healthy, HTTP 200 / 8.96.7; 5 utilizatori, 7 hosturi; backup consistent 1698127872 bytes, integrity_check ok.
- VPS: Docker healthy, HTTP 200 / 8.96.7; 2 utilizatori, 1 hosturi; backup consistent 619614208 bytes, integrity_check ok.

Backup-uri private 0600 in directoare 0700; imaginile anterioare si configuratia de rollback sunt pastrate.
Cheile, fisierele .env, volumele, porturile si retelele sunt pastrate. Migrarea 177 este prezenta.
Verificarea post-deploy confirma accesul Docker local, imaginea exacta si helper-ul configurat.
Helper: `sha256:386bdd5b2c87f4b04867083eb9d771aab0a9446d531c05ae08212f8bb123a8d5`. Imaginea helper lipsa pe VPS a fost restaurata inainte de deploy.

Sunt instalate corectiile [HTTP/proxy](2026-09-20-http-trust-and-quotas.md),
[lease HA](2026-09-20-ha-lease.md) si separarea health de bugetul API.
Ambele aplicatii raman standalone, SSO dezactivat, fara TRUST_PROXY personalizat.
Modul HA a fost testat numai in containere temporare. Nu este certificat pentru infrastructura de productie.

[Probele imaginii](2026-09-20-image-8.96.7.md) au trecut pe ambele hosturi:
Compose, pornire/restart Linux, SQLite, chei persistente, Git/OpenSSH, TLS provider, LDAP,
10 scenarii HA si 8 HTTP/Redis per host. 361 suite / 4736 teste trecute, unul omis; lint si npm audit trecute.

Trivy: 4 High / 2 Medium / 3 Unknown; Grype: 4 High / 5 Medium, fara Critical.
Nu s-au adaugat exceptii de scanare si nu s-au dezactivat praguri de admitere/publicare.
Imaginea a fost transferata privat, fara publicare intr-un registru public.
Expunerea Docker LAN 2375, constatarile imaginii, credentialele istorice si limitele egress/HA documentate raman deschise.

Dovezi si orele verificarilor: [JSON deploy](2026-09-20-deployment-8.96.7.json).
