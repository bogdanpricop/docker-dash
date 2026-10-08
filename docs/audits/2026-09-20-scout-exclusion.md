# Docker Scout: excludere temporară din imaginea standard

Decizie confirmată de utilizator la 20 septembrie 2026: excludem temporar Docker
Scout, păstrând scanarea cu Trivy și Grype, cu explicații vizibile în produs.

## Motiv

Ultimul release public verificat, Scout 1.24.0 din 30 iulie 2026, include dependențe
vulnerabile. Scanarea imaginii a raportat 47 de constatări în binarul său, inclusiv
runtime-ul Go 1.26.3 și biblioteci mai vechi. Unele constatări de modul necesită
analiză de aplicabilitate; nu presupunem că toate pot fi exploatate. Totuși, nu avem
o justificare verificată pentru a păstra întregul binar în imaginea standard.

Repository-ul public Docker Scout distribuie binare și documentație. Sursa
modulului încorporat `github.com/docker/scout-cli-plugin` nu este disponibilă prin
repository-ul public verificat, astfel că nu putem produce și valida aceeași
recompilare cu remedieri aplicată scannerelor cu sursă disponibilă.

## Efect în aplicație

- Imaginea standard nu instalează pluginul Scout sau stratul gcompat adăugat
  pentru acesta. Docker CLI și Compose rămân disponibile.
- Modul Auto folosește Trivy, apoi Grype. Nu returnează rezultate ale altui motor
  sub numele Scout.
- Images și Security explică dezactivarea temporară, în română și engleză.
  Nu mai oferă formular de parolă/token pentru activarea Scout.
- Cererile explicite către Scout și vechiul endpoint de autentificare primesc
  HTTP 503 cu codul `SCOUT_TEMPORARILY_DISABLED` și explicația. Nu sunt prezentate
  drept scanări reușite cu zero vulnerabilități.
- Rezultatele istorice și configurația Docker persistentă existentă sunt păstrate.

## Condiții pentru reintroducere

Verificăm un release corectat: proveniență și checksum, inventarul dependențelor,
vulnerabilitățile aplicabile, scanare funcțională și scanarea imaginii finale.
Publicarea rămâne blocată dacă persistă constatări High/Critical/Unknown fără
remediere sau dovadă precisă de neaplicabilitate. Simplul număr de versiune mai
mare sau existența unui cont Docker Hub nu îndeplinește aceste condiții.

Referințe: [release Scout 1.24.0](https://github.com/docker/scout-cli/releases/tag/v1.24.0),
[repository public](https://github.com/docker/scout-cli),
[inventarul imaginii înainte de excludere](2026-09-20-image-vulnerabilities.json).
