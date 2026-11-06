# Compose 5.5.1 cu dependente remediate

Imaginea 8.96.4 foloseste Compose `5.5.1+dd.1`, recompilat din sursa upstream
verificata, fara modificari ale sursei Compose. Modulul containerd este actualizat
de la 2.3.4 la 2.3.5, x/crypto de la 0.56.0 la 0.57.0, iar compilatorul este
Go 1.27.1. gRPC ramane la versiunea upstream 1.83.2. Nu sunt ignorate constatari
ale scannerelor.

## Identitate si validare

- [Ultima versiune Compose](https://github.com/docker/compose/releases/tag/v5.5.1):
  commit `5f94fb0aa42a2cd1248c6e6c7fafb87546b9c8de`.
- Checksum modul: `h1:saWlMxB0tfQ+FVUlWGIUjLvR0jF5cfTU18KI5zKLD/M=`.
- SHA-256 binar Linux amd64:
  `d8e47a8412129295947abc11b4725339d052ed7059a18141485f5ce12eba2fe7`.
- Build-ul verifica checksum-ul sursei, foloseste lock-urile Go in mod readonly
  si tag-ul `e2e` al build-ului oficial. Testele upstream din `pkg/compose`,
  `pkg/api` si `cmd/compose` au trecut cu dependentele selectate.
- Imaginea include sursa/checksum-ul, graful de pachete, metadata Go, modulul de
  build, licenta si hash-ul binarului in `/usr/share/docker-dash/scanners`.
  Pluginul este instalat in `/usr/libexec/docker/cli-plugins/docker-compose`.
- Canary real pe LAN si VPS: verificare hash/versiune, configuratie, `up`, health,
  `exec`, restart, recreare fortata, persistenta continutului unui volum si `ps`.
  Au fost eliminate toate resursele cu eticheta unica a fiecarei executii.
- Testul initial LAN a esuat la alocarea retelei: pool-urile implicite Docker
  sunt epuizate. Canary-ul final foloseste `network_mode: none`; el verifica
  lifecycle-ul si volumul, nu alocarea retelelor. Nu au fost sterse retelele
  existente si nu a fost reconfigurat daemonul.

## Rezultatul scanarilor

Trivy: 4 High, 2 Medium, 3 Unknown. Grype: 4 High, 5 Medium. Niciun Critical.
Fiecare scanner raporteaza cu un Medium mai putin fata de imaginea 8.96.3:
constatarea containerd CVE-2026-53495 a disparut din Compose. Advisory-ul
[containerd](https://github.com/containerd/containerd/security/advisories/GHSA-7jxh-36q5-gcqv)
confirma remedierea in 2.3.5 si descrie problema din CRI ExecSync.

GO-2026-5932 ramane raportat la x/crypto inclusiv in noul Compose. Graful real de
pachete al acestui binar nu include `golang.org/x/crypto/openpgp`; aceasta este
dovada de analiza a aplicabilitatii, nu o exceptie globala. Constatari pentru
gRPC/Docker in celelalte unelte si pachete Alpine, inclusiv zlib, raman deschise.
Nu se afirma ca intreaga imagine este securizata sau eligibila pentru publicare
prin pragul automat High/Critical/Unknown.

Scanarile sunt legate de imaginea exacta prin verificarea SHA-256 a manifestului
si configuratiei OCI, platformei linux/amd64 si celor 20 de straturi ordonate.
[Dovezi scanare si provenienta](2026-09-20-image-8.96.4.json).

Sunt testate local build-ul Linux amd64 si instalarea pe cele doua hosturi.
Nu se pretinde validarea unui build ARM64 in aceasta etapa.
