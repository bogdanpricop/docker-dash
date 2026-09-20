---
slug: ldap-tls
title: Verified LDAP and Active Directory transport
title_ro: Transport LDAP si Active Directory verificat
category: docker-dash
difficulty: intermediate
icon: fas fa-lock
summary: Configure verified LDAPS or StartTLS before directory passwords are sent.
summary_ro: Configureaza LDAPS sau StartTLS verificat inainte de trimiterea parolelor.
---

## Configurarea conexiunii

In **Settings → LDAP**, alege **StartTLS** (de obicei portul 389) sau **LDAPS**
(de obicei 636). Ambele verifica lantul, valabilitatea si numele certificatului
inainte de trimiterea parolei contului de serviciu sau a utilizatorului. Campul
host accepta numele DNS ori adresa IP, fara schema URL. Poti folosi porturi proprii.

Pentru PKI privat, obtine CA-ul emitent printr-un canal de administrare deja sigur
si introdu certificatele PEM in formular. Un certificat de server autosemnat
poate fi acceptat explicit daca este de incredere si corespunde hostului.
Nu accepta automat certificatul primit de la un server neverificat. Fara CA privat
configurat se folosesc certificatele implicite de incredere ale containerului.

Foloseste un cont de serviciu cu drepturi limitate la cautarile necesare. Introdu
DN-ul complet, parola, base DN si atributul utilizatorului. Grupul obligatoriu
necesita DN complet. Testeaza, salveaza si verifica autentificarea. Contul admin
local ramane disponibil pentru recuperare; parola LDAP nu devine parola locala.
Verificarile MFA si blocarea dupa incercari esuate raman active.

## Configuratii vechi si rotirea CA-ului

Vechea optiune LDAPS debifata inseamna acum **StartTLS obligatoriu**. Daca serverul
refuza negocierea, nu primeste parola. Configuratiile cu `tlsSkipVerify: true`
refuza conectarea pana la salvarea unor setari verificate. Nu exista revenire
la LDAP necriptat dupa o eroare TLS.

La editare, parola si CA-ul lasate goale pastreaza valorile salvate. Si **Test
Connection** foloseste valorile salvate. Controlul explicit de stergere a CA-ului
revine la certificatele implicite ale containerului. Pentru rotire, poti introduce
temporar CA-ul vechi si cel nou, ambele verificate independent; dupa schimbarea
certificatului si testare, elimina CA-ul retras.

Parola de serviciu este criptata cu `ENCRYPTION_KEY`; pastreaza cheia stabila si
copiata sigur. Backup-urile vechi pot contine credentiale istorice necriptate.

## Erori de conectare

- Eroare de CA/lant: configureaza emitentul verificat si certificatele intermediare.
- Nume diferit: foloseste numele din certificat sau emite un certificat corect.
- Certificat expirat: reinnoieste-l; verificarea nu poate fi dezactivata.
- StartTLS refuzat: activeaza-l pe server sau foloseste LDAPS verificat.
- Timeout TLS: verifica accesul, portul si modul selectat.
- Reconectare necriptata refuzata: repeta operatia; noua conexiune negociaza din nou TLS.

Nu seta `NODE_TLS_REJECT_UNAUTHORIZED=0` si nu ignora verificarea certificatelor.

Referinte: [RFC 4513](https://www.rfc-editor.org/rfc/rfc4513),
[transport securizat ldapts](https://github.com/ldapts/ldapts#starttls).
