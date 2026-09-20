---
title: Docker Secrets Management
summary: Use Docker secrets with the _FILE pattern to keep credentials out of env vars and image layers.
category: security
difficulty: intermediate
icon: fas fa-user-secret
---

<h2>Why Not Environment Variables?</h2>
<p>Putting secrets in <code>environment:</code> exposes them in: <strong>docker inspect</strong>, process listing (<code>ps aux</code>), container logs, and crash dumps. Anyone with access to the Docker socket can read them.</p>

<h2>The _FILE Pattern</h2>
<p>Most modern images (postgres, mysql, mariadb, redis, nginx) support reading secrets from a file via the <code>_FILE</code> suffix. Instead of:</p>
<pre><code>environment:
  POSTGRES_PASSWORD: my-secret-pass</code></pre>
<p>Use:</p>
<pre><code>environment:
  POSTGRES_PASSWORD_FILE: /run/secrets/db_password
secrets:
  - db_password</code></pre>

<h2>Setup with docker-compose</h2>
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

<h2>Create the Secret File (Correct Way)</h2>
<pre><code># CRITICAL: use printf, NEVER echo (echo adds \n which breaks credentials)
sudo mkdir -p /etc/myapp/secrets
sudo sh -c 'printf "%s" "$(openssl rand -base64 24)" > /etc/myapp/secrets/db_password.txt'
sudo chmod 600 /etc/myapp/secrets/db_password.txt
sudo chown root:docker /etc/myapp/secrets/db_password.txt</code></pre>

<h2>Common Pitfalls</h2>
<ul>
  <li><strong>echo adds newline:</strong> <code>echo "secret" > file</code> stores <code>secret\n</code> — many drivers include the newline literally, causing silent auth failures.</li>
  <li><strong>Permissions matter:</strong> file must be 600 (root + docker group only).</li>
  <li><strong>Don't commit:</strong> add <code>secrets/</code> to .gitignore.</li>
  <li><strong>App must support _FILE:</strong> custom apps need to read the file themselves.</li>
</ul>

<h2>Verify in the Container</h2>
<pre><code># Files appear at /run/secrets/&lt;name&gt;
docker exec mycontainer ls -la /run/secrets/
docker exec mycontainer cat /run/secrets/db_password</code></pre>


<h2>Remote execution from the Secrets Wizard</h2>
<p>The wizard requires an administrator, writable mode and a configured SSH host
with a trusted host fingerprint. It sends the script through the encrypted channel,
verifies the complete SHA-256 on the host, then executes it without creating a
script file. The script is absent from command arguments and the audit log.
The host needs Bash, sha256sum and /dev/fd; the sudo option requires passwordless,
non-interactive sudo. Script commands receive EOF on standard input and cannot
prompt for passwords. The script's own commands can still create files.</p>
<p>The deadline is 120 seconds; scripts and combined stdout/stderr are limited to
1 MiB. The audit records an operation ID, hash and execution metadata before and
after the attempt. Script contents and output are not recorded there. Output is
returned only to the requesting administrator with cache storage disabled.</p>
<p>A dropped connection, timeout or output overflow is not proof that the remote
process stopped. The response warns when execution cannot be confirmed. Inspect
the host and audit operation before retrying; remote shell effects are not rolled
back automatically. A hash mismatch prevents execution of an incomplete upload.</p>
<p>Older releases may have left docker-dash-secrets-*.sh files in /tmp or script
previews in old audit exports/backups. This change does not erase them. Review them
as an administrator, confirm they belong to a finished deployment and handle them
under your secret-retention policy. Do not delete unknown scripts or rewrite a
hash-chained audit log to hide old events.</p>
