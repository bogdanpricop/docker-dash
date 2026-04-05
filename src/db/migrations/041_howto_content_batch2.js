'use strict';

exports.up = function (db) {
  const update = db.prepare('UPDATE howto_guides SET content = ?, content_ro = ? WHERE slug = ?');

  // ── 16. update-containers ──────────────────────────────────────────────────
  update.run(
    `<h2>Updating Containers Safely</h2>
<p>Keeping your containers up to date is essential for security patches and new features. Docker Compose makes this a two-step process.</p>

<h3>Pull New Images</h3>
<pre><code>docker compose pull</code></pre>
<p>This downloads the latest versions of all images declared in your <code>docker-compose.yml</code> without touching running containers.</p>

<h3>Recreate Containers</h3>
<pre><code>docker compose up -d</code></pre>
<p>Compose compares the running state against the desired state and recreates only the containers whose images changed.</p>

<h3>Verify the Update</h3>
<pre><code>docker compose ps
docker compose logs --tail=50</code></pre>

<h3>Update a Single Service</h3>
<pre><code>docker compose pull app
docker compose up -d app</code></pre>

<h3>Rolling Updates in Swarm</h3>
<p>In Swarm mode, use <code>docker service update</code> for zero-downtime rolling updates:</p>
<pre><code>docker service update --image myapp:2.0 my_service</code></pre>
<p>Swarm drains one task at a time, keeping the service available throughout.</p>

<h3>Automated Updates with Watchtower</h3>
<p>Watchtower polls Docker Hub and automatically recreates containers when a new image is pushed:</p>
<pre><code>docker run -d --name watchtower \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  containrrr/watchtower --interval 3600</code></pre>
<p><strong>Caution:</strong> Watchtower is convenient for home labs but should be used carefully in production — always pin image versions and test before auto-deploying.</p>`,

    `<h2>Actualizare containere în siguranță</h2>
<p>Menținerea containerelor la zi este esențială pentru patch-uri de securitate și funcționalități noi. Docker Compose face acest proces simplu în doi pași.</p>

<h3>Descarcă imaginile noi</h3>
<pre><code>docker compose pull</code></pre>
<p>Aceasta descarcă cele mai recente versiuni ale tuturor imaginilor declarate în <code>docker-compose.yml</code> fără a atinge containerele care rulează.</p>

<h3>Recreează containerele</h3>
<pre><code>docker compose up -d</code></pre>
<p>Compose compară starea curentă cu starea dorită și recreează doar containerele ale căror imagini s-au schimbat.</p>

<h3>Verifică actualizarea</h3>
<pre><code>docker compose ps
docker compose logs --tail=50</code></pre>

<h3>Actualizează un singur serviciu</h3>
<pre><code>docker compose pull app
docker compose up -d app</code></pre>

<h3>Rolling updates în Swarm</h3>
<p>În modul Swarm, folosește <code>docker service update</code> pentru actualizări fără downtime:</p>
<pre><code>docker service update --image myapp:2.0 my_service</code></pre>

<h3>Actualizări automate cu Watchtower</h3>
<p>Watchtower monitorizează Docker Hub și recreează automat containerele când apare o imagine nouă:</p>
<pre><code>docker run -d --name watchtower \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  containrrr/watchtower --interval 3600</code></pre>
<p><strong>Atenție:</strong> Watchtower este convenabil pentru home lab, dar în producție întotdeauna fixează versiunile imaginilor și testează înainte de a activa auto-deploy.</p>`,
    'update-containers'
  );

  // ── 17. container-wont-start ───────────────────────────────────────────────
  update.run(
    `<h2>Container Won't Start — Debugging Guide</h2>
<p>When a container exits immediately or refuses to start, exit codes and logs tell the whole story.</p>

<h3>Step 1: Check the Exit Code</h3>
<pre><code>docker inspect --format='{{.State.ExitCode}}' &lt;container&gt;</code></pre>

<h3>Common Exit Codes</h3>
<ul>
  <li><strong>0</strong> — Clean exit (process finished normally)</li>
  <li><strong>1</strong> — Application error (check app logs)</li>
  <li><strong>126</strong> — Permission denied (entrypoint not executable)</li>
  <li><strong>127</strong> — Command not found (wrong entrypoint or PATH)</li>
  <li><strong>137</strong> — Killed by OOM killer (not enough memory)</li>
  <li><strong>139</strong> — Segmentation fault (crash in native code)</li>
  <li><strong>143</strong> — Graceful SIGTERM (usually intentional)</li>
</ul>

<h3>Step 2: Read the Logs</h3>
<pre><code>docker logs &lt;container&gt;
docker logs --tail=100 &lt;container&gt;</code></pre>

<h3>Step 3: Check Volume Mounts</h3>
<pre><code>docker inspect &lt;container&gt; | grep -A 20 Mounts</code></pre>
<p>Missing host paths cause immediate crashes. Verify the source directory exists.</p>

<h3>Step 4: Check Port Conflicts</h3>
<pre><code>docker inspect &lt;container&gt; | grep -A 10 PortBindings
ss -tlnp | grep :8080</code></pre>
<p>If another process already occupies the port, the container will fail to bind.</p>

<h3>Step 5: Try an Interactive Shell</h3>
<pre><code>docker run -it --entrypoint sh &lt;image&gt;</code></pre>
<p>Override the entrypoint to get a shell inside the image and investigate directly.</p>`,

    `<h2>Containerul nu pornește — Ghid de depanare</h2>
<p>Când un container se oprește imediat sau refuză să pornească, codurile de ieșire și logurile spun totul.</p>

<h3>Pasul 1: Verifică codul de ieșire</h3>
<pre><code>docker inspect --format='{{.State.ExitCode}}' &lt;container&gt;</code></pre>

<h3>Coduri de ieșire comune</h3>
<ul>
  <li><strong>0</strong> — Ieșire curată (procesul s-a terminat normal)</li>
  <li><strong>1</strong> — Eroare aplicație (verifică logurile)</li>
  <li><strong>126</strong> — Permisiune refuzată (entrypoint-ul nu este executabil)</li>
  <li><strong>127</strong> — Comandă negăsită (entrypoint greșit sau PATH incorect)</li>
  <li><strong>137</strong> — Ucis de OOM killer (memorie insuficientă)</li>
  <li><strong>139</strong> — Segmentation fault (crash în cod nativ)</li>
  <li><strong>143</strong> — SIGTERM grațios (de obicei intenționat)</li>
</ul>

<h3>Pasul 2: Citește logurile</h3>
<pre><code>docker logs &lt;container&gt;
docker logs --tail=100 &lt;container&gt;</code></pre>

<h3>Pasul 3: Verifică monturile de volume</h3>
<pre><code>docker inspect &lt;container&gt; | grep -A 20 Mounts</code></pre>
<p>Căile lipsă pe host cauzează crash imediat. Verifică că directorul sursă există.</p>

<h3>Pasul 4: Verifică conflictele de porturi</h3>
<pre><code>docker inspect &lt;container&gt; | grep -A 10 PortBindings
ss -tlnp | grep :8080</code></pre>

<h3>Pasul 5: Încearcă un shell interactiv</h3>
<pre><code>docker run -it --entrypoint sh &lt;image&gt;</code></pre>
<p>Suprascrie entrypoint-ul pentru a obține un shell în interiorul imaginii și investighează direct.</p>`,
    'container-wont-start'
  );

  // ── 18. reading-logs ───────────────────────────────────────────────────────
  update.run(
    `<h2>Reading Docker Logs</h2>
<p>Container logs are your primary debugging tool. Docker captures everything written to stdout and stderr.</p>

<h3>Basic Log Commands</h3>
<pre><code># All logs
docker logs &lt;container&gt;

# Last 100 lines
docker logs --tail=100 &lt;container&gt;

# Follow in real-time (like tail -f)
docker logs -f &lt;container&gt;

# Logs since a specific time
docker logs --since="2024-01-15T10:00:00" &lt;container&gt;

# Last 30 minutes
docker logs --since=30m &lt;container&gt;</code></pre>

<h3>Docker Compose Logs</h3>
<pre><code># All services
docker compose logs

# Specific service, follow
docker compose logs -f app

# Multiple services
docker compose logs -f app db</code></pre>

<h3>Searching Log Output</h3>
<pre><code># Find errors
docker logs &lt;container&gt; 2>&amp;1 | grep -i error

# Find a specific request
docker logs &lt;container&gt; | grep "/api/users"</code></pre>

<h3>Log Drivers</h3>
<p>Docker supports multiple log drivers configured in <code>/etc/docker/daemon.json</code>:</p>
<ul>
  <li><strong>json-file</strong> — Default. Stored on disk, viewable with <code>docker logs</code></li>
  <li><strong>syslog</strong> — Sends to system syslog daemon</li>
  <li><strong>journald</strong> — Integrates with systemd journal</li>
  <li><strong>fluentd</strong> — Forwards to Fluentd aggregator</li>
  <li><strong>none</strong> — Disables logging entirely</li>
</ul>
<p><strong>Note:</strong> When using non-default drivers, <code>docker logs</code> may not work — use the driver's native tooling instead.</p>`,

    `<h2>Citirea logurilor Docker</h2>
<p>Logurile containerelor sunt principalul tău instrument de depanare. Docker capturează tot ce este scris pe stdout și stderr.</p>

<h3>Comenzi de bază pentru loguri</h3>
<pre><code># Toate logurile
docker logs &lt;container&gt;

# Ultimele 100 de linii
docker logs --tail=100 &lt;container&gt;

# Urmărire în timp real (ca tail -f)
docker logs -f &lt;container&gt;

# Loguri de la un moment specific
docker logs --since="2024-01-15T10:00:00" &lt;container&gt;

# Ultimele 30 de minute
docker logs --since=30m &lt;container&gt;</code></pre>

<h3>Loguri Docker Compose</h3>
<pre><code># Toate serviciile
docker compose logs

# Serviciu specific, urmărire
docker compose logs -f app

# Mai multe servicii
docker compose logs -f app db</code></pre>

<h3>Căutare în loguri</h3>
<pre><code># Găsește erori
docker logs &lt;container&gt; 2>&amp;1 | grep -i error

# Găsește un request specific
docker logs &lt;container&gt; | grep "/api/users"</code></pre>

<h3>Drivere de logging</h3>
<p>Docker suportă mai multe drivere configurate în <code>/etc/docker/daemon.json</code>:</p>
<ul>
  <li><strong>json-file</strong> — Implicit. Stocate pe disc, vizualizabile cu <code>docker logs</code></li>
  <li><strong>syslog</strong> — Trimite la daemon-ul syslog al sistemului</li>
  <li><strong>journald</strong> — Se integrează cu jurnalul systemd</li>
  <li><strong>fluentd</strong> — Redirecționează la agregatorul Fluentd</li>
  <li><strong>none</strong> — Dezactivează logging-ul complet</li>
</ul>
<p><strong>Notă:</strong> Când folosești drivere non-implicite, <code>docker logs</code> poate să nu funcționeze — folosește instrumentele native ale driverului.</p>`,
    'reading-logs'
  );

  // ── 19. getting-started-dd ─────────────────────────────────────────────────
  update.run(
    `<h2>Getting Started with Docker Dash</h2>
<p>Docker Dash is a self-hosted dashboard that gives you full visibility and control over your Docker environment. Here is a quick tour to get you productive in minutes.</p>

<h3>1. Open the Dashboard</h3>
<p>Navigate to <code>http://&lt;your-server&gt;:3000</code>. The main dashboard shows a real-time overview: CPU, memory, active containers, and recent events.</p>

<h3>2. Browse Your Containers</h3>
<p>Click <strong>Containers</strong> in the sidebar. From here you can start, stop, restart, and delete containers. Click a container name to view its logs, stats, environment variables, and mounts.</p>

<h3>3. Deploy a Template</h3>
<p>Go to <strong>Templates</strong> to deploy popular self-hosted apps (Nginx, PostgreSQL, Nextcloud, etc.) with a single click. Fill in environment variables and port mappings, then hit <strong>Deploy</strong>.</p>

<h3>4. Scan for Vulnerabilities</h3>
<p>Open <strong>Security → Scan</strong> and select an image. Docker Dash runs Trivy under the hood and displays CVEs grouped by severity. Fix Critical and High issues first.</p>

<h3>5. Set Up Alerts</h3>
<p>Navigate to <strong>Alerts</strong> and create a rule — for example CPU &gt; 80% for 5 minutes. Connect a notification channel (Discord, Slack, Telegram, or email) to receive instant alerts.</p>

<h3>6. Connect More Hosts</h3>
<p>Under <strong>Hosts</strong> you can add remote Docker engines via TCP, SSH tunnel, or Unix socket. Switch between hosts instantly from the top navigation bar.</p>

<p>That is the essentials. Explore the <strong>How-To</strong> knowledge base for deeper guides on each feature.</p>`,

    `<h2>Primii pași cu Docker Dash</h2>
<p>Docker Dash este un dashboard self-hosted care îți oferă vizibilitate completă și control asupra mediului Docker. Iată un tur rapid pentru a fi productiv în câteva minute.</p>

<h3>1. Deschide dashboard-ul</h3>
<p>Navighează la <code>http://&lt;serverul-tău&gt;:3000</code>. Dashboard-ul principal afișează o prezentare în timp real: CPU, memorie, containere active și evenimente recente.</p>

<h3>2. Explorează containerele</h3>
<p>Apasă pe <strong>Containers</strong> în bara laterală. De aici poți porni, opri, reporni și șterge containere. Apasă pe numele unui container pentru a vedea loguri, statistici, variabile de mediu și montaje.</p>

<h3>3. Deployează un template</h3>
<p>Mergi la <strong>Templates</strong> pentru a deploya aplicații self-hosted populare (Nginx, PostgreSQL, Nextcloud etc.) cu un singur click. Completează variabilele de mediu și mapările de porturi, apoi apasă <strong>Deploy</strong>.</p>

<h3>4. Scanează vulnerabilitățile</h3>
<p>Deschide <strong>Security → Scan</strong> și selectează o imagine. Docker Dash rulează Trivy și afișează CVE-urile grupate după severitate. Rezolvă mai întâi problemele Critice și High.</p>

<h3>5. Configurează alerte</h3>
<p>Navighează la <strong>Alerts</strong> și creează o regulă — de exemplu CPU &gt; 80% timp de 5 minute. Conectează un canal de notificare (Discord, Slack, Telegram sau email) pentru alerte instant.</p>

<h3>6. Conectează mai multe hosturi</h3>
<p>La <strong>Hosts</strong> poți adăuga motoare Docker la distanță via TCP, tunel SSH sau socket Unix. Comută între hosturi instant din bara de navigare de sus.</p>`,
    'getting-started-dd'
  );

  // ── 20. multi-host-setup ───────────────────────────────────────────────────
  update.run(
    `<h2>Multi-Host Setup Guide</h2>
<p>Docker Dash can manage multiple Docker engines from a single interface. Connect your home server, VPS, and cloud instances all in one place.</p>

<h3>Connection Methods</h3>
<ul>
  <li><strong>Unix Socket</strong> — Local Docker on the same machine. No config needed (<code>/var/run/docker.sock</code>)</li>
  <li><strong>TCP</strong> — Direct TCP connection to Docker daemon (requires daemon configured with <code>-H tcp://0.0.0.0:2375</code>)</li>
  <li><strong>SSH Tunnel</strong> — Secure connection via SSH. Recommended for remote hosts</li>
</ul>

<h3>Add a Host via SSH</h3>
<ol>
  <li>Go to <strong>Hosts → Add Host</strong></li>
  <li>Choose connection type <strong>SSH</strong></li>
  <li>Enter the server IP, SSH port (default 22), username, and your private key</li>
  <li>Click <strong>Test Connection</strong> to verify</li>
  <li>Save the host</li>
</ol>

<h3>Add a Host via TCP</h3>
<p>First, enable the TCP socket on the remote Docker daemon:</p>
<pre><code># /etc/docker/daemon.json
{
  "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"]
}</code></pre>
<p><strong>Always use TLS</strong> when exposing Docker over TCP to the internet.</p>

<h3>Switching Between Hosts</h3>
<p>Use the host selector in the top navigation bar to switch context instantly. All pages (Containers, Images, Volumes) update to show the selected host's data.</p>

<h3>Multi-Host Overview</h3>
<p>The <strong>Multi-Host Overview</strong> page shows all connected hosts at a glance — their status, container counts, and resource usage — so you can spot issues across your entire fleet.</p>`,

    `<h2>Ghid configurare Multi-Host</h2>
<p>Docker Dash poate gestiona mai multe motoare Docker dintr-o singură interfață. Conectează serverul de acasă, VPS-ul și instanțele cloud într-un singur loc.</p>

<h3>Metode de conexiune</h3>
<ul>
  <li><strong>Unix Socket</strong> — Docker local pe aceeași mașină. Fără configurare (<code>/var/run/docker.sock</code>)</li>
  <li><strong>TCP</strong> — Conexiune TCP directă la daemon-ul Docker (necesită configurarea daemon-ului cu <code>-H tcp://0.0.0.0:2375</code>)</li>
  <li><strong>Tunel SSH</strong> — Conexiune securizată via SSH. Recomandat pentru hosturi la distanță</li>
</ul>

<h3>Adaugă un host via SSH</h3>
<ol>
  <li>Mergi la <strong>Hosts → Add Host</strong></li>
  <li>Alege tipul de conexiune <strong>SSH</strong></li>
  <li>Introdu IP-ul serverului, portul SSH (implicit 22), utilizatorul și cheia privată</li>
  <li>Apasă <strong>Test Connection</strong> pentru verificare</li>
  <li>Salvează hostul</li>
</ol>

<h3>Adaugă un host via TCP</h3>
<p>Mai întâi, activează socket-ul TCP pe daemon-ul Docker de la distanță:</p>
<pre><code># /etc/docker/daemon.json
{
  "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"]
}</code></pre>
<p><strong>Folosește întotdeauna TLS</strong> când expui Docker prin TCP pe internet.</p>

<h3>Comutarea între hosturi</h3>
<p>Folosește selectorul de host din bara de navigare de sus pentru a comuta contextul instant. Toate paginile (Containers, Images, Volumes) se actualizează pentru a afișa datele hostului selectat.</p>

<h3>Prezentare generală Multi-Host</h3>
<p>Pagina <strong>Multi-Host Overview</strong> afișează toate hosturile conectate dintr-o privire — starea lor, numărul de containere și utilizarea resurselor.</p>`,
    'multi-host-setup'
  );

  // ── 21. alerts-notifications ───────────────────────────────────────────────
  update.run(
    `<h2>Setting Up Alerts &amp; Notifications</h2>
<p>Docker Dash can notify you when containers misbehave — before your users notice. Set up alert rules and notification channels in minutes.</p>

<h3>Create an Alert Rule</h3>
<ol>
  <li>Go to <strong>Alerts → Rules → New Rule</strong></li>
  <li>Choose a metric: <strong>CPU</strong>, <strong>Memory</strong>, <strong>Container Down</strong>, or <strong>Restart Count</strong></li>
  <li>Set the threshold — e.g. CPU &gt; 80%</li>
  <li>Set the duration — e.g. for 5 minutes (avoids false positives from spikes)</li>
  <li>Assign a notification channel</li>
  <li>Save and enable the rule</li>
</ol>

<h3>Add a Notification Channel</h3>
<p>Go to <strong>Alerts → Channels → Add Channel</strong> and choose your platform:</p>

<h4>Discord</h4>
<p>Create a webhook in your Discord server (Server Settings → Integrations → Webhooks) and paste the URL.</p>

<h4>Slack</h4>
<p>Create an Incoming Webhook app in Slack and paste the webhook URL.</p>

<h4>Telegram</h4>
<p>Create a bot via <code>@BotFather</code>, get the bot token, and find your chat ID with <code>@userinfobot</code>.</p>

<h4>Email</h4>
<p>Enter your SMTP server details (host, port, username, password, TLS) and a recipient address.</p>

<h3>Test the Channel</h3>
<p>After saving, click <strong>Send Test</strong>. You should receive a test message within seconds. If not, check the channel configuration and Docker Dash logs.</p>

<h3>Common Alert Rules to Start With</h3>
<ul>
  <li>CPU &gt; 85% for 5 minutes</li>
  <li>Memory &gt; 90% for 2 minutes</li>
  <li>Container status = stopped (immediate)</li>
  <li>Container restart count &gt; 3 in 10 minutes</li>
</ul>`,

    `<h2>Configurare alerte și notificări</h2>
<p>Docker Dash te poate notifica când containerele se comportă anormal — înainte ca utilizatorii să observe. Configurează reguli de alertă și canale de notificare în câteva minute.</p>

<h3>Creează o regulă de alertă</h3>
<ol>
  <li>Mergi la <strong>Alerts → Rules → New Rule</strong></li>
  <li>Alege o metrică: <strong>CPU</strong>, <strong>Memory</strong>, <strong>Container Down</strong> sau <strong>Restart Count</strong></li>
  <li>Setează pragul — ex. CPU &gt; 80%</li>
  <li>Setează durata — ex. timp de 5 minute (evită false pozitive din spike-uri)</li>
  <li>Asignează un canal de notificare</li>
  <li>Salvează și activează regula</li>
</ol>

<h3>Adaugă un canal de notificare</h3>
<p>Mergi la <strong>Alerts → Channels → Add Channel</strong> și alege platforma:</p>

<h4>Discord</h4>
<p>Creează un webhook în serverul tău Discord (Server Settings → Integrations → Webhooks) și lipește URL-ul.</p>

<h4>Slack</h4>
<p>Creează o aplicație Incoming Webhook în Slack și lipește URL-ul webhook-ului.</p>

<h4>Telegram</h4>
<p>Creează un bot via <code>@BotFather</code>, obține token-ul botului și găsește ID-ul chat-ului cu <code>@userinfobot</code>.</p>

<h4>Email</h4>
<p>Introdu detaliile serverului SMTP (host, port, utilizator, parolă, TLS) și adresa destinatarului.</p>

<h3>Testează canalul</h3>
<p>După salvare, apasă <strong>Send Test</strong>. Ar trebui să primești un mesaj de test în câteva secunde.</p>

<h3>Reguli de alertă recomandate pentru început</h3>
<ul>
  <li>CPU &gt; 85% timp de 5 minute</li>
  <li>Memory &gt; 90% timp de 2 minute</li>
  <li>Stare container = oprit (imediat)</li>
  <li>Număr de restart-uri &gt; 3 în 10 minute</li>
</ul>`,
    'alerts-notifications'
  );

  // ── 22. backup-volumes ─────────────────────────────────────────────────────
  update.run(
    `<h2>Backup Docker Volumes</h2>
<p>Named volumes store persistent data outside containers. Backing them up correctly ensures you can recover from accidental deletions, corruption, or host failures.</p>

<h3>Backup a Volume</h3>
<p>Spin up a temporary Alpine container, mount the volume and a local backup directory, then create a compressed archive:</p>
<pre><code>docker run --rm \\
  -v myvolume:/data \\
  -v $(pwd):/backup \\
  alpine tar czf /backup/myvolume-$(date +%Y%m%d).tar.gz -C /data .</code></pre>
<p>This produces a <code>.tar.gz</code> file in your current directory.</p>

<h3>Restore a Volume</h3>
<pre><code># Create the volume if it doesn't exist
docker volume create myvolume

# Extract backup into the volume
docker run --rm \\
  -v myvolume:/data \\
  -v $(pwd):/backup \\
  alpine tar xzf /backup/myvolume-20240115.tar.gz -C /data</code></pre>

<h3>Backup All Volumes at Once</h3>
<pre><code>for vol in $(docker volume ls -q); do
  docker run --rm \\
    -v $vol:/data \\
    -v $(pwd)/backups:/backup \\
    alpine tar czf /backup/$vol-$(date +%Y%m%d).tar.gz -C /data .
  echo "Backed up: $vol"
done</code></pre>

<h3>Best Practices</h3>
<ul>
  <li>Stop the container before backing up databases to ensure consistency</li>
  <li>Store backups on a different host or cloud storage</li>
  <li>Test restores periodically — a backup you've never tested is not a backup</li>
  <li>Automate with a cron job: <code>0 2 * * * /opt/backup-volumes.sh</code></li>
</ul>`,

    `<h2>Backup volume Docker</h2>
<p>Volumele numite stochează date persistente în afara containerelor. Backup-ul corect asigură că te poți recupera după ștergeri accidentale, corupere sau defecțiuni ale hostului.</p>

<h3>Backup un volum</h3>
<p>Pornește un container temporar Alpine, montează volumul și un director de backup local, apoi creează o arhivă comprimată:</p>
<pre><code>docker run --rm \\
  -v myvolume:/data \\
  -v $(pwd):/backup \\
  alpine tar czf /backup/myvolume-$(date +%Y%m%d).tar.gz -C /data .</code></pre>
<p>Aceasta produce un fișier <code>.tar.gz</code> în directorul curent.</p>

<h3>Restaurează un volum</h3>
<pre><code># Creează volumul dacă nu există
docker volume create myvolume

# Extrage backup-ul în volum
docker run --rm \\
  -v myvolume:/data \\
  -v $(pwd):/backup \\
  alpine tar xzf /backup/myvolume-20240115.tar.gz -C /data</code></pre>

<h3>Backup toate volumele simultan</h3>
<pre><code>for vol in $(docker volume ls -q); do
  docker run --rm \\
    -v $vol:/data \\
    -v $(pwd)/backups:/backup \\
    alpine tar czf /backup/$vol-$(date +%Y%m%d).tar.gz -C /data .
  echo "Backed up: $vol"
done</code></pre>

<h3>Bune practici</h3>
<ul>
  <li>Oprește containerul înainte de backup pentru bazele de date, pentru consistență</li>
  <li>Stochează backup-urile pe un host diferit sau în cloud</li>
  <li>Testează restaurarea periodic — un backup netestat nu este un backup</li>
  <li>Automatizează cu cron: <code>0 2 * * * /opt/backup-volumes.sh</code></li>
</ul>`,
    'backup-volumes'
  );

  // ── 23. backup-restore-db ──────────────────────────────────────────────────
  update.run(
    `<h2>Database Backup &amp; Restore</h2>
<p>Databases need consistent backups that capture data at a point in time. Use the native dump tools rather than volume snapshots for running databases.</p>

<h3>PostgreSQL</h3>
<pre><code># Backup
docker exec postgres_container pg_dump -U postgres mydb &gt; mydb-$(date +%Y%m%d).sql

# Compressed backup
docker exec postgres_container pg_dump -U postgres -Fc mydb &gt; mydb.dump

# Restore
docker exec -i postgres_container psql -U postgres mydb &lt; mydb-20240115.sql

# Restore from custom format
docker exec -i postgres_container pg_restore -U postgres -d mydb &lt; mydb.dump</code></pre>

<h3>MySQL / MariaDB</h3>
<pre><code># Backup
docker exec mysql_container mysqldump -u root -p'secret' mydb &gt; mydb-$(date +%Y%m%d).sql

# All databases
docker exec mysql_container mysqldump -u root -p'secret' --all-databases &gt; all-dbs.sql

# Restore
docker exec -i mysql_container mysql -u root -p'secret' mydb &lt; mydb-20240115.sql</code></pre>

<h3>MongoDB</h3>
<pre><code># Backup (creates a directory)
docker exec mongo_container mongodump --db mydb --out /dump
docker cp mongo_container:/dump ./mongo-backup-$(date +%Y%m%d)

# Restore
docker cp ./mongo-backup-20240115 mongo_container:/dump
docker exec mongo_container mongorestore --db mydb /dump/mydb</code></pre>

<h3>Automating Database Backups</h3>
<pre><code># /etc/cron.daily/docker-db-backup
#!/bin/bash
docker exec postgres_container pg_dump -U postgres mydb \\
  | gzip &gt; /backups/postgres-$(date +%Y%m%d).sql.gz
find /backups -name "postgres-*.sql.gz" -mtime +30 -delete</code></pre>`,

    `<h2>Backup și restaurare baze de date</h2>
<p>Bazele de date necesită backup-uri consistente care capturează datele la un moment în timp. Folosește instrumentele native de dump în loc de snapshot-uri de volume pentru bazele de date active.</p>

<h3>PostgreSQL</h3>
<pre><code># Backup
docker exec postgres_container pg_dump -U postgres mydb &gt; mydb-$(date +%Y%m%d).sql

# Backup comprimat
docker exec postgres_container pg_dump -U postgres -Fc mydb &gt; mydb.dump

# Restaurare
docker exec -i postgres_container psql -U postgres mydb &lt; mydb-20240115.sql

# Restaurare din format custom
docker exec -i postgres_container pg_restore -U postgres -d mydb &lt; mydb.dump</code></pre>

<h3>MySQL / MariaDB</h3>
<pre><code># Backup
docker exec mysql_container mysqldump -u root -p'secret' mydb &gt; mydb-$(date +%Y%m%d).sql

# Toate bazele de date
docker exec mysql_container mysqldump -u root -p'secret' --all-databases &gt; all-dbs.sql

# Restaurare
docker exec -i mysql_container mysql -u root -p'secret' mydb &lt; mydb-20240115.sql</code></pre>

<h3>MongoDB</h3>
<pre><code># Backup (creează un director)
docker exec mongo_container mongodump --db mydb --out /dump
docker cp mongo_container:/dump ./mongo-backup-$(date +%Y%m%d)

# Restaurare
docker cp ./mongo-backup-20240115 mongo_container:/dump
docker exec mongo_container mongorestore --db mydb /dump/mydb</code></pre>

<h3>Automatizarea backup-urilor</h3>
<pre><code># /etc/cron.daily/docker-db-backup
#!/bin/bash
docker exec postgres_container pg_dump -U postgres mydb \\
  | gzip &gt; /backups/postgres-$(date +%Y%m%d).sql.gz
find /backups -name "postgres-*.sql.gz" -mtime +30 -delete</code></pre>`,
    'backup-restore-db'
  );

  // ── 24. docker-prune ───────────────────────────────────────────────────────
  update.run(
    `<h2>Clean Up Docker Resources</h2>
<p>Docker accumulates unused images, stopped containers, dangling volumes, and stale networks over time. Regular pruning keeps disk usage in check.</p>

<h3>The Nuclear Option — Prune Everything</h3>
<pre><code># Remove all stopped containers, unused networks, dangling images, and build cache
docker system prune

# Also remove unused volumes (add -v) and ALL unused images (not just dangling)
docker system prune -a --volumes</code></pre>
<p><strong>Warning:</strong> The <code>--volumes</code> flag will delete volumes not attached to any container. Make sure you have backups first.</p>

<h3>Targeted Pruning</h3>
<pre><code># Dangling images only (untagged layers)
docker image prune

# All unused images (not referenced by any container)
docker image prune -a

# Stopped containers
docker container prune

# Unused volumes
docker volume prune

# Unused networks
docker network prune

# Build cache only
docker builder prune
docker builder prune -a  # including non-dangling cache</code></pre>

<h3>Check What Will Be Removed First</h3>
<pre><code>docker system df          # shows disk usage summary
docker system df -v       # verbose: lists each image and volume</code></pre>

<h3>Scheduled Cleanup</h3>
<p>Add a weekly cleanup cron job on your server:</p>
<pre><code># /etc/cron.weekly/docker-cleanup
#!/bin/bash
docker system prune -f
docker image prune -a -f --filter "until=720h"  # older than 30 days</code></pre>`,

    `<h2>Curățare resurse Docker</h2>
<p>Docker acumulează în timp imagini neutilizate, containere oprite, volume suspendate și rețele învechite. Curățarea regulată menține utilizarea discului sub control.</p>

<h3>Opțiunea nucleară — Curăță totul</h3>
<pre><code># Elimină toate containerele oprite, rețelele neutilizate, imaginile suspendate și cache-ul de build
docker system prune

# Include și volumele neutilizate (-v) și TOATE imaginile neutilizate
docker system prune -a --volumes</code></pre>
<p><strong>Atenție:</strong> Flag-ul <code>--volumes</code> va șterge volumele neataşate niciunui container. Asigură-te că ai backup-uri mai întâi.</p>

<h3>Curățare direcționată</h3>
<pre><code># Doar imagini suspendate (layere fără tag)
docker image prune

# Toate imaginile neutilizate
docker image prune -a

# Containere oprite
docker container prune

# Volume neutilizate
docker volume prune

# Rețele neutilizate
docker network prune

# Doar cache-ul de build
docker builder prune
docker builder prune -a</code></pre>

<h3>Verifică ce va fi eliminat</h3>
<pre><code>docker system df          # rezumat utilizare disc
docker system df -v       # detaliat: listează fiecare imagine și volum</code></pre>

<h3>Curățare programată</h3>
<p>Adaugă un cron job săptămânal pe serverul tău:</p>
<pre><code># /etc/cron.weekly/docker-cleanup
#!/bin/bash
docker system prune -f
docker image prune -a -f --filter "until=720h"  # mai vechi de 30 de zile</code></pre>`,
    'docker-prune'
  );

  // ── 25. resource-limits ────────────────────────────────────────────────────
  update.run(
    `<h2>Container Resource Limits</h2>
<p>Without limits, a single runaway container can starve all other containers and crash the host. Always set CPU and memory limits in production.</p>

<h3>Setting Limits in docker-compose.yml</h3>
<pre><code>services:
  app:
    image: myapp:latest
    deploy:
      resources:
        limits:
          cpus: '0.50'      # max 50% of one CPU core
          memory: 512M      # max 512 MB RAM
        reservations:
          cpus: '0.25'      # guaranteed minimum
          memory: 256M</code></pre>
<p><strong>Note:</strong> The <code>deploy.resources</code> syntax works for both Compose v3 and Swarm.</p>

<h3>Setting Limits with docker run</h3>
<pre><code>docker run -d \\
  --memory="512m" \\
  --memory-swap="1g" \\
  --cpus="0.5" \\
  myapp:latest</code></pre>

<h3>Monitoring Resource Usage</h3>
<pre><code># Live stats for all containers
docker stats

# One-shot snapshot (no streaming)
docker stats --no-stream

# Specific container
docker stats myapp --no-stream</code></pre>

<h3>What Happens When Limits Are Hit</h3>
<ul>
  <li><strong>Memory limit reached:</strong> The OOM killer terminates the container process (exit code 137)</li>
  <li><strong>CPU limit reached:</strong> The container is throttled — it keeps running but slower</li>
</ul>

<h3>Resource Editor in Docker Dash</h3>
<p>In Docker Dash, open a container's detail page and click <strong>Edit Resources</strong> to adjust memory and CPU limits on the fly without editing compose files manually.</p>`,

    `<h2>Limite de resurse pentru containere</h2>
<p>Fără limite, un singur container scăpat de sub control poate priva toate celelalte containere de resurse și poate crăpa hostul. Setează întotdeauna limite CPU și memorie în producție.</p>

<h3>Setarea limitelor în docker-compose.yml</h3>
<pre><code>services:
  app:
    image: myapp:latest
    deploy:
      resources:
        limits:
          cpus: '0.50'      # max 50% dintr-un core CPU
          memory: 512M      # max 512 MB RAM
        reservations:
          cpus: '0.25'      # minim garantat
          memory: 256M</code></pre>

<h3>Setarea limitelor cu docker run</h3>
<pre><code>docker run -d \\
  --memory="512m" \\
  --memory-swap="1g" \\
  --cpus="0.5" \\
  myapp:latest</code></pre>

<h3>Monitorizarea utilizării resurselor</h3>
<pre><code># Statistici live pentru toate containerele
docker stats

# Snapshot instantaneu (fără streaming)
docker stats --no-stream

# Container specific
docker stats myapp --no-stream</code></pre>

<h3>Ce se întâmplă când limitele sunt atinse</h3>
<ul>
  <li><strong>Limita de memorie atinsă:</strong> OOM killer-ul termină procesul containerului (cod de ieșire 137)</li>
  <li><strong>Limita CPU atinsă:</strong> Containerul este throttle-uit — continuă să ruleze, dar mai lent</li>
</ul>

<h3>Editorul de resurse în Docker Dash</h3>
<p>În Docker Dash, deschide pagina de detalii a unui container și apasă <strong>Edit Resources</strong> pentru a ajusta limitele de memorie și CPU din mers, fără a edita manual fișierele compose.</p>`,
    'resource-limits'
  );

  // ── 26. docker-networking-deep ─────────────────────────────────────────────
  update.run(
    `<h2>Docker Networking Deep Dive</h2>
<p>Docker offers five network drivers. Understanding how each works helps you choose the right one and debug connectivity issues.</p>

<h3>Bridge (Default)</h3>
<p>Every container gets a virtual Ethernet interface (veth pair). One end lives in the container, the other in the host's network namespace. Docker creates <code>iptables</code> rules for NAT and port forwarding.</p>
<pre><code>docker network create mynet
docker run --network mynet myapp</code></pre>
<p>Containers on the same custom bridge network can reach each other by container name (built-in DNS).</p>

<h3>Host Network</h3>
<p>The container shares the host's network namespace — no isolation, no NAT, maximum performance.</p>
<pre><code>docker run --network host nginx</code></pre>
<p>Use when: low latency is critical (high-throughput proxies, monitoring agents).</p>

<h3>Overlay (Swarm Multi-Host)</h3>
<p>Overlay networks span multiple Docker hosts using VXLAN encapsulation. Swarm services on the same overlay network can communicate by service name regardless of which node they run on.</p>
<pre><code>docker network create -d overlay --attachable myoverlay</code></pre>

<h3>Macvlan</h3>
<p>Assigns a real MAC address to the container, making it appear as a physical device on your LAN. Containers get their own IP addresses from your router's DHCP pool.</p>
<pre><code>docker network create -d macvlan \\
  --subnet=192.168.1.0/24 \\
  --gateway=192.168.1.1 \\
  -o parent=eth0 mymacvlan</code></pre>

<h3>None</h3>
<p>Completely disables networking. Use for batch processing containers that must have no network access.</p>`,

    `<h2>Rețele Docker în detaliu</h2>
<p>Docker oferă cinci drivere de rețea. Înțelegerea modului de funcționare al fiecăruia te ajută să alegi pe cel potrivit și să depanezi problemele de conectivitate.</p>

<h3>Bridge (implicit)</h3>
<p>Fiecare container primește o interfață Ethernet virtuală (pereche veth). Un capăt trăiește în container, celălalt în namespace-ul de rețea al hostului. Docker creează reguli <code>iptables</code> pentru NAT și redirecționarea porturilor.</p>
<pre><code>docker network create mynet
docker run --network mynet myapp</code></pre>
<p>Containerele din aceeași rețea bridge custom se pot contacta reciproc prin numele containerului (DNS integrat).</p>

<h3>Rețea Host</h3>
<p>Containerul împarte namespace-ul de rețea al hostului — fără izolare, fără NAT, performanță maximă.</p>
<pre><code>docker run --network host nginx</code></pre>
<p>Folosește când: latența scăzută este critică (proxy-uri de throughput ridicat, agenți de monitorizare).</p>

<h3>Overlay (Swarm Multi-Host)</h3>
<p>Rețelele overlay se extind pe mai mulți hosturi Docker folosind încapsulare VXLAN. Serviciile Swarm din aceeași rețea overlay pot comunica prin numele serviciului indiferent de nodul pe care rulează.</p>
<pre><code>docker network create -d overlay --attachable myoverlay</code></pre>

<h3>Macvlan</h3>
<p>Atribuie o adresă MAC reală containerului, făcându-l să apară ca un dispozitiv fizic în rețeaua LAN. Containerele obțin propriile adrese IP din pool-ul DHCP al router-ului.</p>
<pre><code>docker network create -d macvlan \\
  --subnet=192.168.1.0/24 \\
  --gateway=192.168.1.1 \\
  -o parent=eth0 mymacvlan</code></pre>

<h3>None</h3>
<p>Dezactivează complet rețeaua. Folosește pentru containere de procesare în lot care nu trebuie să aibă acces la rețea.</p>`,
    'docker-networking-deep'
  );

  // ── 27. dockerfile-best-practices ─────────────────────────────────────────
  update.run(
    `<h2>Dockerfile Best Practices</h2>
<p>A well-crafted Dockerfile produces smaller, faster, and more secure images. These patterns make a real difference.</p>

<h3>1. Order Layers by Change Frequency</h3>
<p>Put instructions that change rarely (dependencies) before instructions that change often (source code). Docker caches layers and rebuilds from the first changed layer.</p>
<pre><code>COPY package*.json ./      # changes rarely
RUN npm ci                 # cached until package.json changes
COPY . .                   # changes every build</code></pre>

<h3>2. Use a .dockerignore File</h3>
<pre><code>node_modules
.git
.env
*.log
dist</code></pre>
<p>Keeps the build context small and prevents secrets from leaking into the image.</p>

<h3>3. Use Multi-Stage Builds</h3>
<pre><code>FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]</code></pre>

<h3>4. Pin Base Image Versions</h3>
<pre><code># Bad
FROM node:latest

# Good
FROM node:20.11-alpine3.19</code></pre>

<h3>5. Combine RUN Commands</h3>
<pre><code># Bad — creates 3 layers
RUN apt-get update
RUN apt-get install -y curl
RUN rm -rf /var/lib/apt/lists/*

# Good — one layer
RUN apt-get update &amp;&amp; apt-get install -y curl \\
    &amp;&amp; rm -rf /var/lib/apt/lists/*</code></pre>

<h3>6. Run as Non-Root</h3>
<pre><code>RUN addgroup -S appgroup &amp;&amp; adduser -S appuser -G appgroup
USER appuser</code></pre>`,

    `<h2>Bune practici Dockerfile</h2>
<p>Un Dockerfile bine conceput produce imagini mai mici, mai rapide și mai sigure. Aceste tipare fac o diferență reală.</p>

<h3>1. Ordonează layerele după frecvența de schimbare</h3>
<p>Pune instrucțiunile care se schimbă rar (dependențe) înaintea celor care se schimbă des (cod sursă). Docker cacheauă layerele și reconstruiește de la primul layer modificat.</p>
<pre><code>COPY package*.json ./      # se schimbă rar
RUN npm ci                 # în cache până când package.json se schimbă
COPY . .                   # se schimbă la fiecare build</code></pre>

<h3>2. Folosește un fișier .dockerignore</h3>
<pre><code>node_modules
.git
.env
*.log
dist</code></pre>

<h3>3. Folosește build-uri multi-etapă</h3>
<pre><code>FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]</code></pre>

<h3>4. Fixează versiunile imaginilor de bază</h3>
<pre><code># Rău
FROM node:latest

# Bun
FROM node:20.11-alpine3.19</code></pre>

<h3>5. Combină comenzile RUN</h3>
<pre><code># Rău — creează 3 layere
RUN apt-get update
RUN apt-get install -y curl
RUN rm -rf /var/lib/apt/lists/*

# Bun — un singur layer
RUN apt-get update &amp;&amp; apt-get install -y curl \\
    &amp;&amp; rm -rf /var/lib/apt/lists/*</code></pre>

<h3>6. Rulează ca non-root</h3>
<pre><code>RUN addgroup -S appgroup &amp;&amp; adduser -S appuser -G appgroup
USER appuser</code></pre>`,
    'dockerfile-best-practices'
  );

  // ── 28. docker-logging ─────────────────────────────────────────────────────
  update.run(
    `<h2>Docker Logging Strategies</h2>
<p>Logs are essential for debugging and auditing. Docker's pluggable logging system lets you route logs wherever you need them.</p>

<h3>Default: json-file Driver</h3>
<p>By default, Docker writes container logs as JSON to files under <code>/var/lib/docker/containers/</code>. Access them with <code>docker logs</code>.</p>

<h3>Log Rotation (Critical!)</h3>
<p>Without rotation, log files grow indefinitely. Configure in <code>/etc/docker/daemon.json</code>:</p>
<pre><code>{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}</code></pre>
<p>This keeps at most 3 files of 10 MB each (30 MB max per container). Restart Docker after changing: <code>systemctl restart docker</code></p>

<h3>Per-Container Log Options in Compose</h3>
<pre><code>services:
  app:
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "5"</code></pre>

<h3>Syslog Driver</h3>
<pre><code>docker run --log-driver syslog --log-opt syslog-address=udp://logserver:514 myapp</code></pre>

<h3>Fluentd for Centralized Logging</h3>
<pre><code>docker run --log-driver fluentd \\
  --log-opt fluentd-address=localhost:24224 \\
  --log-opt tag="docker.{{.Name}}" \\
  myapp</code></pre>

<h3>Centralized Logging Stack</h3>
<p>For production, consider the <strong>ELK stack</strong> (Elasticsearch + Logstash + Kibana) or <strong>Loki + Grafana</strong> (lighter weight). Both integrate with Fluentd or the respective Docker log drivers.</p>`,

    `<h2>Strategii de logging Docker</h2>
<p>Logurile sunt esențiale pentru depanare și audit. Sistemul de logging cu plugin-uri al Docker îți permite să direcționezi logurile oriunde ai nevoie.</p>

<h3>Implicit: driverul json-file</h3>
<p>Implicit, Docker scrie logurile containerelor ca JSON în fișiere sub <code>/var/lib/docker/containers/</code>. Accesează-le cu <code>docker logs</code>.</p>

<h3>Rotația logurilor (critică!)</h3>
<p>Fără rotație, fișierele de log cresc la infinit. Configurează în <code>/etc/docker/daemon.json</code>:</p>
<pre><code>{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}</code></pre>
<p>Păstrează maximum 3 fișiere de 10 MB fiecare (30 MB max per container). Repornește Docker după modificare: <code>systemctl restart docker</code></p>

<h3>Opțiuni de log per-container în Compose</h3>
<pre><code>services:
  app:
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "5"</code></pre>

<h3>Driverul Syslog</h3>
<pre><code>docker run --log-driver syslog --log-opt syslog-address=udp://logserver:514 myapp</code></pre>

<h3>Fluentd pentru logging centralizat</h3>
<pre><code>docker run --log-driver fluentd \\
  --log-opt fluentd-address=localhost:24224 \\
  --log-opt tag="docker.{{.Name}}" \\
  myapp</code></pre>

<h3>Stack de logging centralizat</h3>
<p>Pentru producție, consideră <strong>stiva ELK</strong> (Elasticsearch + Logstash + Kibana) sau <strong>Loki + Grafana</strong> (mai ușor). Ambele se integrează cu Fluentd sau cu driverele de log Docker respective.</p>`,
    'docker-logging'
  );

  // ── 29. docker-storage-drivers ─────────────────────────────────────────────
  update.run(
    `<h2>Docker Storage Drivers</h2>
<p>Storage drivers manage how image layers are stored and stacked on disk. The choice affects performance, stability, and available features.</p>

<h3>Check Your Current Driver</h3>
<pre><code>docker info | grep "Storage Driver"</code></pre>

<h3>overlay2 — The Default and Recommended Choice</h3>
<p>Works on any Linux kernel 4.0+ with ext4 or xfs filesystems. Uses Linux's OverlayFS to efficiently stack image layers. Best performance for most workloads.</p>
<ul>
  <li>Supported on: Ubuntu, Debian, CentOS 8+, Fedora, RHEL 8+</li>
  <li>Requires: <code>d_type=true</code> on XFS (verify with <code>xfs_info / | grep ftype</code>)</li>
</ul>

<h3>btrfs</h3>
<p>Uses Btrfs filesystem's native snapshotting. Good performance for write-heavy workloads. Requires the host filesystem to be Btrfs.</p>
<pre><code>mkfs.btrfs /dev/sdb
mount /dev/sdb /var/lib/docker</code></pre>

<h3>zfs</h3>
<p>Uses ZFS native snapshots and send/receive. Excellent for data integrity and deduplication. Higher memory usage than overlay2.</p>

<h3>devicemapper (Legacy — Avoid)</h3>
<p>Older driver, deprecated in Docker 20.10+. Poor performance in loopback mode. Avoid on new installations.</p>

<h3>When to Change Storage Drivers</h3>
<ul>
  <li><strong>Stay on overlay2</strong> for the vast majority of use cases</li>
  <li><strong>Consider btrfs/zfs</strong> only if your host already runs those filesystems and you need their advanced features</li>
  <li>Changing storage drivers requires deleting all existing images and containers</li>
</ul>`,

    `<h2>Drivere de stocare Docker</h2>
<p>Driverele de stocare gestionează modul în care layerele imaginilor sunt stocate și stivuite pe disc. Alegerea afectează performanța, stabilitatea și funcționalitățile disponibile.</p>

<h3>Verifică driverul curent</h3>
<pre><code>docker info | grep "Storage Driver"</code></pre>

<h3>overlay2 — Alegerea implicită și recomandată</h3>
<p>Funcționează pe orice kernel Linux 4.0+ cu sisteme de fișiere ext4 sau xfs. Folosește OverlayFS din Linux pentru a stiva eficient layerele imaginilor. Cea mai bună performanță pentru majoritatea sarcinilor.</p>
<ul>
  <li>Suportat pe: Ubuntu, Debian, CentOS 8+, Fedora, RHEL 8+</li>
  <li>Necesită: <code>d_type=true</code> pe XFS (verifică cu <code>xfs_info / | grep ftype</code>)</li>
</ul>

<h3>btrfs</h3>
<p>Folosește snapshot-urile native ale sistemului de fișiere Btrfs. Performanță bună pentru sarcini cu scrieri intense. Necesită ca sistemul de fișiere al hostului să fie Btrfs.</p>

<h3>zfs</h3>
<p>Folosește snapshot-urile native ZFS și send/receive. Excelent pentru integritatea datelor și deduplicare. Utilizare mai mare a memoriei față de overlay2.</p>

<h3>devicemapper (Legacy — Evită)</h3>
<p>Driver mai vechi, depreciat în Docker 20.10+. Performanță slabă în modul loopback. Evită pe instalările noi.</p>

<h3>Când să schimbi driverele de stocare</h3>
<ul>
  <li><strong>Rămâi pe overlay2</strong> pentru marea majoritate a cazurilor de utilizare</li>
  <li><strong>Consideră btrfs/zfs</strong> doar dacă hostul tău rulează deja acele sisteme de fișiere</li>
  <li>Schimbarea driverelor de stocare necesită ștergerea tuturor imaginilor și containerelor existente</li>
</ul>`,
    'docker-storage-drivers'
  );

  // ── 30. docker-multi-stage ─────────────────────────────────────────────────
  update.run(
    `<h2>Multi-Stage Docker Builds</h2>
<p>Multi-stage builds let you use one image for building your app and a separate, minimal image for running it. The result: images that are 80–95% smaller.</p>

<h3>The Problem Without Multi-Stage</h3>
<p>A Go app built with the full Go toolchain image: ~850 MB. The same app in a scratch container: ~8 MB. Multi-stage builds bridge this gap.</p>

<h3>Go Application Example</h3>
<pre><code># Stage 1: Build
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o server .

# Stage 2: Runtime (scratch = zero OS overhead)
FROM scratch
COPY --from=builder /app/server /server
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
EXPOSE 8080
ENTRYPOINT ["/server"]</code></pre>
<p>Result: from ~900 MB → ~12 MB.</p>

<h3>Node.js Application Example</h3>
<pre><code>FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER node
CMD ["node", "dist/index.js"]</code></pre>

<h3>Targeting a Specific Stage</h3>
<pre><code># Build only the builder stage (useful for CI test runners)
docker build --target builder -t myapp:test .</code></pre>

<h3>Named Build Arguments Across Stages</h3>
<pre><code>ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-alpine AS builder</code></pre>`,

    `<h2>Build-uri Docker multi-etapă</h2>
<p>Build-urile multi-etapă îți permit să folosești o imagine pentru construirea aplicației și o imagine separată, minimală, pentru rularea ei. Rezultat: imagini cu 80–95% mai mici.</p>

<h3>Problema fără multi-etapă</h3>
<p>O aplicație Go construită cu imaginea completă Go toolchain: ~850 MB. Aceeași aplicație într-un container scratch: ~8 MB. Build-urile multi-etapă acoperă acest decalaj.</p>

<h3>Exemplu aplicație Go</h3>
<pre><code># Etapa 1: Build
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o server .

# Etapa 2: Runtime (scratch = zero overhead OS)
FROM scratch
COPY --from=builder /app/server /server
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
EXPOSE 8080
ENTRYPOINT ["/server"]</code></pre>
<p>Rezultat: de la ~900 MB → ~12 MB.</p>

<h3>Exemplu aplicație Node.js</h3>
<pre><code>FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER node
CMD ["node", "dist/index.js"]</code></pre>

<h3>Targetarea unei etape specifice</h3>
<pre><code># Construiește doar etapa builder (util pentru runner-e de teste CI)
docker build --target builder -t myapp:test .</code></pre>`,
    'docker-multi-stage'
  );

  // ── 31. docker-secrets ─────────────────────────────────────────────────────
  update.run(
    `<h2>Managing Secrets in Docker</h2>
<p>Secrets — passwords, API keys, certificates — must never appear in Dockerfiles, image layers, or environment variables that can be inspected with <code>docker inspect</code>.</p>

<h3>The Wrong Way (Never Do This)</h3>
<pre><code># BAD: secret baked into the image layer forever
ENV DATABASE_PASSWORD=mysecretpassword

# BAD: visible in docker inspect
docker run -e DB_PASS=secret myapp</code></pre>

<h3>Docker Swarm Secrets (Most Secure)</h3>
<pre><code># Create a secret from a file
echo "mysecretpassword" | docker secret create db_password -

# List secrets
docker secret ls

# Use in a service
docker service create \\
  --secret db_password \\
  --env DB_PASSWORD_FILE=/run/secrets/db_password \\
  myapp</code></pre>
<p>Secrets are mounted as files at <code>/run/secrets/&lt;name&gt;</code> — never stored in environment variables.</p>

<h3>Using Secrets in Docker Compose</h3>
<pre><code>services:
  app:
    image: myapp
    secrets:
      - db_password
    environment:
      DB_PASSWORD_FILE: /run/secrets/db_password

secrets:
  db_password:
    file: ./secrets/db_password.txt  # local dev only</code></pre>

<h3>.env File Best Practices</h3>
<ul>
  <li>Add <code>.env</code> to <code>.gitignore</code> — never commit it</li>
  <li>Provide a <code>.env.example</code> with dummy values for documentation</li>
  <li>Use different <code>.env</code> files per environment: <code>.env.prod</code>, <code>.env.dev</code></li>
</ul>

<h3>Scanning for Leaked Secrets</h3>
<pre><code>docker history --no-trunc myimage | grep -i password
docker inspect mycontainer | grep -i secret</code></pre>`,

    `<h2>Gestionarea secretelor în Docker</h2>
<p>Secretele — parole, chei API, certificate — nu trebuie să apară niciodată în Dockerfile-uri, layere de imagini sau variabile de mediu care pot fi inspectate cu <code>docker inspect</code>.</p>

<h3>Modul greșit (Niciodată nu face asta)</h3>
<pre><code># RĂU: secretul este copt în layerul imaginii pentru totdeauna
ENV DATABASE_PASSWORD=mysecretpassword

# RĂU: vizibil în docker inspect
docker run -e DB_PASS=secret myapp</code></pre>

<h3>Secrete Docker Swarm (cel mai sigur)</h3>
<pre><code># Creează un secret dintr-un fișier
echo "mysecretpassword" | docker secret create db_password -

# Listează secretele
docker secret ls

# Folosește într-un serviciu
docker service create \\
  --secret db_password \\
  --env DB_PASSWORD_FILE=/run/secrets/db_password \\
  myapp</code></pre>
<p>Secretele sunt montate ca fișiere la <code>/run/secrets/&lt;name&gt;</code> — niciodată stocate în variabile de mediu.</p>

<h3>Folosirea secretelor în Docker Compose</h3>
<pre><code>services:
  app:
    image: myapp
    secrets:
      - db_password
    environment:
      DB_PASSWORD_FILE: /run/secrets/db_password

secrets:
  db_password:
    file: ./secrets/db_password.txt  # doar dev local</code></pre>

<h3>Bune practici pentru fișierul .env</h3>
<ul>
  <li>Adaugă <code>.env</code> în <code>.gitignore</code> — nu-l commite niciodată</li>
  <li>Furnizează un <code>.env.example</code> cu valori dummy pentru documentație</li>
  <li>Folosește fișiere <code>.env</code> diferite per mediu: <code>.env.prod</code>, <code>.env.dev</code></li>
</ul>`,
    'docker-secrets'
  );

  // ── 32. docker-exec-debug ──────────────────────────────────────────────────
  update.run(
    `<h2>Debugging with docker exec</h2>
<p><code>docker exec</code> lets you run commands inside a running container — your most powerful debugging tool.</p>

<h3>Get an Interactive Shell</h3>
<pre><code># bash (most images)
docker exec -it mycontainer bash

# sh (Alpine and minimal images)
docker exec -it mycontainer sh

# as root (override user)
docker exec -it -u root mycontainer bash</code></pre>

<h3>Inspect Processes</h3>
<pre><code>docker exec mycontainer ps aux</code></pre>

<h3>Check Network from Inside</h3>
<pre><code>docker exec mycontainer cat /etc/hosts
docker exec mycontainer cat /etc/resolv.conf

# Ping another container by name
docker exec mycontainer ping db

# Check if a port is reachable
docker exec mycontainer nc -zv db 5432</code></pre>

<h3>Install Debug Tools on the Fly</h3>
<pre><code># Debian/Ubuntu-based
docker exec -it -u root mycontainer bash -c "apt-get update &amp;&amp; apt-get install -y curl net-tools"

# Alpine-based
docker exec -it -u root mycontainer apk add curl</code></pre>

<h3>Copy Files In/Out</h3>
<pre><code># Copy file from container to host
docker cp mycontainer:/app/config.json ./config.json

# Copy file from host to container
docker cp ./new-config.json mycontainer:/app/config.json</code></pre>

<h3>When the Container Won't Start</h3>
<p>Override the entrypoint to get a shell even if the app crashes on startup:</p>
<pre><code>docker run -it --entrypoint sh myimage</code></pre>

<h3>nsenter for Host Namespace Access</h3>
<pre><code>PID=$(docker inspect --format '{{.State.Pid}}' mycontainer)
nsenter -t $PID -n ip addr  # container's network from host</code></pre>`,

    `<h2>Depanare cu docker exec</h2>
<p><code>docker exec</code> îți permite să rulezi comenzi în interiorul unui container care rulează — cel mai puternic instrument de depanare.</p>

<h3>Obține un shell interactiv</h3>
<pre><code># bash (majoritatea imaginilor)
docker exec -it mycontainer bash

# sh (Alpine și imagini minimale)
docker exec -it mycontainer sh

# ca root (suprascrie utilizatorul)
docker exec -it -u root mycontainer bash</code></pre>

<h3>Inspectează procesele</h3>
<pre><code>docker exec mycontainer ps aux</code></pre>

<h3>Verifică rețeaua din interior</h3>
<pre><code>docker exec mycontainer cat /etc/hosts
docker exec mycontainer cat /etc/resolv.conf

# Ping alt container după nume
docker exec mycontainer ping db

# Verifică dacă un port este accesibil
docker exec mycontainer nc -zv db 5432</code></pre>

<h3>Instalează instrumente de depanare din mers</h3>
<pre><code># Bazat pe Debian/Ubuntu
docker exec -it -u root mycontainer bash -c "apt-get update &amp;&amp; apt-get install -y curl net-tools"

# Bazat pe Alpine
docker exec -it -u root mycontainer apk add curl</code></pre>

<h3>Copiază fișiere în/din container</h3>
<pre><code># Copiază fișier din container pe host
docker cp mycontainer:/app/config.json ./config.json

# Copiază fișier de pe host în container
docker cp ./new-config.json mycontainer:/app/config.json</code></pre>

<h3>Când containerul nu pornește</h3>
<p>Suprascrie entrypoint-ul pentru a obține un shell chiar dacă aplicația se oprește la pornire:</p>
<pre><code>docker run -it --entrypoint sh myimage</code></pre>`,
    'docker-exec-debug'
  );

  // ── 33. docker-registry ────────────────────────────────────────────────────
  update.run(
    `<h2>Private Docker Registry</h2>
<p>A private registry lets you store and distribute Docker images within your organization — no Docker Hub required.</p>

<h3>Run a Basic Registry</h3>
<pre><code>docker run -d \\
  --name registry \\
  -p 5000:5000 \\
  -v registry_data:/var/lib/registry \\
  --restart unless-stopped \\
  registry:2</code></pre>

<h3>Push an Image to Your Registry</h3>
<pre><code># Tag the image for your registry
docker tag myapp:latest localhost:5000/myapp:latest

# Push
docker push localhost:5000/myapp:latest

# Pull from another machine (replace localhost with your server IP)
docker pull 192.168.1.100:5000/myapp:latest</code></pre>

<h3>Configure Authentication (htpasswd)</h3>
<pre><code>mkdir auth
docker run --rm --entrypoint htpasswd httpd:2 \\
  -Bbn myuser mypassword &gt; auth/htpasswd

docker run -d \\
  --name registry \\
  -p 5000:5000 \\
  -v registry_data:/var/lib/registry \\
  -v $(pwd)/auth:/auth \\
  -e REGISTRY_AUTH=htpasswd \\
  -e REGISTRY_AUTH_HTPASSWD_REALM="Registry Realm" \\
  -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \\
  registry:2</code></pre>

<h3>Configure Docker to Trust Your Registry</h3>
<p>For HTTP (non-TLS) registries, add to <code>/etc/docker/daemon.json</code>:</p>
<pre><code>{ "insecure-registries": ["192.168.1.100:5000"] }</code></pre>
<p>Restart Docker after the change. For production, always use TLS.</p>

<h3>Use in docker-compose.yml</h3>
<pre><code>services:
  app:
    image: 192.168.1.100:5000/myapp:latest</code></pre>`,

    `<h2>Registru Docker privat</h2>
<p>Un registru privat îți permite să stochezi și să distribui imagini Docker în cadrul organizației — fără Docker Hub.</p>

<h3>Rulează un registru de bază</h3>
<pre><code>docker run -d \\
  --name registry \\
  -p 5000:5000 \\
  -v registry_data:/var/lib/registry \\
  --restart unless-stopped \\
  registry:2</code></pre>

<h3>Push o imagine în registrul tău</h3>
<pre><code># Tag-uiește imaginea pentru registrul tău
docker tag myapp:latest localhost:5000/myapp:latest

# Push
docker push localhost:5000/myapp:latest

# Pull de pe altă mașină (înlocuiește localhost cu IP-ul serverului)
docker pull 192.168.1.100:5000/myapp:latest</code></pre>

<h3>Configurează autentificarea (htpasswd)</h3>
<pre><code>mkdir auth
docker run --rm --entrypoint htpasswd httpd:2 \\
  -Bbn myuser mypassword &gt; auth/htpasswd

docker run -d \\
  --name registry \\
  -p 5000:5000 \\
  -v registry_data:/var/lib/registry \\
  -v $(pwd)/auth:/auth \\
  -e REGISTRY_AUTH=htpasswd \\
  -e REGISTRY_AUTH_HTPASSWD_REALM="Registry Realm" \\
  -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \\
  registry:2</code></pre>

<h3>Configurează Docker să aibă încredere în registrul tău</h3>
<p>Pentru registre HTTP (fără TLS), adaugă în <code>/etc/docker/daemon.json</code>:</p>
<pre><code>{ "insecure-registries": ["192.168.1.100:5000"] }</code></pre>
<p>Repornește Docker după modificare. În producție, folosește întotdeauna TLS.</p>`,
    'docker-registry'
  );

  // ── 34. docker-buildx ──────────────────────────────────────────────────────
  update.run(
    `<h2>Building Multi-Architecture Images with Buildx</h2>
<p>Docker Buildx extends the standard <code>docker build</code> with support for building images for multiple CPU architectures simultaneously — essential for supporting both x86 servers and ARM devices (Raspberry Pi, Apple Silicon).</p>

<h3>Set Up a Buildx Builder</h3>
<pre><code># Create and use a new builder instance
docker buildx create --name mybuilder --use

# Verify QEMU emulators are available
docker run --privileged --rm tonistiigi/binfmt --install all

# Inspect the builder
docker buildx inspect --bootstrap</code></pre>

<h3>Build for Multiple Platforms</h3>
<pre><code>docker buildx build \\
  --platform linux/amd64,linux/arm64,linux/arm/v7 \\
  -t myrepo/myapp:latest \\
  --push \\
  .</code></pre>
<p>The <code>--push</code> flag is required for multi-platform builds — the result is a manifest list that Docker automatically resolves to the correct architecture.</p>

<h3>Build for a Single Platform Locally</h3>
<pre><code>docker buildx build --platform linux/arm64 -t myapp:arm64 --load .</code></pre>

<h3>Check Image Architecture</h3>
<pre><code>docker manifest inspect myrepo/myapp:latest | grep architecture</code></pre>

<h3>QEMU Emulation vs. Native Builders</h3>
<p>QEMU emulation is convenient but slow. For CI pipelines, consider native ARM builder nodes for faster builds. GitHub Actions provides hosted ARM runners.</p>

<h3>GitHub Actions Example</h3>
<pre><code>- uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v5
  with:
    platforms: linux/amd64,linux/arm64
    push: true
    tags: myrepo/myapp:latest</code></pre>`,

    `<h2>Construirea imaginilor multi-arhitectură cu Buildx</h2>
<p>Docker Buildx extinde comanda standard <code>docker build</code> cu suport pentru construirea imaginilor pentru mai multe arhitecturi CPU simultan — esențial pentru suportul serverelor x86 și dispozitivelor ARM (Raspberry Pi, Apple Silicon).</p>

<h3>Configurează un builder Buildx</h3>
<pre><code># Creează și folosește o nouă instanță builder
docker buildx create --name mybuilder --use

# Verifică că emulatorii QEMU sunt disponibili
docker run --privileged --rm tonistiigi/binfmt --install all

# Inspectează builder-ul
docker buildx inspect --bootstrap</code></pre>

<h3>Construiește pentru mai multe platforme</h3>
<pre><code>docker buildx build \\
  --platform linux/amd64,linux/arm64,linux/arm/v7 \\
  -t myrepo/myapp:latest \\
  --push \\
  .</code></pre>
<p>Flag-ul <code>--push</code> este necesar pentru build-uri multi-platformă — rezultatul este o listă de manifest-uri pe care Docker o rezolvă automat la arhitectura corectă.</p>

<h3>Build pentru o singură platformă local</h3>
<pre><code>docker buildx build --platform linux/arm64 -t myapp:arm64 --load .</code></pre>

<h3>Verifică arhitectura imaginii</h3>
<pre><code>docker manifest inspect myrepo/myapp:latest | grep architecture</code></pre>

<h3>Emulare QEMU vs. builder-e native</h3>
<p>Emularea QEMU este convenabilă, dar lentă. Pentru pipeline-urile CI, consideră noduri builder ARM native pentru build-uri mai rapide. GitHub Actions oferă runner-e ARM găzduite.</p>`,
    'docker-buildx'
  );

  // ── 35. docker-init-systems ────────────────────────────────────────────────
  update.run(
    `<h2>Init Systems in Containers</h2>
<p>PID 1 is special in Linux. Understanding its responsibilities helps you avoid zombie processes and unreliable container shutdowns.</p>

<h3>The PID 1 Problem</h3>
<p>The kernel sends <code>SIGTERM</code> to PID 1 first when stopping a container. If your app doesn't handle <code>SIGTERM</code>, Docker waits 10 seconds then sends <code>SIGKILL</code>. Also, orphaned child processes are only reaped (cleaned up) if PID 1 adopts them — most apps don't do this, causing zombie processes.</p>

<h3>Solution 1: Use Docker's --init Flag</h3>
<pre><code>docker run --init myapp</code></pre>
<p>Docker injects <strong>tini</strong> as PID 1. Tini handles signal forwarding and zombie reaping automatically.</p>

<h3>Solution 2: Embed tini in Your Dockerfile</h3>
<pre><code>FROM alpine:3.19
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]</code></pre>

<h3>Solution 3: dumb-init</h3>
<pre><code>FROM ubuntu:22.04
RUN apt-get update &amp;&amp; apt-get install -y dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["python", "app.py"]</code></pre>

<h3>Solution 4: s6-overlay (For Multi-Process Containers)</h3>
<p>When you genuinely need multiple processes (e.g., nginx + PHP-FPM), <a href="https://github.com/just-containers/s6-overlay">s6-overlay</a> provides a full supervision tree with proper service management.</p>

<h3>When NOT to Use an Init System</h3>
<p>If your single-process app correctly handles SIGTERM (most modern runtimes like Node.js, Python, and Go do), <code>--init</code> may not be necessary — but it never hurts to add it.</p>`,

    `<h2>Sisteme de init în containere</h2>
<p>PID 1 este special în Linux. Înțelegerea responsabilităților sale te ajută să eviți procesele zombie și oprirea nesigură a containerelor.</p>

<h3>Problema PID 1</h3>
<p>Kernel-ul trimite <code>SIGTERM</code> la PID 1 primul când oprește un container. Dacă aplicația ta nu gestionează <code>SIGTERM</code>, Docker așteaptă 10 secunde apoi trimite <code>SIGKILL</code>. De asemenea, procesele copil orfane sunt curățate doar dacă PID 1 le adoptă — majoritatea aplicațiilor nu fac asta, cauzând procese zombie.</p>

<h3>Soluția 1: Folosește flag-ul --init al Docker</h3>
<pre><code>docker run --init myapp</code></pre>
<p>Docker injectează <strong>tini</strong> ca PID 1. Tini gestionează automat redirecționarea semnalelor și curățarea proceselor zombie.</p>

<h3>Soluția 2: Include tini în Dockerfile</h3>
<pre><code>FROM alpine:3.19
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]</code></pre>

<h3>Soluția 3: dumb-init</h3>
<pre><code>FROM ubuntu:22.04
RUN apt-get update &amp;&amp; apt-get install -y dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["python", "app.py"]</code></pre>

<h3>Soluția 4: s6-overlay (pentru containere multi-proces)</h3>
<p>Când ai cu adevărat nevoie de mai multe procese (ex. nginx + PHP-FPM), s6-overlay oferă un arbore complet de supervizare cu gestionare corectă a serviciilor.</p>

<h3>Când să NU folosești un sistem init</h3>
<p>Dacă aplicația ta cu un singur proces gestionează corect SIGTERM (cele mai moderne runtime-uri precum Node.js, Python și Go fac asta), <code>--init</code> poate să nu fie necesar — dar nu strică să îl adaugi.</p>`,
    'docker-init-systems'
  );

  // ── 36. swarm-basics ───────────────────────────────────────────────────────
  update.run(
    `<h2>Docker Swarm Basics</h2>
<p>Docker Swarm turns a group of Docker hosts into a single, fault-tolerant cluster. Services are automatically distributed and restarted across nodes.</p>

<h3>Initialize a Swarm</h3>
<pre><code># On the manager node
docker swarm init --advertise-addr 192.168.1.100</code></pre>
<p>This outputs a join command for workers. Copy it.</p>

<h3>Add Worker Nodes</h3>
<pre><code># On each worker node
docker swarm join --token SWMTKN-1-xxx 192.168.1.100:2377</code></pre>

<h3>Get the Join Token Again</h3>
<pre><code>docker swarm join-token worker
docker swarm join-token manager  # for adding more managers</code></pre>

<h3>View the Cluster</h3>
<pre><code>docker node ls</code></pre>

<h3>Deploy a Service</h3>
<pre><code>docker service create \\
  --name web \\
  --replicas 3 \\
  --publish 80:80 \\
  nginx:alpine</code></pre>

<h3>Deploy a Stack (Compose File)</h3>
<pre><code>docker stack deploy -c docker-compose.yml mystack
docker stack ls
docker stack services mystack
docker stack ps mystack</code></pre>

<h3>Visualizer (Optional)</h3>
<pre><code>docker service create \\
  --name visualizer \\
  --publish 8080:8080 \\
  --constraint node.role==manager \\
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \\
  dockersamples/visualizer</code></pre>
<p>Opens a graphical view of node/service distribution at port 8080.</p>`,

    `<h2>Bazele Docker Swarm</h2>
<p>Docker Swarm transformă un grup de hosturi Docker într-un cluster unitar, tolerant la defecțiuni. Serviciile sunt distribuite și repornite automat pe noduri.</p>

<h3>Inițializează un Swarm</h3>
<pre><code># Pe nodul manager
docker swarm init --advertise-addr 192.168.1.100</code></pre>
<p>Aceasta afișează o comandă de join pentru workeri. Copiaz-o.</p>

<h3>Adaugă noduri worker</h3>
<pre><code># Pe fiecare nod worker
docker swarm join --token SWMTKN-1-xxx 192.168.1.100:2377</code></pre>

<h3>Obține din nou token-ul de join</h3>
<pre><code>docker swarm join-token worker
docker swarm join-token manager  # pentru adăugarea mai multor manageri</code></pre>

<h3>Vizualizează clusterul</h3>
<pre><code>docker node ls</code></pre>

<h3>Deployează un serviciu</h3>
<pre><code>docker service create \\
  --name web \\
  --replicas 3 \\
  --publish 80:80 \\
  nginx:alpine</code></pre>

<h3>Deployează un stack (fișier Compose)</h3>
<pre><code>docker stack deploy -c docker-compose.yml mystack
docker stack ls
docker stack services mystack
docker stack ps mystack</code></pre>

<h3>Vizualizator (opțional)</h3>
<pre><code>docker service create \\
  --name visualizer \\
  --publish 8080:8080 \\
  --constraint node.role==manager \\
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \\
  dockersamples/visualizer</code></pre>`,
    'swarm-basics'
  );

  // ── 37. swarm-services ─────────────────────────────────────────────────────
  update.run(
    `<h2>Swarm Services &amp; Scaling</h2>
<p>Swarm services are the unit of deployment in a cluster. They manage replicas, rolling updates, and placement automatically.</p>

<h3>Scale a Service</h3>
<pre><code>docker service scale web=5
# Or equivalently:
docker service update --replicas 5 web</code></pre>

<h3>Rolling Update (Zero Downtime)</h3>
<pre><code>docker service update \\
  --image nginx:1.25-alpine \\
  --update-parallelism 2 \\
  --update-delay 10s \\
  web</code></pre>
<p>Swarm updates 2 replicas at a time, waiting 10 seconds between batches.</p>

<h3>Rollback to Previous Version</h3>
<pre><code>docker service rollback web</code></pre>

<h3>Placement Constraints</h3>
<pre><code># Only run on manager nodes
docker service create --constraint node.role==manager myapp

# Only on nodes labeled "ssd"
docker service create --constraint node.labels.disk==ssd myapp

# Add a label to a node
docker node update --label-add disk=ssd worker1</code></pre>

<h3>Global Mode (Run on Every Node)</h3>
<pre><code>docker service create --mode global \\
  --name monitoring-agent \\
  prom/node-exporter</code></pre>

<h3>Inspect a Service</h3>
<pre><code>docker service inspect --pretty web
docker service ps web          # task list with placement info
docker service logs -f web     # aggregated logs from all replicas</code></pre>

<h3>Remove a Service</h3>
<pre><code>docker service rm web</code></pre>`,

    `<h2>Servicii și scalare Swarm</h2>
<p>Serviciile Swarm sunt unitatea de deployment într-un cluster. Gestionează automat replicile, actualizările graduale și plasarea.</p>

<h3>Scalează un serviciu</h3>
<pre><code>docker service scale web=5
# Sau echivalent:
docker service update --replicas 5 web</code></pre>

<h3>Actualizare graduală (fără downtime)</h3>
<pre><code>docker service update \\
  --image nginx:1.25-alpine \\
  --update-parallelism 2 \\
  --update-delay 10s \\
  web</code></pre>
<p>Swarm actualizează 2 replici odată, așteptând 10 secunde între loturi.</p>

<h3>Rollback la versiunea anterioară</h3>
<pre><code>docker service rollback web</code></pre>

<h3>Constrângeri de plasare</h3>
<pre><code># Rulează doar pe noduri manager
docker service create --constraint node.role==manager myapp

# Doar pe noduri etichetate cu "ssd"
docker service create --constraint node.labels.disk==ssd myapp

# Adaugă o etichetă unui nod
docker node update --label-add disk=ssd worker1</code></pre>

<h3>Modul Global (rulează pe fiecare nod)</h3>
<pre><code>docker service create --mode global \\
  --name monitoring-agent \\
  prom/node-exporter</code></pre>

<h3>Inspectează un serviciu</h3>
<pre><code>docker service inspect --pretty web
docker service ps web          # lista task-urilor cu info de plasare
docker service logs -f web     # loguri agregate din toate replicile</code></pre>`,
    'swarm-services'
  );

  // ── 38. swarm-networking ───────────────────────────────────────────────────
  update.run(
    `<h2>Swarm Overlay Networks</h2>
<p>Overlay networks allow services on different physical nodes to communicate as if they were on the same local network — using VXLAN encapsulation over the existing network.</p>

<h3>Create an Overlay Network</h3>
<pre><code># Attachable allows standalone containers to also join
docker network create \\
  --driver overlay \\
  --attachable \\
  myoverlay</code></pre>

<h3>Deploy Services on the Same Overlay</h3>
<pre><code>docker service create --network myoverlay --name app myapp:latest
docker service create --network myoverlay --name db postgres:15</code></pre>
<p>The <code>app</code> service can reach <code>db</code> simply by using <code>db</code> as the hostname — Swarm's built-in DNS resolves service names to VIPs (Virtual IPs).</p>

<h3>Encrypted Overlay (for Sensitive Traffic)</h3>
<pre><code>docker network create \\
  --driver overlay \\
  --opt encrypted \\
  secure-net</code></pre>
<p>Encrypts data plane traffic between nodes using AES-GCM. Small performance overhead (~10%).</p>

<h3>Ingress Network and Routing Mesh</h3>
<p>Swarm's built-in <strong>ingress</strong> network implements a routing mesh: any published port on any node routes to any available replica — even if no replica is running on that node.</p>
<pre><code># Port 80 is reachable on ALL nodes, regardless of replica placement
docker service create --publish 80:80 --replicas 2 nginx</code></pre>

<h3>Service Discovery</h3>
<pre><code># From inside a container on the overlay
nslookup app          # resolves to VIP
nslookup tasks.app    # resolves to individual task IPs</code></pre>

<h3>Firewall Ports Required for Swarm</h3>
<ul>
  <li><strong>2377/tcp</strong> — Cluster management (manager only)</li>
  <li><strong>7946/tcp+udp</strong> — Node communication</li>
  <li><strong>4789/udp</strong> — Overlay network traffic (VXLAN)</li>
</ul>`,

    `<h2>Rețele overlay Swarm</h2>
<p>Rețelele overlay permit serviciilor de pe noduri fizice diferite să comunice ca și cum ar fi în aceeași rețea locală — folosind încapsulare VXLAN peste rețeaua existentă.</p>

<h3>Creează o rețea overlay</h3>
<pre><code># Attachable permite și containerelor standalone să se alăture
docker network create \\
  --driver overlay \\
  --attachable \\
  myoverlay</code></pre>

<h3>Deployează servicii pe același overlay</h3>
<pre><code>docker service create --network myoverlay --name app myapp:latest
docker service create --network myoverlay --name db postgres:15</code></pre>
<p>Serviciul <code>app</code> poate ajunge la <code>db</code> pur și simplu folosind <code>db</code> ca hostname — DNS-ul integrat Swarm rezolvă numele serviciilor la VIP-uri (IP-uri Virtuale).</p>

<h3>Overlay criptat (pentru trafic sensibil)</h3>
<pre><code>docker network create \\
  --driver overlay \\
  --opt encrypted \\
  secure-net</code></pre>
<p>Criptează traficul planului de date între noduri folosind AES-GCM. Overhead mic de performanță (~10%).</p>

<h3>Rețeaua Ingress și Routing Mesh</h3>
<p>Rețeaua <strong>ingress</strong> integrată în Swarm implementează un routing mesh: orice port publicat pe orice nod este rutat către orice replică disponibilă — chiar dacă pe acel nod nu rulează nicio replică.</p>
<pre><code># Portul 80 este accesibil pe TOATE nodurile
docker service create --publish 80:80 --replicas 2 nginx</code></pre>

<h3>Porturile de firewall necesare pentru Swarm</h3>
<ul>
  <li><strong>2377/tcp</strong> — Management cluster (doar manager)</li>
  <li><strong>7946/tcp+udp</strong> — Comunicare noduri</li>
  <li><strong>4789/udp</strong> — Trafic rețea overlay (VXLAN)</li>
</ul>`,
    'swarm-networking'
  );

  // ── 39. cis-benchmark ──────────────────────────────────────────────────────
  update.run(
    `<h2>CIS Docker Benchmark Guide</h2>
<p>The CIS Docker Benchmark (v1.6) is the industry standard checklist for securing Docker environments. It covers host configuration, daemon settings, image hygiene, and container runtime settings.</p>

<h3>Key Areas of the Benchmark</h3>

<h4>Section 1 — Host Configuration</h4>
<ul>
  <li>Keep the host OS and kernel up to date</li>
  <li>Only install Docker on dedicated hosts when possible</li>
  <li>Audit Docker daemon files: <code>auditctl -w /usr/bin/dockerd -k docker</code></li>
</ul>

<h4>Section 2 — Docker Daemon Configuration</h4>
<pre><code>// /etc/docker/daemon.json (CIS-recommended settings)
{
  "icc": false,              // disable inter-container communication by default
  "log-level": "info",
  "live-restore": true,      // containers keep running during daemon restart
  "userland-proxy": false,
  "no-new-privileges": true
}</code></pre>

<h4>Section 4 — Container Images</h4>
<ul>
  <li>Use official or trusted base images</li>
  <li>Do not use the <code>:latest</code> tag in production</li>
  <li>Scan images for CVEs before deployment</li>
  <li>Use non-root users inside containers</li>
</ul>

<h4>Section 5 — Container Runtime</h4>
<ul>
  <li>Do not run containers with <code>--privileged</code></li>
  <li>Do not mount sensitive host paths (<code>/etc</code>, <code>/proc</code>)</li>
  <li>Set memory and CPU limits on all containers</li>
  <li>Use read-only root filesystems: <code>--read-only</code></li>
</ul>

<h3>Docker Dash CIS Tool</h3>
<p>In Docker Dash, go to <strong>Security → CIS Benchmark</strong> to run an automated check against these rules. Each item shows pass/fail status with remediation instructions.</p>`,

    `<h2>Ghid CIS Benchmark Docker</h2>
<p>CIS Docker Benchmark (v1.6) este checklist-ul standard din industrie pentru securizarea mediilor Docker. Acoperă configurarea hostului, setările daemon-ului, igiena imaginilor și setările de runtime ale containerelor.</p>

<h3>Arii cheie ale benchmark-ului</h3>

<h4>Secțiunea 1 — Configurarea hostului</h4>
<ul>
  <li>Menține OS-ul host și kernel-ul actualizate</li>
  <li>Instalează Docker pe hosturi dedicate când este posibil</li>
  <li>Auditează fișierele daemon-ului Docker: <code>auditctl -w /usr/bin/dockerd -k docker</code></li>
</ul>

<h4>Secțiunea 2 — Configurarea Docker Daemon</h4>
<pre><code>// /etc/docker/daemon.json (setări recomandate de CIS)
{
  "icc": false,              // dezactivează comunicarea inter-container implicit
  "log-level": "info",
  "live-restore": true,      // containerele continuă să ruleze la repornirea daemon-ului
  "userland-proxy": false,
  "no-new-privileges": true
}</code></pre>

<h4>Secțiunea 4 — Imagini de containere</h4>
<ul>
  <li>Folosește imagini de bază oficiale sau de încredere</li>
  <li>Nu folosi tag-ul <code>:latest</code> în producție</li>
  <li>Scanează imaginile pentru CVE-uri înainte de deployment</li>
  <li>Folosește utilizatori non-root în interiorul containerelor</li>
</ul>

<h4>Secțiunea 5 — Runtime containere</h4>
<ul>
  <li>Nu rula containere cu <code>--privileged</code></li>
  <li>Nu monta căi sensitive ale hostului (<code>/etc</code>, <code>/proc</code>)</li>
  <li>Setează limite de memorie și CPU pe toate containerele</li>
  <li>Folosește sisteme de fișiere root read-only: <code>--read-only</code></li>
</ul>

<h3>Instrumentul CIS din Docker Dash</h3>
<p>În Docker Dash, mergi la <strong>Security → CIS Benchmark</strong> pentru a rula o verificare automată față de aceste reguli. Fiecare element afișează starea pass/fail cu instrucțiuni de remediere.</p>`,
    'cis-benchmark'
  );

  // ── 40. docker-security-scanning ───────────────────────────────────────────
  update.run(
    `<h2>Container Security Scanning</h2>
<p>Vulnerability scanning checks your images against known CVE databases, identifying OS packages and libraries that have publicly disclosed security issues.</p>

<h3>Trivy (Most Popular, Open Source)</h3>
<pre><code># Install
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh

# Scan an image
trivy image nginx:latest

# JSON output for CI
trivy image --format json --output results.json nginx:latest

# Fail CI if CRITICAL vulnerabilities found
trivy image --exit-code 1 --severity CRITICAL nginx:latest</code></pre>

<h3>Grype (Anchore, Fast)</h3>
<pre><code># Install
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh

# Scan
grype nginx:latest

# Only critical/high
grype nginx:latest --fail-on high</code></pre>

<h3>Docker Scout (Built into Docker CLI)</h3>
<pre><code>docker scout cves nginx:latest
docker scout recommendations nginx:latest  # suggests updates</code></pre>

<h3>Understanding Severity Levels</h3>
<ul>
  <li><strong>Critical</strong> — Remotely exploitable, no authentication required. Fix immediately</li>
  <li><strong>High</strong> — Significant impact, may be exploitable. Fix within days</li>
  <li><strong>Medium</strong> — Limited impact or requires complex exploitation. Plan to fix</li>
  <li><strong>Low</strong> — Minimal risk. Fix in normal maintenance cycles</li>
  <li><strong>Negligible/Unknown</strong> — Informational only</li>
</ul>

<h3>Scanning in Docker Dash</h3>
<p>Go to <strong>Security → Vulnerability Scanner</strong>, select an image, and click <strong>Scan</strong>. Results are grouped by severity with CVE IDs, affected packages, and fix versions displayed.</p>

<h3>CI Integration (GitHub Actions)</h3>
<pre><code>- name: Scan with Trivy
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: myapp:latest
    severity: CRITICAL,HIGH
    exit-code: 1</code></pre>`,

    `<h2>Scanare securitate containere</h2>
<p>Scanarea vulnerabilităților verifică imaginile tale față de bazele de date CVE cunoscute, identificând pachete OS și biblioteci cu probleme de securitate divulgate public.</p>

<h3>Trivy (cel mai popular, open source)</h3>
<pre><code># Instalare
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh

# Scanează o imagine
trivy image nginx:latest

# Output JSON pentru CI
trivy image --format json --output results.json nginx:latest

# Eșuează CI dacă există vulnerabilități CRITICAL
trivy image --exit-code 1 --severity CRITICAL nginx:latest</code></pre>

<h3>Grype (Anchore, rapid)</h3>
<pre><code># Instalare
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh

# Scanează
grype nginx:latest

# Doar critical/high
grype nginx:latest --fail-on high</code></pre>

<h3>Docker Scout (integrat în Docker CLI)</h3>
<pre><code>docker scout cves nginx:latest
docker scout recommendations nginx:latest  # sugerează actualizări</code></pre>

<h3>Înțelegerea nivelurilor de severitate</h3>
<ul>
  <li><strong>Critical</strong> — Exploatabil de la distanță, fără autentificare. Remediați imediat</li>
  <li><strong>High</strong> — Impact semnificativ, poate fi exploatabil. Remediați în zile</li>
  <li><strong>Medium</strong> — Impact limitat sau necesită exploatare complexă. Planificați remedierea</li>
  <li><strong>Low</strong> — Risc minim. Remediați în cicluri normale de întreținere</li>
</ul>

<h3>Scanare în Docker Dash</h3>
<p>Mergi la <strong>Security → Vulnerability Scanner</strong>, selectează o imagine și apasă <strong>Scan</strong>. Rezultatele sunt grupate după severitate cu ID-uri CVE, pachete afectate și versiunile de fix afișate.</p>`,
    'docker-security-scanning'
  );

  // ── 41. docker-apparmor-seccomp ────────────────────────────────────────────
  update.run(
    `<h2>AppArmor &amp; Seccomp Profiles</h2>
<p>Seccomp and AppArmor are Linux kernel security mechanisms that limit what containers can do — even if they are running as root.</p>

<h3>Seccomp — Restricting System Calls</h3>
<p>Docker applies a <strong>default seccomp profile</strong> that blocks ~44 dangerous syscalls (e.g., <code>ptrace</code>, <code>mount</code>, <code>kexec_load</code>). This works automatically without configuration.</p>

<pre><code># Verify seccomp is active
docker info | grep seccomp

# Run with no seccomp (avoid in production)
docker run --security-opt seccomp=unconfined myapp

# Run with a custom profile
docker run --security-opt seccomp=/path/to/profile.json myapp</code></pre>

<h3>Creating a Custom Seccomp Profile</h3>
<pre><code>{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": ["read", "write", "open", "close", "stat", "exit", "exit_group"],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}</code></pre>
<p>Start with the default Docker profile from GitHub and remove only what your app doesn't need.</p>

<h3>AppArmor — Restricting File System Access</h3>
<p>Docker uses the <code>docker-default</code> AppArmor profile automatically on supported systems.</p>
<pre><code># Check if AppArmor is active
aa-status

# Run with a custom profile
docker run --security-opt apparmor=my-profile myapp

# Run without AppArmor (avoid)
docker run --security-opt apparmor=unconfined myapp</code></pre>

<h3>Key --security-opt Flags</h3>
<pre><code>--security-opt no-new-privileges    # prevents privilege escalation
--security-opt seccomp=profile.json # custom syscall filter
--security-opt apparmor=myprofile   # custom AppArmor policy
--cap-drop ALL --cap-add NET_BIND_SERVICE  # drop all, add only what's needed</code></pre>`,

    `<h2>Profile AppArmor și Seccomp</h2>
<p>Seccomp și AppArmor sunt mecanisme de securitate ale kernel-ului Linux care limitează ce pot face containerele — chiar dacă rulează ca root.</p>

<h3>Seccomp — Restricționarea apelurilor de sistem</h3>
<p>Docker aplică un <strong>profil seccomp implicit</strong> care blochează ~44 syscall-uri periculoase (ex. <code>ptrace</code>, <code>mount</code>, <code>kexec_load</code>). Funcționează automat fără configurare.</p>

<pre><code># Verifică dacă seccomp este activ
docker info | grep seccomp

# Rulează fără seccomp (evită în producție)
docker run --security-opt seccomp=unconfined myapp

# Rulează cu un profil custom
docker run --security-opt seccomp=/path/to/profile.json myapp</code></pre>

<h3>Crearea unui profil seccomp custom</h3>
<pre><code>{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": ["read", "write", "open", "close", "stat", "exit", "exit_group"],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}</code></pre>
<p>Începe cu profilul Docker implicit de pe GitHub și elimină doar ce aplicația ta nu are nevoie.</p>

<h3>AppArmor — Restricționarea accesului la sistemul de fișiere</h3>
<p>Docker folosește automat profilul AppArmor <code>docker-default</code> pe sistemele suportate.</p>
<pre><code># Verifică dacă AppArmor este activ
aa-status

# Rulează cu un profil custom
docker run --security-opt apparmor=my-profile myapp</code></pre>

<h3>Flag-uri cheie --security-opt</h3>
<pre><code>--security-opt no-new-privileges    # previne escalarea privilegiilor
--security-opt seccomp=profile.json # filtru custom de syscall
--security-opt apparmor=myprofile   # politică AppArmor custom
--cap-drop ALL --cap-add NET_BIND_SERVICE  # elimină toate, adaugă doar ce e necesar</code></pre>`,
    'docker-apparmor-seccomp'
  );

  // ── 42. linux-rdp-vnc ──────────────────────────────────────────────────────
  update.run(
    `<h2>Remote Desktop (RDP/VNC) on Linux</h2>
<p>Access a graphical desktop on your Linux server from Windows, Mac, or another Linux machine.</p>

<h3>Option 1: xrdp (RDP Protocol — Windows-Friendly)</h3>
<pre><code># Install a desktop environment (if none installed)
sudo apt install -y xfce4 xfce4-goodies

# Install xrdp
sudo apt install -y xrdp
sudo systemctl enable xrdp
sudo systemctl start xrdp

# Configure xrdp to use Xfce
echo xfce4-session > ~/.xsession

# Open firewall port
sudo ufw allow 3389/tcp</code></pre>
<p>Connect from Windows: open <strong>Remote Desktop Connection</strong>, enter <code>&lt;server-ip&gt;:3389</code>, log in with your Linux username and password.</p>

<h3>Option 2: TigerVNC Server</h3>
<pre><code>sudo apt install -y tigervnc-standalone-server tigervnc-common

# Set VNC password
vncpasswd

# Start VNC server on display :1
vncserver :1 -geometry 1920x1080 -depth 24

# View VNC logs
cat ~/.vnc/*.log</code></pre>
<p>Connect with a VNC viewer (RealVNC, TigerVNC Viewer) to <code>&lt;server-ip&gt;:5901</code>.</p>

<h3>Option 3: x11vnc (Share Existing X Session)</h3>
<pre><code>sudo apt install -y x11vnc
x11vnc -display :0 -auth guess -passwd mysecret -forever -bg</code></pre>

<h3>Security Best Practices</h3>
<ul>
  <li>Tunnel RDP/VNC over SSH instead of exposing ports directly to the internet</li>
  <li>Use strong passwords or certificate authentication</li>
  <li>Consider a VPN for access to home/office servers</li>
</ul>
<pre><code># SSH tunnel for VNC (run on client)
ssh -L 5901:localhost:5901 user@server</code></pre>`,

    `<h2>Desktop la distanță (RDP/VNC) pe Linux</h2>
<p>Accesează un desktop grafic pe serverul Linux din Windows, Mac sau altă mașină Linux.</p>

<h3>Opțiunea 1: xrdp (Protocol RDP — prieten cu Windows)</h3>
<pre><code># Instalează un mediu desktop (dacă nu există)
sudo apt install -y xfce4 xfce4-goodies

# Instalează xrdp
sudo apt install -y xrdp
sudo systemctl enable xrdp
sudo systemctl start xrdp

# Configurează xrdp să folosească Xfce
echo xfce4-session > ~/.xsession

# Deschide portul firewall
sudo ufw allow 3389/tcp</code></pre>
<p>Conectare din Windows: deschide <strong>Conexiune Desktop la distanță</strong>, introdu <code>&lt;ip-server&gt;:3389</code>, loghează-te cu utilizatorul și parola Linux.</p>

<h3>Opțiunea 2: TigerVNC Server</h3>
<pre><code>sudo apt install -y tigervnc-standalone-server tigervnc-common

# Setează parola VNC
vncpasswd

# Pornește serverul VNC pe display :1
vncserver :1 -geometry 1920x1080 -depth 24</code></pre>
<p>Conectează-te cu un viewer VNC (RealVNC, TigerVNC Viewer) la <code>&lt;ip-server&gt;:5901</code>.</p>

<h3>Opțiunea 3: x11vnc (Partajează sesiunea X existentă)</h3>
<pre><code>sudo apt install -y x11vnc
x11vnc -display :0 -auth guess -passwd mysecret -forever -bg</code></pre>

<h3>Bune practici de securitate</h3>
<ul>
  <li>Tunelizează RDP/VNC prin SSH în loc să expui porturile direct pe internet</li>
  <li>Folosește parole puternice sau autentificare cu certificat</li>
  <li>Consideră un VPN pentru acces la servere de acasă/birou</li>
</ul>
<pre><code># Tunel SSH pentru VNC (rulează pe client)
ssh -L 5901:localhost:5901 user@server</code></pre>`,
    'linux-rdp-vnc'
  );

  // ── 43. linux-samba ────────────────────────────────────────────────────────
  update.run(
    `<h2>Samba File Sharing on Linux</h2>
<p>Samba implements the SMB/CIFS protocol, letting you share folders from Linux to Windows, Mac, and other Linux machines — they appear as network drives.</p>

<h3>Install Samba</h3>
<pre><code>sudo apt update
sudo apt install -y samba samba-common-bin</code></pre>

<h3>Create a Share Directory</h3>
<pre><code>sudo mkdir -p /srv/samba/shared
sudo chmod 775 /srv/samba/shared
sudo chown $USER:$USER /srv/samba/shared</code></pre>

<h3>Configure /etc/samba/smb.conf</h3>
<pre><code>[global]
   workgroup = WORKGROUP
   server string = My Linux Server
   security = user
   map to guest = bad user

[Shared]
   path = /srv/samba/shared
   browseable = yes
   read only = no
   valid users = sambauser
   create mask = 0664
   directory mask = 0775</code></pre>

<h3>Create a Samba User</h3>
<pre><code># User must exist on the system first
sudo useradd -M sambauser
sudo smbpasswd -a sambauser
sudo smbpasswd -e sambauser  # enable the user</code></pre>

<h3>Restart and Enable Samba</h3>
<pre><code>sudo systemctl restart smbd nmbd
sudo systemctl enable smbd nmbd
sudo ufw allow samba</code></pre>

<h3>Connect from Windows</h3>
<p>Open File Explorer, type <code>\\&lt;server-ip&gt;\Shared</code> in the address bar, enter the Samba credentials when prompted.</p>

<h3>Connect from Linux</h3>
<pre><code>sudo apt install smbclient
smbclient //server-ip/Shared -U sambauser

# Mount as a network drive
sudo mount -t cifs //server-ip/Shared /mnt/share -o username=sambauser</code></pre>`,

    `<h2>Partajare fișiere Samba pe Linux</h2>
<p>Samba implementează protocolul SMB/CIFS, permițându-ți să partajezi foldere din Linux către Windows, Mac și alte mașini Linux — apar ca unități de rețea.</p>

<h3>Instalează Samba</h3>
<pre><code>sudo apt update
sudo apt install -y samba samba-common-bin</code></pre>

<h3>Creează un director de partajare</h3>
<pre><code>sudo mkdir -p /srv/samba/shared
sudo chmod 775 /srv/samba/shared
sudo chown $USER:$USER /srv/samba/shared</code></pre>

<h3>Configurează /etc/samba/smb.conf</h3>
<pre><code>[global]
   workgroup = WORKGROUP
   server string = My Linux Server
   security = user
   map to guest = bad user

[Shared]
   path = /srv/samba/shared
   browseable = yes
   read only = no
   valid users = sambauser
   create mask = 0664
   directory mask = 0775</code></pre>

<h3>Creează un utilizator Samba</h3>
<pre><code># Utilizatorul trebuie să existe mai întâi în sistem
sudo useradd -M sambauser
sudo smbpasswd -a sambauser
sudo smbpasswd -e sambauser  # activează utilizatorul</code></pre>

<h3>Repornește și activează Samba</h3>
<pre><code>sudo systemctl restart smbd nmbd
sudo systemctl enable smbd nmbd
sudo ufw allow samba</code></pre>

<h3>Conectare din Windows</h3>
<p>Deschide File Explorer, tastează <code>\\&lt;ip-server&gt;\Shared</code> în bara de adrese, introdu credențialele Samba când ești solicitat.</p>

<h3>Conectare din Linux</h3>
<pre><code>sudo apt install smbclient
smbclient //ip-server/Shared -U sambauser

# Montează ca unitate de rețea
sudo mount -t cifs //ip-server/Shared /mnt/share -o username=sambauser</code></pre>`,
    'linux-samba'
  );

  // ── 44. linux-sftp ─────────────────────────────────────────────────────────
  update.run(
    `<h2>SFTP Server Setup</h2>
<p>SFTP (SSH File Transfer Protocol) is built into OpenSSH — no extra software needed. It's the most secure way to transfer files to/from a Linux server.</p>

<h3>OpenSSH Already Includes SFTP</h3>
<pre><code># Check if SSH is running
sudo systemctl status sshd

# Test SFTP (you're probably already done!)
sftp username@server</code></pre>

<h3>Create a Dedicated SFTP-Only User</h3>
<pre><code># Create user with no login shell
sudo useradd -m -s /usr/sbin/nologin sftpuser
sudo passwd sftpuser

# Create upload directory
sudo mkdir -p /home/sftpuser/uploads
sudo chown sftpuser:sftpuser /home/sftpuser/uploads</code></pre>

<h3>Chroot Jail (Restrict User to Home Directory)</h3>
<p>Add to the bottom of <code>/etc/ssh/sshd_config</code>:</p>
<pre><code>Match User sftpuser
    ForceCommand internal-sftp
    ChrootDirectory /home/sftpuser
    PasswordAuthentication yes
    AllowTcpForwarding no
    X11Forwarding no</code></pre>
<pre><code>sudo systemctl restart sshd</code></pre>
<p><strong>Note:</strong> The chroot directory must be owned by <code>root</code>:</p>
<pre><code>sudo chown root:root /home/sftpuser</code></pre>

<h3>Connect with sftp Command</h3>
<pre><code>sftp sftpuser@server
sftp> ls
sftp> put localfile.txt
sftp> get remotefile.txt
sftp> exit</code></pre>

<h3>Connect with FileZilla</h3>
<p>Host: <code>sftp://server-ip</code>, Port: <code>22</code>, Protocol: SFTP, User/Password as set above. FileZilla supports both password and key-based authentication.</p>`,

    `<h2>Configurare server SFTP</h2>
<p>SFTP (SSH File Transfer Protocol) este inclus în OpenSSH — nu necesită software suplimentar. Este cea mai sigură modalitate de transfer de fișiere către/de pe un server Linux.</p>

<h3>OpenSSH include deja SFTP</h3>
<pre><code># Verifică dacă SSH rulează
sudo systemctl status sshd

# Testează SFTP (probabil ești deja gata!)
sftp username@server</code></pre>

<h3>Creează un utilizator dedicat doar pentru SFTP</h3>
<pre><code># Creează utilizator fără shell de login
sudo useradd -m -s /usr/sbin/nologin sftpuser
sudo passwd sftpuser

# Creează directorul de upload
sudo mkdir -p /home/sftpuser/uploads
sudo chown sftpuser:sftpuser /home/sftpuser/uploads</code></pre>

<h3>Chroot Jail (restricționează utilizatorul la directorul home)</h3>
<p>Adaugă la sfârșitul fișierului <code>/etc/ssh/sshd_config</code>:</p>
<pre><code>Match User sftpuser
    ForceCommand internal-sftp
    ChrootDirectory /home/sftpuser
    PasswordAuthentication yes
    AllowTcpForwarding no
    X11Forwarding no</code></pre>
<pre><code>sudo systemctl restart sshd</code></pre>
<p><strong>Notă:</strong> Directorul chroot trebuie să fie deținut de <code>root</code>:</p>
<pre><code>sudo chown root:root /home/sftpuser</code></pre>

<h3>Conectare cu comanda sftp</h3>
<pre><code>sftp sftpuser@server
sftp> ls
sftp> put fisier-local.txt
sftp> get fisier-remote.txt
sftp> exit</code></pre>

<h3>Conectare cu FileZilla</h3>
<p>Host: <code>sftp://ip-server</code>, Port: <code>22</code>, Protocol: SFTP, utilizator/parolă conform celor setate. FileZilla suportă atât autentificarea cu parolă, cât și cu cheie.</p>`,
    'linux-sftp'
  );

  // ── 45. linux-firewall ─────────────────────────────────────────────────────
  update.run(
    `<h2>Linux Firewall (UFW/iptables)</h2>
<p>UFW (Uncomplicated Firewall) is the recommended front-end for iptables on Ubuntu/Debian. However, Docker has a known bypass issue you must understand before relying on UFW alone.</p>

<h3>Basic UFW Setup</h3>
<pre><code># Enable UFW
sudo ufw enable

# Default: deny all incoming, allow all outgoing
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH (do this BEFORE enabling UFW!)
sudo ufw allow ssh
sudo ufw allow 22/tcp

# Allow specific ports
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp

# Check status
sudo ufw status verbose

# Delete a rule
sudo ufw delete allow 3000/tcp</code></pre>

<h3>The Docker/UFW Bypass Problem</h3>
<p><strong>Critical:</strong> Docker modifies iptables directly and bypasses UFW rules for published ports. A container with <code>-p 8080:8080</code> is exposed to the internet even if UFW blocks port 8080!</p>

<h3>Fix: Use the DOCKER-USER Chain</h3>
<p>Add rules to the <code>DOCKER-USER</code> iptables chain — Docker reads these but UFW doesn't overwrite them:</p>
<pre><code># Block all access to Docker ports except from a trusted IP
sudo iptables -I DOCKER-USER -i eth0 ! -s 192.168.1.0/24 -j DROP

# Save iptables rules
sudo apt install -y iptables-persistent
sudo netfilter-persistent save</code></pre>

<h3>Alternative Fix: Bind to Localhost Only</h3>
<pre><code># In docker-compose.yml — only accessible from the host itself
ports:
  - "127.0.0.1:8080:8080"</code></pre>
<p>Then use a reverse proxy (Nginx/Traefik) to handle external traffic.</p>`,

    `<h2>Firewall Linux (UFW/iptables)</h2>
<p>UFW (Uncomplicated Firewall) este front-end-ul recomandat pentru iptables pe Ubuntu/Debian. Totuși, Docker are o problemă de bypass cunoscută pe care trebuie să o înțelegi înainte de a te baza doar pe UFW.</p>

<h3>Configurare de bază UFW</h3>
<pre><code># Activează UFW
sudo ufw enable

# Implicit: refuză tot incoming, permite tot outgoing
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Permite SSH (fă asta ÎNAINTE de a activa UFW!)
sudo ufw allow ssh
sudo ufw allow 22/tcp

# Permite porturi specifice
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp

# Verifică starea
sudo ufw status verbose

# Șterge o regulă
sudo ufw delete allow 3000/tcp</code></pre>

<h3>Problema bypass Docker/UFW</h3>
<p><strong>Critic:</strong> Docker modifică iptables direct și ocolește regulile UFW pentru porturile publicate. Un container cu <code>-p 8080:8080</code> este expus pe internet chiar dacă UFW blochează portul 8080!</p>

<h3>Remediere: Folosește lanțul DOCKER-USER</h3>
<p>Adaugă reguli la lanțul iptables <code>DOCKER-USER</code> — Docker le citește, dar UFW nu le suprascrie:</p>
<pre><code># Blochează accesul la porturile Docker cu excepția unui IP de încredere
sudo iptables -I DOCKER-USER -i eth0 ! -s 192.168.1.0/24 -j DROP

# Salvează regulile iptables
sudo apt install -y iptables-persistent
sudo netfilter-persistent save</code></pre>

<h3>Remediere alternativă: Leagă la localhost</h3>
<pre><code># În docker-compose.yml — accesibil doar de pe host
ports:
  - "127.0.0.1:8080:8080"</code></pre>
<p>Apoi folosește un reverse proxy (Nginx/Traefik) pentru traficul extern.</p>`,
    'linux-firewall'
  );

  // ── 46. linux-systemd ──────────────────────────────────────────────────────
  update.run(
    `<h2>Systemd Service Management</h2>
<p>Systemd is the init system and service manager on most modern Linux distributions. Mastering a handful of commands covers the vast majority of daily tasks.</p>

<h3>Essential Service Commands</h3>
<pre><code>sudo systemctl start nginx       # start a service
sudo systemctl stop nginx        # stop a service
sudo systemctl restart nginx     # stop then start
sudo systemctl reload nginx      # reload config without stopping

sudo systemctl enable nginx      # start on boot
sudo systemctl disable nginx     # don't start on boot

sudo systemctl status nginx      # check status + recent logs
sudo systemctl is-active nginx   # active / inactive
sudo systemctl is-enabled nginx  # enabled / disabled</code></pre>

<h3>Viewing Logs with journalctl</h3>
<pre><code>journalctl -u nginx              # all logs for nginx
journalctl -u nginx -f           # follow (live tail)
journalctl -u nginx --since "1 hour ago"
journalctl -u nginx -n 50        # last 50 lines
journalctl -p err -u nginx       # errors only
journalctl --disk-usage          # how much space logs use</code></pre>

<h3>Create a Custom Service Unit</h3>
<p>Create <code>/etc/systemd/system/myapp.service</code>:</p>
<pre><code>[Unit]
Description=My Application
After=network.target

[Service]
Type=simple
User=myuser
WorkingDirectory=/opt/myapp
ExecStart=/opt/myapp/myapp --port 8080
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target</code></pre>
<pre><code>sudo systemctl daemon-reload      # reload unit files
sudo systemctl enable --now myapp # enable and start immediately</code></pre>

<h3>Timer Units (Cron Replacement)</h3>
<p>Create <code>/etc/systemd/system/backup.timer</code>:</p>
<pre><code>[Unit]
Description=Daily Backup Timer

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target</code></pre>
<pre><code>sudo systemctl enable --now backup.timer
systemctl list-timers  # list all active timers</code></pre>`,

    `<h2>Gestionarea serviciilor cu Systemd</h2>
<p>Systemd este sistemul init și managerul de servicii pe majoritatea distribuțiilor Linux moderne. Stăpânirea câtorva comenzi acoperă marea majoritate a sarcinilor zilnice.</p>

<h3>Comenzi esențiale pentru servicii</h3>
<pre><code>sudo systemctl start nginx       # pornește un serviciu
sudo systemctl stop nginx        # oprește un serviciu
sudo systemctl restart nginx     # oprește apoi pornește
sudo systemctl reload nginx      # reîncarcă config fără oprire

sudo systemctl enable nginx      # pornește la boot
sudo systemctl disable nginx     # nu porni la boot

sudo systemctl status nginx      # verifică starea + loguri recente
sudo systemctl is-active nginx   # active / inactive
sudo systemctl is-enabled nginx  # enabled / disabled</code></pre>

<h3>Vizualizarea logurilor cu journalctl</h3>
<pre><code>journalctl -u nginx              # toate logurile pentru nginx
journalctl -u nginx -f           # urmărire live
journalctl -u nginx --since "1 hour ago"
journalctl -u nginx -n 50        # ultimele 50 de linii
journalctl -p err -u nginx       # doar erori
journalctl --disk-usage          # cât spațiu folosesc logurile</code></pre>

<h3>Creează o unitate de serviciu custom</h3>
<p>Creează <code>/etc/systemd/system/myapp.service</code>:</p>
<pre><code>[Unit]
Description=Aplicatia Mea
After=network.target

[Service]
Type=simple
User=myuser
WorkingDirectory=/opt/myapp
ExecStart=/opt/myapp/myapp --port 8080
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target</code></pre>
<pre><code>sudo systemctl daemon-reload        # reîncarcă fișierele de unitate
sudo systemctl enable --now myapp   # activează și pornește imediat</code></pre>

<h3>Unități Timer (înlocuitor pentru Cron)</h3>
<p>Creează <code>/etc/systemd/system/backup.timer</code>:</p>
<pre><code>[Unit]
Description=Timer backup zilnic

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target</code></pre>
<pre><code>sudo systemctl enable --now backup.timer
systemctl list-timers  # listează toți timerii activi</code></pre>`,
    'linux-systemd'
  );
};
