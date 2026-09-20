# Verify SSH server identity before authentication

The SSH2 Docker tunnel, connection tests, key deployer, ESXi telemetry/terminal,
Proxmox migration and system operations currently omit host verification. Raw
Xen only verifies an optional fingerprint. Git explicitly disables OpenSSH host
checking. A hostile endpoint can receive credentials or management commands.

Require an administrator-supplied host-key SHA-256 fingerprint for SSH2 callers.
Accept a canonical OpenSSH SHA256 base64 fingerprint or 64 hexadecimal digits;
reject missing, malformed and noncanonical encodings. Compare the negotiated
host-key digest exactly, before SSH user authentication, including reconnects
and test buttons. No automatic first-use trust or insecure compatibility switch.
Missing legacy pins must cause a clear error until an administrator supplies a
fingerprint obtained through a trusted console or previously verified channel.

Expose the nonsecret pin in host editing and the key-deployer workflow. Preserve
stored credentials when editing only a pin. Do not silently learn or replace
pins from a network probe. Validate configuration before saving it and before
opening a connection. A changed server key fails closed until explicitly updated.

Tests need a real local SSH server: the correct key permits authentication, a
different key is rejected before the server receives user authentication, and
missing pins do not open a network connection. Cover all SSH2 call sites and
configuration round trips. Real host tests may reuse independently trusted local
known-host records; never turn ssh-keyscan output into trust by itself.

Git must use strict OpenSSH known-host checking with explicitly configured trust
and no /dev/null trust bypass. Its repository configuration and UI need a matching
migration path. This remains part of the same audit even if completed separately
from SSH2 integration. No live host configuration or daemon restart is implied.
