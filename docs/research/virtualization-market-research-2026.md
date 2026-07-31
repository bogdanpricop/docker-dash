# Market research 2026: managementul virtualizării, private cloud și infrastructură hibridă

**Data cercetării:** 26 iulie 2026  
**Produs analizat:** Docker Dash, inclusiv integrarea Xen/XCP-ng/XenServer introdusă în ramura curentă  
**Domeniu:** platforme de management pentru mașini virtuale, HCI, private cloud, cloud hibrid și convergență VM–containere  
**Statut:** document de research și backlog candidat; nu este o promisiune contractuală și nu afirmă paritate de funcții între ediții sau versiuni.

## 1. Rezumat executiv

Piața nu mai este împărțită simplu între „hypervisoare”. Liderii vând un plan de control complet: inventar multi-site, lifecycle, self-service, policy-as-code, rețelistică și stocare software-defined, backup/DR, securitate, observabilitate, FinOps și o punte între VM-uri, Kubernetes și cloud public. Pentru Docker Dash, oportunitatea nu este să copieze integral un VCF, OpenStack sau Azure Local, ci să devină un **control plane pragmatic, vendor-neutral și sigur** pentru flote mixte de containere și VM-uri.

Selecția strategică rezultată este:

1. VMware vSphere / VMware Cloud Foundation (Broadcom)
2. Microsoft Hyper-V / Azure Local
3. Nutanix AHV / Prism / Nutanix Cloud Platform
4. Proxmox Virtual Environment
5. OpenStack
6. Red Hat OpenShift Virtualization
7. XCP-ng / Xen Orchestra
8. Apache CloudStack
9. XenServer
10. SUSE Harvester

Acesta este un **top de relevanță compozit**, nu un clasament absolut de venituri sau cotă. El maximizează împreună reprezentarea enterprise, open source, HCI, cloud-service-provider, Kubernetes-native, edge și Xen. Cercetarea a extras **225 de capabilități distincte confirmate** în taxonomia comparativă și le-a transformat într-un catalog deduplicat de **450 de feature-uri candidate** pentru Docker Dash.

Recomandarea principală este un roadmap în șase valuri: (1) contract comun de provider și inventar profund; (2) provisioning, consolă și operații VM sigure; (3) migrare, HA și maintenance orchestration; (4) backup/DR verificabil; (5) networking/storage/security policy; (6) self-service, cost, AIOps și cloud hibrid. Primele rezultate utile pot fi livrate fără a construi un cloud complet: capability discovery uniform, VM detail, console proxy, clone/template, live migration preflight, maintenance drain, job engine persistent și politici de backup cu restore drill.

## 2. Metodologie, criterii și limite

### 2.1 Metodă

Research-ul a fost realizat în cinci pași:

1. inventarierea documentației oficiale și a paginilor oficiale de produs disponibile la data cercetării;
2. normalizarea funcțiilor într-o taxonomie neutră, evitând numele comerciale ca feature-uri duplicate;
3. marcarea unei capabilități ca „nativă” numai când sursa oficială o descrie direct, iar ca „adiacentă/condiționată” când necesită un produs din aceeași suită, un driver, un storage backend sau o integrare;
4. inspecția read-only a repo-ului Docker Dash: servicii/rute/UI pentru Docker, Podman, Proxmox, vSphere, Xen, Incus/LXD și Kubernetes, plus audit, posture, alerts, GitOps, observabilitate și backup-ul configurației;
5. deduplicarea oportunităților într-un backlog de produs, cu valoare, efort relativ și orizont.

Nu au fost folosite afirmații de marketing drept dovadă pentru superioritate. Pagini de produs sunt folosite pentru existența funcției; limitările și condițiile sunt păstrate când documentația le precizează. Unde o celulă nu a putut fi confirmată din sursele consultate, este lăsată neconfirmată — absența marcajului nu înseamnă neapărat că produsul nu poate realiza funcția printr-un partener.

### 2.2 Criteriul „Top 10”

Scorul editorial folosește șase axe, total 100 puncte:

| Axă | Pondere | Întrebarea evaluată |
|---|---:|---|
| Maturitate și adopție enterprise | 25 | Poate opera infrastructuri critice, mari și eterogene? |
| Amploarea control plane-ului | 20 | Acoperă compute, storage, network, identity, policy și DR? |
| VM lifecycle și reziliență | 20 | Are provisioning, migrare, HA, backup și mentenanță mature? |
| Automatizare și deschidere | 15 | API, SDK, IaC, events, extensii, ecosystem? |
| Convergență hibridă/VM–container | 10 | Leagă private cloud, edge, cloud public și Kubernetes? |
| Relevanță pentru Docker Dash | 10 | Aduce un model sau o integrare cu ROI realist pentru produs? |

Scorurile sunt o evaluare comparativă reproductibilă pe aceste criterii, nu o măsură financiară auditată.

### 2.3 Legendă

Coduri vendor: `VMW` VMware; `MS` Microsoft; `NUT` Nutanix; `PVE` Proxmox; `OS` OpenStack; `RHV` Red Hat OpenShift Virtualization; `XCP` XCP-ng/Xen Orchestra; `ACS` Apache CloudStack; `XEN` XenServer; `HAR` Harvester.

- **Nativ/confirmat:** funcția apare direct în documentația oficială a platformei/suitei.
- **Adiacent/condiționat:** necesită un component al suitei, un backend/driver sau are limitări explicite.
- **Neconfirmat:** nu a fost găsită dovadă suficientă în setul de surse; nu este echivalent cu „imposibil”.

## 3. Top 10 justificat

| Loc | Ecosistem | Scor | De ce este în top | Potrivire pentru Docker Dash |
|---:|---|---:|---|---|
| 1 | VMware vSphere / VCF | 94 | Cel mai complet model integrat de private cloud enterprise: fleet, lifecycle, compute, vSAN, NSX, automation, operations și security posture. | Etalon pentru operații sigure, DRS/HA, policy și fleet UX. |
| 2 | Microsoft Hyper-V / Azure Local | 91 | Bază enterprise Windows, clustering/Replica, control Azure Arc, ARM/Bicep/Terraform, identitate și servicii hibride. | Provider Windows/WinRM/Arc și model pentru control plane hibrid. |
| 3 | Nutanix AHV / Prism | 89 | HCI integrat, operații „one-click”, DR, Flow networking/security, analytics, self-service și cost governance. | Etalon pentru simplitate, day-2 automation și FinOps. |
| 4 | Proxmox VE | 86 | Platformă open-source foarte accesibilă, KVM+LXC, Ceph/ZFS, HA, SDN/firewall, API și backup profund integrat. | Cea mai apropiată țintă pentru paritate rapidă în segmentul SMB/mid-market. |
| 5 | OpenStack | 85 | Control plane IaaS modular și foarte extensibil, multi-tenant, multi-hypervisor, cu ecosistem complet de servicii. | Etalon pentru modelul resource/provider, quotas, projects și service catalog. |
| 6 | Red Hat OpenShift Virtualization | 83 | KubeVirt enterprise: VM și containere în același control plane Kubernetes, GitOps/operators, migrare și CSI/CNI. | Direcția strategică pentru convergența VM–container și policy-as-code. |
| 7 | XCP-ng / Xen Orchestra | 81 | Stack Xen open-source orientat management centralizat, backup/DR foarte competitiv, API și self-service. | Integrare deja începută; cel mai mare ROI pentru extinderea Xen. |
| 8 | Apache CloudStack | 79 | IaaS turnkey pentru service providers, multi-hypervisor, networking avansat, usage/billing, projects, API și extensii. | Model bun pentru multi-tenancy, quotas, offerings și billing-ready usage. |
| 9 | XenServer | 76 | XAPI matur, HA, live/storage migration, WLB, GPU/vGPU și integrare puternică în ecosistemul Citrix. | Completează contractul Xen pentru ediții comerciale și VDI/GPU. |
| 10 | SUSE Harvester | 74 | HCI Kubernetes-native bazat pe KubeVirt/Longhorn/RKE2, VM lifecycle, backup, live migration și Rancher. | Țintă modernă pentru edge și API Kubernetes fără greutatea OpenShift. |

## 4. Profilurile jucătorilor

### 4.1 VMware vSphere / VMware Cloud Foundation

**Poziționare.** VCF 9.1 este un private-cloud stack integrat cu interfață unificată pentru Operate/Manage/Protect/Build, fleet lifecycle, VCF Automation, vSphere, vSAN și NSX. Broadcom descrie explicit Active Findings, security posture management, log management și namespace self-service; VCF 9.0 a consolidat lifecycle, certificate, license, identity și fleet management în VCF Operations. [VCF 9.1 hands-on feature overview](https://blogs.vmware.com/cloud-foundation/2026/05/12/vcf-9-1-is-available-explore-the-new-features-in-hands-on-labs/), [VCF 9.0 use cases și fleet](https://blogs.vmware.com/cloud-foundation/2025/06/17/vcf-9-0-use-cases/), [vSphere în VCF 9.0](https://blogs.vmware.com/cloud-foundation/2025/06/23/vsphere-in-vcf-9-0-whats-new/).

**Puncte forte:** profunzime VM/cluster; vMotion/DRS/HA; control integrat compute-storage-network; lifecycle și patch orchestration; observabilitate și diagnostic; multi-tenancy/automation; ecosistem și SDK.

**Puncte slabe/riscuri:** cost și complexitate operațională ridicate; dependență de bundle și ediție; schimbări de licențiere; integrarea corectă necesită mai multe API-uri decât simplul vSphere SOAP. Docker Dash nu trebuie să mimeze toate componentele VCF într-un singur provider.

### 4.2 Microsoft Hyper-V / Azure Local

**Poziționare.** Hyper-V rămâne hypervisorul enterprise Windows, iar Azure Local proiectează VM-urile on-premises în Azure prin Arc Resource Bridge și ARM. Managementul VM include portal, CLI, PowerShell, ARM, Bicep și Terraform; Hyper-V adaugă live/storage migration, failover clustering, Replica, shielded VMs și HGS. [Azure Local VM management](https://learn.microsoft.com/en-us/azure/azure-local/manage/azure-arc-vm-management-overview), [Hyper-V overview](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/overview), [Hyper-V features](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/features-terminology), [Hyper-V Replica](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/replication-overview).

**Puncte forte:** integrare Windows/AD/Entra; clustering și DR; gestionare cloud hibridă; managed identity și Azure services; GPU-P/DDA; PowerShell/WMI și ARM; security model cu shielded VMs.

**Puncte slabe/riscuri:** funcțiile sunt împărțite între Hyper-V, Failover Cluster, Windows Admin Center, SCVMM și Azure Arc; operațiile suportate diferă între VM-uri Arc și VM-uri gestionate local; dependența de Azure poate fi incompatibilă cu site-uri complet izolate. [Operații suportate și limite Azure Local](https://learn.microsoft.com/en-us/azure/azure-local/manage/virtual-machine-operations).

### 4.3 Nutanix AHV / Prism / Nutanix Cloud Platform

**Poziționare.** AHV este hypervisorul integrat în Nutanix Cloud Infrastructure, Prism oferă management unificat, iar NCM extinde spre self-service, cost și security. Flow furnizează VPC, microsegmentare și firewall distribuit; Nutanix DR oferă Async/NearSync/Sync și Metro. [AHV](https://www.nutanix.com/products/ahv), [Nutanix Cloud Platform](https://www.nutanix.com/products/cloud-platform), [Flow](https://www.nutanix.com/products/flow), [Nutanix Disaster Recovery](https://www.nutanix.com/products/nutanix-cloud-infrastructure/disaster-recovery).

**Puncte forte:** HCI coerent și simplu; scale-out; one-click lifecycle; data protection și DR; rich analytics; networking/security integrate; self-service și cost governance; migrare prin Nutanix Move.

**Puncte slabe/riscuri:** valoarea maximă vine din stack-ul Nutanix complet; anumite capabilități sunt produse/licențe separate; API-urile și edițiile trebuie negociate explicit, nu presupuse din Prism/AHV.

### 4.4 Proxmox Virtual Environment

**Poziționare.** Proxmox VE 9.2 combină KVM și LXC, management web/CLI/REST, cluster multi-master, HA, live migration, Ceph/ZFS, SDN, firewall și integrare Proxmox Backup Server. [Proxmox VE features](https://www.proxmox.com/en/products/proxmox-virtual-environment/features), [Proxmox VE 9.2 downloads/datasheet](https://www.proxmox.com/en/downloads/proxmox-virtual-environment/), [Admin Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf).

**Puncte forte:** open source și cost redus; API JSON Schema; instalare/operare directă; VM+LXC; storage foarte flexibil; Ceph/ZFS; backup incremental, dedup, live restore și file restore prin PBS; RBAC/realms.

**Puncte slabe/riscuri:** mai puține servicii hibrid-cloud și FinOps native decât suitele enterprise; unele funcții avansate cer PBS sau Ceph; clusterele și quorum-ul trebuie operate atent. Integrarea curentă Docker Dash este predominant read-only.

### 4.5 OpenStack

**Poziționare.** OpenStack este un control plane IaaS modular: Nova compute, Neutron networking, Cinder block, Glance images, Keystone identity, Placement, Horizon și servicii opționale pentru orchestration, HA, DNS, LBaaS, secrets, telemetry și bare metal. [OpenStack 2026.1 docs](https://docs.openstack.org/2026.1/), [Nova](https://docs.openstack.org/nova/2026.1/), [servicii OpenStack](https://docs.openstack.org/2025.2/install/).

**Puncte forte:** multi-tenancy și quotas foarte mature; API-first; modularitate și extensibilitate; multi-hypervisor/bare metal; networking și storage pluggable; scale prin Cells v2; ecosistem mare.

**Puncte slabe/riscuri:** complexitate mare de instalare/upgrade și integrare; experiența depinde de distribuție și operator; nu toate driverele au paritate. De exemplu, live migration cross-cell nu este disponibilă. [Nova Cells v2](https://docs.openstack.org/nova/2026.1/admin/cells.html), [live migration](https://docs.openstack.org/nova/latest/admin/configuring-migrations.html).

### 4.6 Red Hat OpenShift Virtualization

**Poziționare.** OpenShift Virtualization rulează VM-uri Windows/Linux împreună cu containere prin KubeVirt și CRD-uri Kubernetes; oferă import/clone, disk/NIC management, console și live migration. CSI snapshots asigură backup/restore, iar Multus/OVN-Kubernetes/NMState acoperă rețeaua. [OpenShift Virtualization overview](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/virtualization/about), [virtualization guide](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html-single/virtualization/), [backup și snapshots](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/virtualization/backup-and-restore).

**Puncte forte:** un singur API declarativ pentru VM și containere; operators/GitOps/policy; self-service prin namespaces; convergență de networking, storage și observabilitate Kubernetes; ecosistem Red Hat.

**Puncte slabe/riscuri:** cerințe și complexitate OpenShift; funcțiile depind de CSI/CNI și access mode; anumite configurații single-node/cloud au restricții de migrare/snapshot; necesită model Kubernetes, nu doar un adaptor hypervisor.

### 4.7 XCP-ng / Xen Orchestra

**Poziționare.** XCP-ng oferă hypervisorul/pool-urile XAPI, iar Xen Orchestra este planul recomandat de management și backup la scară. XO acoperă full/incremental backup, CR/DR, GFS retention, health checks, file/differential restore, encryption, self-service și API. [XCP-ng API guidance](https://docs.xcp-ng.org/management/manage-locally/api/), [XO backup concepts](https://docs.xen-orchestra.com/backups), [incremental backups](https://docs.xen-orchestra.com/incremental_backups), [XCP-ng HA](https://docs.xcp-ng.org/management/ha/).

**Puncte forte:** management Xen centralizat; backup/DR bogat și eficient; open source; pool HA/live/storage migration; self-service/ACL; integrare bună pentru infrastructuri SMB/enterprise.

**Puncte slabe/riscuri:** paritatea depinde de XCP-ng vs XenServer și XO edition/build; storage și versiunea XAPI impun limite; HA necesită shared storage și operare disciplinată; backup-ul raw `xl` nu este un contract portabil. Docker Dash are deja inventory, power, snapshots și task-uri, dar nu provisioning, console, migration, HA sau backup orchestration.

### 4.8 Apache CloudStack

**Poziționare.** CloudStack este un IaaS turnkey multi-hypervisor, orientat service providers/private cloud: zones/pods/clusters, offerings, projects/domains, quotas/usage, advanced networking, autoscaling, Kubernetes service, backup și extensii. 4.21 a introdus inclusiv framework de extensii, Proxmox/Hyper-V adapters, vTPM și incremental snapshots. [CloudStack feature catalog](https://cloudstack.apache.org/features/), [CloudStack 4.21 highlights](https://docs.cloudstack.apache.org/en/4.21.0.0/releasenotes/about.html), [Admin Guide](https://docs.cloudstack.apache.org/en/latest/adminguide/).

**Puncte forte:** multi-tenancy/billing ready; API și UI complete; multi-hypervisor; VPC/network services; resource offerings și quotas; projects/domains; operational mai compact decât OpenStack.

**Puncte slabe/riscuri:** capabilitățile diferă pe hypervisor/plugin; unele integrări sunt preview; arhitectura este orientată cloud orchestration, nu management direct minimal. Un provider Docker Dash trebuie să expose capabilities reale per zone/hypervisor.

### 4.9 XenServer

**Poziționare.** XenServer 9 păstrează modelul resource pool/XAPI și oferă live/storage migration, HA cu fencing, Workload Balancing, GPU passthrough/vGPU, rolling pool upgrades și Conversion Manager. [XenServer 9 technical overview](https://docs.xenserver.com/en-us/xenserver/9/technical-overview), [migration](https://docs.xenserver.com/en-us/xenserver/9/vms/migrate.html), [HA](https://docs.xenserver.com/en-us/xenserver/9/high-availability), [graphics/vGPU](https://docs.xenserver.com/en-us/xenserver/9/graphics).

**Puncte forte:** XAPI matur; integrare VDI/Citrix; HA și migrare; WLB; GPU/vGPU; management de pool; tooling de conversie VMware.

**Puncte slabe/riscuri:** licențiere și integrare comercială; unele funcții GPU sunt preview sau au restricții; nu are breadth de private cloud similar VCF/OpenStack; backup-ul complet este de regulă extern. XenServer 9 elimină și tehnologii legacy, deci version/capability discovery este obligatoriu. [What’s new XenServer 9](https://docs.xenserver.com/en-us/xenserver/9/whats-new).

### 4.10 SUSE Harvester

**Poziționare.** Harvester 1.7 este HCI open-source bazat pe KubeVirt, Longhorn și RKE2: VM lifecycle, live migration, snapshot/backup/restore, volume și VLAN networks, Rancher integration și API Kubernetes. [Harvester overview](https://docs.harvesterhci.io/v1.7/), [Harvester API](https://docs.harvesterhci.io/v1.7/category/api/), [backup/snapshot/restore](https://docs.harvesterhci.io/v1.7/vm/backup-restore).

**Puncte forte:** VM+Kubernetes/edge; API declarativ; Longhorn storage; simplu față de OpenShift; Rancher multi-cluster; backup S3/NFS; maintenance migration.

**Puncte slabe/riscuri:** produs mai tânăr; funcțiile depind de Longhorn/KubeVirt; single-node exclude HA/live migration; upgrade-urile au version-skew constraints; documentația 1.7 notează o problemă Longhorn V2 care poate bloca operații după ștergerea ultimului snapshot/backup. [cerințe/HA](https://docs.harvesterhci.io/v1.7/install/requirements/), [upgrade](https://docs.harvesterhci.io/v1.7/upgrade/index/).

## 5. Taxonomie comparativă — 225 capabilități distincte

Marcajele din fiecare secțiune sunt susținute de sursele oficiale legate la începutul secțiunii. „Nativ” include planul de control principal; „condiționat” include componente oficiale ale suitei, pluginuri/drivere, storage classes sau ediții.

### T1. Control plane, inventar și organizare (C001–C015)

Surse de bază: [VCF fleet operations](https://blogs.vmware.com/cloud-foundation/2025/06/17/vcf-9-0-use-cases/), [Azure Local VM management](https://learn.microsoft.com/en-us/azure/azure-local/manage/azure-arc-vm-management-overview), [Nutanix Cloud Platform](https://www.nutanix.com/products/cloud-platform), [Proxmox features](https://www.proxmox.com/en/products/proxmox-virtual-environment/features), [OpenStack services](https://docs.openstack.org/2025.2/install/), [OpenShift Virtualization](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/virtualization/about), [XCP-ng architecture/API](https://docs.xcp-ng.org/management/manage-locally/api/), [CloudStack features](https://cloudstack.apache.org/features/), [XenServer overview](https://docs.xenserver.com/en-us/xenserver/9/technical-overview), [Harvester overview](https://docs.harvesterhci.io/v1.7/).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C001 | Inventar central de VM-uri | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C002 | Inventar central de hosturi/noduri | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C003 | Inventar de clustere/pool-uri | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C004 | Inventar de datastore/storage repositories | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C005 | Inventar de rețele virtuale | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C006 | Management multi-site / multi-datacenter | VMW, MS, NUT, OS, XCP, ACS | PVE, RHV, XEN, HAR |
| C007 | Management global/fleet dintr-un singur UI | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C008 | Grupare prin foldere/proiecte/namespaces | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C009 | Tags, labels sau categories | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C010 | Căutare și filtrare globală | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C011 | Custom fields / metadata extensibilă | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C012 | Resource hierarchy și ownership | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C013 | Vizualizare capacity agregată | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C014 | Health sumarizat pe infrastructură | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C015 | Discovery/import pentru resurse existente | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |

### T2. VM lifecycle și provisioning (C016–C030)

Surse: [Azure Local VM operations](https://learn.microsoft.com/en-us/azure/azure-local/manage/virtual-machine-operations), [Proxmox feature catalog](https://www.proxmox.com/en/products/proxmox-virtual-environment/features), [OpenStack Nova](https://docs.openstack.org/nova/2026.1/), [OpenShift VM management](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html-single/virtualization/), [XenServer CLI](https://docs.xenserver.com/en-us/xenserver/9/command-line-interface), [Harvester API](https://docs.harvesterhci.io/v1.7/category/api/).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C016 | Creare VM din wizard/API | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C017 | Start VM | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C018 | Shutdown graceful | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | guest tools |
| C019 | Power-off forțat | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C020 | Reboot graceful / hard reset | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | guest tools |
| C021 | Pause / unpause | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C022 | Suspend / resume cu stare | VMW, MS, NUT, PVE, OS, RHV, XCP, XEN | ACS, HAR |
| C023 | Delete VM cu confirmare | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C024 | Clone complet VM | VMW, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | MS |
| C025 | Linked/thin clone | VMW, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | MS |
| C026 | Template / golden image | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C027 | Content/image library | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C028 | Cloud-init / user-data | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C029 | Sysprep / guest customization | VMW, MS, NUT, PVE, OS, XCP, ACS, XEN | RHV, HAR |
| C030 | Bulk lifecycle actions | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |

### T3. Compute, virtual hardware și acceleratoare (C031–C045)

Surse: [Hyper-V compatibility matrix](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/hyper-v-feature-compatibility-by-generation-and-guest), [Azure Local GPU](https://learn.microsoft.com/en-us/azure/azure-local/manage/gpu-preparation), [Nova compute administration](https://docs.openstack.org/nova/2025.2/admin/), [XenServer graphics](https://docs.xenserver.com/en-us/xenserver/9/graphics), [XCP-ng VM limits](https://docs.xcp-ng.org/installation/requirements/), [Harvester requirements](https://docs.harvesterhci.io/v1.7/install/requirements/).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C031 | Modificare vCPU | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | hot-add depinde de guest |
| C032 | Modificare memorie | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | hot-add depinde de guest |
| C033 | Dynamic memory / ballooning | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | guest tools |
| C034 | CPU topology sockets/cores/threads | VMW, MS, NUT, PVE, OS, RHV, XCP, XEN, HAR | ACS |
| C035 | CPU pinning / dedicated cores | VMW, MS, NUT, PVE, OS, RHV, XCP, XEN, HAR | ACS |
| C036 | NUMA topology și affinity | VMW, MS, NUT, PVE, OS, RHV, XCP, XEN, HAR | ACS |
| C037 | Huge pages | VMW, NUT, PVE, OS, RHV, XCP, XEN, HAR | MS, ACS |
| C038 | CPU compatibility/baseline | VMW, MS, NUT, PVE, OS, XCP, XEN, HAR | RHV, ACS |
| C039 | Nested virtualization | VMW, MS, NUT, PVE, OS, RHV, XCP, XEN, HAR | ACS |
| C040 | PCI passthrough | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C041 | SR-IOV NIC passthrough | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C042 | GPU passthrough dedicat | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C043 | vGPU / GPU partitioning | VMW, MS, NUT, OS, RHV, XCP, ACS, XEN, HAR | PVE |
| C044 | vTPM | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C045 | USB / device passthrough | VMW, MS, NUT, PVE, OS, RHV, XCP, XEN, HAR | ACS |

### T4. Placement, migrare, HA și mentenanță (C046–C060)

Surse: [XenServer migration](https://docs.xenserver.com/en-us/xenserver/9/vms/migrate.html), [XenServer HA](https://docs.xenserver.com/en-us/xenserver/9/high-availability), [XCP-ng HA](https://docs.xcp-ng.org/management/ha/), [Proxmox HA/migration](https://www.proxmox.com/en/products/proxmox-virtual-environment/features), [Nova migration](https://docs.openstack.org/nova/latest/admin/configuring-migrations.html), [Azure VM load balancing](https://learn.microsoft.com/en-us/azure/azure-local/manage/vm-load-balancing), [Harvester maintenance](https://docs.harvesterhci.io/v1.7/host/).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C046 | Live migration compute | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | storage/CPU constraints |
| C047 | Cold migration | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C048 | Storage live migration | VMW, MS, NUT, PVE, OS, XCP, ACS, XEN | RHV, HAR |
| C049 | Cross-cluster/pool migration | VMW, MS, NUT, PVE, XCP, ACS, XEN | OS, RHV, HAR |
| C050 | Cross-site/cloud workload mobility | VMW, MS, NUT, XCP, ACS | PVE, OS, RHV, XEN, HAR |
| C051 | Host evacuation / maintenance mode | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C052 | Automatic VM restart după host failure | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C053 | Fencing / split-brain protection | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | implementation varies |
| C054 | HA admission/capacity planning | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN | HAR |
| C055 | VM restart priority/order | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN | HAR |
| C056 | Affinity / anti-affinity VM-host | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C057 | Anti-affinity VM-VM | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C058 | Automated workload balancing / DRS | VMW, MS, NUT, OS, XCP, ACS, XEN | PVE, RHV, HAR |
| C059 | Predictive placement / recommendation | VMW, NUT, OS | MS, PVE, RHV, XCP, ACS, XEN, HAR |
| C060 | Rolling host upgrade fără oprirea workload-urilor migrabile | VMW, MS, NUT, PVE, OS, RHV, XCP, XEN, HAR | ACS |

### T5. Storage și data plane (C061–C075)

Surse: [Proxmox storage/Ceph](https://www.proxmox.com/en/products/proxmox-virtual-environment/features), [OpenStack Cinder](https://docs.openstack.org/cinder/2025.2/), [CloudStack storage](https://docs.cloudstack.apache.org/en/latest/adminguide/storage.html), [OpenShift storage matrix](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html-single/virtualization/), [Harvester Longhorn backup/storage](https://docs.harvesterhci.io/v1.7/vm/backup-restore), [XCP-ng storage limits](https://docs.xcp-ng.org/installation/requirements/).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C061 | Creare/atașare/detașare disk | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C062 | Hot add/remove disk | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | guest/backend dependent |
| C063 | Resize/expand disk | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | shrink rareori suportat |
| C064 | Thin provisioning | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | backend dependent |
| C065 | Thick/preallocated provisioning | VMW, MS, NUT, PVE, OS, XCP, ACS, XEN | RHV, HAR |
| C066 | Storage policy/class based placement | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C067 | Storage QoS / IOPS limit | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | backend dependent |
| C068 | Volume multi-attach/shared disk | VMW, MS, NUT, PVE, OS, RHV, ACS, XEN | XCP, HAR |
| C069 | NFS storage | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C070 | iSCSI / Fibre Channel | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C071 | Ceph/RBD distributed storage | PVE, OS, RHV, ACS | VMW, MS, NUT, XCP, XEN, HAR |
| C072 | Native HCI distributed block storage | VMW, MS, NUT, PVE, RHV, XCP, HAR | OS, ACS, XEN |
| C073 | Storage replication | VMW, MS, NUT, PVE, OS, XCP, ACS, XEN, HAR | RHV |
| C074 | Deduplication și compression | VMW, MS, NUT, PVE, OS, XCP, HAR | RHV, ACS, XEN |
| C075 | Storage health, latency și capacity telemetry | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |

### T6. Snapshots, backup, restore și DR (C076–C090)

Surse: [XO backup concepts](https://docs.xen-orchestra.com/backups), [XO incremental backup](https://docs.xen-orchestra.com/incremental_backups), [Proxmox backup/PBS](https://www.proxmox.com/en/products/proxmox-virtual-environment/features), [OpenShift backup](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/virtualization/backup-and-restore), [Harvester backup](https://docs.harvesterhci.io/v1.7/vm/backup-restore), [Nutanix DR](https://www.nutanix.com/products/nutanix-cloud-infrastructure/disaster-recovery), [CloudStack Admin Guide](https://docs.cloudstack.apache.org/en/latest/adminguide/).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C076 | VM snapshot create/list/delete | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | backend dependent |
| C077 | Snapshot revert/restore | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C078 | Quiesced/application-consistent snapshot | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | guest agent/VSS |
| C079 | Snapshot cu RAM/memory state | VMW, MS, PVE, XCP, XEN | NUT, OS, RHV, ACS, HAR |
| C080 | Scheduled backup jobs | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C081 | Full VM backup | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C082 | Incremental/delta backup | VMW, MS, NUT, PVE, OS, XCP, ACS, HAR | RHV, XEN |
| C083 | Changed block tracking | VMW, NUT, PVE, OS, XCP, ACS, XEN, HAR | MS, RHV |
| C084 | Backup encryption client-side | VMW, MS, NUT, PVE, OS, XCP, HAR | RHV, ACS, XEN |
| C085 | Immutable backup / retention lock | VMW, MS, NUT, PVE, OS, XCP | RHV, ACS, XEN, HAR |
| C086 | File-level restore | VMW, MS, NUT, PVE, XCP | OS, RHV, ACS, XEN, HAR |
| C087 | Instant/live restore | VMW, NUT, PVE, XCP | MS, OS, RHV, ACS, XEN, HAR |
| C088 | Backup health check / test boot | VMW, NUT, PVE, XCP | MS, OS, RHV, ACS, XEN, HAR |
| C089 | Replication și orchestrated failover/failback | VMW, MS, NUT, PVE, OS, XCP, ACS, XEN, HAR | RHV |
| C090 | Non-disruptive DR test / isolated recovery | VMW, MS, NUT, XCP, ACS | PVE, OS, RHV, XEN, HAR |

### T7. Networking, SDN și servicii de rețea (C091–C105)

Surse: [Nutanix Flow](https://www.nutanix.com/products/flow), [Proxmox SDN/firewall](https://www.proxmox.com/en/products/proxmox-virtual-environment/features), [CloudStack networking](https://cloudstack.apache.org/features/), [OpenStack Neutron](https://docs.openstack.org/neutron/2026.1/), [OpenShift networking](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html-single/virtualization/), [Azure Network ATC](https://learn.microsoft.com/en-us/azure/azure-local/concepts/network-atc-overview), [Harvester networking overview](https://docs.harvesterhci.io/v1.7/networking/harvester-network).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C091 | Virtual switch / bridge management | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C092 | Distributed virtual switch/fabric | VMW, MS, NUT, PVE, OS, RHV, ACS, HAR | XCP, XEN |
| C093 | VLAN tagging/trunking | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C094 | VXLAN/overlay networking | VMW, MS, NUT, PVE, OS, RHV, ACS | XCP, XEN, HAR |
| C095 | EVPN/BGP control plane | VMW, NUT, PVE, OS, RHV, ACS | MS, XCP, XEN, HAR |
| C096 | VPC/tenant virtual networks | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C097 | Overlapping tenant CIDRs | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C098 | Distributed firewall | VMW, NUT, PVE, OS, RHV, ACS | MS, XCP, XEN, HAR |
| C099 | Microsegmentation app/tag-aware | VMW, NUT, OS, RHV | MS, PVE, XCP, ACS, XEN, HAR |
| C100 | Security groups | VMW, MS, NUT, PVE, OS, RHV, ACS | XCP, XEN, HAR |
| C101 | NAT și elastic/public IP | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C102 | Load balancing as a service | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C103 | VPN service/site-to-site | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C104 | DHCP/DNS/IPAM integration | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C105 | Network flow visibility și dependency map | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |

### T8. Securitate platformă și workload (C106–C120)

Surse: [VCF security operations](https://blogs.vmware.com/cloud-foundation/2026/02/06/why-vcf-9-0-improves-it-operations-and-management/), [Hyper-V Gen2 security](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/generation-2-virtual-machine-security-features), [Nutanix Flow Network Security](https://www.nutanix.com/products/flow-network-security), [Nova security/performance](https://docs.openstack.org/nova/2025.2/admin/), [CloudStack security](https://cloudstack.apache.org/features/), [XenServer 9 secure boot](https://docs.xenserver.com/en-us/xenserver/9/whats-new).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C106 | Host Secure Boot | VMW, MS, NUT, PVE, RHV, XCP, XEN, HAR | OS, ACS |
| C107 | VM UEFI Secure Boot | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C108 | VM disk encryption | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C109 | Encryption pentru saved state | VMW, MS, NUT, OS | PVE, RHV, XCP, ACS, XEN, HAR |
| C110 | Encryption live-migration traffic | VMW, MS, NUT, PVE, OS, RHV, XCP, XEN | ACS, HAR |
| C111 | Key management extern/KMS | VMW, MS, NUT, PVE, OS, RHV, ACS | XCP, XEN, HAR |
| C112 | Confidential VMs / SEV / TDX | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |
| C113 | Shielded/guarded workloads | MS | VMW, NUT, OS, RHV, PVE, XCP, ACS, XEN, HAR |
| C114 | Host configuration hardening | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C115 | Security posture/compliance scoring | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |
| C116 | Vulnerability/advisory visibility | VMW, MS, NUT, OS, RHV, XCP, XEN, HAR | PVE, ACS |
| C117 | Automated security remediation | VMW, MS, NUT, RHV | PVE, OS, XCP, ACS, XEN, HAR |
| C118 | Workload isolation și tenant boundaries | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C119 | Secrets vault / key service | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C120 | Malware/ransomware lateral-movement controls | VMW, MS, NUT, RHV | PVE, OS, XCP, ACS, XEN, HAR |

### T9. Identity, acces și audit (C121–C135)

Surse: [Proxmox authentication/RBAC](https://www.proxmox.com/en/products/proxmox-virtual-environment/features), [CloudStack roles/accounts](https://docs.cloudstack.apache.org/en/latest/adminguide/accounts.html), [CloudStack security adapters](https://cloudstack.apache.org/features/), [Azure Local RBAC](https://learn.microsoft.com/en-us/azure/azure-local/manage/azure-arc-vm-management-overview), [XenServer RBAC](https://docs.xenserver.com/en-us/xenserver/9/users/rbac-roles-permissions.html), [XO ACL v2](https://docs.xen-orchestra.com/xo6/acl-v2).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C121 | Local users și groups | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C122 | LDAP integration | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C123 | Active Directory integration | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C124 | SAML/OIDC SSO | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C125 | MFA/TOTP | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C126 | Granular RBAC | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C127 | ACL pe obiect/resource hierarchy | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C128 | Read-only/support/operator personas | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C129 | Project-scoped delegated administrator | VMW, MS, NUT, OS, RHV, ACS, HAR | PVE, XCP, XEN |
| C130 | Service accounts / API tokens | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C131 | Short-lived/federated credentials | VMW, MS, NUT, OS, RHV, ACS, HAR | PVE, XCP, XEN |
| C132 | Audit log pentru acțiuni utilizator | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C133 | Login/session audit | VMW, MS, NUT, PVE, OS, RHV, ACS, XEN, HAR | XCP |
| C134 | Export audit spre SIEM/syslog | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C135 | Approval / separation of duties | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |

### T10. Multi-tenancy, quotas și service offerings (C136–C150)

Surse: [CloudStack projects](https://docs.cloudstack.apache.org/en/latest/adminguide/projects.html), [CloudStack usage](https://docs.cloudstack.apache.org/en/latest/adminguide/usage.html), [OpenStack Nova/Keystone/Placement](https://docs.openstack.org/nova/2026.1/), [Nutanix self-service](https://www.nutanix.com/products/cloud-manager/self-service), [OpenShift namespaces](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/virtualization/about), [VCF self-service](https://blogs.vmware.com/cloud-foundation/2026/05/05/accelerate-streamline-and-control-your-self-service-private-cloud-with-vcf-9-1/).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C136 | Tenant/project/account isolation | VMW, MS, NUT, OS, RHV, XCP, ACS, HAR | PVE, XEN |
| C137 | Nested domain/organization hierarchy | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C138 | Quota CPU | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C139 | Quota memory | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C140 | Quota storage | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C141 | Quota network/public IP | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C142 | Quota snapshots/backups | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C143 | Resource pools/reservations/limits | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C144 | Service/flavor offerings | VMW, MS, NUT, OS, RHV, ACS, HAR | PVE, XCP, XEN |
| C145 | Disk/storage offerings | VMW, MS, NUT, OS, RHV, ACS, HAR | PVE, XCP, XEN |
| C146 | Network offerings | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C147 | Per-tenant image/template visibility | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C148 | Resource ownership transfer | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C149 | Lease/TTL pentru resurse | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C150 | Showback/chargeback per tenant/project | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |

### T11. API, automatizare, IaC și extensibilitate (C151–C165)

Surse: [Proxmox REST API](https://www.proxmox.com/en/products/proxmox-virtual-environment/features), [OpenStack APIs](https://docs.openstack.org/2026.1/api/), [Azure Local ARM/Bicep/Terraform](https://learn.microsoft.com/en-us/azure/azure-local/manage/azure-arc-vm-management-overview), [XO REST API](https://docs.xen-orchestra.com/restapi/), [XenServer XAPI wire protocol](https://docs.xenserver.com/en-us/xenserver/developer/xenserver-9/management-api/wire-protocol.html), [CloudStack extension/API](https://cloudstack.apache.org/features/), [Harvester API](https://docs.harvesterhci.io/v1.7/category/api/).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C151 | REST API | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C152 | RPC/SOAP/native management API | VMW, MS, NUT, XCP, XEN | PVE, OS, RHV, ACS, HAR |
| C153 | CLI administrativ | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C154 | SDK oficial | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | language coverage varies |
| C155 | API schema/OpenAPI/JSON Schema | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C156 | Async task/job API | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C157 | Event stream / notifications API | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C158 | Webhooks | VMW, MS, NUT, OS, RHV, XCP, ACS, HAR | PVE, XEN |
| C159 | Terraform provider | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C160 | Declarative templates/blueprints | VMW, MS, NUT, OS, RHV, ACS, HAR | PVE, XCP, XEN |
| C161 | GitOps reconciliation | VMW, MS, NUT, RHV, HAR | PVE, OS, XCP, ACS, XEN |
| C162 | Workflow/runbook automation | VMW, MS, NUT, OS, RHV, XCP, ACS | PVE, XEN, HAR |
| C163 | Plugin/adapter framework | VMW, MS, NUT, PVE, OS, RHV, ACS, HAR | XCP, XEN |
| C164 | Idempotent desired-state operations | VMW, MS, NUT, OS, RHV, HAR | PVE, XCP, ACS, XEN |
| C165 | API version/capability negotiation | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |

### T12. Observabilitate, alerting și AIOps (C166–C180)

Surse: [VCF Operations](https://blogs.vmware.com/cloud-foundation/2026/02/06/why-vcf-9-0-improves-it-operations-and-management/), [Nutanix Cloud Manager](https://www.nutanix.com/products/cloud-platform), [OpenStack telemetry services](https://docs.openstack.org/2025.2/install/), [Proxmox monitoring/tasks](https://www.proxmox.com/en/products/proxmox-virtual-environment/features), [CloudStack monitoring](https://cloudstack.apache.org/features/), [OpenShift metrics](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html-single/virtualization/), [XO backup logs/syslog](https://docs.xen-orchestra.com/backups).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C166 | Host CPU/memory metrics | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C167 | VM CPU/memory metrics | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C168 | Disk IOPS/latency/throughput | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | backend depth varies |
| C169 | Network throughput/drop metrics | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C170 | Historical time-series charts | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | retention varies |
| C171 | Configurable alerts/thresholds | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C172 | Capacity exhaustion forecast | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |
| C173 | Anomaly detection | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |
| C174 | Root-cause/topology correlation | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |
| C175 | Active findings/recommendations | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |
| C176 | Central log aggregation/search | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | component may be separate |
| C177 | Prometheus metrics/export | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | adapters vary |
| C178 | Grafana/dashboard integration | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | adapters vary |
| C179 | External alert channels/webhooks | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C180 | SLA/availability reporting | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |

### T13. Lifecycle, patching și platform operations (C181–C195)

Surse: [VCF lifecycle/certificates](https://blogs.vmware.com/cloud-foundation/2026/02/06/why-vcf-9-0-improves-it-operations-and-management/), [XCP-ng updates](https://docs.xcp-ng.org/management/updates/), [Harvester upgrades](https://docs.harvesterhci.io/v1.7/upgrade/index/), [Proxmox Admin Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf), [Azure Local documentation](https://learn.microsoft.com/en-us/azure/azure-local/), [XenServer rolling upgrades](https://docs.xenserver.com/en-us/xenserver/9/install/upgrade).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C181 | Version/edition discovery | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C182 | Compatibility/preflight checks | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | depth varies |
| C183 | Central update catalog/depot | VMW, MS, NUT, PVE, RHV, XCP, XEN, HAR | OS, ACS |
| C184 | Host patch orchestration | VMW, MS, NUT, PVE, OS, RHV, XCP, XEN, HAR | ACS |
| C185 | Cluster rolling update | VMW, MS, NUT, PVE, OS, RHV, XCP, XEN, HAR | ACS |
| C186 | Live patching | VMW, MS, RHV, ACS | NUT, PVE, OS, XCP, XEN, HAR |
| C187 | Firmware/driver lifecycle | VMW, MS, NUT, PVE, RHV, XCP, XEN, HAR | OS, ACS |
| C188 | Certificate inventory/renewal | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | automation varies |
| C189 | License/subscription inventory | VMW, MS, NUT, PVE, RHV, XCP, XEN | OS, ACS, HAR |
| C190 | Configuration drift detection | VMW, MS, NUT, OS, RHV, HAR | PVE, XCP, ACS, XEN |
| C191 | Desired-state host profiles | VMW, MS, NUT, OS, RHV, HAR | PVE, XCP, ACS, XEN |
| C192 | Backup/restore management-plane config | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C193 | Support bundle collection | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |
| C194 | Cluster health pre-upgrade gate | VMW, MS, NUT, PVE, OS, RHV, XCP, XEN, HAR | ACS |
| C195 | Air-gapped/offline upgrade workflow | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | — |

### T14. Kubernetes, containere și cloud hibrid (C196–C210)

Surse: [OpenShift VM+containers](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/virtualization/about), [Harvester Rancher integration](https://docs.harvesterhci.io/v1.7/), [Azure Local](https://learn.microsoft.com/en-us/azure/azure-local/), [Nutanix platform](https://www.nutanix.com/products), [VCF private cloud](https://blogs.vmware.com/cloud-foundation/2025/06/17/vcf-9-0-use-cases/), [CloudStack Kubernetes Service](https://docs.cloudstack.apache.org/en/latest/plugins/cloudstack-kubernetes-service.html), [OpenStack Magnum/Zun](https://docs.openstack.org/2025.2/install/).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C196 | VM și containere în același inventory | VMW, MS, NUT, PVE, RHV, HAR | OS, XCP, ACS, XEN |
| C197 | Kubernetes cluster provisioning | VMW, MS, NUT, OS, RHV, ACS, HAR | PVE, XCP, XEN |
| C198 | Kubernetes lifecycle management | VMW, MS, NUT, OS, RHV, ACS, HAR | PVE, XCP, XEN |
| C199 | VM declarată ca Kubernetes CRD | RHV, HAR | VMW, MS, NUT, PVE, OS, XCP, ACS, XEN |
| C200 | Namespace/project self-service | VMW, MS, NUT, OS, RHV, ACS, HAR | PVE, XCP, XEN |
| C201 | Kubernetes-native VM GitOps | RHV, HAR | VMW, MS, NUT, PVE, OS, XCP, ACS, XEN |
| C202 | CSI-based VM storage | VMW, MS, NUT, RHV, HAR | PVE, OS, XCP, ACS, XEN |
| C203 | CNI/Multus multi-network VM | RHV, HAR | VMW, MS, NUT, PVE, OS, XCP, ACS, XEN |
| C204 | On-prem to public-cloud workload mobility | VMW, MS, NUT | OS, RHV, XCP, ACS, XEN, HAR |
| C205 | Unified public/private cloud inventory | VMW, MS, NUT | OS, RHV, XCP, ACS, XEN, HAR |
| C206 | Cloud public policy/governance extension | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |
| C207 | Managed identity pentru VM on-prem | MS | VMW, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR |
| C208 | Edge/ROBO cluster management | VMW, MS, NUT, PVE, RHV, ACS, HAR | OS, XCP, XEN |
| C209 | Disconnected/sovereign operations | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, XEN, HAR | feature depth varies |
| C210 | Hybrid application blueprints | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |

### T15. FinOps, UX, service delivery și sustenabilitate (C211–C225)

Surse: [Nutanix Cost Governance](https://www.nutanix.com/library/datasheets/nutanix-cloud-manager-cost-governance), [Nutanix self-service](https://www.nutanix.com/products/cloud-manager/self-service), [CloudStack usage](https://docs.cloudstack.apache.org/en/latest/adminguide/usage.html), [VCF Automation/self-service](https://blogs.vmware.com/cloud-foundation/2026/05/05/accelerate-streamline-and-control-your-self-service-private-cloud-with-vcf-9-1/), [Proxmox UI/mobile](https://www.proxmox.com/en/products/proxmox-virtual-environment/features), [OpenStack Horizon](https://docs.openstack.org/horizon/2026.1/).

| ID | Capabilitate neutră | Nativ/confirmat | Adiacent/condiționat |
|---|---|---|---|
| C211 | Self-service service catalog | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C212 | Blueprint marketplace | VMW, MS, NUT, OS, RHV, ACS | PVE, XCP, XEN, HAR |
| C213 | Custom request forms | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |
| C214 | Approval workflow pentru requests | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |
| C215 | Usage metering | VMW, MS, NUT, PVE, OS, RHV, ACS | XCP, XEN, HAR |
| C216 | Cost model pentru private cloud | VMW, MS, NUT, OS, ACS | PVE, RHV, XCP, XEN, HAR |
| C217 | Showback/chargeback reports | VMW, MS, NUT, OS, ACS | PVE, RHV, XCP, XEN, HAR |
| C218 | Budget și overspend alerts | VMW, MS, NUT, OS | PVE, RHV, XCP, ACS, XEN, HAR |
| C219 | Idle/underutilized resource detection | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |
| C220 | Rightsizing recommendations | VMW, MS, NUT, OS, RHV | PVE, XCP, ACS, XEN, HAR |
| C221 | Capacity/TCO scenario modeling | VMW, MS, NUT, OS | PVE, RHV, XCP, ACS, XEN, HAR |
| C222 | Power/energy telemetry | VMW, MS, NUT, PVE, OS | RHV, XCP, ACS, XEN, HAR |
| C223 | Carbon/sustainability reporting | VMW, MS, NUT | PVE, OS, RHV, XCP, ACS, XEN, HAR |
| C224 | Mobile/responsive administration | VMW, MS, NUT, PVE, OS, RHV, XCP, ACS, HAR | XEN |
| C225 | White-label/brandable tenant portal | VMW, MS, NUT, OS, ACS | PVE, RHV, XCP, XEN, HAR |

### 5.1 Ce arată taxonomia

- **Paritatea de bază** (inventory + power + snapshot) este doar intrarea în piață; diferențierea reală începe la migration/HA, backup verificat, policy, self-service și cost.
- **VMware, Microsoft și Nutanix** au cea mai lată integrare suite-level, dar această lățime vine cu componente/licențe multiple.
- **Proxmox și XCP-ng/XO** sunt cele mai accesibile surse de quick wins concrete pentru un control plane independent.
- **OpenStack și CloudStack** oferă modelele cele mai mature pentru multi-tenancy, quotas, offerings și usage.
- **OpenShift Virtualization și Harvester** arată direcția convergenței VM–container: resursa VM devine declarativă, policy-able și GitOps-ready.
- O implementare profesională trebuie să negocieze **capabilități per endpoint, versiune, edition și backend**, nu să aibă un boolean static per vendor.

## 6. Gap analysis față de Docker Dash

Analiza repo-ului a urmărit [README.md](../../README.md), serviciile/rutele providerilor, [integrarea Xen](../features/xen-integration.md), [research-ul de produs anterior](../planning/feature-research-2026-07.md) și UI-urile provider. Constatările de mai jos sunt observații din cod, nu afirmații despre vendor.

| Domeniu | Acoperire Docker Dash observată | Gap principal | Implicație |
|---|---|---|---|
| Docker/Compose lifecycle | Puternic: containere, imagini, volume, rețele, stacks, Git deploy, rollout, preview și OCI Compose | Nu este încă un model comun VM+container | Păstrarea nucleului container și adăugarea unui resource model neutru |
| Provider registry | Există `daemon_type` și dispatch pentru Docker/Podman/Incus/LXD/Proxmox/Kubernetes/Nomad/vSphere/Xen | Contractele provider nu sunt uniforme la nivel de resources/actions/tasks/events | Introducerea Provider SDK v2 și capability schema versionată |
| Proxmox | Inventar nodes/VM/LXC/storage/backups; firewall; read-focused | Fără power, snapshot mutation, backup trigger, create/clone/migrate/HA/console | Cel mai rapid provider pentru paritate VM de bază |
| vSphere | Inventar bogat, datastore browser/upload/download, servicii host, SSH telemetry/history | Codul declară explicit lipsa power/snapshot/console; fără clusters/DRS/HA/migrate/provisioning | Provider vCenter complet, nu doar ESXi read-only |
| Xen | XO/XAPI/raw, inventory pool/host/VM/SR/network/task, power și snapshot cu capability gates | Fără provisioning, console, backup, migrate, HA, storage/network mutation, host operations | Extindere pe XO/XAPI; raw rămâne subset sigur |
| Hyper-V/Azure Local | Niciun provider dedicat | Lipsește întreg ecosistemul Windows/Arc | Provider în două planuri: WinRM/PowerShell + Azure ARM/Arc |
| Nutanix | Niciun provider | Lipsește AHV/Prism inventory și lifecycle | Integrare Prism Central API cu tasks și categories |
| OpenStack | Niciun provider | Lipsește Keystone catalog și Nova/Cinder/Neutron/Glance | Provider modular, project-scoped, microversion aware |
| OpenShift Virtualization | Există Kubernetes resources, nu model KubeVirt dedicat | Lipsesc VM CRDs, DataVolumes, migrations și consoles | Extensie a providerului Kubernetes, nu provider paralel duplicat |
| CloudStack | Niciun provider | Lipsesc zones/offerings/projects/usage și async jobs | Bun candidat după common IaaS abstractions |
| Harvester | Poate fi parțial vizibil ca Kubernetes, fără semantics Harvester | Lipsesc Longhorn VM backup, networks, images, migrations | Adaptor peste Kubernetes APIs + Harvester CRDs |
| VM detail | Xen are tabel/listă și snapshot modal; vSphere are detail/telemetry; implementări divergente | Nu există shell comun cu hardware, disks, NICs, metrics, tasks, events | `VirtualMachineDetail` normalizat cu extensii vendor |
| Console | Container exec și SSH există; providerii VM nu oferă console proxy | Lipsesc noVNC/SPICE/WebMKS/serial/RDP/VMConnect gates | Gateway de console separat, token scurt și audit |
| Provisioning | Compose/blueprints mature; VM provisioning absent | Fără create-from-template, cloud-init, image library | Wizard cu plan/validate/apply și adapter vendor |
| Migration/maintenance | Rollout pentru stacks; niciun orchestrator VM migration | Fără compatibility preflight, live migrate, evacuation, rollback | Job engine durabil și runbook de mentenanță |
| HA/placement | Doar vizibilitate minimă în Xen pool | Fără policies, restart order, affinity, admission sau DRS recommendations | Inițial read/recommend; mutation ulterior cu safeguards |
| Backup/DR workload | Backup al configurației Docker Dash și pCloud; inventar backup Proxmox | Nu orchestrează backup-uri VM, retention, replica, restore drill | Backup policy engine separat de snapshot |
| Storage VM | Inventar basic; datastore file operations vSphere | Fără disk lifecycle, QoS, storage policy, multipath/health | Common volume model și backend-specific operations |
| Network VM | Inventory/rețele; firewall pentru unele platforme | Fără NIC lifecycle, VLAN/VPC, IPAM, SG/microsegmentation | Network intent + dry-run/lockout safety |
| IAM/RBAC | Auth, LDAP, 3 roluri, host access și audit | Nu are tenancy/projects/quotas/delegated admin/approval | Extindere graduală de scopes și permissions |
| Audit/security posture | Foarte bun pentru produs: audit hash-chain, secret encryption, posture checks, remediation | Provider posture este încă superficial, fără benchmark/version advisory per fabric | Policy packs per vendor și evidence collection |
| Observabilitate | Prometheus/Grafana, alerts, history, topology și insights pentru containere | VM metrics/events nu sunt normalizate și corelate | Common metrics schema, event ingestion și cardinality control |
| FinOps/capacity | Cost optimizer pentru containere | Fără VM showback, energy, reservations sau forecast | Unified allocation/cost model cu confidence levels |
| GitOps/IaC | Declarative fleet sync, plans, apply hash, managed writeback | Resursele VM/storage/network nu sunt declarative | Provider-neutral manifests cu ownership și drift |
| Extensibilitate | Sample plugin, API playground, multe servicii interne | Fără SDK provider/plugin stabil și signed capability manifest | Boundary versionat, test kit și sandbox |

### 6.1 Avantaje existente de păstrat

Docker Dash are deja elemente pe care multe UI-uri hypervisor le tratează separat: deployment planning, progressive rollout, procedure stages, preview environments, OCI artifacts, disk-pressure automation, emergency terminal lock, encrypted credentials, hash-chained audit, posture, multi-channel notifications, GitOps plan/apply și un model simplu de instalare. Acestea trebuie refolosite ca infrastructură transversală pentru VM-uri, nu reimplementate per provider.

### 6.2 Cele mai importante lacune

1. contract comun pentru `VirtualMachine`, `Host`, `Cluster`, `Datastore`, `Network`, `Task`, `Capability` și `Event`;
2. task engine durabil, reluabil și observabil pentru operații care durează minute/ore;
3. provisioning/clone/template/cloud-init;
4. console gateway sigur;
5. migration/maintenance/HA orchestration;
6. workload backup/DR cu restore verification;
7. tenancy/quotas/self-service;
8. provider-specific security/compliance și lifecycle;
9. metrics/events normalized; capacity și FinOps;
10. extensibilitate și contract de test pentru provider plugins.

## 7. Catalog agregat și deduplicat — 450 feature-uri candidate

**Coloane:** `Val.` = valoare dominantă (`Ops`, `Sig` securitate, `Rez` reziliență, `DX`, `Cost`, `Gov`); `Ef.` = efort relativ (`S`, `M`, `L`, `XL`); `Oriz.` păstrează `Now` (0–6 luni), `Next` (6–15 luni), `Later` (15+ luni) pentru itemii deschiși, iar `Partial` și `Done` reprezintă starea de livrare reconciliată. Prioritatea este orientativă și presupune validare cu utilizatori și endpoint-uri reale. Proiecția machine-readable și limitările nivelului de livrare sunt în [`virtualization-feature-registry.json`](virtualization-feature-registry.json).

### A. Provider platform și inventar (B001–B025)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B001 | Provider SDK v2 | Interfață versionată pentru inventory/actions/tasks/events. | DX | L | Done |
| B002 | Capability schema versionată | Contract typed cu suport, condiții și motive de indisponibilitate. | Ops | M | Done |
| B003 | Capability discovery live | Detectare per endpoint/edition/version/backend, cu cache invalidabil. | Ops | M | Done |
| B004 | Resource ID canonic | UUID stabil plus native reference intern și mapping istoric. | Ops | M | Done |
| B005 | Common VM model | Normalizare state, hardware, guest, placement și ownership. | Ops | L | Done |
| B006 | Common host model | Health, maintenance, capacity, hardware și version. | Ops | M | Done |
| B007 | Common cluster/pool model | HA state, quorum, capacity și coordinator. | Ops | M | Done |
| B008 | Common datastore model | Capacity, backend, shared state, health și capabilities. | Ops | M | Done |
| B009 | Common network model | Switch/network/VPC, CIDR, VLAN și provider metadata. | Ops | M | Done |
| B010 | Common task model | State machine, progress, owner, cancelability și native link. | Ops | L | Done |
| B011 | Common event model | Event envelope deduplicat cu cursor și severity. | Ops | L | Done |
| B012 | Incremental inventory sync | Delta/cursor sync în loc de full polling. | Ops | L | Done |
| B013 | Inventory cache cu freshness | TTL, ETag/version, stale badge și refresh reason. | Ops | M | Done |
| B014 | Cross-provider global search | Căutare VM/host/storage/network/tag în toată flota. | Ops | M | Done |
| B015 | Saved inventory views | Filtre/coloane/sortare salvate per utilizator. | DX | S | Partial |
| B016 | Resource collections | Grupuri dinamice după tag, regex, provider, site sau state. | Ops | M | Done |
| B017 | Custom metadata fields | Schema administrată pentru CMDB/business context. | Gov | M | Done |
| B018 | Ownership și contacts | Owner, service, cost center, pager și runbook URL. | Gov | S | Done |
| B019 | Resource relationship graph | VM–host–cluster–disk–network–backup dependency graph. | Ops | L | Done |
| B020 | Duplicate/orphan detector | Resurse fără owner, disk-uri detașate, imagini nefolosite. | Cost | M | Done |
| B021 | Provider health contract | Auth, reachability, latency, clock skew și API degradation. | Rez | M | Done |
| B022 | Provider circuit breaker | Backoff, half-open probes și limitarea cascadei de erori. | Rez | M | Done |
| B023 | Rate-limit budget manager | Adaptive concurrency pe endpoint/API. | Rez | M | Done |
| B024 | Provider compatibility registry | Matrice testată de versiuni/ediții/drivere. | Gov | M | Done |
| B025 | Provider conformance kit | Fixtures, contract tests și fake endpoints pentru pluginuri. | DX | L | Done |

**Status implementare locală 2026-07-30:** B015 are migrare, service, API și UI
pentru view-uri personale pe inventarul VM, inclusiv host, filtre, coloane,
sortare și default per utilizator. Testele route/migration/ownership/frontend și
regresiile provider sunt verzi; rămâne browser smoke și includerea într-un
release înainte ca rândul să fie promovat la `Done`.

### B. VM lifecycle și provisioning (B026–B050)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B026 | Unified VM detail shell | Overview/hardware/disks/NICs/snapshots/tasks/events într-un UI comun. | Ops | M | Done |
| B027 | Safe power actions | Start/shutdown/reboot/pause/suspend cu capability și policy gates. | Ops | M | Done |
| B028 | Bulk VM power actions | Selecție multiplă, concurrency cap și rezultat per VM. | Ops | M | Done |
| B029 | VM action preflight | Verifică state, tools, locks, HA și task-uri conflictuale. | Rez | M | Done |
| B030 | Typed destructive confirmation | Confirmare cu numele VM și blast-radius preview. | Sig | S | Done |
| B031 | VM create wizard | Plan de compute/storage/network/image înainte de apply. | DX | L | Done |
| B032 | Create from template | Provisionare vendor-neutrală din golden image. | DX | L | Done |
| B033 | Full VM clone | Clone cu alegere target cluster/storage/network. | DX | L | Done |
| B034 | Linked/thin clone | Clone rapid când backend-ul îl permite. | Cost | M | Done |
| B035 | Cloud-init editor | User-data/meta-data/network-config cu schema și preview. | DX | M | Done |
| B036 | Guest customization profiles | Sysprep/Linux settings reutilizabile și secret references. | DX | L | Done |
| B037 | VM hardware profile | Preset versionat pentru CPU/RAM/firmware/devices. | DX | M | Done |
| B038 | Flavor/service offering mapper | Mapează profil comun la flavor/offering/vendor shape. | Gov | M | Done |
| B039 | Image library aggregator | ISO/template/image inventory multi-provider cu provenance. | Ops | L | Done |
| B040 | Image upload/import pipeline | Upload resumable, checksum și format conversion. | DX | L | Done |
| B041 | Image replication | Distribuie imagini către site-uri/cluster-e cu progress. | Ops | L | Done |
| B042 | Template versioning | Semver, deprecation, owners și compatibility notes. | Gov | M | Done |
| B043 | Template promotion flow | Dev→test→prod cu approvals și immutable digest. | Gov | L | Done |
| B044 | VM lease/TTL | Stop/delete automat cu owner notification și extensions. | Cost | M | Done |
| B045 | Scheduled VM actions | Cron start/stop/reboot/snapshot cu blackout windows. | Ops | M | Partial |
| B046 | Guest tools status | Version, health, feature impact și upgrade recommendation. | Ops | M | Done |
| B047 | Guest graceful command | Shutdown/reboot/script doar prin agentul oficial suportat. | Ops | L | Done |
| B048 | VM console token broker | Token scurt, single-use și scope per VM. | Sig | L | Done |
| B049 | Multi-protocol console gateway | noVNC/SPICE/WebMKS/serial adapters cu audit. | DX | XL | Done |
| B050 | Console emergency lock | Global/provider/VM deny și închiderea sesiunilor active. | Sig | M | Done |

### C. Migrare, placement, maintenance și HA (B051–B075)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B051 | Migration capability matrix | Explică live/cold/storage/cross-pool per VM și target. | Ops | M | Done |
| B052 | Migration compatibility preflight | CPU, devices, storage, network, HA și version checks. | Rez | L | Done |
| B053 | Live migration action | Selectare/auto-target, progress și post-validation. | Ops | L | Done |
| B054 | Cold migration action | Migrare orchestrată cu downtime estimate. | Ops | L | Done |
| B055 | Storage live migration | Relocare disk fără oprire când providerul permite. | Ops | L | Done |
| B056 | Cross-pool/cluster migration | Mapare storage/network și credential boundary. | Ops | XL | Done |
| B057 | Cross-provider migration workflow | Export/convert/import plus cutover plan. | DX | XL | Done |
| B058 | Migration bandwidth control | Throttle, compression și maintenance traffic network. | Ops | M | Done |
| B059 | Migration queue | Prioritate, concurrency și fair scheduling per fabric. | Ops | L | Done |
| B060 | Migration abort/force-complete | Acțiuni native gated după state și provider support. | Rez | M | Done |
| B061 | Migration rollback plan | Pași compensați și recovery instructions per failure stage. | Rez | L | Done |
| B062 | Maintenance mode runbook | Disable/drain/patch/reboot/rejoin/validate. | Ops | L | Done |
| B063 | Host evacuation planner | Destination plan, capacity și VM exceptions înainte de drain. | Rez | L | Done |
| B064 | Batch evacuation | Wave-based migrations cu health gates și pause. | Rez | L | Done |
| B065 | Non-migratable workload policy | Stop, defer sau require approval pentru passthrough/local disk. | Gov | M | Done |
| B066 | HA status dashboard | Quorum, heartbeat, fencing și protected VM coverage. | Rez | M | Done |
| B067 | HA readiness checker | Shared storage/network/capacity/guest agility validation. | Rez | M | Done |
| B068 | HA policy editor | Restart priority, order și failure tolerance. | Rez | L | Done |
| B069 | Affinity rule inventory | Vizualizează VM-host și VM-VM rules. | Ops | M | Done |
| B070 | Affinity rule editor | Create/update/delete cu conflict analysis. | Ops | L | Done |
| B071 | Placement recommendation | Scor CPU/RAM/NUMA/storage/network/policy cu explicații. | Cost | L | Done |
| B072 | Automated rebalance plan | Dry-run cu migrations propuse și impact estimat. | Cost | L | Done |
| B073 | Controlled rebalance apply | Waves, maintenance window și auto-pause. | Rez | XL | Done |
| B074 | HA failure simulation | What-if pentru pierderea unuia sau mai multor hosturi. | Rez | L | Done |
| B075 | Recovery start-order visualizer | Dependency DAG și timpi estimați după incident. | Rez | M | Done |

### D. Storage și volume (B076–B100)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B076 | Unified VM disk inventory | Disks, bus, size, provisioning, backing și attachment. | Ops | M | Done |
| B077 | Disk create/attach wizard | Plan storage policy, format, QoS și target VM. | DX | L | Done |
| B078 | Safe disk detach | Guest/boot/shared checks și explicit keep/delete. | Sig | M | Done |
| B079 | Disk delete guard | Backup/snapshot/attachment/replica dependency check. | Sig | M | Done |
| B080 | Online disk expansion | Capability-gated resize plus guest follow-up guidance. | Ops | M | Done |
| B081 | Disk move between datastores | Relocation cu progress și space reservation. | Ops | L | Done |
| B082 | Disk format conversion | VMDK/VHDX/QCOW2/RAW/VHD workflow verificabil. | DX | XL | Done |
| B083 | Storage policy inventory | Classes/policies/offers și compliance state. | Gov | M | Done |
| B084 | Storage policy assignment | Reconfigurare cu compatibility și migration plan. | Gov | L | Done |
| B085 | Datastore capacity dashboard | Used/free/provisioned/overcommit/growth forecast. | Cost | M | Done |
| B086 | Thin overcommit monitor | Alertă pe logical vs physical și growth velocity. | Rez | M | Done |
| B087 | Storage latency heatmap | VM/datastore/path latency correlation. | Ops | L | Done |
| B088 | Storage path/multipath health | Detectează degraded paths și policy mismatch. | Rez | L | Done |
| B089 | Orphan disk cleanup | Dry-run cu age, owner și restore window. | Cost | M | Done |
| B090 | Stale snapshot growth monitor | Chain depth, age, consolidation/coalesce risk. | Rez | M | Partial |
| B091 | Snapshot consolidation action | Preflight și native progress când suportat. | Ops | M | Done |
| B092 | Storage QoS editor | IOPS/throughput limits per disk/volume. | Gov | L | Done |
| B093 | Storage tiering recommendation | Plasare după latency, cost, resilience și workload. | Cost | L | Done |
| B094 | Shared disk topology | Multi-attach consumers și cluster dependency view. | Ops | M | Done |
| B095 | Object storage registry | S3-compatible endpoints și policy/capacity health. | Ops | M | Done |
| B096 | NFS/SMB repository health | Mount reachability, auth, latency și write test safe. | Rez | M | Partial |
| B097 | Ceph health adapter | MON/OSD/PG/pool/replication summary pentru PVE/OpenStack. | Rez | L | Done |
| B098 | Longhorn health adapter | Volume replicas, rebuild, degraded și backup target. | Rez | L | Done |
| B099 | vSAN/S2D/AOS health adapters | Suite-specific capacity/resync/fault-domain summary. | Rez | XL | Done |
| B100 | Storage change plan | Diff, blast radius, rollbackability și required downtime. | Gov | L | Done |

**Status implementare 2026-07-30:** B082–B084, B087–B089, B091–B095 și
B097–B100 au fost închise în V4.2f / v8.78.0. Conversia, assignment-ul,
cleanup-ul, QoS, tiering-ul și schimbările produc contracte hash-bound și nu
expun apply implicit; health adapters consumă numai dovezi normalizate bounded.
B091 reutilizează task-ul nativ vSphere deja livrat, iar B094 reutilizează
topologia shared-disk cu identități opace. B090 are implementarea locală
read-only în V4.2g (migration, provider evidence, policy/API, job leader-only,
UI și teste); browser smoke și includerea într-un release sunt încă restante.
B096 are în V4.2h registry-ul local, secret references, probe DNS/TCP reale,
istoric, freshness, alerte și contractul opt-in de write/cleanup. Auth/list și
write-test rămân explicit necunoscute fără un adaptor data-plane aprobat;
browser smoke și includerea într-un release sunt încă restante.

### E. Networking și connectivity (B101–B125)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B101 | Unified VM NIC inventory | MAC, network, model, IP, link și security state. | Ops | M | Done |
| B102 | NIC add/attach wizard | Network/VLAN/IP/model selection cu validation. | DX | L | Done |
| B103 | Safe NIC detach | Management/last-interface/guest dependency checks. | Sig | M | Done |
| B104 | NIC connect/disconnect | Link state mutation și audit. | Ops | M | Partial |
| B105 | Network mapping profiles | Source→target mapping reutilizabil pentru clone/migration. | Ops | M | Done |
| B106 | VLAN network creation | Provider-neutral intent cu dry-run. | Ops | L | Done |
| B107 | Trunk and QinQ configuration | Capability-gated nested segmentation. | Ops | L | Done |
| B108 | VXLAN/overlay creation | VNI, transport și MTU validation. | Ops | XL | Done |
| B109 | VPC/subnet lifecycle | Tenant network create/update/delete. | DX | XL | Done |
| B110 | IPAM integration | Allocate/release/reserve cu Infoblox/NetBox/native backends. | Ops | L | Done |
| B111 | DHCP reservation workflow | MAC/IP/hostname ownership și conflict checks. | Ops | M | Done |
| B112 | DNS record automation | A/AAAA/PTR lifecycle legat de VM. | DX | M | Done |
| B113 | Security group inventory | Rules, attachments, effective policy și drift. | Sig | M | Done |
| B114 | Security group editor | Plan/diff/lockout guard și atomic apply. | Sig | L | Done |
| B115 | Distributed firewall adapter | NSX/Flow/PVE/Neutron/OVN policy abstraction. | Sig | XL | Done |
| B116 | Microsegmentation policy model | App/tag/identity aware rules și staged enforcement. | Sig | XL | Done |
| B117 | Flow log ingestion | Normalize allow/deny/bytes/5-tuple cu retention. | Sig | L | Done |
| B118 | VM dependency map | Construiește relații din flows, DNS și metadata. | Ops | L | Partial |
| B119 | Network reachability test | Source/destination/port simulation sau probe controlat. | Ops | L | Partial |
| B120 | MTU mismatch detector | Path/overlay/storage/live-migration MTU checks. | Rez | M | Partial |
| B121 | Bond/LAG health | Members, mode, link, imbalance și failover state. | Rez | M | Partial |
| B122 | SR-IOV inventory | PF/VF capacity, allocations și migration constraints. | Ops | M | Done |
| B123 | Load balancer inventory | VIP, pools, members, health și provider links. | Ops | L | Partial |
| B124 | NAT/public IP lifecycle | Allocate, map, release și cost/ownership. | DX | L | Partial |
| B125 | Network intent validation | CIDR overlap, gateway, DNS, VLAN/VNI și route conflicts. | Sig | L | Partial |

**Status implementare 2026-07-30:** B102–B103 și B105–B117 au fost închise
în V4.3f / V4.4d / v8.79.0. NIC, segment, VPC/subnet, address, security-group
și microsegmentation changes sunt planuri hash-bound fără apply implicit.
Firewall-ul guarded existent și connector marketplace IPAM/DNS sunt referite,
nu duplicate; distributed firewall și flow logs acceptă doar dovezi normalizate
bounded, fără trafic sau raw payload.

B125 are implementarea locală V4.5i: parser/canonicalizare IPv4/IPv6,
overlap-uri cross-resource, gateway/DNS/route și coliziuni VLAN/VNI, verdict
`pass/fail/unknown`, hash-uri imutabile, API/UI și teste. Browser smoke,
release-ul și legarea primului executor de validation hash rămân restante.

B118 are implementarea locală V4.4e read-only: observații normalizate IP/DNS,
corelare cu flow batches, metadata și relationship graphs, snapshots imutabile,
freshness/confidence/evidence per edge și impact bounded exclusiv pe relațiile
declarate. Flow-only candidates rămân explicit non-cauzale. Browser smoke,
adaptoarele de evidence provider-native și includerea într-un release rămân
restante.

B119 are implementarea locală V4.4f simulation-only: evaluează tuple explicite
source/destination/TCP/UDP/ICMP din route, policy, attachment și provider
simulation evidence cu freshness individual, corelează DNS și flow logs
normalizate și persistă `pass/fail/unknown` imutabil. `pass` este etichetat ca
predicție control-plane, nu dovadă data-plane; flow-ul istoric nu promovează
evidence incompletă. Nu există probe, DNS lookup, socket sau provider mutation.
Browser smoke, adaptoarele provider-native, release-ul și orice runner activ
allowlisted cu source ownership/destination policy rămân restante.

B120 are implementarea locală V4.4g pasivă: evaluează paths workload, overlay,
storage și live-migration, calculează overhead-ul cumulativ per segment, păstrează
DF ca evidence explicit și produce `pass/fail/unknown` cu bottleneck și deficit.
Nu pornește trafic sau remediere. Colectarea automată provider-native, browser
smoke și includerea într-un release rămân restante.

B121 are implementarea locală V4.4h pasivă: normalizează bond/team/LAG members,
rol activ/standby/LACP, link/admin/speed/duplex, partner keys, delte de trafic,
errors/drops/flaps și failover evidence. Quorum-ul, partner mismatch și imbalance
sunt evaluate fail-closed; zero trafic rămâne `not_observed`. Colectoarele
provider-native, browser smoke și includerea într-un release rămân restante.

B123 are implementarea locală V4.4i read-only: inventar normalizat pentru VIP,
listeners, pools, members, algoritm, admin/provider health și legături canonice
network/resource. Dangling pool refs și native/sensitive refs sunt respinse; nu
pornește health probes. Colectoarele NSX/Octavia/cloud, browser smoke și release-ul
rămân restante.

B124 are implementarea locală V4.4j plan-only: allocate/map/unmap/release leagă
ownership token, tenant/owner, quota, cost în micros, conflict/current state,
expected version, mappings/dependencies, capability și checks. Release-ul extern
sau dependent este blocat și nu există apply endpoint. Browser smoke, adaptoarele
provider-native, canary și execuția controlată din R8 rămân restante.

B104 are implementarea locală V4.4k: inventar live, declarație admin
expirabilă și legată de fingerprint, preflight cu last/management/boot/guest
guards, operație durabilă connect/disconnect, post-read și rollback manual.
Proxmox schimbă doar `link_down`, vSphere doar starea `connected`, iar XenAPI
folosește `VIF.plug/unplug`; attach/detach/delete/remap nu sunt expuse. Cele
trei flag-uri provider sunt default-off. Browser smoke, canary pe provideri
disposable și includerea într-un release rămân restante; Xen Orchestra/raw Xen
nu declară mutația ca suportată.

**Status reconciliat 2026-07-30:** B101 și B122 reutilizează inventory-ul comun
NIC, respectiv evidence-ul PF/VF și constrângerile de migrare livrate în v8.71.0.
Nu mai există un feature `Open` în catalog; B119 rămâne `Partial` până la
adaptoarele provider-native, decizia de active runner și validările de release.
Niciun plan din B102–B117 nu este promovat implicit la executor provider-native.

### F. Backup, restore și disaster recovery (B126–B150)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B126 | VM snapshot policy | Schedule, retention, quiesce și max-chain. | Rez | M | Done |
| B127 | Snapshot vs backup guardrail | UI explică failure domain și blochează falsa protecție. | Sig | S | Done |
| B128 | Unified backup inventory | Recovery points, type, repository, size și verification. | Rez | L | Done |
| B129 | Backup job orchestrator | Full/incremental schedules per provider/VM group. | Rez | XL | Partial |
| B130 | Smart backup selection | Dinamic după tag/site/state/owner/classification. | Ops | M | Partial |
| B131 | Backup exclusion policy | Disk/tag/path exclusions cu warning și audit. | Gov | M | Partial |
| B132 | Application-consistency policy | Guest agent/VSS/scripts, fallback și evidence. | Rez | L | Partial |
| B133 | Backup concurrency controller | Global/provider/repository/host IO limits. | Rez | M | Partial |
| B134 | Backup bandwidth windows | Rate limit și schedule după site/link. | Ops | M | Partial |
| B135 | GFS retention engine | Daily/weekly/monthly/yearly policy normalizată. | Gov | M | Partial |
| B136 | Immutable retention adapter | Object lock/WORM/immutable host capabilities. | Sig | L | Partial |
| B137 | Backup encryption policy | Key reference, algorithm, rotation constraints și compliance. | Sig | L | Partial |
| B138 | Backup integrity verification | Hash/metadata/chain validation fără full restore. | Rez | L | Partial |
| B139 | Automated restore drill | Isolated restore, boot/agent/app check și cleanup. | Rez | XL | Partial |
| B140 | Restore drill scheduler | Sample-based weekly/monthly verification cu SLA. | Rez | M | Partial |
| B141 | File-level restore browser | Search/download/restore gated pe backup compatibil. | Ops | XL | Partial |
| B142 | Instant/live restore adapter | Start workload înainte de hidratarea completă. | Rez | XL | Partial |
| B143 | Differential restore adapter | Refolosește baza locală cu integrity safeguards. | Rez | XL | Partial |
| B144 | Cross-site backup copy | Copy/mirror cu resumability și bandwidth policy. | Rez | L | Partial |
| B145 | VM replication policy | Async/near-sync/sync capability and RPO. | Rez | XL | Partial |
| B146 | DR protection groups | Grupe app-consistente cu boot order/network maps. | Rez | XL | Partial |
| B147 | Failover plan/runbook | Precheck, isolate, promote, validate și notify. | Rez | XL | Partial |
| B148 | Failback workflow | Reverse sync, planned cutback și validation. | Rez | XL | Partial |
| B149 | Non-disruptive DR test | Bubble network și temporary clones fără production impact. | Rez | XL | Partial |
| B150 | RPO/RTO compliance dashboard | Target vs actual recovery point și test duration. | Gov | L | Partial |

**Status reconciliat 2026-07-30:** B126–B128 sunt livrate în scope-ul declarat.
B129–B150 au fundație, contracte ori execuție pe un subset de provideri, dar
rămân `Partial` până când backup/restore/DR este executabil și verificabil pe
providerii declarați în batch-ul R5.

**Status implementare R5a / working tree 2026-07-30:** B129–B138 au acum un
contract de execuție v1.1 persistent și hash-bound: mod provider/full/incremental,
selecție dinamică tag/site/state/owner/classification, excluderi explicite,
consistență și hook references, admission global/provider/host/repository/policy,
ferestre bandwidth, GFS fără prune authority, cerințe encryption/immutability și
evidence separată provider/metadata/checksum/chain. Proxmox `vzdump` rămâne
singurul executor real și este fail-closed pentru traduceri nedovedite. XO cere
un schedule/job task-aware descoperit, iar vSphere un adaptor VADP/VDDK/vendor cu
data mover. Din acest motiv B129–B138 rămân `Partial` până la canary și al doilea
adaptor executabil.

### G. Security, confidential computing și compliance (B151–B175)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B151 | Provider security posture packs | Checks versionate per VMware/Hyper-V/Nutanix/PVE/Xen/KubeVirt. | Sig | L | Partial |
| B152 | Secure Boot inventory | Host și VM enabled/capable/noncompliant. | Sig | M | Partial |
| B153 | vTPM inventory | Presence, version, state și migration/clone constraints. | Sig | M | Partial |
| B154 | Encryption inventory | VM disks, saved state, migration și backup coverage. | Sig | L | Partial |
| B155 | KMS/key-provider registry | Endpoint health, certificate expiry și affected resources. | Sig | L | Partial |
| B156 | Shielded/confidential VM detector | Identifică HGS/SEV/TDX și special constraints. | Sig | M | Partial |
| B157 | Confidential VM provisioning | Policy-based compatible host/image/flavor selection. | Sig | XL | Partial |
| B158 | Host hardening baseline | CIS/STIG/vendor guidance evidence și drift. | Sig | L | Partial |
| B159 | VM virtual hardware baseline | Firmware, devices, boot, TPM și unsafe legacy settings. | Sig | M | Partial |
| B160 | Insecure protocol detector | HTTP, weak TLS, password SSH, legacy APIs și expired certs. | Sig | M | Partial |
| B161 | Certificate trust dashboard | Chain, SAN, expiry, algorithm și renewal owner. | Sig | M | Partial |
| B162 | Certificate rotation workflow | CSR/import/validate/rollback per provider. | Sig | XL | Partial |
| B163 | CVE/advisory correlator | Mapează version/build la advisories oficiale și severity. | Sig | L | Partial |
| B164 | Exposure-based patch priority | Combină CVE, workload criticality și reachability. | Sig | L | Partial |
| B165 | Security finding exceptions | Owner, reason, expiry și compensating controls. | Gov | M | Partial |
| B166 | Remediation plan/dry-run | Pași, downtime, dependencies și rollback înainte de fix. | Sig | L | Partial |
| B167 | Automated low-risk remediation | Config fixes allowlisted cu canary și verification. | Sig | XL | Partial |
| B168 | Secrets reference enforcement | Interzice credențiale inline în manifests/jobs/templates. | Sig | M | Partial |
| B169 | Privileged action elevation | Step-up MFA/JIT grant pentru operații critice. | Sig | L | Partial |
| B170 | Break-glass workflow | Cont temporar, approval, session recording și review. | Sig | L | Partial |
| B171 | Console/remote-session recording | Metadata și opțional recording conform policy/consent. | Gov | XL | Partial |
| B172 | Data classification tags | Public/internal/confidential/restricted propagate în policy. | Gov | M | Partial |
| B173 | Compliance evidence export | Signed JSON/PDF bundle cu checks, configs și audit links. | Gov | L | Partial |
| B174 | Control-framework mapping | CIS/NIST/ISO/SOC2/DORA mappings fără duplicarea finding-ului. | Gov | L | Partial |
| B175 | Ransomware recovery posture | Immutability, isolation, test restore și credential separation score. | Sig | L | Partial |

**Status reconciliat 2026-07-30:** B151–B175 rămân `Partial`. Există posture,
guardrails, inventory și contracte de control, însă provider-native evidence,
remediation controlată și exportul complet de compliance sunt urmărite în R6.

### H. Identity, multi-tenancy și guvernanță (B176–B200)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B176 | Fine-grained permission catalog | Verbe explicite pe resource type și scope. | Gov | L | Done |
| B177 | Custom roles | Compoziție de permissions cu safe defaults. | Gov | M | Done |
| B178 | Scope hierarchy | Organization/site/provider/cluster/project/resource. | Gov | L | Done |
| B179 | Delegated site admin | Admin doar pe site/fabric atribuit. | Gov | M | Done |
| B180 | Project/tenant model | Membri, owners, resources, quota și lifecycle. | Gov | XL | Done |
| B181 | Project invitations | Invitație, acceptare, expiry și domain restriction. | DX | M | Done |
| B182 | Project ownership transfer | Transfer controlat fără orphan resources. | Gov | M | Done |
| B183 | CPU quota | Hard/soft quota și current usage. | Gov | M | Done |
| B184 | Memory quota | Hard/soft quota și reservation accounting. | Gov | M | Done |
| B185 | Storage quota | Logical/physical/backup usage și limits. | Gov | L | Done |
| B186 | Network/public-IP quota | NIC/network/IP/security-group limits. | Gov | M | Done |
| B187 | Snapshot/backup quota | Count și bytes per project/policy. | Gov | M | Done |
| B188 | GPU/device quota | Profile/count/time allocation pentru acceleratoare. | Gov | L | Done |
| B189 | Quota request workflow | Request, approval, time-bound increase și audit. | Gov | M | Done |
| B190 | SSO provider federation | Multi-OIDC/SAML realms și domain routing. | Sig | L | Done |
| B191 | SCIM user/group provisioning | Sync lifecycle din identity provider. | Gov | L | Done |
| B192 | Short-lived service tokens | Expiry, scopes, rotation și last-used. | Sig | M | Done |
| B193 | Workload identity federation | OIDC/SPIFFE/cloud identity fără long-lived secrets. | Sig | XL | Done |
| B194 | Policy approval engine | One/two-person approval după risk și environment. | Gov | L | Done |
| B195 | Change blackout windows | Blochează mutations în freeze periods cu emergency exception. | Gov | M | Done |
| B196 | Resource lease policy | Max TTL, renewal rights și cleanup ownership. | Gov | M | Done |
| B197 | Ownership completeness policy | Blochează production resource fără owner/service/cost center. | Gov | S | Done |
| B198 | Separation-of-duties reports | Detectează combinații role conflictuale. | Gov | M | Done |
| B199 | Access review campaigns | Recertificare periodică pe roles/scopes/service accounts. | Gov | L | Done |
| B200 | Tenant data export/delete | Portabilitate și controlled offboarding. | Gov | L | Done |

**Status implementare 2026-07-29:** B176–B185 au fost livrate în V4.6a / v8.49.0.
Cotele folosesc contabilizarea explicită a resurselor alocate proiectului; discovery-ul
automat pentru logical/physical/backup storage rămâne în batch-urile următoare.

**Status implementare 2026-07-29:** B186–B195 au fost livrate în V4.6b / v8.50.0.
Contabilizarea extinsă rămâne explicită și nu rezervă resurse în provider. Federarea
SAML folosește un broker de identitate de încredere; aplicația nu acceptă assertions
SAML nesemnate și nu implementează un validator XML ad-hoc.

**Status implementare 2026-07-29:** B196–B200 au fost livrate în V4.6c / v8.52.0.
Lease expiry rămâne control-plane only, production ownership este fail-closed,
iar tenant delete cere export valid, checksum, suspendare și confirmare tipărită.

### I. Observabilitate, events și AIOps (B201–B225)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B201 | Unified VM metrics schema | CPU/RAM/disk/network fields, units și provenance. | Ops | L | Done |
| B202 | Provider metrics adapters | vSphere perf, XAPI RRD, PVE RRD, Prometheus, Azure Monitor. | Ops | XL | Done |
| B203 | Metrics freshness indicator | Last sample, lag și collection errors per resource. | Ops | S | Done |
| B204 | Adaptive metrics polling | Frequency după activity, page visibility și rate budget. | Cost | M | Done |
| B205 | Metrics cardinality guard | Label budgets, aggregation și sampling controls. | Cost | M | Done |
| B206 | VM performance charts | CPU/RAM/IO/network cu compare și annotations. | Ops | M | Done |
| B207 | Host contention dashboard | CPU ready, steal, balloon, swap și noisy-neighbor signals. | Ops | L | Done |
| B208 | Storage performance dashboard | Latency/IOPS/throughput/queue/resync correlation. | Ops | L | Done |
| B209 | Network performance dashboard | Throughput/drops/errors/flows/MTU incidents. | Ops | L | Done |
| B210 | Unified event ingestion | Cursor/watch/webhook/poll adapters și normalization. | Ops | XL | Done |
| B211 | Event deduplication | Native ID/fingerprint/time window și repeat counter. | Ops | M | Done |
| B212 | Event correlation timeline | Config changes, tasks, alerts și metrics într-o cronologie. | Ops | L | Done |
| B213 | VM incident timeline | Restart/migrate/snapshot/backup/guest alert context. | Ops | M | Done |
| B214 | Fabric topology correlation | Alert propagation pe host/storage/network dependencies. | Ops | XL | Done |
| B215 | Multi-signal alert rules | Metric+event+state+duration conditions. | Ops | L | Done |
| B216 | Dynamic baseline alerts | Sezon/percentile baseline cu explainability. | Ops | L | Done |
| B217 | Alert dependency suppression | Suprimă simptomele când cauza upstream este activă. | Ops | L | Done |
| B218 | Maintenance-aware alerting | Silence automat cu owner și end time. | Ops | M | Done |
| B219 | Capacity forecast | Time-to-full pe cluster/storage/pool. | Cost | L | Done |
| B220 | Anomaly triage assistant | Rezumă semnale și citează evidence; fără auto-mutation. | Ops | L | Done |
| B221 | Root-cause candidate ranking | Scor explainable pe dependencies și temporal order. | Ops | XL | Done |
| B222 | Recommended runbook links | Mapează finding/event la procedură versionată. | Ops | M | Done |
| B223 | External observability export | OTLP/Prometheus/webhook/syslog cu filters. | Ops | L | Done |
| B224 | SLO and availability reports | Uptime, error budget și maintenance exclusions. | Gov | L | Done |
| B225 | Telemetry privacy controls | Redaction, sampling, retention și data residency. | Gov | M | Done |

**Status implementare 2026-07-29:** B201–B205 au fost livrate în V4.6c / v8.52.0,
iar B206–B215 în V6.4a / v8.53.0. Adaptoarele normalizează payload-uri furnizate
prin API și descriu coverage; nu pretind colectare live în lipsa unui collector
configurat. Charts au limite de range/series, deduplicarea păstrează repeat
evidence, iar topology propagation și multi-signal evaluation sunt advisory.
B216–B225 au fost livrate în V6.4b / v8.54.0: baseline-urile sunt sezoniere și
explicabile, suppressions păstrează cauza dependency/maintenance, forecast-ul și
triage-ul sunt advisory, iar exportul este explicit, bounded și guvernat de
redaction, sampling, retention și data residency. V6.4 este astfel închis.

### J. Automation, GitOps și IaC (B226–B250)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B226 | Persistent infrastructure job engine | Durable state, retry, cancel, resume și compensation. | Rez | XL | Done |
| B227 | Provider task bridge | Leagă job-ul Docker Dash de task-ul nativ. | Ops | L | Done |
| B228 | Idempotency keys | Deduplică mutations și retry-uri după timeout. | Rez | M | Done |
| B229 | Resource locks | Serializare per VM/host/datastore cu lease/expiry. | Rez | M | Done |
| B230 | Operation dependency DAG | Pași/stadii/needs și cycle validation. | Ops | L | Done |
| B231 | Compensation action framework | Rollback/cleanup semantic per step. | Rez | L | Done |
| B232 | Infrastructure change plan | Create/update/delete/blocked/unchanged cu hash. | Gov | L | Done |
| B233 | Stale-plan rejection | Revalidare resource versions înainte de apply. | Sig | M | Done |
| B234 | VM manifest schema | Desired hardware/image/network/storage/policy. | DX | L | Done |
| B235 | Host/fabric manifest schema | Desired maintenance, tags și policy references. | DX | L | Done |
| B236 | Storage/network manifest schema | Desired resources cu ownership și deletion safeguards. | DX | XL | Done |
| B237 | Import live resource to manifest | Export secret-free, normalized și determinist. | DX | M | Done |
| B238 | Declarative drift detection | Live-vs-Git semantic diff și ownership boundaries. | Gov | L | Done |
| B239 | Manual GitOps reconcile | Plan/approve/apply cu commit and diff evidence. | Gov | L | Done |
| B240 | Continuous GitOps reconcile | Optional, scoped, paused-on-conflict controller. | Gov | XL | Done |
| B241 | Pull-request infrastructure preview | Policy checks, cost și blast radius în PR. | DX | L | Done |
| B242 | Terraform state import helper | Generează import mappings fără a prelua state ownership. | DX | L | Done |
| B243 | Terraform run integration | Plan artifact ingestion și gated apply. | Gov | XL | Done |
| B244 | Ansible inventory export | Dynamic inventory cu tags/groups și secret refs. | DX | M | Done |
| B245 | Webhook-triggered runbooks | Signed event, allowlist și replay protection. | Ops | M | Done |
| B246 | Schedule/calendar triggers | Cron, timezone, holiday și blackout awareness. | Ops | M | Done |
| B247 | Approval timeout/escalation | Expire/reassign/escalate fără apply implicit. | Gov | M | Done |
| B248 | Dry-run provider adapters | Native validate/simulate când există; explicit unsupported altfel. | Sig | L | Done |
| B249 | Automation secret broker | JIT fetch, memory-only use și access audit. | Sig | L | Done |
| B250 | Workflow template library | Curated maintenance/migration/backup/security runbooks. | DX | L | Done |

**Status implementare 2026-07-29:** B226–B235 au fost închise în V0.3b /
v8.55.0. B226–B229 reutilizează nucleul persistent V0.3 deja livrat, iar noul
strat adaugă DAG-uri și compensări declarative, manifeste secret-free, planuri
imutabile și respingere stale pe revision/live-state/resource-version/expiry.
Acceptarea intentului și preview-ul de compensare nu execută provider mutations;
ștergerile storage/network rămân blocate până la safeguards B236.

**Status implementare 2026-07-29:** B236–B245 au fost închise în V0.3c /
v8.56.0. Storage/network delete este permis numai pentru ownership `managed`,
`deletionPolicy=delete`, protecție dezactivată și confirmare tipărită. Controller-ul
continuu procesează observații stocate, deduplică și se oprește la conflict; nu
pornește provider mutations. Preview-ul PR, Terraform și inventory Ansible sunt
integrări bounded: nu fac merge, nu preiau state și nu lansează executabile.
Webhook-urile pot porni numai procedura aleasă de admin după HMAC, timestamp,
event allowlist și nonce unic.

**Status implementare 2026-07-29:** B246–B250 au fost închise în V0.3d /
v8.57.0. Schedulerul este timezone/holiday/blackout-aware și păstrează evidence
idempotent pe minut fără a porni automat workflow-ul. Approval timeout poate
escalada sau expira, dar nu autorizează apply. Dry-run-ul folosește numai un
adapter validate/simulate înregistrat și raportează explicit `unsupported` în
lipsa lui. Secret broker-ul păstrează doar referințe, face fetch JIT, golește
bufferul și expune doar fingerprint/audit. Biblioteca include cinci DAG-uri
curated, instanțiate numai după validarea parametrilor.

### K. Lifecycle, updates și configuration management (B251–B275)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B251 | Version and build inventory | Host/control-plane/tools/firmware versions. | Ops | M | Done |
| B252 | Support lifecycle registry | GA/EOL/EOS dates și recommended target. | Gov | M | Done |
| B253 | Upgrade path advisor | Supported hops, prerequisites și blockers per vendor. | Ops | L | Done |
| B254 | Update catalog ingestion | Advisories/packages/bundles din surse oficiale. | Ops | L | Done |
| B255 | Upgrade precheck framework | Health, capacity, backup, compatibility, free space. | Rez | L | Done |
| B256 | Maintenance window planner | Durată, waves, evacuation și owner conflicts. | Ops | M | Done |
| B257 | Cluster rolling-upgrade runner | Node-by-node cu gates și pause. | Rez | XL | Done |
| B258 | Live-patch adapter | Inventory/apply/verify când vendorul îl oferă. | Rez | L | Done |
| B259 | Reboot-required detector | Kernel/hypervisor/toolstack signals și vendor guidance. | Ops | M | Done |
| B260 | Firmware catalog | BIOS/BMC/NIC/storage/GPU mapping și compatibility. | Ops | XL | Done |
| B261 | Driver compatibility checker | Device/driver/firmware/host release matrix. | Rez | XL | Done |
| B262 | Guest tools upgrade campaign | Staged tools update cu compatibility și rollback. | Ops | L | Done |
| B263 | VM hardware version campaign | Precheck, snapshot/backup și staged upgrade. | Ops | L | Done |
| B264 | Certificate inventory | Endpoint/service/host cert ownership și expiry. | Sig | M | Done |
| B265 | Certificate renewal reminders | Thresholds, escalation și maintenance dependencies. | Sig | S | Done |
| B266 | Automated certificate renewal | Vendor adapters cu verify și rollback. | Sig | XL | Done |
| B267 | License entitlement inventory | Edition, capacity, expiry și assigned resources. | Gov | L | Done |
| B268 | License usage alerts | Over/under-assignment și expiry forecasts. | Cost | M | Done |
| B269 | Host configuration snapshot | Periodic secret-redacted desired/actual capture. | Gov | M | Done |
| B270 | Configuration diff | Human-readable changes between captures. | Gov | M | Done |
| B271 | Drift policy | Allowed/denied/ignored fields și owner. | Gov | M | Done |
| B272 | Host profile compliance | Baseline comparison și remediation plan. | Gov | L | Done |
| B273 | Air-gap content mirror | Cache signed packages/images/advisories per site. | Rez | XL | Done |
| B274 | Support bundle orchestrator | Multi-node collection, redaction, checksum și expiry. | Ops | L | Done |
| B275 | Post-upgrade validation pack | API/HA/migration/storage/network/VM smoke tests. | Rez | L | Done |

**Status implementare 2026-07-29:** B251–B255 au fost închise în V0.3d /
v8.57.0. Inventarul host/control-plane/tool/firmware păstrează versiune, build,
freshness și hash-ul evidence. Registrul support derivă GA/EOL/EOS și target,
iar advisorul cere hops/prerequisites/blockers susținute de o sursă HTTPS.
Catalogul acceptă numai ingest marcat `official_vendor`, fără download/install.
Precheck-ul verifică health, capacity, backup, compatibility, free space și
freshness; rezultatul este expiring evidence și nu pornește upgrade-ul.

**Status implementare 2026-07-29:** B256–B265 au fost închise în V0.3e /
v8.58.0. Plannerul separă availability groups și owner concurrency în waves,
verifică durata/evacuarea și cere aprobarea hash-ului imutabil. Campaniile de
cluster, guest tools și VM hardware avansează numai cu o operație durabilă
reușită și post-verificare pozitivă; orice eșec le pune în pause. Live patch
este un contract de adapter explicit cu approval și typed confirmation, iar
lipsa adapterului rămâne `unsupported`. Reboot detection unește patru surse
fără a programa reboot. Firmware/driver compatibility păstrează surse HTTPS și
digest, iar certificatele leagă expiry de owner, escalation, maintenance și
reminders idempotente fără renewal automat.

**Status implementare 2026-07-29:** B266–B275 au fost închise în V0.3f /
v8.59.0. Renewal-ul cere plan hash, două aprobări explicite și operation evidence;
adapterul face apply/verify și urmează rollback policy la eșec. License inventory
folosește referințe opace, iar alertele acoperă assignment, usage, expiry și
forecast fără schimbare de licență. Snapshot-urile redactează înainte de hash,
diff-urile alimentează reguli allowed/denied/ignored și profile versionate cu
remediation advisory. Mirror-ul acceptă doar digesturi cerute și semnături din
trust roots, fără fallback de download. Support bundles sunt bounded, redacted,
checksummed și expiring, iar validation packs fail-closed pentru cele șase
categorii și pornesc zero provider mutations.

### L. FinOps, capacity și sustenabilitate (B276–B300)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B276 | Unified resource allocation ledger | vCPU/RAM/storage/GPU/IP alocat vs folosit. | Cost | L | Done |
| B277 | Private-cloud cost model | Hardware/software/facility/energy/personnel parameters. | Cost | L | Done |
| B278 | Provider/license cost model | Per-core/socket/host/subscription cost windows. | Cost | M | Done |
| B279 | Storage tier cost model | Cost per logical/physical/replicated/backup GB. | Cost | M | Done |
| B280 | Network/public-IP cost model | Transfer, egress, LB, VPN și address cost. | Cost | M | Done |
| B281 | GPU accelerator cost model | Device/profile/hour și reservation accounting. | Cost | M | Done |
| B282 | Tag-based cost allocation | Business unit/app/env/cost center mapping. | Cost | M | Done |
| B283 | Showback dashboards | Transparent usage/cost fără billing transaction. | Cost | L | Done |
| B284 | Chargeback export | Rated usage CSV/API pentru billing/ERP. | Cost | L | Done |
| B285 | Budget definitions | Monthly/quarterly per scope/cost center. | Cost | M | Done |
| B286 | Budget threshold alerts | Forecast și actual 50/80/100% notifications. | Cost | S | Done |
| B287 | Cost anomaly detection | Unexpected spend/consumption changes cu evidence. | Cost | L | Done |
| B288 | Idle VM detector | Low utilization + owner/uptime/criticality context. | Cost | M | Done |
| B289 | Oversized VM detector | Rightsize CPU/RAM cu confidence și peak guard. | Cost | L | Done |
| B290 | Zombie resource detector | Stale disk/snapshot/IP/template/backup candidates. | Cost | M | Done |
| B291 | Schedule-based savings | Recomandă/automatizează off-hours power policy. | Cost | M | Done |
| B292 | Reserved capacity recommendations | On-prem headroom și cloud commitment guidance. | Cost | L | Done |
| B293 | Cluster consolidation scenario | Simulează host removal fără SLA/HA breach. | Cost | L | Done |
| B294 | Capacity purchase forecast | When/what capacity pe growth și failure tolerance. | Cost | L | Done |
| B295 | Workload placement cost score | Cost+performance+resilience+compliance. | Cost | XL | Done |
| B296 | Power/energy telemetry ingestion | BMC/vendor metrics normalizate per host. | Cost | L | Done |
| B297 | Energy efficiency dashboard | Watt/VM, watt/workload și idle host waste. | Cost | L | Done |
| B298 | Carbon factor configuration | Region/site/time carbon intensity și provenance. | Gov | M | Done |
| B299 | Carbon-aware scheduling recommendation | Propune time/site fără a încălca SLA/data residency. | Cost | XL | Done |
| B300 | TCO scenario comparator | Compară hardware/provider/licensing/migration assumptions. | Cost | XL | Done |

**Status implementare 2026-07-29:** B276–B285 au fost închise în V6.3a /
v8.60.0. Ledger-ul păstrează separat allocation și usage pentru CPU, RAM,
storage, GPU și IP, cu interval și evidence hash. Cinci modele versionate acoperă
private cloud, provider/licensing, storage tiers, network/IP și GPU, fiecare cu
currency, confidence, sursă HTTPS și fereastră de valabilitate. Regulile de tag
rezolvă business unit, application, environment și cost center cu prioritate
deterministă. Rating-ul showback păstrează formula și provenance pe linie, iar
CSV/JSON chargeback sunt exporturi pentru ERP, nu tranzacții. Bugetele monthly
sau quarterly sunt comparate per scope.

**Status implementare 2026-07-29:** B286–B295 au fost închise în V6.3b /
v8.61.0. Pragurile actual/forecast produc notificări idempotente, iar anomaly
detection compară rating runs cu baseline și evidence. Detectoarele idle,
oversized și zombie includ owner, criticality, coverage, peak guards și nu
execută remedieri. Off-hours automation necesită policy automate, approval
legat de hash, durable operation, confirmare tipărită și adapter cu verify.
Reserved-capacity, consolidarea N+1, purchase forecast și placement scoring sunt
scenarii explicabile; nu cumpără, nu elimină hosturi și nu mută workload-uri.

**Status implementare 2026-07-29:** B296–B300 au fost închise în V6.3c /
v8.62.0. Telemetria normalizează watt și kWh per host/site cu interval, sursă și
provenance. Dashboard-ul calculează W/VM, W/workload, idle waste, emisii și
acoperirea factorilor de carbon. Factorii sunt versionați temporal și legați de
surse HTTPS. Recomandările carbon-aware exclud explicit candidații care încalcă
rezidența, SLA, latența sau capacitatea și nu programează/migrează workload-uri.
Comparatorul TCO păstrează ipotezele hardware, provider, licențiere, energie,
migrare, discount și risc și nu creează achiziții ori tranzacții de billing.

### M. Kubernetes și convergență VM–container (B301–B325)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B301 | KubeVirt capability discovery | Detectează CRDs, CDI, migrations, snapshots și console. | Ops | M | Done |
| B302 | KubeVirt VM inventory | Normalizează VirtualMachine/Instance/InstanceMigration. | Ops | L | Done |
| B303 | OpenShift Virtualization adapter | OCP routes, RBAC, projects și operator conditions. | Ops | L | Done |
| B304 | Harvester adapter | Harvester CRDs, images, networks, backups și Longhorn state. | Ops | L | Done |
| B305 | VM YAML editor | Schema-aware, diff și server dry-run pentru CRD. | DX | M | Done |
| B306 | DataVolume inventory | CDI sources, import/clone/upload și progress. | Ops | M | Done |
| B307 | DataVolume creation wizard | HTTP/registry/PVC/upload source cu checksum. | DX | L | Done |
| B308 | VM template/instancetype inventory | Templates, instancetypes și preferences. | DX | M | Done |
| B309 | VM template instantiate | Parametri, namespace, storage și network validation. | DX | L | Done |
| B310 | VM live-migration policy | Bandwidth, concurrency, completion și timeout policy. | Rez | L | Done |
| B311 | Node drain VM awareness | Eviction/migration strategy și non-migratable blockers. | Rez | L | Done |
| B312 | CSI snapshot capability map | VolumeSnapshotClass, quiesce și restore support. | Rez | M | Done |
| B313 | Multus network inventory | NADs, attachments, IPAM și interface mappings. | Ops | M | Done |
| B314 | NMState network intent | Host network policies și enactment health. | Ops | L | Done |
| B315 | VM service exposure | Kubernetes Service/Route/Ingress mapping pentru VM. | DX | M | Done |
| B316 | VM/pod unified topology | Relații namespace/service/network/storage/node. | Ops | L | Done |
| B317 | VM/pod unified metrics | Common workload charts și contention context. | Ops | L | Done |
| B318 | VM/pod unified policy | Labels, quotas, network și admission evidence. | Gov | XL | Done |
| B319 | VM GitOps reconciliation | Flux/Argo-compatible manifests și status. | DX | L | Done |
| B320 | VM admission policy library | Secure boot, images, resources, networks și ownership. | Sig | L | Done |
| B321 | Kubernetes cluster provisioning catalog | AKS Arc/NKE/OpenShift/CKS/Rancher workflows. | DX | XL | Done |
| B322 | Cluster lifecycle dashboard | Version, support, nodes, addons și upgrade readiness. | Ops | L | Done |
| B323 | VM-to-container modernization map | App dependencies și staged migration checklist. | DX | L | Done |
| B324 | Shared image provenance | OCI/VM image SBOM, signatures și source linkage. | Sig | XL | Done |
| B325 | Unified application environment | Un singur view pentru stack Compose, VM și Kubernetes app. | DX | XL | Done |

**Status implementare 2026-07-29:** B301–B305 au fost închise în V5.6a /
v8.62.0. Discovery combină API groups și CRD evidence și raportează `unknown`
când RBAC împiedică verdictul. Inventarul unește VirtualMachine, VMI și
InstanceMigration prin identitate namespace/name, cu state, node, IP și
migration history. Adaptoarele OpenShift și Harvester expun routes/projects,
operator/RBAC, images, NAD networks, backups și Longhorn fără mutații. Editorul
acceptă exclusiv `kubevirt.io/v1 VirtualMachine`, blochează identitatea/statusul
și secretele inline, produce diff și trimite numai `dryRun=All`; nu există
endpoint de apply.

**Status implementare 2026-07-29:** B306–B315 au fost închise în V5.6b /
v8.63.0. CDI inventory normalizează sursa, storage, faza, progresul și condițiile,
iar wizardul acceptă HTTPS/registry/PVC/upload și checksum SHA-256. Template,
instancetype și preference inventory păstrează coverage fără a returna valorile
implicite ale parametrilor. Crearea DataVolume și instanțierea VM folosesc
manifest canonic, prerequisites, API `dryRun=All`, approval legat de plan hash,
four-eyes, confirmare tipărită, revalidare, jurnal durabil și read-back cu
fingerprint. Politica de live migration este declarativă/locală și nu se aplică
singură. Drain awareness, CSI snapshots, Multus, NMState și Service/Route/Ingress
sunt evidence read-only, cu redacție și stări `unknown` când RBAC/API nu permit
un verdict.

**Status implementare 2026-07-29:** B316–B325 au fost închise în V5.6c / V6.1a
/ v8.64.0. Topologia corelează namespace, pod/VM, Service, node, PVC/DataVolume
și Multus, iar metricile normalizează CPU/memorie și marchează contention cu
proveniență explicită. Quotas, NetworkPolicy, admission controllers și labels
formează evidence unificat. Planurile VM GitOps sunt Flux/Argo-aware, resping
secrete și URL-uri credentializate și se opresc după `dryRun=All`; nu există
apply. Biblioteca de cinci politici produce numai evaluări locale. Catalogul de
provisioning pentru AKS Arc, NKE, OpenShift, CKS și Rancher rămâne blocat până la
prechecks și nu are executor de provider. Lifecycle, modernization, provenance
OCI/VM și application environments sunt persistente, hash-idempotent și nu
modifică workload-uri, clustere ori registre.

### N. Edge, ROBO, disconnected și sovereign (B326–B350)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B326 | Site/edge location model | Timezone, region, connectivity și local owner. | Gov | M | Done |
| B327 | Intermittent-connectivity provider mode | Queue/read-cache și explicit stale state. | Rez | L | Done |
| B328 | Offline mutation queue | Signed, expiring intents cu revalidation la reconnect. | Rez | XL | Done |
| B329 | Edge heartbeat and last-seen | Health fără false outage la expected disconnect. | Ops | M | Done |
| B330 | Bandwidth-aware sync | Prioritizează inventory/events înainte de metrics/artifacts. | Cost | L | Done |
| B331 | Store-and-forward events | Buffer local cu cursor, compression și dedup. | Rez | L | Done |
| B332 | Local edge execution agent | Runbook allowlist semnat când control plane e offline. | Rez | XL | Done |
| B333 | Edge agent auto-update rings | Canary/stable/held, rollback și offline bundle. | Rez | L | Done |
| B334 | Air-gapped provider bootstrap | Certificates, packages și docs bundle verificat. | DX | L | Done |
| B335 | Offline image/content mirror | OCI/ISO/template/package mirror cu signatures. | Rez | XL | Done |
| B336 | Sovereign data-residency policy | Blochează logs/backups/metrics în afara zonei. | Gov | L | Done |
| B337 | Disconnected identity cache | Short-lived cached auth și emergency policy. | Sig | XL | Done |
| B338 | Site-local secret vault adapter | Credential resolution fără central secret transit. | Sig | XL | Done |
| B339 | Edge cluster single-node profile | Capability/HA caveats și safe defaults. | Ops | M | Done |
| B340 | Witness/quorum topology view | Voting members, witness și failure-domain risk. | Rez | M | Done |
| B341 | Edge resource reservation | Protejează system capacity în small clusters. | Rez | M | Done |
| B342 | Low-bandwidth console mode | Serial/text-first și adaptive quality. | DX | L | Done |
| B343 | Remote-hands runbook | BMC/console/checklist/approval pentru site fără operator. | Ops | M | Done |
| B344 | BMC inventory | Redfish/IPMI power, sensors, firmware și ownership. | Ops | L | Done |
| B345 | Out-of-band host recovery | JIT BMC action cu fencing/HA safeguards. | Rez | XL | Done |
| B346 | Site disaster declaration | Freeze mutations, notify și activate runbook. | Rez | L | Done |
| B347 | Edge backup seeding | Local seed, offline transfer și delta continuation. | Rez | L | Done |
| B348 | Edge fleet compliance summary | Aggregate evidence fără exportul datelor sensibile. | Gov | L | Done |
| B349 | Multi-rack/fault-domain visualization | Rack/power/network/storage domain și placement risk. | Rez | L | Done |
| B350 | Edge zero-touch enrollment | One-time token, hardware identity și certificate bootstrap. | DX | XL | Done |

**Status implementare 2026-07-29:** B326–B335 au fost închise în V6.5a /
v8.65.0. Site-urile păstrează timezone IANA, regiune, jurisdicție, owner, trust
roots și host mapping unic. Conectivitatea intermitentă separă cache `fresh` /
`stale` / `expired` și expected disconnect de outage. Intențiile offline sunt
HMAC-signate, expirabile și devin `ready_for_agent` numai după revalidarea
completă; control plane-ul nu le execută. Heartbeat-ul are sequence anti-replay.
Event buffer-ul este deflate-raw, cursor-based, deduplicat și sincronizat în
ordinea configurată inventory/events/metrics/artifacts, cu acknowledgement legat
de plan hash. Agenții au allowlist de runbook, rings canary/stable/held și
update plan cu bundle/rollback verificabil, fără apply central. Bootstrap și
mirror manifests includ numai certificate/package/docs/OCI/ISO/template refs,
digests și external signature evidence; nu includ private keys și nu descarcă
ori sincronizează implicit. Heartbeat-ul poate fi ingerat prin endpointul
administrativ existent sau printr-un gateway mTLS extern; API-ul nu pretinde că
endpointul administrativ este autentificare directă de agent.

**Status implementare 2026-07-29:** B336–B345 au fost închise în V6.5b /
v8.66.0. Rezidența este fail-closed și blochează sync plans care ar scoate
inventory/logs/metrics/backups din jurisdicția permisă. Cache-ul de identitate
păstrează numai assertion hash, scope și TTL scurt, cu activare four-eyes și
fără token returnat. Vault adapters păstrează referințe și emit numai planuri
semnate de rezoluție locală. Profilul single-node, quorum/witness view și
resource reservations expun caveats și assessment fără apply. Consola este
serial/text-first, fără clipboard/file transfer. Remote-hands și BMC recovery
folosesc plan hash, typed confirmation, approval independent, safeguards de
fencing/quorum/backup și pachete JIT executabile numai de agentul edge; control
plane-ul nu apelează BMC-ul.

**Status implementare 2026-07-29:** B346–B350 au fost închise în V6.5c /
v8.67.0. Declarația de disaster îngheață mutațiile, semnează un runbook local și
pune notificări în outbox, iar alt administrator eliberează freeze-ul cu
confirmare și evidence hash. Backup seeding păstrează manifests/chunks semnate
și checkpoints monotone pentru transfer offline/delta. Fleet compliance expune
numai control/state agregat, fault domains acoperă rack/power/network/storage
fără placement apply, iar enrollment-ul hardware-bound folosește token one-time,
attestation și certificate fingerprint four-eyes fără private key central.

### O. UX, self-service și service catalog (B351–B375)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B351 | Unified infrastructure home | VM/container/K8s health, risks, costs și recent changes. | DX | M | Done |
| B352 | Provider-aware navigation | Afișează doar pages/actions susținute live. | DX | S | Done |
| B353 | Consistent resource detail shell | Tabs/actions/tasks/events/audit identice între providers. | DX | M | Done |
| B354 | Action availability explanation | Tooltip cu capability/policy/state/permission blocker. | DX | S | Done |
| B355 | Long-task activity center | Persistent jobs, progress, cancel și deep links. | DX | M | Done |
| B356 | Global command palette | Search/navigation/safe actions cu permissions. | DX | M | Done |
| B357 | Bulk selection basket | Resurse cross-page cu preview și compatibility filter. | DX | M | Done |
| B358 | Infrastructure service catalog | Curated VM/app/cluster offerings. | DX | L | Done |
| B359 | Catalog item versioning | Owner, lifecycle, changelog, deprecation și compatibility. | Gov | M | Done |
| B360 | Dynamic request forms | Conditional fields, validation și cost preview. | DX | L | Done |
| B361 | Request approval inbox | Risk/context/diff/expiry și approve/reject comment. | Gov | M | Done |
| B362 | Request fulfillment timeline | Requested→approved→running→validated state. | DX | M | Done |
| B363 | Self-service project dashboard | Resources, quota, cost, alerts și requests. | DX | L | Done |
| B364 | Self-service VM provisioning | Catalog-scoped create fără fabric details. | DX | XL | Done |
| B365 | Self-service lifecycle actions | Power/snapshot/console within project policy. | DX | L | Done |
| B366 | Self-service quota increase | Time-bound request and approval. | DX | M | Done |
| B367 | Portal branding | Logo/colors/help links per organization. | DX | M | Done |
| B368 | Contextual documentation | Provider/version/action-specific guidance și caveats. | DX | M | Done |
| B369 | Guided troubleshooting | Evidence checklist, support bundle și next safe test. | Ops | L | Done |
| B370 | Explainable recommendations | Reason, evidence, confidence, impact și undo. | DX | M | Done |
| B371 | Keyboard-accessible VM operations | Full navigation/action/confirm accessibility. | DX | M | Done |
| B372 | Mobile incident view | Read/ack/pause/job status fără destructive defaults. | Ops | M | Done |
| B373 | Localization completeness gate | Provider/action strings și safety copy testate. | Gov | S | Done |
| B374 | Accessibility conformance pack | WCAG focus, contrast, labels, live regions și tests. | Gov | M | Done |
| B375 | Product feedback telemetry opt-in | Feature usage/failure funnels fără sensitive payloads. | DX | M | Done |

**Status implementare 2026-07-29:** B351–B355 au fost închise în V6.1b /
v8.67.0. Home-ul comun agregă doar endpointurile permise și evidența persistentă
VM/container/Kubernetes, risks, rated cost și recent operations, marcând
acoperirea necunoscută. Navigația folosește endpointuri active care nu sunt
explicit unhealthy. DetailShell normalizează Overview/Actions/Tasks/Events/Audit,
deciziile de acțiune separă blockers de capability/policy/state/permission, iar
Activity Center oferă summary, progress, cancel availability și deep links
canonice pentru operație și resursă.

**Status implementare 2026-07-30:** B356–B365 au fost închise în V6.2a /
v8.68.0. Command palette combină resursele cu proiecte, oferte și cereri și
explică acțiunile indisponibile, iar basket-ul persistent calculează
compatibilitatea cross-page. Catalogul VM/app/cluster este versionat și are
owner, lifecycle, changelog, compatibilitate, formulare condiționale, validare
și cost preview. Inbox-ul leagă risk/diff/expiry de aprobarea existentă, iar
timeline-ul păstrează tranzițiile. Dashboard-ul de proiect oferă resources,
quota alerts, cost boundary și requests. Provisioning-ul VM și lifecycle
power/snapshot/console ascund fabric details și refolosesc preflight-ul și
motorul persistent de operații după aprobarea separată.

**Status implementare 2026-07-30:** B366–B375 au fost închise în V6.2b /
v8.69.0. Quota increase folosește aprobări și granturi temporare; branding-ul
moștenit acceptă numai URL-uri same-origin/HTTPS. Ajutorul contextual și
troubleshooting-ul sunt provider/version/action-aware, iar bundle-urile de
suport sunt redacted și hash-bound. Recomandările sunt explicabile și strict
advisory. Operațiile VM au navigare de tastatură, incident view-ul mobil oferă
numai acknowledge/pause, iar gate-urile CI verifică safety copy în 11 limbi și
contractele de accesibilitate. Feedback telemetry este opt-in, agregat local și
nu face transmisii de rețea.

### P. Hardware, acceleratoare și performanță (B376–B400)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B376 | Host hardware inventory | CPU/NUMA/RAM/NIC/HBA/disk/GPU/BMC normalized. | Ops | L | Done |
| B377 | Hardware compatibility tags | Model/generation/feature baseline pentru migration/placement. | Rez | M | Done |
| B378 | CPU feature baseline view | Common/extra/missing features per cluster. | Rez | M | Done |
| B379 | CPU compatibility policy | EVC/compatibility mode inventory și editor adapter. | Rez | L | Done |
| B380 | NUMA topology visualizer | Nodes, CPUs, memory, devices și VM placement. | Ops | L | Done |
| B381 | VM NUMA fit analyzer | Warn remote-memory/oversize topology. | Ops | L | Done |
| B382 | CPU pinning inventory | Dedicated/shared pools și conflicts. | Ops | M | Done |
| B383 | Real-time workload profile | Pinning, isolation, hugepages și latency checks. | Ops | L | Done |
| B384 | Hugepage capacity dashboard | Size/node/free/allocated și fragmentation. | Ops | M | Done |
| B385 | Memory balloon/overcommit dashboard | Reserved/active/balloon/swap și risk. | Rez | L | Done |
| B386 | Memory tiering visibility | DRAM/NVMe tiers, hit rate și workload impact. | Cost | L | Done |
| B387 | PCI device inventory | IOMMU groups, allocation, reset și passthrough readiness. | Ops | L | Done |
| B388 | PCI passthrough assignment | Safe attach/detach cu host placement constraints. | Ops | XL | Done |
| B389 | SR-IOV VF allocator | PF/VF pools, NUMA affinity și quota. | Ops | XL | Done |
| B390 | GPU inventory | Vendor/model/memory/driver/profile/health. | Ops | L | Done |
| B391 | GPU passthrough assignment | Device availability și migration/HA caveats. | Ops | XL | Done |
| B392 | vGPU/GPU-P profile allocator | Shared profile capacity, licenses și placement. | Ops | XL | Done |
| B393 | GPU utilization metrics | SM/memory/encoder/ECC/throttle per workload. | Cost | L | Done |
| B394 | Accelerator reservation schedule | Time/project based scarce-device booking. | Gov | L | Done |
| B395 | USB passthrough inventory | Device ownership, mappings și mobility caveats. | Ops | M | Done |
| B396 | Virtual hardware compatibility scan | VM devices vs target host/provider/version. | Rez | L | Done |
| B397 | Performance benchmark registry | Controlled baseline results și hardware metadata. | Ops | L | Done |
| B398 | Noisy-neighbor detector | Correlate contention și colocated workloads. | Ops | XL | Done |
| B399 | Performance regression detector | Before/after migration/upgrade/config change. | Ops | L | Done |
| B400 | Workload performance profile | Batch/database/VDI/latency/AI policy presets. | DX | L | Done |

**Status implementare 2026-07-30:** B376–B385 au fost închise în V6.6a /
v8.70.0. Snapshot-urile normalizate păstrează proveniență bounded pentru
CPU/NUMA/RAM/NIC/HBA/disk/GPU/BMC, tags de compatibilitate și placement VM.
Cluster view calculează tag/CPU common-extra-missing, iar editorul CPU păstrează
numai desired plan și blockers, fără apply. NUMA fit, pinning și real-time checks
corelează CPUs, device locality, isolation, hugepages, balloon și swap.
Dashboard-urile hugepage/memory sunt strict evidence-only; nu există endpoint
pentru BIOS/EVC/device/pinning/memory mutation.

**Status implementare V6.6b / v8.71.0:** B386–B395 adaugă snapshots
credential-free pentru memory tiers, PCI/IOMMU/PF/VF, GPU/profile și USB,
analize de readiness și telemetry GPU. Alocările PCI, SR-IOV, GPU și vGPU sunt
planuri control-plane conflict-checked, izolate per host, cu NUMA/migration/HA
caveats și capacitate/licență vGPU. Rezervările temporale detectează overlap,
dar nu rezervă în provider. Release-ul unui plan nu face detach, iar niciun
endpoint din batch nu poate porni attach, detach sau provider apply.

**Status implementare V6.6c / v8.72.0:** B396–B400 închid hardware/performance
cu scanări VM-target pentru CPU/memory/device/provider-version, baseline-uri
controlate legate de hardware evidence, corelație temporală explicit
non-cauzală pentru noisy neighbors și comparații direction-aware înainte/după
schimbări. Preseturile batch/database/VDI/latency/AI sunt desired thresholds;
nu pornesc migration, placement sau reconfigurare.

### Q. Integrații, extensibilitate și migration factory (B401–B425)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B401 | Signed provider plugin manifest | API version, permissions, capabilities și signature. | Sig | L | Done |
| B402 | Out-of-process plugin sandbox | Resource/network/filesystem limits și RPC boundary. | Sig | XL | Done |
| B403 | Plugin permission consent | Explicit read/write/secrets/network capabilities. | Gov | M | Done |
| B404 | Plugin compatibility checker | Core/API/version/schema conformance before enable. | Rez | M | Done |
| B405 | Plugin health and telemetry | Crashes/latency/rate/errors fără payload secrets. | Ops | M | Done |
| B406 | Connector marketplace registry | Curated metadata, signatures și support level. | DX | L | Done |
| B407 | CMDB connector | NetBox/ServiceNow/GLPI sync cu ownership rules. | Gov | L | Done |
| B408 | ITSM change connector | Ticket/change-window/approval/evidence links. | Gov | L | Done |
| B409 | SIEM connector pack | Splunk/Elastic/Sentinel/syslog normalized events. | Sig | L | Done |
| B410 | Secrets manager connectors | Vault/Key Vault/Secrets Manager/1Password refs. | Sig | L | Done |
| B411 | IPAM/DNS connector pack | NetBox/Infoblox/PowerDNS/Route53 lifecycle. | Ops | L | Done |
| B412 | Backup vendor connector API | Veeam/Commvault/Rubrik/HYCU job/recovery visibility. | Rez | XL | Done |
| B413 | Monitoring connector pack | Prometheus/Grafana/Datadog/Zabbix/PRTG. | Ops | L | Done |
| B414 | Message/event bus integration | Kafka/NATS/AMQP/SNS/SQS publish with schema. | Ops | L | Done |
| B415 | Generic OpenAPI connector | Read/action prototypes with strict allowlist. | DX | XL | Done |
| B416 | Migration assessment scanner | Source inventory, dependencies, blockers și target candidates. | DX | XL | Done |
| B417 | VM format conversion worker | Sandboxed qemu-img/virt-v2v with checksums. | DX | XL | Done |
| B418 | Migration network mapper | VLAN/subnet/security/IP target translation. | Ops | L | Done |
| B419 | Migration storage mapper | Datastore/policy/tier/capacity target translation. | Ops | L | Done |
| B420 | Migration test clone | Isolated target boot fără source cutover. | Rez | XL | Done |
| B421 | Migration wave planner | Apps/dependencies/downtime/business windows. | Gov | L | Done |
| B422 | Cutover orchestrator | Final sync, shutdown, network switch, boot și validation. | Rez | XL | Done |
| B423 | Migration rollback orchestrator | Restore source network/power și cleanup target safely. | Rez | XL | Done |
| B424 | Migration evidence report | Source/target checksums, timings, tests și approvals. | Gov | M | Done |
| B425 | Legacy Xen migration assistant | `xm`/`xl`/Xend discovery și guided move spre XAPI/XCP-ng. | DX | L | Done |

**Status implementare V5.8a / v8.72.0:** B401–B405 adaugă canonical Ed25519
manifest verification, permisiuni explicite cu nivel de risc și consent legat
de exact manifest hash. Enable rămâne blocat până când signature, core/API,
schema/capabilities și toate consimțămintele trec. Sandbox probe folosește un
worker JSON-RPC fix într-un proces separat, 32 MiB/2 secunde/16 KiB output,
environment gol, fără plugin code/path/endpoint și fără payload în răspuns.
Health telemetry acceptă exclusiv latency/request/error/crash aggregates și
respinge câmpuri suplimentare sau credential-shaped.

**Status implementare V5.8b / v8.73.0:** B406–B415 închid backlog-ul de
conectori cu marketplace metadata semnată Ed25519 și support level explicit.
CMDB păstrează ownership per field, ITSM leagă ticket/approval/window/evidence,
SIEM normalizează fără raw payload, iar Vault/Key Vault/Secrets Manager/
1Password păstrează exclusiv referințe. IPAM/DNS produce planuri legate de
ownership token și expected version; backup și monitoring normalizează numai
visibility/allowlist evidence. Event bus și OpenAPI sunt schema/operation/field
allowlisted, persistă planuri hash-bound și pornesc zero request-uri externe.

**Status implementare V6.7 / v8.74.0:** B416–B425 adaugă assessment cu
inventory/dependency/blocker/candidate scoring, mapări network/storage și
test-clone evidence izolat. Workerul subprocess fix validează contracte
qemu-img/virt-v2v numai cu formate și checksum-uri: nu primește path, nu face
disk I/O și nu rulează binarul. Wave planner ordonează dependențe și ferestre;
cutover/rollback sunt planuri approval/confirmation/precondition-bound fără
execute endpoint. Raportul leagă checksum/timing/test/approval hashes, iar
asistentul Xen identifică xm/xl/Xend și ghidează mutarea spre XAPI/XCP-ng.

**Status implementare V0.2b / V1.5b / V1.7b / v8.75.0:** B011, B012,
B016, B017, B019, B020 și B023 livrează evenimente deduplicate, delta sync cu
cursor strict, colecții cu selectori siguri, metadata typed/versioned, graf de
relații, hygiene advisory și bugete adaptive per endpoint. B034, B036 și B038
adaugă planuri linked-clone, profile guest immutable cu secret references și
mapping de offerings. B039 agregă imagini după digest/provenance, iar B040
păstrează resumable chunk/checksum receipts și planul de conversie; nu stochează
bytes și nu pornește clone, cleanup, upload, import sau provider mutation.

**Status implementare V1.6b / V2.2b / v8.76.0:** B041–B044 livrează
replication plans cu progress/checksum, template semver immutable, promovare
dev→test→prod și lease-uri VM cu owner notification/extensions. B047 acceptă
shutdown/reboot sau script ref+digest numai prin agent oficial healthy, iar
B049 completează profilul noVNC/WebMKS/serial cu SPICE native handoff și audit.

**Status implementare V2.1c / working tree 2026-07-30:** B045 are local un
scheduler VM durabil pentru start/guest shutdown/reboot/snapshot, cron în fus
orar IANA, politici DST first/second/skip, holiday și blackout suppression,
deduplicare per slot, child idempotency, reconciliere `unknown`, auto-disable,
API/UI/RBAC/audit și job leader-only. Browser smoke, canary pe provideri reali și
includerea într-un release rămân restante, deci feature-ul este `Partial`.
B053–B055 leagă live/cold/storage controls de executorul durabil vm.migrate
existent; B056–B061 adaugă cross-pool/provider evidence, bandwidth windows,
weighted fair queue, native-state cancel/force-complete și rollback pe stadii.

**Status implementare V2.3–V2.6 / V4.1 / v8.77.0:** B064–B065 sunt
orchestrarea durabilă de evacuare în waves și politica explicită pentru
workload-uri nemigrabile. B068 și B070–B073 reutilizează schimbări HA/affinity
cu preflight, approval, diff, rollback și rebalance auto-pause; B074 păstrează
simulări conservative de pierdere a hosturilor. B075 adaugă un recovery DAG
cu waves topologice, start-order Xen și timpi numai când există evidence;
ciclurile sau dependențele nerezolvate blochează planul. B077–B081 sunt
lifecycle-ul de volume capability-gated: create/attach, detach-retain,
owned-volume delete guard, grow-only și datastore move cu revalidare.

### R. Reliability, testare și control operațional (B426–B450)

| ID | Feature candidat | Descriere scurtă | Val. | Ef. | Oriz. |
|---|---|---|---|---|---|
| B426 | Operation risk classifier | Read/low/medium/high/critical după blast radius. | Gov | M | Done |
| B427 | Policy-driven confirmation | Confirm/typed/MFA/approval după risk și environment. | Sig | M | Done |
| B428 | Read-only global mode | Blochează toate mutations inclusiv automation/plugins. | Sig | S | Done |
| B429 | Provider emergency stop | Oprește noi mutations și încearcă cancel safe. | Rez | M | Done |
| B430 | Maintenance freeze calendar | Windows globale/site/app și emergency override. | Gov | M | Done |
| B431 | Operation timeout policy | Per provider/action/phase cu safe terminal states. | Rez | M | Done |
| B432 | Retry policy catalog | Transient-only, jitter, caps și idempotency requirements. | Rez | M | Done |
| B433 | Reconciliation after unknown result | Read-after-timeout pentru a decide success/failure/unknown. | Rez | L | Done |
| B434 | Unknown-state operator workflow | Evidence, retry guard și manual resolution. | Rez | M | Done |
| B435 | Audit correlation ID | Request→job→provider task→event→notification chain. | Gov | M | Done |
| B436 | Tamper-evident job evidence | Hashes pentru plan/input/output/status transitions. | Gov | L | Done |
| B437 | Disaster recovery for Docker Dash | DB/config/secrets/keys/runbook și tested restore. | Rez | L | Done |
| B438 | HA leader-safe scheduler | Exactly-once-ish leases și failover recovery. | Rez | L | Done |
| B439 | Chaos test provider fakes | Timeout, partial response, session expiry, redirect, task loss. | Rez | L | Done |
| B440 | Contract test corpus | Official/sanitized fixtures across versions/editions. | DX | L | Done |
| B441 | Live endpoint certification suite | Read-only probes plus opt-in disposable mutation tests. | Gov | L | Done |
| B442 | Canary operation mode | Apply to small cohort și health gate. | Rez | M | Done |
| B443 | Wave rollout for infrastructure changes | Fixed/exponential waves cu pause/rollback. | Rez | L | Done |
| B444 | Automatic post-action verification | State, metrics, events și guest health assertions. | Rez | L | Done |
| B445 | SLO for control-plane operations | Success/latency/unknown-state budgets per provider. | Gov | M | Done |
| B446 | Data retention controls | Metrics/events/audit/jobs/consoles per policy. | Gov | M | Done |
| B447 | Backup/export portability | Open JSON/YAML formats și documented encryption envelope. | Gov | L | Done |
| B448 | Feature-flag/ring delivery | Internal/canary/beta/GA și per-provider rollout. | Rez | M | Done |
| B449 | Deprecation lifecycle | Warning, telemetry, migration path și removal gate. | Gov | M | Done |
| B450 | Product capability scorecard | Shipped/partial/planned/evidence per provider, actualizat automat. | Gov | M | Done |

## 8. Roadmap recomandat

### Valul 0 — fundația de siguranță (0–2 luni)

Obiectivul este să nu mai crească fiecare integrare ca o insulă. Livrabile: B001–B010, B021–B025, B226–B233, B426–B435, capability discovery per endpoint, common task/job și conformance tests. Nicio funcție mutabilă nouă nu ar trebui lansată fără idempotency, lock, audit correlation, unknown-state reconciliation și capability reason.

**Exit criteria:** Proxmox, vSphere și Xen trec același contract read/task/action; UI poate explica precis de ce o acțiune lipsește; testele simulează timeout, auth expiry și task loss.

### Valul 1 — VM operations utile (2–6 luni)

Livrabile: VM detail comun, metrics freshness, safe power/bulk power, create-from-template, clone, cloud-init, image/template inventory, common disk/NIC inventory, console token broker și activity center. Prioritate furnizori: Proxmox, Xen XO/XAPI, vCenter; în paralel, spike read-only Hyper-V și Nutanix.

**Exit criteria:** utilizatorul poate inventaria, diagnostica, porni/opri, clona și provisiona controlat pe cel puțin trei ecosisteme, cu plan și post-validation.

### Valul 2 — maintenance, migration și HA (5–10 luni)

Livrabile: B051–B075, maintenance runbook, evacuation planner, live/cold/storage migration, HA dashboard/readiness și affinity inventory. Mutation pentru HA/affinity vine după cel puțin o versiune read/recommend.

**Exit criteria:** o mentenanță de host poate fi planificată, executată în waves, întreruptă și reluată, iar fiecare VM are rezultat și recovery path.

### Valul 3 — backup/DR verificabil (8–14 luni)

Livrabile: B126–B150, pornind cu inventory/policy/retention și restore drills pentru XO și Proxmox PBS, apoi adaptere enterprise. Snapshot-urile rămân separate conceptual de backup.

**Exit criteria:** RPO/RTO vizibil, backup integrity verificată și cel puțin un restore drill automat pe fiecare policy critică.

### Valul 4 — fabric policy și enterprise controls (12–20 luni)

Livrabile: disk/NIC lifecycle, storage/network policy, posture packs, certificate/advisory lifecycle, projects/quotas, approvals, drift și GitOps VM. Providerii OpenStack/CloudStack devin mai atractivi după apariția tenancy/offerings.

**Exit criteria:** schimbările de fabric au plan/diff/blast radius/approval; project admin nu poate depăși scope sau quota; compliance evidence este exportabilă.

### Valul 5 — convergență, edge și economie operațională (18+ luni)

Livrabile: KubeVirt/OpenShift/Harvester depth, self-service catalog, FinOps, edge/disconnected, acceleratoare, migration factory și AIOps explainable. Automatizarea AI rămâne advisory până există suficientă telemetrie și evaluare.

**Exit criteria:** VM/container/Kubernetes apar în același application view, cost/ownership/compliance sunt consistente, iar edge funcționează degradat și sigur fără conectivitate continuă.

## 9. Quick wins recomandate

| Ordine | Quick win | Feature-uri | De ce acum | Slice demonstrabil |
|---:|---|---|---|---|
| 1 | Capability contract unificat | B001–B003, B024–B025 | Reduce imediat divergence și false promises. | Un endpoint `/capabilities` identic pentru PVE/vSphere/Xen. |
| 2 | VM detail comun | B005–B010, B026 | Refolosește inventory deja prezent. | Hardware/disks/NICs/tasks/events, cu tabs consistente. |
| 3 | Proxmox power + snapshots | B027–B030, B126 | API și UI există deja read-only. | Start/stop/reboot/snapshot cu audit și task progress. |
| 4 | vSphere power + snapshots | B027–B030, B126 | Închide anti-feature-ul explicit din integrarea alpha. | Power/snapshot capability-gated prin vCenter. |
| 5 | Xen migration preflight | B051–B053, B063 | XAPI/XO sunt deja implementate și task-aware. | Target candidates + blockers, apoi live migration. |
| 6 | Unified task activity center | B010, B226–B229, B355 | Operațiile VM sunt asincrone și lungi. | Job persistent legat de task nativ, cancel când suportat. |
| 7 | Backup inventory | B128, B138, B150 | PVE listează backup-uri; XO are API bogat. | Recovery points XO/PBS și verification status. |
| 8 | HA readiness dashboard Xen | B066–B067 | Pool/HA metadata există deja. | Protected VMs, shared SR, failure tolerance și warnings. |
| 9 | Provider certificate dashboard | B160–B161, B264–B265 | Refolosește encrypted config/posture. | Expiry/trust/TLS skip across all endpoints. |
| 10 | Hyper-V read-only spike | B002, B004–B009 | Acoperă lacuna enterprise cea mai mare. | WinRM/PowerShell inventory pe un host și un cluster. |
| 11 | KubeVirt inventory spike | B301–B303 | Extinde providerul Kubernetes existent. | VM/instance/migration/DataVolume read-only. |
| 12 | Idle VM detector | B201–B207, B288 | Extinde cost optimizerul existent. | VM low-use report cu owner și confidence, fără auto-stop. |

## 10. Ce nu recomandăm încă

- un „hypervisor universal” care ascunde toate diferențele; trebuie păstrate extensii vendor și capability reasons;
- implementarea simultană a tuturor celor zece provider-e înaintea unui SDK/conformance kit;
- snapshot prezentat ca backup;
- console proxy direct din browser către hypervisor fără broker/token/audit;
- auto-DR sau auto-DRS înainte de preflight, persistent jobs și post-validation;
- AI care execută mutation din text liber; primele utilizări trebuie să fie explainable triage/recommendation;
- raw `xl`/`xm` extins cu operații fragile doar pentru a bifa paritate; legacy trebuie orientat spre migrare;
- un marketplace cu cod privilegiat in-process înainte de sandbox, signatures și permissions.

## 11. Indicatori de succes

1. procentul endpoint-urilor cu capability discovery validată prin conformance tests;
2. procentul acțiunilor mutabile cu plan, idempotency key, lock și post-validation;
3. rata de operații rămase în `unknown` și timpul până la reconciliere;
4. succesul migration preflight vs succesul migrațiilor reale;
5. timpul mediu pentru host maintenance și procentul workload-urilor evacuate fără downtime;
6. acoperirea backup policy și procentul recovery points testate prin restore drill;
7. reducerea resurselor orphan/idle/oversized fără incidente de auto-remediation;
8. procentul resurselor cu owner, service, environment și cost center;
9. numărul findings provider-specific remediate cu evidence;
10. adopția self-service și timpul request→ready fără escaladarea privilegiilor.

## 12. Registrul surselor oficiale

### VMware / Broadcom

- [VCF 9.1 hands-on capabilities](https://blogs.vmware.com/cloud-foundation/2026/05/12/vcf-9-1-is-available-explore-the-new-features-in-hands-on-labs/)
- [VCF 9.1 private-cloud self-service](https://blogs.vmware.com/cloud-foundation/2026/05/05/accelerate-streamline-and-control-your-self-service-private-cloud-with-vcf-9-1/)
- [VCF 9.1 announcement](https://blogs.vmware.com/cloud-foundation/2026/05/05/announcing-vcf-9-1-modern-private-cloud-built-for-efficiency-and-resilience/)
- [VCF 9.0 operations, lifecycle, certificates și security](https://blogs.vmware.com/cloud-foundation/2026/02/06/why-vcf-9-0-improves-it-operations-and-management/)
- [VCF 9.0 use cases și fleet management](https://blogs.vmware.com/cloud-foundation/2025/06/17/vcf-9-0-use-cases/)
- [vSphere în VCF 9.0](https://blogs.vmware.com/cloud-foundation/2025/06/23/vsphere-in-vcf-9-0-whats-new/)

### Microsoft

- [Azure Local documentation](https://learn.microsoft.com/en-us/azure/azure-local/)
- [Azure Local VM management](https://learn.microsoft.com/en-us/azure/azure-local/manage/azure-arc-vm-management-overview)
- [Azure Local supported VM operations](https://learn.microsoft.com/en-us/azure/azure-local/manage/virtual-machine-operations)
- [Azure Local VM management comparison](https://learn.microsoft.com/en-us/azure/azure-local/concepts/compare-vm-management-capabilities)
- [Hyper-V overview](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/overview)
- [Hyper-V features and terminology](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/features-terminology)
- [Hyper-V Replica](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/replication-overview)
- [Hyper-V generation 2 security](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/generation-2-virtual-machine-security-features)
- [Azure Local GPU preparation](https://learn.microsoft.com/en-us/azure/azure-local/manage/gpu-preparation)
- [Network ATC](https://learn.microsoft.com/en-us/azure/azure-local/concepts/network-atc-overview)

### Nutanix

- [Nutanix Cloud Platform](https://www.nutanix.com/products/cloud-platform)
- [AHV](https://www.nutanix.com/products/ahv)
- [Flow networking/security](https://www.nutanix.com/products/flow)
- [Flow Network Security](https://www.nutanix.com/products/flow-network-security)
- [Nutanix Disaster Recovery](https://www.nutanix.com/products/nutanix-cloud-infrastructure/disaster-recovery)
- [NCM Self-Service](https://www.nutanix.com/products/cloud-manager/self-service)
- [NCM Cost Governance](https://www.nutanix.com/library/datasheets/nutanix-cloud-manager-cost-governance)

### Proxmox

- [Proxmox VE features](https://www.proxmox.com/en/products/proxmox-virtual-environment/features)
- [Proxmox VE overview](https://www.proxmox.com/en/products/proxmox-virtual-environment/overview)
- [Proxmox VE 9.2 downloads/datasheet](https://www.proxmox.com/en/downloads/proxmox-virtual-environment/)
- [Proxmox VE Admin Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf)
- [Migration to Proxmox VE](https://pve.proxmox.com/wiki/Migrate_to_Proxmox_VE)

### OpenStack

- [OpenStack 2026.1 documentation](https://docs.openstack.org/2026.1/)
- [OpenStack service catalog/docs](https://docs.openstack.org/2025.2/install/)
- [Nova compute](https://docs.openstack.org/nova/2026.1/)
- [Nova admin guide](https://docs.openstack.org/nova/2025.2/admin/)
- [Nova Cells v2](https://docs.openstack.org/nova/2026.1/admin/cells.html)
- [Nova live migration](https://docs.openstack.org/nova/latest/admin/configuring-migrations.html)
- [Cinder block storage](https://docs.openstack.org/cinder/2025.2/)
- [Neutron networking](https://docs.openstack.org/neutron/2026.1/)
- [Horizon dashboard](https://docs.openstack.org/horizon/2026.1/)

### Red Hat OpenShift Virtualization

- [OpenShift Virtualization overview](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/virtualization/about)
- [OpenShift Virtualization full guide](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html-single/virtualization/)
- [VM backup and restore](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/virtualization/backup-and-restore)

### XCP-ng / Xen Orchestra

- [XCP-ng API guidance](https://docs.xcp-ng.org/management/manage-locally/api/)
- [XCP-ng HA](https://docs.xcp-ng.org/management/ha/)
- [XCP-ng updates](https://docs.xcp-ng.org/management/updates/)
- [XCP-ng CLI reference](https://docs.xcp-ng.org/appendix/cli_reference/)
- [XCP-ng VM/host limits](https://docs.xcp-ng.org/installation/requirements/)
- [XCP-ng migration guidance](https://docs.xcp-ng.org/installation/migrate-to-xcp-ng/)
- [Xen Orchestra REST API](https://docs.xen-orchestra.com/restapi/)
- [XO backup concepts](https://docs.xen-orchestra.com/backups)
- [XO incremental backups](https://docs.xen-orchestra.com/incremental_backups)
- [XO distributed backups](https://docs.xen-orchestra.com/distributed_backups)
- [XO immutability](https://docs.xen-orchestra.com/xo5/immutability)
- [XO users/self-service](https://docs.xen-orchestra.com/xo5/users)
- [XO ACL v2](https://docs.xen-orchestra.com/xo6/acl-v2)

### Apache CloudStack

- [CloudStack feature catalog](https://cloudstack.apache.org/features/)
- [CloudStack 4.21 highlights](https://docs.cloudstack.apache.org/en/4.21.0.0/releasenotes/about.html)
- [CloudStack Admin Guide](https://docs.cloudstack.apache.org/en/latest/adminguide/)
- [CloudStack roles/accounts/domains](https://docs.cloudstack.apache.org/en/latest/adminguide/accounts.html)
- [CloudStack projects](https://docs.cloudstack.apache.org/en/latest/adminguide/projects.html)
- [CloudStack usage](https://docs.cloudstack.apache.org/en/latest/adminguide/usage.html)
- [CloudStack storage](https://docs.cloudstack.apache.org/en/latest/adminguide/storage.html)
- [CloudStack instances](https://docs.cloudstack.apache.org/en/latest/adminguide/virtual_machines.html)

### XenServer

- [XenServer 9 technical overview](https://docs.xenserver.com/en-us/xenserver/9/technical-overview)
- [XenServer migration](https://docs.xenserver.com/en-us/xenserver/9/vms/migrate.html)
- [XenServer HA](https://docs.xenserver.com/en-us/xenserver/9/high-availability)
- [XenServer graphics/vGPU](https://docs.xenserver.com/en-us/xenserver/9/graphics)
- [XenServer 9 what’s new](https://docs.xenserver.com/en-us/xenserver/9/whats-new)
- [XenServer XAPI wire protocol](https://docs.xenserver.com/en-us/xenserver/developer/xenserver-9/management-api/wire-protocol.html)
- [XenServer CLI](https://docs.xenserver.com/en-us/xenserver/9/command-line-interface)
- [XenServer RBAC](https://docs.xenserver.com/en-us/xenserver/9/users/rbac-roles-permissions.html)

### SUSE Harvester

- [Harvester 1.7 overview](https://docs.harvesterhci.io/v1.7/)
- [Harvester API](https://docs.harvesterhci.io/v1.7/category/api/)
- [Harvester VM backup/snapshot/restore](https://docs.harvesterhci.io/v1.7/vm/backup-restore)
- [Harvester requirements și HA](https://docs.harvesterhci.io/v1.7/install/requirements/)
- [Harvester host maintenance](https://docs.harvesterhci.io/v1.7/host/)
- [Harvester upgrades](https://docs.harvesterhci.io/v1.7/upgrade/index/)

## 13. Verificare și întreținere

Inventarul comparativ este intenționat limitat la **225** capabilități distincte (`C001`–`C225`). Catalogul candidat este intenționat limitat la **450** itemi deduplicați (`B001`–`B450`), grupați în 18 categorii egale. La actualizări ulterioare trebuie păstrate ID-urile; un feature schimbat semantic primește ID nou, iar cel vechi este marcat deprecated pentru trasabilitate.

Feature-urile vendor sunt snapshot la data cercetării. Înaintea implementării fiecărei integrări trebuie reverificate versiunea curentă, edition/licensing, API contract, backend-ul de storage/network și support matrix. Pentru OpenStack/OpenShift/Harvester trebuie testate distribuția și operatorii reali; pentru VMware/Microsoft/Nutanix trebuie verificat bundle-ul licențiat; pentru Xen trebuie păstrat modelul de capability negotiation deja început.
