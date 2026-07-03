---
slug: install-proxmox-on-esxi
title: Install Proxmox VE 8 (nested on ESXi, for docker-dash testing)
title_ro: Instalare Proxmox VE 8 (imbricat pe ESXi, pentru testare docker-dash)
category: homelab-setup
difficulty: intermediate
icon: fas fa-server
summary: Spin up a Proxmox VE 8 node as a nested VM inside VMware ESXi so you can verify docker-dash's Proxmox integration and VM migration tools.
summary_ro: Ruleaza un nod Proxmox VE 8 ca VM imbricat in VMware ESXi pentru a verifica integrarea Proxmox si migratia VM din docker-dash.
---

## Why this recipe

You have ESXi in the LAN. You want to test docker-dash's Proxmox integration (v8.9.1+) and the VM migration tool (v8.9.2+) **without buying new hardware**. A nested Proxmox VM on ESXi is the fastest path:

- No new hardware
- No commitment — trash the VM when done
- Nested virtualization works fine on ESXi 6.7+ for Proxmox KVM VMs (some performance hit, irrelevant for testing)
- You can still use your existing ESXi for production workloads

## Requirements

- ESXi 6.7 or newer (7.0+ preferred)
- One VM with:
  - **8 GB RAM** minimum (Proxmox itself + one guest VM comfortably)
  - **4 vCPU** (with hardware virtualization exposed)
  - **60 GB disk** (30 for Proxmox + 30 for a test guest)
- Access to the ESXi web client with a user that can create VMs and toggle nested virtualization
- A Proxmox VE 8 ISO (get from https://www.proxmox.com/en/downloads)

## Step 1 — Upload the Proxmox ISO to ESXi

1. ESXi web client → **Storage** → pick your datastore → **Datastore browser**
2. Click **Upload** and select the `proxmox-ve_8.x-x.iso` file
3. Wait for the upload (700 MB — a few minutes on a 100 Mb LAN)

## Step 2 — Create the nested VM

1. ESXi → **Virtual Machines** → **Create / Register VM** → **Create a new VM**
2. Wizard settings:
   | Field | Value |
   |---|---|
   | Name | `proxmox-test` |
   | Compatibility | ESXi 6.7 or later (whatever you have) |
   | Guest OS family | Linux |
   | Guest OS version | **Other 5.x Linux (64-bit)** (or "Debian 12" if listed) |
   | CPU | 4 |
   | Memory | 8 GB |
   | Hard disk | 60 GB, thin-provisioned |
   | Network adapter | your production LAN portgroup |
   | CD/DVD drive | Datastore ISO file → `proxmox-ve_8.x-x.iso` |

3. **Before finishing** — click on the CPU section and check:
   - ☑ **Expose hardware assisted virtualization to the guest OS**
   - ☑ **Enable virtualized CPU performance counters** (optional, useful for perf tests)

   Without this checkbox, Proxmox will boot but every KVM VM you create inside will fail with "KVM virtualization not available."

4. Also on the Network section:
   - Change adapter type to **VMXNET3** (better throughput than E1000)

5. Finish → do **not** boot yet.

## Step 3 — Enable promiscuous mode on the portgroup

Proxmox VMs get their own MAC addresses. By default ESXi drops packets whose destination MAC doesn't match the VM's own MAC. So Proxmox guests won't get network.

Two options:

**Option A: enable promiscuous mode on the portgroup** (easiest, less secure)
1. ESXi → **Networking** → **Virtual switches** → pick your vSwitch
2. Edit settings → **Security** → **Promiscuous mode = Accept**, **Forged transmits = Accept**, **MAC address changes = Accept**

**Option B: create a nested portgroup**
Only if you want to isolate the nested lab from production LAN.

## Step 4 — Boot Proxmox and install

1. Power on the VM → open console
2. Choose **Install Proxmox VE (Graphical)**
3. Accept the EULA
4. Target disk: `sda` (60 GB)
5. Country, timezone, keyboard layout — set yours
6. Root password + admin email
7. Network:
   - Hostname: `proxmox-test.lan` (adjust to your domain)
   - IP: static, in your LAN range (e.g. `192.168.13.21/24`)
   - Gateway: your router (`192.168.13.1`)
   - DNS: whatever your LAN uses (or `192.168.13.20` if docker-dash runs there and does DNS)
8. Confirm summary → **Install**
9. Wait 5-10 minutes
10. Reboot — **eject the ISO** from the CD drive first (ESXi → Edit VM → CD/DVD → Client Device)

## Step 5 — First login to Proxmox web UI

Open `https://192.168.13.21:8006` in a browser (self-signed cert warning is fine for testing).

- User: `root`
- Password: whatever you set
- Realm: **Linux PAM standard authentication**

You should see the Proxmox VE dashboard, one node listed on the left with your hostname.

**Optional but recommended** — disable the "no valid subscription" popup:
```bash
ssh root@192.168.13.21
sed -Ezi.bak "s/(function\(orig_cmd\) \{)/\1\n\torig_cmd\(\);\n\treturn;/g" \
  /usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js
systemctl restart pveproxy
```

## Step 6 — Create the API token for docker-dash

Proxmox uses API tokens for programmatic access. Create a dedicated one for docker-dash:

1. Proxmox UI → **Datacenter** → **Permissions** → **API Tokens** → **Add**
2. Fields:
   - User: `root@pam` (or create a dedicated user first — see below)
   - Token ID: `docker-dash`
   - Privilege Separation: **☐ uncheck** (so the token inherits the user's permissions)
3. Click **Add** — a popup shows the **Token ID** (e.g. `root@pam!docker-dash`) and **Secret** (UUID)
4. **Copy both immediately** — the secret is shown only once

**More secure (recommended for anything past first-test):**
- **Datacenter → Users → Add** — create user `dockerdash@pve` with password
- **Datacenter → Permissions → Add → User Permission** — path `/`, user `dockerdash@pve`, role **PVEAuditor** (read-only) or **PVEVMAdmin** (full VM control)
- Then create the token on this user instead of `root@pam`

## Step 7 — Set up SSH key auth for the VM migration tool

The VM migration tool (Sprint 7) runs SSH commands on the Proxmox node. Set up passwordless SSH from docker-dash to the Proxmox root.

On the docker-dash host (VPS or LAN 13.20):
```bash
# Generate a key pair specifically for docker-dash → Proxmox
ssh-keygen -t ed25519 -f /data/pve-migration-key -N ""

# Push it to Proxmox
ssh-copy-id -i /data/pve-migration-key.pub root@192.168.13.21

# Test
ssh -i /data/pve-migration-key root@192.168.13.21 "hostname"
# → should print: proxmox-test
```

## Step 8 — Register Proxmox in docker-dash

1. Open docker-dash (http://192.168.13.20:8101)
2. Sidebar → **Hosts**
3. Click **Non-Docker host (alpha)** — the wizard opens
4. Daemon type: **Proxmox VE**
5. Name: `proxmox-test`
6. Endpoint: `https://192.168.13.21:8006`
7. API token ID: `root@pam!docker-dash` (from step 6)
8. API token secret: the UUID from step 6
9. Skip TLS verification: ☑ **checked** (self-signed cert)
10. Submit

Sidebar → **Proxmox (alpha)** now appears. Click it — you should see the info card with the Proxmox version and 5 tabs (Nodes / VMs / LXC / Storages / Backups).

For the VM migration tool, add SSH config too. In the docker-dash container:
```bash
docker exec docker-dash node -e '
const { getDb } = require("/app/src/db");
const { encryptDaemonConfig, decryptDaemonConfig } = require("/app/src/services/proxmox");
const fs = require("fs");

const HOST_ID = <YOUR-PROXMOX-HOST-ID-FROM-DD>;
const row = getDb().prepare("SELECT daemon_config FROM docker_hosts WHERE id = ?").get(HOST_ID);
const cfg = decryptDaemonConfig(row.daemon_config);
cfg.sshConfig = {
  host: "192.168.13.21",
  port: 22,
  user: "root",
  privateKey: fs.readFileSync("/data/pve-migration-key", "utf8"),
};
getDb().prepare("UPDATE docker_hosts SET daemon_config = ? WHERE id = ?")
  .run(encryptDaemonConfig(cfg), HOST_ID);
console.log("SSH config added");
'
```

## Verification checklist

- [ ] `/api/proxmox/version?hostId=<id>` returns something like `{ version: "8.x.x", release: "..." }`
- [ ] Proxmox tab shows the info card with the version
- [ ] Nodes tab lists at least one node
- [ ] VMs tab is probably empty (fresh Proxmox) — create a small test VM manually and refresh
- [ ] Sidebar → **VM Migration (alpha)** appears (gated on any Proxmox host being registered)

## Troubleshooting

**"KVM virtualization not available" when creating a VM inside Proxmox**

Step 2 checkbox "Expose hardware assisted virtualization" wasn't ticked. Shut down the Proxmox VM, edit settings, tick, power back on.

**"connect ECONNREFUSED 192.168.13.21:8006"**

Proxmox pveproxy service not up. SSH in and `systemctl status pveproxy` → `systemctl restart pveproxy`.

**Proxmox integration error: HTTP 401 from `/access/ticket`**

API token has "Privilege Separation" enabled but no ACL granted. Either:
- Uncheck Privilege Separation and recreate the token, or
- Add an ACL: **Datacenter → Permissions → Add → API Token Permission** → path `/`, token `root@pam!docker-dash`, role `PVEVMAdmin`

## Next step

You have a working Proxmox. Now try [ESXi → Proxmox migration walkthrough](../howto/esxi-to-proxmox-migration) to test the Sprint 7 tool end-to-end.

## References

- [Proxmox VE Installation guide (official)](https://pve.proxmox.com/wiki/Installation)
- [Nested virtualization on ESXi](https://williamlam.com/2014/08/enabling-nested-esxi-in-vsphere-web-client.html)
- [Docker Dash Proxmox howto](../howto/proxmox-integration)
- [Docker Dash VM Migration howto](../howto/vm-migration-to-proxmox)
