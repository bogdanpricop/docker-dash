---
slug: vm-migration-to-proxmox
title: VM Migration to Proxmox (alpha)
title_ro: Migrare VM in Proxmox (alpha)
category: docker-dash
difficulty: advanced
icon: fas fa-exchange-alt
summary: Migrate a VM disk (VMDK / OVA / QCOW2 / RAW) from a URL to a Proxmox cluster.
summary_ro: Migreaza un disc VM (VMDK / OVA / QCOW2 / RAW) de la URL intr-un cluster Proxmox.
---

## What this feature does

Docker Dash's **VM Migration** page orchestrates a one-way import of a disk image from a URL into a Proxmox VM:

1. Downloads the source disk (VMDK / OVA / QCOW2 / RAW) via `wget` on a chosen Proxmox node
2. Extracts VMDK from OVA if applicable
3. Runs `qemu-img convert` to QCOW2 format
4. Creates a stopped Proxmox VM with sensible defaults (2 GB RAM, 2 cores, virtio NIC on `vmbr0`)
5. Uses `qm importdisk` to attach the converted disk as `scsi0` with a `virtio-scsi-pci` controller
6. Cleans up the working directory

Live progress and phase log are streamed back to the UI.

**This is NOT vSphere-to-Proxmox live migration.** The source VM must first be exported to an OVA (from vSphere) or the VMDK made accessible via HTTP.

## Alpha caveats

- Unverified against a real Proxmox cluster in this release. Ship as **alpha** — expect edge cases
- Windows guests may need `virt-io` driver injection after import (`virt-v2v` handles this, but it's not orchestrated here yet)
- OVAs with multiple disks: only the first VMDK found is imported
- No file upload (URL source only in this alpha); a follow-up will add chunked upload
- Concurrent migrations to the same VMID are not guarded — pick unique VMIDs
- No cancel button

## Prerequisites

1. A Proxmox cluster already registered in Docker Dash with `daemon_type='proxmox'` (see the Proxmox howto)
2. **SSH credentials** for the destination Proxmox node — added to the same host's `daemon_config`
3. A source URL reachable **from the Proxmox node** (not from docker-dash — the fetch happens on the Proxmox side)

## Add SSH credentials to an existing Proxmox host

Open the docker-dash container shell:
```bash
docker exec -it docker-dash sh
```

Then run this SQL to add SSH config to the existing Proxmox host row:
```bash
docker exec docker-dash node -e '
const { getDb } = require("/app/src/db");
const { encryptDaemonConfig, decryptDaemonConfig } = require("/app/src/services/proxmox");
const fs = require("fs");

const HOST_ID = <YOUR-PROXMOX-HOST-ID>;
const row = getDb().prepare("SELECT daemon_config FROM docker_hosts WHERE id = ?").get(HOST_ID);
const cfg = decryptDaemonConfig(row.daemon_config);
cfg.sshConfig = {
  host: "pve.example.com",              // FQDN or IP of the node
  port: 22,
  user: "root",
  privateKey: fs.readFileSync("/data/pve-id_ed25519", "utf8"),   // read from a mounted volume
};
getDb().prepare("UPDATE docker_hosts SET daemon_config = ? WHERE id = ?")
  .run(encryptDaemonConfig(cfg), HOST_ID);
console.log("sshConfig added and encrypted");
'
```

## Trigger a migration

1. Sidebar → **VM Migration (alpha)** — visible when at least one Proxmox host is registered
2. Click **New Migration**
3. Fill in:
   - **Source URL** — must be an `http://` or `https://` URL the Proxmox node can reach
   - **Source format** — leave as *auto* unless the URL has no extension
   - **Destination Proxmox host** — dropdown of registered hosts
   - **Proxmox node** — name of the target node in the cluster (e.g. `pve`)
   - **Storage** — target storage id (e.g. `local-lvm`, `local-zfs`, `pool01`)
   - **New VMID** — integer between 100 and 999999999 that isn't already in use
   - **New VM name** — descriptive name
4. Click **Start migration** — the modal closes, and the new job appears in the list with status *pending*
5. Click the row to open the job detail modal with live progress bar and phase log tail

## Progress milestones

| % | Phase | What happens |
|---:|---|---|
| 3 | setup | `mkdir /tmp/dd-migration-<jobId>` on the Proxmox node |
| 5 | download | `wget` starts |
| 40 | download-complete | source disk saved locally on Proxmox node |
| 42 | extract | (OVA only) `tar -xf` runs |
| 50 | convert | `qemu-img convert -f <src> -O qcow2` starts |
| 85 | convert-complete | QCOW2 written |
| 88 | create-vm | `qm create` runs |
| 90 | import-disk | `qm importdisk` runs |
| 95 | attach-disk | `qm set --scsihw --scsi0` runs |
| 100 | done | VM created (stopped); user starts it manually |

## After the migration

1. In Proxmox UI: open the new VM — adjust memory, cores, network as needed
2. Boot the VM — Linux guests usually boot as-is (Debian/Ubuntu/CentOS/Fedora)
3. Windows guests: install VirtIO drivers before first boot to avoid BSOD. The [Proxmox VirtIO drivers ISO](https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers) is the canonical source
4. If disk isn't detected: the source might have used a non-standard controller. Try changing `--scsi0` to `--sata0` on the Proxmox side or set the controller to `LSI` in the VM Options

## Security notes

- The source URL is fetched by `wget` on the **Proxmox node**, not by docker-dash. Network egress policy applies to Proxmox, not to docker-dash
- SSH credentials are stored **encrypted at rest** via the same AES-256-GCM helper used for Docker Dash git credentials
- Every migration write action is audit-logged: `vm_migration_start` in the audit trail
- Every command is constructed via `ssh2`'s exec API with strict input validation (VMIDs, names) and shell-escaping to prevent injection
- Bounded phase log at 256 KB per job — never fills SQLite

## Troubleshooting

**Job stays at 5% for a long time**

Slow download from the source URL, or the URL is unreachable from the Proxmox node. Check the phase log — `wget` errors surface there. Test manually: `ssh root@pve wget -q -O /dev/null <url>`.

**"SSH connect timeout"**

`sshConfig.host` is wrong, port 22 blocked, or the key is missing/wrong. Test manually: `ssh -i <key> root@<host>`.

**"qm create: VM 200 already exists"**

Pick a different VMID. Docker Dash doesn't check for collisions.

**"qemu-img convert: unable to open"**

The source format detection guessed wrong. Set the source format explicitly in the form. Or the download was corrupt — check the phase log for `wget` errors.

**"qm importdisk: format 'qcow2' unsupported"**

Some Proxmox storages don't support QCOW2 (LVM-thin requires raw). Options: (a) create a new storage that supports QCOW2, (b) wait for a future release that supports raw output.

**Windows guest doesn't boot**

Missing VirtIO drivers. See the "After the migration" section above.

## References

- [Proxmox: Migrate to Proxmox VE (official wiki)](https://pve.proxmox.com/wiki/Migrate_to_Proxmox_VE)
- [Proxmox: Advanced Migration Techniques](https://pve.proxmox.com/wiki/Advanced_Migration_Techniques_to_Proxmox_VE)
- [Proxmox: Windows VirtIO Drivers](https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers)
- [Docker Dash migration research + roadmap](../../plans/research-vmware-and-cross-migration-2026-07-03.md)
