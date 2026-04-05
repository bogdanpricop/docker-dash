'use strict';

// Batch 1: full HTML content for the first 15 built-in How-To guides
exports.up = function (db) {
  const update = db.prepare('UPDATE howto_guides SET content = ?, content_ro = ? WHERE slug = ?');

  // ─── 1. install-docker ────────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Install Docker on Ubuntu / Debian</h2>
<p>The recommended way is to add Docker's official APT repository so you always get the latest stable engine.</p>
<pre><code># Remove old conflicting packages (safe to run even if not installed)
sudo apt-get remove -y docker docker-engine docker.io containerd runc

# Install prerequisites
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# Add Docker's GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin</code></pre>

<h3>Verify the installation</h3>
<pre><code>sudo docker run hello-world</code></pre>
<p>You should see a "Hello from Docker!" message. To run Docker without <code>sudo</code>, add your user to the docker group:</p>
<pre><code>sudo usermod -aG docker $USER
# Log out and back in, then test:
docker run hello-world</code></pre>

<h2>CentOS / RHEL / Fedora</h2>
<pre><code>sudo dnf install -y yum-utils
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker</code></pre>

<h2>Alpine Linux</h2>
<pre><code>apk add docker docker-compose
rc-update add docker default
service docker start</code></pre>`,

    /* RO */
    `<h2>Instalare Docker pe Ubuntu / Debian</h2>
<p>Metoda recomandată este să adaugi repository-ul APT oficial Docker pentru a primi întotdeauna ultima versiune stabilă.</p>
<pre><code># Elimină pachetele vechi conflictuale
sudo apt-get remove -y docker docker-engine docker.io containerd runc

# Instalează dependențele necesare
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# Adaugă cheia GPG Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Adaugă repository-ul
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Instalează Docker Engine
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin</code></pre>

<h3>Verifică instalarea</h3>
<pre><code>sudo docker run hello-world</code></pre>
<p>Ar trebui să vezi mesajul "Hello from Docker!". Pentru a rula Docker fără <code>sudo</code>, adaugă utilizatorul în grupul docker:</p>
<pre><code>sudo usermod -aG docker $USER
# Deconectează-te și reconectează-te, apoi testează:
docker run hello-world</code></pre>

<h2>CentOS / RHEL / Fedora</h2>
<pre><code>sudo dnf install -y yum-utils
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker</code></pre>

<h2>Alpine Linux</h2>
<pre><code>apk add docker docker-compose
rc-update add docker default
service docker start</code></pre>`,

    'install-docker'
  );

  // ─── 2. images-vs-containers ─────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Images vs Containers</h2>
<p>Think of a <strong>Docker image</strong> as a class definition in code — it's a read-only template that describes everything needed to run an application: the OS layer, runtime, dependencies, and your app files. A <strong>container</strong> is a running instance of that image, just like an object is an instance of a class.</p>

<h2>Working with images</h2>
<pre><code># Download an image from Docker Hub (does NOT run it)
docker pull nginx:alpine

# List locally available images
docker images

# Remove an image
docker rmi nginx:alpine</code></pre>

<h2>Working with containers</h2>
<pre><code># Create AND start a container from an image
docker run -d -p 8080:80 --name my-nginx nginx:alpine

# List running containers
docker ps

# List ALL containers (including stopped)
docker ps -a

# Stop / start / remove a container
docker stop my-nginx
docker start my-nginx
docker rm my-nginx</code></pre>

<h2>How image layers work</h2>
<p>Images are built in <strong>layers</strong>. Each instruction in a Dockerfile adds a layer. Layers are cached and shared between images, so pulling <code>nginx:alpine</code> and <code>node:alpine</code> reuses the shared Alpine base layer — saving both disk space and download time.</p>
<pre><code># Inspect layers of an image
docker history nginx:alpine</code></pre>

<h3>Key takeaway</h3>
<ul>
  <li>Images are <strong>immutable</strong> — you never change a running container's image.</li>
  <li>Containers are <strong>ephemeral</strong> by default — data written inside is lost when the container is removed. Use <strong>volumes</strong> to persist data.</li>
  <li>One image can spawn many containers simultaneously.</li>
</ul>`,

    /* RO */
    `<h2>Imagini vs Containere</h2>
<p>Gândește-te la o <strong>imagine Docker</strong> ca la o definiție de clasă — este un șablon read-only care descrie tot ce e necesar pentru a rula o aplicație: stratul de OS, runtime, dependențe și fișierele aplicației. Un <strong>container</strong> este o instanță activă a acelei imagini, la fel cum un obiect este o instanță a unei clase.</p>

<h2>Lucrul cu imagini</h2>
<pre><code># Descarcă o imagine de pe Docker Hub (NU o rulează)
docker pull nginx:alpine

# Listează imaginile disponibile local
docker images

# Șterge o imagine
docker rmi nginx:alpine</code></pre>

<h2>Lucrul cu containere</h2>
<pre><code># Creează ȘI pornește un container dintr-o imagine
docker run -d -p 8080:80 --name my-nginx nginx:alpine

# Listează containerele care rulează
docker ps

# Listează TOATE containerele (inclusiv cele oprite)
docker ps -a

# Oprește / pornește / șterge un container
docker stop my-nginx
docker start my-nginx
docker rm my-nginx</code></pre>

<h2>Cum funcționează straturile imaginii</h2>
<p>Imaginile sunt construite în <strong>straturi</strong>. Fiecare instrucțiune dintr-un Dockerfile adaugă un strat. Straturile sunt cache-uite și partajate între imagini — descărcarea <code>nginx:alpine</code> și <code>node:alpine</code> reutilizează stratul Alpine de bază, economisind spațiu și timp.</p>
<pre><code># Inspectează straturile unei imagini
docker history nginx:alpine</code></pre>

<h3>Concluzie cheie</h3>
<ul>
  <li>Imaginile sunt <strong>imutabile</strong> — nu modifici imaginea unui container care rulează.</li>
  <li>Containerele sunt <strong>efemere</strong> implicit — datele scrise în interior se pierd la ștergere. Folosește <strong>volume</strong> pentru persistență.</li>
  <li>O singură imagine poate genera mai multe containere simultan.</li>
</ul>`,

    'images-vs-containers'
  );

  // ─── 3. docker-volumes ───────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Docker Volumes Explained</h2>
<p>Containers are ephemeral — when a container is removed, its writable layer disappears. <strong>Volumes</strong> and <strong>bind mounts</strong> are the two ways to persist data outside the container lifecycle.</p>

<h2>Named volumes (recommended)</h2>
<p>Docker manages named volumes in <code>/var/lib/docker/volumes/</code>. They survive container removal and can be shared between containers.</p>
<pre><code># Create a named volume
docker volume create mydata

# Run a container using it
docker run -d -v mydata:/var/lib/postgresql/data postgres:16

# List volumes
docker volume ls

# Inspect a volume (shows mount path)
docker volume inspect mydata</code></pre>

<h2>Bind mounts</h2>
<p>Bind mounts map a <strong>host directory</strong> directly into the container. Useful for development (live code reloading) but less portable.</p>
<pre><code># Mount the current directory as /app inside the container
docker run -d -v $(pwd)/src:/app node:20-alpine</code></pre>

<h2>Volumes in Docker Compose</h2>
<pre><code>services:
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:</code></pre>

<h2>Backup a volume</h2>
<pre><code># Tar the volume contents into the current directory
docker run --rm \
  -v mydata:/data \
  -v $(pwd):/backup \
  busybox tar czf /backup/mydata-backup.tar.gz -C /data .</code></pre>

<h2>Restore a backup</h2>
<pre><code>docker run --rm \
  -v mydata:/data \
  -v $(pwd):/backup \
  busybox tar xzf /backup/mydata-backup.tar.gz -C /data</code></pre>`,

    /* RO */
    `<h2>Volume Docker explicate</h2>
<p>Containerele sunt efemere — la ștergere, stratul lor de scriere dispare. <strong>Volumele</strong> și <strong>bind mount-urile</strong> sunt cele două metode de a persista date în afara ciclului de viață al containerului.</p>

<h2>Volume cu nume (recomandat)</h2>
<p>Docker gestionează volumele cu nume în <code>/var/lib/docker/volumes/</code>. Supraviețuiesc ștergerii containerelor și pot fi partajate între containere.</p>
<pre><code># Creează un volum cu nume
docker volume create mydata

# Rulează un container folosindu-l
docker run -d -v mydata:/var/lib/postgresql/data postgres:16

# Listează volumele
docker volume ls

# Inspectează un volum (arată calea de montare)
docker volume inspect mydata</code></pre>

<h2>Bind mounts</h2>
<p>Bind mount-urile mapează direct un <strong>director de pe host</strong> în container. Utile pentru dezvoltare (reîncărcare live a codului), dar mai puțin portabile.</p>
<pre><code># Montează directorul curent ca /app în container
docker run -d -v $(pwd)/src:/app node:20-alpine</code></pre>

<h2>Volume în Docker Compose</h2>
<pre><code>services:
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:</code></pre>

<h2>Backup pentru un volum</h2>
<pre><code># Arhivează conținutul volumului în directorul curent
docker run --rm \
  -v mydata:/data \
  -v $(pwd):/backup \
  busybox tar czf /backup/mydata-backup.tar.gz -C /data .</code></pre>

<h2>Restaurare din backup</h2>
<pre><code>docker run --rm \
  -v mydata:/data \
  -v $(pwd):/backup \
  busybox tar xzf /backup/mydata-backup.tar.gz -C /data</code></pre>`,

    'docker-volumes'
  );

  // ─── 4. linux-commands ───────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Essential Linux Commands</h2>
<p>These 20 commands cover the operations you'll use daily when managing a Docker host.</p>

<h2>File system</h2>
<pre><code>ls -lah            # List files with sizes (human-readable)
cd /var/log        # Change directory
pwd                # Print current directory
cp file1 file2     # Copy file
mv old new         # Move / rename file
rm -rf dir/        # Delete file or directory (careful with -rf!)
mkdir -p a/b/c     # Create nested directories
cat file.txt       # Print file contents
less file.txt      # Scroll through file (q to quit)</code></pre>

<h2>Processes</h2>
<pre><code>ps aux             # List all running processes
top                # Live process monitor (q to quit)
htop               # Better top (install: apt install htop)
kill -9 1234       # Force-kill process with PID 1234
pkill nginx        # Kill by process name</code></pre>

<h2>Networking</h2>
<pre><code>ip addr            # Show network interfaces and IPs
ss -tlnp           # Show listening TCP sockets with PIDs
curl -I https://example.com   # HTTP headers only
ping -c 4 8.8.8.8  # Test reachability</code></pre>

<h2>Disk &amp; memory</h2>
<pre><code>df -h              # Disk usage per filesystem
du -sh /var/lib/docker   # Size of a specific directory
free -h            # RAM and swap usage
uname -r           # Kernel version</code></pre>

<h3>Tips</h3>
<ul>
  <li>Prefix any command with <code>sudo</code> to run as root.</li>
  <li>Press <strong>Ctrl+C</strong> to interrupt a running command.</li>
  <li>Use <code>man &lt;command&gt;</code> (e.g. <code>man ls</code>) to read the manual.</li>
  <li>Append <code>| grep word</code> to filter output, e.g. <code>ps aux | grep nginx</code>.</li>
</ul>`,

    /* RO */
    `<h2>Comenzi Linux esențiale</h2>
<p>Aceste 20 de comenzi acoperă operațiunile pe care le vei folosi zilnic când administrezi un host Docker.</p>

<h2>Sistemul de fișiere</h2>
<pre><code>ls -lah            # Listează fișierele cu dimensiuni (human-readable)
cd /var/log        # Schimbă directorul
pwd                # Afișează directorul curent
cp file1 file2     # Copiază fișier
mv old new         # Mută / redenumește fișier
rm -rf dir/        # Șterge fișier sau director (atenție la -rf!)
mkdir -p a/b/c     # Creează directoare imbricate
cat file.txt       # Afișează conținutul fișierului
less file.txt      # Navighează prin fișier (q pentru ieșire)</code></pre>

<h2>Procese</h2>
<pre><code>ps aux             # Listează toate procesele active
top                # Monitor live de procese (q pentru ieșire)
htop               # Top îmbunătățit (instalare: apt install htop)
kill -9 1234       # Forțează oprirea procesului cu PID 1234
pkill nginx        # Oprește după numele procesului</code></pre>

<h2>Rețea</h2>
<pre><code>ip addr            # Arată interfețele de rețea și IP-urile
ss -tlnp           # Arată socket-uri TCP care ascultă, cu PID-uri
curl -I https://example.com   # Doar anteturile HTTP
ping -c 4 8.8.8.8  # Testează conectivitatea</code></pre>

<h2>Disc și memorie</h2>
<pre><code>df -h              # Utilizarea discului pe sistem de fișiere
du -sh /var/lib/docker   # Dimensiunea unui director specific
free -h            # Utilizarea RAM și swap
uname -r           # Versiunea kernel-ului</code></pre>

<h3>Sfaturi</h3>
<ul>
  <li>Prefixează orice comandă cu <code>sudo</code> pentru a rula ca root.</li>
  <li>Apasă <strong>Ctrl+C</strong> pentru a întrerupe o comandă în execuție.</li>
  <li>Folosește <code>man &lt;comandă&gt;</code> (ex. <code>man ls</code>) pentru a citi manualul.</li>
  <li>Adaugă <code>| grep cuvant</code> pentru a filtra rezultatele, ex. <code>ps aux | grep nginx</code>.</li>
</ul>`,

    'linux-commands'
  );

  // ─── 5. ssh-key-auth ─────────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>SSH Key Authentication</h2>
<p>Password-based SSH is slow and brute-force prone. Key authentication is faster, safer, and required when automating deployments.</p>

<h2>Step 1 — Generate a key pair</h2>
<p>Run this on your <strong>local machine</strong> (not the server):</p>
<pre><code>ssh-keygen -t ed25519 -C "your-email@example.com"
# Accept the default path (~/.ssh/id_ed25519)
# Set a passphrase for extra security (optional but recommended)</code></pre>
<p>This creates two files: <code>~/.ssh/id_ed25519</code> (private — never share) and <code>~/.ssh/id_ed25519.pub</code> (public — safe to share).</p>

<h2>Step 2 — Copy the public key to the server</h2>
<pre><code># Automatic (recommended)
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@your-server-ip

# Manual alternative (if ssh-copy-id is not available)
cat ~/.ssh/id_ed25519.pub | ssh user@server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"</code></pre>

<h2>Step 3 — Test the login</h2>
<pre><code>ssh user@your-server-ip
# Should log in without asking for a password</code></pre>

<h2>Step 4 — Disable password authentication (optional but recommended)</h2>
<pre><code>sudo nano /etc/ssh/sshd_config</code></pre>
<p>Set these lines:</p>
<pre><code>PasswordAuthentication no
PubkeyAuthentication yes</code></pre>
<pre><code>sudo systemctl restart sshd</code></pre>
<p><strong>Warning:</strong> Make sure your key login works before disabling passwords — otherwise you will be locked out.</p>

<h3>Multiple keys / servers</h3>
<p>Use <code>~/.ssh/config</code> to define shortcuts:</p>
<pre><code>Host myserver
  HostName 192.168.1.100
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519</code></pre>
<p>Then connect with just <code>ssh myserver</code>.</p>`,

    /* RO */
    `<h2>Autentificare SSH cu cheie</h2>
<p>Autentificarea SSH bazată pe parolă este lentă și vulnerabilă la atacuri brute-force. Autentificarea cu cheie este mai rapidă, mai sigură și necesară pentru automatizarea deploymentelor.</p>

<h2>Pasul 1 — Generează perechea de chei</h2>
<p>Rulează pe <strong>mașina ta locală</strong> (nu pe server):</p>
<pre><code>ssh-keygen -t ed25519 -C "email-tau@exemplu.com"
# Acceptă calea implicită (~/.ssh/id_ed25519)
# Setează o frază de acces pentru securitate suplimentară (opțional, dar recomandat)</code></pre>
<p>Se creează două fișiere: <code>~/.ssh/id_ed25519</code> (privat — nu-l distribui niciodată) și <code>~/.ssh/id_ed25519.pub</code> (public — sigur de distribuit).</p>

<h2>Pasul 2 — Copiază cheia publică pe server</h2>
<pre><code># Automat (recomandat)
ssh-copy-id -i ~/.ssh/id_ed25519.pub utilizator@ip-server

# Alternativă manuală (dacă ssh-copy-id nu e disponibil)
cat ~/.ssh/id_ed25519.pub | ssh utilizator@server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"</code></pre>

<h2>Pasul 3 — Testează autentificarea</h2>
<pre><code>ssh utilizator@ip-server
# Ar trebui să te conectezi fără a cere parolă</code></pre>

<h2>Pasul 4 — Dezactivează autentificarea prin parolă (opțional, dar recomandat)</h2>
<pre><code>sudo nano /etc/ssh/sshd_config</code></pre>
<p>Setează aceste linii:</p>
<pre><code>PasswordAuthentication no
PubkeyAuthentication yes</code></pre>
<pre><code>sudo systemctl restart sshd</code></pre>
<p><strong>Atenție:</strong> Asigură-te că autentificarea cu cheie funcționează înainte de a dezactiva parolele — altfel vei fi blocat din server.</p>

<h3>Chei multiple / servere multiple</h3>
<p>Folosește <code>~/.ssh/config</code> pentru scurtături:</p>
<pre><code>Host serverulmeu
  HostName 192.168.1.100
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519</code></pre>
<p>Conectează-te cu simplu <code>ssh serverulmeu</code>.</p>`,

    'ssh-key-auth'
  );

  // ─── 6. expose-ports ─────────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Expose Container Ports Safely</h2>
<p>Docker's <code>-p</code> flag maps a container port to a host port. The syntax is <code>HOST_PORT:CONTAINER_PORT</code>.</p>

<h2>Basic port mapping</h2>
<pre><code># Expose container port 80 on host port 8080 (all interfaces)
docker run -d -p 8080:80 nginx

# Bind to localhost only — NOT reachable from outside
docker run -d -p 127.0.0.1:8080:80 nginx

# Expose on a specific interface
docker run -d -p 192.168.1.10:8080:80 nginx</code></pre>

<h2>Docker Compose ports section</h2>
<pre><code>services:
  web:
    image: nginx
    ports:
      - "8080:80"          # public
      - "127.0.0.1:9000:9000"  # localhost only</code></pre>

<h2>Security warning: Docker bypasses UFW</h2>
<p><strong>Critical:</strong> Docker directly modifies iptables rules, bypassing UFW entirely. A port mapped with <code>-p 8080:80</code> is publicly accessible even if UFW says it's blocked.</p>
<ul>
  <li>Use <code>127.0.0.1:PORT:PORT</code> for services that should only be reached via a reverse proxy.</li>
  <li>Or configure <code>DOCKER-USER</code> iptables chain to restrict access.</li>
  <li>Or use a reverse proxy (Nginx/Caddy/Traefik) and only expose ports 80 and 443 publicly.</li>
</ul>

<h2>Check which ports are open</h2>
<pre><code># On the host
ss -tlnp | grep docker

# Inspect a container
docker port my-container</code></pre>`,

    /* RO */
    `<h2>Expunerea porturilor containerelor în siguranță</h2>
<p>Flag-ul <code>-p</code> al Docker mapează un port al containerului la un port al hostului. Sintaxa este <code>PORT_HOST:PORT_CONTAINER</code>.</p>

<h2>Mapare de bază a porturilor</h2>
<pre><code># Expune portul 80 al containerului pe portul 8080 al hostului (toate interfețele)
docker run -d -p 8080:80 nginx

# Leagă la localhost — NU accesibil din exterior
docker run -d -p 127.0.0.1:8080:80 nginx

# Expune pe o interfață specifică
docker run -d -p 192.168.1.10:8080:80 nginx</code></pre>

<h2>Secțiunea ports în Docker Compose</h2>
<pre><code>services:
  web:
    image: nginx
    ports:
      - "8080:80"               # public
      - "127.0.0.1:9000:9000"  # doar localhost</code></pre>

<h2>Avertisment de securitate: Docker ocolește UFW</h2>
<p><strong>Critic:</strong> Docker modifică direct regulile iptables, ocolind complet UFW. Un port mapat cu <code>-p 8080:80</code> este accesibil public chiar dacă UFW spune că e blocat.</p>
<ul>
  <li>Folosește <code>127.0.0.1:PORT:PORT</code> pentru servicii ce trebuie accesate doar printr-un reverse proxy.</li>
  <li>Sau configurează lanțul iptables <code>DOCKER-USER</code> pentru a restricționa accesul.</li>
  <li>Sau folosește un reverse proxy (Nginx/Caddy/Traefik) și expune public doar porturile 80 și 443.</li>
</ul>

<h2>Verifică porturile deschise</h2>
<pre><code># Pe host
ss -tlnp | grep docker

# Inspectează un container
docker port my-container</code></pre>`,

    'expose-ports'
  );

  // ─── 7. reverse-proxy ────────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Set Up a Reverse Proxy</h2>
<p>A reverse proxy sits in front of your services and handles incoming requests. Benefits: single port 443 for HTTPS, SSL termination in one place, route multiple domains to different containers, hide internal ports.</p>

<h2>Option 1 — Caddy (simplest, auto-HTTPS)</h2>
<pre><code># Caddyfile
example.com {
  reverse_proxy localhost:3000
}

api.example.com {
  reverse_proxy localhost:4000
}</code></pre>
<p>Caddy automatically obtains and renews Let's Encrypt certificates. No configuration needed.</p>

<h2>Option 2 — Nginx</h2>
<pre><code># /etc/nginx/sites-available/myapp
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}</code></pre>

<h2>Option 3 — Traefik (Docker-native, label-based)</h2>
<pre><code>services:
  traefik:
    image: traefik:v3
    command:
      - "--providers.docker=true"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.le.acme.email=you@example.com"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock

  myapp:
    image: myapp:latest
    labels:
      - "traefik.http.routers.myapp.rule=Host(\`example.com\`)"
      - "traefik.http.routers.myapp.tls.certresolver=le"</code></pre>
<p>Traefik auto-discovers containers via Docker labels — no config reload needed when adding services.</p>`,

    /* RO */
    `<h2>Configurare Reverse Proxy</h2>
<p>Un reverse proxy stă în fața serviciilor tale și gestionează cererile primite. Avantaje: un singur port 443 pentru HTTPS, terminare SSL într-un singur loc, rutarea mai multor domenii la containere diferite, ascunderea porturilor interne.</p>

<h2>Opțiunea 1 — Caddy (cel mai simplu, auto-HTTPS)</h2>
<pre><code># Caddyfile
example.com {
  reverse_proxy localhost:3000
}

api.example.com {
  reverse_proxy localhost:4000
}</code></pre>
<p>Caddy obține și reînnoiește automat certificatele Let's Encrypt. Nu necesită configurare suplimentară.</p>

<h2>Opțiunea 2 — Nginx</h2>
<pre><code># /etc/nginx/sites-available/myapp
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}</code></pre>

<h2>Opțiunea 3 — Traefik (nativ Docker, bazat pe etichete)</h2>
<pre><code>services:
  traefik:
    image: traefik:v3
    command:
      - "--providers.docker=true"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.le.acme.email=tu@exemplu.com"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock

  myapp:
    image: myapp:latest
    labels:
      - "traefik.http.routers.myapp.rule=Host(\`example.com\`)"
      - "traefik.http.routers.myapp.tls.certresolver=le"</code></pre>
<p>Traefik descoperă automat containerele prin etichetele Docker — nu e nevoie de reîncărcare a configurației la adăugarea de servicii.</p>`,

    'reverse-proxy'
  );

  // ─── 8. docker-networks ──────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Docker Networks Guide</h2>
<p>Docker networking controls how containers communicate with each other and the outside world.</p>

<h2>Network types</h2>
<ul>
  <li><strong>bridge</strong> (default) — Isolated virtual network on the host. Containers can talk to each other by name on the same bridge.</li>
  <li><strong>host</strong> — Container shares the host's network stack. No isolation; useful for high-performance scenarios.</li>
  <li><strong>overlay</strong> — Spans multiple Docker hosts (requires Swarm). Used in production clusters.</li>
  <li><strong>macvlan</strong> — Assigns a real MAC/IP from your LAN to the container. Appears as a physical device on the network.</li>
  <li><strong>none</strong> — No networking. Completely isolated.</li>
</ul>

<h2>Custom bridge networks (recommended)</h2>
<p>Always create a named bridge network instead of using the default one. Containers on the same named network can resolve each other by service name.</p>
<pre><code># Create a network
docker network create mynet

# Run containers on it
docker run -d --network mynet --name db postgres:16
docker run -d --network mynet --name app myapp

# "app" can reach "db" simply using hostname "db"</code></pre>

<h2>Useful commands</h2>
<pre><code># List networks
docker network ls

# Inspect a network (see connected containers and IPs)
docker network inspect mynet

# Connect a running container to a network
docker network connect mynet existing-container

# Disconnect
docker network disconnect mynet existing-container</code></pre>

<h2>Docker Compose</h2>
<pre><code>services:
  db:
    image: postgres:16
    networks: [backend]
  app:
    image: myapp
    networks: [backend, frontend]
  nginx:
    image: nginx
    networks: [frontend]

networks:
  backend:
  frontend:</code></pre>
<p>This setup means only <code>nginx</code> and <code>app</code> share a network — the database is not reachable from nginx directly.</p>`,

    /* RO */
    `<h2>Ghid rețele Docker</h2>
<p>Rețelistica Docker controlează modul în care containerele comunică între ele și cu lumea exterioară.</p>

<h2>Tipuri de rețele</h2>
<ul>
  <li><strong>bridge</strong> (implicit) — Rețea virtuală izolată pe host. Containerele de pe același bridge pot comunica între ele prin nume.</li>
  <li><strong>host</strong> — Containerul partajează stack-ul de rețea al hostului. Fără izolare; util pentru scenarii de performanță ridicată.</li>
  <li><strong>overlay</strong> — Se extinde pe mai multe hosturi Docker (necesită Swarm). Folosit în clustere de producție.</li>
  <li><strong>macvlan</strong> — Atribuie un MAC/IP real din rețeaua locală containerului. Apare ca un dispozitiv fizic în rețea.</li>
  <li><strong>none</strong> — Fără rețea. Complet izolat.</li>
</ul>

<h2>Rețele bridge custom (recomandat)</h2>
<p>Creează întotdeauna o rețea bridge cu nume în loc să folosești pe cea implicită. Containerele din aceeași rețea cu nume se pot rezolva între ele prin numele serviciului.</p>
<pre><code># Creează o rețea
docker network create mynet

# Rulează containere pe ea
docker run -d --network mynet --name db postgres:16
docker run -d --network mynet --name app myapp

# "app" poate ajunge la "db" folosind simplu hostname-ul "db"</code></pre>

<h2>Comenzi utile</h2>
<pre><code># Listează rețelele
docker network ls

# Inspectează o rețea (vezi containerele conectate și IP-urile)
docker network inspect mynet

# Conectează un container activ la o rețea
docker network connect mynet container-existent

# Deconectează
docker network disconnect mynet container-existent</code></pre>

<h2>Docker Compose</h2>
<pre><code>services:
  db:
    image: postgres:16
    networks: [backend]
  app:
    image: myapp
    networks: [backend, frontend]
  nginx:
    image: nginx
    networks: [frontend]

networks:
  backend:
  frontend:</code></pre>
<p>Această configurare înseamnă că doar <code>nginx</code> și <code>app</code> partajează o rețea — baza de date nu este accesibilă direct din nginx.</p>`,

    'docker-networks'
  );

  // ─── 9. dns-domain-setup ─────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>DNS &amp; Domain Setup</h2>
<p>To access your Docker services via a domain name, you need to create DNS records pointing to your server's public IP.</p>

<h2>Step 1 — Find your server's public IP</h2>
<pre><code>curl -s https://ifconfig.me</code></pre>

<h2>Step 2 — Add DNS A records</h2>
<p>In your domain registrar or DNS provider (Cloudflare, Route53, etc.), add:</p>
<ul>
  <li><strong>A record</strong>: <code>@</code> → your server IP (apex domain, e.g. <code>example.com</code>)</li>
  <li><strong>A record</strong>: <code>www</code> → your server IP</li>
  <li><strong>A record</strong>: <code>app</code> → your server IP (for subdomains)</li>
</ul>
<p>DNS propagation takes up to 48 hours, but usually minutes with Cloudflare.</p>

<h2>Step 3 — Verify DNS propagation</h2>
<pre><code># Check A record
dig example.com A +short

# Or using nslookup
nslookup example.com

# Check from multiple locations
curl https://dns.google/resolve?name=example.com&type=A</code></pre>

<h2>Step 4 — Configure your service</h2>
<p>Once DNS resolves correctly, point your reverse proxy at your domain:</p>
<pre><code># Caddy — automatic HTTPS
example.com {
  reverse_proxy localhost:3000
}</code></pre>

<h2>Step 5 — Free HTTPS with Caddy</h2>
<pre><code>sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
sudo systemctl enable --now caddy</code></pre>

<h3>Cloudflare tip</h3>
<p>If using Cloudflare, keep the proxy (orange cloud) <strong>disabled</strong> initially until you confirm the domain resolves. Enable it after HTTPS is working to get DDoS protection and CDN.</p>`,

    /* RO */
    `<h2>Configurare DNS și domeniu</h2>
<p>Pentru a accesa serviciile Docker printr-un domeniu, trebuie să creezi înregistrări DNS care să pointeze către IP-ul public al serverului tău.</p>

<h2>Pasul 1 — Găsește IP-ul public al serverului</h2>
<pre><code>curl -s https://ifconfig.me</code></pre>

<h2>Pasul 2 — Adaugă înregistrări DNS A</h2>
<p>La registratorul domeniului sau furnizorul DNS (Cloudflare, Route53 etc.), adaugă:</p>
<ul>
  <li><strong>Înregistrare A</strong>: <code>@</code> → IP-ul serverului (domeniu apex, ex. <code>example.com</code>)</li>
  <li><strong>Înregistrare A</strong>: <code>www</code> → IP-ul serverului</li>
  <li><strong>Înregistrare A</strong>: <code>app</code> → IP-ul serverului (pentru subdomenii)</li>
</ul>
<p>Propagarea DNS durează până la 48 de ore, dar de obicei câteva minute cu Cloudflare.</p>

<h2>Pasul 3 — Verifică propagarea DNS</h2>
<pre><code># Verifică înregistrarea A
dig example.com A +short

# Sau folosind nslookup
nslookup example.com

# Verifică din locații multiple
curl https://dns.google/resolve?name=example.com&type=A</code></pre>

<h2>Pasul 4 — Configurează serviciul</h2>
<p>Odată ce DNS rezolvă corect, pointează reverse proxy-ul către domeniu:</p>
<pre><code># Caddy — HTTPS automat
example.com {
  reverse_proxy localhost:3000
}</code></pre>

<h2>Pasul 5 — HTTPS gratuit cu Caddy</h2>
<pre><code>sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
sudo systemctl enable --now caddy</code></pre>

<h3>Sfat Cloudflare</h3>
<p>Dacă folosești Cloudflare, menține proxy-ul (norul portocaliu) <strong>dezactivat</strong> inițial până confirmi că domeniul rezolvă corect. Activează-l după ce HTTPS funcționează pentru protecție DDoS și CDN.</p>`,

    'dns-domain-setup'
  );

  // ─── 10. tls-certificates ────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>TLS/SSL Certificates</h2>
<p>HTTPS requires a TLS certificate. Let's Encrypt provides free, automatically renewable certificates trusted by all browsers.</p>

<h2>Option 1 — Caddy (automatic, zero config)</h2>
<p>Caddy is the easiest path to HTTPS. It requests and renews certificates automatically:</p>
<pre><code># /etc/caddy/Caddyfile
example.com {
  reverse_proxy localhost:3000
}

# That's it. Caddy handles everything.</code></pre>

<h2>Option 2 — Certbot (manual, works with any web server)</h2>
<pre><code># Install certbot
sudo apt install -y certbot python3-certbot-nginx

# Get a certificate (Nginx plugin auto-configures Nginx)
sudo certbot --nginx -d example.com -d www.example.com

# Or standalone (no web server running on 80)
sudo certbot certonly --standalone -d example.com

# Auto-renewal is set up automatically. Test it:
sudo certbot renew --dry-run</code></pre>

<h2>Option 3 — Traefik (Docker-native)</h2>
<pre><code>command:
  - "--certificatesresolvers.le.acme.tlschallenge=true"
  - "--certificatesresolvers.le.acme.email=you@example.com"
  - "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json"</code></pre>

<h2>Where certificates are stored (certbot)</h2>
<pre><code>/etc/letsencrypt/live/example.com/fullchain.pem   # Certificate + chain
/etc/letsencrypt/live/example.com/privkey.pem     # Private key</code></pre>

<h2>Certificate expiry</h2>
<p>Let's Encrypt certificates expire after <strong>90 days</strong>. Certbot installs a systemd timer that renews automatically when less than 30 days remain. Check the timer:</p>
<pre><code>sudo systemctl status certbot.timer</code></pre>

<h3>Self-signed certificates (local dev only)</h3>
<pre><code>openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout selfsigned.key -out selfsigned.crt \
  -subj "/CN=localhost"</code></pre>`,

    /* RO */
    `<h2>Certificate TLS/SSL</h2>
<p>HTTPS necesită un certificat TLS. Let's Encrypt oferă certificate gratuite, reînnoite automat, de încredere pentru toate browserele.</p>

<h2>Opțiunea 1 — Caddy (automat, fără configurare)</h2>
<p>Caddy este cea mai simplă cale spre HTTPS. Solicită și reînnoiește certificatele automat:</p>
<pre><code># /etc/caddy/Caddyfile
example.com {
  reverse_proxy localhost:3000
}

# Atât. Caddy se ocupă de tot.</code></pre>

<h2>Opțiunea 2 — Certbot (manual, funcționează cu orice server web)</h2>
<pre><code># Instalează certbot
sudo apt install -y certbot python3-certbot-nginx

# Obține certificat (plugin-ul Nginx configurează automat Nginx)
sudo certbot --nginx -d example.com -d www.example.com

# Sau standalone (niciun server web nu rulează pe portul 80)
sudo certbot certonly --standalone -d example.com

# Reînnoirea automată e configurată automat. Testează:
sudo certbot renew --dry-run</code></pre>

<h2>Opțiunea 3 — Traefik (nativ Docker)</h2>
<pre><code>command:
  - "--certificatesresolvers.le.acme.tlschallenge=true"
  - "--certificatesresolvers.le.acme.email=tu@exemplu.com"
  - "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json"</code></pre>

<h2>Unde sunt stocate certificatele (certbot)</h2>
<pre><code>/etc/letsencrypt/live/example.com/fullchain.pem   # Certificat + lanț
/etc/letsencrypt/live/example.com/privkey.pem     # Cheie privată</code></pre>

<h2>Expirarea certificatelor</h2>
<p>Certificatele Let's Encrypt expiră după <strong>90 de zile</strong>. Certbot instalează un timer systemd care reînnoiește automat când rămân mai puțin de 30 de zile. Verifică timer-ul:</p>
<pre><code>sudo systemctl status certbot.timer</code></pre>

<h3>Certificate auto-semnate (doar pentru dezvoltare locală)</h3>
<pre><code>openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout selfsigned.key -out selfsigned.crt \
  -subj "/CN=localhost"</code></pre>`,

    'tls-certificates'
  );

  // ─── 11. harden-docker ───────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Harden Your Docker Host</h2>
<p>By default, Docker containers run as root and have broad capabilities. These practices significantly reduce attack surface.</p>

<h2>1 — Run containers as non-root</h2>
<pre><code># In Dockerfile
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser</code></pre>
<pre><code># In docker-compose.yml
services:
  app:
    image: myapp
    user: "1000:1000"</code></pre>

<h2>2 — Read-only root filesystem</h2>
<pre><code>docker run --read-only -v /tmp myapp</code></pre>
<pre><code># docker-compose.yml
services:
  app:
    read_only: true
    tmpfs:
      - /tmp</code></pre>

<h2>3 — Drop all capabilities, add only what's needed</h2>
<pre><code>services:
  app:
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE   # only if binding to port < 1024</code></pre>

<h2>4 — No new privileges</h2>
<pre><code>services:
  app:
    security_opt:
      - no-new-privileges:true</code></pre>

<h2>5 — Resource limits</h2>
<pre><code>services:
  app:
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 256M</code></pre>

<h2>6 — Never use --privileged</h2>
<p><code>--privileged</code> gives a container full root access to the host kernel. Avoid it completely — use specific capabilities instead.</p>

<h2>7 — Keep images updated</h2>
<pre><code># Scan for CVEs before deploying
docker scout cves myimage:latest
# or
trivy image myimage:latest</code></pre>`,

    /* RO */
    `<h2>Securizarea hostului Docker</h2>
<p>Implicit, containerele Docker rulează ca root și au capabilități extinse. Aceste practici reduc semnificativ suprafața de atac.</p>

<h2>1 — Rulează containerele ca utilizator non-root</h2>
<pre><code># În Dockerfile
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser</code></pre>
<pre><code># În docker-compose.yml
services:
  app:
    image: myapp
    user: "1000:1000"</code></pre>

<h2>2 — Sistem de fișiere root read-only</h2>
<pre><code>docker run --read-only -v /tmp myapp</code></pre>
<pre><code># docker-compose.yml
services:
  app:
    read_only: true
    tmpfs:
      - /tmp</code></pre>

<h2>3 — Elimină toate capabilitățile, adaugă doar ce e necesar</h2>
<pre><code>services:
  app:
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE   # doar dacă portul < 1024</code></pre>

<h2>4 — Fără privilegii noi</h2>
<pre><code>services:
  app:
    security_opt:
      - no-new-privileges:true</code></pre>

<h2>5 — Limite de resurse</h2>
<pre><code>services:
  app:
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 256M</code></pre>

<h2>6 — Nu folosi niciodată --privileged</h2>
<p><code>--privileged</code> oferă containerului acces root complet la kernel-ul hostului. Evită complet — folosește capabilități specifice în loc.</p>

<h2>7 — Ține imaginile actualizate</h2>
<pre><code># Scanează CVE-uri înainte de deployment
docker scout cves myimage:latest
# sau
trivy image myimage:latest</code></pre>`,

    'harden-docker'
  );

  // ─── 12. rootless-docker ─────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Rootless Docker Setup</h2>
<p>Rootless mode runs the Docker daemon and containers under a normal user account, eliminating the risk of container escapes gaining root on the host.</p>

<h2>Prerequisites</h2>
<pre><code># Install required packages
sudo apt install -y uidmap dbus-user-session slirp4netns

# Ensure user has a subuid/subgid range
grep $USER /etc/subuid /etc/subgid
# If missing, add:
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER</code></pre>

<h2>Install rootless Docker</h2>
<pre><code># Run as your normal user (NOT root)
dockerd-rootless-setuptool.sh install

# If dockerd-rootless-setuptool.sh is not found, install it:
curl -fsSL https://get.docker.com/rootless | sh</code></pre>

<h2>Configure your shell</h2>
<pre><code># Add to ~/.bashrc or ~/.zshrc
export PATH=/home/$USER/bin:$PATH
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock</code></pre>
<pre><code>source ~/.bashrc
docker info   # should show rootless mode</code></pre>

<h2>Auto-start with systemd (user session)</h2>
<pre><code>systemctl --user enable docker
systemctl --user start docker
# To start even without login:
sudo loginctl enable-linger $USER</code></pre>

<h2>Limitations to be aware of</h2>
<ul>
  <li>Ports below 1024 require <code>sysctl net.ipv4.ip_unprivileged_port_start=80</code>.</li>
  <li><code>--privileged</code> and most <code>cap_add</code> options are restricted.</li>
  <li>Some storage drivers (overlay2) may need additional kernel config.</li>
  <li>Performance is slightly lower due to user-mode networking (slirp4netns).</li>
</ul>`,

    /* RO */
    `<h2>Docker fără root (Rootless)</h2>
<p>Modul rootless rulează daemonul Docker și containerele sub un cont de utilizator normal, eliminând riscul ca un container compromis să obțină root pe host.</p>

<h2>Cerințe prealabile</h2>
<pre><code># Instalează pachetele necesare
sudo apt install -y uidmap dbus-user-session slirp4netns

# Verifică că utilizatorul are un interval subuid/subgid
grep $USER /etc/subuid /etc/subgid
# Dacă lipsesc, adaugă:
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER</code></pre>

<h2>Instalează Docker rootless</h2>
<pre><code># Rulează ca utilizator normal (NU root)
dockerd-rootless-setuptool.sh install

# Dacă dockerd-rootless-setuptool.sh nu e găsit, instalează-l:
curl -fsSL https://get.docker.com/rootless | sh</code></pre>

<h2>Configurează shell-ul</h2>
<pre><code># Adaugă în ~/.bashrc sau ~/.zshrc
export PATH=/home/$USER/bin:$PATH
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock</code></pre>
<pre><code>source ~/.bashrc
docker info   # ar trebui să arate modul rootless</code></pre>

<h2>Pornire automată cu systemd (sesiune utilizator)</h2>
<pre><code>systemctl --user enable docker
systemctl --user start docker
# Pentru pornire chiar fără login:
sudo loginctl enable-linger $USER</code></pre>

<h2>Limitări de reținut</h2>
<ul>
  <li>Porturile sub 1024 necesită <code>sysctl net.ipv4.ip_unprivileged_port_start=80</code>.</li>
  <li><code>--privileged</code> și majoritatea opțiunilor <code>cap_add</code> sunt restricționate.</li>
  <li>Unele drivere de stocare (overlay2) pot necesita configurare suplimentară a kernel-ului.</li>
  <li>Performanța e ușor mai mică din cauza rețelei în modul utilizator (slirp4netns).</li>
</ul>`,

    'rootless-docker'
  );

  // ─── 13. compose-first-stack ─────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Your First Docker Compose Stack</h2>
<p>Docker Compose lets you define multi-container applications in a single YAML file and manage them with one command.</p>

<h2>The docker-compose.yml file</h2>
<pre><code>services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
    volumes:
      - ./html:/usr/share/nginx/html:ro
    depends_on:
      - db

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: myuser
      POSTGRES_PASSWORD: mypassword
      POSTGRES_DB: mydb
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:</code></pre>

<h2>Essential commands</h2>
<pre><code># Start all services in the background
docker compose up -d

# View running services
docker compose ps

# View logs (all services)
docker compose logs -f

# View logs for a specific service
docker compose logs -f db

# Stop all services (containers remain)
docker compose stop

# Stop AND remove containers (volumes are kept)
docker compose down

# Remove containers AND volumes (destructive!)
docker compose down -v

# Rebuild images and restart
docker compose up -d --build</code></pre>

<h2>Execute commands inside a service</h2>
<pre><code># Open a shell in the web container
docker compose exec web sh

# Run a one-off command in db
docker compose exec db psql -U myuser mydb</code></pre>

<h3>Project naming</h3>
<p>By default, Compose uses the directory name as the project prefix (e.g., <code>myproject_web_1</code>). Override with <code>-p myproject</code> or set <code>COMPOSE_PROJECT_NAME</code> in your <code>.env</code> file.</p>`,

    /* RO */
    `<h2>Primul tău stack Docker Compose</h2>
<p>Docker Compose îți permite să definești aplicații multi-container într-un singur fișier YAML și să le gestionezi cu o singură comandă.</p>

<h2>Fișierul docker-compose.yml</h2>
<pre><code>services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
    volumes:
      - ./html:/usr/share/nginx/html:ro
    depends_on:
      - db

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: myuser
      POSTGRES_PASSWORD: mypassword
      POSTGRES_DB: mydb
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:</code></pre>

<h2>Comenzi esențiale</h2>
<pre><code># Pornește toate serviciile în fundal
docker compose up -d

# Vezi serviciile active
docker compose ps

# Vezi logurile (toate serviciile)
docker compose logs -f

# Loguri pentru un serviciu specific
docker compose logs -f db

# Oprește toate serviciile (containerele rămân)
docker compose stop

# Oprește ȘI șterge containerele (volumele sunt păstrate)
docker compose down

# Șterge containerele ȘI volumele (distructiv!)
docker compose down -v

# Reconstruiește imaginile și repornește
docker compose up -d --build</code></pre>

<h2>Execută comenzi într-un serviciu</h2>
<pre><code># Deschide un shell în containerul web
docker compose exec web sh

# Rulează o comandă în db
docker compose exec db psql -U myuser mydb</code></pre>

<h3>Denumirea proiectului</h3>
<p>Implicit, Compose folosește numele directorului ca prefix de proiect (ex. <code>myproject_web_1</code>). Suprascrie cu <code>-p myproject</code> sau setează <code>COMPOSE_PROJECT_NAME</code> în fișierul <code>.env</code>.</p>`,

    'compose-first-stack'
  );

  // ─── 14. compose-env-vars ────────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Environment Variables in Docker Compose</h2>
<p>Hard-coding passwords and configuration in docker-compose.yml is a security risk. Environment variables keep sensitive values out of version control.</p>

<h2>The .env file</h2>
<p>Create a <code>.env</code> file in the same directory as <code>docker-compose.yml</code>:</p>
<pre><code># .env
POSTGRES_USER=myuser
POSTGRES_PASSWORD=supersecret
POSTGRES_DB=mydb
APP_PORT=3000</code></pre>
<p><strong>Add .env to .gitignore immediately:</strong></p>
<pre><code>echo ".env" >> .gitignore</code></pre>

<h2>Reference variables in Compose</h2>
<pre><code>services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
  app:
    image: myapp
    ports:
      - "${APP_PORT}:3000"</code></pre>

<h2>The env_file directive</h2>
<p>Load all variables from a file without listing them individually:</p>
<pre><code>services:
  app:
    image: myapp
    env_file:
      - .env
      - .env.local   # local overrides</code></pre>

<h2>Inline environment section</h2>
<pre><code>services:
  app:
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db/mydb</code></pre>

<h2>Provide a .env.example file</h2>
<p>Commit a <code>.env.example</code> (with placeholder values) so teammates know which variables are required:</p>
<pre><code># .env.example
POSTGRES_USER=changeme
POSTGRES_PASSWORD=changeme
POSTGRES_DB=mydb
APP_PORT=3000</code></pre>

<h3>Variable precedence (highest to lowest)</h3>
<ul>
  <li>Shell environment variables</li>
  <li>Variables set with <code>-e KEY=VALUE</code> flag</li>
  <li><code>environment:</code> section in compose file</li>
  <li><code>.env</code> file</li>
  <li>Dockerfile <code>ENV</code> defaults</li>
</ul>`,

    /* RO */
    `<h2>Variabile de mediu în Docker Compose</h2>
<p>Codificarea parolelor și a configurației direct în docker-compose.yml este un risc de securitate. Variabilele de mediu țin valorile sensibile în afara controlului de versiune.</p>

<h2>Fișierul .env</h2>
<p>Creează un fișier <code>.env</code> în același director cu <code>docker-compose.yml</code>:</p>
<pre><code># .env
POSTGRES_USER=myuser
POSTGRES_PASSWORD=supersecret
POSTGRES_DB=mydb
APP_PORT=3000</code></pre>
<p><strong>Adaugă .env în .gitignore imediat:</strong></p>
<pre><code>echo ".env" >> .gitignore</code></pre>

<h2>Referențierea variabilelor în Compose</h2>
<pre><code>services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
  app:
    image: myapp
    ports:
      - "${APP_PORT}:3000"</code></pre>

<h2>Directiva env_file</h2>
<p>Încarcă toate variabilele dintr-un fișier fără a le lista individual:</p>
<pre><code>services:
  app:
    image: myapp
    env_file:
      - .env
      - .env.local   # suprascrieri locale</code></pre>

<h2>Secțiunea environment inline</h2>
<pre><code>services:
  app:
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db/mydb</code></pre>

<h2>Furnizează un fișier .env.example</h2>
<p>Commit-ează un <code>.env.example</code> (cu valori placeholder) pentru ca membrii echipei să știe ce variabile sunt necesare:</p>
<pre><code># .env.example
POSTGRES_USER=changeme
POSTGRES_PASSWORD=changeme
POSTGRES_DB=mydb
APP_PORT=3000</code></pre>

<h3>Prioritatea variabilelor (de la cea mai mare la cea mai mică)</h3>
<ul>
  <li>Variabile de mediu din shell</li>
  <li>Variabile setate cu flag-ul <code>-e KEY=VALUE</code></li>
  <li>Secțiunea <code>environment:</code> din fișierul compose</li>
  <li>Fișierul <code>.env</code></li>
  <li>Valorile implicite <code>ENV</code> din Dockerfile</li>
</ul>`,

    'compose-env-vars'
  );

  // ─── 15. compose-healthchecks ────────────────────────────────────────────
  update.run(
    /* EN */
    `<h2>Health Checks in Docker Compose</h2>
<p>Health checks tell Docker whether a container is actually ready to serve traffic — not just started. Other services can use <code>condition: service_healthy</code> to wait for dependencies.</p>

<h2>Health check parameters</h2>
<ul>
  <li><code>test</code> — Command to run. Exit code 0 = healthy, non-zero = unhealthy.</li>
  <li><code>interval</code> — How often to check (default: 30s).</li>
  <li><code>timeout</code> — How long to wait for the command (default: 30s).</li>
  <li><code>retries</code> — Failures before marking unhealthy (default: 3).</li>
  <li><code>start_period</code> — Grace period after start before counting failures (default: 0s).</li>
</ul>

<h2>Web service (HTTP check)</h2>
<pre><code>services:
  web:
    image: nginx:alpine
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s</code></pre>

<h2>PostgreSQL</h2>
<pre><code>  db:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s</code></pre>

<h2>Redis</h2>
<pre><code>  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3</code></pre>

<h2>Make services wait for healthy dependencies</h2>
<pre><code>  app:
    image: myapp
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy</code></pre>

<h2>Check health status</h2>
<pre><code># Via Docker Compose
docker compose ps

# Via Docker inspect
docker inspect --format='{{json .State.Health}}' container_name | jq</code></pre>`,

    /* RO */
    `<h2>Verificări de sănătate în Docker Compose</h2>
<p>Verificările de sănătate îi spun Docker dacă un container este cu adevărat pregătit să servească trafic — nu doar pornit. Alte servicii pot folosi <code>condition: service_healthy</code> pentru a aștepta dependențele.</p>

<h2>Parametrii verificărilor de sănătate</h2>
<ul>
  <li><code>test</code> — Comanda de rulat. Codul de ieșire 0 = sănătos, non-zero = nesănătos.</li>
  <li><code>interval</code> — Cât de des să verifice (implicit: 30s).</li>
  <li><code>timeout</code> — Cât să aștepte comanda (implicit: 30s).</li>
  <li><code>retries</code> — Eșecuri înainte de a marca ca nesănătos (implicit: 3).</li>
  <li><code>start_period</code> — Perioadă de grație după start înainte de a număra eșecurile (implicit: 0s).</li>
</ul>

<h2>Serviciu web (verificare HTTP)</h2>
<pre><code>services:
  web:
    image: nginx:alpine
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s</code></pre>

<h2>PostgreSQL</h2>
<pre><code>  db:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s</code></pre>

<h2>Redis</h2>
<pre><code>  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3</code></pre>

<h2>Fă serviciile să aștepte dependențe sănătoase</h2>
<pre><code>  app:
    image: myapp
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy</code></pre>

<h2>Verifică starea de sănătate</h2>
<pre><code># Prin Docker Compose
docker compose ps

# Prin Docker inspect
docker inspect --format='{{json .State.Health}}' container_name | jq</code></pre>`,

    'compose-healthchecks'
  );
};
