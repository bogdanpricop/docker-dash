# Docker access findings and migration plan

Verified from the authorized audit workstation on 2026-09-20.

## LAN: unauthenticated daemon API

`http://192.168.13.20:2375` accepts Docker API requests without a client
certificate or another authentication mechanism. Read-only inventory succeeded;
the explicitly authorized disposable build/smoke also succeeded through this
endpoint. Anyone with the same network reachability can potentially administer
the daemon. This is a critical unresolved infrastructure finding. Internet
reachability was not established by this test.

SSH is verified with the current user's `id_ed25519` key as
`localadmin-a@192.168.13.20`, with strict known-host checking. This account belongs
to the Docker group. Passwordless sudo is unavailable. Root SSH and the separate
`id_ed25519_lan_docker` key were refused; no password authentication was attempted.

Do not close the port until its current consumers have a working authenticated
replacement and a separate recovery channel has been verified. The existing
workloads and host firewall were not changed by this audit.

## VPS: no daemon TCP listener observed

SSH to `89.37.212.66` succeeded using the existing local key with strict known-host
verification. `ss -lntp` showed no listener on 2375 or 2376. Docker 29.7.2 reports
AppArmor, the built-in seccomp profile and cgroup namespaces. These observations
do not establish the security of all published services or workloads.

## Proposed LAN migration

The effective configuration has now been inspected. `daemon.json` contains
`hosts`, `live-restore`, `log-driver` and `log-opts`; the systemd override resets
`ExecStart` to `/usr/bin/dockerd` with no conflicting `-H` flags. Current listeners
are the Unix socket and `tcp://0.0.0.0:2375`; `live-restore` is true.

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

Applying this requires backing up the original file, verifying its hash again,
installing the validated candidate atomically and restarting the Docker daemon.
Live restore preserves running containers, but daemon/API availability is briefly
interrupted. Verify Unix/SSH access, absence of the TCP listener and the health of
the pre-existing containers; restore the original file and restart through the
independent SSH channel if validation fails. **Host mutation is awaiting explicit
approval; no change or restart has been made.**

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

This is a proposed migration, not an applied host change. Exact service edits
depend on the effective LAN daemon configuration and the consumer inventory.

Reference: [Docker daemon socket protection](https://docs.docker.com/engine/security/protect-access/).
