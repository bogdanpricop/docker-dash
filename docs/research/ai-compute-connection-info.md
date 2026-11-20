# AI Compute connection information

The small information button next to an SSH host opens an administrator-only,
host-scoped dialog. Public endpoint, authentication method, remote Docker socket
and pinned SHA256 server fingerprint are returned through a no-store endpoint.
Viewing it does not connect to Docker or require a healthy tunnel. Credentials,
key material, passphrases and raw encrypted configuration are never serialized.

Deployment-specific topology and controls require an operator inspection. The
internal `recordDeploymentInfo` maintenance helper stores only an allowlisted
snapshot, its timestamp and a SHA256 of the public connection identity. It has no
HTTP write endpoint. Changed endpoint, port, account, socket, authentication mode
or fingerprint hides previous observations. Secret rotation alone does not
invalidate an unchanged public identity. Saving observations preserves monitoring.

For the VPS reverse tunnel, inspection on 2026-11-20 confirmed:

- DGX initiates SSH to VPS port 22. The reverse listener is bound to the private
  Docker bridge address 172.23.0.1:12223 and forwards to DGX loopback SSH port 22.
- The outbound client checks a pinned VPS known_hosts entry, uses a dedicated
  key, ExitOnForwardFailure and 20-second keepalives with a three-miss threshold.
- The dedicated account uses public-key authentication, disables password and
  keyboard-interactive authentication, TTY, X11 and agent forwarding, and forces
  nologin. Remote TCP forwarding is restricted to the configured listeners
  172.23.0.1:12223 and 172.23.0.1:18443. Streamlocal forwarding remains enabled.
- Its container is unprivileged, UID/GID 1000, read-only root filesystem, with
  read-only key/known_hosts mounts and an unless-stopped restart policy.
- Docker Dash independently pins the DGX SSH server fingerprint and forwards its
  Docker Unix socket to an application-container loopback listener. This is
  powerful host-management access; the private binding alone is not isolation
  from every VPS-local workload or a replacement for firewall/access policies.

Observations describe that inspection, not continuous attestation. No private
reverse-tunnel topology is inferred from a host name or private IP. LAN direct SSH
connections receive public connection information and generic SSH behavior until
an inspection is recorded. The dialog explains failure/reconnect behavior and
links to the official Docker daemon security documentation.
