---
slug: vsphere-integration
title: VMware vSphere / ESXi integration (alpha)
title_ro: Integrare VMware vSphere / ESXi (alpha)
category: docker-dash
difficulty: intermediate
icon: fas fa-server
summary: Register a standalone ESXi host or a vCenter Server in Docker Dash to browse VMs, ESXi hosts, and datastores.
summary_ro: Inregistreaza un ESXi standalone sau vCenter Server in Docker Dash pentru a vizualiza VM-uri, host-uri ESXi si datastore-uri.
---

## Positioning

Docker Dash's vSphere / ESXi integration is **read-only in this alpha**. It shows you what's running on your ESXi lab or vCenter cluster so you can decide what to migrate off — the actual migration TO Proxmox happens via [VM Migration](../howto/vm-migration-to-proxmox).

**Anti-features (won't do):**
- Power operations on VMs (start / stop / restart) — use the vSphere client
- Snapshot management — use the vSphere client
- VM console (noVNC / SPICE / VMRC) — the vSphere client already does this
- Editing VM configuration — vSphere client

If you need any of these → use the native vSphere client. That is the design.

## Requirements

- ESXi 6.7 or newer (standalone free / paid), or vCenter Server 6.7+
- A username + password with at least "Read-only" role on the target
- HTTPS reachable from docker-dash to the ESXi/vCenter endpoint on port 443

## Register in Docker Dash

1. Sidebar → **Hosts** → **Non-Docker host (alpha)**
2. Daemon type: **VMware vSphere / ESXi**
3. Name: `esxi-lab` (or whatever you like)
4. Endpoint: `https://esxi.example.com` (no path, no port — port 443 assumed)
5. Username:
   - Standalone ESXi: `root` (or a dedicated user)
   - vCenter: `administrator@vsphere.local` (or a dedicated user)
6. Password: (your password)
7. Skip TLS verification: ☑ **checked by default** — ESXi ships with a self-signed cert
8. Submit

Sidebar → **vSphere / ESXi (alpha)** appears.

## What you'll see

Three tabs:

- **VMs** — name, power state, guest OS, vCPU, memory, UUID
- **ESXi Hosts** — hostname, connection state, hardware model, CPU cores + MHz, memory, ESXi version
- **Datastores** — name, type (VMFS/NFS/vSAN), capacity, free space, used %, accessible

For standalone ESXi you'll see 1 ESXi host in the "ESXi Hosts" tab (itself). For vCenter you'll see all managed hosts.

## Create a dedicated read-only user (recommended)

### On standalone ESXi

1. ESXi web client → **Manage** → **Security & users** → **Users** → **Add user**
2. User name: `dockerdash`, description: `Docker Dash read-only`, set a password
3. **Manage** → **Security & users** → **Permissions** → **Add user permission**
4. User: `dockerdash`, Role: **Read only**
5. Register in Docker Dash using this user instead of `root`

### On vCenter Server

1. vSphere Web Client → **Menu** → **Administration** → **Users and Groups**
2. Add user `dockerdash` in the `vsphere.local` domain
3. **Access Control** → **Global Permissions** → **Add**
4. User: `dockerdash@vsphere.local`, Role: **Read-only**, ☑ Propagate to children
5. Register in Docker Dash using `dockerdash@vsphere.local`

## Security notes

- **Password is encrypted at rest** via AES-256-GCM (`enc:` prefix on `daemon_config`) — same helper used for git credentials / Docker registry auth / K8s tokens
- **Session cookie cached in-memory** for 20 minutes per host — reduces SOAP login round-trips. Cleared on daemon restart
- **All routes require authentication** in Docker Dash (session cookie); no unauthenticated pass-through to ESXi
- `skipTlsVerify: true` is the default because ESXi ships with a self-signed cert. **In production**, either add the ESXi CA to your trust store OR install a valid cert on ESXi and untick the box

## Alpha caveats

- Read-only. Every write operation is deliberately out-of-scope
- No pagination — for vCenter with 500+ VMs, the initial load may be slow (SOAP retrieveProperties is bandwidth-heavy). Follow-up will add filters + pagination
- SOAP session doesn't refresh automatically — a 20-min idle session cache means a first request after 20 min triggers a fresh login. Subsequent calls are cached
- No selection of read-only vs full-access roles at Docker Dash level — the level is controlled by the vSphere user's assigned role
- End-to-end **not** verified against vCenter in this session (developed against ESXi 8.0 SOAP docs)

## Troubleshooting

**"vSphere SOAP error: Cannot complete login due to an incorrect user name or password"**

Wrong credentials. For standalone ESXi, use `root`. For vCenter, remember the `@vsphere.local` suffix.

**"vSphere SOAP timeout after 30s"**

Endpoint unreachable, or vCenter under heavy load. Test manually: `curl -sk -o /dev/null -w '%{http_code}\n' https://esxi.example.com/sdk` should return `200` or `400`.

**"vSphere connect error: certificate has expired"**

`skipTlsVerify` was unchecked but the ESXi/vCenter cert is expired or self-signed. Re-check the box, or fix the cert.

**"vSphere SOAP error: Permission to perform this operation was denied"**

User has fewer permissions than needed. `Read-only` role on the top-level object (root folder for ESXi, data center or higher for vCenter) is enough.

**Empty VMs list on vCenter, but the vSphere client shows VMs**

The user is scoped to a specific folder/host and the query at root sees nothing. Grant `Read-only` at a higher level (data center or vCenter root).

## References

- [vSphere Web Services SDK reference](https://developer.vmware.com/apis/vsphere-automation/)
- [Docker Dash VM Migration howto](../howto/vm-migration-to-proxmox) — actually move VMs OFF vSphere
- [Docker Dash ESXi → Proxmox walkthrough](../howto/esxi-to-proxmox-migration)
