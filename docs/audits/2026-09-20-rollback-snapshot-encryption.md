# Criptarea configuratiilor istorice pentru rollback

Audit local, 20 septembrie 2026. Modificarile nu sunt publicate sau instalate peste
serviciile existente. Migrarea este validata pe date de test.

## Remedieri

`container_image_history.config_snapshot` continea configuratia completa ca JSON
in clar, inclusiv variabile de mediu si comenzi care pot include parole. Acum
update, safe update, pipeline si rollback folosesc acelasi serviciu de salvare cu
AES-256-GCM si cheia instalarii. Formatul are versiune, nonce aleator si un context
autentificat cu hostul, numele containerului, ID-ul original si ID-ul imaginii.
Mutarea ciphertext-ului intr-un rand cu alta identitate este refuzata.

Migrarea 176 cripteaza inregistrarile existente in tranzactia de startup. Citeste
cate un rand, fara un iterator SQLite activ in timpul scrierilor. O eroare anuleaza
intreaga migrare; nu se ignora pierderea cheii sau esecul unei scrieri. Datele JSON
vechi invalide sunt pastrate criptat si raman inutilizabile pentru rollback.
Valorile istorice null/goale pastreaza fallback-ul existent, numai pentru admin.

Rollback-ul refuza plaintext introdus dupa migrare, date corupte, cheia gresita sau
identitatea nepotrivita inainte de oprirea containerului. Cele patru fluxuri nu
mai ignora esecurile salvarii istoricului: containerul curent ramane neatins.
API-ul de istoric continua sa omita complet snapshot-ul, inclusiv forma criptata.

In dialog erau interpolate direct unele metadate din istoric. Aceste campuri sunt
acum escapate. Verificarea a identificat si faptul ca helperul comun `escapeHtml`
nu proteja ghilimelele in atribute. Helperul escapeaza acum `&`, `<`, `>`, ambele
tipuri de ghilimele si pastreaza valoarea afisata. Aceasta nu inlocuieste validarea
URL-urilor sau separarea datelor de cod JavaScript.

Dialogul include explicatia EN/RO si legatura catre ghidul din produs
[`rollback-history`](../../src/db/howto-content/rollback-history.md), inclusiv
pastrarea cheii, recuperarea si limitele backup-ului.

## Validare

- **352 suite, 4.550 teste reusite, unul omis**, plus lint si help 60/60.
- 81 teste tintite pentru istoric, autorizare si deployment: migrare atomica,
  nonce-uri distincte, decriptare, cheie gresita, autenticitate, mutarea datelor
  intre contexte, toate cele patru fluxuri si eroare SQLite inainte de stop/remove.
- Browser real cu CSP in EN/RO: textul si atributele nu produc markup injectat,
  ghidul este tradus si se deschide. Au trecut din nou verificarile bibliotecilor
  browser, inventarului, formularelor Scout/SSH/Git/provider/LDAP.
- Imagine Linux verificata:
  `sha256:b21e40cf15e9548154310f82704fe6fe1ad81abfb640cadaf5c1f445e3dc2979`.
  Migrarea SQLite reala, criptarea, decriptarea dupa restart si refuzul altui host
  au trecut, impreuna cu smoke-urile LDAP, Git SSH, mTLS, Compose si startup.
  Containerul disposable a fost eliminat.

[Dovezile sintetice](2026-09-20-rollback-snapshot-encryption.json) leaga testele si
scanarile de acest ID exact. Noua scanare
[Trivy](2026-09-20-rollback-image-trivy.json) raporteaza 4 High, 3 Medium si
3 Unknown; [Grype](2026-09-20-rollback-image-grype.json) raporteaza 4 High si
6 Medium. Niciun scanner nu raporteaza Critical. Numaratorile nu se aduna si nu
reprezinta o imagine fara vulnerabilitati. Grype identifica in continuare
`CVE-2026-85091` pentru zlib 1.3.2-r0, fara versiune reparata indicata in raport.
Exista si diferente de inventar/advisory intre scanere; analiza anterioara a
dependintelor Go este in [raportul recompilarii](2026-09-20-scanner-rebuild.md).
Nu au fost introduse exceptii globale. Publicarea ramane blocata de constatari;
ambele containere de scanare au fost eliminate.

Docker foloseste ID-ul manifestului OCI pentru acest build; Grype raporteaza
ID-ul configuratiei `sha256:eb406fa9a0f9b83e29f6d1a3e80b0ecd17c3824de5748bff8119ad52baa27a4a`.
Legatura manifest-config a fost verificata din exportul exact al imaginii, cu
SHA-256 pentru ambele obiecte, platforma linux/amd64 si aceleasi 20 de straturi
in ordinea corecta. Diferenta de ID nu a fost acceptata fara aceste verificari.

## Limite ramase

Criptarea acopera randurile active si scrierile noi. Nu rescrie backup-uri, copii
WAL, pagini libere sau snapshot-uri de stocare; acestea necesita protectie si
retentie separata, iar secretele expuse trebuie rotite. Nu a fost introdusa o
politica arbitrara de stergere a istoricului. Pastrarea cheii langa o copie accesibila
a bazei permite decriptarea; accesul la ambele trebuie controlat.

Inlocuirea containerului nu este inca tranzactionala. O eroare dupa stergerea
containerului curent poate necesita recuperare manuala. Acest lucru, istoricul
auditului, regulile egress ramase, Docker LAN 2375 si vulnerabilitatile imaginii
raman in audit. Raportul nu afirma ca intregul proiect este securizat.
