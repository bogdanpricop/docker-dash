# Provider artifact catalog

Docker Dash exposes a read-only, provider-neutral catalog for VM templates and installation media:

```http
GET /api/providers/:hostId/artifacts?kind=vmTemplate&q=debian&limit=200
```

Supported inventory sources:

- Proxmox VE: QEMU templates, ISO media and LXC templates;
- VMware vSphere/ESXi: VM templates and datastore ISO media;
- Xen Orchestra/XAPI: VM templates;
- raw Xen: explicitly unsupported because xl/xm does not expose a portable persistent template catalog.

The response uses opaque `dda_art_*` IDs. Native provider references are encrypted at rest and omitted from API responses. Reads require authentication and effective `view` access to the endpoint. The catalog does not authorize provisioning; clone/create remains a separate preflighted operation.

Official model references: [Proxmox storage content](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf), [vSphere VirtualMachine](https://developer.broadcom.com/xapis/vsphere-web-services-api/latest/vim.VirtualMachine.html), [vSphere datastore browser](https://developer.broadcom.com/xapis/vsphere-web-services-api/latest/vim.host.DatastoreBrowser.html), [XAPI VM templates](https://xapi-project.github.io/xen-api/classes/vm.html), [Xen Orchestra templates](https://docs.xen-orchestra.com/vm-templates).
