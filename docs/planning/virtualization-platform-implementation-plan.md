# Plan de implementare: control plane unificat pentru virtualizare

**Statut:** activ  
**Data inițială:** 26 iulie 2026  
**Sursa backlog:** [Market research 2026](../research/virtualization-market-research-2026.md)  
**Inventar sursă:** 225 capabilități comparative (`C001–C225`) și 450 feature-uri candidate (`B001–B450`)  
**Principiu:** fiecare batch este vertical, testabil, publicat în Git și instalat într-un mediu real înainte de următorul batch.

## 1. Obiectiv

Docker Dash va evolua dintr-un dashboard centrat pe Docker într-un control plane vendor-neutral pentru containere, VM-uri și infrastructură hibridă. Produsul nu va ascunde diferențele importante dintre provideri. Va oferi un contract comun pentru inventar, capabilități, operații, task-uri și evenimente, plus extensii explicite pentru funcțiile vendor-specific.

Rezultatul urmărit este:

1. aceeași experiență de bază pentru Proxmox, vSphere și Xen;
2. integrarea progresivă Hyper-V/Azure Local, Nutanix, OpenStack, CloudStack și KubeVirt/Harvester;
3. operații mutabile sigure: plan, confirmare, lock, audit, task persistent, reconciliere și post-validare;
4. provisioning, console, migrare, mentenanță, HA, backup/DR și policy;
5. self-service, cost, capacity, edge și convergență VM–container după stabilizarea fundației.

## 2. Reguli de produs și arhitectură

- Capability discovery se face per endpoint, versiune, ediție și backend; nu se presupune paritate pe baza numelui vendorului.
- UUID-ul canonic este expus public; referințele native opace rămân interne.
- Orice mutation primește `operationId`, idempotency key, resource lock, audit correlation și rezultat reconciliabil.
- Snapshot-ul nu este prezentat ca backup.
- `raw xl/xm` rămâne o integrare deliberat limitată; nu extindem legacy cu operații fragile.
- Funcțiile noi pornesc admin-only și capability-gated; delegated operations vin după conformance și audit.
- API-ul comun este versionat și aditiv. Extensiile vendor nu modifică semantic câmpurile comune.
- O eroare de transport după trimiterea comenzii produce `unknown`, nu `failed`, până la reconciliere.
- Nicio operație bulk nu rulează fără blast-radius preview, limită de concurență și stop condition.
- Feature flags separă `internal`, `canary`, `beta` și `GA`.

## 3. Definition of Ready

Un batch poate intra în implementare doar dacă are:

- scope și anti-scope explicite;
- API/schema și schimbări de DB definite;
- matrice RBAC și audit events;
- failure modes și stări intermediare;
- compatibilitate/upgrade/rollback descrise;
- teste unitare, route și contract planificate;
- endpoint real sau fixture reprezentativ pentru providerii afectați;
- feature flag și strategie de observabilitate;
- checklist de deploy și smoke-test.

## 4. Definition of Done pentru fiecare batch

1. codul, migrarea și documentația sunt complete;
2. lint, syntax checks, testele țintite și suita completă sunt verzi;
3. `git diff --check` este curat;
4. feature-ul este dezactivabil sau backward-compatible;
5. commit-ul conține numai scope-ul batch-ului;
6. branch-ul este împins pe GitHub și PR-ul curent este actualizat;
7. imaginea este construită pe mediul țintă cu tag bazat pe commit;
8. deploy-ul păstrează volumele și configurația;
9. health, login, pagina afectată și endpoint-urile batch-ului trec smoke-testul;
10. commitul/imaginea anterioară rămâne disponibilă pentru rollback;
11. rezultatul deploy-ului este înregistrat în jurnalul de progres al planului.

## 5. Release loop obligatoriu

Pentru fiecare batch:

```text
feature/deep spec
  → implementation + migration
  → targeted tests
  → full tests + lint
  → commit
  → push branch / update PR
  → remote build tagged <version>-<short-sha>
  → compose up --no-deps app
  → health + API + UI smoke
  → keep or rollback
```

Deploy-ul nu va dezactiva verificarea cheii SSH. O schimbare de host fingerprint blochează acel mediu până la verificare out-of-band.

## 6. Ordinea de implementare

### Valul 0 — baseline și publicarea cercetării

| Batch | Scope | Backlog | Criteriu principal |
|---|---|---|---|
| V0.0 | Integrarea Xen XO/XAPI/raw, research, acest plan | baseline | Xen inventory/actions/snapshots/tasks + documentație și teste |
| V0.1 | Provider SDK v2 și capability contract | B001–B003, B024–B025, B426–B435 | Proxmox, vSphere și Xen emit același envelope versionat |
| V0.2 | Resource identity și modele comune | B004–B010 | VM/host/cluster/storage/network/task au ID și schema stabile |
| V0.3 | Operation/job core persistent | B226–B229, B355, B428–B434 | operațiile supraviețuiesc restartului și se reconciliază |
| V0.3b | Infrastructure automation foundations | B226–B235 | core-ul persistent este reutilizat de manifests, plans, DAG și compensation; apply provider rămâne separat |
| V0.3c | Infrastructure delivery și GitOps safeguards | B236–B245 | ownership/deletion gates, import/drift/reconcile, PR/Terraform/Ansible și webhook HMAC |
| V0.3d | Automation operations și lifecycle readiness | B246–B255 | calendar/approval/dry-run/secret/template controls plus version/support/update/precheck evidence |
| V0.3e | Lifecycle maintenance și compatibility operations | B256–B265 | maintenance waves, staged durable-operation campaigns, live patch/reboot evidence, firmware/driver matrix și certificate reminders |
| V0.3f | Lifecycle assurance, content și support | B266–B275 | certificate renewal adapters, license assurance, redacted config drift/profile, signed mirrors, support bundles și validation packs |
| V0.4 | Provider conformance kit | B018, B022–B025, B436–B450 | fixtures, fault injection și scorecard automat per provider |

**Exit:** niciun provider nou și nicio mutation nouă nu mai introduc contracte ad-hoc.

### Valul 1 — paritate VM utilă pe providerii existenți

| Batch | Scope | Backlog | Provideri inițiali |
|---|---|---|---|
| V1.1 | VM detail shell comun | B005, B026, B351–B356 | Proxmox, vSphere, Xen |
| V1.2 | Power operations sigure | B027–B031, B436–B444 | Proxmox, vSphere, Xen |
| V1.3 | Snapshot lifecycle comun | B126–B127, B132, B138 | Proxmox, vSphere, Xen |
| V1.4 | Activity center și native task bridge | B010, B226–B229, B355 | toate operațiile asincrone |
| V1.5 | Template/image inventory | B034–B039 | Proxmox, vSphere, XO |
| V1.6 | Clone și create-from-template | B032–B043 | Proxmox, vSphere, XO/XAPI |
| V1.7 | Cloud-init/guest customization | B035 structured subset; B036 foundation; C028/C029 | Proxmox, vSphere, Xen |
| V1.8 | Console gateway | B048–B050 | noVNC/RFB, WebMKS și serial, token scurt, credential isolation și audit |
| V1.9 | Disk și NIC inventory uniform | B076, B085–B086 (read model), B101 | detail live, topology și hot-plug capability evidence; mutațiile rămân în V4.1/V4.3 |

**Exit:** cel puțin trei ecosisteme permit inspectare, power, snapshot, clone și provisioning controlat.

### Valul 2 — migration, maintenance, placement și HA

| Batch | Scope | Backlog | Rezultat |
|---|---|---|---|
| V2.1 | Migration compatibility/preflight | B051–B056 | target candidates, blockers, estimated downtime |
| V2.2 | Live/cold/storage migration | B053–B061 | job persistent, progress, cancel și reconcile |
| V2.3 | Host maintenance orchestration | B062–B065 | drain/evacuate în waves, resume și post-check |
| V2.4 | HA inventory și readiness | B066–B067, B074–B075 | quorum, protected VMs, shared storage, admission warnings |
| V2.5 | Affinity și placement recommendations | B069, B071–B072, B201–B225 | read/recommend înainte de mutation |
| V2.6 | Placement/HA mutation | B068, B070, B073 | approval, diff și rollback semantic |

**Exit:** mentenanța unui host este repetabilă, observabilă și poate fi reluată fără pierderea stării.

### Valul 3 — backup și disaster recovery verificabil

| Batch | Scope | Backlog | Rezultat |
|---|---|---|---|
| V3.1 | Recovery point inventory | B128–B138 | XO și Proxmox PBS mai întâi |
| V3.2 | Backup policy și retention | B126–B142 | schedule, scope, GFS, encryption, immutability metadata |
| V3.3 | Backup execution și verification | B129–B145 | progress, checksum/health, alerting |
| V3.4 | File/disk/VM restore | B133–B147 | plan, target selection, conflict handling |
| V3.5 | Automated restore drill | B141–B150 | isolated restore, assertions și evidence |
| V3.6 | Replication/DR runbooks | B146–B150 | RPO/RTO, failover/failback și dependency order |

**Exit:** fiecare policy critică are recovery point verificat și restore drill măsurabil.

### Valul 4 — storage, network și security fabric

| Batch | Scope | Backlog | Rezultat |
|---|---|---|---|
| V4.1 | Volume lifecycle | B076–B090 | create/resize/attach/detach/move cu safety gates |
| V4.2 | Storage health/policy/QoS | B091–B100 | policy compliance, multipath și capacity; V4.2a a livrat baseline-ul read-only, V4.2b B091 vSphere consolidation strict-gated, V4.2c corelează backing-uri shared, V4.2d oferă advisory de plasare, iar V4.2e evaluează policy compliance fără a persista sau aplica politica |
| V4.3 | NIC/network/VLAN lifecycle | B101–B113 | intent + diff, fără lockout accidental; V4.3a–e oferă posture, policy, topologie, placement și baseline drift numai read-only, fără trafic sau mutații |
| V4.4 | IPAM, SG/firewall și microsegmentation | B114–B125 | staged policy și connectivity verification |
| V4.5 | Provider security posture packs | B151–B175 | TLS/certs, advisories, hardening, evidence |
| V4.6 | Projects, quotas și approvals | B176–B200 | V4.6a a livrat B176–B185; V4.6b B186–B195; V4.6c închide B196–B200 cu leases, ownership completeness, SoD, access reviews și offboarding controlat și livrează fundația de metrici B201–B205 |

**Exit:** orice schimbare de fabric are plan, blast radius, approval și post-validation.

### Valul 5 — provideri noi și convergență

| Batch | Scope | Backlog | Ordine |
|---|---|---|---|
| V5.1 | Hyper-V read-only | B001–B010, B401–B425 | WinRM/PowerShell + cluster inventory |
| V5.2 | Hyper-V/Azure Local lifecycle | B026–B075 | local și ARM/Arc capability-separated |
| V5.3 | Nutanix Prism Central | B001–B075 | tasks, categories și AHV lifecycle |
| V5.4 | OpenStack provider | B001–B150, B176–B200 | Keystone catalog + Nova/Cinder/Neutron/Glance |
| V5.5 | CloudStack provider | B001–B150, B176–B200 | zones, offerings, projects, async jobs |
| V5.6 | KubeVirt/OpenShift Virtualization | B301–B316 | V5.6a livrează B301–B305: discovery, VM/VMI/migration inventory, OpenShift/Harvester evidence și YAML server dry-run; B306–B316 rămân planificate |
| V5.7 | Harvester depth | B301–B325 | Longhorn, networks, images, backup și migrations |
| V5.8 | Provider plugin SDK | B401–B425 | signed manifest, permissions, sandbox și test kit |

**Exit:** providerii se adaugă prin contract și conformance, fără schimbări structurale în nucleu.

### Valul 6 — self-service, edge și economie operațională

| Batch | Scope | Backlog | Rezultat |
|---|---|---|---|
| V6.1 | Unified application view | B301–B325, B351–B375 | VM+container+Kubernetes într-o singură aplicație |
| V6.2 | Service catalog și request workflow | B351–B375 | templates, approvals, quotas și expiration |
| V6.3 | FinOps/showback/capacity | B276–B300 | Complet: V6.3a cost foundation, V6.3b optimization/capacity și V6.3c energy, carbon și TCO |
| V6.4 | Observability/events/AIOps advisory | B206–B225 | Complet: V6.4a livrează charts/events/correlation, iar V6.4b baseline, suppression, forecast, triage/runbooks, exports, SLO și privacy controls |
| V6.5 | Edge/disconnected/sovereign | B326–B350 | local cache, queued ops și reconciliation |
| V6.6 | Accelerators/performance | B376–B400 | GPU/vGPU/SR-IOV/NUMA/hugepages capability-driven |
| V6.7 | Migration factory | B401–B425 | discovery, waves, conversion, validation și evidence |

**Exit:** control plane-ul poate opera coerent workload-uri mixte în datacenter, edge și cloud hibrid.

## 7. Prioritatea concretă pentru primele 12 batch-uri

1. V0.0 — publicarea baseline-ului Xen și research.
2. V0.1 — Provider SDK/capability contract.
3. V0.2 — resource model și IDs.
4. V0.3 — durable operation engine.
5. V0.4 — conformance kit.
6. V1.1 — common VM detail.
7. V1.2 — Proxmox/vSphere/Xen safe power.
8. V1.3 — common snapshots.
9. V1.4 — activity center.
10. V1.5 — templates/images.
11. V1.6 — clone/create.
12. V1.7 — Linux guest customization; corectează maparea eronată B040–B047 la B035/C028/C029.

V1.8 — console gateway urmează după finalizarea și deploy-ul V1.7. ID-urile B040–B047 rămân neschimbate și sunt implementate în batch-urile lor reale de image lifecycle, schedules și guest-agent. B162–B164 aparțin unui batch ulterior de certificate și security posture, nu consolei.

Ordinea se poate schimba numai pe bază de preflight sau feedback din endpoint-uri reale. ID-urile backlog nu se renumerotează.

## 8. Strategie de testare

### Unit și contract

- schema validation pentru capability/resource/operation envelopes;
- contract fixtures pentru fiecare versiune de provider;
- state-machine tests pentru task-uri și stări `unknown`;
- permission/audit matrix pentru fiecare mutation;
- serialization compatibility între versiuni de schema.

### Integration

- mock HTTP/SSH/SOAP/XML-RPC cu timeout, răspuns mare, auth expiry și redirect master;
- DB migration pe snapshot de schemă veche;
- route tests cu host scope și read-only mode;
- provider sandbox cu operații idempotente și cleanup.

### Endpoint real

- read-only inventory înainte de mutation;
- resursă disposable cu nume prefixat `dd-preflight-*`;
- snapshot/clone/migrate/restore numai în pool-ul de test;
- host maintenance doar după verificarea capacity/HA;
- cleanup explicit și evidence în preflight results.

### UI și accessibility

- empty/loading/error/partial-capability/unknown-state;
- keyboard/focus/ARIA pentru dialogs și destructive confirmations;
- browser smoke pentru route, resource switch și action progress;
- screenshot comparison pentru paginile comune.

## 9. Deploy, smoke și rollback

### Pre-deploy

- confirmarea host key SSH;
- disk space și Docker daemon health;
- backup DB/config și inspectarea migrărilor pending;
- capturarea imaginii și commitului curent;
- verificarea health endpoint înainte de schimbare.

### Deploy

- fetch branch-ul publicat;
- build imagine cu tag bazat pe versiune și short SHA;
- `docker compose up -d --no-deps app` pentru a păstra serviciile auxiliare;
- așteptare healthcheck, fără sleep fix lung;
- verificare loguri pentru migration errors și restart loop.

### Smoke minim

- `/api/health` și versiunea/commitul;
- login și CSRF;
- host inventory;
- pagina/endpoint-ul modificat de batch;
- un read operation real;
- mutation doar dacă preflight-ul definește resursă disposable;
- audit record și operation result.

### Rollback

- redeploy imaginea precedentă;
- nu restaura DB automat dacă migrarea este forward-compatible;
- pentru migrare incompatibilă, deploy-ul cere backup verificat și procedură dedicată;
- reconcilierea operațiilor `running/unknown` înainte de rollback;
- documentarea motivului și păstrarea logurilor.

## 10. Riscuri majore

| Risc | Control |
|---|---|
| False feature parity | capability reasons și conformance per endpoint |
| Task nativ pierdut după restart | operation store + provider reconciliation |
| Dublă executare | idempotency key + resource lock |
| Host/network lockout | plan, connectivity guard și staged apply |
| DB schema înaintea codului vechi | migrare aditivă și backward-readable |
| Secret leakage | encrypted config, redaction și bounded error payload |
| API/vendor drift | version probes, fixtures și compatibility matrix |
| Bulk blast radius | preview, cohort, concurrency cap și stop condition |
| Snapshot confundat cu backup | modele și UI separate |
| Deploy pe host neconfirmat | strict host-key checking; blocare la mismatch |

## 11. Metrici de progres

- provideri care trec Provider SDK conformance;
- procent capabilități cu evidence live și reason;
- mutations cu idempotency/lock/audit/post-validation;
- operații rămase `unknown` și timpul de reconciliere;
- acoperire teste contract per provider/version;
- succes deploy și rollback time per batch;
- VM-uri cu owner/service/environment/cost metadata;
- recovery points verificate și restore drills reușite;
- timpul pentru maintenance/migration workflows;
- findings security remediate cu evidence.

## 12. Jurnal de execuție

| Batch | Commit | Git/PR | Staging | VPS | Rezultat |
|---|---|---|---|---|---|
| V0.0 | `2e21d3c` | push + PR #13 | `8.21.4-2e21d3c`, healthy | blocat: host key mismatch | Xen + research + plan |
| V0.1 | `8ad9d04` | push + PR #13 | `8.21.4-8ad9d04`, healthy; ESXi live probe | blocat: host key mismatch | Provider SDK v2, schema 1.0, 29 capabilities |
| V0.2 | `5c7f246` | push + PR #13 | `8.21.4-5c7f246`, healthy; ESXi live inventory | blocat: host key mismatch | resource schema 1.0, identity encryption, 6 common kinds |
| V0.3 | `3a327d1` | push + PR #13 | `8.21.4-3a327d1`, healthy; durable-operation smoke | blocat: host key mismatch | operation schema 1.0, leases, locks, reconcile și policies |
| V0.4 | `b795b9a` | push + PR #13; CI/build verde | `8.21.4-b795b9a`, healthy; ESXi conformance 187/187 | blocat: host key mismatch | manifests, fixtures/faults, circuit budget, persistent certification și scorecard |
| V1.1 | `549ba98` | push + PR #13; CI/build verde | `8.21.4-549ba98`, healthy; ESXi 5 VM common detail/cache/search | blocat: host key mismatch | unified VM inventory/detail, action blockers, command search și Activity Center |
| V1.2 | `b593c59` | push + PR #13; CI/build verde | `8.21.4-b593c59`, healthy; ESXi 5 VM live read-only preflight | blocat: host key mismatch | safe single/bulk power, typed force, native tasks, no-replay reconciliation și post-state verification |
| V1.3.1 | `c245c46` | push + PR #13; CI/build verde | `8.21.4-c245c46`, healthy; ESXi snapshot inventory/preflight read-only | blocat: host key mismatch | common snapshot list/create/revert/delete, opaque identity, graph/count/depth guards, quiesce evidence și no-replay reconciliation |
| V1.3.2 | `bbb5784` | push + PR #13; CI/build verde | `8.21.4-bbb5784`, healthy; ESXi live policy preview read-only | blocat: host key mismatch | persistent UTC policies, dry-run, managed-prefix leaf retention, durable child orchestration și restart recovery |
| V1.4 | `0265a54` | push + PR #13; CI/build verde | `8.21.4-0265a54`, healthy; live Activity projection read-only | blocat: host key mismatch | owner/permissions, native state, search/timing, safe cancel request și evidence-based unknown resolution |
| V1.5 | `0d88227` | push + PR #13; CI/build verde | `8.21.4-0d88227`, healthy; ESXi 11-artifact catalog, repeatability 12/12 | blocat: host key mismatch | opaque/encrypted template+image catalog, Proxmox/vSphere/XO/XAPI adapters, VM Catalog UI și WAL-safe persistence |
| V1.6 | `140494f` | push + PR #13; CI/build verde | `8.21.4-140494f`, healthy; mutation-disabled smoke | blocat: host key mismatch | clone/create-from-template durabil pentru Proxmox, vSphere și XAPI, XO/raw Xen capability-blocked, wizard VM Catalog |
| V1.7 | `8215774` | push + PR #13; CI/build verde | `8.21.4-8215774`, healthy; flags OFF, customization smoke | blocat: host key mismatch | Linux guest customization structurat pentru Proxmox/vSphere/XO, XAPI/raw fail-closed, recovery și UI |
| V1.8 | `f7fde38` | push + PR #13; CI/build verde | `8.21.4-f7fde38`, healthy; WebSocket/noVNC smoke | blocat: host key mismatch | gateway de consolă VM protejat, ticket unic, broker RFB și rutare WebSocket dedicată |
| V1.9 | `d6e0192` | push + PR #13; CI/build verde | `8.21.4-d6e0192`, healthy; ESXi device inventory live | blocat: host key mismatch | inventar uniform disk/NIC pentru Proxmox, vSphere și Xen, cu capabilități tri-state |
| V2.1 | `6e132e9` | push + PR #13; CI/build verde | `8.21.4-6e132e9`, healthy; ESXi preflight read-only | blocat: host key mismatch | preflight de migrare multi-target, moduri live/cold/storage, capacity și compatibility evidence |
| V2.2 | `da93c09` | push + PR #13; CI/build verde | `8.21.4-da93c09`, healthy; migrare activată, fără mutation smoke | blocat: host key mismatch | migrare VM nativă durabilă pentru Proxmox, vSphere și XAPI, XO discovery-gated |
| V2.3 | `547ae12` | push + PR #13; CI/build verde | `8.21.4-547ae12`, healthy; ESXi maintenance preflight fail-closed | blocat: host key mismatch | drain/maintenance orchestration, waves, reservations, pause/resume/cancel/exit și native vSphere/XAPI |
| V2.4 | `e3da04b` | push + PR #13; CI/build verde | `8.21.4-e3da04b`, healthy; 2 endpoint-uri ESXi HA `unsupported` fail-closed | blocat: host key mismatch | HA readiness, encrypted history, host-loss simulation și recovery-priority evidence pentru Proxmox/vSphere/Xen |
| V2.5 | `ea1a203` | push + PR #13; CI/build verde | `8.21.4-ea1a203`, healthy; ESXi affinity `unsupported`, recommendation și dry-run fail-closed | blocat: host key mismatch | affinity/anti-affinity Proxmox 9+/vCenter/Xen, telemetry bounded, scoring explicabil și rebalance strict non-executable |
| V2.6 | `1b25b7c` | push + PR #13; CI/build verde | `8.21.4-1b25b7c`, healthy; flags OFF, ESXi mutation capabilities `unsupported` fail-closed | blocat: host key mismatch | four-eyes HA/affinity CRUD, durable rebalance waves, auto-pause, post-read verification și semantic rollback planning |
| V3.1 | `3cf80eb` | push + PR #13; CI/build verde | `8.21.4-3cf80eb`, healthy; flag ON, migrarea 117, ESXi backup inventory `unsupported` fail-closed | blocat: host key mismatch | inventar comun de repositories/recovery points pentru PVE/PBS și XO, identități criptate, evidence tri-state și UI read-only |
| V3.2 | `ec31675` | push + PR #13; CI/build verde | `8.21.4-ec31675`, healthy; flag ON, migrarea 118, policy list 200 și ESXi preflight `unsupported` fail-closed | blocat: host key mismatch | policies plan-only, scope dinamic, schedule IANA, GFS preview, encryption/immutability tri-state și due-slot evidence |
| V3.3 | `c99a314` | push + PR #13; CI `30222882876` și build `30222882860` verzi | `8.21.4-c99a314`, healthy, 0 restarturi; flag ON, migrarea `119_provider_backup_execution.js`, API autentificat și backup SQLite verificate | blocat: cheia prezentată `SHA256:tqbf5X...` diferă de cheia fixată `SHA256:pwHZ3Y...` | execuție backup Proxmox durabilă, idempotency, UPID, discovery recovery point, verificare separată și retention mutation permanent blocată |
| V3.4 | `75c1fe2` (`da62ceb` test fix) | push + PR #13; CI `30224432844` și build `30224432842` verzi | `8.21.4-75c1fe2`, healthy, 0 restarturi; restore flag ON, API/RBAC autentificat și backup SQLite verificate | blocat: cheia prezentată `SHA256:tqbf5X...` diferă de cheia fixată `SHA256:pwHZ3Y...` | restore PVE create-only durabil, target nou și oprit, override verificare strict, no-replay, UPID/cancel și partial-target evidence fără auto-delete |
| V3.5 | `926e6d1` | push + PR #13; CI `30225972140` și build `30225972133` verzi | `8.21.4-926e6d1`, healthy, 0 restarturi; drill flag ON, migrarea 120, API/RBAC autentificat și backup SQLite verificate | blocat: cheia prezentată `SHA256:tqbf5X...` diferă de cheia fixată `SHA256:pwHZ3Y...` | restore drill PVE izolat, assertions boot/agent, RPO/RTO, evidence hash, scheduling și cleanup strict ownership-gated |
| V3.6 | `eb26679` | push + PR #13; CI `30227581320` și build `30227581317` verzi | `8.21.4-eb26679`, healthy, 0 restarturi; DR flag ON, migrarea 121, API/RBAC autentificat și backup SQLite verificate | blocat: cheia prezentată `SHA256:tqbf5X...` diferă de cheia fixată `SHA256:pwHZ3Y...` | protection groups + DAG, replication inventory PVE read-only, RPO/RTO posture, deterministic failover/failback/test plans și rehearsals non-mutante |
| V4.1 | `c2a2a6b` | push + tag `v8.22.0` | LAN `192.168.13.20` și VPS healthy, ambele `8.22.0-c2a2a6b`; migrarea 122 verificată | Docker Desktop indisponibil local | lifecycle sigur de volume pentru disk: create/attach, detach retain, grow, move și ownership-bound cleanup; flag-uri de mutație rămân OFF |
| V4.2a | `8b98069` | push + tag `v8.23.0` | LAN `192.168.13.20` healthy, `8.23.0-8b98069`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.23.0-8b98069`; backup SQLite verificat | storage posture read-only: accesibilitate, mentenanță, capacitate/overcommit și coverage explicit pentru policy/QoS/multipath; B091–B100 rămân parțial planificate |
| V4.2b | `97208a0` | push + tag `v8.24.0` | LAN `192.168.13.20` healthy, `8.24.0-97208a0`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.24.0-97208a0`; backup SQLite verificat | B091 vSphere `ConsolidateVMDisks_Task`: evidence runtime, plan hash, typed confirm, durable task și post-read; restul B092–B100 rămân planificate |
| V4.2c | `e4eb3bc` | push + tag `v8.25.0` | LAN `192.168.13.20` healthy, `8.25.0-e4eb3bc`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.25.0-e4eb3bc`; backup SQLite verificat | topologie backing shared read-only: ID-uri opace, confirmare doar cu `shared=true` pe toate atașările observate, acoperire bounded/explicită; fără mutații |
| V4.2d | `f7bdab4` | push + tag `v8.26.0` | LAN `192.168.13.20` healthy, `8.26.0-f7bdab4`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.26.0-f7bdab4`; backup SQLite verificat | advisory read-only de plasare disk: dimensiune bounded, headroom, accesibilitate/maintenance/capacitate și `images` PVE; fără reservation sau mutații |
| V4.2e | `e361c6f` | push + tag `v8.27.0` | LAN `192.168.13.20` healthy, `8.27.0-e361c6f`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.27.0-e361c6f`; backup SQLite verificat | policy compliance read-only: accesibilitate, min-free și shared configurate tranzitoriu, `unknown` fail-closed; fără persistență, reservation sau mutații |
| V4.3a | `32b61f8` | push + tag `v8.28.0` | LAN `192.168.13.20` healthy, `8.28.0-32b61f8`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.28.0-32b61f8`; backup SQLite verificat | Network Posture read-only pentru vSphere/Xen: accesibilitate, managed, bridge, VLAN și MTU; fără test trafic sau mutații |
| V4.3b | `db7e0c0` | push + tag `v8.29.0` | LAN `192.168.13.20` healthy, `8.29.0-db7e0c0`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.29.0-db7e0c0`; backup SQLite verificat | policy advisory read-only: accesibilitate obligatorie, MTU/managed/VLAN opționale, `unknown` fail-closed; fără persistență, trafic sau mutații |
| V4.3c | `609b1e7` | push + tag `v8.30.0` | LAN `192.168.13.20` healthy, `8.30.0-609b1e7`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.30.0-609b1e7`; backup SQLite verificat | topologie VM–network read-only: ID-uri opace, acoperire bounded/explicită; fără trafic, guest query sau mutații |
| V4.3d | `47be911` | push + tag `v8.31.0` | LAN `192.168.13.20` healthy, `8.31.0-47be911`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.31.0-47be911`; backup SQLite verificat | placement advisory read-only: accesibilitate și managed pozitive pentru candidate; `unknown` fail-closed, fără rezervări sau mutații |
| V4.3e | `5a61f6d` | push + tag `v8.32.0` | LAN `192.168.13.20` healthy, `8.32.0-5a61f6d`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.32.0-5a61f6d`; backup SQLite verificat | baseline drift read-only, salvat explicit de host-admin; absent baseline=`unbaselined`, fără reconciliere sau mutații |
| V4.4a | `ea41eaa` | push + tag `v8.33.0` | LAN `192.168.13.20` healthy, `8.33.0-ea41eaa`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.33.0-ea41eaa`; backup SQLite verificat | IP evidence provider-visible, bounded și read-only; fără guest query, probe de rețea sau mutații |
| V4.4b | `12d5bde` | push + tag `v8.34.0` | LAN `192.168.13.20` healthy, `8.34.0-12d5bde`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.34.0-12d5bde`; backup SQLite verificat | candidate de conflict bazate numai pe aceeași adresă observată; fără verdict de reachability ori remediere automată |
| V4.4c | `579cf4a` | push + tag `v8.35.0` | LAN `192.168.13.20` healthy, `8.35.0-579cf4a`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.35.0-579cf4a`; backup SQLite verificat | readiness derivat read-only din atașamente/posture; fără agent guest, trafic sau mutații |
| V4.5a | `8bcb9ec` | push + tag `v8.36.0` | LAN `192.168.13.20` healthy, `8.36.0-8bcb9ec`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.36.0-8bcb9ec`; backup SQLite verificat | transport posture din probele SDK existente; fără scanare TLS/certificat/port, trafic sau mutații |
| V4.5b | `3df3fcb` | push + tag `v8.37.0` | LAN `192.168.13.20` healthy, `8.37.0-3df3fcb`; backup SQLite verificat | VPS `89.37.212.66` healthy, `8.37.0-3df3fcb`; backup SQLite verificat | dashboard de prezentare peste evidențele deja încărcate; indisponibilitățile sunt explicite, fără apeluri noi sau mutații |
| V4.5c | `223d829` | push + tag `v8.38.0` | LAN healthy, `8.38.0-223d829`; backup SQLite verificat | VPS healthy, `8.38.0-223d829`; backup SQLite verificat | acoperire declarată a contractului SDK, nu scanare sau verdict de securitate |
| V4.5d | `89124ae` | push + tag `v8.39.0` | LAN/VPS healthy; backup SQLite verificat | LAN/VPS healthy; backup SQLite verificat | approval, confirmare, revalidare, post-verificare și task durabil ca evidence declarată |
| V4.5e | `fc17e1e` | push + tag `v8.40.0` | LAN/VPS healthy; backup SQLite verificat | LAN/VPS healthy; backup SQLite verificat | guardrail-uri declarate backup/recovery; fără execuție sau mutație |
| V4.5f | `d25bb47` | push + tag `v8.41.0` | LAN/VPS healthy; backup SQLite verificat | LAN/VPS healthy; backup SQLite verificat | safeguards declarate console, fără sesiune sau credential exposure |
| V4.5g | `c460674` | push + tag `v8.42.0` | LAN/VPS healthy; backup SQLite verificat | LAN/VPS healthy; backup SQLite verificat | task assurance declarată, fără creare/anulare/retry |
| V4.5h | `54bfce1` | push + tag `v8.43.0` | LAN/VPS healthy; backup SQLite verificat | LAN/VPS healthy; backup SQLite verificat | guardrail-uri rețea declarate, fără schimbări de fabric |
| V4.5i | `4b7c4d6` | push + tag `v8.44.0` | LAN/VPS healthy; backup SQLite verificat | LAN/VPS healthy; backup SQLite verificat | guardrail-uri lifecycle workload declarate, fără operații VM |
| V4.5j | `ff567ca` | push + tag `v8.45.0` | LAN/VPS healthy; backup SQLite verificat | LAN/VPS healthy; backup SQLite verificat | registru bounded pentru capabilități explicit unsupported |
| V4.5k | `243b088` | push + tag `v8.46.0` | LAN/VPS healthy; backup SQLite verificat | LAN/VPS healthy; backup SQLite verificat | freshness pentru evidența returnată, fără refresh sau probe noi |
| V4.5l | `fef215a` | push + tag `v8.47.0` | LAN `8.47.0-fef215a` healthy; backup SQLite verificat | VPS `8.47.0-fef215a` healthy; backup SQLite verificat | dashboard consolidat, fără colectări sau mutații suplimentare |
| V4.6a | `b2a81a1` | push + tag `v8.49.0` | LAN `8.49.0-b2a81a1` healthy; backup SQLite verificat | VPS `8.49.0-b2a81a1` healthy; backup SQLite verificat | B176–B185: catalog/roluri/scope delegation, projects, invitații, ownership și cote CPU/RAM/storage fără mutații provider |
| V4.6b | `4b08bd0` | push + tag `v8.50.0` | LAN `8.50.0-4b08bd0` healthy; backup SQLite verificat | VPS `8.50.0-4b08bd0` healthy; backup SQLite verificat | B186–B195: cote network/backup/GPU, quota requests, federation/SCIM/tokens/workload identity, approvals și blackout windows |
| V4.6c | `2dbbc54` | push + tag `v8.52.0` | LAN `8.52.0-2dbbc54` healthy; backup SQLite verificat | VPS `8.52.0-2dbbc54` healthy; backup SQLite verificat | B196–B205: leases, ownership completeness, SoD, access reviews, tenant offboarding și VM metrics foundation |
| V6.4a | `1b902c3` | push + tag `v8.53.0` | LAN `8.53.0-1b902c3` healthy; backup SQLite verificat | VPS `8.53.0-1b902c3` healthy; backup SQLite verificat | B206–B215: VM charts, contention/storage/network dashboards, events, correlation, topology și multi-signal alerts |
| V6.4b | `4387d9f` (`v8.54.0` base `2d80878`) | push + tag `v8.54.0` | LAN `8.54.0-4387d9f` healthy; backup SQLite verificat | VPS `8.54.0-4387d9f` healthy; backup SQLite verificat | B216–B225: baseline/suppression/maintenance, forecast, triage/runbooks, exports, SLO și telemetry privacy |
| V0.3b | `13bc623` | push + tag `v8.55.0` | LAN `8.55.0-13bc623` healthy; backup SQLite verificat | VPS `8.55.0-13bc623` healthy; backup SQLite verificat | B226–B235: durable-job evidence, DAG/compensation, secret-free manifests, immutable plans și stale rejection |
| V0.3c | `70404fe` | push + tag `v8.56.0` | LAN `8.56.0-70404fe` healthy; backup SQLite verificat | VPS `8.56.0-70404fe` healthy; backup SQLite verificat | B236–B245: ownership/delete safety, drift/reconcile, PR/Terraform/Ansible flows și signed webhook triggers |
| V0.3d | `8e19e0e` | push + tag `v8.57.0` | LAN `8.57.0-8e19e0e` healthy; backup SQLite verificat | VPS `8.57.0-8e19e0e` healthy; backup SQLite verificat | B246–B255: calendar/approval/dry-run/secret/template controls și lifecycle inventory/support/catalog/precheck evidence |
| V0.3e | `1e5e8c8` | push + tag `v8.58.0` | LAN `8.58.0-1e5e8c8` healthy; backup SQLite verificat | VPS `8.58.0-1e5e8c8` healthy; backup SQLite verificat | B256–B265: maintenance waves, gated lifecycle campaigns, live patch/reboot evidence, firmware/driver compatibility și certificate reminders |
| V0.3f | `d8d4d4a` | push + tag `v8.59.0` | LAN `8.59.0-d8d4d4a` healthy; backup SQLite verificat | VPS `8.59.0-d8d4d4a` healthy; backup SQLite verificat | B266–B275: certificate renewal, license assurance, configuration drift/profiles, air-gap mirrors, support bundles și post-upgrade validation |
| V6.3a | `c8ed49b` | push + tag `v8.60.0` | LAN `8.60.0-c8ed49b` healthy; backup SQLite verificat | VPS `8.60.0-c8ed49b` healthy; backup SQLite verificat | B276–B285: ledger allocation/usage, cinci familii de cost, tag allocation, showback, chargeback export și bugete |
| V6.3b | `e08c40c` | push + tag `v8.61.0` | LAN `8.61.0-e08c40c` healthy; backup SQLite verificat | VPS `8.61.0-e08c40c` healthy; backup SQLite verificat | B286–B295: alerte de buget/anomalii, idle/oversized/zombie, savings schedules, capacity commitments/consolidation/forecast și placement scoring |
| V6.3c / V5.6a | `9362b9f` | push + tag `v8.62.0`; PR #13 | LAN `8.62.0-9362b9f` healthy; backup SQLite verificat | VPS `8.62.0-9362b9f` healthy; backup SQLite verificat | B296–B305: energy/carbon/TCO și KubeVirt discovery/inventory, OpenShift/Harvester evidence, VM YAML server dry-run fără apply |

Acest tabel se actualizează după fiecare push și deploy. Detaliile fiecărui batch sunt păstrate sub `docs/planning/virtualization-platform/`.
