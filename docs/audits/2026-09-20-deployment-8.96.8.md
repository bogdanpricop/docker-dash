# Deploy verificat 8.96.8 - LAN si VPS

Ambele instalari ruleaza commit-ul `29c26d2b248cbc57c580ed8df57b1d9744123064`, urcat pe Git.
Imagine: `docker-dash:8.96.8-audit-29c26d2`, ID `sha256:1085b24aa2d0531faa15b62ae32b3ef93f92532a47d237ef978654464570741b`.

- LAN: Docker healthy, HTTP 200 / 8.96.8; 5 utilizatori, 7 hosturi; backup consistent 1735495680 bytes, integrity_check ok.
- VPS: Docker healthy, HTTP 200 / 8.96.8; 2 utilizatori, 1 hosturi; backup consistent 619614208 bytes, integrity_check ok.

Backup-uri private 0600 in directoare 0700; imaginile anterioare si configuratia de rollback sunt pastrate.
Cheile, fisierele .env, volumele, porturile si retelele sunt pastrate. Migrarea 177 este prezenta.
Verificarea post-deploy confirma accesul Docker local, imaginea exacta si helper-ul configurat.
Helper: `sha256:386bdd5b2c87f4b04867083eb9d771aab0a9446d531c05ae08212f8bb123a8d5`. Imaginea helper a fost verificata pe fiecare daemon inainte de deploy.

Sunt instalate corectiile [duratei cotelor HTTP](2026-09-20-quota-lifecycle.md)
si [protejarii recuperarilor la prune](2026-09-20-prune-recovery.md).
Ambele aplicatii raman standalone, SSO dezactivat, fara TRUST_PROXY personalizat.
Modul HA a fost testat numai in containere temporare. Nu este certificat pentru infrastructura de productie.

[Probele imaginii](2026-09-20-image-8.96.8.md) au trecut pe ambele hosturi:
Compose, pornire/restart Linux, SQLite, chei persistente, Git/OpenSSH, TLS provider, LDAP,
10 scenarii HA, 12 HTTP/Redis si 5 prune per host. 362 suite / 4762 teste trecute, unul omis; lint si npm audit trecute.

Trivy: 4 High / 2 Medium / 3 Unknown; Grype: 4 High / 5 Medium, fara Critical.
Nu s-au adaugat exceptii de scanare si nu s-au dezactivat praguri de admitere/publicare.
Imaginea a fost transferata privat, fara publicare intr-un registru public.
Expunerea Docker LAN 2375, constatarile imaginii, credentialele istorice si limitele egress/HA documentate raman deschise.

Dovezi si orele verificarilor: [JSON deploy](2026-09-20-deployment-8.96.8.json).
