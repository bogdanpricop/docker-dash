# Provider VM provisioning

Docker Dash supports safety-gated VM creation from cataloged VM templates.

```http
POST /api/providers/:hostId/artifacts/:artifactId/clone/preflight
POST /api/providers/:hostId/artifacts/:artifactId/clone
Idempotency-Key: <8-200 visible ASCII characters>
```

The feature is disabled by default. Enable it explicitly with:

```env
DD_PROVIDER_VM_PROVISIONING=true
```

Preflight remains readable while disabled and reports `RELEASE_DISABLED`. Submit requires an authenticated administrator, effective `operate` access to the provider host, writeable application mode, a current plan hash, `confirm=true`, typed target VM name and an Idempotency-Key.

Provider support:

- Proxmox VE: full and linked QEMU template clones, optional target storage/node, durable UPID reconciliation;
- VMware vSphere/ESXi: full `CloneVM_Task` to a live folder/resource pool/datastore, powered off;
- direct XAPI: linked `VM.clone` or full `VM.copy`, followed by a durable `VM.provision` stage;
- Xen Orchestra REST and raw Xen: explicitly unsupported until a task-safe official template instantiate API is available.

Native template, storage and task references are encrypted and never returned. A completed provider task is not enough for success: Docker Dash verifies the new VM in live inventory and returns its canonical `ddr_vm_*` ID. Interrupted or indeterminate outcomes are reconciled without replay; unresolved results become `unknown` and retain their locks.

Official references: [Proxmox API viewer](https://pve.proxmox.com/pve-docs/api-viewer/), [vSphere CloneVM_Task](https://developer.broadcom.com/xapis/vsphere-web-services-api/latest/vim.VirtualMachine.html), [vSphere CloneSpec](https://developer.broadcom.com/xapis/vsphere-web-services-api/latest/vim.vm.CloneSpec.html), [XAPI VM methods](https://xapi-project.github.io/new-docs/xen-api/classes/vm/index.html), [Xen Orchestra VM templates](https://docs.xen-orchestra.com/vm-templates).
