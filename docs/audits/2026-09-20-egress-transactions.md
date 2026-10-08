# Egress: tranzactii nftables si recuperare verificata

Aceasta corectie pastreaza politica anterioara daca aplicarea unui filtru esueaza.
Corectia este inclusa in [deploy-ul 8.96.5 pe LAN/VPS](2026-09-20-deployment-8.96.5.md). Testele de mai jos au modificat exclusiv namespace-uri
ale containerelor temporare de audit, fara firewall-ul hostului sau aplicatiile
existente.

## Defecte corectate

Runner-ul anterior stergea tabela `ip ddout` inainte de a valida/aplica toate
regulile noi. O eroare ulterioara putea lasa tinta fara politica initiala. La esecul
unui stack, elimina filtrele deja aplicate in loc sa restaureze politicile vechi.
Erorile restaurarii erau doar logate, iar mesajul putea afirma ca rollback-ul
reusise. Citirea logurilor nu avea limita/deadline si presupunea ca fiecare chunk
contine exact un frame Docker.

Noua implementare:

- Valideaza IPv4 si portul sidecar-ului inaintea crearii helper-elor. Foloseste
  ID-ul canonic Docker si verifica starea, capabilitatile si namespace-ul tintei
  si prin API-ul serviciului, nu doar prin ruta HTTP.
- Rezerva fiecare tinta printr-un helper cu nume unic pe daemon. Ordinea stabila
  a ID-urilor previne achizitia inversa pentru stack-uri suprapuse. Un conflict
  refuza operatia fara a modifica sau elimina helper-ul altui proces.
- Pregateste nftables si snapshot-urile tuturor tintelor inaintea primei mutatii.
  Helper-ele raman disponibile pana la sfarsitul aplicarii/restaurarii; rollback-ul
  nu depinde de instalarea pachetelor prin reteaua deja filtrata.
- Trimite adaugarea/stergerea/recrearea tabelei in acelasi `nft -f`.
  [Documentatia nftables](https://wiki.nftables.org/wiki-nftables/index.php/Atomic_rule_replacement)
  descrie acest mecanism de tranzactie. Alte tabele nu sunt sterse.
- Restaureaza snapshot-urile tintelor incercate, inclusiv absenta unei tabele.
  Compara politica restaurata cu snapshot-ul; raporteaza separat restaurarile
  reusite si esuate. Nu exista atomicitate globala intre namespace-uri.
- La rezultat incert sau recuperare nereusita, pastreaza rezervarea si copia
  privata din helper, incearca oprirea helper-ului si raporteaza identitatea sa.
  Etichetele pastreaza ID-ul tintei, StartedAt, PID-ul si ID-ul operatiei pentru
  reconciliere. O rezervare ramasa nu expira automat.
- Limiteaza fiecare observare Docker la 45 secunde, output-ul combinat la 128 KiB
  si snapshot-ul la 64 KiB; decodifica frame-uri fragmentate/coalescente. Helper-ul
  are 128 MiB, 0,5 CPU, 32 PID-uri si numai NET_ADMIN, fara escaladare de privilegii.
- Inregistreaza intentia de audit inaintea mutatiilor si raporteaza esecurile.
  Eliminarea partiala a unui stack intoarce eroare, nu succes. Interfata nu mai
  sterge politica dupa un esec al dezactivarii de urgenta.

## Dovezi

- Regresie completa: 355 suite, 4.613 teste trecute, un test live existent omis.
  Ultima ajustare de raportare audit este verificata separat prin 48 teste.
- Teste de orchestration: snapshot inaintea mutatiilor, rollback real al starii
  anterioare, recuperare esuata/incerta, concurenta, restartul tintei, limitele
  output-ului, parsing Docker si intentia de audit obligatorie.
- Canary LAN si VPS cu nftables 1.1.6, pe aceeasi imagine helper:
  `sha256:e35bb0e3321e5470a56398d303c5642d64221caab78341b66cc7f4d45656867b`.
  O comanda invalida in aceeasi tranzactie nu sterge tabela initiala; al doilea
  apply esuat restaureaza ambele politici; reapply/status pastreaza o tabela
  separata; concurenta este refuzata; rollback-ul reface absenta unei tabele;
  restaurarea esuata retine helper-ul oprit si snapshot-ul original verificat
  prin exportul fisierului. Sase scenarii trecute pe fiecare host.
- LAN verifica suplimentar instalarea nftables prin fallback-ul Alpine, inaintea
  mutatiei. Toate containerele de test, controalele si helper-ele retinute intentionat
  de test au fost eliminate dupa verificare.
- Lint, sintaxa canary si help/i18n verificate. [Dovezi sanitizate](2026-09-20-egress-transactions.json).

Imaginea helper a fost verificata separat: Trivy zero constatari; Grype un High
(zlib CVE-2026-85091) si trei Medium (BusyBox CVE-2025-60876 pentru busybox,
busybox-binsh si ssl_client). Manifestul OCI si configuratia raportata de Grype
au SHA-256 verificat si aceleasi doua straturi. Dupa actualizarea indexului Alpine,
`apk version -l '<'` nu a gasit pachete actualizabile: zlib 1.3.2-r0,
BusyBox 1.37.0-r31, nftables 1.1.6-r1. Aceste constatari raman deschise; imaginea
nu este declarata curata, publicata sau configurata automat in aplicatiile live.

## Limite ramase

Politica de trafic IPv4 existenta este pastrata in aceasta etapa: DNS, loopback
si RFC1918 sunt exceptate; IPv6 si non-TCP pot ocoli proxy-ul. Acoperirea acestora,
exceptii private strict per stack, revocarea conexiunilor existente si atribuirea
logurilor raman deschise. Nu se afirma izolarea completa a containerelor.

Snapshot-ul este o politica stateless nftables: contoarele, conexiunile conntrack
si starea temporala nu sunt restaurate. Dupa restartul tintei/app-ului sau esecul
comunicarii cu Docker, reconcilierea poate fi manuala. Copia unui namespace vechi
nu trebuie aplicata automat unei tinte restartate. Administratorii externi ai
daemonului pot ocoli rezervarile aplicatiei.

Imaginea dedicata din `docker/egress-helper` trebuie construita/verificata pe
daemonul selectat si configurata prin ID imutabil. Fallback-ul Alpine necesita
acces la repository in timpul pregatirii; daca o politica veche il blocheaza,
operatia refuza fara a modifica regulile. Nu se dezactiveaza filtre pentru a
instala dependente.

Suprapunerea politicilor container/stack la unapply, reaplicarea automata dupa
restart si fluxul de recuperare asistata raman de analizat separat. Aceasta etapa
inchide stergerea prematura a politicilor si raportarea falsa a restaurarii,
fara sa declare tot subsistemul egress finalizat.
