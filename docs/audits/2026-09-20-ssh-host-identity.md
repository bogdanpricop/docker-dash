# SSH server identity verification

The audit found SSH2 connections without server-key verification in Docker
tunnels, key deployment, ESXi telemetry/terminal, Proxmox migration and remote
secret deployment. Raw Xen only verified a key when an optional pin was present.

## Implemented behavior

These connections now require `hostKeySha256` before opening a connection. The
value is a 64-character SHA-256 hexadecimal digest or an OpenSSH `SHA256:...`
fingerprint. Encoding is validated strictly; the SSH2 `hostVerifier` checks the
negotiated key using SHA-256 and a constant-time comparison. Missing or different
keys refuse authentication. This applies to test buttons, reconnects and ESXi
write operations that share the telemetry connector. There is no automatic
first-use trust or insecure fallback.

Hosts → Add/Edit exposes the pin for Docker SSH, vSphere, Proxmox and raw Xen.
The SSH Key Deployer also requires it, including testing the new key and attaching
it to vSphere. The label and explanation are available in English and Romanian.
The Proxmox editor now exposes its SSH configuration and a read-only login test.
Pin-only edits preserve encrypted private keys/passwords; explicit replacement
authentication takes precedence over the previous method. Host detail responses
expose the public fingerprint and credential-presence flags, never the secrets.

Remote secret deployment now decrypts the saved SSH configuration, respects
read-only mode, writes its script exclusively with mode 0600 under an unpredictable
temporary name and bounds returned output to 1 MiB. Audit keeps the script hash
and size-related metadata, without the previous first/last script fragments.
Existing audit records that already contain script fragments have not been
rewritten by this change. Script cleanup after interrupted uploads/executions
still needs a separate failure-path review.

## Migration for existing configurations

Existing unpinned connections fail closed until an administrator supplies the
server fingerprint. Obtain it through the provider console, physical console or
an already verified management channel. For a Linux server with an Ed25519 host
key, run this on that trusted console:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Paste the `SHA256:...` value into the host's SSH fingerprint field and save.
It identifies the **server key**, not the user's login key. A network key scan
alone does not establish trust. If the negotiated key differs, investigate the
server and verify any rotation independently before changing the saved pin.
Other server key types are supported through their SHA-256 fingerprint; the pin
must match the key negotiated by the SSH connection.

API fields are `sshHostKeySha256` for Docker host create/update/test, nested
`daemonConfig.sshConfig.hostKeySha256` for vSphere/Proxmox, top-level
`daemonConfig.hostKeySha256` for raw Xen and `connection.hostKeySha256` for the
key deployer. No database migration is required for these existing JSON configs.

## Evidence and limits

Tests with a real local SSH server cover the shared verifier, Docker connection
test, key deployer, ESXi and Xen. Correct keys authenticate; an impostor receives
no user authentication; a missing pin opens no connection. Additional integration
tests exercise Proxmox migration, ESXi terminal, secret deployment, encrypted
config editing and attaching a key. Real browser checks cover the forms and
payloads in English/Romanian under CSP, including escaping of the fingerprint.

[Read-only host verification](2026-09-20-ssh-host-identity.json) used the current
user's SSH key and Ed25519 server keys already stored in that user's `known_hosts`:
LAN `192.168.13.20` as `localadmin-a`, VPS `89.37.212.66` as `root`. Both accepted
the trusted pin and rejected an intentionally different pin. Only `whoami` ran
remotely; no host configuration, authorized keys or existing workloads changed.

This change covers the SSH2 paths above. Git's separate OpenSSH invocations still
disable host verification and remain an explicit open audit finding. Provider TLS
defaults, Docker LAN port 2375, transactional deployment and the rest of the
project audit remain separate work. Nothing here proves the whole project secure.

Reference: [SSH2 hostHash and hostVerifier](https://github.com/mscdex/ssh2#client-methods).

Final validation: 347 Jest suites passed; 4,399 tests passed, one skipped. Lint,
browser checks and page-help coverage passed. Production test image
`sha256:d56b32a9f1434a024472b40d02893f57920b7d31f7834671cc236aba6742e396`
passed Linux startup, SQLite migrations, Compose configuration, HTTP health and
secret persistence/precedence checks. Its disposable controller was removed.
There was no deployment to an existing instance and no publication. This build
does not remediate the previously identified scanner/base-image findings.
