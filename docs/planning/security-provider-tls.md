# Verified provider TLS

Require authenticated TLS for remote Incus/LXD, Proxmox, Kubernetes, Nomad and
Xen management APIs and console connections. Preserve local Unix sockets and
verified raw-Xen SSH. Reject legacy skipTlsVerify rather than silently continuing
with unauthenticated transport. Remote endpoints must use HTTPS; normalize bare
host names to HTTPS. Operators migrate by installing a valid server certificate
or supplying a verified CA bundle, including a trusted self-signed server
certificate where it validates for the endpoint host. Do not auto-import keys or
trust a certificate fetched over the unverified connection.

Centralize bounded PEM validation and TLS options, including hostname verification
and TLS 1.2 minimum. Add CA fields where absent and remove bypass checkboxes. Save,
edit and test must preserve existing encrypted secrets and CA material. Reject
undecryptable stored settings instead of overwriting them with partial input.
Kubeconfig export must preserve secure endpoint/CA settings and use default CA
trust when a custom CA was not supplied; never emit insecure-skip-tls-verify=true.

Verify with real HTTPS servers: trusted CA succeeds, missing/wrong trust and
hostname mismatch fail before HTTP credentials reach the server. Cover mTLS,
console TLS options, form payloads, configuration persistence and kubeconfig.
Update current how-to guidance, then run regressions and production startup.
