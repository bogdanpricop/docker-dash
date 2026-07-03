---
slug: esxi-to-proxmox-migration
title: Migrate a VM from ESXi to Proxmox using docker-dash (end-to-end)
title_ro: Migreaza un VM de la ESXi la Proxmox folosind docker-dash (end-to-end)
category: homelab-setup
difficulty: advanced
icon: fas fa-exchange-alt
summary: Export a VM from ESXi as OVA, publish it via HTTP, then use docker-dash's VM Migration tool to import into Proxmox.
summary_ro: Exporta un VM din ESXi ca OVA, publica-l prin HTTP, apoi foloseste tool-ul VM Migration din docker-dash pentru a-l importa in Proxmox.
---

## The scenario

You have ESXi with production VMs. You installed [Proxmox on ESXi](../howto/install-proxmox-on-esxi) as a nested test lab. Now you want to move one of your smaller ESXi VMs into Proxmox using docker-dash's Sprint 7 VM Migration tool.

**This end-to-end walkthrough is what verifies Sprint 7 for beta promotion.** If it works, we can promote v8.9.2 out of alpha.

## Pre-flight

- Proxmox host registered in docker-dash (via [Proxmox howto](../howto/install-proxmox-on-esxi))
- SSH key auth from docker-dash to the Proxmox node (step 7 in that howto)
- A small ESXi VM to migrate — pick one **you can afford to trash on the first try**. A Linux VM boots without driver injection; Windows needs VirtIO drivers first (see below).

## Step 1 — Export the VM from ESXi as OVA

ESXi doesn't require the VM to be off for OVF export via CLI, but for a **clean migration** the VM should be shut down.

**Via ESXi web client:**
1. Right-click the VM → **Export**
2. Files to include: VMDK, MF (manifest), OVF descriptor → click **Export**
3. Browser downloads: `<vmname>.ovf`, `<vmname>.vmdk`, `<vmname>.mf`

**Or via `ovftool` (recommended for larger VMs — supports resumable downloads):**
```bash
# Install ovftool: https://developer.broadcom.com/tools/open-virtualization-format-ovf-tool/
ovftool "vi://root@192.168.13.10/MyVM" my-vm.ova
```

## Step 2 — Publish the OVA over HTTP

The migration tool downloads from a URL that the **Proxmox node** can reach. So publish the OVA somewhere reachable from Proxmox.

**Simplest — one-off Python HTTP server on your workstation:**
```bash
cd /path/to/ova
python3 -m http.server 8000 --bind 192.168.13.100
# → Serving HTTP on 192.168.13.100 port 8000
```

Your OVA is now at `http://192.168.13.100:8000/my-vm.ova`.

**More permanent — put it in the docker-dash container's public volume:**
```bash
docker cp my-vm.ova docker-dash:/data/public/
# Publish via a small caddy sidecar, or serve directly via docker-dash's static
# assets — up to you. URL will be http://192.168.13.20:8101/data/public/my-vm.ova
```

## Step 3 — Trigger the migration in docker-dash

1. Sidebar → **VM Migration (alpha)**
2. Click **New Migration**
3. Fill:
   | Field | Value |
   |---|---|
   | Source URL | `http://192.168.13.100:8000/my-vm.ova` |
   | Source format | auto |
   | Destination Proxmox host | `proxmox-test` (registered earlier) |
   | Proxmox node | `proxmox-test` (name of the node inside the cluster) |
   | Storage | `local-lvm` (or whatever your Proxmox storage id is) |
   | New VMID | any unused ID between 100 and 999999999 — try `200` |
   | New VM name | `migrated-web` |

4. Click **Start migration**

The job appears in the list with status `pending`. Click the row to open the detail modal — live progress bar + phase log tail.

## Step 4 — Watch the phases

The tool runs 9 phases on the Proxmox node via SSH:

| % | Phase | Command |
|---:|---|---|
| 3 | setup | `mkdir /tmp/dd-migration-<jobId>` |
| 5 | download | `wget <URL>` |
| 40 | download-complete | (verify) |
| 42 | extract | `tar -xf` (OVA only) |
| 50 | convert | `qemu-img convert -f vmdk -O qcow2` |
| 85 | convert-complete | (verify) |
| 88 | create-vm | `qm create <vmid> --name ...` |
| 90 | import-disk | `qm importdisk <vmid> ...` |
| 95 | attach-disk | `qm set --scsihw virtio-scsi-pci --scsi0 ...` |
| 100 | done | VM created (stopped) |

Total time = mostly (download time) + (qemu-img convert time). For a 20 GB disk over a 100 Mb LAN, expect ~30 min.

## Step 5 — Boot the migrated VM

Open the Proxmox web UI → your new VM.

**Adjust hardware:**
- Memory: match the ESXi source (default is 2 GB — probably wrong)
- CPU: match cores
- Network: verify the bridge is `vmbr0` (Proxmox default)

**Boot** — Linux guests usually boot as-is. If disk isn't detected:
- Try changing controller from `virtio-scsi` to `LSI` (VM Options → OS Type = Windows for Windows; Linux → keep scsi)
- Or try `--sata0` instead of `--scsi0`

## Windows guest — VirtIO driver injection

Windows VMs from ESXi don't have VirtIO drivers by default. If you boot as-is, you get a BSOD (`INACCESSIBLE_BOOT_DEVICE`).

Two options:

**Option A: pre-inject VirtIO drivers on ESXi BEFORE exporting**
1. Boot the Windows VM on ESXi
2. Download the [VirtIO drivers ISO](https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers)
3. Mount, install `virtio-win-guest-tools.exe`
4. Shut down, export as OVA
5. Import via docker-dash — boots fine

**Option B: mount VirtIO ISO on the migrated Proxmox VM**
1. On Proxmox: **Datacenter → node → local → ISO Images → Upload** the VirtIO ISO
2. Edit the migrated VM → add CD/DVD drive → attach `virtio-win.iso`
3. Change SCSI controller to `LSI 53C895A` (or leave as VirtIO SCSI single)
4. Boot → Windows Recovery Environment loads → **Startup Repair** → select the drivers from the CD

## Verification checklist

- [ ] Migration job completes at 100% with status `completed`
- [ ] Phase log shows no errors
- [ ] Proxmox web UI shows the new VM (stopped)
- [ ] VM boots and reaches login prompt
- [ ] Network works (for Linux; Windows needs VirtIO or LSI)
- [ ] Disk data matches the source

## Common failures

**Phase `download` fails**

Source URL not reachable from the Proxmox node. Test manually:
```bash
ssh root@192.168.13.21 wget -q -O /dev/null http://192.168.13.100:8000/my-vm.ova
```

If this fails, the URL is unreachable (typo, firewall, wrong IP).

**Phase `convert` fails with "unable to open"**

The OVA extracted a VMDK that `qemu-img` can't read. Some ESXi VMs use `streamOptimized` VMDK which qemu-img handles fine — but very old ESXi versions used other subformats. Convert manually first:
```bash
# On the Proxmox node:
qemu-img convert -f vmdk -O qcow2 old.vmdk new.qcow2
```

If manual convert fails, the VMDK is not a shape qemu-img supports.

**Phase `import-disk` fails with "format 'qcow2' unsupported"**

The chosen Proxmox storage doesn't support QCOW2 files (e.g. `local-lvm` requires raw). Migrate to a storage that supports QCOW2 (`local-zfs`, `local`, custom NFS), or wait for the future alpha that supports raw output.

**Phase `create-vm` fails with "VM 200 already exists"**

Pick a different VMID. Docker Dash doesn't check for collisions yet.

## Beta blocker status

Successfully migrating a small Linux VM from ESXi → Proxmox via this walkthrough is **exactly what unblocks Sprint 7 (v8.9.2) beta promotion**. Please report back:
- Which OS you migrated
- OVA size
- Total wall-clock time
- Any phases that were unclear or slow

## References

- [Docker Dash VM Migration howto](../howto/vm-migration-to-proxmox)
- [Proxmox: Migrate from VMware](https://pve.proxmox.com/wiki/Migrate_to_Proxmox_VE)
- [Broadcom OVF Tool download](https://developer.broadcom.com/tools/open-virtualization-format-ovf-tool/)
