---
title: Gestionarea Docker Secrets
summary: Folosește Docker secrets cu pattern-ul _FILE pentru a ține credențialele în afara env vars și layerelor de imagine.
---

<h2>De ce nu Environment Variables?</h2>
<p>Punerea secretelor în <code>environment:</code> le expune în: <strong>docker inspect</strong>, listarea proceselor (<code>ps aux</code>), logurile containerului și crash dumps. Oricine are acces la Docker socket le poate citi.</p>

<h2>Pattern-ul _FILE</h2>
<p>Majoritatea imaginilor moderne (postgres, mysql, mariadb, redis, nginx) suportă citirea secretelor dintr-un fișier prin sufixul <code>_FILE</code>. În loc de:</p>
<pre><code>environment:
  POSTGRES_PASSWORD: my-secret-pass</code></pre>
<p>Folosește:</p>
<pre><code>environment:
  POSTGRES_PASSWORD_FILE: /run/secrets/db_password
secrets:
  - db_password</code></pre>

<h2>Configurare cu docker-compose</h2>
<pre><code>services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password

secrets:
  db_password:
    file: /etc/myapp/secrets/db_password.txt</code></pre>

<h2>Creare fișier secret (modul corect)</h2>
<pre><code># CRITIC: folosește printf, NICIODATĂ echo (echo adaugă \n care strică credențialele)
sudo mkdir -p /etc/myapp/secrets
sudo sh -c 'printf "%s" "$(openssl rand -base64 24)" > /etc/myapp/secrets/db_password.txt'
sudo chmod 600 /etc/myapp/secrets/db_password.txt
sudo chown root:docker /etc/myapp/secrets/db_password.txt</code></pre>

<h2>Capcane comune</h2>
<ul>
  <li><strong>echo adaugă newline:</strong> <code>echo "secret" > file</code> stochează <code>secret\n</code> — multe drivere includ newline-ul literal, cauzând eșecuri silențioase de autentificare.</li>
  <li><strong>Permisiunile contează:</strong> fișierul trebuie să fie 600 (doar root + grupul docker).</li>
  <li><strong>Nu face commit:</strong> adaugă <code>secrets/</code> în .gitignore.</li>
  <li><strong>App-ul trebuie să suporte _FILE:</strong> aplicațiile custom trebuie să citească fișierul singure.</li>
</ul>

<h2>Verificare în container</h2>
<pre><code># Fișierele apar la /run/secrets/&lt;name&gt;
docker exec mycontainer ls -la /run/secrets/
docker exec mycontainer cat /run/secrets/db_password</code></pre>


<h2>Executie la distanta din Secrets Wizard</h2>
<p>Sunt necesare rolul administrator, modul cu scriere si un host SSH configurat
cu amprenta de incredere. Scriptul este transmis criptat, verificat integral prin
SHA-256 pe host si executat fara crearea unui fisier de script. Continutul nu apare
in argumentele proceselor sau in audit. Hostul necesita Bash, sha256sum si /dev/fd;
optiunea sudo necesita acces fara parola, neinteractiv. Comenzile scriptului primesc
EOF pe intrarea standard si nu pot cere parole. Scriptul in sine poate crea fisiere.</p>
<p>Limita de timp este 120 de secunde; scriptul si output-ul combinat stdout/stderr
sunt limitate la 1 MiB. Auditul pastreaza ID-ul operatiei, hash-ul si metadatele
executiei inainte si dupa incercare, fara continutul scriptului sau output.
Output-ul este returnat doar administratorului solicitant, fara stocare in cache.</p>
<p>Conexiunea pierduta, timeout-ul sau output-ul excesiv nu dovedesc oprirea
procesului remote. Raspunsul avertizeaza cand executia nu poate fi confirmata.
Verifica hostul si operatia din audit inainte de repetare. Efectele comenzilor nu
sunt anulate automat. Hash-ul diferit impiedica executia unui transfer incomplet.</p>
<p>Versiunile vechi pot fi lasat fisiere docker-dash-secrets-*.sh in /tmp sau
fragmente de script in exporturi/backup-uri de audit. Modificarea nu le sterge.
Administratorul trebuie sa confirme ca apartin unor operatii incheiate si sa aplice
politica de retentie a secretelor. Nu sterge scripturi necunoscute si nu rescrie
lantul de hash-uri al auditului pentru a ascunde evenimente.</p>
