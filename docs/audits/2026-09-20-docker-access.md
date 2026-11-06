# Docker access findings and migration plan

Verified from the authorized audit workstation on 2026-09-20.

## LAN: unauthenticated daemon API (remediated 2026-10-07)

`http://192.168.13.20:2375` accepted Docker API requests without a client
certificate or another authentication mechanism. Read-only inventory succeeded;
the explicitly authorized disposable build/smoke also succeeded through this
endpoint. Anyone with the same network reachability could potentially administer
the daemon. Internet reachability was not established by this test.

SSH is verified with the current user's `id_ed25519` key as
`localadmin-a@192.168.13.20`, with strict known-host checking. This account belongs
to the Docker group. Passwordless sudo is unavailable. Root SSH and the separate
`id_ed25519_lan_docker` key were refused; no password authentication was attempted.

The plaintext listener was removed on 2026-10-07 after the consumer inventory
showed no active 2375 sessions and Docker Dash used the local Unix socket or SSH
for the LAN host. The daemon configuration now exposes only
`unix:///var/run/docker.sock`. The original configuration is preserved at
`/etc/docker/daemon.json.codex-20261007-plaintext-2375.bak` on the host.

The restart used the existing independent SSH channel and an automatic rollback
if Docker did not return active. `live-restore` preserved all 150 pre-existing
running containers. After the restart, Docker 29.7.2 responded through the Unix
socket, Docker Dash was healthy, no listener existed on 2375/2376, and a request
to `192.168.13.20:2375` from the audit workstation was refused. The installed
configuration hash is
`f1b672719f012d11a6b7da2da1a00ab95b2f18cfad1a4ef5a45d27422d910e48`;
the backup hash is
`105b06eba3a1d8bf1b672bc2818e671dee7c413c1a8a4602c55a202c37cafe94`.

## VPS: no daemon TCP listener observed

SSH to `89.37.212.66` succeeded using the existing local key with strict known-host
verification. `ss -lntp` showed no listener on 2375 or 2376. Docker 29.7.2 reports
AppArmor, the built-in seccomp profile and cgroup namespaces. These observations
do not establish the security of all published services or workloads.

## LAN migration record

The effective configuration was inspected before remediation. `daemon.json`
contained `hosts`, `live-restore`, `log-driver` and `log-opts`; the systemd override
reset `ExecStart` to `/usr/bin/dockerd` with no conflicting `-H` flags. The listeners
were the Unix socket and `tcp://0.0.0.0:2375`; `live-restore` was and remains true.

The concrete proposed change is:

```diff
- "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2375"]
+ "hosts": ["unix:///var/run/docker.sock"]
```

Keep all other settings. The SHA-256 of the existing file is
`105b06eba3a1d8bf1b672bc2818e671dee7c413c1a8a4602c55a202c37cafe94`.
The candidate was generated in a private temporary file on the host and passed
`dockerd --validate --config-file`; it was then deleted. Its SHA-256 is
`f1b672719f012d11a6b7da2da1a00ab95b2f18cfad1a4ef5a45d27422d910e48`.

Read-only checks found no Docker Dash host records using this LAN TCP endpoint
or port 2375 in either installed instance, no running-container environment
variables mentioning 2375 on LAN, and no established TCP sessions at inspection
time. External scheduled consumers have not been ruled out.

The original file was backed up, the validated candidate was installed atomically,
and Docker was restarted through the verified SSH channel. The post-restart checks
described above passed, so rollback was not needed.

For environments that still require TCP, the alternative migration remains:

1. Establish and test SSH/console recovery to the LAN host. Inventory the
   consumers of 2375, including Docker Dash host records, CI and automation.
   Read the effective `dockerd` service arguments, drop-ins and `daemon.json`;
   preserve the existing data root, networking and runtime settings.
2. Prefer an SSH connection to the Unix socket where supported. If TCP consumers
   require an API endpoint, configure mutual TLS on 2376 with a server certificate
   whose SAN includes `192.168.13.20`, serverAuth usage, and a separately issued
   clientAuth certificate. Keep the CA private key off the Docker host. Never
   disable server-certificate verification.
3. Validate the merged daemon configuration before a scheduled restart. Avoid
   defining the same `hosts` option in both systemd arguments and `daemon.json`.
   Keep the Unix socket and verified recovery access. Restrict TCP access to the
   management clients at the host/network firewall.
4. Move each consumer to the authenticated endpoint. Confirm inventory and an
   operation on a uniquely labelled disposable container. Test that a client
   without a certificate and a client with an untrusted certificate are rejected.
5. Remove the plaintext listener and firewall access to 2375. Verify it is closed
   from the workstation and another authorized network vantage point; recheck
   existing workloads and automation. Preserve a reviewed rollback that restores
   the previous service configuration through console/SSH if migration fails.

The direct Unix socket and SSH are now the supported transports for this LAN host.
If a future consumer requires TCP, use the mutual-TLS procedure above on 2376;
do not restore the plaintext listener.

Reference: [Docker daemon socket protection](https://docs.docker.com/engine/security/protect-access/).
