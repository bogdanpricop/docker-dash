# Plan de implementare și tracking pentru funcționalitățile rămase din market research

**Creat:** 2026-07-30
**Sursă principală:** [`../research/virtualization-market-research-2026.md`](../research/virtualization-market-research-2026.md)
**Plan de bază:** [`virtualization-platform-implementation-plan.md`](virtualization-platform-implementation-plan.md)
**Research Docker/Compose adiacent:** [`feature-research-2026-07.md`](feature-research-2026-07.md)
**Baseline produs:** v8.79.0
**Statut document:** Active — sursa operațională de adevăr pentru implementarea rămasă

## 1. Obiectiv

Acest document transformă funcționalitățile rămase din market research într-un
program executabil și urmărit. El separă explicit:

1. gap-urile care nu au încă o implementare utilă;
2. capabilitățile care există doar ca evidence, plan sau contract;
3. funcțiile care au executor real, dar numai pentru un provider;
4. batch-urile de provider care nu au început;
5. elementele deja livrate care necesită numai reconcilierea catalogului.

Un feature nu este marcat `Done` doar pentru că are o tabelă, un contract sau un
mock. Criteriul de închidere este rezultatul declarat în scope-ul batch-ului:

- pentru un feature read-only: evidence live sau importată printr-un adaptor
  explicit, UI, RBAC, freshness și coverage;
- pentru un feature de planificare: plan determinist, validare, stale rejection,
  audit și absența unei căi implicite de execuție;
- pentru un feature mutabil: preflight live, plan hash, approval/confirmation,
  idempotency, lock, task durabil, post-verificare și reconciliere;
- pentru un provider: fixtures, conformance, endpoint read-only și canary mutabil
  pe resurse disposable unde providerul permite.

## 2. Legendă de tracking

| Status | Semnificație |
|---|---|
| `Not started` | Nu există spec acceptat și nici cod dedicat suficient. |
| `Spec` | Scope-ul și criteriile sunt documentate; codul nu a început. |
| `In progress` | Există lucru activ în branch-ul curent. |
| `Partial` | Există fundație/plan/evidence, dar lipsește rezultatul complet descris aici. |
| `Blocked` | Depinde de o decizie, credențiale, licență sau endpoint real indisponibil. |
| `Done` | Criteriile batch-ului, testele și documentarea au fost îndeplinite. |

Prioritățile sunt:

- `P0` — închide un gap clar cu risc mic sau deblochează alte batch-uri;
- `P1` — valoare operațională mare, necesită integrare sau mutații controlate;
- `P2` — provider expansion ori funcție enterprise cu efort mare;
- `P3` — ecosistem/extensibilitate, după stabilizarea suprafețelor principale.

## 3. Registrul master

| Batch | Feature-uri | Prioritate | Efort | Status | Dependențe | Rezultat de închidere |
|---|---|---:|---:|---|---|---|
| R0 | Reconcilierea catalogului și gate automat | P0 | S | `Done` | — | 450 ID-uri validate; status curent 391 Done, 59 Partial, 0 Open; gate CI determinist. |
| R1 | B015 Saved inventory views | P0 | M | `Partial` | Provider VM inventory | Livrat în v8.80 și calificat read-only în v8.85; browser smoke rămâne. |
| R2 | B045 Scheduled VM actions | P0 | L | `Partial` | operation core, blackout windows | Livrat în v8.80 și calificat read-only în v8.85; browser/canary rămân. |
| R3 | B090, B096 Storage operational monitors | P0 | L | `Partial` | snapshot/storage evidence | Livrate în v8.80 și calificate read-only în v8.85; adaptorul B096 și browser smoke rămân. |
| R4 | B104, B118–B125 Network closure | P0/P1 | XL | `Partial` | v8.79 network plans, provider SDK | Implementările sunt în v8.80; v8.85 califică B104/B118–B121/B123, iar v8.86 califică B124/B125. Browser/provider/canary, probele active B119 și apply-ul R8 pentru B124 rămân. |
| R5 | B129–B150 Backup/DR depth | P1 | XXL | `Partial` | V3.1–V3.8 | B129–B150 au contracte/UI și execuție Proxmox limitată; v8.86 califică read-only B129–B136. Adaptoarele XO/vSphere și DR mutation/canary rămân. |
| R6 | B151–B175 Security/compliance depth | P1 | XXL | `Partial` | provider SDK, governance | B151–B175 au control-plane/evidence; colectoarele native, media recorder, public attestation și adaptoarele de remediation/enforcement rămân. |
| R7 | V5.1–V5.5, V5.7 Provider expansion | P2 | XXL | `Not started` | conformance kit | Hyper-V/Azure Local, Nutanix, OpenStack, CloudStack și Harvester depth. |
| R8 | Execuție pentru suprafețele plan-only | P1/P2 | XXL | `Partial` | R4–R7 | Executori expliciți pentru storage/network/migration/connectors. |
| R9 | Compose blueprint catalog | P3 | L | `Not started` | OCI Compose, signatures | Catalog semnat, pinned și operabil prin wizard. |
| R10 | Signed extension API complet | P3 | XL | `Partial` | provider plugins v8.72–v8.73 | Extensii read-only/UI stabile înaintea codului privilegiat. |

## 4. Reguli transversale

### 4.1 Siguranță și autorizare

- Nicio credențială, referință nativă sensibilă sau payload raw nu intră în
  răspunsuri publice, audit ori evidence export.
- Orice mutație folosește `requireAuth`, host scope, permisiune explicită,
  `writeable`, audit și politica read-only globală.
- Operațiile `high` sau `critical` cer confirmare tipărită; cele care pot afecta
  mai multe resurse cer approval independent conform policy engine-ului.
- Timeout după submit nu produce retry orb. Operația intră în `unknown` și este
  reconciliată prin read-back sau task-ul nativ.
- Orice executor nou pornește cu feature flag implicit `false` în producție.

### 4.2 Date și compatibilitate

- Migrările SQLite sunt aditive, monotone și idempotente la reaplicare.
- JSON persistent are versiune de schemă sau structură validată strict.
- Listele sunt bounded și paginate; nu se adaugă polling necontrolat.
- Planurile persistă hash-ul inputului și expiră când evidence-ul live devine
  stale ori versiunea resursei s-a schimbat.
- API-urile existente rămân backward-compatible.

### 4.3 UX și accesibilitate

- Fiecare pagină acoperă loading, empty, error, partial coverage, stale și
  unsupported.
- Orice control este utilizabil cu tastatura, are label accesibil și focus
  return după modal.
- Un feature indisponibil explică provider/capability/policy/state/permission
  blocker; nu dispare fără explicație.
- Datele introduse de utilizator sunt escapate cu `Utils.escapeHtml()`.

### 4.4 Definition of Done per batch

- feature-spec și assumption audit pentru batch-urile L/XL/XXL;
- migrare + service + route + UI unde scope-ul cere UI;
- teste unitare, contract, route/RBAC și browser pentru fluxurile principale;
- lint fără warnings și suita relevantă verde;
- `CHANGELOG.md`, What's New și documentația feature actualizate la release;
- catalogul research și acest registru actualizate în același PR;
- smoke read-only pe cel puțin un endpoint real relevant;
- mutation smoke numai pe resursă disposable și numai cu feature flag activat
  explicit;
- rollback și limitările rămase documentate.

## 5. Batch R0 — reconcilierea catalogului și gate automat

**Scope:** toate ID-urile care păstrează `Now/Next/Later` deși jurnalul de rollout
arată că sunt livrate, inclusiv B001–B014, B018–B037, B046–B076, B101, B122,
B126–B150 pe slice-ul declarat, B176–B185 și B426–B450.

### Livrabile

1. Un registru machine-readable cu `featureId`, `status`, `deliveryLevel`,
   `providers`, `evidence` și `limitations`.
2. Un script CI care verifică ID-uri duplicate, intervale lipsă, status invalid și
   contradicții între `Done` și absența dovezii de rollout.
3. Actualizarea tabelului research fără a promova `Partial` la `Done` când
   descrierea originală cere execuție reală.
4. Raport generat cu număr de `Done/Partial/Open` per categorie.

### Criterii de acceptare

- cele 450 de ID-uri apar exact o dată;
- orice `Done` are cel puțin un release/commit sau un test de contract asociat;
- orice implementare plan-only este etichetată explicit;
- CI eșuează dacă un release declară închiderea unui ID fără actualizarea
  registrului.

## 6. Batch R1 — B015 Saved inventory views

**Decizie acceptată pentru primul slice:** view-urile sunt personale, nu pot fi
partajate și nu pot schimba host scope-ul utilizatorului. Toți utilizatorii
autentificați își pot gestiona propriile view-uri. Primul consumer este pagina
`Virtual Machines`; schema este pregătită pentru alte tipuri de inventar.

### Model de date

Tabel `provider_inventory_views`:

- `id`, `user_id`, `name`, `resource_type`;
- `provider_host_id` opțional;
- `filters_json`, `columns_json`, `sort_json`;
- `is_default`, `version`, `created_at`, `updated_at`;
- unicitate case-insensitive pe utilizator, resource type și nume;
- maximum 50 view-uri per utilizator și maximum un default per resource type.

### Contract API

- `GET /api/providers/inventory-views?resourceType=virtual-machines`;
- `POST /api/providers/inventory-views`;
- `PUT /api/providers/inventory-views/:id`;
- `DELETE /api/providers/inventory-views/:id`.

Serverul acceptă numai câmpuri allowlisted. Pentru VM inventory:

- filtre: `query`, `powerState`, `providerHostId`;
- coloane: `name`, `powerState`, `cpu`, `memory`, `ipAddress`, `observedAt`;
- sortare: aceleași câmpuri, direcție `asc|desc`.

### UI

- selector `Saved view` în toolbar;
- `Save as`, `Update`, `Delete` și `Set default`;
- restaurarea filtrului, hostului, coloanelor și sortării;
- default-ul se aplică la intrarea pe pagină, fără să suprascrie un deep-link;
- fallback la view-ul built-in dacă un host salvat nu mai este accesibil;
- column picker și sort selector, cu layout card adaptat coloanelor selectate.

### Teste și acceptare

- ownership strict: user A nu poate citi/modifica view-ul userului B;
- viewer/operator/admin își pot gestiona propriile view-uri;
- validare pentru câmpuri necunoscute, nume duplicate, limită 50 și default unic;
- create/update/delete sunt audit-logged fără query text sensibil în audit;
- filtrarea/sortarea frontend este deterministă și nu mută inventarul original;
- refresh păstrează view-ul activ;
- test route, service, migration și browser/pure-page.

## 7. Batch R2 — B045 Scheduled VM actions

### Scope

- acțiuni `start`, guest-aware `shutdown`, `reboot`, `snapshot`;
- target VM explicit cu identitate canonică stabilă; selectoarele dinamice rămân în afara scope-ului;
- cron + timezone IANA, maintenance/blackout awareness;
- dry-run persistent pentru sloturile eligibile și run manual;
- leader-only scheduler în HA;
- fiecare firing creează operații VM existente, nu un executor paralel.

### Guardrails

- `forceShutdown` și `forceReboot` rămân OUT din scheduler;
- targetele sunt revalidate live înaintea fiecărei execuții;
- un slot are cheie idempotentă `(schedule, scheduledAt, resource)`;
- overlap policy conservatoare `skip`; `unknown` menține lock-ul până la rezoluția operației;
- snapshot schedule nu este prezentat drept backup;
- disable automat după eșecuri consecutive configurabile.

### Teste/acceptare

- DST forward/backward, restart, leader handover și duplicate tick;
- blackout, target dispărut, provider indisponibil, operation `unknown`;
- audit pentru create/update/disable/fire/skip/fail;
- UI cu next runs, last outcome și deep-link Activity Center.

## 8. Batch R3 — B090/B096 Storage operational monitors

### R3a — B090 Stale snapshot growth monitor

- normalizează age, chain depth, estimated bytes și consolidation/coalesce state;
- praguri per provider cu defaulturi conservative și override administrativ;
- trend zilnic, alertă numai la tranziție sau agravare;
- link către snapshot detail/consolidation preflight;
- nicio consolidare automată.

### R3b — B096 NFS/SMB repository health

- registry pentru endpoint și secret reference, fără credentiale inline;
- probe separate: DNS/TCP, mount/auth, list, latency și write-test opt-in;
- write-test folosește fișier aleator, bounded, apoi cleanup verificat;
- read-only probe implicit; write-test cere admin, typed confirmation și cleanup
  evidence;
- scheduler leader-only, history, alerts și freshness.

### Acceptare

- timeout și output bounded;
- path traversal, UNC/URL credentials și secret-shaped fields respinse;
- cleanup failure este incident vizibil, nu succes;
- niciun mount persistent nu este lăsat de probe.

## 9. Batch R4 — network closure

R4 se livrează în sub-batch-uri pentru a separa evidence read-only de mutații.

### R4a — B118 dependency map

- [x] contract și assumption audit pentru direcția upstream → downstream și
  limitele de cauzalitate;
- [x] observații IP/DNS normalizate, stricte, bounded și hash-deduplicate;
- [x] corelare read-only cu flow batches, metadata non-confidențială și
  relationship graphs;
- [x] fiecare edge are surse, first/last seen, confidence, freshness și
  eligibilitate explicită pentru impact;
- [x] nu declară dependență cauzală din proximitate temporală, DNS sau flow-only;
- [x] snapshots imutabile/deduplicate și impact upstream/downstream bounded,
  cycle-safe, doar pe relații declarate;
- [x] API admin, audit actions, UI și teste focused;
- [x] includere în v8.80.0 și calificare operațională read-only în v8.85.0;
- [ ] browser smoke și adaptoare provider-native de evidence.

### R4b — B119 reachability + B120 MTU

- B119 reachability:
  - [x] contract simulation-only pentru route/policy/attachment/provider evidence;
  - [x] tuple TCP/UDP/ICMP explicite, freshness și `pass/fail/unknown`;
  - [x] DNS/flow correlation read-only; flow-ul istoric nu produce singur pass;
  - [x] assessment imutabil/deduplicat, API admin auditat, UI și teste;
  - [ ] simulation adapter când providerul oferă native trace/diagnostic;
  - [ ] probe active numai dintr-un runner allowlisted, cu source ownership;
  - [ ] rate limit, timeout, destination allowlist și audit;
  - [x] includere în v8.80.0 și calificare read-only în v8.85.0;
  - [ ] browser smoke;
- B120 MTU:
  - [x] contract pasiv pentru paths workload/overlay/storage/live-migration;
  - [x] overhead cumulativ per segment și DF evidence explicit;
  - [x] `pass/fail/unknown`, bottleneck/deficit și fail-closed pe evidence
    missing/incomplete/expired;
  - [x] assessment imutabil/deduplicat, API admin auditat, UI și teste;
  - [x] includere în v8.80.0 și calificare read-only în v8.85.0;
  - [ ] browser smoke și adaptoare provider-native.

### R4c — B121 Bond/LAG și reconciliere B122 SR-IOV

- [x] contract normalizat pentru members/mode/link/admin/role/speed/duplex;
- [x] quorum activ, LACP partner consistency, errors/drops/flaps și recent
  failover evidence;
- [x] imbalance din delte bounded; zero trafic este `not_observed`;
- [x] observație imutabilă/deduplicată, API admin auditat, UI și teste;
- [x] includere în v8.80.0 și calificare read-only în v8.85.0;
- [ ] colectoare read-only provider-native și browser smoke;
- [x] B122 rămâne închis prin reutilizarea PF/VF din v8.71; nu se introduce un
  al doilea store SR-IOV.

### R4d — B123 load balancers și B124 NAT/public IP

- B123:
  - [x] inventory normalizat pentru VIP/listener/pool/member/algorithm/health;
  - [x] provider/network/resource canonical links fără native refs;
  - [x] observations imutabile/deduplicate, API admin auditat, UI și teste;
  - [x] includere în v8.80.0 și calificare read-only în v8.85.0;
  - [ ] colectoare NSX/Octavia/cloud și browser smoke;
- B124:
  - [x] NAT/public IP plan cu ownership, quota, cost, conflicts și release guard;
  - [x] plans imutabile/deduplicate, API admin auditat, UI și teste;
  - [x] includere în v8.80.0 și calificare read-only în v8.86.0;
  - [ ] apply intră în R8 numai după provider adapter și canary aprobate.

### R4e — B125 network intent validation

- parser IPv4/IPv6 pentru CIDR/subnet/gateway/route/DNS/VLAN/VNI;
- overlap și shadow/conflict checks cross-resource;
- validează intentul din v8.79 înainte ca orice executor să-l poată accepta;
- verdict `pass/fail/unknown`, niciodată `pass` pe evidence incompletă.
- [x] includere în v8.80.0 și calificare read-only în v8.86.0;
- [ ] browser smoke și primul executor legat de hash-ul intentului.

### R4f — B104 NIC connect/disconnect

- [x] preflight live pe VM/NIC, last/management/boot/guest dependency checks;
- [x] `connect` și `disconnect`, fără attach/detach/delete/remap;
- [x] task durabil per provider, post-read și rollback manual cu preflight nou;
- [x] feature flags separate, default-off, pentru Proxmox/vSphere/XenAPI;
- [x] declarație admin expirabilă, persistată și legată de fingerprint-ul NIC;
- [x] includere în v8.80.0 și calificare read-only în v8.85.0;
- [ ] browser smoke, canary pe provideri disposable și release gradual.

## 10. Batch R5 — backup, restore și DR depth

### R5a — backup execution multi-provider

**Features:** B129–B138.

- [ ] XO task-aware și vSphere data-mover adapters după Proxmox;
- [x] selection/exclusion explicit, concurrency și bandwidth windows;
- [x] crash/filesystem/application consistency cu evidence, nu fallback ascuns;
- [x] retention GFS, immutable capability și encryption policy aplicate numai când
  transportul nativ poate fi verificat;
- [x] integrity verification separată de simpla existență a recovery point-ului;
- [x] contract/plan/admission/integrity hashes persistente și UI de authoring;
- [x] includere în v8.80.0; B129–B136 au calificare read-only în v8.86.0;
- [ ] browser smoke și Proxmox/PBS canary.

### R5b — restore modes

**Features:** B139–B144.

- [x] file-level catalog/search cu path safety, RBAC, audit și metadata-only UI;
- [ ] file download/restore real după adaptor task-aware și content streaming;
- [x] instant/live restore plan capability-gated și cu network isolation;
- [x] differential restore plan cu base checksum și target isolation;
- [x] cross-site copy plan resumable, cu bandwidth policy și checksum;
- [ ] restore drill executabil extins dincolo de Proxmox.

### R5c — replication și DR execution

**Features:** B145–B150.

- [x] politici de replicare async/near-sync/sync versionate, draft-only;
- [ ] provider-native replication mutation adapters;
- [x] protection group cu network/placement maps și dependency graph versionat;
- [x] failover/failback deterministic preflight și rehearsal evidence;
- [ ] failover/failback provider mutation task-backed, approval și typed confirmation;
- [x] bubble-network DR test compiler/readiness cu temporary clones, source
  isolation și cleanup ownership; executorul provider rămâne nereleased;
- [x] RPO/RTO dashboard alimentat din recovery points/replication și durate de
  restore drill reușite, cu `unknown` păstrat explicit.

### Release gate R5

- niciun provider fără task/reconciliation identity nu primește mutation support;
- test restore real pe workload disposable;
- zero auto-delete pentru ținte parțiale sau recovery points;
- runbook de recuperare din `unknown` pentru fiecare adaptor.

## 11. Batch R6 — security și compliance depth

### R6a — hardware trust și encryption inventory

**Features:** B151–B159.

- [x] packs versionate Proxmox/vSphere/Xen/KubeVirt plus Hyper-V/Nutanix;
- [x] Secure Boot, vTPM, disk/state/migration/backup encryption ca evidence
  importată/provider-reported, fără scan implicit;
- [x] KMS/key-provider health, certificate expiry și affected resources cu
  secret references simbolice și zero network calls;
- [x] confidential VM detection și compatibility preflight persistent;
  provisioning-ul real rămâne separat și neautorizat;
- [x] CIS/STIG/vendor host baseline evidence closed-schema;
- [x] VM virtual-hardware baseline B159 ca evidence closed-schema;
- [ ] colectoare provider-native pentru toate domeniile de trust.

### R6b — advisories și remediation controlată

**Features:** B160–B168.

- [x] TLS/protocol/certificate evidence importată/provider-reported,
  closed-schema; colectarea live rămâne fail-closed;
- [x] reutilizarea catalogului oficial versionat și mapping exact
  version/build→CVE, fără fetch sau range guessing;
- [x] priority din severity + criticality + reachability, cu confidence;
- [x] finding exceptions cu owner/reason/expiry/compensating controls;
- [x] dry-run remediation cu steps/downtime/dependencies/rollback;
- [x] executor low-risk allowlisted numai după flag separat, typed confirmation,
  canary, adapter injectat și post-read verification; niciun adaptor production;
- [x] certificate rotation reutilizează lifecycle assurance existent;
- [x] manifests/jobs/templates resping credentialele inline și păstrează numai
  document/reference hashes.

### R6c — privileged access și compliance

**Features noi în depth:** B169–B175. **Batch de release exact:** B169–B178,
unde B176–B178 erau deja `Done` și sunt revalidate ca fundație integrată, nu
reclamate ca implementări noi.

- [x] step-up TOTP local/JIT grants cu TTL, scope, rate limit, four-eyes și
  token claim o singură dată;
- [x] break-glass four-eyes cu notification references, activare, închidere și
  review independent obligatoriu;
- [x] session metadata recording implicit; screen policy numai cu consent și
  policy reference, fără recorder/media storage;
- [x] data classification proiectată în export/backup/telemetry policy;
- [x] signed JSON/PDF bundle cu redaction și mappings organizaționale
  CIS/NIST/ISO/SOC2/DORA fără finding duplicat;
- [x] ransomware posture din immutability, isolation, restore tests și
  credential separation;
- [x] integrarea celor zece permisiuni cu custom roles și scope hierarchy
  provider-bound B176–B178;
- [ ] external notification dispatcher, standalone temporary account,
  provider-native enforcement, media recorder și public-key attestation.

## 12. Batch R7 — provider expansion

Fiecare provider trece prin același pipeline: spike read-only → manifest și
capabilities → resource adapters → conformance → UI → mutations separate.

### V5.1 — Hyper-V read-only

- transport WinRM/PowerShell constrained endpoint;
- standalone + Failover Cluster inventory;
- VM/host/cluster/storage/network/task normalization;
- certificate/auth modes fără command injection;
- Windows test matrix documentată.

### V5.2 — Hyper-V/Azure Local lifecycle

- power, snapshot/checkpoint, clone/create și migration;
- separare clară local PowerShell vs ARM/Arc;
- Cluster-Aware Updating și maintenance numai după readiness.

### V5.3 — Nutanix Prism Central

- clusters/hosts/VMs/storage/networks/tasks/categories;
- AHV power, snapshot, clone/create și migration;
- task UUID persistence și Prism Central/Element boundaries.

### V5.4 — OpenStack

- Keystone catalog și project scope;
- Nova, Cinder, Neutron și Glance adapters;
- quotas, async operations și microversion discovery;
- niciun admin-project fallback implicit.

### V5.5 — CloudStack

- zones/pods/clusters/hosts/offerings/projects;
- async job bridge;
- volume/network/template/VM lifecycle;
- domain/project isolation.

### V5.7 — Harvester depth

- Longhorn, Multus/NAD, images/DataVolumes, backups și migrations;
- reutilizează KubeVirt contracts fără a ascunde extensiile Harvester;
- mutation numai prin server dry-run + approval + read-back.

## 13. Batch R8 — transformarea planurilor în execuție explicită

Acest batch nu adaugă un buton universal `Apply`. Fiecare familie primește
adaptere separate și propriile safeguards.

### R8a Storage

- conversion worker real qemu-img/virt-v2v, sandbox și checksum;
- policy/QoS/tiering assignment adapters;
- orphan quarantine/cleanup cu recovery window;
- object/NFS/SMB health integration.

### R8b Network

- IPAM/DHCP/DNS connector execution;
- VLAN/VXLAN/VPC/NAT/security-group adapters;
- staged microsegmentation cu canary și management reachability guard;
- post-change B119/B120 validation.

### R8c Migration factory

- source export, conversion, isolated test clone și final sync;
- cutover/rollback executors cu checkpoints;
- network/storage switch separat și compensabil;
- evidence report din task-uri reale.

### R8d Connectors și plugins

- outbound requests numai pentru connector manifest semnat și host allowlisted;
- secret resolution JIT;
- retry/idempotency/timeout per operation;
- plugin code rămâne out-of-process și fără acces direct la DB/secrets.

## 14. Batch R9 — Curated Compose blueprint catalog

- index semnat și versionat;
- Compose artifact pinned la digest și imagini pinned unde este posibil;
- ownership, support level, changelog și deprecation;
- variables wizard cu secret references;
- healthcheck, backup/restore hints și resource estimates;
- plan/dry-run obligatoriu înainte de deploy;
- update diff și rollback către digestul anterior;
- proces documentat pentru review, key rotation și template compromise.

## 15. Batch R10 — Signed extension API complet

### Faza 1 — read-only UI extensions

- manifest API/UI versionat;
- panels declarative cu componente allowlisted, fără HTML/JS arbitrar;
- data queries prin capabilities declarate și host scope;
- CSP, size/rate limits și compatibility checker.

### Faza 2 — actions declarative

- acțiuni care apelează numai operații core înregistrate;
- permission consent, risk classifier și audit;
- fără acces direct la credențiale sau filesystem.

### Faza 3 — privileged out-of-process plugins

- se evaluează numai după două release-uri stabile ale fazelor 1–2;
- sandbox OS real, RPC schema, resource/network allowlist și kill switch;
- signing/revocation/update policy și incident response.

## 16. Strategie de testare

### Unit și property-style

- validatoare, canonical JSON/hash, state machines, retry și time calculations;
- CIDR/route/MTU, cron/DST, DAG/cycles și retention calculations;
- redaction și forbidden-field corpus.

### Route/RBAC

- anon/viewer/operator/admin/custom role;
- host/project scope și cross-user ownership;
- read-only global mode și disabled feature flags;
- payload limits, malformed IDs, stale plans și secret-shaped fields.

### Contract/provider

- fixtures pe versiuni/ediții;
- timeout, partial response, auth expiry, redirect master și task loss;
- capability reason pentru unsupported/conditional/unknown.

### Browser/accessibility

- keyboard-only, focus, labels și live status;
- empty/loading/error/stale/partial/unsupported;
- persistence după reload și deep-link navigation;
- fără console errors sau request loops.

### Endpoint real

- read-only înainte de mutation;
- resurse `dd-preflight-*` disposable;
- backup înainte de deploy și cleanup evidence după test;
- endpoint-urile/licențele absente rămân `Blocked`, nu sunt simulate drept suport.

## 17. Release și rollout

Pentru fiecare sub-batch:

1. feature-spec + assumption audit;
2. cod și teste focused;
3. lint + regression relevant;
4. backup DB/config pe ținte;
5. build `--target production` cu tag versiune+SHA;
6. deploy canary cu flags off;
7. smoke read-only și migrare;
8. activare flag pe un endpoint de test;
9. mutation disposable când este în scope;
10. post-verificare, audit și cleanup;
11. rollout gradual LAN/VPS;
12. actualizarea acestui registru, research-ului și changelog-ului.

Rollback-ul aplicației nu reface automat DB. Migrările trebuie să rămână
backward-readable; operațiile active/unknown se reconciliază înainte de rollback.

## 18. Decizii care necesită acord înainte de implementare

Următoarele schimbă material produsul și nu vor fi presupuse autonom:

1. providerul prioritar dintre Hyper-V, Nutanix, OpenStack și CloudStack;
2. acceptarea unei dependențe/binare noi pentru qemu-img/virt-v2v sau sandbox;
3. providerii comerciali/licențele disponibile pentru test real;
4. activarea screen recording pentru console, inclusiv retention și cerințe
   legale;
5. dacă view-urile salvate devin shareable/team-owned după R1;
6. dacă external connector execution poate ieși în internet din deployment;
7. cine deține signing keys și procesul de revocation pentru blueprint/plugin
   marketplace.

## 19. Jurnal de execuție

| Data | Batch | Status | Commit/release | Dovezi | Note |
|---|---|---|---|---|---|
| 2026-07-30 | R1 / B015 | `In progress` | — | audit repo + scope acceptat | Primul slice: VM inventory, view-uri personale, fără sharing. |
| 2026-07-30 | R1 / B015 | `In progress` | working tree local | migrarea 153; service/API/UI; 69 teste relevante; ESLint + `git diff --check` | Implementarea locală este completă. Browser smoke este restant deoarece browserul integrat nu a fost disponibil în sesiune; release/docs rămân de făcut. |
| 2026-07-30 | R0 | `Done` | working tree local | registry JSON 450/450; report 391/48/11; validator + 5 teste; gate CI | Research-ul este sursa editabilă; JSON-ul și raportul sunt proiecții generate și drift-checked. |
| 2026-07-30 | R3a / B090 | `In progress` | working tree local | migrarea 154; collector/policy/API/job/UI; teste focused | Monitorul read-only este implementat local; browser smoke și includerea într-un release rămân restante. |
| 2026-07-30 | R3b / B096 | `In progress` | working tree local | migrarea 155; registry/API/job/UI; DNS/TCP, history, transition alerts și adapter contract; teste focused | Nucleul read-only este local. Auth/list/write necesită adaptor data-plane aprobat; browser smoke și release rămân restante. |
| 2026-07-30 | R4e / B125 | `In progress` | working tree local | migrarea 156; validator IPv4/IPv6; overlap/gateway/DNS/route/VLAN/VNI; API/UI; teste focused | Validatorul local este complet; browser smoke, release și primul executor hash-bound rămân restante. |
| 2026-07-30 | R2 / B045 | `In progress` | working tree local | migrarea 157; cron IANA/DST; blackout/holiday; operation-core dispatch/reconcile; API/job/UI; 74 teste relevante | Scheduler-ul local este complet. Browser smoke, canary pe provider real și release rămân restante. |
| 2026-07-30 | R4a / B118 | `In progress` | working tree local | migrarea 158; IP/DNS + flow/metadata/graph correlation; snapshot/impact API; UI; 23 teste focused | Harta read-only este completă local; flow-only rămâne non-cauzal. Browser smoke, adaptoarele provider-native și release-ul rămân restante. |
| 2026-07-30 | R4b / B120 | `In progress` | working tree local | migrarea 159; evaluator MTU/overhead/DF; API/UI; 23 teste focused | Detectorul pasiv este complet local; 0 probe și 0 mutații. Browser smoke, adaptoarele provider-native și release-ul rămân restante. |
| 2026-07-30 | R4c / B121 | `In progress` | working tree local | migrarea 160; analyzer Bond/LAG/LACP/quorum/imbalance/failover; API/UI; 24 teste focused | Analyzer-ul pasiv este complet local; 0 active failovers și 0 mutații. Browser smoke, colectoarele provider-native și release-ul rămân restante. |
| 2026-07-30 | R4d / B123 | `In progress` | working tree local | migrarea 161; VIP/listener/pool/member/health inventory; API/UI; 23 teste focused | Inventarul read-only este complet local; 0 probes și 0 mutații. Browser smoke, colectoarele provider-native și release-ul rămân restante. |
| 2026-07-30 | R4d / B124 | `In progress` | working tree local | migrarea 162; allocate/map/unmap/release plans; ownership/quota/cost/conflict/version/release guards; API/UI; 23 teste focused | Planning-ul este complet local; 0 apply și 0 mutații. Browser smoke, provider adapters/canary, R8 apply și release-ul rămân restante. |
| 2026-07-30 | R4f / B104 | `In progress` | working tree local | migrarea 163; inventar/declarations/preflight; operation core; Proxmox/vSphere/XenAPI; API/UI; 10 teste dedicate | Link-only mutation este completă local și default-off per provider; attach/detach/delete/remap lipsesc intenționat. Browser smoke, provider canary și release-ul rămân. |
| 2026-07-30 | R4b / B119 | `In progress` | working tree local | migrarea 164; evaluator route/policy/attachment/DNS/flow; API/UI; 5 teste dedicate | Simularea control-plane este completă local cu 0 network calls/mutații; active probes, provider adapters, browser smoke și release rămân. |
| 2026-07-30 | Validare cumulativă | `Done` | working tree local | 306 suite / 3280 teste passed / 4 skipped; ESLint 0 errors; registry 391/59/0; `git diff --check` | Jest păstrează avertismentele cunoscute despre handle-uri Redis mock după finalizare; procesul a ieșit cu cod 0. |
| 2026-07-30 | UX control-plane transversal | `In progress` | working tree local | 11 locale pentru cele 4 rute; tab-uri și modale standardizate; Edge grupat în 5 categorii; 27 teste focused; gate-urile i18n/a11y; ESLint 0 errors; `git diff --check` | Implementarea locală este completă. Browser smoke rămâne deoarece runtime-ul integrat nu a expus niciun browser în sesiunea curentă. |
| 2026-07-30 | R5a / B129–B138 | `In progress` | working tree local | migrarea 165; policy/contract/admission/integrity/UI; teste focused | Control-plane-ul comun este local. Proxmox rămâne singurul executor; XO job discovery, vSphere data mover, browser smoke, canary și release rămân. |
| 2026-07-31 | Release 8.80.0 | `Partial` | `9db6d02` / `v8.80.0` | 308 suite / 3305 teste passed / 4 skipped; ESLint 0 errors; registry 391/59/0; gate-uri i18n/a11y și whitespace; health extern `8.80.0` pe LAN și VPS; migrațiile 153–165 aplicate | Lotul R5a conține exact 10 features, B129–B138, și include restanțele locale R1–R4 validate cumulativ. Backupurile SQLite `predeploy-v8.80.0-9db6d02.db` au fost create pe ambele servere. Browser smoke și deploy-ul local au rămas indisponibile deoarece sesiunea nu a expus browser sau Docker CLI/daemon; canary provider rămâne separat și default-off. |
| 2026-07-31 | Release 8.81.0 / B139–B148 | `Partial` | `f7bf79a` / `v8.81.0` | 309 suite / 3310 teste passed / 4 skipped; ESLint 0 errors; registry 391/59/0; i18n/a11y/whitespace; health extern `8.81.0` pe LAN și VPS; migrarea 166 + SQLite integrity `ok` | Lot exact de 10: drill/scheduler și DR existente plus file-catalog metadata, advanced restore/copy plans și replication policy drafts. Backupurile `predeploy-v8.81.0-f7bf79a.db` sunt păstrate. Mutațiile noi rămân default-off/fail-closed; Docker/browser local indisponibil. |
| 2026-07-31 | Release 8.82.0 / B149–B158 | `Partial` | `902bd85` / `v8.82.0` | 310 suite / 3317 teste passed / 4 skipped; ESLint 0 errors; registry 391/59/0; CI + 2 build-uri verzi; health extern `8.82.0` pe LAN și VPS; migrarea 167 + SQLite integrity `ok` | Lot exact de 10: DR test readiness și RPO/RTO aggregates plus packs Secure Boot/vTPM/encryption/confidential/hardening, KMS registry și confidential preflight. Flag-ul metadata-only este activ pe cele două ținte; colectoarele și provider mutations rămân fail-closed. Backupurile `predeploy-v8.82.0-902bd85.db` sunt păstrate; Docker/browser local indisponibil. |
| 2026-07-31 | Release 8.83.0 / B159–B168 | `Partial` | `2a45db4` / `v8.83.0` | 311 suite / 3326 teste passed / 4 skipped; ESLint 0 errors; registry 391/59/0; CI + build PR/tag verzi; health intern/extern `8.83.0` pe LAN și VPS; migrarea 168 + SQLite integrity `ok` | Lot exact de 10: virtual hardware/protocol/certificate/exposure evidence, exact advisory correlation, priority, excepții, dry-run/low-risk remediation contract, certificate renewal projection și no-storage secret validation. Lifecycle control-plane este activ; executorul low-risk rămâne explicit false și fără adaptor production. Backupurile `predeploy-v8.83.0-2a45db4.db` sunt păstrate; Docker/browser local indisponibil. |
| 2026-07-31 | Release 8.84.0 / B169–B178 | `Partial` | `85f030b` / `v8.84.0` | 312 suite / 3338 teste passed / 4 skipped; ESLint 0 errors; registry 391/59/0; CI + build PR/tag verzi; health intern/extern `8.84.0` pe LAN și VPS; migrarea 169 + SQLite integrity `ok` | Lot exact de 10: B169–B175 primesc TOTP/JIT, break-glass, session metadata, classification, signed evidence, mappings și ransomware posture; B176–B178 erau deja Done și sunt revalidate ca permission/custom-role/scope foundation. Flagul este activ pe ambele ținte; contul temporar standalone, dispatcherul extern, media recorderul, public attestation și enforcement-ul provider-native rămân absente. Backupurile `predeploy-v8.84.0-85f030b.db` sunt păstrate; Docker/browser local indisponibil. |
| 2026-08-01 | Release 8.85.0 / B015, B045, B090, B096, B104, B118–B121, B123 | `Partial` | `43c05ea` / `v8.85.0` | 313 suite / 3342 teste passed / 4 skipped; ESLint 0 errors; registry 391/59/0; CI rerun + build-uri PR/tag verzi; health intern/extern `8.85.0` pe LAN și VPS; SQLite integrity `ok` | Calificarea read-only separă schema livrată, evidența runtime și blocajele reale pentru exact primele 10 ID-uri Partial. LAN: vSphere real, schema 10/10, runtime 1; VPS fără provider activ: verificare explicit sintetică, schema 10/10, runtime 0. B045/B104 rămân false. Backupurile `predeploy-v8.85.0-43c05ea.db` sunt păstrate; browserul integrat, adaptoarele/collectorii și canary-urile rămân indisponibile. |
| 2026-08-01 | Release 8.86.0 / B124, B125, B129–B136 | `Partial` | `84122da` / `v8.86.0` | 313 suite / 3344 teste passed / 4 skipped; ESLint 0 errors; registry 391/59/0; CI + build-uri PR/tag verzi; health intern/extern `8.86.0` pe LAN și VPS; SQLite integrity `ok` | Calificarea read-only batch-aware verifică exact 10 ID-uri deja incluse în v8.80. Schema este 10/10 pe ambele ținte, runtime observat 0, iar invocarea pornește 0 provider/network/external work. LAN păstrează cele 2 flag-uri backup deja active, VPS 0. Backupurile `predeploy-v8.86.0-84122da.db` sunt păstrate; browserul integrat nu expune runtime, iar canary-urile și adaptoarele lipsă rămân deschise. |

## 20. Următoarele acțiuni

1. UX control-plane: browser smoke pentru Governance, Self-Service, Identity & Policy și Edge, inclusiv tab keyboard navigation și cel puțin un dialog modal pe rută.
2. R1/B015: browser smoke pe un endpoint local; includerea în v8.80 și calificarea v8.85 sunt deja înregistrate.
3. R2/B045: canary pe provider disposable și reconciliere browser când runtime-ul devine disponibil; execute rămâne default-off.
4. R4a/B118: browser smoke și conectarea adaptoarelor read-only de evidence când runtime/provider fixtures devin disponibile.
5. R4f/B104: browser smoke, canary per provider disposable și release gradual al flag-urilor independente; calificarea nu le activează.
6. R4b/B119: browser/provider simulation adapters și decizie separată pentru probe active privind runner-ul allowlisted, source ownership, destination policy, egress și rate limits.
7. R5a/B129–B138: canary Proxmox/PBS, apoi adaptor XO pentru un schedule/job task-aware descoperit explicit; vSphere intră numai prin VADP/VDDK sau backup vendor cu data mover.
8. R5b/R5c/B139–B148: adaptoare task-aware pentru file/instant/differential/copy și replication configure; failover/failback real numai după fencing, isolated networking, data-authority reversal și post-read verification.
9. R5c/R6a/B149–B158: provider-native DR test executor și security collectors;
   confidential VM create numai după canary, task identity și post-read verify.
10. R6a/R6b/B159–B168: provider-native hardware/transport/certificate/exposure
    collectors și certificate/remediation adapters; executorul low-risk poate fi
    canary-uit numai pe un provider disposable, cu rollback și post-read verify.
11. R6c/B169–B175: conectarea JIT la operațiile critice rămase, step-up pentru
    SSO/WebAuthn, dispatcher extern de notificări, media recorder aprobat legal,
    enforcement provider-native pentru classification și public-key attestation.
