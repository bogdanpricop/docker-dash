# Provider VM guest customization

Docker Dash can attach a safe Linux identity and IPv4 network configuration while creating a VM from a template. The feature extends the VM Catalog provisioning wizard and durable Activity Center operation.

## Enablement

```env
DD_PROVIDER_VM_PROVISIONING=true
DD_PROVIDER_VM_GUEST_CUSTOMIZATION=true
```

Both flags default to false. The user must be an administrator with `operate` access to the selected endpoint. Provider capability is probed live, so an enabled flag does not override missing provider support.

## Accepted values

- hostname and optional DNS domain;
- optional IANA-style timezone;
- optional Linux account and up to ten OpenSSH public keys;
- DHCP or one static IPv4/CIDR plus gateway;
- up to three DNS servers and six search domains.

Passwords, private keys, arbitrary scripts/user-data, Windows settings, IPv6 and multi-NIC maps are rejected in this release. The VM is created powered off; the prepared customization completes when it is first started.

## Provider notes

- Proxmox writes and verifies native Cloud-Init QEMU settings after clone.
- vSphere prechecks LinuxPrep compatibility and embeds customization in the clone task; DNS domain is required and user/SSH-key fields are unavailable.
- Xen Orchestra support is enabled only when its live Swagger declares the task-backed pool create endpoint and Cloud-Init fields.
- direct XAPI and raw Xen explicitly report unsupported guest customization.

Preflight shows exact blockers before submission. Public keys are represented by SHA-256 fingerprints in plans/results and remain only inside the encrypted operation request when execution requires them.
