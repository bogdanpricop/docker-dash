# Changelog

All notable changes to Docker Dash are documented here.

## [8.73.0] - 2026-07-30 — Signed connector marketplace and integration contracts

The B406–B415 batch completes the provider connector backlog with a signed,
secret-free and fail-closed integration control plane.

- Connector marketplace manifests require canonical Ed25519 signatures and
  declare publisher, support level, domains, products and exact HTTPS hosts.
- CMDB plans enforce per-field ownership; ITSM links gate on approval and exact
  change windows. SIEM events use a normalized schema and never store raw
  payloads; secret managers retain provider-native references only.
- IPAM/DNS lifecycle is ownership/version-bound and plan-only. Backup adapters
  normalize job/recovery visibility, while monitoring targets require explicit
  metric/label allowlists and a host signed into the manifest.
- Kafka/NATS/AMQP/SNS/SQS publications are schema-bound plans. Generic OpenAPI
  operations require exact host, method, path, risk and query/body allowlists;
  prototypes return hashes and start no network call.
- A dedicated governance tab exposes signed entries and the integration
  contract ledger. Every accepted write is audited and external mutations,
  publishes and network requests remain zero in this surface.

## [8.72.0] - 2026-07-30 — Advanced performance and signed provider plugins

The B396–B405 batch completes performance evidence and establishes a
fail-closed provider plugin trust boundary.

- VM compatibility scans compare recorded CPU, memory and device requirements
  with target host/provider-version evidence without starting migration or
  placement.
- Controlled benchmark baselines retain normalized hardware metadata. Noisy
  neighbor analysis correlates colocated pressure without claiming causation;
  direction-aware before/after comparison detects regressions.
- Batch, database, VDI, latency and AI profiles define desired thresholds and
  evaluate the latest workload sample without provider reconfiguration.
- Provider plugin manifests require valid canonical Ed25519 signatures and a
  known API/schema/capability contract. Explicit risk-aware permission consent
  is bound to the exact manifest hash and gates enablement.
- The sandbox probe runs only a fixed JSON-RPC worker in a separate process with
  memory/time/output limits, empty environment, no plugin code/path/network
  endpoint and no returned payload. Health stores aggregates only.

## [8.71.0] - 2026-07-30 — Hardware devices and accelerator control plane

The B386–B395 batch extends hardware evidence into scarce-device inventory,
telemetry, allocation planning and scheduling without exposing provider apply.

- Memory-tier snapshots report DRAM/NVMe capacity, use, hit rate and workload
  impact. PCI inventory reports IOMMU groups, reset/ACS readiness, PF/VF
  relationships, drivers, health and current mappings.
- PCI passthrough and SR-IOV actions create host-scoped, conflict-checked plans
  with NUMA, migration and HA constraints. Releasing a plan never detaches a
  provider device.
- GPU inventory includes model, memory, driver, health, MIG capability and
  licensed vGPU profile capacity. Full-GPU and vGPU plans prevent conflicting
  or over-capacity assignments.
- Bounded GPU metrics retain SM, memory, encoder, ECC and throttle evidence.
  Host-scoped accelerator reservations reject overlapping full/profile windows
  and expire automatically.
- USB ownership, mappings and mobility caveats are visible in the operator UI.
  Credential-shaped fields and oversized evidence fail closed; all writes are
  audited and provider mutations remain zero.

## [8.70.0] - 2026-07-30 — Hardware and performance evidence foundation

The B376–B385 batch adds normalized hardware and workload-placement evidence
without exposing a provider hardware mutation path.

- Host snapshots normalize CPU/NUMA/RAM/NIC/HBA/disk/GPU/BMC models,
  provenance and compatibility tags while rejecting credential-shaped fields.
- Cluster comparison shows common/extra/missing hardware tags and CPU features.
  CPU policy editing stores a provider-aware, hash-bound desired plan and
  blockers; it has no apply endpoint.
- NUMA topology joins CPUs, memory, devices and workload placement. VM fit
  analysis warns on oversized layouts, cross-node pinning and remote devices.
- CPU pinning inventory finds dedicated/shared conflicts. The real-time profile
  evaluates complete pinning, isolated CPUs, hugepages, latency sensitivity,
  ballooning and swap.
- Hugepage and memory dashboards expose per-node capacity, fragmentation,
  reserved/active/balloon/swap state and overcommit risk without remediation.

## [8.69.0] - 2026-07-30 — Accessible and explainable self-service experience

The B366–B375 batch completes the self-service experience with bounded support,
accessibility and privacy controls.

- Project administrators can request time-bound quota increases through the
  existing approval workflow. Approved limits become expiring grants.
- Organization/project branding accepts only same-origin or HTTPS assets and
  help links. Contextual documentation is provider-, version- and action-aware.
- Guided troubleshooting persists a hash-bound redacted support bundle, an
  evidence checklist and a read-only next safe test. Recommendations disclose
  reason, evidence, confidence, impact and undo and remain advisory-only.
- Keyboard VM operations, live regions, focus/contrast/motion rules and mobile
  incident cards add safe acknowledge/pause actions without destructive mobile
  defaults. CI gates the critical copy in all 11 bundled languages.
- Product feedback is disabled by default. After explicit opt-in, only an
  allowlisted local daily aggregate is retained; no telemetry is transmitted.

## [8.67.0] - 2026-07-29 — Edge continuity and unified infrastructure experience

The B346–B355 batch closes the edge backlog and starts the common operator
experience with permission-filtered, evidence-aware views.

- A disaster declaration freezes site mutations, signs an allowlisted local
  assessment runbook and queues local/external notification references without
  sending from the control plane. A different administrator must confirm the
  site slug and attach evidence to release the freeze.
- Offline backup seeds use signed, verified chunk manifests and monotonic,
  replay-safe continuation checkpoints; transfer remains outside the API.
  Fleet compliance exposes aggregate control states only and withholds source
  evidence. Rack, power, network and storage topology visualizes placement risk
  without changing placement.
- Zero-touch enrollment returns a hardware-bound token once, verifies TPM and
  device claims, rejects replay and requires independent approval of the public
  certificate fingerprint. No private key is generated or returned.
- The unified infrastructure home aggregates permitted endpoint health,
  persisted VM inventory, recent container telemetry, Kubernetes topology
  coverage, risks, rated cost and recent operations while marking unknown
  evidence explicitly. Navigation is refined by healthy permitted endpoints.
- DetailShell standardizes Overview, Actions, Tasks, Events and Audit tabs.
  Action decisions explain capability, policy, state and permission blockers;
  Activity Center adds persistent summaries, cancellation counts and canonical
  operation/resource deep links.

## [8.66.0] - 2026-07-29 — Edge sovereignty and resilient remote operations

The B336–B345 batch extends disconnected sites with fail-closed data movement,
short-lived local access and independently approved out-of-band recovery.

- Per-site residency rules cover inventory, logs, metrics and backups. Every
  evaluated destination is persisted, and synchronization plans are rejected
  when any selected category falls outside its allowed jurisdiction.
- Disconnected identity stores only assertion hashes, restricts normal and
  emergency scopes/TTL and requires another administrator to activate an exact
  signed grant. Site-local vault adapters retain references only; expiring
  secret-resolution envelopes execute at the edge and never return a secret.
- Single-node profiles expose lack of HA, require backup and maintenance-window
  evidence and disable automatic upgrades. Quorum snapshots compute majority,
  witness health and failure-domain risk; reservation assessments protect
  system CPU, memory and storage without applying configuration.
- Low-bandwidth console profiles prefer serial/text, adapt quality and force
  clipboard/file transfer off. Remote-hands checklists are signed, expiring and
  payload-bound to independent approval before local-operator readiness.
- Redfish/IPMI inventory links a registered host to a local-vault credential
  reference. Power recovery is blocked unless fencing, quorum, evacuation,
  backup and identity safeguards pass, then emits a short-lived four-eyes JIT
  envelope for an edge agent; the central service never calls the BMC.

## [8.65.0] - 2026-07-29 — Edge and disconnected operations foundation

The B326–B335 batch adds explicit edge-site state and bounded offline planning
without turning disconnected evidence into implicit infrastructure execution.

- Edge sites bind unique registered hosts to IANA timezone, region,
  jurisdiction, local owner and trust roots. Connectivity policies distinguish
  expected disconnects from outages and cached evidence is explicitly fresh,
  stale or expired.
- Offline mutation intents are HMAC-signed, expiring and action-allowlisted;
  reconnect revalidation must cover every prerequisite before an intent becomes
  agent-ready. The central service exposes no executor.
- Replay-safe heartbeats use monotonic sequences. Store-and-forward batches
  reject secrets, compress with deflate-raw, deduplicate by content identity and
  prioritize inventory/events ahead of metrics/artifacts within a byte budget.
- Local agent profiles restrict signed runbook envelopes to an allowlist.
  Canary/stable/held update plans retain trusted offline bundle and rollback
  evidence but expose no apply action.
- Air-gap bootstrap and OCI/ISO/template/package/docs mirror manifests retain
  digests, local references and external signature evidence, contain no private
  keys and never download or sync implicitly.

## [8.64.0] - 2026-07-29 — Unified Kubernetes application platform

The B316–B325 batch closes the VM/container convergence group with common
operational evidence, policy planning and application-level context.

- A bounded topology graph connects namespaces, pods, VMs, Services, nodes,
  PVCs/DataVolumes and Multus networks; normalized metrics attribute
  virt-launcher usage to VMs and expose node contention.
- ResourceQuota, NetworkPolicy, admission-controller and required-label
  evidence share one policy view. Cluster version, nodes, addons, API groups
  and OpenShift operators feed an explicit upgrade-readiness dashboard.
- Flux/Argo-aware VM GitOps plans accept credential-free HTTPS sources, reject
  inline secrets, compare live drift and stop after Kubernetes `dryRun=All`.
  The five-policy VM admission library records evaluations but never enforces.
- Curated AKS Arc, NKE, OpenShift, CloudStack CKS and Rancher workflows create
  blocked local plans with required prechecks; no provider executor is exposed.
- VM modernization maps, shared OCI/VM digest-SBOM-signature provenance and a
  unified Compose/Kubernetes/KubeVirt application environment are persistent,
  bounded and hash-idempotent without mutating providers or registries.

## [8.63.0] - 2026-07-29 — KubeVirt storage and network convergence

The B306–B315 batch adds CDI/template workflows and read-only storage, network
and drain convergence evidence with guarded, independently approved creation.

- DataVolume inventory normalizes HTTP, registry, PVC clone and upload sources,
  storage, phase, progress and conditions. The creation wizard supports those
  sources, HTTPS enforcement and optional SHA-256 provenance.
- OpenShift templates, KubeVirt instancetypes and preferences expose explicit
  API/RBAC coverage without returning parameter defaults. Template
  instantiation validates namespace, storage classes and Multus attachments.
- DataVolume and VM creation require a canonical plan, Kubernetes `dryRun=All`,
  hash-bound approval by another administrator, typed confirmation, fresh
  prerequisite validation, durable operation events and fingerprinted read-back.
- Local migration policies capture bandwidth, concurrency and timeout intent
  without applying cluster configuration. Node-drain evidence reports eviction
  strategy and non-migratable blockers.
- CSI snapshot classes/drivers/storage classes, Multus NAD/IPAM/interface
  mappings, redacted NMState intent/health and VM Service/Route/Ingress exposure
  are available as live evidence and explicit persisted snapshots.

## [8.62.0] - 2026-07-29 — Sustainability and KubeVirt convergence

The B296–B305 batch completes FinOps sustainability and starts the converged
Kubernetes virtualization track without adding implicit provider actions.

- Host/site power telemetry retains interval, watt/kWh, utilization, workload
  counts, source and provenance; dashboards expose W/VM, W/workload, idle waste,
  emissions and explicit carbon-factor coverage.
- Time-bounded carbon factors require credential-free HTTPS sources.
  Carbon-aware recommendations enforce capacity, residency, SLA and latency
  blockers and never schedule or migrate a workload.
- TCO scenarios compare CAPEX, recurring cost families, migration, residual
  value, discount, escalation, carbon and risk without purchasing or billing.
- KubeVirt discovery detects VM, CDI, migration, snapshot and console APIs and
  reports RBAC-obscured evidence as unknown. VM/VMI/migration inventory is
  normalized by namespace/name identity.
- OpenShift Virtualization exposes projects, routes, operator conditions and
  namespace RBAC; Harvester exposes images, networks, backups and Longhorn state.
- The VM YAML editor accepts only `kubevirt.io/v1 VirtualMachine`, blocks
  server-owned status, identity changes and inline secrets, and offers diff plus
  `dryRun=All` validation with no Apply endpoint.

## [8.61.0] - 2026-07-29 — FinOps optimization and capacity

The B286–B295 batch adds evidence-backed alerts, savings guidance and capacity
planning while keeping advisory actions separate from provider mutation.

- Budget policies queue idempotent actual and full-period forecast threshold
  notifications; scoped cost anomaly policies compare bounded rating-run
  baselines with amount floors, direction and confidence.
- Idle VM checks include CPU/RAM usage, uptime, owner, criticality and coverage;
  oversized checks use peak evidence, observation length and headroom guards.
- Stale disk, snapshot, IP, template and backup candidates honor attached,
  protected, criticality and owner context and never auto-delete.
- Off-hours policies support recommendation mode and a separate automation path
  requiring a payload-bound approval, durable operation, typed confirmation and
  registered apply/verify adapter.
- Reserved-capacity options compare on-prem and cloud commitments; N+1
  consolidation scenarios preserve HA reserve and utilization ceilings.
- CPU/RAM/storage growth forecasts estimate purchase date/quantity, while
  placement scoring explains cost, performance, resilience and compliance and
  excludes blocked candidates without placing workloads.

## [8.60.0] - 2026-07-29 — FinOps cost foundation

The B276–B285 batch adds transparent, evidence-backed infrastructure rating
without turning Docker Dash into a billing system.

- An immutable resource ledger records allocated and used vCPU, RAM, storage,
  GPU and IP/network quantities with bounded intervals and secret-free source
  evidence.
- Versioned private-cloud, provider/license, storage-tier, network/public-IP and
  GPU-profile models keep effective windows, currency, confidence and HTTPS
  provenance alongside their exact parameters.
- Priority tag rules map provider metadata to business unit, application,
  environment, cost center, project and site without changing provider tags.
- Hash-idempotent showback ratings preserve quantity, rate, formula and
  provenance per resource/model line and aggregate by category, cost center and
  confidence.
- Deterministic CSV/JSON chargeback exports are ready for billing or ERP import
  while explicitly creating no billing transaction.
- Monthly and quarterly budgets compare global or dimension-scoped rated spend;
  threshold/forecast notifications remain isolated for B286.

## [8.59.0] - 2026-07-29 — Lifecycle assurance, content and support

The B266–B275 batch completes the lifecycle/configuration-management research
track with adapter-gated mutation, redacted evidence and fail-closed validation.

- Certificate renewal plans require an immutable approval, a separate
  payload-bound approval and a durable operation before a registered adapter
  can apply. Verification updates tracked evidence; failures follow the
  approved rollback policy.
- License entitlements store opaque contract references rather than license
  keys, map capacity to resources and emit idempotent over-assignment,
  over-usage, under-assignment, expiry and growth-forecast alerts.
- Canonical host configuration snapshots redact secret-shaped values before
  persistence. Human-readable diffs feed allow/deny/ignore drift policies and
  versioned host-profile compliance with advisory remediation plans.
- Air-gap mirrors accept only exact requested digests signed by configured
  trust identities; unregistered adapters and unsigned content remain explicit
  failures without direct-download fallback.
- Multi-node support bundle adapters return bounded, redacted, checksummed and
  expiring evidence. Post-upgrade validation packs cover API, HA, migration,
  storage, network and VM checks and fail closed for required missing adapters.

## [8.58.0] - 2026-07-29 — Lifecycle maintenance and compatibility operations

The B256–B265 batch turns update readiness into explicit, staged operational
plans while retaining strict separation from provider execution.

- Maintenance windows model duration, owner/availability constraints,
  evacuation readiness and deterministic waves, then require a plan-hash-bound
  typed approval without starting provider work.
- Rolling cluster, guest-tools and VM hardware campaigns enforce distinct
  prechecks, ordered stages, verified durable-operation evidence and automatic
  pause on failed work or post-verification.
- Injectable live-patch adapters expose inventory/apply/verify evidence;
  apply/verify needs a matching approval, durable operation and typed phrase,
  while unavailable adapters remain explicitly unsupported.
- Independent kernel, hypervisor, toolstack and vendor signals produce an
  aggregate reboot-required result but never schedule a reboot.
- Official HTTPS firmware catalogs and exact device/driver/firmware/host-release
  compatibility records provide source-digested, non-remediating guidance.
- Certificate inventory links endpoints, services or hosts to owners,
  escalation and maintenance dependencies. Idempotent threshold reminders do
  not renew certificates automatically.

## [8.57.0] - 2026-07-29 — Automation operations and lifecycle readiness

The B246–B255 batch closes the automation research section and starts the
lifecycle/update track with durable, non-mutating operational evidence.

- Calendar-aware workflow schedules validate five-field cron and IANA timezone,
  suppress holidays/blackouts and deduplicate evidence per minute without
  launching workflow execution.
- Timed approvals can reassign, escalate and expire; decision requires the
  reviewed payload hash and never implies apply.
- Provider validate/simulate adapters persist bounded dry-run evidence and
  return explicit `unsupported` when no native adapter exists.
- The secret broker stores references only, fetches just in time, restricts
  purpose/TTL, zeroes memory buffers and audits fingerprints without returning
  secret values. Five curated workflow DAGs cover maintenance, migration,
  backup, security and upgrade readiness.
- Version/build inventory, GA/EOL/EOS support registry and vendor-supported
  upgrade paths provide freshness, hop, prerequisite and blocker evidence.
- Official-vendor catalog ingestion normalizes advisories without installing
  packages. Expiring upgrade prechecks cover health, capacity, verified backup,
  compatibility, free space and inventory freshness without starting upgrades.

## [8.56.0] - 2026-07-29 — Infrastructure delivery and GitOps safeguards

The B236–B245 batch extends infrastructure intent into guarded delivery
workflows while reusing the existing Fleet GitOps and procedure engines.

- Storage and network manifests require explicit ownership, owner and deletion
  policy; deletion is possible only for managed, unprotected resources.
- Live-resource import is deterministic and secret-free. Semantic drift honors
  ownership boundaries and manual reconcile revalidates fresh state before
  approval, retaining commit, diff and durable-operation evidence.
- Optional scoped controllers evaluate stored observations on schedule, avoid
  duplicate plans and pause when live state changes under a pending plan.
- Pull-request previews retain policy, cost-confidence and blast-radius evidence;
  Terraform imports and plan ingestion never take state ownership or persist
  before/after values.
- Terraform authorization records a typed, audited gate without launching an
  external process; Ansible inventory exports symbolic secret references only.
- Runbook webhooks use one-time-issued encrypted HMAC secrets, timestamp windows,
  event allowlists and transactionally unique nonces to reject replay.

## [8.55.0] - 2026-07-29 — Infrastructure automation foundations

The B226–B235 batch joins the existing durable provider-operation engine to a
secret-free, stale-safe infrastructure intent layer.

- Versioned VM, host and fabric manifests normalize desired state, reject
  secret-bearing fields and deduplicate identical revisions by SHA-256.
- Immutable change plans classify create, update, delete, unchanged and blocked
  paths; destructive storage/network changes remain blocked until B236.
- Plan acceptance revalidates manifest revision, live-state hash, native
  resource-version hash and expiry before recording reviewed intent.
- Workflow DAGs validate dependencies and cycles, and expose deterministic
  reverse-order compensation previews without executing provider mutations.
- Accepted plans can link to the existing durable provider jobs while exposing
  state, retry, idempotency, lock and native-task evidence without ciphertext.
- Governance → Automation & IaC provides the complete admin-only control surface;
  accepting a plan or previewing compensation schedules zero provider mutations.

## [8.54.0] - 2026-07-29 — Advanced VM observability operations

The B216–B225 market-backlog batch adds explainable operational controls on
top of normalized VM telemetry. All assessments are bounded and advisory; no
provider mutation or collection is inferred.

- Dynamic baseline policies, multi-signal alert suppression and maintenance
  windows retain evidence for every evaluation and suppression decision.
- Capacity forecasts, incident triage and versioned runbook links turn metric
  and event evidence into bounded operator guidance.
- Explicit telemetry exports apply per-host privacy, residency and delivery
  checks; retention requires a typed confirmation.
- SLO reports calculate availability across their full window and exclude the
  union of matching maintenance intervals without double-counting overlaps.
- The Governance → Observability control surface exposes every policy and
  evidence workflow; export delivery and retention purge remain separate,
  explicitly confirmed operator actions.

## [8.53.0] - 2026-07-29 — VM observability and event correlation

The next ten market-backlog capabilities, B206–B215, turn the normalized VM
telemetry foundation into bounded performance, event and correlation views.

- VM performance comparison charts support up to ten resources, twelve metrics,
  31 days, downsampling and normalized event annotations.
- Contention, storage and network dashboards expose ready/steal/balloon/swap,
  latency/IOPS/queue/resync and throughput/drop/error/flow/MTU evidence.
- Six cursor/watch/webhook/poll event adapters normalize caller-supplied
  observations and deduplicate them by native ID or a bounded fingerprint
  window while retaining repeat counts.
- Correlation and VM incident timelines combine normalized events, audit
  changes, existing alerts and metric evidence.
- Fabric topology edges produce bounded downstream impact overlays; multi-signal
  rules combine metric, event and collection-state conditions with duration
  evidence and create advisory, explainable alerts.

## [8.52.0] - 2026-07-29 — Governance lifecycle and VM metrics foundation

The next ten market-backlog controls, B196–B205, close the governance lifecycle
wave and establish bounded, provider-aware VM telemetry.

- Resource leases enforce maximum TTL, explicit renewal rights, renewal count
  and cleanup ownership without deleting provider resources on expiry.
- Production resource assignment can fail closed until owner, service and cost
  center are complete; SoD reports include direct and team role bindings.
- Access review campaigns recertify role/scope bindings and service accounts,
  preserving evidence when a binding is expired or token revoked.
- Tenant portability uses a size-bounded JSON export and SHA-256 checksum;
  deletion requires suspension, cleared blockers, checksum and typed phrase.
- A 13-series VM metrics schema normalizes PVE RRD, XAPI RRD, vSphere
  performance, Prometheus and Azure Monitor payloads with units and provenance.
- Per-resource freshness/errors, adaptive polling and cardinality budgets are
  visible in the governance UI and exported as bounded Prometheus metrics.

## [8.51.0] - 2026-07-29 — Compose mount and volume attribution

Compose stack storage now accounts for Docker named volumes as well as image and
writable-layer sizes, while keeping host-owned mounts explicitly separate.

- Shared named volumes are deduplicated, show Docker-reported usage coverage,
  and distinguish volumes managed by the stack from external or unknown ones.
- Stack and service detail show bind-mount topology, including writable versus
  read-only binds and tmpfs mounts, without scanning host filesystems.
- Approximate persistent footprint includes named volume usage only when Docker
  returned complete measurements; bind mounts, logs and build cache remain out
  of scope and no Docker mutation is performed.

## [8.50.0] - 2026-07-29 — Identity and policy governance

The next ten market-backlog controls, B186–B195, extend projects with capacity,
identity lifecycle and mutation governance.

- Network/public-IP, snapshot/backup and GPU/device profiles use explicit soft/hard
  quota accounting. Audited requests can add time-bound quota grants after one or
  two distinct approvals.
- Multiple OIDC/SAML-broker realms route login by email domain. SCIM 2.0 provisions
  users and groups with scoped Bearer tokens, deactivates deleted users, invalidates
  their sessions and never grants global admin through SCIM.
- Short-lived service tokens are shown once, stored only as hashes, scope-checked,
  rotatable and revocable. Signed OIDC/SPIFFE/cloud JWT assertions can exchange once
  against pinned JWKs for workload tokens lasting at most one hour.
- Policy approvals bind the canonical payload and action to distinct approvers and
  consume the approval after a successful mutation. Blackout windows return HTTP 423;
  permitted emergency overrides require a global admin, ticket and reason and are stored.
- The new Identity & Policy page exposes the controls. Migration 125 is additive and
  provider resources are never discovered, reserved or mutated by quota accounting.

## [8.49.0] - 2026-07-29 — Scoped governance foundation

Docker Dash now provides an additive governance control plane over its existing
tenant model for B176–B185 from the virtualization market backlog.

- A permission catalog, custom roles, hierarchical scopes and inherited
  user/team bindings support delegated site administration without granting
  global Docker Dash admin rights.
- Projects include owners, members, active/suspended lifecycle, hashed expiring
  invitations, transactional ownership transfer and explicit resource assignments.
- CPU, memory and storage expose current usage plus soft warnings and hard
  transactional limits. Accounting assignments never move or mutate provider resources.
- The new Governance page and audited API are guarded by `DD_GOVERNANCE_ENABLED`.

## [8.48.0] - 2026-07-29 — Compose stack storage footprint

Compose stack details now show Docker-reported image and container filesystem
sizes for every running or stopped service.

- Per-container rows distinguish shared image size, writable-layer size and
  root-filesystem size.
- The stack summary deduplicates shared images and calculates approximate
  footprint only when image and writable-layer coverage are complete.
- Size accounting runs only when a stack detail is opened and explicitly
  excludes volumes, logs and build cache; it performs no Docker mutation.

## [8.47.0] - 2026-07-29 — Consolidated provider security evidence

Provider Security Posture now begins with a compact summary of its existing
capability, safeguard, gap, and freshness evidence.

- The dashboard consumes the response already collected by the page.
- It is not a security rating, compliance certification, or vulnerability assessment.
- No additional provider, guest, network, or configuration operation is performed.

## [8.46.0] - 2026-07-29 — Posture evidence freshness

Provider Security Posture now displays the returned capability-evidence timestamp,
age band, and existing probe state.

- Freshness measures returned evidence only; it is not a provider health guarantee.
- The page does not force a refresh or run an additional endpoint probe.

## [8.45.0] - 2026-07-29 — Unsupported capability gap register

Provider Security Posture now lists the provider SDK capabilities explicitly
declared unsupported, with their contract reasons.

- Unsupported is presented as a safety boundary, not as an error to bypass.
- No provider CLI or compatibility fallback is invoked.

## [8.44.0] - 2026-07-29 — Workload lifecycle guardrail evidence

Provider Security Posture now summarizes declared safeguards for VM power,
snapshots, clone/create, and guest customization capabilities.

- It is contract evidence, not proof that a lifecycle operation is safe or complete.
- No VM power, snapshot, clone, create, or guest customization action is submitted.

## [8.43.0] - 2026-07-29 — Network-change guardrail evidence

Provider Security Posture now summarizes declared network/NIC evidence bounds
and the released state of common network mutation.

- It does not test routing, VLAN safety, firewall policy, or isolation.
- It changes no NIC, bridge, VLAN, security group, or network configuration.

## [8.42.0] - 2026-07-29 — Native task assurance evidence

Provider Security Posture now summarizes declared durable-task, cancellation,
post-verification, and revalidation properties for eligible provider operations.

- It is not a task history, task health, or reconciliation result.
- No task is started, cancelled, retried, or modified.

## [8.41.0] - 2026-07-29 — Console exposure safeguard evidence

Provider Security Posture now shows declared console-gateway safeguards: single-use
tokens, server-side credential isolation, and emergency lock support.

- The data is contract evidence, not a live-console, TLS, or endpoint-hardening test.
- It does not open a console or expose provider credentials.

## [8.40.0] - 2026-07-29 — Backup and recovery control evidence

Provider Security Posture now surfaces declared backup, restore, drill, and
replication guardrails such as durable tasks, create-only restore, isolation,
and disabled retention mutation.

- The summary is not backup integrity, restore success, RPO/RTO, or drill proof.
- It introduces no backup, restore, replication, retention, or provider mutation.

## [8.39.0] - 2026-07-29 — Privileged-operation safeguard evidence

Provider Security Posture now summarizes declared four-eyes approval, typed
confirmation, revalidation, post-verification, and durable-task controls.

- These are contract declarations, not proof that a control has been exercised.
- The view never authorizes, submits, or changes a privileged operation.

## [8.38.0] - 2026-07-29 — Provider capability coverage posture

Provider Security Posture introduces a read-only summary of the provider SDK's
declared supported, conditional, and unsupported capabilities.

- It is contract coverage, not a security scan, authorization audit, or
  compliance certification.
- Conditional capability remains explicitly conditional per provider/resource.
- No endpoint, credential, TLS, certificate, port, guest, or provider setting is read or changed beyond existing SDK evidence.

## [8.37.0] - 2026-07-28 — Consolidated network evidence dashboard

Network Posture now begins with a compact, read-only dashboard that brings the
already-collected network, attachment, address, readiness and endpoint evidence
into one operational view.

- **No new collection.** The dashboard consumes the same responses shown below;
  it does not add a provider, guest or network call.
- **Unavailable stays visible.** If a supporting evidence source cannot be
  collected, the summary counts it as unavailable rather than inferring a result.
- **No expanded claim.** The summary does not prove connectivity, isolation,
  routing, policy enforcement or IP ownership, and has no mutation path.

## [8.36.0] - 2026-07-28 — Read-only provider endpoint transport posture

Network Posture now surfaces the most recent provider capability-probe outcome
as endpoint transport evidence.

- **No additional scan.** The feature consumes existing probe evidence only; it
  performs no new TLS, port, certificate or transport probe.
- **Bounded meaning.** Reachability is not proof of authentication,
  authorization, provider feature availability or workload connectivity.
- **No mutation.** It changes no endpoint, credential, certificate, firewall or
  network configuration.

## [8.35.0] - 2026-07-28 — Read-only guest network readiness evidence

Network Posture now summarizes per-VM guest network readiness evidence from
provider-visible NIC configuration, link state and reported addresses.

- **Fail-closed status.** A VM is ready only when a connected NIC and an
  observed address are both present; missing evidence remains unknown.
- **Bounded coverage.** Reads are limited to 100 VMs with four concurrent NIC
  inventory requests; unreadable hardware remains visible as partial coverage.
- **No active validation.** It does not run guest commands, ping, DNS, routing
  or firewall tests, and makes no network mutation or remediation.

## [8.34.0] - 2026-07-28 — Read-only IP conflict candidates

Network Posture can now identify repeated provider-visible IP observations as
conflict candidates.

- **Candidates, not conclusions.** NAT, stale guest-tools data, multi-homing
  and provider semantics may explain a repeated address; no result confirms an
  IP conflict.
- **Existing evidence only.** It reuses bounded VM IP observations and preserves
  partial-inventory coverage rather than performing active discovery.
- **No remediation.** No ARP/ping, DHCP/IPAM lookup, guest command, provider
  mutation, CLI fallback or automatic response is performed.

## [8.33.0] - 2026-07-28 — Read-only VM IP address evidence

Network Posture now summarizes provider-visible and guest-tools-reported VM IP
address evidence on supported endpoints.

- **Bounded observations.** Inventory reads at most 100 VMs and returns at most
  1,000 observed addresses with IPv4/IPv6 counts and explicit partial coverage.
- **Honest evidence.** Missing values do not mean a VM has no address; observed
  values do not prove DHCP ownership, IPAM allocation or reachability.
- **No active discovery.** No packet, DHCP/IPAM lookup, guest command, network
  mutation, CLI fallback or remediation is performed.

## [8.32.0] - 2026-07-28 — Read-only network configuration drift baseline

Network Posture can now retain an operator-created baseline of normalized
provider-visible network configuration and compare later observations to it.

- **Explicit baseline.** Until an authorized host administrator saves a
  baseline, the result is `unbaselined`, never falsely in sync.
- **Bounded normalized diff.** The comparison covers provider-visible
  accessibility, managed state, bridge, VLAN and MTU; only change types and
  fields are returned.
- **No reconciliation.** Saving or comparing a baseline changes no provider
  network configuration, sends no traffic and has no CLI fallback or remediation.

## [8.31.0] - 2026-07-28 — Read-only virtual-network placement evidence

Network Posture now evaluates provider-visible virtual networks as placement
evidence. A candidate requires positive provider evidence for both accessibility
and managed state; negative evidence blocks it and missing evidence remains
unknown.

- **Fail-closed advisory.** No missing management or accessibility value can
  become a candidate.
- **No implied fabric guarantee.** A candidate is not a reservation and does
  not prove routing, firewall policy, capacity, connectivity or isolation.
- **No control-plane effect.** The host-view advisory changes no NIC, switch or
  VLAN, sends no traffic, and has no CLI fallback or remediation path.

## [8.30.0] - 2026-07-28 — Read-only VM network attachment topology

Network Posture now includes a bounded view of the provider-visible
VM-to-virtual-network attachments on supported vSphere and Xen endpoints.

- **Opaque, host-scoped grouping.** Provider-native network identifiers are
  never returned. Attachments are grouped under an opaque host-scoped identity
  with the reported display name, bridge and VLAN evidence where available.
- **Partial evidence remains explicit.** At most 100 VMs are read with bounded
  concurrency. Truncation and unreadable NIC inventories are reported as partial
  coverage rather than hidden or treated as no attachments.
- **No fabric inference or control.** The result does not prove connectivity,
  routing, firewall policy or tenant isolation. It changes no NIC, switch or
  VLAN, sends no traffic and has no provider CLI fallback or remediation path.

## [8.29.0] - 2026-07-28 — Read-only virtual network policy advisory

Network Posture can now assess provider-visible virtual networks against an
operator-selected, temporary policy: provider-reported accessibility is always
required, with optional minimum MTU, managed-network and VLAN-evidence criteria.

- **Honest compliance states.** Networks are marked compliant, noncompliant or
  unknown. Missing required accessibility, VLAN or MTU evidence remains unknown
  and never appears compliant.
- **Bounded provider-neutral evidence.** The host-view endpoint evaluates at
  most 500 canonical network records and returns only neutral signals. Support
  is conditional for vSphere and Xen; Proxmox remains explicitly unsupported.
- **No control-plane effect.** The policy is transient and read-only: it is not
  saved, applied or remediated, sends no traffic, and does not reserve network
  capacity or use provider CLI fallback.

## [8.28.0] - 2026-07-28 — Read-only virtual network posture

Docker Dash now has a **Network Posture** page for vSphere and supported Xen
management planes. It is a read-only, provider-neutral inventory projection;
Proxmox remains explicitly unsupported until a common bridge-inventory contract
is available.

- **Live configuration evidence.** Each virtual network shows provider-reported
  accessibility, management state, bridge/backing, VLAN ID and MTU where the
  provider exposes them.
- **Honest limits.** A bridge, VLAN or MTU is configuration evidence only — it
  is not presented as proof of routing, firewall policy, tenant isolation or
  end-to-end connectivity. Missing values remain unknown.
- **No lockout risk.** The host-view endpoint performs no network mutation,
  test traffic, provider CLI fallback or automatic remediation.

## [8.27.0] - 2026-07-28 — Read-only storage policy compliance

Storage Posture now evaluates provider-visible storage inventory against a
temporary policy selected by the operator: accessible storage is always
required, with optional minimum free capacity and shared-storage requirements.
The policy is a view-only assessment and is never persisted or applied.

- **Compliance without fiction.** Each target is shown as compliant,
  noncompliant or unknown. A negative provider observation fails the policy;
  missing accessibility, capacity or shared-state evidence remains unknown and
  cannot appear compliant.
- **Scoped, bounded evidence.** The host-view endpoint reads at most 500
  normalized targets and permits a minimum-free requirement from 0 to 64 TiB.
  It returns only canonical storage identities and provider-neutral signals.
- **No hidden control plane.** This release reserves no capacity, changes no
  storage policy, writes no test data and performs no provider CLI fallback.
  A later disk operation must still perform its own authorized fresh preflight.

## [8.26.0] - 2026-07-28 — Read-only virtual-disk placement advisory

Storage Posture can now evaluate provider-visible storage targets for a proposed
virtual-disk size. It applies the same capacity headroom used by the guarded
disk lifecycle preflight, but remains a read-only, point-in-time advisory.

- **Explicit target evidence.** Operators choose a disk size in GiB and receive
  candidate, blocked and needs-evidence results based on reported accessibility,
  maintenance state, free capacity and, for Proxmox, VM image-content support.
- **No implied reservation.** A target becomes a candidate only when every
  applicable check is positively evidenced. Missing telemetry remains unknown;
  capacity is never reserved and a real disk operation must revalidate before
  provider I/O.
- **Bounded and portable.** The endpoint is host-view scoped, returns canonical
  storage identities and is capability-gated for Proxmox VE, vSphere / ESXi and
  supported Xen management planes. It performs no storage mutation, test write,
  shell fallback or automatic placement.

## [8.25.0] - 2026-07-28 — Read-only shared virtual-disk topology

Storage Posture now includes a bounded, provider-neutral view of virtual-disk
backings observed across VMs on Proxmox VE, vSphere / ESXi and supported Xen
management planes. It is evidence only: the release creates no disks, changes
no attachment, and enables no storage mutation.

- **Opaque cross-VM correlation.** A host-scoped opaque backing ID correlates
  observed VM disk attachments without returning VMDK, VDI, volume or provider
  path references to the browser.
- **No unsafe inference.** A backing is shown as *confirmed shared* only when
  every observed attachment is explicitly declared shared by the provider.
  Any other common backing is a *needs review* observation, never a claim that
  a multi-writer configuration is valid or safe.
- **Bounded, honest coverage.** Collection is limited to 100 selected VMs with
  four concurrent read-only hardware calls. Truncation, unreadable VM hardware
  or unavailable disk inventory is shown as partial evidence rather than being
  silently ignored. Native identifiers, guest changes, test writes, repair,
  policy/QoS changes and automation remain out of scope.

## [8.24.0] - 2026-07-28 — Guarded vSphere snapshot consolidation

Docker Dash can now submit VMware vSphere snapshot disk consolidation only when the
VM's live runtime explicitly reports that it is needed. This is a separate opt-in
from regular snapshots: `DD_PROVIDER_VM_SNAPSHOT_CONSOLIDATION=true` is required in
addition to the existing snapshot gate.

- **Evidence before I/O.** Consolidation is offered only for vSphere VMs whose fresh
  `runtime.consolidationNeeded` value is true. A false or missing observation blocks
  preview and worker execution; Proxmox and Xen providers remain unsupported.
- **Durable and verified.** The action uses `ConsolidateVMDisks_Task`, a hash-bound
  preflight, exact typed VM-name confirmation, admin plus host-operate access, a
  per-VM lock and non-idempotent operation handling. Success requires both native
  task completion and a fresh runtime observation that consolidation is no longer needed.
- **No automation implied.** The release does not delete snapshots, schedule or bulk
  consolidate workloads, execute guest commands, alter datastore policy/QoS or use a
  provider CLI fallback. Operators retain explicit control over a potentially I/O-heavy task.

## [8.23.0] - 2026-07-28 — Provider storage posture baseline

Docker Dash now has a provider-neutral **Storage Posture** page for Proxmox VE,
vSphere / ESXi and supported Xen management planes. It is a read-only assessment
under the existing Provider SDK v2 contract; no storage policy or volume mutation
is enabled by this release.

- **Live, bounded evidence.** Each storage target shows provider-reported accessibility,
  maintenance state, capacity, used/free bytes, virtual allocation where available,
  type/content and shared-storage evidence. Inaccessible storage and >=95% observed
  utilization are critical; maintenance, 85–<95% utilization and observed overcommit
  are warnings.
- **Honest coverage.** Policy, QoS and multipath capability evidence is shown alongside
  every result. Missing or unsupported QoS/multipath, Ceph, Longhorn, vSAN, S2D and
  appliance telemetry is explicitly unknown — it is never presented as healthy.
- **Safe foundation.** The new host-view endpoint uses canonical IDs and the existing
  normalized inventory. It performs no write/test-write, no shell fallback, no capacity
  reservation and no snapshot consolidation. Those workflows remain separately planned
  and must revalidate at execution time.

## [8.22.0] - 2026-07-28 — Provider VM disk lifecycle

Docker Dash can now perform a guarded lifecycle for virtual disks on supported Proxmox VE QEMU,
vSphere/vCenter and XenAPI endpoints. The feature is intentionally opt-in through
`DD_PROVIDER_VM_DISK_LIFECYCLE=true`; permanent backing deletion has a second, separate
`DD_PROVIDER_VM_DISK_DELETE=true` gate.

- **Plan before mutation.** The VM Disks tab provides a fresh, hash-bound preflight for creating and
  attaching a managed disk, safely detaching while retaining data, grow-only resize, and supported
  storage moves. Each action rechecks capability, current VM/disk state, safety evidence, permissions
  and operation conflicts immediately before it is queued.
- **Durable, auditable operations.** Disk actions use the provider-operation engine with VM/storage
  locks, idempotency keys, native task reconciliation, positive post-read verification and a
  hash-chained audit event. Native provider identifiers remain encrypted server-side.
- **Ownership-protected cleanup.** Docker Dash records ownership only after it creates and verifies a
  backing. It never adopts foreign disks. Permanent deletion applies solely to a positively detached,
  Docker Dash-managed volume, and additionally requires no snapshot dependency, a recent verified
  recovery point and the exact typed confirmation.
- **Deliberately excluded.** Shrink, guest partition/filesystem changes, implicit format conversion,
  foreign-volume cleanup and unverified provider transports remain fail-closed. Xen Orchestra REST,
  raw Xen and Proxmox LXC disk mutations are not released in this slice.

## [8.21.4] - 2026-07-25 — Fix Linux image startup from Windows-authored releases

- **Fixed Docker restart loop.** `entrypoint.sh` was stored with CRLF line endings, so Linux read its
  shebang as `/bin/sh\r` and released images failed at startup with `exec /app/entrypoint.sh: no such
  file or directory`. Shell scripts are now normalized and enforced as LF through `.gitattributes`.
- Supersedes `8.21.3`; the Teams UI and per-host access-control functionality is unchanged.

## [8.21.3] - 2026-07-25 — Teams UI and enforced per-host access control

The Teams, host-groups and host-permissions primitives introduced earlier are now usable end to
end. Administrators get a new **Settings → Teams & Access** tab for managing teams, memberships,
host groups and explicit `view` / `operate` / `admin` grants.

- **Per-host enforcement.** Host visibility is filtered for non-admins, direct host details fail
  closed, and container/image/volume APIs now require `view` for reads and `operate` for mutations
  before contacting the daemon. Global administrators retain their existing bypass.
- **Safe rollout.** The compatibility default remains enabled after upgrade, so existing users keep
  their previous `operate` access until an administrator reviews grants and deliberately disables
  compatibility mode. The UI warns before that switch can lock ungranted users out.
- **Teams & Access UI.** Create/edit/delete teams and host groups, manage members, grant or revoke
  permissions for users or teams against a host or host group, and inspect existing grants from one
  screen. Access-control configuration endpoints are admin-only.
- **Default-host correctness.** The API alias `hostId=0` now resolves consistently to the persisted
  default-host row for grants, effective permission checks and listings. Re-granting the same
  subject/target updates the existing row instead of creating a duplicate.
- **Frontend resilience.** If a saved host becomes invisible after an ACL change, the selector falls
  back to the first visible host. New interface text is translated in all 11 locales.

## [8.21.2] - 2026-07-24 — Fix: promote/redeploy dialog flashed open then closed itself

Picking a stack in **Promote existing stack** (8.21.1) opened the Deploy dialog for a split second,
then it vanished on its own — same for **Edit & redeploy** in the View YAML dialog (8.21.0).

- **Root cause.** `Modal` is a singleton: `Modal.close()` schedules a 200 ms cleanup timeout that
  hides the overlay and clears its content. Both flows called `Modal.close()` and *then* immediately
  opened the Deploy dialog — so ~200 ms later the stale close-timeout wiped the dialog that had just
  opened.
- **Fix.** Don't `Modal.close()` before chaining to the Deploy dialog — since the modal is a
  singleton, opening the next dialog already replaces the content in place. The Deploy dialog now
  stays open for review. Frontend-only; no backend/db/deps.

## [8.21.1] - 2026-07-24 — Swarm: promote an existing stack from the Stacks tab

You can now push an existing single-host Compose stack into the swarm **without leaving the Swarm
page**. The Swarm → Stacks tab gains a **Promote existing stack** button next to *Deploy Stack from
YAML*.

- **Picker modal.** The button opens a dialog listing the single-host Compose stacks running on the
  host (name + running/total). Pick one → its compose YAML is loaded (via the existing
  compose-config resolver) and handed to the *Deploy Stack* dialog **pre-filled** so you review the
  YAML and the swarm "skipped fields" warnings before confirming.
- Previously this promotion was only reachable from `#/stacks` → open a stack → *Deploy to Swarm*.
  Same underlying flow (audited as `swarm_stack_from_local`), now also available where you'd expect
  it — on the Swarm page. Available in the empty state too, so a fresh swarm can be seeded from a
  running compose stack in two clicks.
- Frontend-only: reuses the existing `getStacks` / `composeConfig` endpoints and the deploy dialog.
  No backend, database, or dependency changes. 6 new strings in all 11 locales.

## [8.21.0] - 2026-07-24 — Swarm: export compose YAML from an existing stack

The Stacks tab now works both ways. Alongside **Deploy Stack from YAML** (which *writes* a stack from
YAML), each stack row gets a **View YAML** button that *reads* — it reconstructs an editable compose
YAML from the running services and shows it in a dialog.

- **View YAML per stack.** Reconstructs a compose from the stack's services — image (digest stripped),
  command, environment, published ports, user labels (compose/stack bookkeeping stripped), and
  `deploy` (replicas / global mode / non-default restart_policy / placement constraints). It's the
  faithful inverse of the deploy mapping, so an export → redeploy round-trips for the supported
  surface.
- **Copy + Edit & redeploy.** Copy the YAML to the clipboard, or hand it straight to the
  *Deploy Stack from YAML* dialog (pre-filled) to tweak and redeploy.
- **Honest about gaps.** Anything the deploy flow can't round-trip — volumes/mounts, secrets,
  configs, custom networks, healthchecks — is listed as a note in the dialog rather than silently
  dropped.
- **Admin-only + audited** (`swarm_stack_export`): the export embeds each service's environment,
  which can carry sensitive values. New endpoint `GET /api/swarm/stacks/:name/compose`. Reverse
  derivation is a pure, unit-tested function (`deriveComposeFromStackServices`). No new dependencies
  (reuses the `yaml` package already used by deploy). 11 new tests; strings in all 11 locales.

## [8.20.4] - 2026-07-24 — Fix: sidebar showed raw i18n keys for 9 newer pages

Nine navigation items rendered their raw key (e.g. `nav.posture`, `nav.copilot`) in the sidebar and
spammed the console with `[i18n] Missing` warnings.

- **Root cause.** The sidebar sets each label via `i18n.t('nav.' + dataPage)`, but nine newer pages
  never had a `nav.*` key: `posture`, `blueprints` (Reconciler), `copilot`, and the six alpha
  fleet-daemon pages (`incus-instances`, `proxmox-resources`, `migration-vm`,
  `kubernetes-resources`, `nomad-jobs`, `vsphere-resources`). `i18n.t()` returns the key verbatim on
  a miss, so the sidebar literally displayed "nav.posture" etc. (posture/blueprints/copilot are
  always visible; the fleet pages show only when that daemon exists — which is why the labels looked
  fine until now).
- **Fix.** Added all 9 keys to every locale, with proper translations. Verified all 37 `data-page`
  slugs in `index.html` now resolve to a `nav.*` key, and all 11 locales stay at exact parity.
- **Note:** the `Cross-Origin-Opener-Policy header has been ignored` message is not a bug — browsers
  ignore that hardening header over plain HTTP on a LAN IP. It disappears behind HTTPS (Caddy).

## [8.20.3] - 2026-07-24 — Fix: Swarm Stacks tab no longer 503s on a non-swarm host

Opening the **Stacks** tab on a host that isn't a swarm manager threw a raw
`503 Service Unavailable` / "Internal server error" in the console.

- **Root cause.** Unlike the Nodes/Services/Tasks tabs, the Stacks tab called `GET /api/swarm/stacks`
  without first checking whether swarm is active. On a non-manager host the Docker daemon answers
  `listServices` with "This node is not a swarm manager" (HTTP 503), and the route had no
  `try/catch`, so it bubbled up as a generic 503.
- **Frontend fix.** The Stacks tab now guards on swarm status first (like its sibling tabs) and
  shows *"Swarm is not active on this host."* instead of erroring.
- **Backend fix (defense in depth).** The `GET /nodes`, `/services`, `/tasks` and `/stacks` list
  routes now catch daemon errors and return a **humanized 400** (e.g. *"This host isn't a swarm
  manager yet. Initialize a swarm here first…"*) instead of leaking a raw 503 "Internal server
  error". 4 new regression tests.

## [8.20.2] - 2026-07-24 — Swarm init failures stay put in a visible card

When **Initialize Swarm** fails, the reason no longer vanishes with a transient toast.

- **Persistent error card.** The (already humanized) failure reason is now pinned into a
  dismissible red card directly under the *Initialize Swarm* button — so an operator who glances
  away doesn't lose an actionable message like *"This host's Docker has live-restore turned on,
  which can't be used together with swarm mode — set `live-restore: false` in
  `/etc/docker/daemon.json` and restart Docker, then try again."* The toast still fires for
  immediate attention; the card is the durable record. It clears automatically on the next attempt
  and can be dismissed manually. Two new strings (`pages.swarm.initFailedTitle`,
  `initFailedHint`) added to all 11 locales.
- **i18n parity fix.** Removed an orphaned `pages.containers.healthCheckStatus` key that existed
  only in Romanian (unreferenced in code), restoring exact key parity across all 11 locales.

Frontend-only + i18n. No backend, database, or dependency changes.

## [8.20.1] - 2026-07-24 — i18n: the new Deploy-to-Swarm strings translated everywhere

The `pages.swarm.*` strings added in 8.20.0 shipped in English + Romanian only. They're now
translated into the remaining 9 languages (de, es, fr, it, ja, ko, pt, zh, tlh), so all 11 locales
are back to 100% key parity with English (1694 keys).

## [8.20.0] - 2026-07-24 — Deploy to Swarm — promote a container or an existing stack

You can now push already-existing workloads onto a swarm without re-entering everything by hand.

- **Container → service.** A standalone container gains a **Deploy to Swarm** action (container
  detail) that derives a proposed service spec from its `docker inspect` — image, env, command,
  published ports, cleaned labels (compose/stack bookkeeping stripped), and a mapped restart
  policy — then opens the swarm "Create Service" dialog **pre-filled** so you review/adjust before
  creating. A prominent warnings panel flags everything that doesn't map cleanly to a service:
  bind mounts (must exist on all nodes), named volumes (node-local), `-it`/tty, `network_mode:
  host`, `--privileged`, `--device`, legacy `--link`, entrypoint overrides, and that published
  ports become ingress/routing-mesh ports.
- **Existing stack → swarm.** A single-host compose stack gains a **Deploy to Swarm** action that
  loads its compose YAML (via the existing compose-config resolver) and hands it to the swarm
  stack-deploy flow for review.
- Both surface a **clear, humanized message** when the target host isn't an active swarm manager
  (initialize/join a swarm first) instead of a 500. Admin-gated + audited
  (`swarm_service_from_container`, `swarm_stack_from_local`).

No new database or dependencies — a thin bridge over the existing swarm create/deploy. Derivation
is a pure, unit-tested helper (`src/services/swarm-derive.js`). 16 new tests — suite at **2185
passing across 132 suites**. New UI strings in en + ro (other locales fall back to English until a
follow-up backfill).

## [8.19.3] - 2026-07-24 — Human-friendly Docker error messages

Raw Docker daemon errors (e.g. `(HTTP code 500) unexpected - --live-restore daemon configuration is
incompatible with swarm mode`) are now translated into plain, actionable language. New shared
`humanizeDockerError()` maps the common cases — live-restore vs swarm, multi-homed advertise
address, already-in-a-swarm, port already in use, no-such-container/image, out-of-disk, connection
refused / timed out / SSH auth failed — to a short "what went wrong + how to fix it" sentence, and
cleans up anything it doesn't recognise instead of leaking the HTTP-code preamble. Applied to Swarm
init/leave and System → Prune. Example: the swarm live-restore failure now reads *"This host's
Docker has 'live-restore' turned on, which can't be used together with swarm mode. On that host, set
'live-restore': false in /etc/docker/daemon.json and restart Docker, then try again."* 13 tests.

## [8.19.2] - 2026-07-23 — Fix: Swarm init/leave surface the real Docker error

Initializing a swarm returned a bare **"Internal server error"** (500) with no explanation — the
route funnelled the daemon's error through the generic handler. `POST /api/swarm/init` and
`/leave` now return the actual Docker message plus a hint for the common footguns, e.g.:
`--live-restore daemon configuration is incompatible with swarm mode — set "live-restore": false in
/etc/docker/daemon.json on that host and restart Docker, then retry` (also covers multi-homed hosts
that need an advertise address, and hosts already in a swarm).

## [8.19.1] - 2026-07-23 — Fix: prune "socket hang up" on large build cache / image sets

Pruning a large build cache (or image set) failed with **`socket hang up`**. Root cause: the
shared Docker connection has a 30-second per-request timeout, and a prune that runs longer than
that (a multi-GB build cache can take minutes) had its socket cut mid-request. Prune now uses a
dedicated connection with a **15-minute** timeout; every other request keeps the 30 s default.
Confirmed against a real host: a 13 GB build-cache prune that previously hung up now completes.

## [8.19.0] - 2026-07-23 — Full i18n coverage (all 11 languages) + prune run-log + version-notification fix

### Fixed — the "new version available" notification showed a raw key
The update toast called `i18n.t('common.newVersionAvailable')` and `i18n.t('common.reload')`, but
those strings were defined under `errors.*`. Since a missing key falls through to returning the key
itself, the notification rendered the literal text **`common.newVersionAvailable`** — in every
language, English included. The keys now live under `common` (where the code looks), translated in
all 11 locales.

### Translations — every locale brought to 100% key parity
A full audit found the 10 non-English locales were only **~60% translated** (German 59%, Romanian
86%, the rest ~60%) — roughly **669 keys missing each**, covering all recent features (onboarding,
firewall write, posture, reconciler, Copilot…) plus whole groups (`updates.*`, `login.*`, `nav.*`,
`errors.*`). All missing strings were translated and every locale (de, es, fr, it, ja, ko, pt, ro,
zh, tlh) is now at **100% parity with English** (1684 keys), interpolation tokens (`{{version}}` …)
preserved, product/technology names kept untranslated.

### Added — System → Prune session run-log
Each Prune tile now keeps a **session run-log** beneath it: for every prune you trigger it records
when it started, when it finished, how long it took, whether it succeeded or failed (with the error
if not), and how much space was reclaimed — shown as sub-cards, newest first. The log lives for the
open session (cleared on a full page reload). Fully translated.

No backend changes; suite unchanged at 2156 passing across 130 suites. Zero new npm dependencies.

## [8.18.1] - 2026-07-22 — Fix: System → Prune now reclaims build cache + all unused images

Prune ran but "Disk Usage barely changed" because it skipped the two biggest reclaimable items.

- **Build cache is now pruned.** `dockerService.prune()` previously ignored build cache entirely;
  it's frequently the single largest reclaimable item (`docker builder prune`). Added a **Prune
  Build Cache** tile, and **Prune Everything** now covers it too (== `docker system prune -a
  --volumes` + build cache).
- **Image prune now removes ALL unused images**, not just dangling — matching the `docker image
  prune -a -f` the UI already advertised (previously it only removed untagged layers, reclaiming
  almost nothing on a real host).
- **The reclaimed-space total is now reported.** The API returns an aggregated top-level
  `SpaceReclaimed`, so the post-prune toast finally shows how much was actually freed (it was
  always reading a field that didn't exist → always 0).

Verify: **System → Audit** logs every `system_prune`, and the toast now reports the bytes freed;
`docker system df` on the host confirms the drop.

The final phase of the Onboarding & Provisioning Wizard. The four-phase feature is now complete:
guided setup (v8.15.0), templates + onboarding-as-code (v8.16.0), demo/trial + mock data
(v8.17.0), and now entities, drift and lifecycle.

### Entities & relationships
A generic, template-definable graph — migration `094` adds `tenant_entities` +
`tenant_entity_relations` (both seed-taggable and purgeable). The same two tables model a
homelab's Site→Host→Service or a plant's Site→Department→Line; typing lives in `entity_type` /
`relation_type` + metadata, not in schema. A new idempotent `seed_entities` provisioning step and
a fully-editable wizard step 6 create them; templates may pre-fill entities/relations (safe —
unlike users, an entity grants no access and authenticates nobody, so a preset can never mint a
principal).

### Drift re-provision
`engine.replan()` + `POST /api/onboarding/tenants/:id/replan` return a read-only
`toCreate / toUpdate / inSync` diff of a declaration against an existing tenant (settings, modules,
nomenclatures, entities, relations, hosts, users) — converged through the existing idempotent
apply, so re-running is safe and never duplicates.

### Trial lifecycle
Trial tenants get a `trial_expires_at` (`DD_TRIAL_DAYS`, default 14). An hourly monitor
(unref'd, like the reconciler/posture monitors) suspends expired trials — notify + audit
`tenant_trial_expired` — and warns once a few days out; the suspend is structurally idempotent
(`WHERE status != 'suspended'`), so restarts never re-fire. `extend-trial` and promote-to-production
reactivate. Suspension is intentionally lightweight (mark + notify + surface) — the tenant seam is
a logical grouping, not a security boundary.

### UX
Per-field inline validation across the wizard (`aria-invalid` + red border + message on the exact
offending input, auto-clearing on edit).

Migration `094`. 4 new audit actions. 25 new tests — suite at **2156 passing across 130 suites**.
Zero new npm dependencies. The onboarding wizard is usable from the UI, the REST API, and a
headless `DD_ONBOARD_FILE` at deploy time.

## [8.17.0] - 2026-07-22 — Onboarding Phase 3 — Demo/Trial modes + synthetic mock data

Phase 3 of 4. A prospect can now pick **Demo** (or **Trial**) in the onboarding wizard and land
in a fully populated app — a believable estate to click through immediately — with zero real
infrastructure and zero risk to real data.

### Deterministic, synthetic-only generator
A hand-rolled generator (mulberry32 seeded PRNG — no new deps) populates a demo tenant across
hosts, containers, stats history, events, firewall rules + snapshot, posture snapshot + a
critical finding, blueprints, teams, registries, and a valid audit trail. Three volume profiles
(**small ≈ 3.8k / medium ≈ 13k / large ≈ 32k rows, < 25 MB**) and three scenarios
(healthy-shop, busy-estate with drift, multi-daemon-plant). Identical inputs produce a
byte-identical dataset.

### Safe by construction
- Every generated row is tagged `seed_run_id`; **real rows are `NULL`**, so reset / regenerate /
  purge run `DELETE … WHERE seed_run_id = ?` and are **structurally incapable** of touching real
  data (proved by a canary test). Table names come only from a static allow-list, never data.
- All addresses are RFC1918/TEST-NET, all hostnames use reserved `*.test`/`*.example` TLDs, demo
  users are **viewer-only**, and even the fake credentials are AES-encrypted at rest. No real or
  PII data, ever. The `docker_events` bloat lesson is encoded: hard row budgets and **no `exec_*`
  events**.
- **Mock Docker adapter** — demo hosts have no daemon, so a narrow, isolated adapter serves the
  synthetic container roster + stats. It engages **only** for a host whose `seed_run_id` is set
  with an active dataset; real hosts are byte-for-byte unaffected, and it refuses every mutation
  rather than faking success.
- **Production promotion gate** — a tenant cannot be switched to `production` while any synthetic
  batch or placeholder credential remains; the gate returns actionable blockers, and going live
  requires purging the demo data first.

### Wizard
Demo/Trial are enabled in step 0; a new **Mock data** step picks the volume profile (with live row
estimates) and scenario; the summary gains **Reset / Regenerate / Purge** demo-data actions and a
promotion warning. Production hides mock-data entirely. (en/ro.)

Migration `093` (+ a guarded `seed_run_id` column across 26 seedable tables + the `seed_containers`
roster). New audit actions for seed lifecycle + tenant promotion. 47 new tests — suite at **2131
passing across 129 suites**. Zero new npm dependencies.

## [8.16.0] - 2026-07-22 — Onboarding Phase 2 — templates, nomenclatures & onboarding-as-code

Phase 2 of 4. Turns the Phase-1 wizard into a repeatable, scriptable onboarding system.

### Environment templates
Four built-in presets ship as JSON files in `src/db/onboarding-templates/` — **Minimal**,
**Manufacturing Plant** (metric/EUR, shift + production-line nomenclatures), **MSP Client**
(multi-site, service tiers), **Software Team** (dev/staging/prod). They are re-imported at every
boot with the **file as source of truth** (howto-loader pattern), so authoring a preset means
dropping a file — no migration. Picking a template pre-fills modules, regional settings and
nomenclatures; **your explicit choices always win** over the template's.

Security note: a template may describe modules/regional/nomenclatures but is **never allowed to
create accounts** — `users`/`roles` are deliberately not merged into a declaration, so an imported
preset cannot mint privileged users during an unattended headless apply.

### Nomenclatures
New per-tenant `nomenclatures` table (migration `091`) — environments, shifts, production lines,
sites, service tiers, severities and more (13 validated kinds) — seeded by a new idempotent
provisioning step with its own compensation.

### Onboarding as code
Point **`DD_ONBOARD_FILE`** at a declaration document and a fresh container comes up fully
provisioned with zero click-path — the same validated declaration the wizard posts, applied
through the same saga. It is **strictly limited to an empty instance**: the gate refuses if setup
is already complete, if any non-default tenant exists, or if any provisioning run has completed —
and **fails closed** if instance state can't be verified. On an already-configured install it
logs a warning, writes nothing, and boots normally; it runs after the admin seed so an instance
can never end up adminless, and the file's contents are never logged or audited.

Also: save any completed run as a reusable template, or export one directly
(`GET /runs/:id/export?asTemplate=1`). Templates and exports never contain credentials —
`validateTemplateSpec` rejects secret-shaped keys outright rather than silently stripping them.

Migrations `091`–`092`. 4 new audit actions. 48 new tests — suite at **2084 passing across 128
suites**. Zero new npm dependencies.

## [8.15.0] - 2026-07-22 — Onboarding & Provisioning Wizard — Phase 1 (tenant model + saga engine + wizard)

A professional, guided initialization flow for a new **tenant / client / plant** — usable at a
fresh deployment or when onboarding a new customer. Phase 1 of 4 (deep-spec + feature-spec in
`plans/`); it ships the foundation and the full **production** onboarding path. Demo/trial mock
data arrives in Phase 3.

**Architecture decision:** docker-dash stays single-binary and self-hosted — we did NOT bolt on
full multi-tenancy. Instead this adds an **Environment Provisioning** layer with a
forward-compatible tenant seam: a `tenants` table with an auto-seeded default row, and
`tenant_id` plumbed only through the new provisioning tables. **No `tenant_id` retrofit on any
existing table**, so every existing feature is untouched. Real isolation remains at the
deployment level (each client = their own instance) — the strongest isolation available — while
the seam makes future logical multi-tenancy an additive migration rather than a rewrite.

### Provisioning engine (saga)
- Migrations `088`–`090`: `tenants` / `tenant_settings` / `user_tenants` (+ default tenant,
  partial-unique index enforcing exactly one default), `provisioning_runs` /
  `provisioning_steps`, `tenant_modules`.
- **Idempotent, resumable, rollback-able**: `plan` (dry-run: impact estimate + warnings, no
  writes) → `apply` → `resume` → `rollback`. Steps split `db` (synchronous, transaction-wrapped)
  vs `external` (outside any transaction, with an explicit compensation). Three-layer
  idempotency — unique run key, `UNIQUE(run_id, step_key)`, and natural-key upserts — so
  re-running the same declaration never duplicates anything.
- Safe compensations: the tenant-delete pivot **refuses to touch the default tenant**, and user
  rollback **deactivates** rather than deletes (shared user pool).
- 7 steps: create_tenant → set_regional → enable_modules → create_hosts → create_users →
  grant_permissions → finalize.

### Declaration document (onboarding-as-code foundation)
A validated `onboarding-declaration` v1 doc drives provisioning. The validator is a strict trust
boundary: whitelist-canonicalized (unknown keys dropped), recursive prototype-pollution guard,
bounded volumes, strict field domains — and it **rejects any wire-supplied `tenant_id`/`org_id`**
(the tenant is derived server-side). **Least-privilege enforced:** demo/trial declarations may
not create an `admin`, and at most one owner per run.

### Secrets
Host credentials and user passwords are `crypto.encrypt`'d **on ingest**, decrypted only in-process
into their real homes (encrypted `ssh_config`, bcrypt hash), then wiped from the stored input on
success. Every response, run/step JSON, and the golden-config export are redacted — no plaintext
or ciphertext ever leaves the server.

### Wizard UI
New admin-only `#/onboarding` page plus a reusable `Wizard` primitive (`public/js/components/wizard.js`)
— a vanilla-JS render() state machine (no framework, no new deps): full-viewport stepper with a
rail (segmented progress under 900px), per-step validation gating, focus management, and debounced
persistence. Nine steps: mode/template → organization identity → regional (locale/timezone/currency/
units/formats, defaulted from `Intl`) → modules → servers & connections (with **live connection
testing**) → users, roles & starter grants → **dry-run preview with impact counts + warnings** →
live provisioning (per-step progress, Retry-step / Roll-back on failure) → summary + golden-config
export. Resumes an interrupted run on launch. Full `pages.onboarding.*` i18n (en + ro).

Admin-only, fully audited (10 new audit actions). 58 new backend tests — suite at **2036 passing
across 127 suites**. Zero new npm dependencies.

## [8.14.0] - 2026-07-22 — Hypervisor firewall WRITE — Phase C: Incus / LXD (series complete)

Incus/LXD network-ACL rules are now **writable** from the Firewall page — the final phase of
hypervisor firewall write. All three hypervisor backends (Proxmox, ESXi, Incus) now share one
commit-confirmed safety pipeline.

- **Operations:** add / remove an ingress or egress rule on an existing network ACL
  (validated action/state/protocol/source/destination/ports). Creating or deleting whole
  ACLs — and **attaching** ACLs to NICs/networks — stay out of scope (attachment is manual).
- **Attachment caveat, surfaced everywhere:** an Incus ACL only filters traffic once it's
  attached to a NIC or network, which docker-dash does not manage. Each ACL shows an
  attached/unattached badge, and the warning is repeated in the add-rule + confirm dialogs.
- **Commit-confirmed pipeline (shared with Proxmox/ESXi):** every change is validated,
  snapshotted (fail-closed), and applied **provisionally** with an auto-revert deadline
  (`DD_PLATFORM_CONFIRM_MINUTES`, default 5) unless confirmed. Revert declaratively restores
  the affected direction from the pre-change snapshot. Lockout risk is inherently low here
  (an unattached ACL can't sever access), so the guard is light: it only warns on an unscoped
  inbound drop/reject to an ACL that's already in use.
- Read-modify-PUT preserves the full ACL (`description`/`config`/both rule arrays) — no field
  is clobbered. New `IncusClient` methods `getNetworkAcl`/`updateNetworkAcl`. Reuses migration
  `087` (no new schema). 31 new tests (suite: **1978 passing / 123 suites**). Zero new npm deps.

### Hypervisor firewall write — series complete
Proxmox (8.12.0) → ESXi/vSphere (8.13.0) → Incus/LXD (8.14.0). Every mutation across all three
runs the same guard → snapshot → provisional apply → commit-confirmed auto-revert flow, so a
change that locks you out un-does itself.

## [8.13.0] - 2026-07-22 — Hypervisor firewall WRITE — Phase B: ESXi / vSphere

ESXi/vSphere firewall is now **writable** from the Firewall page (was read-only status).
Phase B of hypervisor firewall write; it rides the same commit-confirmed safety pipeline as
Phase A (Proxmox). ESXi is the highest lockout risk of the three — an `esxcli` firewall
change over SSH can lock docker-dash out of the host — so the safety net is mandatory here.

- **Operations (ruleset-level):** enable/disable a firewall ruleset, add/remove an allowed
  IP/CIDR on a ruleset, toggle a ruleset's allowed-all. Whole-firewall on/off is deliberately
  out (too blunt).
- **ESXi lockout guard:** refuses disabling the SSH management ruleset (`sshServer`), refuses
  removing an allowed IP that would leave *your* IP uncovered for SSH, and refuses turning off
  allowed-all when the explicit allow-list wouldn't cover you. Fail-closed: any state that
  can't be positively verified as keeping you connected is refused.
- **Commit-confirmed auto-revert (mandatory):** every ESXi change applies **provisionally**
  and auto-reverts after `DD_PLATFORM_CONFIRM_MINUTES` (default 5) unless confirmed — a change
  that locks you out simply un-does itself. Live countdown banner with Confirm / Revert now.
- **Injection-safe:** all esxcli commands are fixed templates; the only interpolated tokens
  are a whitelisted ruleset-id (`[A-Za-z0-9_.-]`), a `validateCidrOrIp`-checked address, and
  literal booleans — over a write-only SSH module kept separate from the read path.

New `src/services/vsphere-ssh-write.js`; ESXi validation + lockout guard + revert added to the
shared `platform-write.js` pipeline (reuses migration `087`, no new schema). 26 new tests
(suite: **1947 passing / 122 suites**). Incus is Phase C. Zero new npm deps.

## [8.12.0] - 2026-07-22 — Proxmox firewall WRITE (Phase A) + docker_events bloat fix

### Hypervisor firewall write — Phase A: Proxmox

The Firewall page can now **mutate** a Proxmox host's firewall (was read-only status).
This is Phase A of hypervisor firewall write (deep-spec in `plans/`); ESXi and Incus
follow in their own phases and stay read-only until then. Writing a firewall rule on a
hypervisor can lock you out of the host itself, so every mutation runs a safety pipeline
**stricter than the Linux one**:

- **Validate** against a Proxmox rule schema (type/action/source/dest/proto/dport,
  reusing the existing validators; unconstrained rules refused).
- **Extended lockout guard** — refuses enabling the firewall unless an ACCEPT rule
  protects **SSH (22)** and **PVE web (8006)** for *your* IP; refuses an unscoped
  `DROP`/`REJECT` of a management port (an explicit `0.0.0.0/0` // `::/0` source counts
  as unscoped — hardened in review); refuses blocking your own IP; refuses removing the
  only ACCEPT that protects your management access while the firewall is enabled.
- **Snapshot before mutate** (fail-closed — no change without a rollback source).
- **Commit-confirmed auto-revert** — every change applies **provisionally** and
  auto-reverts after `DD_PLATFORM_CONFIRM_MINUTES` (default 5) unless you confirm it.
  If a rule locks you out you can't confirm → it rolls back → access restored. A live
  countdown banner offers **Confirm / Revert now**.
- **Audited** end to end (`firewall_platform_apply/remove/confirm/revert/auto_revert`).

New: `ProxmoxClient` firewall write methods, migration `087` (`platform_firewall_changes`),
`src/services/firewall/platform-write.js`, `POST /:hostId/confirm-change` +
`/revert-change` + `GET /:hostId/pending-changes`, write controls in the platform
firewall UI (admin-only, gated on a `writesSupported` capability flag).

### Fixed — docker_events database bloat (healthcheck exec noise)

On busy hosts, `docker_events` grew to tens of GB (observed: a 31 GB DB, ~26 GB of it this
one table, 19.4M rows in ~4 days). Root cause: every container **healthcheck** emits three
`exec_create`/`exec_start`/`exec_die` events every few seconds, and all of them were being
persisted — >95% of rows were healthcheck noise with no diagnostic value, and 3-day
retention couldn't keep up with the volume. docker-dash now **skips persisting `exec_*`
events** (they're still broadcast live to the UI and fed to the crash/OOM/health notifier —
only the DB write is skipped). Opt back in with `DD_STORE_EXEC_EVENTS=true`. This stops the
growth; a one-time reclaim (delete existing exec rows + `VACUUM`) recovers the space.

## [8.11.0] - 2026-07-21 — Connection Health & Circuit Breaker for managed hosts

When a managed host's SSH credentials changed (password rotated, key replaced),
docker-dash used to retry forever on exponential backoff — flooding the log with
`SSH error … All configured authentication methods failed` every cycle and stalling
on-demand callers like `sandbox-ttl-sweep` on a fresh 20s connect timeout each time.

Now each host has a **connection-health circuit breaker**:

- After **4 consecutive auth/host-key failures** on a host **confirmed reachable by a
  raw TCP probe**, the circuit opens: auto-reconnect stops, the host is marked
  `auth_failed` / paused, and a **"Needs credentials"** amber badge + the failure
  reason + timestamp surface on the Hosts page — so you see *which* host and *why*.
- **Transient failures are never paused.** Refused / timeout / unreachable keep the
  existing infinite backoff untouched — a host that's merely down or briefly
  unreachable still recovers on its own. Only a *reachable-but-rejected* auth failure
  (a real credential problem needing a human) trips the breaker.
- **Resume paths:** updating the host's credentials (`PUT /hosts/:id`) clears the
  circuit automatically; a one-click **Retry** (`POST /hosts/:id/reconnect`, admin +
  audited) forces a fresh attempt. A successful reconnect auto-detects recovery
  (audit `host_conn_recovered` + notification).
- A warning notification + audit (`host_conn_paused`) fire **once** on the transition
  to paused — not on every failure.

Every hook into the core connection path (`ssh-tunnel.js`, `docker.js`) is additive
and `try/catch`-wrapped: a healthy host's connect path is behaviourally unchanged, and
a bug in the breaker can never break connectivity. Migration `086` adds
`conn_state / conn_failures / conn_last_error(_at) / conn_reachable / conn_paused
(_reason/_at)` to `docker_hosts`. New service `src/services/connection-health.js`
(classify → probe → record → pause/resume). Threshold overridable via
`DD_CONN_FAIL_THRESHOLD`. 37 new tests; suite at **1893 passing across 120 suites**.
Zero new npm deps.

## [8.10.0] - 2026-07-14 — **PLATFORM**: Security Posture + Reconciler + Ops Copilot, graduated to stable

Graduates the `8.9.22`–`8.9.45` alpha line to a stable minor. This is the release
where docker-dash stops being "a Docker UI with a firewall page" and becomes a
**self-hosted estate control plane**: it scores your security posture, converges
your infrastructure to a declarative desired state, and reasons across all of it —
all local-first, zero telemetry, zero new npm dependencies, single binary.

Three new pillars ship together, plus a hardened firewall subsystem.

### Security Posture — the estate's security grade

A unified, weighted security score (A–F) across your whole estate, computed from
live checks — findings are **never persisted** (only the score snapshot is, for trend).

- **Checks:** hard-coded secrets, RBAC weaknesses, insecure Docker daemon config,
  firewall drift, world-open sensitive exposed ports, egress policy, vSphere/ESXi
  EOL + CVE, and now **Proxmox and Kubernetes** hosts (TLS-verification-disabled +
  unencrypted stored credentials, read-only from existing connection config).
- **One-click safe remediation** for findings whose fix creates no new exposure
  (e.g. re-apply drifted firewall rules through the lockout guard). Risky fixes stay
  guided-only.
- **Mutes**, **trend snapshots**, a **regression-alerting monitor** (in-app alert +
  `posture_regression` audit when the score drops ≥10 or a new critical appears),
  and a **posture grade pill** in the Dashboard header linking straight to Posture.

### Reconciler — declarative desired-state (GitOps for your estate)

A Git-friendly JSON "blueprint" describes what SHOULD exist; docker-dash converges
reality to it — self-hosted, no telemetry.

- **Firewall + containers:** blueprints declare firewall rules AND containers that
  should be running per host. Plan shows a read-only per-host diff; Apply converges
  through the firewall lockout guard + snapshot + audit, and **only starts** stopped
  containers (never stops/deletes anything; Docker/Podman hosts only).
- **Capture / Plan / Apply / Export / Import** round-trip the JSON so Git is your
  source of truth.
- **Sync from a remote URL (new):** a blueprint can pull its desired-state JSON from
  a remote HTTPS endpoint (raw GitHub/GitLab or any HTTP URL) — Node stdlib https,
  10s timeout, optional **encrypted** Bearer token, validated before storing, and it
  never overwrites a good doc on a failed fetch. On-demand ("Sync now") or best-effort
  scheduled, folded into the drift monitor.
- A **drift monitor** alerts on divergence (delta-deduped); an opt-in **Enforce**
  toggle auto-applies to converge.

### Ops Copilot — local-first, cross-layer advisor

A security/ops advisor that correlates signals docker-dash already has (posture,
firewall/blueprint drift, ESXi EOL/CVE, exposed ports, egress, inventory, recent
activity) into a prioritized "what to fix first" briefing with deep-links.

- **Tier 1** is fully rule-based — zero setup, no LLM, works out of the box.
- **Tier 2 (optional):** bring your own OpenAI-compatible endpoint (local Ollama /
  LM Studio / any URL you set) for natural-language briefing + Q&A. No bundled model,
  no telemetry: a **secret-free** context bundle is sent ONLY to your endpoint (local
  Ollama = nothing leaves the box), the API key is encrypted at rest and never
  returned, and the copilot is **advise-only** — it never executes anything.
- **Actionable recommendations:** briefing items that map to a safe fix offer an
  "Apply fix" button reusing the guarded Posture remediation path.
- **Persisted conversation history (new):** the Copilot now remembers its Q&A across
  reloads (new `copilot_history` table, "Clear history" button — admin, audited).
  Only the literal question/answer text is stored; the context bundle is never persisted.

### Firewall — hardened into a real per-host manager

Building on the `8.9.22` MVP: **temporary rules with auto-expiry**, **nftables** and
**Windows Firewall (PowerShell over SSH)** backends, **drift detection + re-apply**,
fine-grained **RBAC** (viewer/operator/admin), **audit export** (CSV/JSON) with
manual-rule awareness, a **mutual-TLS** channel for the firewall-agent, a proactive
**drift-alerting monitor**, and **read-only firewall status** for ESXi/Proxmox/Incus.
SSH execution hardened for non-root, key-auth hosts: `/usr/sbin` PATH, passwordless
sudo, optional per-host sudo password via `sudo -S` stdin, and a fix for scoped
`NOPASSWD` sudoers (no more `sudo -n true` capability probe). Incus fixes: own-host
resolution and the client-cert + trust-token flow.

### Under the hood

- Migrations `080`–`085` (firewall, posture, blueprints, copilot, copilot history,
  blueprint remote-source). All auto-apply at startup; monotonic.
- New background monitors (firewall drift, posture regression, reconciler drift/sync)
  — all `setInterval` + `unref`'d, ~15 min, best-effort.
- Test suite grew to **1856 passing across 119 suites**. Zero new npm dependencies
  across the entire line. Deep-specs + feature-specs for every pillar in `plans/`.

### Fixed

- Release deploys could silently leave a host on the previous image: piping the
  remote build through `tail` masked its exit code, so a failed build still reported
  "done" and `docker compose` kept launching the old image tag. Deploy verification
  now gates on the running `/api/health` version string on every target.
- `scripts/sync-version.js` compose-fallback regex didn't match pre-release
  (`-alpha.N`) fallbacks; the `docker-compose.yml` `APP_VERSION` fallback is now `8.10.0`.

## [8.9.22-alpha.1] - 2026-07-08 — Firewall management MVP1 (per-host, SSH/agent)

The Firewall page becomes a real per-host firewall manager (was local-only UFW
read). Deep-spec + feature-spec in `plans/`. Zero new npm deps.

**Architecture (adapted from the user's firewall-in-Docker doc):** the app
container has a read-only Docker socket and no NET_ADMIN, so it *cannot* touch the
local host firewall directly — matching the doc's "web app holds no host
privileges" thesis. Privileged work runs **outside** the container via two channels:
- **SSH** — reuses each host's live tunnel (`sshTunnelService.exec`) + stored
  encrypted credentials.
- **firewall-agent** — a standalone stdlib-only Node systemd service
  (`agent/firewall-agent/`, bearer token) for the local host / non-SSH hosts. It
  reuses verbatim copies of the same pure validation + builder modules.

**Backends:** iptables (+DOCKER-USER + conntrack `--ctorigdstport` for container
scope), firewalld (rich rules + reload), ufw (host-general; refused for container
scope). Auto-detected per host (firewalld → ufw → iptables).

**Operations (whitelisted):** allow-ip, block-ip, open-port, close-port,
allow-container-port, remove-rule, list, snapshot, rollback (iptables).

**Safety:** strict IP/CIDR/port/protocol/scope validation (dangerous chars
rejected); commands built from fixed templates with POSIX-quoted tokens (never
concatenated from UI); lockout guard (refuses closing the SSH/mgmt port for
everyone or blocking your own/admin IP); snapshot before every mutation; every
action audited (`firewall_*`); app rules tagged `APPFW uuid=…` and tracked in DB.

- Migration `080_firewall.js` (`firewall_rules`, `firewall_snapshots`).
- `src/services/firewall/*` (validate, backends, runner, lockout, service),
  `src/routes/firewall.js` (`/api/firewall/:hostId/*`), `public/js/pages/firewall.js`
  (multi-host UI: Rules + History tabs, Add-rule, Snapshot, Configure-agent).
- 22 new unit tests. Full suite: 1787 passing across 112 suites.
- OUT (later phases): Windows Firewall, temporary-rule auto-expiry, fine RBAC
  roles, mTLS, drift reconciliation.

## [8.9.16-alpha.1] - 2026-07-07 — SSH Key Deployer (System → Tools)

New admin tool that generates an SSH keypair and pushes the **public** key to a target host's `authorized_keys` in one step — with a manual-instructions fallback when automation isn't possible. Zero new npm deps (Node `crypto` for keygen, existing `ssh2` for transport).

**What ships:**
- `src/services/ssh-keygen.js` — ed25519 (default) / RSA-4096 keypairs via `crypto.generateKeyPairSync`. Node can't emit the OpenSSH public wire format nor an `ssh2`-parseable ed25519 private key, so both are built by hand: the `authorized_keys` line (`ssh-ed25519` / `ssh-rsa`, JWK → SSH string/mpint) and the `openssh-key-v1` private container for ed25519 (RSA uses PKCS#1, which `ssh2` reads). SHA256 fingerprint. 9 unit tests assert `ssh2` parses the output and the derived public blob round-trips.
- `src/services/ssh-deploy.js` — one-shot `ssh2` connect (initial password **or** an existing key, used once and never stored), idempotent append to `authorized_keys`. Path per target: Linux / Docker / Proxmox → `~/.ssh/authorized_keys`; ESXi → `/etc/ssh/keys-<user>/authorized_keys`. POSIX-quoted commands, friendly error mapping (SSH-off / auth-failed / unreachable). `testKey()` verifies login with the newly deployed key.
- `src/routes/ssh-keys.js` — `POST /generate|deploy|test|attach-vsphere`, `GET /vsphere-hosts`. Admin-only + `writeable` + audit-logged. Deploy failures return `ok:false` (not HTTP 500) so the wizard can render manual steps instead of erroring.
- `public/js/pages/ssh-key-deployer.js` — `SshKeyDeployer` wizard: target picker (Linux/Docker, ESXi, Proxmox/Linux, Git provider, manual), key options, one-shot connection, **Generate & Deploy**. Shows the public key + fingerprint + a one-time private-key download, live deploy status, and target-specific copy-paste instructions on failure or for manual targets. On ESXi success it offers to attach the private key to a vSphere host so the SSH Console + Hardware tab work immediately.
- **"SSH Key Deployer"** card in System → Tools (security category); dedicated wizard modal.

Full suite: **1761 passing** across 108 suites.

## [8.9.11-alpha.1] - 2026-07-06 — VMware vSphere / ESXi integration + Hosts docs tabs

### VMware vSphere / ESXi (new daemon type)

Read-only alpha covering both **standalone ESXi** (free / paid) and **vCenter Server**. Same SOAP API surface on `/sdk`. Zero new npm deps — hand-rolled SOAP client on stdlib `https` with tolerant XML regex parsing.

**What ships:**
- Migration 078 widens `docker_hosts.daemon_type` CHECK to include `'vsphere'`
- `src/services/vsphere.js` — `VSphereClient` with `login()`, `logout()`, `retrieveServiceContent()`, `listVMs()`, `listHosts()`, `listDatastores()`. Session cookie captured on login and reused. 20-min in-memory client cache in the routes layer to avoid re-login on every request.
- `src/routes/vsphere.js` — `GET /api/vsphere/{info, vms, hosts, datastores}`, all requiring auth
- `docker.js` `_getNonDockerInfo` dispatch: probes `/sdk` for product/version/API and populates the base info card
- `public/js/pages/vsphere-resources.js` — 3 tabs (VMs / ESXi Hosts / Datastores) with info card
- Sidebar entry **"vSphere / ESXi (alpha)"** gated `data-fleet-daemon="vsphere"`
- Wizard field on **Hosts → Non-Docker host (alpha)** — daemon type dropdown now offers "VMware vSphere / ESXi"; type-specific fields are endpoint + username + password + skipTlsVerify (default checked because ESXi ships with a self-signed cert)
- Howto `vsphere-integration.md` with dedicated read-only user recipe (both ESXi and vCenter), security notes, troubleshooting

**Positioning:** read-only by design. Power ops, snapshots, VM console, config editing → use the native vSphere client. The unique value is bridging: browse ESXi to decide what to migrate, then use Sprint 7 VM Migration to import into Proxmox.

### Hosts page docs — 3 cards → 3 tabs

The three previous sections under the hosts grid (**Supported daemon types**, **How Hosts work**, **SSH key setup**) collapsed into a single card with a 3-tab switcher. Only one visible at a time; selected tab persists to localStorage as `dd-hosts-docs-tab`. Simpler to scan, less scrolling on smaller screens.

The vSphere row is included in the daemon-types table with the wizard reference.

### Tests
- `vsphere-client.test.js` — **14 tests** (constructor validation, encryption round-trip, `fromHostRow`, XML `_extractTag` / `_extractFault` / `_extractObjects` helpers with fixture data, SOAP login envelope shape + cookie capture, missing-cookie failure).
- Full suite: **1704 passing** across 104 suites (was 1690/103).

### API additions
- `GET /api/vsphere/info` — ServiceContent (version, product name, API version, build)
- `GET /api/vsphere/vms` — VirtualMachine list (name, powerState, guestOS, memoryMB, numCPU, uuid, moref)
- `GET /api/vsphere/hosts` — HostSystem list (name, connectionState, model, CPU, memory, version)
- `GET /api/vsphere/datastores` — Datastore list (name, type, capacity, freeSpace, accessible)
- Frontend API helpers wired: `getVSphereInfo`, `getVSphereVMs`, `getVSphereHosts`, `getVSphereDatastores`

### Backward compatibility

- New daemon type; no existing rows touched
- No new npm deps
- Wizard is additive: existing 5 non-Docker types (Incus, LXD, Proxmox, Kubernetes, Nomad) unchanged

Deployed to VPS (`89.37.212.66:8101`) and LAN (`192.168.13.20:8101`).

## [8.9.10-alpha.1] - 2026-07-06 — Gap closure ship 4: Teams + Per-host access control

Ship 4. Closes the two Portainer P0 gaps that dominated the multi-tenant RBAC story.

### Closed
- **Portainer G01 Teams (P0, L) — CLOSED (foundation)**: migration 077 adds `teams` + `team_members` tables. Service `src/services/teams.js` with CRUD + `addMember`/`removeMember` + `teamsForUser(userId)` helper. Admin-only routes at `/api/teams`. Every mutation audit-logged (`team_create`, `_update`, `_delete`, `_member_add`, `_member_remove`). UI in follow-up.
- **Portainer G02 Per-host access control (P0, M) — CLOSED**: migration 077 adds `host_permissions` table with CHECK constraint: exactly one of `{host_id, host_group_id}` and exactly one of `{user_id, team_id}`. `permission IN ('view', 'operate', 'admin')`. Service `src/services/host-permissions.js` exposes `resolveEffectivePermission(userId, hostId, isAdmin)` — walks admin-global → direct user grant → team grant → host-group grant (via `host_group_members`), returning the highest-precedence permission. `filterVisibleHosts()` for the hosts-list-filter use case. Routes at `/api/host-permissions` + `/effective` + `/legacy-default`.

### Backward compatibility — `legacy_host_access_default` setting
Migration 077 seeds `settings.legacy_host_access_default='true'`. When enabled, the resolver returns `'operate'` for any non-admin user on any host with no explicit grants — preserving pre-upgrade behavior. Admin can toggle it off via `POST /api/host-permissions/legacy-default { enabled: false }` after configuring real permissions. Documented in the settings audit trail.

### Tests
- `teams-and-host-perms.test.js` — **13 tests**: teams validation + members CRUD + delete cascade; host permissions with direct grant, team grant, group grant, precedence, filter visible, legacy default. Full suite: **1690 passing** across 103 suites (was 1677/102).

### API additions
- `GET/POST/PUT/DELETE /api/teams`
- `POST/DELETE /api/teams/:id/members[/:userId]`
- `GET/POST/DELETE /api/host-permissions`
- `GET /api/host-permissions/effective?hostId=X`
- `GET/POST /api/host-permissions/legacy-default`
- Frontend API helpers wired: `listTeams`, `createTeam`, `updateTeam`, `deleteTeam`, `addTeamMember`, `removeTeamMember`, `listHostPermissions`, `grantHostPermission`, `revokeHostPermission`, `getEffectiveHostPermission`, `getLegacyHostAccessDefault`, `setLegacyHostAccessDefault`

### Migrations
- **077** — `teams`, `team_members`, `host_permissions`; seeds `settings.legacy_host_access_default='true'`.

### What's still open
- Frontend Teams management UI (Settings → Teams tab) — follow-up
- Wire `requireHostAccess(minLevel)` middleware into container/image/volume routes — follow-up (foundation is ready)
- Custom RBAC roles beyond fixed admin/operator/viewer (Portainer G11) — deferred; needs teams + per-host to shake out first

### Not shipped in this session (deferred with clear rationale)
- **Dockge G01** Compose event loop unblock (P0, M): requires SSE refactor of 6 `execFileSync` call sites in `system-stacks.js`. Design ready in gap-closure-vs-dockge.md; deferred to future sprint.
- **Dockge G02** CodeMirror YAML editor (P1, M): requires vendoring 200KB bundle under `public/vendor/`. Design ready; deferred.
- **Dockge G03** Stack-level log stream (P1, S): reuses existing WS `logs:subscribe` fan-out; deferred to follow-up.
- **Komodo G01** Multi-host git deploy UI polish + deep integration with `deployStack()`: partial in v8.9.7; deferred.
- **Komodo G03** User-invoked procedures (P1, M): needs schema for `procedures` + `procedure_runs`; deferred.
- **Komodo G04** Fleet-first UX polish (P1, S): sidebar tree + bulk actions; deferred.
- **Komodo G06** Cross-host build pipeline (P2, L): needs G05 build dispatch first; deferred to v9.0.
- **Komodo G07** GitOps export/import (P2, M): deferred.
- **Portainer G10** Proxmox noVNC console (P2, M): needs own deep-spec (browser connects directly to Proxmox); deferred.
- **Portainer G11** Custom RBAC roles (P2, M): deferred, needs G01/G02 field-tested first.

Deployed to VPS (`89.37.212.66:8101`) and LAN (`192.168.13.20:8101`).

## [8.9.9-alpha.1] - 2026-07-06 — Gap closure ship 3: volume browser + alerter routes + FS stacks + builder host + Uptime Kuma + docker-run UI

Ship 3. Closes 6 gaps across all three trackers.

### Closed
- **Portainer G07 Volume file browser (P1, M) — CLOSED (list + read + delete)**: `src/services/volume-browser.js` launches an ephemeral alpine container with the volume mounted (read-only for list/read, read-write for delete) and runs `ls -laF`, `head`, or `rm`. `_safePath` blocks path traversal — any user-supplied path that resolves outside `/data` throws. Routes: `GET /api/volumes/:name/{browse, read}` (auth) + `DELETE /api/volumes/:name/file` (admin). Upload deferred.
- **Komodo G05 Builder host concept (P2, S) — CLOSED (schema)**: migration 076 adds `docker_hosts.is_builder INTEGER DEFAULT 0` + `docker_hosts.default_registry_id`. Build dispatch logic in a follow-up minor. Documented in the tracker.
- **Komodo G09 Alerter routing (P3, S) — CLOSED**: `alert_channel_routes(scope_type, scope_id, channel_id, severity_min)` (migration 076). Service `resolve({hostId, severity})` walks precedence host → host_group → all with severity filtering. Route CRUD at `/api/alert-routes` + `/api/alert-routes/resolve` preview endpoint.
- **Dockge G04 Filesystem-first stacks discovery (P2, S) — CLOSED (backend)**: `src/services/stacks-fs.js` walks `DD_STACKS_DIR` (default `/opt/stacks`, comma-separated) up to depth 3, parses each `docker-compose.yml`, returns `{name, path, composeFile, services, serviceCount, source: 'filesystem'}`. Merge into `/stacks` route in follow-up.
- **Dockge G06 docker-run → compose converter UI (P3, S) — CLOSED**: new "Convert docker run" button next to "Create Stack" on the Stacks page opens a modal with a paste-command textarea, a Convert button that hits `/api/compose/convert` (v8.9.7 backend), and a read-only preview of generated YAML.
- **Dockge G08 Uptime Kuma auto-detect (P3, XS) — CLOSED (detect)**: `GET /api/integrations/uptime-kuma` scans containers for `louislam/uptime-kuma` image on the current host. Returns `{detected, container, url}` with the extracted public port. Monitor auto-registration deferred to follow-up.
- **Komodo G08 rollback — CONFIRMED ALREADY CLOSED**: `src/services/git.js:rollbackStack(stackId, deploymentId)` restores any previous deployment. Deeper than Komodo's previous-commit-only rollback.

### Tests
- `alert-routes.test.js` — 7 tests (validation, host-scope precedence, severity filtering, resolve fallback)
- `volume-browser-safety.test.js` — 5 tests (path traversal guarded)
- Full suite: **1677 passing** across 102 suites (was 1665/100).

### API additions
- `GET /api/volumes/:name/browse?path=...`
- `GET /api/volumes/:name/read?path=...`
- `DELETE /api/volumes/:name/file?path=...`
- `GET /api/integrations/uptime-kuma`
- `GET /api/alert-routes`
- `POST /api/alert-routes`
- `DELETE /api/alert-routes/:id`
- `GET /api/alert-routes/resolve?hostId=X&severity=Y`

### Migrations
- **076** — `docker_hosts.is_builder` + `docker_hosts.default_registry_id` columns; `alert_channel_routes` table.

### Backward compatibility
Fully backward-compatible. All new tables and columns. `DD_STACKS_DIR` defaults to `/opt/stacks`; unset → no filesystem discovery.

Deployed to VPS (`89.37.212.66:8101`) and LAN (`192.168.13.20:8101`).

## [8.9.8-alpha.1] - 2026-07-06 — Gap closure ship 2: K8s write ops + pod logs + container webhooks + Docker events

Ship 2 of the gap-closure programme. Closes 4 Portainer gaps.

### Closed
- **Portainer G04 K8s write ops (P1, M) — CLOSED**: `scaleDeployment`, `restartDeployment` (kubectl-style rollout restart via patch on annotations), `deletePod`, `cordonNode(name, unschedulable)` on `KubernetesClient`. Routes at `/api/kubernetes/{deployments/:ns/:name/{scale,restart}, pods/:ns/:name, nodes/:name/cordon}`. All admin-only, audit-logged. PATCH uses `application/strategic-merge-patch+json` content type. Frontend row-action buttons on Deployments and Pods tabs.
- **Portainer G05 K8s pod log streaming (P1, S) — CLOSED**: `streamPodLogs(ns, name, {container, follow, tailLines})` on `KubernetesClient` — returns an EventEmitter-like object with `on(evt, cb)` and `destroy()`. SSE route at `GET /api/kubernetes/pods/:ns/:name/logs`. Frontend: click the `<i class="fas fa-file-alt">` icon on any pod row → modal with live-tailing log view.
- **Portainer G06 Per-container webhook (P1, S) — CLOSED**: `container_webhooks` table (migration 075) with unique 32-byte random URL-safe tokens, 3 actions (`recreate` / `restart` / `pull-only`). Public trigger endpoint `POST /webhook/container/:token` — no auth (token IS the auth), rate-limited to 10 req/min. Management endpoints under `/api/container-webhooks` (admin). Audit trail on every trigger (`container_webhook_trigger` / `_trigger_failed` / `_create` / `_delete`). Trigger pulls image + recreates or restarts container.
- **Portainer G09 Real-time Docker events stream (P2, S) — CLOSED (backend)**: SSE route `GET /api/docker/events?filter=<container|image|network|volume>` reuses existing `dockerService.getEventStream()`. Frontend Timeline drawer UI in v8.9.9.

### Tests
- `k8s-write-ops.test.js` — 7 tests (scale validation + PATCH shape + content type, restart annotation, delete URL, cordon/uncordon body)
- Full suite: **1665 passing** across 100 suites (was 1658/99).

### API additions
- `POST /api/kubernetes/deployments/:ns/:name/{scale, restart}`
- `DELETE /api/kubernetes/pods/:ns/:name`
- `POST /api/kubernetes/nodes/:name/cordon`
- `GET /api/kubernetes/pods/:ns/:name/logs` (SSE)
- `GET /api/container-webhooks`, `POST /api/container-webhooks/:containerId`, `DELETE /api/container-webhooks/:containerId`
- `POST /webhook/container/:token` (public, rate-limited)
- `GET /api/docker/events` (SSE)
- Frontend API helpers wired for all above

### Backward compatibility
Fully backward-compatible. New tables, no schema changes to existing rows.

Deployed to VPS (`89.37.212.66:8101`) and LAN (`192.168.13.20:8101`).

## [8.9.7-alpha.1] - 2026-07-05 — Gap closure ship 1: Host groups + K8s Ingress/NP + KubeConfig + docker-run converter + git multi-host targets

Ship 1 of the multi-competitor gap-closure programme. Closes 5 gaps outright, opens 1 as partial:

### Portainer gaps closed
- **G03 Host groups (P1, S) — CLOSED**: new `host_groups` + `host_group_members` tables (migration 073), full CRUD service + routes at `/api/host-groups`, service `groupsForHost(hostId)` for enrichment. Admin-only writes, audit-logged.
- **G08 KubeConfig download (P2, XS) — CLOSED**: `buildKubeconfig(row)` in `src/services/kubernetes.js` emits a valid kubeconfig YAML from a stored k8s host. Endpoint: `GET /api/kubernetes/kubeconfig` (with `X-Host-ID`). Falls back to `insecure-skip-tls-verify: true` when no CA cert stored.
- **G13 K8s Ingress/NetworkPolicy read (P3, S) — CLOSED**: `listIngresses(ns?)` + `listNetworkPolicies(ns?)` on `KubernetesClient`; new routes `/api/kubernetes/{ingresses, networkpolicies}`. Read-only per Sprint 5 anti-features.

### Komodo gaps closed / partial
- **G02 Host groups (P1, S) — CLOSED**: same schema + code as Portainer G03. Groups have color + icon + sort_order for the sidebar/list UI in ship 2.
- **G01 Multi-host git stack targets (P0, M) — PARTIAL**: migration 074 adds `git_stack_targets` join table (stack_id, host_id, last_deployed_commit, last_deploy_status, previous_deployed_commit) with backfill from existing single-host stacks. Service `src/services/git-multi-host.js` and routes `/api/git/stacks/:id/{targets, deploy-all}` land the fan-out scaffolding; full deep integration with `deployStack()` + UI polish deferred to ship 3.

### Dockge gaps closed
- **G06 docker-run → compose converter (P3, S) — CLOSED (backend)**: `parseDockerRun(cmd)` in `src/services/docker-run-parser.js` handles image, --name, -p, -v, -e/--env, --restart, --network, --user, -w, --entrypoint, --cap-add/drop, --privileged, --tty, --tmpfs, --device, --label, --dns, --add-host + more. Routes: `POST /api/compose/convert`. UI paste-command dialog ships in ship 3.

### Komodo G08 note
Full stack rollback is **already shipped**: `git.js:rollbackStack(stackId, deploymentId)` restores any previous deployment by commit. Deeper than Komodo's "previous commit only." Marking G08 as already-closed in ship 2's doc update.

### Tests
- `docker-run-parser.test.js` — 24 tests (tokenize, all common flags, complex real-world postgres command, YAML output)
- `host-groups.test.js` — 6 tests (create, list, get, update, delete cascade, groupsForHost)
- `kubeconfig-builder.test.js` — 4 tests (rejects non-k8s row, emits valid YAML with CA, skip-tls fallback, name sanitization)
- Full suite: **1658 passing** across 99 suites (was 1622/96)

### API additions
- `POST /api/host-groups`, `GET /api/host-groups`, `GET /api/host-groups/:id`, `PUT /api/host-groups/:id`, `DELETE /api/host-groups/:id`
- `GET /api/git/stacks/:id/targets`, `PUT /api/git/stacks/:id/targets`, `POST /api/git/stacks/:id/deploy-all`
- `GET /api/kubernetes/{ingresses, networkpolicies, kubeconfig}`
- `POST /api/compose/convert`
- Frontend API helpers wired: `listHostGroups`, `createHostGroup`, `updateHostGroup`, `deleteHostGroup`, `getGitStackTargets`, `setGitStackTargets`, `deployGitStackAll`, `getKubernetesIngresses`, `getKubernetesNetworkPolicies`, `convertDockerRun`

### Backward compatibility

Fully backward-compatible. Existing `git_stacks.host_id` remains authoritative for the primary/legacy target. New join table backfilled at migration time. No route breaking changes.

Deployed to VPS (`89.37.212.66:8101`) and LAN (`192.168.13.20:8101`).

## [8.9.6-alpha.1] - 2026-07-03 — Homelab install tutorials + ESXi→Proxmox walkthrough

Content-only release. **No code changes**, just 7 new howtos that walk through installing each supported daemon type as a nested VM under ESXi, then registering it in docker-dash. Purpose: turn every alpha's "end-to-end not verified against a live daemon" caveat into "verified" by giving operators a concrete recipe.

### New howtos (category `homelab-setup`)

- `install-proxmox-on-esxi.md` — Proxmox VE 8 as a nested VM on ESXi (nested virt, promiscuous mode, API token, SSH key for migration tool)
- `install-lxd-ubuntu.md` — LXD via snap on Ubuntu Server (Unix socket vs HTTPS + client cert)
- `install-incus-debian.md` — Incus on Debian 12 via Zabbly repo, or Debian 13 from base
- `install-k3s-single-node.md` — Rancher k3s single-node install, ServiceAccount + `view` ClusterRoleBinding, test workload
- `install-nomad-dev.md` — Nomad 1.9 dev agent, systemd unit, test job (Redis), ACL bootstrap
- `install-podman-rhel.md` — Podman on Rocky/Fedora/RHEL, socket setup, SSH tunnel registration (auto-detects Podman badge)
- `esxi-to-proxmox-migration.md` — end-to-end walkthrough: export ESXi VM as OVA, publish over HTTP, run docker-dash's VM Migration tool, boot the migrated VM on Proxmox. Includes Windows VirtIO driver injection guide.

### New master guide

- `homelab-setup-checklist.md` — reference LAN topology (192.168.13.20–27), recommended setup order, per-daemon test workload, promotion-blocker table showing which sprints each successful integration unblocks for beta

### Category filter update

- New "Homelab setup" filter chip in the How-To page category bar (`fas fa-network-wired` icon)

### Beta promotion narrative

Each install howto ends with a "Verification checklist" plus a footer explaining which sprint's alpha it validates. Running through the master checklist end-to-end is what turns:

> "PLATFORM alpha — end-to-end not verified against a live daemon"

into:

> "verified against a live daemon; ready for beta promotion"

for Sprints 3, 4, 5, 7, 8, 10.

### No functional changes

- No new routes, no new backend code, no migrations
- No test additions (nothing to test — content only)
- Full suite still: **1622 passing** across 96 suites

Deployed to VPS (`89.37.212.66:8101`) and LAN (`192.168.13.20:8101`).

## [8.9.5-alpha.1] - 2026-07-03 — **PLATFORM alpha**: Sprint 9 + Sprint 10 + Hosts UI

Alpha release combining three concerns: Wasm runtime detection (Sprint 9), Nomad integration (Sprint 10), and a refresh of the Hosts page with documentation + a wizard to register non-Docker daemons.

### Sprint 10 — Nomad (HashiCorp workload orchestrator)

Read-only alpha. Nomad is a simpler alternative to Kubernetes — jobs (containers, exec, java, qemu, raw_exec) scheduled onto client nodes. Common in homelabs and smaller shops.

**Backend**
- `src/services/nomad.js` — thin HTTP(S) client on stdlib, zero new deps
- Auth via `X-Nomad-Token` header (optional if ACL disabled)
- TLS via `caCert` + `skipTlsVerify`
- Methods: `agentSelf`, `listNamespaces`, `listJobs(ns?)`, `getJob`, `listJobAllocations`, `listAllocations(ns?)`, `listNodes`, `listDeployments(ns?)`
- `listNamespaces` gracefully handles 501 (OSS returns empty)
- 30 s timeout, 16 MB response cap
- Migration 072 widens `docker_hosts.daemon_type` CHECK to include `'nomad'` (writable_schema in-place edit, same pattern as 071)

**Routes**
- `GET /api/nomad/{info, namespaces, jobs, jobs/:id, jobs/:id/allocations, allocations, nodes, deployments}` — all guarded on `daemon_type='nomad'`

**Frontend**
- `public/js/pages/nomad-jobs.js` — 4-tab page (Jobs / Allocations / Deployments / Nodes) with namespace filter and info card (agent name + version + region + DC)
- Sidebar entry **"Nomad (alpha)"** gated `data-fleet-daemon="nomad"`

**Howto** — `nomad-integration.md` with ACL policy YAML, per-scope explanation, troubleshooting

### Sprint 9 — Wasm runtime detection

Docker (via containerd) can run WebAssembly modules as containers using alternative OCI runtimes (WasmEdge, wasmtime, Spin, wasmer). This alpha adds **detection + categorization**, not a Deploy-Wasm-app wizard.

**Backend**
- `src/services/docker.js` — `_categorizeRuntimes(info.Runtimes)` groups runtimes into `standard` / `sandboxed` / `wasm` via pattern match on binary names
- Result surfaced in `/api/system/info` as `runtimeCategories: {standard, sandboxed, wasm}`
- Standard: `runc`, `crun`
- Sandboxed: `kata`, `runsc`, `firecracker`, `nabla`, `youki`
- Wasm: `wasmedge`, `wasmtime`, `wamr`, `spin`, `crun-wasm`, `wasmer`, `wws`

**Frontend** — the field is available for the System page to render (a follow-up alpha will add the visual "Wasm runtime" badge)

**Howto** — `wasm-workloads.md` with WasmEdge install recipe, `containerd-shim` registration in `daemon.json`, security notes on the Wasm sandbox model, and the categorization rules

### Hosts page — docs + non-Docker registration wizard

**"Non-Docker host" button** (top-right, next to "Add host"):

Opens a wizard that:
1. Asks the daemon type (Incus / LXD / Proxmox / Kubernetes / Nomad)
2. Renders type-specific fields (transport dropdown for Incus/LXD, endpoint + API token for Proxmox, endpoint + bearer token for Kubernetes, endpoint + ACL token for Nomad)
3. Handles transport toggle for Incus/LXD (unix socket vs HTTPS + client cert)
4. Submits to `POST /hosts` with `{name, daemonType, daemonConfig}`

Backend dispatches to the right `encryptDaemonConfig()` helper per daemon type. Every write is audit-logged.

**"Supported daemon types" documentation section** (collapsible, persists to localStorage):

Table with columns Type / Auth / What ships / Read-only? / Howto — one row per daemon type (Docker, Podman, Incus, LXD, Proxmox, Kubernetes, Nomad) linking to the corresponding howto. Includes a note on Wasm runtime detection and a security callout for `daemon_config` encryption at rest.

### Tests

- `src/__tests__/nomad-client.test.js` — 13 tests (constructor validation, encryption round-trip, `fromHostRow`, X-Nomad-Token header, namespace scoping, OSS 501 graceful handling, 4xx status surfacing)
- Full suite: **1622 passing** across 96 suites

### Alpha caveats

- End-to-end not verified against a live Nomad cluster or a live Wasm-capable Docker host
- Nomad: read-only. Job submit / stop / restart / eval land in alpha.2
- Wasm: detection only. No Deploy-Wasm-app wizard, no Wasm-specific System-page badge yet
- Non-Docker host wizard: no "Test connection" button — save + refresh to see if it connects

### Backward compatibility

- `POST /hosts` still accepts the existing Docker-only body shape — new `daemonType` / `daemonConfig` fields are opt-in
- Existing rows unchanged
- No sidebar clutter unless a Nomad host is registered

Deployed to VPS (`89.37.212.66:8101`) and LAN (`192.168.13.20:8101`).

## [8.9.4-alpha.1] - 2026-07-03 — **PLATFORM alpha**: Sprint 5 — Kubernetes read-only foundation

Alpha release. First cut of the Kubernetes module described in `plans/deep-spec-sprint-5-kubernetes.md`. Read-only in this alpha — Deployments, Pods, Services, Namespaces, Nodes. Write operations (scale, rollout-restart, delete pod, tail logs) land in alpha.2 once the plumbing is verified against a live k3s.

### Positioning (from the deep-spec)

> Kubernetes support in Docker Dash exists so a homelab operator can see what's running on their k3s cluster alongside their Docker hosts — **not to replace Lens, Rancher, or `kubectl`.**

Every scope decision follows from that. Anti-features that stay OUT permanently:

- No YAML editor
- No Helm install / upgrade
- No Ingress / RBAC / NetworkPolicy editor
- No `kubectl`-in-browser terminal (security nightmare in a web app)
- No Secret / ConfigMap viewer (accidental disclosure risk)
- No CRD viewer

If a user needs any of these → they should use Lens or `kubectl`. That is the design.

### What ships

**1. `src/services/kubernetes.js` — `KubernetesClient`**

- Thin HTTPS client on stdlib `https` — **zero new npm deps** (no `@kubernetes/client-node`)
- Bearer-token auth (`Authorization: Bearer <token>`)
- CA cert verification (or `skipTlsVerify` for testing)
- 30 s per-request timeout, 16 MB response cap
- Methods: `version`, `listNamespaces`, `listPods(ns?)`, `listDeployments(ns?)`, `listServices(ns?)`, `listNodes`
- `daemonType` getter (constant `'kubernetes'`)

**2. `daemon_config` shape (encrypted at rest via `enc:` prefix)**

```
{
  endpoint: "https://k3s.example.com:6443",
  token: "eyJhbG...",
  caCert: "-----BEGIN CERTIFICATE-----...",
  skipTlsVerify: false
}
```

Same AES-256-GCM helper used for Incus / Proxmox / git credentials.

**3. `src/routes/kubernetes.js` — read-only routes**

- `GET /api/kubernetes/version`
- `GET /api/kubernetes/namespaces`
- `GET /api/kubernetes/pods?namespace=<ns>`
- `GET /api/kubernetes/deployments?namespace=<ns>`
- `GET /api/kubernetes/services?namespace=<ns>`
- `GET /api/kubernetes/nodes`

All guarded on `daemon_type='kubernetes'` on the target host row.

**4. `public/js/pages/kubernetes-resources.js`**

- Namespace filter dropdown at the top
- Tabs: Deployments (default) / Pods / Services / Namespaces / Nodes
- Info card with cluster version + Go build + platform
- Sidebar entry **"Kubernetes (alpha)"** gated via `data-fleet-daemon="kubernetes"` — appears only when the operator has registered a k8s host

**5. `docker.js` dispatch upgraded**

`_getNonDockerInfo` now reaches the apiserver's `/version` endpoint for the k8s branch (previously it returned a stub). Populates `dockerVersion` with `gitVersion`, `apiVersion` with `major.minor`, `os` with `platform`.

**6. Howto `kubernetes-integration.md`**

- Least-privilege ServiceAccount + `view` ClusterRoleBinding YAML
- Manual token Secret (post-1.24 pattern)
- Per-distro endpoints table (k3s / k0s / MicroK8s / kubeadm / Docker Desktop k8s)
- Security notes and troubleshooting

**7. Tests: `src/__tests__/kubernetes-client.test.js` — 17 tests**

Constructor validation, daemon_config encryption round-trip, `fromHostRow`, response envelope unwrapping (list responses have `{ items: [...] }`), path composition for namespaced vs cluster-wide list calls, bearer-token header, 4xx surfaced with `status` + parsed body. Full suite: **1608 passing** across 95 suites.

### Alpha caveats

- Read-only. Write ops (scale, rollout restart, delete pod, tail logs) deferred to alpha.2
- No pod log streaming
- No exec-into-pod (never coming — see positioning)
- No YAML view for a resource (deep-spec calls this in-scope for alpha.2)
- Pagination not implemented — clusters with >500 pods per namespace may exceed the 16 MB response cap
- End-to-end not verified against a live k3s in this session. The API surface is stable and well-documented; correctness is overwhelmingly likely but the alpha label stays until an operator confirms

### Backward compatibility

- No migration required (`daemon_type='kubernetes'` was already in the CHECK from migration 069)
- Existing docker/podman/incus/lxd/proxmox rows unchanged
- No sidebar clutter unless a k8s host is registered

Deployed to VPS (`89.37.212.66:8101`) and LAN (`192.168.13.20:8101`).

## [8.9.3-alpha.1] - 2026-07-03 — **PLATFORM alpha**: Sprint 8 — LXD support

Alpha release. Adds Canonical LXD as a first-class daemon type, riding on top of the Incus client shipped in Sprint 3.

### Why LXD alongside Incus

LXD and Incus forked in 2024. For every operation docker-dash cares about — instance lifecycle, snapshots, projects, operation polling — the REST APIs are byte-identical. Divergence only appears on features added *after* the fork.

Ubuntu servers install LXD by default via snap; many production LXD deployments never migrated to Incus. Supporting LXD directly saves those operators the migration step and gives docker-dash access to a wider install base.

### What ships

**1. Database migration 071 — widen `docker_hosts.daemon_type` CHECK**

Adds `'lxd'` to the allowed set (`docker`, `podman`, `incus`, `proxmox`, `kubernetes`, `lxd`). Uses SQLite `writable_schema` in-place edit rather than the RENAME + rebuild pattern — the latter would corrupt the FK from `migration_jobs.destination_host_id → docker_hosts.id` shipped in v8.9.2-alpha.1 (Sprint 7).

**2. IncusClient parametrized with `daemonType`**

Same class, same methods. The daemon type is stamped on the client and surfaced via a `daemonType` getter. `fromHostRow()` now accepts rows with `daemon_type IN ('incus', 'lxd')` and picks the right default Unix socket:

- Incus: `/var/lib/incus/unix.socket`
- LXD:   `/var/snap/lxd/common/lxd/unix.socket` (snap install default; legacy `/var/lib/lxd/` supported via explicit `daemon_config.socket`)

**3. Routes at `/api/incus/*` accept both types**

The route guard widens to `daemon_type IN ('incus', 'lxd')`. All audit-log entries include `daemonType` in `details` for provenance.

**4. Frontend gating**

- Sidebar entry renamed to **"Incus / LXD (alpha)"**
- `data-fleet-daemon="incus,lxd"` supports comma-separated OR-match (new attribute-parsing rule in `_refreshCapabilities`)
- Page title shows "Incus / LXD instances"

**5. Howto: `lxd-integration.md`**

Registration recipe for both snap and legacy installs, HTTPS + client cert flow, differences from Incus (currently: none that matter for docker-dash features), troubleshooting, security notes.

**6. Tests**

- New `src/__tests__/lxd-client.test.js` — 7 tests covering daemonType propagation, LXD socket default, override behavior, encrypted config round-trip for LXD rows, Incus regression guard
- Updated `incus-client.test.js` — one test message widened for the `Incus/LXD host` error
- Full suite: **1591 passing** across 94 suites

### Migration semantics

- `migration_jobs.destination_host_id` FK to `docker_hosts` is preserved (writable_schema edit is a no-op at the FK graph level)
- `PRAGMA integrity_check` is run after the schema edit and throws if it doesn't return `ok`
- Idempotent — the migration is a no-op if the CHECK already contains `'lxd'`

### Backward compatibility

- Every existing daemon_type value continues to be valid
- Every existing IncusClient invocation continues to work unchanged (default `daemonType='incus'`)
- No config file changes required for existing installs
- Podman detection unaffected (still runs dynamically via Docker API `version.Components` inspection)

### Alpha caveats

- The full LXD-specific end-to-end flow has NOT been verified against a live LXD daemon in this session. The API-level identity with Incus makes correctness overwhelmingly likely, but the alpha label stays until an operator confirms.
- LXD-only features (Canonical cluster-wide roles, snap-managed cert rotation) are not exposed
- Incus-only features added after the fork (e.g. OCI image import) are not exposed
- No dedicated LXD icon — the same cube icon used for Incus is reused for now

Deployed to VPS (`89.37.212.66:8101`) and LAN (`192.168.13.20:8101`).

## [8.9.2-alpha.1] - 2026-07-03 — **PLATFORM alpha**: Sprint 7 — cross-hypervisor VM migration to Proxmox

Alpha release. Ships the FIRST cut of the "killer feature" from the migration research (`plans/research-vmware-and-cross-migration-2026-07-03.md`): a one-click workflow to import a disk image URL into a Proxmox VM.

### Positioning

This is what makes the Proxmox integration in docker-dash actually valuable. Proxmox already has a great management UI. Where docker-dash adds unique value is **getting workloads INTO Proxmox** — from VMware VMDKs, OVA appliances, or public disk images.

### Flow

1. Operator opens **VM Migration (alpha)** in the sidebar (visible when any Proxmox host is registered)
2. Clicks **New Migration** and fills a small form: source URL, source format (auto), destination Proxmox host + node + storage + new VMID + VM name
3. Backend orchestrates the work on the Proxmox node via SSH:
   - `wget` the source URL to `/tmp/dd-migration-<jobId>/`
   - Extract VMDK from OVA if applicable
   - `qemu-img convert -O qcow2`
   - `qm create <vmid> --name <name> --memory 2048 --cores 2 --net0 virtio,bridge=vmbr0`
   - `qm importdisk <vmid> <qcow2> <storage>`
   - `qm set <vmid> --scsihw virtio-scsi-pci --scsi0 <storage>:vm-<vmid>-disk-0`
   - `qm set <vmid> --boot c --bootdisk scsi0`
   - Cleanup
4. Live progress and phase log stream back to the UI (polling every 3 s)

### What ships

**1. Database migration 070 — `migration_jobs` table**
Full audit of each job: source spec, destination Proxmox target, status (`pending`/`running`/`completed`/`failed`/`cancelled`), progress 0-100, current phase, phase log (bounded 256 KB), error, timestamps.

**2. Service** — `src/services/migration-vm.js` (~250 lines)
- `createJob(spec, userId)` — validates and persists, kicks off worker via `setImmediate`
- `listJobs(limit)`, `getJob(id)`
- `runJob(id)` — the SSH-driven worker with 9 phases and per-command timeouts (15 min per shell command, 1 h for download, 4 h for `qemu-img convert`)
- Uses `ssh2` (existing dep from `ssh-tunnel.js`) with the SSH creds stored in the destination host's `daemon_config.sshConfig`
- Every command wraps user input in strict shell escaping (`_shellEscape`) or validates against strict regex (`_validateSpec`)
- Bounded phase log at 256 KB to prevent SQLite bloat on chatty commands

**3. Routes** — `src/routes/migration-vm.js`
- `GET /api/migration-vm` — list recent jobs (all authenticated users)
- `GET /api/migration-vm/:id` — one job
- `POST /api/migration-vm` — create + start (admin only, audited as `vm_migration_start`)

**4. Frontend** — `public/js/pages/migration-vm.js`
- Job list table with status badges, progress bars, current phase
- New Migration modal with all fields
- Job detail modal showing spec, progress, phase log tail
- Live polling every 3 s while page is open
- Sidebar entry gated via `data-fleet-daemon="proxmox"`

**5. Howto** — `src/db/howto-content/vm-migration-to-proxmox.md`
- Prerequisites (Proxmox host + SSH config)
- SQL snippet to add `sshConfig` to an existing Proxmox `daemon_config`
- Trigger flow
- Progress milestones with % thresholds
- Post-migration steps (Windows guest driver injection)
- Security notes (source URL fetched by Proxmox not docker-dash; SSH creds encrypted; audit trail)
- Troubleshooting

**6. Tests** — `src/__tests__/migration-vm.test.js`
- 18 unit tests covering:
  - `_validateSpec` — 6 tests (missing URL, non-http, bogus VMID, shell metacharacters in name, valid spec)
  - `_sourceExt` — 6 tests (VMDK/OVA/QCOW2/RAW detection, explicit format overrides URL)
  - `_shellEscape` — 4 tests (POSIX close-escape-reopen pattern, embedded quotes, null/undefined, dangerous payload stays literal)
  - `createJob` / `listJobs` — 2 tests (persistence + listing)
- The SSH-exec / `qemu-img` / `qm importdisk` path is NOT covered by tests — it needs a real Proxmox cluster to verify

Full suite: 1583 passing.

### Alpha caveats — DO NOT USE IN PRODUCTION

- **Unverified end-to-end**. The command sequence is correct per the Proxmox wiki and community writeups, but has NOT been tested against a real Proxmox cluster in this session
- **No cancel button** (v2)
- **OVAs with multiple disks**: only the first VMDK found is imported
- **Storage compatibility**: some Proxmox storages don't support QCOW2 (LVM-thin needs raw); currently we always produce QCOW2
- **Concurrent migrations to the same VMID**: not guarded
- **Windows guests**: no VirtIO driver injection — operator must handle manually per the howto
- **No file upload source** (URL only in this alpha)
- **No VMware source** — deferred pending a decision on shipping a SOAP client for vSphere Web Services API (see the migration research doc)

### Security model

- Source URL is fetched by `wget` **on the Proxmox node**, not by docker-dash. Network egress policy applies to Proxmox
- SSH credentials are stored **encrypted at rest** via the AES-256-GCM helper (same pattern as Incus / Proxmox `daemon_config`)
- Every `POST /api/migration-vm` writes an `vm_migration_start` audit_log entry
- Command construction validates VMIDs (regex + range) and names (strict regex `[a-zA-Z0-9._-]{1,63}`); free-form values are shell-escaped via POSIX close-escape-reopen pattern
- 15-minute timeout on every shell command by default, 1 h on `wget`, 4 h on `qemu-img convert`

### Operator action

None for Docker-only installs. Operators wanting to try the migration flow: register a Proxmox host (see the Proxmox howto), add SSH config to `daemon_config` (see the migration howto), then use the UI. Report bugs — this is unverified alpha.

## [8.9.1-alpha.1] - 2026-07-03 — **PLATFORM alpha**: Sprint 4 (Proxmox VE) foundation — read-only overview

Alpha release. Ships the foundation for Proxmox VE integration but **read-only** — no state-change actions yet. Deployment to a Docker-only install is safe. Deployment against a real Proxmox cluster is EXPERIMENTAL.

### Positioning (unchanged from deep-spec)

docker-dash is **NOT a Proxmox UI replacement**. Proxmox ships an excellent web UI. This integration's value is showing VMs + LXCs + storages + backups alongside your Docker hosts in one dashboard for operators running **mixed infrastructure** (Docker + Proxmox).

### What ships

**1. ProxmoxClient** (`src/services/proxmox.js`)
Thin HTTPS wrapper (stdlib `https`, no new npm dep). API token auth via `PVEAPIToken=USER@REALM!TOKENID=UUID` header. 30 s timeout + 16 MB response cap (matches v8.7.x hardening pattern). `self-signed` cert support via `skipTlsVerify=true`.

Read methods:
- `version()` — daemon info
- `listNodes()` — cluster nodes
- `listVMs()` — VMs across cluster (via `/cluster/resources?type=vm`)
- `listLXC()` — LXC containers
- `listStorages()` — storages
- `getVM(node, vmid)`, `getLXC(node, vmid)` — single-instance detail
- `listBackups()` — union across all storages, sorted newest first

Not yet implemented (deferred to alpha.2 / beta):
- State actions: start / stop / reboot / suspend VM/LXC
- Migrate VM between nodes
- Trigger vzdump backup
- Snapshot management
- noVNC console iframe
- Cluster HA policy view

**2. Routes** (`src/routes/proxmox.js`, mounted at `/api/proxmox/*`)
- `GET /info`, `GET /nodes`
- `GET /vms`, `GET /vms/:node/:vmid`
- `GET /lxc`, `GET /lxc/:node/:vmid`
- `GET /storages`, `GET /backups`

Every route guards on `daemon_type='proxmox'`. Wrong host = 400 with actionable error message.

**3. Frontend** (`public/js/pages/proxmox-resources.js`)
Page with tabs: **VMs**, **LXC**, **Nodes**, **Storages**, **Backups**. Each tab renders a table with the shape appropriate to the resource. Info panel at the top shows Proxmox version + release + repo id.

Sidebar: **Proxmox (alpha)** — gated via `data-fleet-daemon="proxmox"` from v8.9.0-alpha.3, so it only shows when the operator has registered a Proxmox host.

**4. daemon_config encryption** (mirrors Incus alpha.3 pattern)
- `encryptDaemonConfig(cfg)` / `decryptDaemonConfig(raw)` helpers
- Backward-compatible: plaintext JSON accepted
- Encrypted `enc:iv:tag:ciphertext` via AES-256-GCM

**5. `dockerService.getInfo` extended** to actually probe Proxmox for a live version (from alpha.3's stub). Best-effort; connection error leaves `_connectError` on the response instead of failing `/api/system/info`.

**6. Tests** — 12 unit tests in `src/__tests__/proxmox-client.test.js`:
- Constructor validation (endpoint, token, tokenId format)
- Auth header shape (`PVEAPIToken=...`)
- Response envelope unwrapping (`{data: ...}`)
- Error surface with structured `errors` field
- `listLXC` filters `cluster/resources` by `type=lxc`
- Encryption round-trip + plaintext backward-compat + `fromHostRow` non-Proxmox rejection

Full suite: 1565 passing.

### Deployment (Docker + Proxmox mixed install)

1. In Proxmox, create an API token: **Datacenter → Permissions → API Tokens → Add**. Uncheck "Privilege Separation" for simplicity, or grant `PVEAuditor` role on `/` for read-only.

2. Register the host in Docker Dash's DB (no admin UI yet):
```bash
docker exec docker-dash node -e '
const { getDb } = require("/app/src/db");
const { encryptDaemonConfig } = require("/app/src/services/proxmox");
const cfg = {
  endpoint: "https://pve.example.com:8006",
  tokenId: "root@pam!docker-dash",
  tokenSecret: "YOUR-UUID-HERE",
  skipTlsVerify: true    // homelab; false in production with real cert
};
const encrypted = encryptDaemonConfig(cfg);
getDb().prepare(`INSERT INTO docker_hosts
  (name, connection_type, daemon_type, daemon_config, is_default, is_active)
  VALUES (?, ?, ?, ?, ?, ?)`)
  .run("Proxmox Cluster", "tcp", "proxmox", encrypted, 0, 1);
console.log("proxmox host registered");
'
```

3. Refresh Docker Dash. **Proxmox (alpha)** appears in the sidebar. Switch to that host via the host selector, click the nav item — VMs, LXCs, nodes, storages, backups appear.

### Known-alpha limitations

- Read-only. No state-change actions.
- No admin UI to register a Proxmox host (SQL only).
- No noVNC console.
- Cluster addressing: uses cluster-wide `/cluster/resources` endpoint — no per-node routing yet.
- No health-check for Proxmox — the Info panel silently shows nothing on connection failure.
- Nav visible per fleet-daemon gate (v8.9.0-alpha.3) — but if the operator only has Proxmox and no Docker, some other pages error.

### Operator action

None for Docker-only installs. Proxmox operators: read deployment steps above.

## [8.9.0-alpha.3] - 2026-07-03 — **PLATFORM alpha**: Sprint 3 (Incus) consolidation — multi-daemon dispatch, encryption, fleet-daemon nav

Third alpha of Sprint 3. Not new features — this release closes three known-alpha gaps flagged in alpha.2.

### 1. Multi-daemon `getInfo` dispatch — fixes "switch to Incus host and everything errors"

Before: selecting an Incus host and clicking Containers / Images / any Docker page triggered a chain of 500s because `dockerService.getInfo(hostId)` tried to open a Docker socket that isn't there.

After: `dockerService.getInfo()` now looks up the target host's `daemon_type` and dispatches:
- `docker` / `podman` → existing Docker path
- `incus` → `_getNonDockerInfo(hostId, 'incus')` — reads live info via `IncusClient`, fills `hostname`, `os`, `kernelVersion`, `dockerVersion` (= Incus server version), `apiVersion` (Incus API version); Docker-specific fields nulled. Capability matrix has `incus: true`, `swarm: false`, etc.
- `proxmox` / `kubernetes` → stub info (Sprint 4 / 5 will fill this in)
- Unknown daemon_type → safe stub so `/api/system/info` never 500s

Frontend Info card still renders — with the daemon-specific values.

### 2. `daemon_config` encryption at rest

`fromHostRow(row)` and companion helpers now support both:
- **Plaintext JSON** (legacy — alpha.1/2 rows keep working)
- **Encrypted `enc:iv:tag:ciphertext`** — AES-256-GCM via the existing `src/utils/crypto.js` helper (same pattern as git credentials and API keys)

New helpers exported from `src/services/incus.js`:
- `encryptDaemonConfig(cfgObj)` → `enc:iv:tag:hex` string
- `decryptDaemonConfig(raw)` → JS object; handles both formats transparently

**Migration path**: existing plaintext rows keep working forever. New rows registered via a future admin UI (Sprint 3 beta) will be encrypted. To migrate an existing row now:
```bash
docker exec docker-dash node -e '
const { getDb } = require("/app/src/db");
const { encryptDaemonConfig } = require("/app/src/services/incus");
const db = getDb();
const row = db.prepare("SELECT id, daemon_config FROM docker_hosts WHERE id = ?").get(<HOST_ID>);
if (row.daemon_config.startsWith("enc:")) { console.log("already encrypted"); process.exit(0); }
const encrypted = encryptDaemonConfig(JSON.parse(row.daemon_config));
db.prepare("UPDATE docker_hosts SET daemon_config = ? WHERE id = ?").run(encrypted, row.id);
console.log("row " + row.id + " encrypted");
'
```

**Error surface**: if `ENCRYPTION_KEY` rotates without re-encrypting, `fromHostRow` throws a clear `daemon_config decrypt failed (ENCRYPTION_KEY changed?)` instead of a cryptic hex error.

### 3. Fleet-level nav gating — `data-fleet-daemon="X"`

New attribute alongside `data-capability`. Where `data-capability` gates on the CURRENT host's daemon type, `data-fleet-daemon="X"` gates on "at least one host in the fleet has this daemon_type".

Applied to the **Incus (alpha)** nav item: hidden entirely for Docker-only installs (no more noise for the vast majority of users), visible the moment the operator registers an Incus host. Regardless of which host is currently selected.

Backend: `/api/hosts` now includes `daemonType` in each host row so the frontend can compute the presence set. `App._refreshCapabilities()` builds a `Set` of daemon types found in `/api/hosts` and toggles `[data-fleet-daemon]` elements.

### Tests

4 new unit tests in `incus-client.test.js`:
- Round-trip encrypt/decrypt preserves the config
- Plaintext JSON is passed through (backward-compat)
- `fromHostRow` accepts encrypted `daemon_config`
- Rotated `ENCRYPTION_KEY` surfaces a clear error

Total: 23 Incus tests, all passing. Suite: 1553 passing.

### Still known-alpha (unchanged)

- No WebSocket console yet
- No instance-create form (use `incus launch` CLI)
- No snapshot UI (backend works)
- Cluster-aware routing deferred
- No admin UI to register an Incus host (still SQL — see howto)

### Operator action

None for Docker-only installs. Incus operators: nothing forced. Optional — re-encrypt existing plaintext `daemon_config` via the snippet above to get encryption-at-rest.

## [8.9.0-alpha.2] - 2026-07-03 — **PLATFORM alpha**: Sprint 3 (Incus) — write methods + routes + UI

Second alpha of Sprint 3. Ships the write path, backend routes, first-cut frontend UI, and howto docs. **Still alpha** — verified only against unit-test mocks, not a real Incus daemon. Deployment to a Docker-only install is safe; deployment against a real Incus is experimental.

### What ships on top of alpha.1

**IncusClient write methods** (`src/services/incus.js`):
- `startInstance(name, opts)`, `stopInstance`, `restartInstance`, `freezeInstance`, `unfreezeInstance`
- `deleteInstance(name, opts)`
- `createSnapshot(instance, name, opts)`, `restoreSnapshot(instance, name)`, `deleteSnapshot(instance, name)`
- Underlying `_changeInstanceState(name, action, opts)` — validates the action name, sends `PUT /1.0/instances/{name}/state` with `{action, timeout, force, stateful}`, then polls the returned operation until success or timeout (5 min cap for VMs)
- `_awaitOperation(opPath, opts)` — polls `/1.0/operations/{id}/wait?timeout=N`, throws with `err.incusOperation` on Failure

**Backend routes** (`src/routes/incus.js`, mounted at `/api/incus/*`):
- `GET /info` — daemon info + version
- `GET /instances` (with `?project=`), `GET /instances/:name`
- `POST /instances/:name/{start,stop,restart,freeze,unfreeze}` — admin-only, audit logged
- `DELETE /instances/:name` — admin-only, audit logged
- `GET /instances/:name/snapshots`, `POST /instances/:name/snapshots`
- `POST /instances/:name/snapshots/:snapshot/restore`
- `DELETE /instances/:name/snapshots/:snapshot`
- `GET /images`, `GET /projects`

Every route guards on `daemon_type='incus'` for the requested `hostId` — if the operator points a Docker host at `/api/incus/*` the response is a clear 400 error, not a cryptic Docker socket failure.

**Frontend** (`public/js/pages/incus-instances.js`):
- Instances page with Name / Status / Type / IPv4 / Memory / CPU columns
- Row actions: Start, Stop, Restart, Delete (with danger-confirm on Delete)
- Project selector — dropdown of Incus projects if any exist
- Info panel showing server version + kernel + API extensions
- Sidebar entry: **Incus (alpha)** — currently visible on all hosts (see limitation below); clicking it while on a Docker host produces a 400 with actionable message
- Loaded via `<script>` and registered in `App._pages`

**Howto** (`src/db/howto-content/incus-integration.md` + `.ro.md`):
- ~200 lines each covering local rootful setup, remote HTTPS setup with client cert, feature matrix (works/doesn't-work), troubleshooting

**Tests** (`src/__tests__/incus-client.test.js`):
- +7 unit tests on top of the 12 from alpha.1 → **19 total, all passing**
- Coverage: state action shapes, invalid action rejection, async operation polling, failure surface, snapshot create/restore/delete request shapes

### Known-alpha limitations

- **No WebSocket console yet** — LXC `exec` streaming and VM noVNC/SPICE are planned for beta
- **No instance-create form** — use `incus launch images:debian/12 my-instance` from CLI
- **No snapshot management UI** — backend routes work; UI in v8.9.0 proper
- **Nav item is always visible** — `data-capability="incus"` fails-open when the capability key is missing (correct behavior for the general system, but noisy on Docker-only installs). A future release adds a "any-host-has-daemon-type=incus" gate
- **No cred encryption at rest** — Incus HTTPS PEM cert + key stored plaintext in `daemon_config`. Adequate for on-host Unix socket; concern for HTTPS setups. Deferred to alpha.3
- **No cluster-aware routing** — treats each Incus node as an independent daemon. Real Incus clusters need per-node placement. Deferred
- **Multi-daemon host switching is bumpy** — selecting an Incus host and then clicking Containers or Images produces errors because those routes hit `dockerService.getInfo()`. Users have to stay in the Incus subsystem while on an Incus host. Cross-daemon routing is a separate refactor

### Deployment notes

Docker-only installs: **safe**. Nothing changes for Docker workflows.

Docker + Incus installs: read the howto (`Docker Dash → How-To → Incus Integration (alpha)`) end-to-end. Highlights:

1. Bind-mount `/var/lib/incus/unix.socket` in `docker-compose.yml`
2. Run the SQL from the howto to register your Incus host
3. Switch to the Incus host via the host selector
4. Click **Incus (alpha)** in the sidebar

Backend audit log gains 6 new actions: `incus_instance_start`, `_stop`, `_restart`, `_freeze`, `_unfreeze`, `_delete`, `incus_snapshot_create`, `_restore`, `_delete`.

### Operator action

None for Docker-only installs. Incus operators: read the howto before proceeding.

## [8.9.0-alpha.1] - 2026-07-03 — **PLATFORM foundation**: Sprint 3 (Incus) architecture — daemon_type migration + Incus HTTP client + tests

**Alpha release**. Ships the FOUNDATION for Incus support but NOT the UI. Explicit alpha tag because the code path has no verified integration test against a real Incus daemon — mocked tests only. Deploying to a Docker-only environment is safe (migration is additive, no existing behavior changes). Deploying to a real Incus environment is EXPERIMENTAL.

### What ships

**1. Database migration 069 — `daemon_type` + `daemon_config` columns**

`ALTER TABLE docker_hosts` adds:
- `daemon_type TEXT NOT NULL DEFAULT 'docker' CHECK(daemon_type IN ('docker','podman','incus','proxmox','kubernetes'))`
- `daemon_config TEXT` (opaque JSON blob per daemon type)

Backfill: every existing row keeps its implicit meaning (`docker`). Podman rows stay `docker` because Podman detection is dynamic per request (v8.7.44) — the two systems are orthogonal by design.

Idempotent: guards with `PRAGMA table_info` so re-running the migration during dev doesn't fail.

**2. Incus HTTP client — `src/services/incus.js`**

Thin `http`/`https` wrapper (no dependencies) with:
- Unix socket transport (`transport: 'unix', socket: '/var/lib/incus/unix.socket'` default)
- HTTPS transport with TLS client cert (partial — cert loading via string is deferred to alpha.2)
- 30s AbortController timeout on every request (v8.7.x hardening pattern)
- 16 MB response body cap (defence against runaway responses)
- Standard `{ metadata, status_code }` envelope unwrapping — every list method returns just the array
- Error surfacing: HTTP errors carry the parsed body under `err.incusResponse` and `err.status`

**Implemented methods** (READ ONLY in this alpha):
- `info()` — daemon version + supported API versions
- `listInstances(project?)` — containers + VMs with `recursion=1` (status, IPs, memory, CPU)
- `getInstance(name, project?)` — single instance detail
- `listSnapshots(name, project?)`
- `listImages()`
- `listProjects()`

**NOT yet implemented** (deferred to alpha.2 / beta / 8.9.0 proper):
- `startInstance`, `stopInstance`, `restartInstance`, `deleteInstance`
- `createSnapshot`, `restoreSnapshot`, `deleteSnapshot`
- WebSocket console (`exec` for LXC, noVNC/SPICE for KVM VMs)
- Backend routes at `/api/incus/*`
- Frontend page at `pages/incus-instances.js`
- Sidebar entry (will use existing `data-capability="incus"` gating from v8.8.2)
- Docker compose bind-mount for the Incus socket (operator has to add it manually for now)
- Howto documentation

**3. Helper — `fromHostRow(row)`**

Takes a `docker_hosts` row and returns a configured `IncusClient`. Route/service code doesn't need to know the config shape. Rejects non-Incus rows with a clear error.

**4. Tests — `src/__tests__/incus-client.test.js`**

12 unit tests covering:
- Constructor validation (missing transport / socket / endpoint)
- `fromHostRow` config parsing (defaults, JSON errors, non-Incus rejection)
- Response envelope unwrapping (list returns metadata array)
- Missing-metadata fallback to empty array
- HTTP error surfacing (404 with body under `err.incusResponse`)
- Query string composition (project + recursion)

The tests mock the `http` module — no real Incus daemon needed in CI.

### Why alpha

The client + migration have unit test coverage but no integration test against a real Incus. Alpha lets curious operators try it and give feedback without a stability commitment. The write path (start/stop/delete) is intentionally NOT shipped in alpha to prevent damage from an untested code path.

### Deployment notes

- Docker-only installs: safe to deploy. Migration is a no-op behaviorally.
- Docker + Incus installs: after deploy, add an entry manually with:
  ```sql
  INSERT INTO docker_hosts (name, connection_type, daemon_type, daemon_config, is_default)
  VALUES ('Local Incus', 'socket', 'incus',
    '{"transport":"unix","socket":"/var/lib/incus/unix.socket"}', 0);
  ```
  Also add the socket to `docker-compose.yml`:
  ```yaml
  volumes:
    - /var/lib/incus/unix.socket:/var/lib/incus/unix.socket
  ```
  Then in your app the row will exist but no UI reaches it yet — you can experiment via the API `require('/app/src/services/incus').fromHostRow(row).listInstances()`.

### Operator action

None for Docker installs. Incus operators: read the deployment notes above and expect the UI in a follow-up release.

## [8.8.2] - 2026-07-03 — **PLATFORM**: capability-gated nav + stack deploy from YAML

Two related follow-ups that build on the capability matrix shipped in v8.7.44 and the Stacks tab shipped in v8.8.0.

### 1. Capability-based sidebar nav gating

Nav items can now declare `data-capability="X"`. On boot and on every `hostChanged` event, `App._refreshCapabilities()` fetches the current host's `/api/system/info` capability matrix and hides any nav item whose declared capability is `false`.

Ships with one gated item: the **Swarm** nav entry now hides automatically on Podman hosts (Podman doesn't implement Swarm mode; the entry was harmless but confusing there).

Fail-open: missing keys in the matrix default to visible. Better UX than hiding something the user might genuinely need if the server hasn't been upgraded yet.

Ready for Sprint 3 (Incus) and beyond — future daemon types can gate any nav item without extra JS.

### 2. Docker Swarm — deploy a compose YAML as a stack

Fills the Sprint 2 gap noted in v8.8.0. `POST /api/swarm/stacks/:name` accepts a compose YAML string, parses it via the existing `yaml` package, and translates each service into a Swarm service spec, then calls `docker.createService()` for each. Every service gets labeled with `com.docker.stack.namespace=<stack>` so the existing GET/DELETE stack endpoints work symmetrically.

**Supported compose fields per service**:
- `image` (required)
- `command` (string or array)
- `environment` (object or `KEY=VAL` array)
- `ports` (list of `published:target[/proto]` strings or object form)
- `labels`
- `deploy.replicas`, `deploy.mode` (`replicated` or `global`)
- `deploy.restart_policy.{condition,delay,max_attempts}`
- `deploy.placement.constraints`

**Silently skipped** (with warning surfaced in the response and Toast): `secrets`, `configs`, `healthcheck`, `depends_on`, per-service `networks`, `volumes`, `extends`, `deploy.resources`, `deploy.update_config`. Deferred to a v8.8.x follow-up. This is a first-cut MVP — enough to redeploy a small app but not a full replacement for the CLI's `docker stack deploy`.

**Idempotent-ish**: if a service with the composed name already exists it's removed and recreated (matches CLI first-run behavior). A future release will use in-place `service.update()` instead to preserve running state.

**Frontend**: new **Deploy Stack from YAML** button on the Stacks tab opens a modal with a name field + textarea for the YAML. Result panel shows per-service outcome (`OK` / `FAIL` + error) and the list of skipped features.

**Bounds**: 512 KB max YAML payload; 100 services max per stack; stack name validated (`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/`).

### Operator action
None. Backward-compatible. Existing stacks deployed via CLI keep working.

## [8.8.1] - 2026-07-03 — **UX**: OCI runtime alternatives surfaced on the Engine card (Kata / gVisor / crun)

### What
Docker's `info` endpoint reports every configured OCI runtime under `Runtimes` (Kata Containers, gVisor/runsc, crun, sysbox, ...). This release surfaces them in **System → Info → Docker Engine** card:

- **OCI runtimes** row lists every configured runtime (default first, alternatives alphabetically after)
- If any non-default runtime is present, a **SANDBOXED** badge appears next to the row — signal that this host has isolation options beyond stock runc
- Row is hidden when only `runc` is present (no visual noise for the common case)

### Why
This is item #6 in the virtualization roadmap ([`plans/deep-spec-sprint-6-emerging-and-deferred.md`](plans/deep-spec-sprint-6-emerging-and-deferred.md)). Small audience but signals professional-grade dashboard maturity. The plumbing here (backend returns `defaultRuntime`, `runtimes`, `alternativeRuntimes`) also unlocks a future "runtime picker" on the container create form.

### Backend
`dockerService.getInfo()` now returns:
```json
{
  "defaultRuntime": "runc",
  "runtimes": ["crun", "io.containerd.kata.v2", "runc", "runsc"],
  "alternativeRuntimes": ["crun", "io.containerd.kata.v2", "runsc"]
}
```

### Tests
2 new unit tests in `docker-service.test.js`:
- Multiple alt runtimes present → surfaced correctly, sorted, default excluded from alternatives
- Only `runc` present → alternativeRuntimes is empty (row hides in UI)

### Operator action
None. Backward-compatible.

## [8.8.0] - 2026-07-03 — **PLATFORM**: Docker Swarm — Stacks tab (Sprint 2 gap-fill)

### Discovery

While starting Sprint 2 of the virtualization roadmap (Docker Swarm active management), we discovered the Swarm surface was already 90% implemented historically:

- Backend routes at `src/routes/swarm.js` (200+ lines): init/leave, join-tokens, nodes CRUD, services CRUD (including create with full spec), scale, delete, tasks
- Frontend page at `public/js/pages/swarm.js` (590+ lines): Overview / Nodes / Services / Tasks tabs
- Sidebar entry, page registration, `<script>` include — all wired

Only one thing was missing: the **Stacks** tab (services grouped by `com.docker.stack.namespace` label) and the ability to remove a whole stack. This release fills that gap.

### What ships

**Backend** (`src/routes/swarm.js`):
- `GET /api/swarm/stacks` — derives stacks from services by their `com.docker.stack.namespace` label; returns aggregated replica counts (running / desired) per stack. Services without the label appear under a synthetic `_standalone` bucket.
- `DELETE /api/swarm/stacks/:name` — removes all services in the stack. Volumes and networks persist (matches CLI `docker stack rm` semantics; volume cleanup is a separate operator concern).

**Frontend** (`public/js/pages/swarm.js`):
- New **Stacks** tab between Services and Tasks
- Per-row aggregated progress bar (green ≥ 100% running, yellow ≥ 50%, red < 50%)
- Remove button per non-standalone stack with a danger confirmation dialog
- `_standalone` bucket renders as "Standalone services" with actions disabled

**API layer** (`public/js/api.js`):
- `Api.getSwarmStacks()`
- `Api.removeSwarmStack(name)`

**Docs**: No new howto — existing swarm-basics / swarm-services / swarm-networking howtos remain the reference.

### First Sprint 2 delta — future sprints

Sprint 2 in the virtualization roadmap called for **stack deploy from compose YAML** (i.e. `docker stack deploy` semantics — translating a compose YAML into service specs and creating them). That's still deferred to a v8.8.x follow-up because dockerode has no native equivalent and needs a compose-to-service-spec translator. Non-trivial but not urgent — users can still `docker stack deploy` from the CLI and the UI immediately reflects it.

### Operator action

None. Backward-compatible. The new Stacks tab appears for any host that reports Swarm active.

## [8.7.44] - 2026-07-03 — **PLATFORM**: Podman certified — daemon detection + capability matrix + howto

### What
Docker Dash officially certifies Podman as a supported daemon. Podman exposes a Docker-compatible REST API on `/run/podman/podman.sock` (or `$XDG_RUNTIME_DIR/podman/podman.sock` for rootless), so `dockerode` was already working transparently. This release adds:

- **Automatic detection** at runtime: `dockerService.getInfo()` inspects `version.Components[].Name` for "Podman" and returns `daemonType: 'podman'` / `'docker'`
- **Purple PODMAN badge** on the Engine card in System → Info; "Docker Engine" title becomes "Podman"
- **Capability matrix** returned from `/api/system/info`:
  ```json
  {
    "containers": true, "images": true, "networks": true, "volumes": true,
    "compose": true,
    "swarm": false,     // Podman doesn't implement Swarm
    "buildkit": false,  // Podman uses Buildah, different UX
    "plugins": false    // Podman has no plugin system
  }
  ```
  Frontend can now hide Docker-only menu items uniformly instead of per-page `if daemon === 'podman'` sprinkles. (Note: the docker-dash UI doesn't yet HAVE Swarm/plugin menu items — those come in Sprint 2. But the capability plumbing is in place from day one.)
- **Two howto documents**: `podman-integration.md` + `.ro.md` covering rootful + rootless + SELinux setup, multi-host mixed Docker/Podman, and troubleshooting
- **7 new unit tests** in `docker-service.test.js` covering the detection contract (case sensitivity, empty Components, malformed input, fallback to `Platform.Name`, end-to-end capabilities on Docker vs Podman)

### Why now
Podman adoption in Fedora / RHEL / Enterprise Linux is growing. `docker-compose.yml` already documented the Podman socket path via `DOCKER_SOCKET`, but with no formal detection, users would see a UI labeled "Docker" when they were actually running Podman — confusing, and once we ship Swarm management (Sprint 2), those users would see a Swarm menu that produces 404s. This release closes both gaps.

### First Sprint of a larger virtualization roadmap
This ships as the first sprint of a Q3-Q4 2026 roadmap covering:

- Sprint 1 — Podman (this release)
- Sprint 2 — Docker Swarm active management (planned)
- Sprint 3 — Incus / LXC (planned)
- Sprint 4 — Proxmox VE (feedback-gated)
- Sprint 5 — Kubernetes minimal opt-in (feedback-gated)

Full research + deep-specs live under `plans/` (gitignored per project convention). See `plans/deep-spec-virtualization-roadmap.md` for the master plan.

### Operator action
None. Existing Docker deployments are unchanged. To point at a Podman socket:
```env
DOCKER_SOCKET=/run/podman/podman.sock
```

## [8.7.43] - 2026-07-03 — **UX**: "New version available" nudge (SPA tab stale after deploy)

### Bug
Every asset URL in `index.html` already carries `?v=<VERSION>` and the server rewrites `__VERSION__` at request time, so **HTTP caching** is correct — a fresh browser navigation always fetches the new JS.

But Docker Dash is a **long-lived SPA**: users keep the tab open across days, and hash-based routing (`#/system`, `#/dashboard`) does NOT reload `index.html`. So the JS in memory stays at whatever version was loaded when the tab first opened. After v8.7.42 shipped, a user with the tab open since v8.7.39 clicked `#/system`, saw no disk row, and thought the deploy was broken — even though the server was serving the correct new JS. Only a manual `F5` fixed it, but nothing in the UI told them to press it.

Same pitfall affected every previous UX-adding release; the disk row just made it visible.

### Fix
New **version watcher** in `App._initVersionWatcher`:
- Reads the version the JS was loaded with from the existing `#sidebar-version` span (already server-injected via `__VERSION__`)
- Polls `/api/health` (tiny, no-auth) at boot+30s, every 5 min, and on tab focus regain
- When `data.version !== _loadedVersion`, shows a **persistent Toast** with an inline **Reload** button that calls `location.reload()`
- Only fires once per session; skips hidden tabs so unfocused sessions don't nag

**Toast component enhancement**: added an optional `opts.action = { label, onClick }` param. Backward-compatible — no existing caller passes a 4th arg. Styled `.toast-action` as an outlined accent button; on hover it fills with `--accent`.

### Why this is the right fix
- The `?v=` cache-busting was already correct — no need to touch HTTP caching
- The problem is purely "browser tab is older than the server"; the fix has to happen in-app, not at the transport layer
- Poll interval + focus event + one-time flag = minimal traffic (2–3 extra `GET /api/health` per hour per visible tab)
- Users choose when to reload (persistent Toast, not forced) — no lost work

### Operator action
None. First deploy after this release still requires an F5, but every subsequent deploy will pop the Reload nudge automatically.

## [8.7.42] - 2026-06-25 — **UX**: Host card shows disk total + available on the Docker filesystem

### Bug
The **System → Host** card showed hostname, CPUs, memory, containers, images, uptime — but nothing about disk. Operators asking "how much room is left before Docker fills the disk?" had to shell into the host and run `df -h /var/lib/docker`. When the disk actually filled up (image cache growth, log rotation misconfiguration, runaway container producing volume writes), the first symptom was `docker pull` failing with `no space left on device` — no upstream warning from the dashboard.

### Fix
New row on the Host card: **Disk (Docker root)** — shows used / total in formatted bytes with a percentage, available bytes on the right, and a progress bar underneath (green < 70%, yellow < 90%, red ≥ 90%).

Data source: `fs.statfs('/data')` on the docker-dash container. `/data` is a bind-mount to a docker named volume, so `statfs` on that path reports the underlying **host filesystem** stats — the same partition where Docker stores `/var/lib/docker`. This is the operationally correct number: "how much room is left on the disk where Docker keeps its data".

Tooltip on the usage summary shows the `DockerRootDir` value from `docker.info()` so operators can confirm which partition is being measured.

### Multi-host scoping
For remote hosts (`hostId > 0` — SSH-tunneled or TCP-tunneled), the docker-dash filesystem is on a **different machine** than the remote Docker daemon. Reporting our own filesystem stats would be misleading. So the backend only emits `diskTotal` / `diskFree` / `diskUsed` for `hostId=0`; for remote hosts the fields are omitted and the frontend hides the row.

### Implementation
- Backend: [`src/services/docker.js:527`](src/services/docker.js#L527) `getInfo()` — added `dockerRootDir` (from `docker.info().DockerRootDir`) plus `diskTotal` / `diskFree` / `diskUsed` (from `fs.promises.statfs('/data')` on `hostId=0` only). Best-effort — statfs failure (non-Linux dev host, `/data` missing, permission) leaves the fields undefined and the frontend hides the row.
- Frontend: [`public/js/pages/system.js:80`](public/js/pages/system.js#L80) `_renderInfo()` — new `diskRow` template inserted below the Memory row. Uses the existing `.progress-bar` / `.progress-fill.{green,yellow,red}` classes (no new CSS). `role="progressbar"` + `aria-valuenow` for screen reader support.
- 2 new i18n keys (`diskLabel`, `diskAvailable`) in `en.js` + `ro.js`; 9 other locales fall back to English.

### Operator action
None. Backward-compatible — row only appears on the local host tab and only when the OS supports `fs.statfs` (Linux, all Docker Dash deploy targets).

## [8.7.41] - 2026-06-25 — **UX**: Prune cards show equivalent CLI command + Copy button

### Why
Operators kept context-switching to docs when:
- The UI request timed out on huge prune sweeps (`docker system prune -a --volumes` on hosts with TB-scale image caches)
- The Docker socket required root and Docker Dash ran as an unprivileged user
- The HTTP route hung mid-prune

### What
Each of the 5 Prune cards (**System → Prune** tab) now renders, below its action button, a monospace line with the equivalent `docker` CLI command and a small Copy button (icon-only). Above the grid, a one-line hint explains when to fall back to the shell with a sub-note that `sudo` is needed if the operator is not in the `docker` group.

| Card | Command shown |
|---|---|
| Containers | `docker container prune -f` |
| Images | `docker image prune -a -f` |
| Volumes | `docker volume prune -f` |
| Networks | `docker network prune -f` |
| Everything | `docker system prune -a --volumes -f` |

### Implementation notes
- Vanilla template literal inside the existing `_renderPrune` — no new framework, no `onclick=`
- Copy wired via the existing global `[data-copy]` delegated handler in [`app.js:483`](public/js/app.js#L483); fires `Toast.success`
- 3 new i18n keys in `en.js` + `ro.js` (`pruneManualHint`, `pruneSudoNote`, `pruneCopyTooltip`); 9 other locales fall back to English via `_fallback: 'en'`
- 5 new CSS classes (`.prune-manual-hint`, `.prune-sudo-note`, `.prune-cmd`, `.prune-cmd code`, `.prune-cmd-btn` + `:hover` / `:focus-visible`)
- Local test suite still 1521/1521 green

### Operator action
None. Backward-compatible — UI flows unchanged; CLI commands are additive.

## [8.7.40] - 2026-06-22 — **CI**: set `DATA_DIR` in `git-timeouts.test.js` (CI red on every push since v8.7.10)

### Bug
The git-timeouts test added in v8.7.10 forgot to set `process.env.DATA_DIR` before `require('../services/git.js')`. The `GitService` constructor calls `fs.mkdirSync(REPOS_BASE)` at module-load time, where `REPOS_BASE = path.join(DATA_DIR || '/data', 'repos')`. On GitHub-hosted runners (no write access to `/data`) this threw `EACCES: permission denied, mkdir '/data/repos'` and aborted the entire suite. CI was red on every push since v8.7.10 was shipped — but every other workflow (Docker Build & Push, Caddy image, Egress sidecar) stayed green, so the regression went unnoticed.

### Fix
One line added before the require, mirroring sibling tests (`git-validation.test.js`, `pcloud-backup.test.js`):
```js
process.env.DATA_DIR = process.env.DATA_DIR || require('os').tmpdir() + '/dd-test-git-timeouts';
```

### Verification
- Local: full suite 1521/1521 passing
- GitHub CI on commit `78ef019`: ✅ success
- All 5 deploy workflows on the commit: ✅ success

### Operator action
None. Test-only fix.

## [8.7.39] - 2026-06-21 — **SECURITY+RELIABILITY**: CSR temp-dir hardening + 2 more bulk-cap routes

### Bug 1 — `certificates.generateCsr` predictable /tmp paths + world-readable private key (CWE-377, CWE-732)
`generateCsr` wrote three files to `/tmp`:
```js
const confPath = path.join(os.tmpdir(), 'dd-csr-' + Date.now() + '.cnf');
const keyPath  = path.join(os.tmpdir(), 'dd-csr-' + Date.now() + '.key');
const csrPath  = path.join(os.tmpdir(), 'dd-csr-' + Date.now() + '.csr');
```
Three distinct issues:

1. **Predictable paths**: `Date.now()` is millisecond-resolution; an attacker with local /tmp access could pre-create symlinks pointing the writes elsewhere (CWE-377: Insecure Temporary File).
2. **No `flag: 'wx'`**: `fs.writeFileSync` followed existing symlinks. If a symlink at the predicted path pointed to `/etc/anything`, the openssl config (or key, or csr) would overwrite that file.
3. **Private key in /tmp with default umask**: openssl-created `keyPath` got default file mode (typically `0644` — world-readable on default umask 022). For the entire function call, any local user with /tmp read access could read the private key (CWE-732: Incorrect Permission Assignment). Sticky-bit /tmp prevents deletion by others but not read.

On multi-tenant hosts (shared dev boxes, certain container hosts where /tmp is a shared mount), this is a real key disclosure vector.

**Fix**: replaced with `fs.mkdtempSync(path.join(os.tmpdir(), 'dd-csr-'))` — creates a directory with mode `0700` (owner-only) and a cryptographically-random suffix. All three files live inside that dir; they inherit the owner-only boundary. Cleanup is a single `fs.rmSync({recursive: true})`. Added `flag: 'wx'` to `writeFileSync` as defense-in-depth even inside the mkdtemp dir.

### Bug 2 — `POST /api/notifications/bulk` `ids[]` unbounded
Same pattern as v8.7.36 and v8.7.38. `bulkAction` runs `IN (...)` with placeholder count equal to `ids.length`. 100k+ ids would pin SQLite writer.

**Fix**: cap at 1000 with 413 + split-guidance.

### Bug 3 — `POST /api/images/scan-history/delete` `ids[]` unbounded
Same pattern. Capped at 1000 with guidance to use the retention purge cron for full-table sweeps.

### Operator action
None. Backward-compatible for all three. The CSR generation flow produces the same outputs; only the temp-file plumbing is hardened.

## [8.7.38] - 2026-06-21 — **SECURITY+RELIABILITY**: groups scope check + remediation scheduler shutdown

### Bug 1 — groups `addContainers` / `removeContainer` lacked scope check (CWE-639)
`POST /api/groups/:id/containers` and `DELETE /api/groups/:id/containers/:containerId` passed `req.params.id` straight to the service layer without verifying the caller could see the target group. The service methods themselves had no scope filter on the join-table operations.

An operator-role user could:
- Add containers to ANOTHER user's user-scoped group by guessing/iterating `:id`
- Remove containers from another user's user-scoped group the same way

**Severity**: LOW (operator can already create global groups; the data exposure is "which containers does another user have in their personal group"). CWE-639: Authorization Bypass Through User-Controlled Key.

**Fix**: route now calls `groups.get(id, req.user.id)` first — this returns null if the group is user-scoped to a different user. 404 returned in that case, same response as a missing group (no enumeration leak).

### Bug 2 — `containerIds[]` unbounded in groups add
Same pattern as v8.7.36 — `addContainers` ran `INSERT OR IGNORE` in a transaction over an unbounded array. 100k entries would pin the SQLite writer.

**Fix**: cap at 1000 with 413 + split-guidance.

### Bug 3 — remediation scheduler not stopped on graceful shutdown
`server.js` boot called `remediationScheduler.start()` (line 384) but the matching `stop()` was missing from the SIGTERM/SIGINT handler. The `setInterval` kept firing through the rest of shutdown — could mid-execute a remediation `runJob()` against a tearing-down dockerService or write to a closing DB.

**Fix**: added `try { require('./services/remediation-scheduler').stop(); } catch {}` to the shutdown sequence, between log-forwarder.stopAll and jobs.stopAll. Also added `.unref()` to the scheduler's timer so the process can exit even if shutdown is bypassed (e.g., uncaught exception path).

### Operator action
None for any of the three. Backward-compatible.

## [8.7.37] - 2026-06-21 — **SECURITY**: git webhook fail-closed (no-secret + unknown-provider) (CWE-345)

Two fail-open patterns in `POST /api/git/webhook/:token` — both let webhook deliveries succeed without signature verification under misconfigurations the admin might not notice.

### Bug 1 — empty webhook secret silently disabled signature checks
```js
// before
if (secret) {
  const valid = validateSignature(provider, rawBody, secret, req.headers);
  if (!valid) return res.status(401).json(...);
}
```
If `stack.webhook_secret` was empty (admin enabled webhooks but didn't configure a secret), the entire signature block was skipped. The route proceeded to deploy directly. The webhook URL token IS supposed to be the shared secret in this fallback, but URL tokens leak:
- Pasted into PR descriptions
- Captured in screen recordings, screenshots, browser history
- Logged by intermediate proxies / CDN access logs
- Written into CI logs

Once leaked, anyone could force a production deploy of the latest commit on the watched branch. CWE-345: Insufficient Verification of Data Authenticity.

**Fix**: when `deploy_on_push` is enabled and no secret is configured, the request is rejected with 401. The notification-only mode (deploy_on_push=false) still works without a secret — the worst case there is an unwanted "update available" WebSocket broadcast, which is informational not destructive.

### Bug 2 — unknown `webhook_provider` returned `true`
```js
// before
default:
  return true; // Unknown provider, skip validation
```
If an admin set `webhook_provider` to a value the route didn't recognize (typo: "Github" instead of "github", forward-compat "gitea2", custom string), signature validation silently returned `true` and accepted any payload. The intent was probably "be permissive for custom integrations," but it inverted the security default.

**Fix**: `return false`. The admin can fix the provider field; an unsupported provider must not silently disable signature checks.

### What did NOT change
- Branch-mismatch filter: still ignores webhooks for non-tracked branches (defense in depth)
- Token lookup: still parameterized, still 404 on miss
- `timingSafeCompare`: still uses `crypto.timingSafeEqual` correctly
- All 5 supported providers (github, gitlab, gitea, bitbucket, generic): validation behavior identical

### Operator action
- **If you enabled webhooks WITHOUT setting a secret AND deploy_on_push is on**: configure a secret in **Stack → Auto-Deploy → Webhook Secret**, then update the provider-side webhook configuration with the same secret. Webhooks fail closed with 401 until both are set.
- **If you set webhook_provider to a typo / custom value**: fix it to one of `github`, `gitlab`, `gitea`, `bitbucket`, `generic`. Webhooks reject with 401 until the value matches.

## [8.7.36] - 2026-06-21 — **RELIABILITY/DOS**: bulk-input caps (secrets rotation + bundle import)

Two endpoints that iterate over user-supplied arrays without an upper bound. Both admin-gated (no unauthenticated DoS), both prepared-statement-safe (no SQL injection), but both could pin DB writer / image-pull workers for hours on pathological input.

### Bug 1 — `POST /api/secrets/rotations/bulk` unbounded `secrets[]`
The route accepted `req.body.secrets` and looped through each entry, running **2 prepared queries per entry** inside a single transaction (existence check + insert/update). A caller could submit 100,000 secrets and pin the SQLite writer for several seconds, blocking every other write across the app.

**Fix**: cap at 1000 entries per call. Typical app inventories have 5-30 env vars; 1000 is generous. Over the cap returns `413 Payload Too Large` with guidance to split into multiple calls.

### Bug 2 — `stackBundle.importBundle` unbounded `images[]`, `volumes[]`, `containers[]`
A malicious or malformed bundle file could specify thousands of images. Each pull has a 10-min timeout (v8.7.28); 100 images × 10 min worst-case = 16 hours of pinned import-thread work. Similar for volumes and container creation.

**Fix**: per-array caps of 100 each (`{ images: 100, volumes: 100, containers: 100 }`). Throws a clear error pointing to "split into smaller bundles" if exceeded. A typical stack has 1-10 images and < 20 containers; 100 is well beyond legitimate use.

### Batch 29 (observability) — audited, no fixes needed
- `observability-detect._probe`: 2 s timeout + `req.on('timeout')` destroy + URL validation + http/https protocol allowlist ✓
- `observability-import.importDashboard`: 10 s timeout (route is already admin-only via `router.use(requireAuth, requireRole('admin'))`) ✓

### Operator action
None. Backward-compatible for normal use; only pathological input is now bounded.

## [8.7.35] - 2026-06-21 — **SECURITY**: `POST /api/system/stacks/:name/validate` requireRole gate (CWE-862)

### Bug
`POST /api/system/stacks/:name/validate` accepted YAML content, wrote it to `/tmp`, and invoked `docker compose -f tmpFile config --quiet` to validate it. The route only required `requireAuth` — every other stack-management route in the same file (compose action, stacks create, config update, env, deploy) required either `admin` or `admin/operator`. The validate route was the only outlier.

### Impact
A user holding the `viewer` role (or any authenticated session) could:
- Invoke the `docker` CLI on the host indirectly
- Write up to 2 MB of YAML to `/tmp` per request (body parser limit)
- Repeat the call to amplify resource usage

The temp file IS cleaned up correctly in a `finally` block — no disk leak — but viewers should not be able to trigger the docker daemon at all, and the validate path was a route-level privilege escalation: viewer → write-to-tmp + docker-compose-spawn.

CWE-862: Missing Authorization.

### Severity
**LOW-MEDIUM**. Auth required, no role escalation (viewer stays viewer; docker compose config --quiet returns only error messages, no daemon mutation). But it lets viewer-role accounts cause CPU + I/O work the threat model intends to deny them.

### Fix
Added `requireRole('admin', 'operator')` matching the sibling validate-adjacent routes in the same file.

### Operator action
None. Backward-compatible for admin/operator. Viewer-role users now get 403 from this endpoint — UI clients calling it from a viewer session should hide the validate button when role !== 'admin' && role !== 'operator'.

## [8.7.34] - 2026-06-21 — **RELIABILITY**: `execCommand` 8 MB output cap + 60 s timeout

### Bug
`dockerService.execCommand(containerId, cmd, hostId)` ran an arbitrary command inside a container and buffered the full multiplexed Docker stream output into a `chunks` array, then concatenated at end-of-stream. Two gaps:

1. **Unbounded output buffer**: a caller that exec'd a verbose command (e.g. `cat /var/log/...`, `journalctl`, `ls -R /`) could allocate gigabytes of heap as the chunks accumulated. The Docker stream had no end-of-stream guarantee on size.
2. **No timeout**: a hung exec (process waiting on stdin, deadlocked subprocess, infinite loop) would leave the promise pending forever and tie up the calling HTTP request handler.

The current callers in the codebase all expect short, sub-second status output (`docker version` style), so under normal operation this never bites. But every caller that opens this path inherits the unbounded behavior — and as new features get added, the assumption can quietly break.

### Fix
- **8 MB output cap**. When the cap is hit: stream is destroyed and the truncated output returned with a sentinel suffix `[execCommand output truncated at 8 MB]` so callers can detect truncation if they care.
- **60-second wall-clock timeout**. Pathological for any current caller (existing usage is sub-second); 60 s is the failsafe before upstream proxies time out.
- `close` event handler added alongside `end` because some Docker daemons fire `close` instead of `end` after `destroy()`. Guarded with a `settled` flag so the promise resolves exactly once.

### Operator action
None. All known callers stay well under the 8 MB / 60 s budgets; only pathological hostile or buggy callers are now bounded.

## [8.7.33] - 2026-06-21 — **RELIABILITY/DOS**: cap user-supplied LIMIT across 6 paginated routes

### Bug — unbounded `?limit=` query parameter
Six paginated endpoints accepted `?limit=` from the query string and passed `parseInt(limit) || N` straight into SQL `LIMIT ?` clauses without a cap. A caller could request `?limit=1000000` and receive multi-hundred-MB JSON responses, allocating peak heap and tying up the event loop while the response serialized.

| Endpoint | Default | Pre-fix max | Post-fix cap |
|---|---|---|---|
| `GET /api/system/events` (docker events) | 100 | unbounded | 1000 |
| `GET /api/alerts/history` | 50 | unbounded | 500 |
| `GET /api/git/stacks/:id/deployments` | 20 | unbounded | 200 |
| `GET /api/audit/` (misc-audit) | 50 | unbounded | 500 |
| `GET /api/notifications/` (misc-notifications) | 50 | unbounded | 200 |
| `GET /api/egress-filter/.../block-log-grouped` | 50 | unbounded | 1000 |

All require `requireAuth`; `audit` and `system/events` additionally require `admin`. So no unauthenticated DoS, but any authenticated user (or compromised session token) could trigger a multi-hundred-MB allocation per request. Repeated requests would saturate memory.

### Reference pattern already in the codebase
The pattern `Math.min(Math.max(parseInt(limit) || DEFAULT, 1), MAX)` was already used by `routes/audit.js:18` (capped at 500), `routes/remediate.js:199` (100), `routes/egress-filter.js:372` (1000), and v8.7.21's `routes/audit.js:30` ai-search (2000). This release brings the rest of the codebase in line.

### Operator action
None. Normal UI use is well under all caps; only requests with explicit oversized `?limit=` query params are now bounded.

## [8.7.32] - 2026-06-21 — **RELIABILITY**: audit `verify()` streaming + `export()` row cap (OOM bound)

### Bug 1 — `verify()` loaded the entire audit_log into memory
`auditService.verify({fromId, toId})` ran `stmt.all()` on the audit_log table. With no filters specified (the default when an admin opens `/api/audit/verify`), this loaded **every row** into memory. On long-running installs the audit_log grows into millions of rows — every container action, every login, every config change, every AI call gets a row. Loading the full table allocated O(N × row-size) heap; on a 2-year install with 5M+ rows of ~500-byte average payload, that is ~2.5 GB of heap allocated just to walk the chain.

**Fix**: replaced `stmt.all()` with `stmt.iterate()`. Holds **one row** at a time. The sibling `exportJsonl` method already used this pattern (comment: "no buffering, safe for large months"); now `verify()` does too.

### Bug 2 — `export()` materialized both the rows array AND the serialized string
`auditService.export(format, filters)` did:
1. `stmt.all()` — full result in memory as rows array
2. `JSON.stringify(rows)` / `_toCsv(rows)` / `_toSyslog(rows)` — full serialized output as another string in memory

So peak memory was ~2× the result size. For a million-row export at ~500 bytes JSON-stringified, that's ~1 GB peak heap. The endpoint requires admin role, so no unauthenticated DoS, but a careless export click could OOM the process.

**Fix**: server-side `COUNT(*)` precheck. If the would-be result exceeds 500,000 rows, throw a `413 Payload Too Large` error with a message pointing the operator to either narrow the date range or use the streaming `exportJsonl` path (used by the v8.2.0 monthly off-site dump). 500k was picked as the boundary where peak heap stays under ~300 MB even for typical-shape rows — comfortable for normal cloud nodes, well under any operator's memory budget.

### Why not full streaming for `export()`?
The current API returns a string; the route does `res.send(data)`. Converting to streaming would change the function signature and update every caller. Out of scope for a bug-fix release. The row cap blocks the OOM, and operators with legitimate big-export needs already have `exportJsonl` (used by the monthly archive job) — which already streams correctly.

### Operator action
None for normal use. After upgrade, an admin who hits the export endpoint on a > 500k-row range gets a clear error explaining why and what to do instead. The `verify()` route is safe regardless of row count.

## [8.7.31] - 2026-06-21 — **RELIABILITY**: migration.js `dstDocker.pull` timeout (missed v8.7.28 site)

Follow-up to v8.7.28 — the cross-host migration service has its own `docker.pull` callsite at [`src/services/migration.js:57`](src/services/migration.js#L57) that was missed by the previous sweep's grep (the variable name `dstDocker.pull` happened to match the same pattern, but I overlooked it in the diff).

### Impact pre-fix
Without a timeout on the destination-host pull:
- A hung registry on the destination host blocks the migration thread indefinitely
- Source container is still running (`zeroDowntime` mode hasn't stopped it yet — we're in Step 2)
- BUT the user's HTTP request and the migration-progress stream hang
- The admin sees the spinner forever and may force-stop in confusing state

### Fix
Same shared `src/utils/docker-pull.js` helper that v8.7.28 introduced — 10-min wall-clock + stream-destroy on timeout.

### Audit closure
All 8 `docker.pull` callsites across `src/services/` and `src/routes/` now use the shared helper, EXCEPT `src/routes/images.js:46` which streams progress to the client via SSE (bounded by client connection lifecycle — different semantics, intentionally left as-is).

### Operator action
None. Backward-compatible.

## [8.7.30] - 2026-06-21 — **RELIABILITY**: log-pattern per-line length cap (ReDoS bound)

### Bug
`log-patterns.js` runs 28+ regexes against every line of container output for the **Diagnose** flow on each container. Several patterns combine greedy quantifiers with literal anchors:

- `/killed process \d+.*oom/`
- `/unhandled.*rejection/`
- `/redis.*timeout/`
- `/FATAL ERROR: .* JavaScript heap out of memory/`
- a handful of others

These backtrack at O(N²) on a long line that has the prefix but never matches the trailing literal. A container that emits unbuffered JSON or a giant single-line stack trace — common with apps that write logs without newline-delimiting structured payloads — would lock the Node.js event loop for **seconds** across the 28+ patterns.

Trigger conditions:
- Container produces a 10 MB+ single line (no `\n`)
- Admin clicks "Diagnose" on that container
- Or scheduled diagnosis runs against it (no such cron today, but possible)

Result: entire server unresponsive while the regex engine backtracks.

### Fix
Per-line truncation to 10,000 chars before any regex matching:
```js
const MAX_LINE_LEN = 10_000;
const lines = rawLines.map(l => l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) : l);
```
Worst-case work is now `10_000 × 28 ≈ 280k ops per diagnose call` — negligible. Patterns match substrings so truncation doesn't break detection accuracy; the existing `matchedLine` field that ends up in the UI was already independently truncated to 200 chars.

### Why per-line cap rather than rewriting the regexes
The patterns are operator-meaningful (Java OOM, Node UnhandledRejection, etc.) and rewriting them to avoid greedy quantifiers would either complicate them with possessive quantifiers (PCRE-only, JS doesn't have them) or require restructuring with anchors that change matching semantics. A blanket input-length cap is simpler, easier to reason about, and has no false-negative downside for the realistic case of normal-length log lines.

### Operator action
None. Backward-compatible — normal log lines (< 10K chars) are processed identically.

## [8.7.29] - 2026-06-21 — **HA**: rate-limit Lua-atomic + correct `retryAfterSec`

Two distinct bugs in the Redis fixed-window rate limiter, both shipped together because the fix touches the same six lines.

### Bug 1 — `retryAfterSec` returned the entire window length
```js
// before
if (count > maxRequests) {
  return { allowed: false, remaining: 0, retryAfterSec: Math.ceil(windowMs / 1000) };
}
```
For a 15-minute login rate-limit window (typical for the auth route in this codebase), a client that hit the limit at second 870 of the window was told `Retry-After: 900` instead of the correct ~30s until the bucket rolled. Clients waited up to N× longer than necessary — and `Retry-After: 900` against a login endpoint feels broken enough that users assume the system is down.

**Fix**: compute time-until-bucket-rolls-over from the current bucket index:
```js
const retryAfterSec = Math.max(1, Math.ceil(((bucketIdx + 1) * windowMs - now) / 1000));
```
1-second minimum so clients don't busy-retry at sub-second intervals.

### Bug 2 — `INCR` + `PEXPIRE` was two round-trips → permanent block on race
```js
// before
const count = await r.incr(bucket);
if (count === 1) await r.pexpire(bucket, windowMs + 1000);
```
If the Redis connection dropped between `INCR` returning `1` and `PEXPIRE` landing (a few ms is enough on a busy / lossy Redis), the bucket key existed with no TTL. Every subsequent request kept incrementing the key forever — that specific `(route, IP)` combination was **permanently rate-limited** at the configured `maxRequests` until an admin manually `DEL`'d the key or restarted Redis. No symptoms in standalone mode; HA-only.

**Fix**: atomic Lua script — single round-trip, no race:
```lua
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c
```

### Standalone path unaffected
The in-memory sliding-window limiter (`src/services/rate-limiter-memory.js`) was already correct on both counts:
- Uses `times[0] + windowMs - now` for true sliding-window retry-after
- Single-threaded event loop means no INCR/EXPIRE race possible

### Operator action
None. Backward-compatible. HA replicas that suffered permanently-blocked rate-limit keys now self-heal at the next bucket roll-over (typically within `windowMs`).

## [8.7.28] - 2026-06-21 — **RELIABILITY**: `docker.pull` wall-clock timeout (10 min) across 7 sites

### Bug
`dockerode`'s `docker.pull` returns a streaming response; `followProgress` resolves when the stream ends. There is **no timeout**. A registry that stopped responding mid-pull (network drop after handshake, slow-loris registry, single layer server hang) would block the caller indefinitely.

Eight call sites in the codebase, none with a timeout:
- `src/services/pipeline.js` — auto-deploy pipeline (Stage 1)
- `src/services/docker.js` — `pullImage()` method
- `src/services/stackBundle.js` — bundle export image pre-pull
- `src/routes/containers.js` — sandbox container creation (line 594)
- `src/routes/containers.js` — manual container recreate (line 911)
- `src/routes/containers.js` — image update flow (line 1187)
- `src/routes/registries.js` — authenticated private-registry pull
- `src/routes/templates.js` — template deploy pre-pull

All eight could hang the calling HTTP request or background job indefinitely.

### Fix
New shared helper `src/utils/docker-pull.js` exports `pullImage(docker, image, { timeoutMs, authconfig })`:
- Default 10-minute wall-clock timeout (generous for multi-GB images; mainstream images pull in < 2 min)
- On timeout: destroys the dockerode stream so the descriptor and event-loop slot get released
- `finished` guard prevents double-resolve/reject when timeout races followProgress

7 of 8 sites converted to use the helper. The 8th (`src/routes/images.js:46`, `POST /api/images/pull` with Server-Sent Events streaming progress to the client) keeps its raw `docker.pull` call because it streams to the HTTP response — the client disconnect bounds the lifecycle. Flagged as a known issue for follow-up if needed.

### Known issue — pipeline "destructive swap"
While auditing this code path, identified a deeper design concern (not fixed in this release): both `pipeline.js` Stage 3 and `containers.js:917` `remove()` the original container **before** creating/starting the new one. If create or start fails, the operator is left with no running container at all. Fix would require a blue-green pattern (create new with temp name → verify → swap → remove old) — too invasive for a bug-fix release.

### Operator action
None. Backward-compatible. Slow legitimate pulls still complete; only previously-infinite hangs are bounded.

## [8.7.27] - 2026-06-21 — **RELIABILITY**: SSH tunnel exponential-backoff infinite retry (was: single-attempt-then-dead)

### Bug
`SshTunnelService._scheduleReconnect` scheduled **one** reconnect 15 seconds after a tunnel failure. If that one attempt failed, the tunnel was left permanently dead in the `_tunnels` Map (actually deleted from the Map, but no further scheduling). Any transient network outage longer than 15 seconds meant the host stayed offline in Docker Dash until an admin manually re-added it or restarted the process.

```js
// before
_scheduleReconnect(hostConfig) {
  const tunnel = this._tunnels.get(hostConfig.id);
  if (tunnel) {
    if (tunnel.reconnectTimer) return;
    tunnel.reconnectTimer = setTimeout(async () => {
      this._tunnels.delete(hostConfig.id);
      try { await this.createTunnel(hostConfig); }
      catch (err) { log.error(...); }  // ← no follow-up reconnect
    }, 15000);
  }
}
```

Real-world triggers:
- Remote daemon restart taking > 15s (kernel update, big image pull, host reboot)
- Brief WAN outage on a remote host (ISP blip)
- Remote host SSH service restart (`systemctl restart sshd`)

After any of these, the host appeared "unreachable" in the dashboard with no automatic recovery.

### Fix
Exponential backoff with infinite retry:
- Attempt 1: 15s delay
- Attempt 2: 30s
- Attempt 3: 60s
- Attempt 4: 2min
- Attempt 5: 4min
- Attempt 6+: capped at 5min

Each tunnel slot tracks `reconnectAttempts` across the gap. On every successful reconnect, the counter resets to 0 (the new tunnel entry from `createTunnel` starts fresh). On every failure, a placeholder is re-inserted into `_tunnels` so the next `_scheduleReconnect` can find it and chain another attempt.

### Operator action
None. Hosts that previously needed manual recovery after a > 15s outage now self-heal.

## [8.7.26] - 2026-06-21 — **RELIABILITY**: bounded cooldown Maps + workflow webhook timeout

### Bug 1 — unbounded cooldown Maps (slow memory leak)
Two services tracked event/rule cooldowns in JS Maps that **never had entries removed**:

- `eventNotifier.cooldowns` — one entry per unique `(eventType, containerName)` combo
- `workflows._cooldowns` — one entry per unique `(ruleId, containerName)` combo

On busy hosts with ephemeral containers (CI runners, autoscalers, k8s-style pods), the Maps could reach millions of entries over weeks of uptime — a slow memory leak that operators wouldn't notice until OOM after months. Each Map grew without bound; old entries past their cooldown window stayed forever, just being overwritten on a re-fire of the same key (which only happens if the same container name reappears).

**Fix**: bounded LRU-by-eviction. When the Map exceeds 5000 entries, prune entries older than the relevant max-age:
- eventNotifier: prune past `COOLDOWN_MS` (1 min) — cooldown is fixed
- workflows: prune past 24 h — per-rule `cooldown_seconds` varies, but anything >24h suggests a misconfigured rule

Worst-case overhead: O(N) every 5000 inserts; amortized O(1) per insert.

### Bug 2 — workflow `webhook` action had no timeout (SSRF/DoS)
`WorkflowService._executeAction` case `'webhook'` called `fetch(actionConfig.url, { ... })` with no `AbortController`. `actionConfig.url` is admin-supplied via the workflow rule editor — could be any URL.

Two problems combined:
- **Hung webhook target blocks evaluate()**: `evaluate()` iterates `for (const rule of rules) for (const target of targets)` serially. A hung webhook URL would block the entire workflow evaluation for every subsequent rule × target for as long as the remote server stayed unresponsive — Node's default `fetch` has **no timeout**.
- **Same risk class as notificationChannels.ntfy** fixed in v8.7.19, just in a different service.

**Fix**: explicit `AbortController` + `setTimeout(..., 10_000)` matching the 10s budget every other webhook/notification path in the codebase uses.

### Operator action
None. Backward-compatible. Cooldown pruning is invisible; webhook actions that previously hung now fail fast.

## [8.7.25] - 2026-06-20 — **HA**: kickstart leader election at boot (no 10s gap)

### Bug — HA-only cold start delay
`cluster.isLeader()` uses a lazy-init pattern: the Redis election loop only starts the first time `isLeader()` is called. The intent was "don't incur Redis traffic if nothing in this process needs leader status." But in practice, no code calls `isLeader()` at boot — every caller is reactive:
- `_m()` cron wrapper calls it inside each scheduled tick (so the first fast tick is `alert-evaluate` 10s after boot)
- The 60s bootstrap update-check calls it
- WebSocket handlers don't poll until message-driven

So in HA mode, the node spent the first ~10s of runtime in `_leaderState = 'unknown'`. During that window:
- `gitPolling.startAll()` had not run (waiting for `onBecomeLeader` to fire)
- The WebSocket Docker event stream had not started (same)
- Cron jobs that ticked in that window would no-op until the first election completed (`isLeader()` returns false during 'unknown')

The cold-start gap was bounded at 10s by the shortest setInterval (alert-evaluate), but it was wasted time — git polling on a real workload would miss its first 10s of upstream commits.

### Fix
One line at the end of `jobs.startAll()`:
```js
cluster.isLeader().catch((e) => log.warn('initial election kickstart failed', { message: e.message }));
```
This triggers the lazy init synchronously at boot — election fires, transition to `'leader'` or `'reader'` happens within milliseconds, registered `onBecomeLeader` / `onBecomeReader` callbacks (gitPolling, WS stream, etc.) fire immediately.

### Standalone is unaffected
In standalone mode, `cluster.isLeader()` returns `true` synchronously without I/O (line 185 of cluster.js: `if (!isHa()) return true`), and `onBecomeLeader` already fires synchronously on registration. The new kickstart call is a no-op.

### Operator action
None. Backward-compatible. HA leader replicas now reach steady state ~10s faster.

## [8.7.24] - 2026-06-20 — **RELIABILITY**: stats rollup UNIQUE index now includes `host_id` (multi-host correctness)

### Bug
The UNIQUE indexes on the three stats rollup tables were:
```sql
CREATE UNIQUE INDEX idx_stats1m_container_bucket ON container_stats_1m(container_id, bucket);
CREATE UNIQUE INDEX idx_stats1h_container_bucket ON container_stats_1h(container_id, bucket);
CREATE UNIQUE INDEX idx_stats1d_container_bucket ON container_stats_1d(container_id, bucket);
```
But the aggregation queries in `src/services/stats.js` `GROUP BY (host_id, container_id, strftime(bucket))` and `INSERT INTO` includes `host_id`. So the SELECT can legitimately produce multiple rows for the same `(container_id, bucket)` when two hosts happen to have a container with the same ID. The `INSERT OR IGNORE` then **silently drops all but one host's bucket** because the UNIQUE constraint didn't include `host_id`.

### Severity
**LOW** in practice — Docker generates random 64-char container IDs so collision under normal operation is cryptographically negligible. The real failure modes are administrative:
- Container snapshot restored across hosts
- Backup-imported state with the same container_id present on the new host
- (Theoretically) deliberate ID forgery

But the fix is mechanical and the data loss when triggered would be silent — operators wouldn't see "host B's stats just stopped appearing in the 30-day chart" without diving into the raw tables.

### Fix
Migration 068 reshapes the constraint:
- Drops the three old indexes
- Defensive dedupe (keep highest id per `(host_id, container_id, bucket)`) — no-op on systems where the bug never triggered
- Recreates as `(host_id, container_id, bucket)` UNIQUE on all three rollup tables

No query-side change needed — the SELECT/INSERT statements already include `host_id` in both projection and GROUP BY.

### Operator action
None. Migration auto-applies at startup. Existing `INSERT OR IGNORE` semantics keep aggregation idempotent (same bucket can still be re-aggregated safely).

## [8.7.23] - 2026-06-20 — **FUNCTIONALITY/HA**: git auto-deploy config takes effect immediately (no restart)

### Bug — silent no-op after the UI toggle
`PUT /api/git/stacks/:id/auto-deploy` updated the `git_stacks` row's `polling_enabled`, `polling_interval_seconds`, and `deploy_on_push` fields and returned `{ ok: true }`. The in-memory `GitPollingManager._intervals` Map was never touched.

Concrete consequences:
- Admin toggles **Auto-deploy ON** in the UI → DB says enabled → no `setInterval` is started → **polling never runs until next server restart**, no deploys happen
- Admin toggles **Auto-deploy OFF** to stop surprise deploys → DB says disabled → interval keeps firing → next polling tick still deploys
- Admin shortens the interval from 5 min to 1 min for a critical stack → DB row updated → interval still fires every 5 min

The `{ ok: true }` response made it look like the change took effect. Operators trusted the UI and were silently working with stale polling state.

### Bug — broken in HA mode
Even worse in HA: `gitPolling.startAll()` only runs on the leader (gated by `cluster.onBecomeLeader` in `jobs/index.js`). If the API request landed on a **reader** replica, the local route handler couldn't have done anything useful even if it had called `gitPolling.start/stop` — the reader has an empty `_intervals` Map by design. The actual polling lived on the leader, which never heard about the DB change.

### Fix
1. **`gitPolling.reconcileStack(stackId)`** — new method. Reads the stack's current `polling_enabled` + `polling_interval_seconds` and starts/stops/restarts the in-memory interval to match. Idempotent (`start()` already calls `stop()` first). **Leader-gated** via `cluster.isLeader()` so calling on a reader is a safe no-op.
2. **Cluster pubsub fanout** — `startAll()` now subscribes to `git-polling:reconcile`. When the API call lands on a reader, the route publishes a reconcile message; the actual leader receives it and reconciles its own `_intervals`. In standalone, `cluster.publish/subscribe` are no-ops (only the local `reconcileStack()` call runs).
3. **Route handler** — `PUT /auto-deploy` now calls `gitPolling.reconcileStack(id)` (local, correct for standalone) + `cluster.publish('git-polling:reconcile', { stackId })` (HA fanout, no-op for standalone) after the DB write.

### Net effect
- **Standalone**: UI toggles take effect within milliseconds of the API call returning. No restart needed.
- **HA**: API on any replica → reader publishes → leader reconciles in pubsub callback. End-to-end latency is one Redis round-trip (~ms). No restart needed.

### Operator action
None. After upgrade, the UI works as users always thought it did.

## [8.7.22] - 2026-06-20 — **RELIABILITY**: registry rewrap lazy (no shutdown race, no test teardown warning)

### Bug
`RegistryService` constructor scheduled the legacy XOR → AES-GCM password rewrap via:
```js
constructor() {
  setImmediate(() => this._rewrapLegacy());
}
```
Fire-and-forget. Two real problems:

1. **Production shutdown race.** If the process received SIGTERM right after constructor (e.g., a fast `docker stop` during a rolling restart, or a failing health check triggering immediate restart), the immediate would fire DURING shutdown — call `getDb()` which would **reopen** the DB singleton, run the entire migration runner from scratch, decrypt passwords, write back to disk — all while the rest of the app was tearing down. The connection would then leak (no close path).

2. **Test teardown noise.** In Jest, the immediate fires after the test body finishes but before Jest exits. By then the DB singleton has been closed by `afterEach`, so the rewrap path hits a fresh `getDb()` call that triggers `runMigrations` against a module-cache-confused environment, throws `migration.up is not a function`, and the `log.warn` for that fires AFTER Jest considers tests done. Every test run printed:
   ```
   Cannot log after tests are done. Did you forget to wait for something async in your test?
     Attempted to log "Registry legacy rewrap skipped: migration.up is not a function"
   ```
   on the regsitry-related suites. Three identical warnings per run, masking real teardown leaks.

### Fix
Constructor no longer schedules anything async. Replaced with:
- `this._rewrapped = false` flag set in constructor (synchronous)
- `_ensureRewrapped()` private method that runs `_rewrapLegacy()` once per process
- Called from `_decryptLegacyOrNew` (the only place that actually consumes an encrypted password) on first invocation

For installs with no registries configured, the rewrap simply never runs — no work is wasted. For installs with registries, the rewrap fires on the first private-registry pull/push (or first list of repos for that registry), which happens after full app boot — no shutdown race window, no test teardown problem.

The rewrap itself is idempotent (already-AES-GCM rows are detected and skipped), so multiple-fire-by-accident is safe.

### Verification
After this release, the registry-related "Cannot log after tests are done" warnings are gone from the test report. Remaining teardown noise is from `cluster.js` (Redis client connect events firing post-teardown) — a separate known issue, also harmless in production.

### Operator action
None. Backward-compatible. Legacy passwords still get rewrapped on first use after upgrade.

## [8.7.21] - 2026-06-20 — **RELIABILITY/COST**: AI search input length cap (2000 chars)

### Issue
`POST /api/audit/ai-search` validated that `query` was a non-empty string but did **not** cap its length. The global express body-parser limit is 2 MB, so a hostile (or merely careless) admin could send a megabyte-scale "query" string straight to the configured LLM provider.

### Cost math
- OpenAI / Anthropic input pricing: ~$3–15 per 1M input tokens
- ~4 chars per token
- 2 MB query → ~500K tokens
- **Single bad call: $1.50–$7.50**

An automated mistake in client code (autocomplete dumping a whole file into the search box, retry loop on a failed call) could run up real money fast — especially with managed-provider keys where every request is direct dollar cost.

### Fix
Explicit `if (query.length > 2000) return 400`. Audit-search queries are natural-language questions ("who deleted prod-redis last Tuesday?") — well under 200 chars in normal use. 2000 is generous headroom.

### Response side was already protected
- `audit-search.js` sets `maxTokens: 256` (response is a tiny JSON filter object)
- Schema validator drops anything the LLM hallucinates outside the closed action enum
- Server-side `limit` cap of 200 regardless of what the LLM returned

The input side was the only unbounded surface. Now closed.

### Other AI surface (audited, no fixes needed)
- All three provider adapters (openai/anthropic/ollama) have explicit per-request timeouts (15s/15s/30s) with `req.on('timeout')` handlers
- Redactor runs always-on with `AiRedactionError` → abort-the-call semantics (privacy beats utility — D4 decision from the v8.0.0 spike)
- Every AI call writes an audit log entry with payload hash for later verification, regardless of success
- System prompt for audit-search is server-controlled; users only supply the `query` text (no system-prompt injection vector)
- Route requires `admin` role via `requireRole('admin')` — no operator/viewer access

### Operator action
None. Backward-compatible — normal queries are far under 2000 chars.

## [8.7.20] - 2026-06-20 — **RELIABILITY**: transactional `/restore` + accurate response semantics

### Bug 1 — `/restore` was not transactional
`POST /api/system/backup/restore` looped through `data.settings` and `data.apiKeys` calling `INSERT OR REPLACE` one row at a time, with no transaction wrapper. If the process was killed mid-restore (OOM, SIGTERM, disk full, container restart, file-system error), the settings table could be left **half-applied** — some keys updated, some not. Subsequent reads would mix new and old config in non-obvious ways.

**Fix**: wrapped the entire body in `db.transaction(() => { ... })()`. better-sqlite3's transaction helper opens `BEGIN`, calls the function synchronously, `COMMIT`s on return, `ROLLBACK`s on throw. The pre-existing per-row `try/catch { /* skip */ }` for apiKeys is preserved INSIDE the transaction — individual bad rows still get skipped silently (the previous behavior); only an irrecoverable error (prepare failure, disk-full) rolls back the entire restore.

### Bug 2 — Misleading `users: 0` in restore response
The response counter was `restored = { settings: N, apiKeys: M, users: 0 }`. The `users` field was always `0` because the restore route never had a loop for users — this is **intentional**: the backup format at `GET /config` exports user metadata for inspection/audit (id, username, role, mfa_enabled, last_login_at, etc.) but deliberately omits `password_hash`, `mfa_secret`, and `recovery_codes`. Restoring users from that export would create accounts with no credentials, unable to authenticate. The silent `users: 0` made the route look broken when it was actually correct-by-design.

**Fix**: `users` removed from the counter object. If `data.users` is present and non-empty, the response now includes an explicit `note` explaining that user data was not applied and why, so operators don't expect a silent restore that never happens.

### Known issues NOT fixed in this release (deferred — need design work, not a quick patch)
- **`PUT /s3-config` mutates `cfg.s3.*` in-memory without persistence** — operators saving S3 credentials via the UI will lose them on container restart (env vars take over). The fix needs a settings-table fallback for S3 config + config layer changes to read from settings at startup with env-var precedence rules. Larger than this audit batch.

### Operator action
None. Restore is now atomic — partial-restore is impossible. Existing backup files are fully compatible.

## [8.7.19] - 2026-06-20 — **RELIABILITY**: ntfy timeout + concurrent notification dispatch

Two related bugs in the notification-channel layer — one is a timeout gap, the other amplifies its blast radius.

### 1. `ntfy` channel had no timeout
Every other notification provider (Discord, Slack, Telegram, Gotify, Webhook) goes through the `_post()` helper which wraps `fetch` with an `AbortController` and a 10-second timeout. The `ntfy` provider was the lone exception — it called `fetch` directly because the body is plain text and the structured fields live in custom HTTP headers (`Title`, `Priority`, `Tags`). When that direct fetch was written, the timeout wrapper was missed. A hung ntfy.sh request (or self-hosted ntfy server) would block notification dispatch indefinitely for that channel.

**Fix**: explicit `AbortController` + `setTimeout(..., 10000)` matching `_post`.

### 2. `sendToAll` awaited channels serially
```js
// before
for (const channel of channels) {
  try { await provider(config, message); }
  catch (err) { log.error('Notification failed', { ... }); }
}
```
With N active channels, worst-case latency was `N × T_slow`. A single hung channel (especially ntfy without its timeout) would block every subsequent channel for the same alert from being notified. The error isolation worked (try/catch) but the serial-await turned a per-channel timeout into a fleet-wide stall.

**Fix**: `await Promise.allSettled(channels.map(...))`. Per-channel try/catch preserved inside the dispatch lambda; `allSettled` never rejects so the call cannot throw upstream. Total latency is now `max(T_channel)` instead of `sum(T_channel)`.

### Combined impact
Pre-v8.7.19, an outage at ntfy.sh would silently delay every Discord/Slack/Telegram/email alert in the same `sendToAll` batch by however long ntfy took to fail (which, without a timeout, could be **indefinitely**). Post-v8.7.19: ntfy fails within 10s and every other channel dispatches in parallel anyway.

### Operator action
None. Backward-compatible.

## [8.7.18] - 2026-06-20 — **SECURITY**: WebSocket `exec:start` per-stack permission check + audit (CWE-862)

### Vulnerability
The WebSocket `exec:start` message handler at [`src/ws/index.js`](src/ws/index.js) only checked:
```js
if (!client || client.user.role === 'viewer') return; // reject viewer
```
That is, an operator could exec into a container on **any** stack via WebSocket, regardless of the per-stack permissions admins set in **Settings → Users → Stack Permissions**.

The HTTP container-action route (`POST /api/containers/:id/:action` for start/stop/restart/etc.) **did** enforce the per-stack check at [`src/routes/containers.js:329-334`](src/routes/containers.js#L329):
```js
const inspect = await dockerService.inspectContainer(id, req.hostId);
const stack = inspect.Config?.Labels?.['com.docker.compose.project'] || '_standalone';
const effectiveRole = permService.getEffectiveRole(req.user.id, stack, req.user.role);
if (!permService.hasPermission(effectiveRole, 'operate')) {
  return res.status(403).json({ error: 'Insufficient stack permissions for this action' });
}
```
The WS exec gate was the gap. An operator demoted to `view` on a sensitive stack via per-stack permissions could still get a shell inside any container on that stack by speaking WebSocket directly.

### Secondary issue: no audit trail on WS exec
Per CLAUDE.md project conventions:
> Audit trail mandatory for any state-changing action: `auditService.log({ userId, username, action, targetType, targetId, details, ip })`.

Container start/stop/restart/remove all audit (HTTP routes). WS exec — which lets operators run arbitrary commands inside containers — did not. Operator activity was invisible in the audit log.

### Severity
**MEDIUM** — CWE-862 (Missing Authorization). Auth required (the connection still passes through session-cookie validation and viewer rejection), so no unauthenticated exploit. But the per-stack permission system was advertised + enforced only in HTTP; WS bypassed it entirely.

### Fix
1. `startExec` now applies the same per-stack `permService.getEffectiveRole` / `permService.hasPermission(..., 'operate')` check the HTTP container-action route uses. Container inspect failure (missing/unreachable host) is treated as a deny.
2. `connection` handler now captures `req.socket.remoteAddress` into the client object so audit events can attribute correctly.
3. `startExec` now calls `auditService.log({ action: 'container_exec', targetType: 'container', targetId, details: { hostId, shell }, ip })` after the session starts. Audit failure does not break the session (best-effort).

### `logs:subscribe` — intentionally unchanged
The `logs:subscribe` WS handler also only checks `requireAuth`. Its HTTP equivalent `GET /api/containers/:id/logs` matches that — also no per-stack check. Whether logs SHOULD require per-stack permission is a separate design question (logs often contain sensitive data), but the WS behavior is consistent with HTTP today; tightening both at once is a larger product-level decision.

### Operator action
None for backward compatibility. After upgrade, operators see `container_exec` entries in the audit log for the first time, and any operator who was previously exec'ing into containers outside their per-stack scope will now hit `Insufficient stack permissions for exec`.

## [8.7.17] - 2026-06-20 — **SECURITY**: alerts.updateRule mass assignment / column-name injection (CWE-915)

### Vulnerability
`alertService.updateRule(id, data)` previously iterated `Object.entries(data)` and pushed any user-supplied key into the dynamic UPDATE statement:

```js
// vulnerable code (removed in v8.7.17)
for (const [key, val] of Object.entries(data)) {
  if (key === 'channels')      { sets.push('channels = ?'); ... }
  else if (key === 'is_active'){ sets.push('is_active = ?'); ... }
  else                         { sets.push(`${key} = ?`); ... }  // <-- no allowlist
}
db.prepare(`UPDATE alert_rules SET ${sets.join(', ')} WHERE id = ?`).run(...);
```

The route handler at [`src/routes/alerts.js:27`](src/routes/alerts.js#L27) passes `req.body` straight in. Two distinct attack shapes:

1. **Mass-assignment** — any column of `alert_rules` becomes writeable. `created_by` and `created_at` were never meant to be mutable post-creation; this allowed **audit-trail tampering**: an operator could re-attribute their own rule to another user, or backdate creation timestamps.

2. **Column-name injection** — a crafted key like `"name='pwn', is_active=0, target"` would render to SQL as:
   ```sql
   SET name='pwn', is_active=0, target = ? WHERE id = ?
   ```
   Bypassing per-field intent and letting one logical field mutate multiple columns.

### Severity
**MEDIUM** — CWE-915. Auth required (`requireRole('admin', 'operator')`), so no unauthenticated exploit. Does not allow privilege escalation across roles, but **does** allow audit-trail forgery in shared-team deployments.

### Fix
Replaced with an explicit `ALLOWED` allowlist matching the pattern already used by all 5 sibling builders (`auth.updateUser`, `git.updateCredential`, `git.updateStack`, `notificationChannels.update`, `securityAlerts.updateRule`). Unknown keys are silently dropped. 3 new tests cover the regression.

### Codebase-wide SQL-builder audit
Comprehensive sweep across all 6 dynamic SET-clause builders in `src/services/`. **5 were already safe**; the 6th (this one) is now patched. No other column-name interpolation found anywhere in the codebase. No `ORDER BY ${...}` / `LIMIT ${...}` interpolation either.

### Operator action
None. Backward-compatible — legitimate field updates work identically.

## [8.7.16] - 2026-06-20 — **A11Y**: Modal — `inert` instead of `aria-hidden` + sub-overlay `role`/`aria-modal`

### The reported browser warning
Users with a11y-strict browsers (or any modern Chromium) saw this in the console:
```
Blocked aria-hidden on an element because its descendant retained focus.
Element with focus: <button.btn btn-danger#modal-ok>
Ancestor with aria-hidden: <div.modal-overlay#modal-overlay>
Consider using the inert attribute instead.
```
Cause: `Modal.close()` called `setAttribute('aria-hidden', 'true')` synchronously **before** the 300ms close animation finished, while a button inside the modal was still focused.

### Fix
- Switched to the `inert` attribute (per the WAI-ARIA spec recommendation). Setting `inert` on the overlay **auto-blurs** any focused descendant *before* the AT tree is hidden, eliminating the warning entirely.
- Kept `aria-hidden` as a legacy fallback for pre-2022 browsers (Chrome <102, Firefox <112, Safari <15.5).
- Initial `_init()` now sets `inert` if the overlay starts hidden (consistent with the runtime contract).

### Bonus: sub-overlay was missing role + aria-modal
`Modal.openSub` creates a second `.modal-overlay` div on the fly but only the primary overlay had `role="dialog"` + `aria-modal="true"` set in `_init`. Screen readers didn't know a nested dialog had opened — assistive tech treated the sub-overlay as a generic div. Now applied to both overlays consistently, plus the `inert`/`aria-hidden` lifecycle.

### Operator action
None. Backward-compatible. The warning stops firing in browser consoles immediately after upgrade.

## [8.7.15] - 2026-06-20 — **RELIABILITY**: remediate local-exec timeout + scanner version-probe timeouts

### 1. `remediate.js` local `execFileSync` was missing timeout
Live-update step in a remediation plan ran `execFileSync(cmd, args, { encoding: 'utf8' })` without a timeout. The SSH-tunneled sibling above it correctly passes `timeoutMs: 30000`; the local path didn't. A hung child process during plan execution would block the whole plan thread and the user's `POST /api/remediate/.../execute` request indefinitely.

**Fix**: explicit `timeout: 30_000` matching the SSH sibling.

### 2. Scanner version probes (`trivy --version`, `grype version`, `docker scout version`) were unprotected
`GET /api/images/scanners` runs 3 `execFileSync` calls to enumerate available scanners. The actual scan paths (lines 128, 169, 219) all have 120s timeouts; these probe calls had none. A broken trivy install (cache lock, hung subprocess) would hang the route indefinitely.

**Fix**: explicit `timeout: 5000` (version-string output should be instant).

### `execFileSync` audit coverage
Comprehensive sweep across `src/services/`, `src/routes/`, `src/jobs/` found **24 `execFileSync`/`execSync` call sites**. After this release, **all 24 have explicit timeouts**:

| Range | File area |
|---|---|
| 5s–30s | version probes, openssl operations, ufw firewall |
| 60s–120s | docker pull/up, image scans, compose operations, git operations |

### Operator action
None. Backward-compatible.

## [8.7.14] - 2026-06-20 — **RELIABILITY**: cron overlap guard + bootstrap purge leader-gating

### 1. `_m()` overlap dedupe + stall watchdog
The cron/setInterval wrapper had no overlap guard. Three `setInterval`-based jobs were vulnerable to tick pile-up when a single tick took longer than the interval:
- **`alert-evaluate`** every 10s — runs through every alert rule
- **`sandbox-ttl-sweep`** every 30s — now iterates every active host (v8.7.12), each with a 30s docker call timeout
- **`security-alert-windowed`** every 60s

When a tick exceeded its cadence, the next setInterval-driven invocation started concurrently with the running one. Concrete consequences:
- duplicate alert fires (false-positive notifications to Slack/etc.)
- concurrent `docker.listContainers` calls on the same host (load amplification on whichever daemon is slow)
- double audit-log entries for the same scheduled action

node-cron also doesn't dedupe overlap, so cron-based jobs had the same theoretical risk at minute/hour cadences (lower frequency = lower probability but same failure mode).

**Fix**: `_m()` now tracks per-job-name in-flight state. A tick scheduled while the previous one is still running is silently skipped (no log spam at info, no metric bump). A **5-minute stall watchdog** logs `<jobname>: tick still running after 300s — possible stall` so admins can spot a runaway job without piping individual skip events.

### 2. Bootstrap `purge-old-data` was not leader-gated
`setTimeout(purgeAllOldData, 30000)` at startup ran the initial purge directly without the `_m` wrapper, so in HA mode both replicas would purge concurrently 30s after boot. The purge queries are idempotent (DELETE ... WHERE) so this never corrupted data, but it doubled the cleanup load and audit noise on every cold-start.

**Fix**: wrapped with `_m('purge-old-data', ...)` so it leader-gates and also dedupes against the hourly cron tick if startup happens to coincide with `5 * * * *`.

### Operator action
None. Backward-compatible.

## [8.7.13] - 2026-06-20 — **RELIABILITY**: nodemailer explicit timeouts (10s / 5s / 30s)

nodemailer's defaults are `connectionTimeout=2min`, `greetingTimeout=30s`, `socketTimeout=10min`. The **10-minute socket timeout** is far too long for the docker-dash use case: password-reset and alert-channel sends `await transporter.sendMail(...)` inside the request handler, so a misbehaving SMTP server (silent network drop, post-greeting hang, DNS routing issue) would block the user's request for up to **10 minutes** with a spinner and tie up an express worker that whole time.

### Fix
Explicit `connectionTimeout: 10_000`, `greetingTimeout: 5_000`, `socketTimeout: 30_000` on the nodemailer transporter. Password-reset emails now fail fast and visibly when SMTP is down instead of silently keeping users waiting.

### Network-timeout audit coverage from this session (all clean now)
| Service | Status |
|---|---|
| `registry.js` | ✓ 10s `req.setTimeout` |
| `webhooks.js` | ✓ 10s `AbortController` |
| `log-forwarder.js` (Loki / ES / HTTP / syslog) | ✓ 15s HTTP / 5s syslog |
| `dns-providers.js` | ✓ 5s per request |
| `caddy-config.js` | ✓ 10s admin API |
| `s3-backup.js` | ✓ 60s PUT (only op) |
| `pcloud-client.js` | ✓ built-in `DEFAULT_TIMEOUT_MS` + 120s upload |
| `acme.js` | ✓ delegates ACME protocol to Caddy (no direct HTTP) |
| **`email.js`** | **FIXED in this release** |
| `docker.js` (v8.7.12) | ✓ 30s on all 3 connection types |
| `git.js` (v8.7.10) | ✓ 30s probe / 2min fetch / 5min clone |
| OIDC `_oidcFetch` (v8.7.9) | ✓ implicit via `http.request` timeout option |

## [8.7.12] - 2026-06-20 — **RELIABILITY**: Docker connection timeout consistency + sandbox multi-host TTL sweep

Two reliability fixes from the audit sweep — both silent failure modes in multi-host setups.

### 1. Docker connection request timeout applied to ALL connection types
`_createConnection` in `src/services/docker.js` had `timeout: 30000` only on the TCP path. Unix socket and SSH-tunneled connections used no timeout, so a hung remote Docker daemon (paused / restart-looping / deadlocked) would freeze `listContainers`, `inspect`, `pull`, etc. forever — even though the SSH tunnel's own keepalive (10s × 3 retries) kept the underlying transport happily alive.

**Fix**: applied the same `timeout: 30_000` to socket, tcp, and ssh-tunneled cases. Streaming endpoints (`logs --follow`, `attach`, `exec`) are unaffected — the modem doesn't auto-close on the `timeout` event per node `http.req.setTimeout()` semantics, same behavior TCP-connected hosts have had since their inception.

### 2. Sandbox TTL sweep was leaking remote sandboxes forever
`POST /containers/sandbox` accepts `req.hostId` (via the `extractHostId` middleware), so sandboxes can be created on any active host. But `src/jobs/index.js` `sandbox-ttl-sweep` was hardcoded to `getDocker(0)` — only swept local sandboxes. **Sandboxes created on remote hosts never expired**, accumulating resources forever with no audit trail.

**Fix**: sweep iterates `dockerService.getActiveHosts()`. One unreachable host is logged at warn level and skipped (doesn't stall the rest). Per-container cleanup errors (stop/remove failures) now log at warn level instead of being silently swallowed, so a sandbox stuck in "stop refused" state is finally visible in ops. The audit-log entry and WS broadcast now include `hostId` for correct attribution.

### Tests
2 new assertions on the existing docker-service test (plus a sibling test covering tcp + default-fallback timeouts). Suite 1517 → 1518.

### Operator action
None. Backward-compatible. After upgrade, remote-host sandboxes will start expiring on their TTL (any orphaned sandboxes from before the fix may need a one-time manual cleanup via `docker ps -f label=docker-dash.sandbox=true` on each remote host).

## [8.7.11] - 2026-06-20 — **SECURITY FIX**: MFA recovery-code lookup timing leak

**Severity**: medium. `verifyMfaRecovery` used `codes.indexOf(normalizedInput)` to look up a submitted recovery code in the user's stored list. `Array.prototype.indexOf` performs string-equality with **short-circuit comparison** — the wall-clock time depends on where in the array the match is found (and within each element, on how far the first differing character is). An attacker with a valid `mfaToken` (obtainable when valid username+password is stolen but second factor is enforced) could time their requests to determine prefix matches and meaningfully accelerate brute force against the small recovery-code search space.

### The fix
Replace the `indexOf` short-circuit with a constant-time iteration that always loops through ALL stored codes (no early break) and uses `crypto.timingSafeEqual` per comparison. Total wall-clock time is now independent of match position and per-character prefix match. The defensive length-guard before `timingSafeEqual` is structurally a no-op for fixed-length recovery codes but documents intent.

### Tests
5 new cases in `auth-service.test.js`:
- accepts a valid recovery code and creates a session
- accepts the **last** code as readily as the **first** (no short-circuit)
- rejects an invalid recovery code
- rejects a wrong-length code (defensive length-guard)
- consumes a used code so it cannot be reused

Suite 1512 → 1517.

### Defense in depth
Login path is already timing-hardened (`DUMMY_HASH` bcrypt compare on unknown username), TOTP verify already uses `crypto.timingSafeEqual` internally. This fix closes the last `indexOf`-on-secret remaining in the auth path. A complementary hardening item (hashing recovery codes at rest, like passwords) is deferred — current storage is AES-256-GCM-encrypted under `ENCRYPTION_KEY`, so a DB-only attacker can't read them; the timing fix is the one with a practical attack vector.

### Operator action
None required. Backward-compatible.

## [8.7.10] - 2026-06-20 — **RELIABILITY FIX**: git operations could hang forever (no timeouts on simple-git)

**Severity**: silent service degradation. A slow or hung git remote (dead TLS handshake, rate-limited host, broken DNS, network blip mid-fetch) would block the underlying `git` child process **forever**, with three real consequences:

1. **Polling cron stops for the affected stack.** `gitPolling._check` holds a `_checking` Set guard so the same stack doesn't double-fire. If the in-flight check hangs, that guard is **never released** → the stack silently stops being polled until the process restarts. No error logged.
2. **Interactive endpoints freeze a worker.** `/git/stacks/:id/check`, `:id/deploy`, `:id/rollback`, the credential `test`, and the initial clone all run git operations synchronously inside the request handler. A hung remote ties up an express worker until the OS gives up (could be hours), and the user's browser sits on a spinner.
3. **Stack stuck in `deploying`.** The initial clone path sets status `deploying` BEFORE the clone runs. A hung clone leaves the stack in that status indefinitely; the UI shows it as in-flight forever, and no other deploy can run.

### Root cause
**No `simpleGit()` call site passed a timeout.** simple-git's docs are explicit: without `{ timeout: { block: <ms> } }` on the constructor, the library waits forever on the underlying child process.

Four call sites in `src/services/git.js`:

| Line | Operation | Path |
|---|---|---|
| 371 | `listRemote` (credential probe) | `POST /git/credentials/:id/test` |
| 694 | central `_getGit(stack)` returning `simpleGit(repoDir).env(env)` | every fetch/pull/log on existing stacks (polling, check, deploy, rollback) |
| 769 | initial `clone` | `POST /git/stacks` (creation) + deploy |
| 785 | `simpleGit(repoDir)` for first `git.log` after clone | same path as 769 |

### Fix
Three operation-class budgets:
- **`GIT_REMOTE_PROBE_TIMEOUT_MS = 30s`** — single lightweight `ls-remote` for credential test.
- **`GIT_FETCH_TIMEOUT_MS = 2min`** — fetch/pull/log on already-cloned repos.
- **`GIT_CLONE_TIMEOUT_MS = 5min`** — initial deep clone of potentially-large repos.

Helper `_gitOpts(ms)` → `{ timeout: { block: ms } }` applied to every `simpleGit()` constructor. On timeout, simple-git throws a `GitConstructError` / `GitResponseError`, the existing `catch` blocks log it, `_checking.delete(stackId)` runs in the polling `finally`, the express worker frees, and the stack status is reset by the existing error paths instead of being stuck.

### Tests
6 new cases in `git-timeouts.test.js`:
- exports the three documented timeout constants as positive integers
- timeouts are in a sane order: `remoteProbe < fetch < clone`
- all timeouts are within sensible bounds (1s..1h)
- `build()` helper produces the exact shape simple-git expects
- `build()` defaults to the fetch timeout when called with no args
- **source-level guard**: scans `src/services/git.js` and asserts every `simpleGit(...)` call passes `_gitOpts(...)`. If a future contributor adds a new call site without the timeout, this test fails fast.

Suite 1506 → 1512.

### Operator action
None required. Backward-compatible. After upgrade:
- A hung git remote now fails the affected operation cleanly after 30s / 2min / 5min depending on operation class, instead of stalling forever.
- The existing `_checking` Set guard self-releases on timeout, so cron polling resumes on the next interval.
- A new `log.error` line surfaces the timeout in the existing per-route error logger — visible without needing to add new monitoring.

## [8.7.9] - 2026-06-20 — **RELIABILITY FIX**: OIDC outage on IdP key rotation + discovery caching

**Severity**: availability outage. When an OIDC IdP (Entra, Okta, Keycloak, Google) rotated its signing keys mid-cache-window, **every user was locked out of SSO for up to 60 minutes** until the cached JWKS expired and was re-fetched. Entra rotates roughly monthly; the failure window typically caught every SSO user across the org for ~1 hour.

### The bug
The JWKS cache used **time-based invalidation only** (1-hour TTL). The OIDC spec contract requires **time-based PLUS event-based** invalidation: on `kid` not found in cached JWKS, the standard client behavior is to force-refresh once (per RFC 7517 §4.5 and every well-known OIDC library). Docker Dash's verifier just threw `no matching JWK for kid=...` and rejected the login.

Secondary: OIDC **discovery (`/.well-known/openid-configuration`) was never cached**. Every login fetched it twice (in `/oidc/login` and again in `/oidc/callback`) plus a third time on JWKS cache miss. Added 200-1000 ms latency per login and made the IdP a hard dependency for paths that don't logically need it.

### Real-world trigger
```
T+0    JWKS cached (TTL → T+60min). Admin logs in successfully.
T+30m  Entra rotates signing keys. Old kid='X', new kid='Y'.
T+31m  Admin logs in. Token signed with new kid='Y'.
       _verifyIdToken: jwks.find(k => k.kid === 'Y') → undefined.
       → throw "no matching JWK for kid=Y" → HTTP 401.
T+31m..T+90m   EVERY OIDC user locked out, same way.
T+90m  TTL expires. Service restored.
```

### The fix
- **Discovery cache** added (was missing entirely) — 1-hour TTL, same shape as JWKS. Eliminates 2 of the 3 IdP round-trips per login on the warm path.
- **JWKS force-refresh on `kid` miss** — `_verifyIdToken` now retries once with `_getJwks(issuer, { force: true })` when the cached JWKS doesn't contain the token's `kid`. This is the canonical OIDC client cache strategy.
- **Force-refresh cooldown** (1 minute per issuer) — DoS protection: an attacker sending tokens with random `kid`s cannot hammer the IdP discovery endpoint. During cooldown, stale cache is returned; the caller's kid-find still fails and the verify still throws, just without a network call.
- **Tightened single-key fallback** — the `jwks.length === 1` fallback now applies ONLY when the token has no `kid` (rare but valid). Previously it silently picked the stale single cached key, **masking the key-rotation case** with a signature mismatch later in the verify path.
- **Injectable fetcher** (`_oidcCacheInternals.setFetcher`) — clean test surface that exercises the cache layer without touching the network.

### Tests
7 new unit cases in `oidc-jwks-cache.test.js` pin the cache contract: discovery cache miss-then-hit, discovery force=true bypasses cache, JWKS cache miss-fetches-discovery-and-jwks-once, JWKS force-refresh returns fresh keys, **JWKS force-refresh during cooldown returns stale cache (DoS proof)**, end-to-end key-rotation recovery via force-refresh on kid miss, malformed-JWT short-circuit. Suite 1499 → 1506.

### Operator action
No config change required. The fix is backward-compatible. After upgrade:
- The first login after an IdP key rotation may take ~100ms longer (two JWKS fetches: stale, then fresh). All subsequent logins until the next rotation are unaffected.
- A new `log.info` line on the first force-refresh per rotation: `OIDC JWKS force-refresh succeeded (likely IdP key rotation)` — useful for confirming the rotation event in logs.
- For DoS visibility: stale-cache responses during cooldown are not logged (would create attacker-controlled log spam).

## [8.7.8] - 2026-06-19 — **SECURITY FIX**: OIDC silent admin demotion when groups claim is absent

**Severity**: silent privilege change — existing admin/operator users could be **automatically demoted to viewer** on next OIDC sign-in if their IdP momentarily failed to emit the groups claim, with no error surfaced to the user or admin.

### The bug
The v8.7.6 OIDC group→role mapping conflated **two distinct IdP states**:
- "user is in groups, just not the ones we care about" → legitimate fallback to `OIDC_DEFAULT_ROLE`
- "the IdP didn't tell us about groups at all" → should preserve the existing role

Both produced `_resolveRoleFromGroups → null`, then `assignedRole = OIDC_DEFAULT_ROLE` (viewer), then `findOrCreateSsoUser(..., { updateRole: true })`, then a silent `UPDATE users SET role='viewer'` for any pre-existing admin.

### Real-world triggers
1. **Entra "groups overage"** — when a user is in >200 Azure AD groups, Entra omits the actual `groups` claim and replaces it with `_claim_names.groups` + a Microsoft Graph URL we don't follow. Every login of that user demoted them.
2. **Entra Token configuration regression** — a tenant admin re-saving the app registration without re-ticking the groups checkbox stops emitting the claim.
3. **id_token verification fallthrough** — when JWKS rotation or signature issues cause id_token verify to fail, the callback falls back to the userinfo endpoint. Some IdPs don't include the groups claim there.
4. **Upstream OIDC broker scope strip** — orgs that route OIDC through an intermediary may have the `groups` scope stripped.
5. **Worst-case escalation**: the only admin in the system could demote themselves on their own sign-in, locking the org out of its own dashboard.

### The fix
New pure helper **`_hasUsableGroupsClaim(claims, oidcCfg)`** at `src/routes/auth.js`. The OIDC callback now gates `updateRole` on **evidence** (IdP sent groups) rather than on **configuration** (group lists are defined). When evidence is absent:
- existing user's role is preserved (no demotion)
- a `warn`-level log entry is emitted: `OIDC: groups claim absent or unusable — existing user role preserved (no demotion).` with `hasOverageIndicator` flag so ops can spot the >200-group case immediately

The new helper also detects Entra's `_claim_names.groups` overage indicator and treats it as "no usable claim" (preserve role + warn) rather than silently demoting.

### Tests
7 new unit cases in `oidc-group-mapping.test.js` pin the demotion guard: array claim present + non-empty (true), claim entirely absent (false), empty array (false), Entra overage indicator (false), custom claim name (`roles`), single-string claim, defensive nulls. Suite 1492 → 1499. The 12 prior v8.7.6 resolver tests still all pass.

### Operator action
No config change required — the fix is backward-compatible. If you had been seeing unexplained demotions in production, this was almost certainly the cause; the next sign-in after upgrading will preserve the user's existing role and emit a warning that surfaces the underlying IdP issue (overage, missing scope, config regression).

The Entra ID how-to (`oidc-entra-id.md`) is updated with a new "Behavior when the groups claim is absent" section documenting the protection and the four triggers.

## [8.7.7] - 2026-06-17 — Deployment Configurator + recipe library

A new wizard at **System → Tools → Deployment Configurator** generates a tailored `docker-compose.yml` for your environment — and the same recipes ship as static files under [`examples/deployments/`](examples/deployments/README.md) for browsing on GitHub. Inspired by an abandoned community fork (`conexaoazul/docker-dash`) that had to hand-write its own Swarm + Traefik compose because the repo only documented the standalone case.

### 7 recipes
- **standalone** — no reverse proxy; HTTP only, port-mapped.
- **caddy** — Caddy sidecar with auto-HTTPS (Let's Encrypt, zero config).
- **traefik** — labels for an existing Traefik v3 (plain Compose).
- **npm** — port-exposed for Nginx Proxy Manager to pick up.
- **swarm-traefik** — Swarm-managed, pinned to a manager node, behind Traefik.
- **ha** — 2 replicas + Redis-backed leader election (`DD_MODE=ha`).
- **synology** — DSM Container Manager-friendly bind mounts under `/volume1/docker/docker-dash/`.

### The UI
Split-pane modal (340px form on the left, live YAML preview on the right): pick a recipe → only that recipe's fields appear (domain, email, host port, network name, certResolver, redis password, Synology stack path) → preview rebuilds on every keystroke → **Copy** or **Download .yml**.

### Single source of truth
All seven recipe templates live in `public/js/components/deployment-configurator.js` and are exported pure for testing (`DeploymentConfigurator._render`). A small `scripts/generate-deployment-examples.js` snapshots them to the static files under `examples/deployments/` — run after editing a template to keep the GitHub-browsable files in sync.

### Tests
`deployment-recipes.test.js` — **36 new cases**: every recipe parses through the `yaml` lib with both defaults AND custom user options; every recipe mounts the Docker socket read-only and uses `unless-stopped` (or Swarm `restart_policy`); recipe-specific assertions for Caddy domain/email substitution, Traefik labels, Swarm `node.role == manager`, HA Redis + two replicas on distinct host ports, Synology stack-path substitution, standalone single-service shape. Suite 1456 → 1492.

### Why this exists
Reverse-proxy + TLS + mode setup is where ~80% of self-hosted-app friction lives. Before today, the project's README only covered the standalone case; new users hit Caddy / Traefik / NPM / Swarm / NAS situations and had to build their own compose from scratch. The wizard makes "I have setup X" → "here's your compose" a 30-second job.

## [8.7.6] - 2026-06-17 — OIDC: group→role mapping + Entra ID how-to (issue #11)

Closes the gap [#11 raised by @patrickklaeren](https://github.com/bogdanpricop/docker-dash/issues/11) on Microsoft Entra ID SSO. The OIDC backbone has been in place since v8.0 (discovery + RS256 JWKS verification + state CSRF + callback + SSO login button), but two things were missing for an org-scale Entra deployment: a way to drive roles from Entra groups, and any documentation that OIDC existed.

### New (additive — no breaking changes)
- **Group → role mapping**. Four new env vars:
  - `OIDC_GROUP_CLAIM` (default `groups`)
  - `OIDC_ROLE_ADMIN_GROUPS` / `OIDC_ROLE_OPERATOR_GROUPS` / `OIDC_ROLE_VIEWER_GROUPS` (comma-separated; Entra GUIDs or display names)
- **Precedence**: admin > operator > viewer when a user is in groups for multiple roles.
- **Case-insensitive exact match** on the claim values (works for both Entra group object IDs and display names).
- **Role re-evaluated on every login** when any of the three lists is configured — so removing someone from the admin group in Entra demotes them on next sign-in (`SSO user role updated from IdP` in the log). When NO lists are configured, behaviour is exactly as before: every SSO user gets `OIDC_DEFAULT_ROLE` and existing roles are never overwritten.
- **`groups` scope** is added to the auth request only when group mapping is configured (Entra emits the claim per the app registration's *Token configuration*).
- **`findOrCreateSsoUser(username, role, email, { updateRole })`** — the new opt-in flag lets the OIDC callback own the role of existing users; everywhere else still uses the old behaviour.

### Docs
- New how-to **`security` → "OIDC SSO with Microsoft Entra ID (Azure AD)"** (`src/db/howto-content/oidc-entra-id.md`) with the full path: app registration, secret, groups-claim emission, env-var template, role-assignment semantics, troubleshooting (issuer/redirect-URI/missing-claim cases). Notes that the same contract works for Okta / Keycloak / Google / Authentik / Authelia.

### Tests
- 12 new unit cases in `oidc-group-mapping.test.js` for the pure `_resolveRoleFromGroups` resolver: precedence (admin > operator > viewer), case-insensitive GUID + display-name matching, custom claim name, single-string claim wrapping, defensive nulls, partial config (admin-only). Suite 1444 → 1456 (one pre-existing unrelated egress-filter flake under load).

## [8.7.5] - 2026-06-16 — Fix: System → Prune buttons returned 404

### Fixed
The five Prune buttons on **System → Tools** (Containers / Images / Volumes / Networks / All) all returned **HTTP 404** because the frontend was calling `POST /api/system/prune/<type>` but the backend only had the legacy `POST /api/system/prune` with boolean-flag body. Spotted in browser console:
```
POST /api/system/prune/images  →  404 (Not Found)
POST /api/system/prune/all     →  404 (Not Found)
```

- Added `POST /api/system/prune/:type` accepting `containers` / `images` / `volumes` / `networks` / `all`, translating the URL segment into the boolean flags `dockerService.prune()` expects.
- Same audit + permission stack (`requireAuth` + `requireRole('admin')` + `writeable` + `requireFeature('prune')`).
- Audit entries include the type for cleaner history (`action: system_prune, details: { type, ...flags }`).
- Legacy `POST /api/system/prune` route kept unchanged — anyone scripting against the old body-based contract still works.

### Verified
Browser-tested every prune type via the page's `Api.prune` helper on local: all 5 (`containers`, `images`, `volumes`, `networks`, `all`) return `200` with `SpaceReclaimed` (0 on a clean dev box, as expected). Suite green (1444).

## [8.7.4] - 2026-05-27 — Template Configurator: better password detection + Synology DSM export

### Password generator now finds the fields it was missing
The Configure dialog already had a password generator + strength meter, but the field-type detector only matched the literal substrings `SECRET` / `PASSWORD` / `_KEY` / `TOKEN`. That **missed `PASS` on its own** (used by `MONGO_PASS`, `RABBITMQ_DEFAULT_PASS`, etc.) and a bunch of common variants.

- Detector rewritten as `_isSecretKey` with a regex matching word-bounded `PASSWORD` / `PASSWD` / `PASS` / `PWD` / `PW` / `PASSPHRASE` / `SECRET` / `TOKEN` / `API_KEY` / `MASTER_KEY` / `PRIVATE_KEY` / `JWT` / `SALT` / `CREDENTIALS`. Avoids false positives like `BYPASS`, `KEYSTORE_PATH`, `KEY_ALG`.
- Second safety net `_looksLikePasswordValue`: if the **default value** looks like a placeholder (`changeme`, `changeme123`, `base64:CHANGE…`, `generate-strong-secret`, etc.), the field is treated as a password even when the key name doesn't say so.
- Both branches feed `_detectFieldType` AND `_detectCategory` so the field also lands in the **Security** category for grouping.

### New: Synology DSM Container Manager export
Next to **Deploy** in the Configure modal: **Synology export** — opens a sub-modal with a compose YAML rewritten for DSM Container Manager (Synology Docker package):

- **Strips** top-level `volumes:` / `configs:` / `secrets:` blocks and per-service `configs:` / `secrets:` / `healthcheck:` / `deploy:` blocks (DSM doesn't apply them).
- **Rewrites** named-volume + `./relative` mounts to bind mounts under `/volume1/docker/<stack>/<service>/…` — matches the standard Synology layout, shows up in File Station, backs up cleanly.
- Adds a header comment with the exact import path (Container Manager → Project → Create → "Create docker-compose.yml" → paste) and a reminder to create the bind-mount folders in File Station first.
- Output panel has **Copy** + **Download .yml** (`compose.<stack>.synology.yml`).

### Verified
- Detection: `MONGO_PASS`, `RABBITMQ_DEFAULT_PASS`, `PASSPHRASE`, `MY_PWD` → true (previously false); `PUID`, `TZ`, `KEYSTORE_PATH`, `BYPASS_AUTH` → false (no false positives); value-based: `changeme`/`base64:CHANGE…` → true, `Etc/UTC` → false.
- Synology export on a 2-service UniFi-style stack: top-level `volumes:` stripped, per-service `healthcheck:` stripped, named volumes rewritten to `/volume1/docker/unifi/unifi-db/unifi-db:/data/db`, `./media` rewritten to `/volume1/docker/unifi/unifi/media:/data/media`. Zero console errors.

## [8.7.3] - 2026-05-27 — Template deploy: per-stack network (service-name DNS now works)

### Fixed
Multi-service template deploys (UniFi, WordPress, eurooffice-nextcloud, ai-rag-stack…) silently broke because Docker's **default `bridge` network does NOT resolve container names**. UniFi's `MONGO_HOST=unifi-db` failed with `unifi-db is not reachable, cannot proceed`; WordPress's `WORDPRESS_DB_HOST: db` would have failed the same way; every stack that referenced a sibling by name was broken.

`docker compose up` solves this by creating a `<project>_default` user-defined bridge network where Docker provides automatic DNS by container name and alias. The Docker-API deploy path skipped that step entirely.

- The deploy now **creates a `<stackName>_default` user-defined bridge network** before iterating services (idempotent — reuses existing) and attaches every container via `NetworkingConfig.EndpointsConfig` with the service name as an **alias**. Sibling services now resolve each other exactly as they do under `docker compose up`.
- Network creation failure (non-409) is fatal with a clear error — without the network the stack will silently misbehave.
- Network is labeled with `com.docker.compose.project` so it shows up correctly grouped in the Containers page.

### Verified
- Browser-deployed `lsio-ddclient` end-to-end → response OK, container attached **only** to `dd-test-net-ddclient_default` with `aliases=[ddclient]` (not the default bridge).
- Multi-service stacks (UniFi, WordPress) now share a project network so sibling DNS works.
- Suite green (1444).

## [8.7.2] - 2026-05-27 — Template deploy: parser rewrite + persistent error dialog + UniFi simplified

### Fixed (long-standing latent bug)
The Docker-API template deploy was returning **"(HTTP code 400) bad parameter - no command specified"** for any template with a top-level `volumes:` (or `configs:` / `networks:`) block — that includes **every template with a named volume** (postgres, redis, mariadb, mongo, every LSIO template, …). The hand-rolled line parser at `_parseComposeServices` treated any 2-space-indented `name:` as a service, so `volumes:\n  redis-data:` produced a phantom "redis-data" service with empty `Image`, which Docker rejected with the cryptic "no command specified".

- **Parser rewritten** to use the project's `yaml` package — now correctly extracts only `doc.services.*`, ignoring `volumes` / `configs` / `networks` top-level blocks. Supports both array and map forms of `environment`, both short-form strings and long-form `{ target, published, protocol }` for ports, both string and array forms of `command`, and `container_name` overrides.
- **`command:` is honored** in `createOpts.Cmd` (string `command:` runs via `/bin/sh -c`, array form passes through). Templates that relied on a `command:` override (litellm) now actually use it.
- **IP-prefixed ports** (e.g. `"127.0.0.1:2375:2375"` in `lsio-socket-proxy`) now parsed and bound to the right interface via `HostConfig.PortBindings[…].HostIp`.
- Imageless services produce a **clear 400** with the offending service name, instead of letting Docker return the cryptic generic error.

### Persistent deploy-error dialog
Replaces the 4-second `Toast.error` (which made deploy failures essentially undebuggable) with a **persistent sub-modal** showing the full Docker error, the failing service + container, any partial deploys, and the compose YAML that was sent — with a **Copy** button. Closes only when the user clicks Close or the X.

The backend now returns structured `{ error, service, containerName, partial: [...] }` on failure, and `api.js` attaches `.body` and `.status` to the thrown `Error` so the dialog can show all of it.

### UniFi template simplified
The v8.6.2 UniFi template used Compose `configs:` with `content:` for the inline Mongo init script — a Compose-CLI feature the API-based deploy can't apply. Switched to **root Mongo credentials** (`MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD` on mongo + `MONGO_AUTHSOURCE=admin` on the app) so the stack now deploys cleanly via the Docker API without any external file or healthcheck. The first-start race is handled by `restart: unless-stopped` (unifi may crash once before Mongo is ready, then restarts).

### Verified
End-to-end browser test deploys `lsio-prowlarr` cleanly through the new code path (response: `{ ok: true, containers: [{ name: "prowlarr", ... }] }`, zero console errors); the persistent error modal renders correctly with the full error block + Copy/Close. Suite green (1444), template-tests pass, every template's YAML round-trips through the new parser.

## [8.7.1] - 2026-05-27 — Templates dialog: search field + intersect filter

With 84 built-in templates now in **Containers → Templates**, scanning the grid for a specific image was painful. Adds a live search field above the category buttons.

- Substring match on **name + description + category + id** (precomputed `data-search` haystack per card — no DOM-text reads on each keystroke).
- Search **intersects** with the existing category filter (both must match), so you can narrow Database → "redis" for a single result.
- `<N> of <M>` counter on the right of the search box, "No templates match your filters" empty state when nothing hits.
- 120ms debounced input; search field auto-focuses when the dialog opens so you can start typing immediately.
- Modal width bumped to `min(1100px, 96vw)` to breathe with the larger catalog.

Browser-verified: 84 cards total, "sonarr" → 4 hits (correctly includes bazarr/jackett/prowlarr which reference Sonarr), "calibre" → 1, gibberish → 0 with empty state, Database ∩ "redis" → 1. Zero console errors. Suite green (1444).

## [8.7.0] - 2026-05-27 — LinuxServer.io curated template batch (35 images)

Adds **35 new built-in templates** drawn from `docs.linuxserver.io/images-by-category/` — the canonical community-maintained Docker image catalog. Each uses the standard LSIO skeleton (`PUID`/`PGID`/`TZ` + `/config` volume + `lscr.io/linuxserver/<slug>:latest`) with the well-known port(s) for that service, ready to deploy from **Containers → Templates**.

### What landed (by category)
- **Media Servers** — jellyfin, emby, plex
- **Media Management** (the *arr stack) — sonarr, radarr, lidarr, bazarr
- **Indexers** — prowlarr, jackett, nzbhydra2
- **Downloaders** — qbittorrent, transmission, deluge, sabnzbd, nzbget
- **Books** — calibre-web, kavita, lazylibrarian
- **Dashboard** — heimdall
- **Photos** — piwigo
- **Programming** — code-server
- **Remote Desktop** — webtop
- **Reverse Proxy** — swag (Nginx + certbot ACME + fail2ban)
- **DNS** — duckdns, ddclient
- **Backup** — duplicati, syncthing
- **Monitoring** — healthchecks, smokeping, speedtest-tracker
- **Family / Recipes** — babybuddy, grocy
- **File Sharing** — snapdrop
- **Web Tools** — changedetection.io
- **Docker** — socket-proxy
- **IRC** — thelounge

### Scope note (deliberately limited)
The LSIO catalog has ~140 unique images; this batch is the **high-utility server-style subset** (self-hoster favorites: *arr stack, media, downloaders, ops). Excluded on purpose: desktop-via-browser images (gimp/krita/blender/kdenlive — they need GPU/DRINODE wiring) and DB-dependent ones (bookstack/wikijs — need a MariaDB/Postgres sidecar). Those can be added later with their per-image quirks.

### Convention
- IDs prefixed `lsio-<slug>` to avoid collision with non-LSIO templates of the same name (e.g. `wireguard`, `nextcloud` already exist).
- Names suffixed `(LSIO)` so they sort together and are unambiguous next to other ecosystem variants.
- All registered in `BUILTIN_VERIFICATION` dated 2026-05-27.

### Verified
36 new templates (35 LSIO + the prior unifi-network-application now in this category) loaded via `getMergedTemplates()`; **every compose YAML round-trip parsed cleanly** through the project's `yaml` lib (0 parse failures); template-tests + full suite green (1444).

## [8.6.2] - 2026-05-27 — UniFi Network Application template

New built-in template **UniFi Network Application** (category Networking) — a self-hosted Ubiquiti UniFi controller built on the LinuxServer.io image (the community-maintained successor since Ubiquiti discontinued their official Docker controller).

### What's in the stack
- `lscr.io/linuxserver/unifi-network-application:latest` — the controller.
- `mongo:7.0` — dedicated MongoDB sidecar (pinned per LSIO guidance; 7.0 is the highest version supported by UniFi <9.0).
- **Inline mongo init script** via Compose `configs:` with `content:` (requires Compose 2.23+) — auto-creates the `unifi` user with `dbOwner` on the `unifi` and `unifi_stat` databases on first start, so the stack is self-contained (no host file to bind-mount).
- **Healthcheck-gated startup**: the controller `depends_on: { unifi-db: { condition: service_healthy } }` with a `mongosh ping` healthcheck — solves the LSIO-documented "restart container after Mongo is ready" footgun.
- All 9 standard ports declared (4 required: 8443 admin / 8080 device / 3478 STUN / 10001 AP discovery; 5 optional commented with their purpose).
- Named volumes for `/config` and `/data/db`.
- Header comment block documents post-deploy steps + the critical "MONGO_PASS and the init script `pwd:` MUST match before first start" gotcha.

Registered in `BUILTIN_VERIFICATION` (verified 2026-05-27); YAML round-trip parsed cleanly through the project's `yaml` lib; template-tests + full suite green (1444).

## [8.6.1] - 2026-05-22 — Wider Exposed Ports dialog

The Exposed Ports modal now opens at `min(1320px, 96vw)` (was 920px) so the eight columns breathe instead of crowding. Browser-verified at 1320px on a 1600px viewport.

## [8.6.0] - 2026-05-22 — Exposed Ports audit

New **Exposed Ports** button on the Containers page opens a modal auditing every container that publishes a port to the host — the "what's reachable from outside?" view, in one place.

### What it shows
- One row per published mapping (deduped across IPv4/IPv6), with columns: Container (+ state badge, click-through to detail), Stack, Host IP, Host Port, Container Port, Protocol, Service, Exposure.
- **Sortable on every column** (numeric for ports) via the existing DataTable, plus a live text filter.

### Security-minded value-adds
- **Exposure classification**: `0.0.0.0`/`::`/empty → "Public (all interfaces)" (red); `127.0.0.1`/`::1` → "Localhost only" (green); a specific bind IP shown verbatim.
- **Service hints** from a common container-port map (22 SSH, 3306 MySQL, 6379 Redis, 27017 MongoDB, 5432 PostgreSQL, …).
- **Sensitive-exposure flagging**: sensitive services (databases, SSH, RDP, Docker API, …) reachable on all interfaces get a ⚠ marker + tinted row, and a headline count ("N sensitive services publicly exposed").
- Summary line: total published ports, container count, public count, risky count.

### Export
- **CSV** and real **.xlsx** export, plus **Copy** (TSV) to clipboard.
- New reusable, zero-dependency `Utils.exportCsv` / `Utils.exportXlsx` / `Utils.downloadBlob` / `Utils.crc32` — the `.xlsx` writer builds valid OOXML via stored ZIP entries + CRC32 (numbers as numeric cells), with no library and no build step. Available to any page now.

### Notes
- Purely client-side over the existing container list — no new backend endpoint. Browser-verified (modal, sorting, filter, exports, no console errors); `.xlsx` integrity validated with `unzip -t`. Feature-spec: `plans/feature-spec-exposed-ports-audit.md`.

## [8.5.2] - 2026-05-21 — Standardized detail views: images (Phase 3, step 3.3)

Third page onto `DetailShell` — and the first **net-new** detail view (images had no detail page, only modals). Images now have a proper detail at `#/images/<id>` with the standard taxonomy: **Summary** (tags, full ID, digest, size, architecture/OS, labels), **Monitor** (layer history — count, total size, per-layer command + relative-size bars), **Inspect** (raw JSON + copy).

### Behaviour change
- The image list's **Inspect** action (and context-menu, renamed **View Details**) now opens the detail page instead of a JSON modal — the modal is retired (`_inspect` method removed). The standalone **View Layers** modal is unchanged and remains available alongside the new Monitor tab.

### Notes
- Vulnerability-scan integration into the detail is deliberately deferred (async workflow with its own menu/results UI); Monitor = layer analysis for now. Per-page feature-spec: `plans/feature-spec-detail-views-3.3-images.md`.
- Browser-verified (direct nav + list-button nav + all 3 tabs + no new console errors); volumes & networks re-checked for shared-shell regression. Suite unchanged at 1444 green.

## [8.5.1] - 2026-05-21 — Standardized detail views: networks (Phase 3, step 3.2)

Second page migrated onto `DetailShell`. Network detail now uses the standard **Summary** (general + IPAM + driver options) / **Monitor** (connected containers with IPs/MAC) / **Inspect** (raw JSON) taxonomy, replacing the bespoke `#net-detail-tabs` wiring. Behaviour-preserving; adds keyboard tab nav + consistent chrome. Browser-verified (network detail tab switching + no new console errors) and volumes re-verified for no shared-component regression.

## [8.5.0] - 2026-05-21 — Standardized detail views: shell + volumes (Phase 3, steps 3.0–3.1)

First slice of the standardized-detail-views roadmap item (`plans/deep-spec-standardized-detail-views.md`, accepted: 5 grouped tabs Summary/Monitor/Configure/Events/Inspect, safest-first sequencing). Until now container, volume, and network detail each had **bespoke** tab wiring (different IDs, duplicated click/swap logic) and images had only a JSON-inspect modal. This introduces one shared shell and migrates the lowest-risk page (volumes) onto it.

### 3.0 — `DetailShell` component (foundation)

- `public/js/components/detail-shell.js` — `DetailShell.create({ header, tabs, ... })`: a reusable tabbed detail shell with lazy render-once (tabs flagged `live` re-render on every entry), an `onLeave` stream-teardown hook, ←/→ keyboard tab navigation, ARIA `tablist`/`tab`/`tabpanel` roles, optional deep-linking via `history.replaceState` (no app-router reload), and `destroy()` for cleanup.
- **Non-reactive by design** — Phase 4 owns reactivity; the shell's public API is forward-compatible with it.
- DOM-independent decision logic factored into `DetailShell._pure` (initial-tab resolution, hash building, keyboard index math, render decision) so it is unit-testable in the project's jsdom-free Jest; the DOM wiring is covered by per-page browser regression.
- `detail.tabs.{summary,monitor,configure,events,inspect}` i18n keys across all 12 locales; minimal `.detail-shell-*` CSS reusing the existing `.tabs`/`.tab` classes.

### 3.1 — Volumes detail migrated

- Volume detail now renders through `DetailShell` with the standard taxonomy: **Summary** (general + labels), **Monitor** (connected containers), **Inspect** (raw JSON). Same content as before, plus keyboard tab nav and consistent shell chrome. Behaviour-preserving; verified in-browser (login → volume detail → tab switching → no new console errors).

### Tests

- `detail-shell.test.js` — 15 unit cases against `_pure`. Suite: 1429 → 1444.

## [8.4.1] - 2026-05-21 — Drift notifications

Follow-up to the v8.3.0 GitOps drift detection. Until now drift only surfaced as a badge you had to *open the page* to see. Now, when a git-managed stack transitions from in-sync → drifted, Docker Dash pushes a notification to all active channels (Slack/Discord/Telegram/ntfy/Gotify/email/webhook).

### Behaviour

- Fires **only on the transition** (in-sync → drifted), reusing the same guard that already gates the `git_drift_detected` audit entry. A stack that stays drifted across the 5-minute scans does **not** re-notify — no alert spam. It re-notifies only after going back in-sync and drifting again.
- Best-effort and non-blocking: a channel failure is logged at debug and never interrupts the scan. No active channels → silent no-op (same as the existing event notifier).
- Message lists up to 8 specific differences (missing / extra / stopped / image_mismatch) with a "…and N more" overflow line, severity `warning`, and a "Re-deploy from git to reconcile" hint.

### Implementation

- `git-drift.js` — new pure `buildDriftMessage(stack, result)` (testable wording/severity) + `notificationChannels.sendToAll()` dispatch at the transition in `scanAndStore()`.
- 4 new tests in `git-drift.test.js` (severity/event key, singular vs plural difference count, distinct-type listing, 8-item truncation). Suite: 1425 → 1429.

## [8.4.0] - 2026-05-20 — 30-day metrics tier (daily rollup)

Second feature of the v8.3+ roadmap. The metrics chart already offered a **30 Days** range, but it silently lied: that range queried `container_stats_1h`, which the purge job trims at 7 days. Anything past a week returned nothing. This adds the missing 4th aggregation tier so long-range charts show real data.

### The bug it fixes

`stats.query()` mapped `'30d'` → `container_stats_1h`, but `STATS_1H_RETENTION_DAYS` defaults to 7. So a "30 days" chart was capped at 7 days of points with no error — just a short line. The fix is a proper daily rollup retained long enough to back the range.

### What changed

- **New tier `container_stats_1d`** (migration `067_stats_1d.js`) — same columns as the 1h table, unique on `(container_id, bucket)` so `INSERT OR IGNORE` aggregation is idempotent (mirrors the v009 fix for 1m/1h).
- **`statsService.aggregate1d()`** — rolls `container_stats_1h` into UTC-day buckets (`AVG`/`MAX` for gauges, `SUM` for counters), guarded at `bucket < now-25h` so the current day isn't half-aggregated.
- **Daily cron `stats-aggregate-1d`** at 00:20, leader-gated like the other rollups.
- **Retention** — new `STATS_1D_RETENTION_DAYS` (default **90**); `purge()` now trims the 1d table too.
- **Query ranges** — `'30d'` now reads `container_stats_1d`; added a `'90d'` range backed by the same tier.
- **UI** — container Stats tab range selector gains **30 Days** / **90 Days** options, with i18n keys (`statsRange30d`/`statsRange90d`) across all 12 locales.

### Tests

- `stats-aggregate1d.test.js` — 5 cases: multi-bucket same-day rollup (avg/max/sum correctness), day separation, idempotency, 25h guard, and `'30d'` range reads from the 1d tier. Suite: 1420 → 1425.

## [8.3.0] - 2026-05-20 — GitOps drift detection (read-only)

First feature of the v8.3+ roadmap. Tells operators when a git-managed stack's **running** state has diverged from the git-checked-out compose — the "someone touched prod by hand" case that ArgoCD/Flux/Komodo surface but no Docker-focused dashboard in our comparison set does.

### Why this is distinct from the existing "Check"

`git/stacks/:id/check` answers *"are there new commits I haven't deployed?"* (git-ahead). Drift answers a complementary question: *"does the actually-running container state match the compose file git currently has checked out?"* — catching manual `docker stop` / `rm` / re-tag / out-of-band container additions.

### Read-only by design

Detection only. Nothing in the drift path ever starts/stops/removes/deploys a container — the fix is the existing manual "Re-deploy from git" button. Auto-sync was deliberately NOT built (it re-introduces unwanted-deploy risk).

### What it detects

- **missing** — service declared in compose, no container running
- **extra** — container running under the stack's compose project but not declared
- **stopped** — declared service exists but isn't running
- **image_mismatch** — running image differs from what compose declares (with registry-normalized comparison so `nginx` == `docker.io/library/nginx:latest`)

v1 deliberately compares **presence + image only** — env/port/volume deep-diff is too noisy (compose defaults vs runtime-resolved values legitimately differ). Build-only services (no `image:`) are matched by compose-service label, not image.

### Implementation

- `src/services/git-drift.js` — pure `detectDrift(desired, actual)` core (no I/O, fully unit-tested) + `normalizeImage` + `parseComposeServices` + DB-backed `scanStack`/`scanAndStore`/`scanAll`.
- Migration `066_git_stack_drift.js` — one row per git stack (latest result; no history in v1).
- Leader-gated cron `git-drift-scan` every 5 min; manual `POST /git/stacks/:id/drift-scan`.
- Routes: `GET /git/stacks/drift` (all, for badges — registered before `/stacks/:id` to avoid param shadowing), `GET /git/stacks/:id/drift`, `POST /git/stacks/:id/drift-scan` (operator+).
- New audit action `git_drift_detected` (emitted on in-sync → drifted transition; recognised by AI audit search).
- UI: drift badge on the git-stacks list cards + a drift panel on the detail view (per-drift explanation + "Re-deploy from git to fix" + "Scan Drift" button).

### Tests

- `git-drift.test.js` — 22 cases pinning `normalizeImage` (8), `parseComposeServices` (4), and `detectDrift` (10: in-sync, missing, extra, stopped, image_mismatch, build-only no-false-positive, bare-vs-qualified-image equality, multiple simultaneous, empty compose, null-service container ignored). Suite: 1398 → 1420.

### Roadmap context

Part of `plans/feature-roadmap-v8.3+.md`. Key finding from the survey: the product is dramatically more complete than a gap exercise assumes (customizable dashboard, build-from-Dockerfile, historical metrics, per-stack RBAC, etc. are all already shipped). Remaining genuine gaps prioritized as: drift detection (this, Phase 1) → 30d metrics tier → standardized tabbed detail views → frontend reactivity layer → custom named roles.

## [Unreleased — 8.2.x maintenance, wave 7] - 2026-05-15 — One-line install restart-loop bug

User reported: fresh `curl ... | bash` install on Ubuntu 25.10 → container downloads, then enters a restart loop forever. Root-caused to **three independent bugs** stacking; all three fixed.

### The three bugs

1. **No `:latest` tag in GHCR.** The docker-build.yml workflow's metadata-action only emitted `:main` and `:sha-XXX` tags. install.sh's `docker pull ghcr.io/.../docker-dash:latest` returned 404 → fell into a fragile git-clone+local-build fallback path that nobody had end-to-end tested in production. **Fix:** added `type=raw,value=latest,enable={{is_default_branch}}` to the workflow.
2. **Sparse build context in the install.sh git-clone fallback.** The fallback copied only Dockerfile + src + public + scripts + entrypoint.sh + package*.json from the cloned repo. The production Dockerfile stage's `COPY package.json README.md LICENSE CONTRIBUTING.md .env.example .gitignore ./` then failed atomically because README/LICENSE/CONTRIBUTING/.gitignore were missing from the build context. **Fix:** explicit REQUIRED_FILES array covers all 12 paths; belt-and-suspenders pass drops a placeholder for any of README/LICENSE/CONTRIBUTING/.gitignore that's still missing (so future Dockerfile changes don't silently regress this).
3. **`ADMIN_PASSWORD=admin` in `APP_ENV=production` caused `process.exit(1)`.** `.env.example` ships with `APP_ENV=production` + `ADMIN_PASSWORD=admin`. install.sh regenerated APP_SECRET + ENCRYPTION_KEY but left ADMIN_PASSWORD untouched. `server.js:286` then refused to boot ("FATAL: ADMIN_PASSWORD is admin in production. Set a strong ADMIN_PASSWORD or ALLOW_DEFAULT_ADMIN=true"). Container exited code 1 → Docker `restart: unless-stopped` policy bounced it forever. **Fix:** install.sh now appends `ALLOW_DEFAULT_ADMIN=true` to .env (the `admin/admin` → forced password change on first login flow is the documented first-run UX). Operators who want a random admin password can set `FORCE_RANDOM_ADMIN_PASSWORD=1` before running the installer; the success output prints the generated password once.

### Defensive bonus

When the local-build fallback runs, install.sh now patches `docker-compose.yml` with `target: production` so BuildKit doesn't try the `development` stage in parallel — the dev stage runs `npm install` with devDeps including `puppeteer` which downloads a Chromium binary that can fail on some host configurations.

### Verification

- Reproduced original crash: `docker run -e APP_ENV=production -e ADMIN_PASSWORD=admin docker-dash:8.2.0` → "FATAL: ADMIN_PASSWORD is admin" → process.exit(1).
- Confirmed fix: same command + `-e ALLOW_DEFAULT_ADMIN=true` → container Up (healthy), `/api/health` returns 200.
- Tested install.sh end-to-end inside an Ubuntu 25.10 container with stubbed docker daemon — git-clone fallback runs, all 12 required files copied, .env has `ALLOW_DEFAULT_ADMIN=true` + generated APP_SECRET/ENCRYPTION_KEY, docker-compose.yml patched with `target: production`.
- Confirmed `ghcr.io/bogdanpricop/docker-dash:latest` now pulls cleanly (commit f416c8d → workflow run 25917749308 → 3 tags published: `:main`, `:latest`, `:sha-f416c8d`).
- Final E2E: `docker pull` :latest → `docker run` with the fixed env → container Up (healthy) within 12s.

### What this means for users

`curl -fsSL https://raw.githubusercontent.com/bogdanpricop/docker-dash/main/install.sh | bash` now works on a fresh Ubuntu / Debian / Fedora / macOS / etc. — pulls the pre-built image from GHCR (no more build-from-source fallback for the happy path), generates strong APP_SECRET + ENCRYPTION_KEY, allows `admin/admin` first login (forced change after), runs healthy on first boot.

## [Unreleased — 8.2.x maintenance, wave 6] - 2026-05-13 — Backend route splits

The two remaining backend monoliths split into per-resource sub-routers. External API URLs are unchanged — `router.use(prefix, subRouter)` mounts replicate original path resolution. Adds the BACKLOG-deferred backend splits.

### Backend extracts

**`src/routes/system.js`: 2827 → 1646 LOC (-42%)**

4 new sub-routers mounted from `system.js`:

| Sub-router | LOC | Routes |
|---|---|---|
| `system-backup.js` | 353 | 17 routes — `/backup/config`, `/backup/restore`, `/backup/s3-*` (5), `/backup/list`, `/backup/pcloud/*` (7), `/backup/audit-dump/preview` |
| `system-stacks.js` | 364 | 9 routes — `/compose/:stack/:action`, `/compose/:stack/config`, `/stacks/:name/validate`, `/stacks` (CRUD), `/stacks/:name/env`, `/stacks/:name/deploy` |
| `system-schedules.js` | 236 | 7 routes — `/schedules` (CRUD), `/schedules/preview`, `/schedules/:id/history`, `/schedules/:id/run-now`, plus 3 helper functions (`loadSchedules`, `getSchedulesFromDb`, `cronMatchesDate`) |
| `system-database.js` | 301 | 5 routes — `/database`, `/database/cleanup`, `/database/cleanup-aggressive`, `/database/diagnostics`, `/database/vacuum` |

**`src/routes/misc.js`: 1780 → 1433 LOC (-19%)**

5 new sub-routers:

| Sub-router | LOC | Routes |
|---|---|---|
| `misc-favorites.js` | 26 | 3 routes |
| `misc-notifications.js` | 55 | 6 routes |
| `misc-api-keys.js` | 33 | 3 routes |
| `misc-audit.js` | 109 | 3 routes (list, export, analytics) |
| `misc-ai.js` | 203 | 2 routes (chat, github-compose) |

### Mount pattern documented in CLAUDE.md

For future backend splits:
- Each sub-router declares its own `Router()` + imports needed middleware/services.
- Routes inside use the prefix-stripped path (e.g., `/s3-status` instead of `/backup/s3-status`).
- Parent file mounts via `router.use('/prefix', require('./sub-router'))`.
- External URLs unchanged.

### Verification

- 1398/1398 tests passing (schedules + security-input + others).
- All sub-router files load via `require()` smoke test.
- Live API smoke test verified 10 representative endpoints across all new sub-routers (`/backup/s3-status`, `/backup/list`, `/backup/pcloud/status`, `/stacks`, `/schedules`, `/database`, `/favorites`, `/notifications/count`, `/api-keys`, `/audit`).
- Lint: 0 errors, 3 pre-existing warnings unchanged.

### Stats since v8.2.0

- Frontend: `system.js` 6011 → 2618 LOC, `settings.js` 2037 → 572 LOC (waves 1-5).
- Backend: `src/routes/system.js` 2827 → 1646 LOC, `src/routes/misc.js` 1780 → 1433 LOC (wave 6).
- **Total LOC moved from monoliths to per-concern modules: ~6,400 LOC.**
- Tests: 1122 → 1398 (+276), suites 70 → 83.

## [Unreleased — 8.2.x maintenance, wave 5] - 2026-05-06 — Frontend "aircraft carrier" splits

The two largest frontend files (system.js 6011 LOC, settings.js 2037 LOC) lifted into per-tab modules using the proven `Object.assign` merge pattern from v6.16.0. No lazy-loading complications — modules load with the rest of the dashboard, but each is reviewable independently and grep-able for one concern.

### Frontend extracts

**`public/js/pages/system.js`: 6011 → 2618 LOC (-56%)**

7 new modules in `public/js/pages/`:

| Module | LOC | Methods |
|---|---|---|
| `system-egress.js` (already in v8.2.x) | 462 | `_renderEgressAudit`, `_loadEgressBlockLog`, `_renderEgressBlockLog`, `_renderEgressBlockLogHeader`, `_exportEgressBlockLogCsv`, `_showEgressFilterModal` |
| `system-templates.js` | 354 | `_renderTemplates`, `_templateFormDialog` |
| `system-backup.js` | 466 | `_renderBackup` (Local + S3 + pCloud sub-cards with v8.2.0 connect/test/run/disconnect) |
| `system-ssl.js` | 803 | `_renderSsl`, `_renderCertificates`, `_showAddCertificateModal`, `_showCsrModal`, `_showAcmeRotateModal`, `_showLetsEncryptWizard` |
| `system-cis.js` | 414 | `_renderCisBenchmark`, `_cisContainerRemediation`, `_cisBenchmarkGuide` |
| `system-secrets.js` | 583 | `_renderSecretsAudit`, `_renderSecretRotations` |
| `system-translations.js` | 442 | `_renderTranslations`, `_renderTranslationsProviders`, `_renderTranslationsUsage`, `_renderTranslationsTranslate`, `_renderTranslationsReview` |

Verified via Puppeteer: 12 tracked render methods all present on `SystemPage`, 8 tabs (info/health/backup/ssl/cis/secrets/translations/templates) render without DOM error states, 0 console errors beyond the unrelated 401 noise.

**`public/js/pages/settings.js`: 2037 → 572 LOC (-72%)**

7 new modules in `public/js/pages/`:

| Module | LOC |
|---|---|
| `settings-users.js` | 452 |
| `settings-registries.js` | 207 |
| `settings-git.js` | 196 |
| `settings-ai.js` | 198 |
| `settings-ldap.js` | 178 |
| `settings-workflows.js` | 159 |
| `settings-logforwarding.js` | 152 |

Smaller tabs (Profile, Webhooks, NotificationChannels, Secrets, General — each <130 LOC) stay in main `settings.js` for proximity to `_renderTab()` dispatch logic.

Verified via Puppeteer: 12 tracked render methods all present on `SettingsPage`.

### Pattern documentation

Both extracts follow the same convention:
- New file declares `const SystemPageX = { ... };` (or `SettingsPageX`).
- Bottom of file: `if (typeof window !== 'undefined') window.SystemPageX = SystemPageX;`.
- Bottom of `system.js` / `settings.js`: alphabetically-ordered chain of `if (typeof X !== 'undefined') Object.assign(SystemPage, X);`.
- `index.html`: each new module gets a `<script>` tag BEFORE the main page script.

Documented in `CLAUDE.md` (architecture invariants section) for future contributors.

### Backend route splits — DEFERRED

`src/routes/system.js` (2827 LOC, 74 routes) and `src/routes/misc.js` (1780 LOC, 42 routes) identified for future split. Backend Express sub-router mounting changes path resolution mid-tree, so each backend split needs careful regression test on the live API. Tracked in BACKLOG.md with explicit rationale; not blocking.

## [Unreleased — 8.2.x maintenance, wave 4] - 2026-05-05 — Caveat closure + scaffold tests + a11y component pass

Final-final closure pass after the wave-2 "all 22 closed" commit identified 3 caveats + 3 self-introduced gaps. All 6 closed in this wave.

### Closed (caveats from wave 2)
- **Egress regression test (Puppeteer)** — confirmed all 6 extracted methods (`_renderEgressAudit`, `_loadEgressBlockLog`, `_renderEgressBlockLog`, `_renderEgressBlockLogHeader`, `_exportEgressBlockLogCsv`, `_showEgressFilterModal`) merged onto `SystemPage` via `Object.assign` after the lazy-load split. 0 CSP violations, 0 console errors. The 6011→5594 LOC refactor is now Puppeteer-validated.
- **Google Fonts dropped** to keep CSP strict `'self'` — the wave-1 CSP tightening missed a `<link href="fonts.googleapis.com/...">` in `index.html` that was producing CSP-violation noise. JetBrains Mono and Inter now degrade to system monospace and sans-serif (the existing fallback chain in `--mono` and `--sans` CSS vars). Privacy + CSP simplicity wins; the brand-identity loss is minor.
- **Howto markdown precedence documented** in CLAUDE.md — the loader is now the canonical source for the 132 markdown files; migrations are kept as schema + safety-net for installs without the markdown directory mounted.

### Closed (self-introduced gaps)
- **+42 tests** for v8.2.x scaffold modules: `telemetry.test.js` (15 cases — off-by-default contract, install-id idempotency, no-op emit verified via http.request spy), `howto-loader.test.js` (15 cases — front-matter edge cases, EN/RO grouping, UPSERT insert+update paths, COALESCE preservation), `template-verification.test.js` (12 cases — migration 065 idempotency, BUILTIN_VERIFICATION 14 entries, getMergedTemplates surface).
- **A11y at component level (round 2)** — global MutationObserver in `app.js._initA11yAugmentation()` walks every page render and adds `role="tablist"`/`role="tab"`/`aria-selected`/`tabindex` to all `.tabs` containers, plus `role="columnheader"`/`aria-sort` to all sortable table headers. Keyboard nav (Left/Right/Home/End on tabs) wired in. Per-page edits no longer needed.

### Final stats (since v8.2.0 release)
- **1122 → 1398 tests** (+276), **70 → 83 suites**.
- **0 audit-debt items deferred.** All 22 issues from "analiza la sange" closed; 3 caveats closed in this wave; 3 self-introduced gaps closed.
- Production readiness score: **9.8 → 9.9 / 10**.

## [Unreleased — 8.2.x maintenance, wave 2] - 2026-05-05 — All audit issues closed

Final closure pass on the post-v8.2.0 brutal audit. Combined with the earlier 6-batch closure, **all 22 originally identified issues are now resolved** (no longer "deferred to future session"). 8 new tasks completed in 3 waves.

### Closed (was deferred from first remediation pass)

- **dockerode 4 → 5 migration.** Single `npm install dockerode@5` — zero API breaks. Release notes confirmed "dropped uuid package, bumped minimum Node version requirement" as the only breaking change. `npm audit` now reports **0 vulnerabilities** (was 1 moderate). SECURITY.md §7 rewritten as historical record.
- **system.js Egress extract.** 436 LOC of egress audit + filter editor lifted into `public/js/pages/system-egress.js` (462 LOC including header). Merged into `SystemPage` at module load via `Object.assign`. system.js: 6011 → 5594 LOC.
- **84 built-in How-To guides extracted to markdown.** New `scripts/extract-howtos-to-markdown.js` walks the `howto_guides` table and writes one `.md` file per slug per language. 132 markdown files (66 howtos × EN + RO) now under `src/db/howto-content/`. Future edits are markdown PRs, not migrations. Existing migrations stay as historical record.
- **FontAwesome + xterm.js + addon-fit self-hosted.** All third-party CDN runtime dependencies eliminated. CSS at `/lib/fontawesome.min.css`, JS at `/lib/xterm.min.js` + `/lib/xterm-addon-fit.min.js`, webfonts at `/webfonts/fa-{brands-400,regular-400,solid-900,v4compatibility}.{woff2,ttf}`.
- **CSP tightened to strict `'self'`.** All third-party origins (`cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`, `fonts.googleapis.com`, `fonts.gstatic.com`) removed from Helmet's CSP allowlist. `script-src`, `style-src`, `font-src`, `img-src`, `connect-src` now permit only `'self'` (plus `data:` / `blob:` / `ws:` / `wss:` where structurally needed).
- **5 more service tests** (waves 1A): `ldap` 26 cases (with `ldapts` fully mocked, including DN injection escape per RFC 4515 + UTF-8 username), `ssh-tunnel` 24 cases (key/password auth, exec, sftp, port-forward fallback chain), `stackBundle` 21 cases (export envelope shape, label-based filtering, generateCompose YAML synthesis), `securityAlerts` 20 cases (5 default rules + windowed evaluation + cooldown + notify_channels routing), `webhooks` 18 cases (HMAC sig + retry-on-5xx + abort-timeout). +109 tests, total 1247 → **1356 / 80 suites**.
- **A11y at component level** — Modal: `role="dialog"` + `aria-modal="true"` + dynamic `aria-labelledby` to the modal heading + `aria-label` injected on icon-only close buttons + focus restored to triggering element on close. Toast: `role` and `aria-live` now scale with severity (errors interrupt assertively, info/success polite + `aria-atomic`). Every modal and toast in the app benefits at once — no per-page rollout needed.

### Final stats (since v8.2.0 release)

- **1122 → 1356 tests** (+234), **70 → 80 suites**.
- **0 npm audit vulnerabilities** (down from 1 moderate).
- **0 third-party CDN runtime deps** (down from 4: jsdelivr × 2, cdnjs, Google Fonts).
- **system.js**: 6011 → 5594 LOC.
- **84 howtos** lifted from SQL migrations to markdown source files.
- Production readiness score: **9.8 → 9.9 / 10**.

## [Unreleased — 8.2.x maintenance] - 2026-05-05 — Post-release remediation pass

A brutal audit identified 22 issues post-v8.2.0 ship; 6 sequential batches closed almost all of them. No public version bump — these are quality + sustainability improvements on top of v8.2.0.

### Added
- **CLAUDE.md at repo root** — durable conventions for AI-assisted contributions (architecture invariants, deep-spec discipline, port/auth conventions, deploy procedure).
- **3 targeted product comparisons** at `docs/comparisons/`: Portainer, Dockge, Komodo. Each ~600 words, no marketing fluff, "pick X if Y, pick DD if Z" framing.
- **Template trust signals** — `verified_at` and `deprecated_in_favor_of` columns on `custom_templates` (migration 065). Built-in `BUILTIN_VERIFICATION` map covers 14 templates (registry + AI Workload Pack). UI renders verified ✓ / stale ⏰ / deprecated ⚠ badges based on age vs 180-day threshold.
- **How-to markdown loader** — `src/db/howto-content/<slug>.md` with YAML front-matter; UPSERTed at startup. Convention shipped, existing 84 howtos kept in their original migrations until piece-by-piece migration.
- **GitHub Discussions enabled** — community Q&A surface alongside Issues. Linked from README header.
- **Anonymous opt-in telemetry scaffold** at `src/services/telemetry.js` — off by default, no PII, install ID stable per install. Collector + Settings UI ship in v8.3.0; v8.2.x is scaffold + design notes only.
- **Observability profile activated on the public VPS** at `http://89.37.212.66:3015` (Grafana + Prometheus on port 3015 to avoid clash with medinet-backend on 3001). Eats own dog food.

### Changed
- **README scrubbed**: test count 1122→1247, test suites 70→75, badges + body kept in sync. Roadmap rewrite to honest "AI vuln/incident triage gated on production signal — v8.x prioritized adjacent value (registry hygiene, pCloud)". Marketing claim "30+ exclusive features" softened to "20+ rows where DD ships features no compared free tool has, coverage gaps cut both ways".
- **SECURITY.md**: Supported Versions rewritten (8.2.x current / 8.1.x security-only / 8.0.x security-only / 7.x best-effort / <7.0 unsupported). Audit history extended with Production Readiness rows for v6.16.1, v7.0.0, v7.3-7.7, v8.0.0, v8.1.0, v8.2.0, and the v8.2.x post-release remediation pass. New §7 documents the accepted moderate `uuid <14.0.0` CVE via `dockerode 4.x` (verified unreachable through Docker Dash's usage; dockerode 5.x migration tracked in BACKLOG).
- **CONTRIBUTING.md**: stats refreshed to v8.2.0, port `:3456`→`:8101`, new "Project workflow conventions" section explains the gitignored `plans/` strategic-spec workflow.
- **BACKLOG.md**: refreshed to post-v8.2.0 state. F30 (HA mode) marked fully shipped. Added P2 entries for AI vuln/incident triage (gated), system.js Egress extract (specified, deferred), and how-to markdown migration (in progress).

### Fixed (architecture / hygiene)
- **9 inline `onclick=` template-string violations** across `containers.js`, `container-detail.js`, `security.js`, `swarm.js`, `system.js` refactored to delegated handlers (`data-tab-jump`, `data-copy`, `data-img-fallback`) registered in `app.js`. **Custom ESLint rule** added at `eslint.config.js` to fail builds on any new inline event-handler string in `public/js/`. The v5.0 promise — "no inline handlers, ever" — is now actually enforced, not on the honor system.
- **Login flow a11y baseline**: `role="alert"` + `aria-live` on error/success regions, `aria-required` on inputs, `aria-label` on theme toggle + GitHub link, `aria-hidden="true"` on icon-only `<i>` elements, `<label class="sr-only">` for the reset-email field that previously had only a placeholder.

### Tests
- **+125 new tests** closing the dedicated-test gap on 5 critical-path services (auth, audit, docker, registry, ssl). Total: 1122 → 1247 (75 suites). Each test file has a header explaining post-v8.2.0 audit rationale.
- New tests fail loudly if their service contract drifts; they were written against the actual exported API, not assumed shape.

### Self-hosted asset
- **Chart.js 4.4.1 served from `/lib/chart.umd.min.js`** (~205 KB local) instead of `cdn.jsdelivr.net`. Removes one external runtime dependency. Note: this does NOT eliminate `unsafe-eval` in CSP — Chart.js uses `new Function()` internally. FontAwesome + xterm.js self-host deferred (BACKLOG P3).

### Deferred to a future session (documented, not silently dropped)
- `system.js` Egress section extract → `system-egress.js` lazy module (~435 LOC, 6 interlinked methods; needs Puppeteer regression of the egress flow).
- `dockerode 4 → 5` migration (~40 call sites; not urgent, advisory unreachable per audit §7).
- i18n auto-translate batch for the 9 ~66%-translated locales (needs Google/DeepL API key + provider decision).
- 84 existing howtos migrated piece-by-piece to markdown files (loader convention is in place; existing data stays in DB until each is migrated).

### Quality gate
- 1247 tests passing, 4 skipped (live-CF ACME), 0 failures.
- Lint: 0 errors, 3 pre-existing warnings unchanged.
- Local + LAN + VPS smoke-tested.

## [8.2.0] - 2026-05-05 — pCloud backup target + stack & audit off-site archives

### Added

- **pCloud backup target.** Push the daily SQLite backup, weekly stack bundles, and monthly audit log dumps to a pCloud account on the free tier (10 GB, EU data center default). Direct token auth — username/password are exchanged once for a long-lived auth token, the password is never persisted. Token stored AES-256-GCM encrypted in the new `pcloud_config` table. UI in **System → Backup → pCloud Backup** card with separate cron + retention controls per artifact kind.
  - Hand-rolled HTTP client around 7 pCloud endpoints (~150 LOC) — deliberately not the abandoned `pcloud-sdk-js`.
  - Quota-aware: aborts uploads that would push usage above 95% or below a 50 MB safety margin. Audit entry on every abort.
  - Per-artifact retention defaults: 7 DB backups, 8 weekly stack snapshots, 24 monthly audit dumps. Capped server-side at max 50 prune deletions per run.

- **Weekly stack bundle archive job.** New cron walks every active host, lists running Compose stacks, calls the existing `bundleService.exportStack()` per stack, and uploads JSON files to `/docker-dash/stacks/YYYY-MM-DD/<host>--<stack>.json` in pCloud (and S3 if `uploadObject` is wired). Per-stack failures don't abort the run.

- **Monthly audit log dump job.** New cron exports the previous calendar month's audit rows as gzipped JSONL to `/docker-dash/audit/YYYY-MM.jsonl.gz`. Hash chain (`entry_hash` / `prev_hash`) preserved row-for-row — consecutive monthly dumps form a continuous off-site witness so an auditor can verify integrity even if the live DB is later tampered. DB rows are NOT deleted (separate retention concern).
  - Streaming export via `better-sqlite3` `stmt.iterate()` — large months (50k+ rows) gzip-stream out without buffer growth.
  - `?month=YYYY-MM` parameter on the manual run route lets operators backfill or re-dump specific months.

- 4 new audit actions: `pcloud_config_update`, `backup_pcloud`, `backup_pcloud_failed`, `pcloud_prune` — recognised by the v8.0.0 AI audit search.
- Migration `064_pcloud_config.js` — single-row settings table (CHECK id=1), 24 columns covering config + per-artifact last-run state + cached quota.
- Tests: `pcloud-client.test.js` (16 cases), `pcloud-backup.test.js` (14 cases), `audit-dump.test.js` (10 cases) — 40 new green tests, total suite still 100% pass.
- Docs: [`docs/features/pcloud-backup.md`](docs/features/pcloud-backup.md) covers setup, encryption, restore, hash-chain verification, and troubleshooting.

### Strategic discipline

This release continued the deep-spec-first pattern from v8.0.0 / v8.1.0. Three artifacts written before code: `plans/deep-spec-v8.2.0-pcloud-and-archives.md`, `plans/feature-spec-pcloud-backup.md`, `plans/feature-spec-stack-bundle-archive.md`, `plans/feature-spec-audit-monthly-dump.md`. The deep-spec one-sentence defense: "Take 'I have an off-host backup' from 'I configured S3 last quarter and never verified' to 'every night three artifacts land in pCloud free tier and I get a red banner when they don't'."

Anti-features explicitly NOT shipped (see deep-spec §1): pCloud OAuth flow, pCloud Crypto, pCloud Drive mount, public sharing links, two-way sync, restore-from-pCloud UI, resumable chunked uploads, the SDK.

### Why pCloud (and not just S3)

S3 is great for cloud-native shops with an existing AWS account. For self-hosters who don't already have S3, pCloud's free 10 GB tier with EU jurisdiction (Switzerland) and direct token auth is genuinely lower friction. Both targets coexist — operators can enable either or both.

## [8.1.3] - 2026-04-30 — Bug fix: garbage rows in Files tab on BusyBox containers

### Fixed

User-reported screenshot showed file rows with bizarre names (`2G)`, `and ..`, `binary.`, `instead of names`, `to names`) and garbled sizes (`0 B 243M`, `0 B */=@|)`) on a frontend container's Files tab.

**Root cause:** the listing endpoint ran `ls -la --time-style=+ISO /path`. BusyBox `ls` (Alpine, distroless, scratch-based images) doesn't support `--time-style` — it responds with help/usage text on stderr. The exec stream demux concatenates stdout + stderr, so the parser ate the help text and produced one bogus "file" entry per help line.

**Fix** ([`src/routes/containers.js:1707-1779`](src/routes/containers.js)) — three layers of defense:

1. **Permissions regex gate** — every line must start with a valid `ls -l` permissions field (`/^[-dlbcps][-rwxstST]{9}[.+]?$/`) or it's discarded. Drops help text, error messages, blank lines, anything that isn't a real row.
2. **Timestamp-shape detection** — if `parts[5]` is an ISO 8601 token (GNU `--time-style` worked), name starts at `parts[6]`; otherwise it's the Unix 3-token form (`MMM DD time-or-year`) and name starts at `parts[8]`. Filenames with spaces still join correctly.
3. **Auto-fallback** without `--time-style` when the first parse returns zero entries — covers BusyBox where the flag itself bombed.

### Verification

The screenshot's specific failure mode (BusyBox-flavored container) is now caught by all three layers — primarily layer #3 (retry without flag) plus layer #1 (regex gate would have caught the help-text rows even on the first pass).

## [8.1.2] - 2026-04-29 — Files tab: preview-mode selector

### Added

- **Per-operator preview-mode selector** on the container detail page → Files tab. Four radio options between the "File Browser" title and the "Upload" button: **Off** (default — single-click does nothing, only the per-row download button works), **Bottom** (single-click → preview panel below — the original behavior), **Right** (single-click → preview panel to the right of the file list, split layout), **Modal** (single-click does nothing, **double-click** opens a modal with the content).
- Choice persists in `localStorage` as `dd_files_preview_mode` so it sticks across container detail visits.
- Default is **Off** — least surprising. No accidental network fetch when an operator is just clicking around.

### Why

Previous behavior was hard-coded "single-click any file → preview below". Operators who don't need previews paid for an HTTP fetch on every click. Operators who wanted side-by-side or modal views had no option.

### Files touched

- `public/js/pages/container-detail.js` — `_renderFilesTab` extended (~50 LOC), `_applyFilesLayout` helper (~30 LOC), `_renderFilePreviewInline` + `_renderFilePreviewModal` extracted from the inline click handler (~40 LOC). Click handler reduced — single + dblclick listeners with mode dispatch.

## [8.1.1] - 2026-04-29 — Bug fix: edit-meta button on Containers list

### Fixed

- **`Uncaught TypeError: ContainersPage._editMetaDialog is not a function`** when clicking the per-row "Edit metadata" button on the Containers list view, IF the user hadn't first opened a container detail page. Same root cause family as v7.2.1's `_stopLogFollow` bug: `_editMetaDialog` lives in `container-detail.js` (lazy-loaded module from the v6.16.0 split), but the eager `containers.js` delegated click handler called it unconditionally. Unlike v7.2.1 (where the safe fix was a no-op guard because the call was internal cleanup), edit-meta is a user-clicked button — must actually work — so the fix lazy-loads the detail module first, then calls. ([public/js/pages/containers.js:3199-3215](public/js/pages/containers.js#L3199))

### Audit

Grepped for other eager-side calls to lazy-only methods. Found `_execUnsub` (also lives in container-detail.js) called from `destroy()` in eager — but it's already protected by `if (this._execUnsub)` guard since the property is `undefined` until the lazy module merges. Safe.

## [8.1.0] - 2026-04-29 — Registry Hygiene Pack (provenance + retention + remote/virtual)

Three orthogonal-but-thematic features that close the most operationally-painful gaps versus JFrog's universal artifact repo, without taking on Harbor's or JFrog's complexity. Ships as one coherent release per the deep-spec ([`plans/deep-spec-registry-hygiene-pack.md`](plans/deep-spec-registry-hygiene-pack.md)).

### One sentence to defend

> **Registry hygiene that operators actually use — provenance you can read, retention you can preview, upstream caching that survives Docker Hub rate limits — without taking on Harbor's or JFrog's operational burden.**

### Added — Build Provenance Panel (read-only)

New collapsible **Provenance** panel inside the manifest-inspect modal on the Registry Browser page. Pure read-side parser ([`src/services/registry-provenance.js`](src/services/registry-provenance.js)) reads OCI annotations + cosign signature presence from the manifest the existing endpoint already fetches. Zero new state, zero new endpoints.

Surfaces:
- **Source** (`org.opencontainers.image.source`) — clickable link if host is `github.com / gitlab.com / bitbucket.org / codeberg.org / gitea.com`; plain text otherwise
- **Commit** (truncated SHA + tooltip with full one) + **Created** timestamp
- **Authors**, **License** (SPDX), **Vendor**, **Version**, **URL**, **Documentation**, **Base image**
- **Signed** badge if `dev.sigstore.cosign.*` annotations or `signatures[]` array present (presence detection only — cryptographic verification deferred to v8.2.0)
- "Show all annotations" expander with full JSON for power users

Empty state when manifest has no annotations: friendly hint linking to the Docker docs on enabling buildx provenance.

### Added — Retention Policies with Dry-Run

Per-repository cleanup rules with **5 layers of safety** (deep-spec D2, D6):

1. **Default disabled** — every saved policy is dry-run only until operator explicitly enables
2. **Hard floor** — `minTagsToKeep` cannot go below 1 (default 3)
3. **Default protected patterns** — `latest`, `v*`, `main`, `master`, `prod-*`, `stable` always survive unless rule explicitly overrides
4. **Server hard cap** — 200 deletions per single run, regardless of rule (prevents misconfigured "delete all but X" from nuking a 5000-tag repo in one tick)
5. **Audit trail** — each deletion writes its own `registry_tag_delete` entry (tamper-evident hash chain) plus an umbrella `retention_executed` summary per run

UX (admin only): Browse page → repo → "Repository settings" expander → Retention policy editor.
- 4 rule templates: Keep Last 10 / Delete Untagged > 30d / Aggressive (5 + 7d) / Reset
- JSON editor for custom rules
- **Preview button** runs dry-run and shows table: would-delete vs would-keep with reason chips per row, total bytes reclaimed
- **Save (dry-run)** vs **Enable** — separate two-step gate
- Last-run state surfaced inline (deleted count, errors, capped indicator, timestamp)

Cron: daily at 03:17 (off-:00), leader-only via the existing `_m()` wrapper. Iterates all enabled policies, evaluates + executes each, persists run summary.

Backend: pure-function evaluator at [`src/services/retention.js`](src/services/retention.js) (no I/O, trivially testable). 7 new endpoints under `/api/registries/:id/repos/:repoPath/retention`. New audit actions: `retention_policy_create`, `retention_policy_update`, `retention_policy_delete`, `retention_dry_run`, `retention_executed`.

### Added — Remote/Virtual Repository Support

JFrog-style repo taxonomy adapted to Distribution's **one-upstream-per-instance** constraint:

| Type | What it does | Implementation |
|------|--------------|----------------|
| **local** | Push target. You push, others pull. | The existing v7.5.0 template, untouched. |
| **remote** | Caching proxy of an upstream registry. | One `registry:3` container per remote upstream, with `REGISTRY_PROXY_REMOTEURL` set. |
| **virtual** | Aggregator URL. Path-prefix routes to local + remotes. | Caddy reverse-proxy with strip_prefix routing. |

**New template "Private Registry + Cache (3 containers)"** — sibling of the v7.5.0 single-container template (which stays untouched). Ships:
- 1 local registry (`registry-local`) — push target
- 2 remote proxies (`registry-proxy-dockerhub` → `https://registry-1.docker.io`, `registry-proxy-ghcr` → `https://ghcr.io`)
- 1 Caddy router (`registry-router` on `:5000`) — virtual routing
- A `registry-virtual.Caddyfile` shipped via the new `extraFiles` template field

After deploy: pull `<host>:5000/dockerhub/library/nginx:alpine` (proxied + cached), `<host>:5000/ghcr/foo/bar:tag` (same), or `<host>:5000/myteam/myapp:v1` (catch-all → local). Solves Docker Hub rate-limit pain + offline operation after first cache.

**Browse UI** gets a "Repository settings" expander with type editor (radio: local / remote / virtual) + upstream URL field (when remote) + encrypted upstream credential storage. Type pill renders next to repo name.

Backend: 4 new endpoints under `/api/registries/:id/repos`. Per-credential encryption of upstream passwords reuses the AES-GCM helper. New audit actions: `registry_repo_create`, `registry_repo_update`, `registry_repo_delete`.

### Database

New migration `063_registry_repos_and_retention.js` — single migration creating both `registry_repos` (local/remote/virtual + upstream metadata) and `retention_policies` (rule JSON + enabled + schedule). ON DELETE CASCADE keeps the schema consistent if a registry credential is removed.

### Tests

| Suite | Tests | Coverage |
|-------|------:|----------|
| `registry-provenance.test.js` | 15 | Empty inputs, defensive array handling, all 12 known OCI keys, source linkification (5 hosts + non-linkable + malformed URL), revision truncation, cosign detection (3 variants), signer extraction |
| `retention.test.js` | 27 | All 4 rule clauses, default protect patterns, min-floor enforcement, 200-cap, sort order, missing pushedAt, summary shape, dry-run vs real execute, partial-failure handling, untagged manifest skip |
| `registry-repos.test.js` | 16 | List, upsert (insert + ON CONFLICT update), encryption round-trip, cascade delete, virtual member resolution, retention policy CRUD |

**Suite: 1024 → 1082 passing / 67 suites.** Lint clean for v8.1.0 (3 pre-existing warnings from v8.0.0 still tracked separately).

### Deep-spec D1-D6 — pre-committed decisions (now shipped)

- **D1** — Auto-seed catch-all `local *` repo entry on first read of any registry credential (so existing UX works without configuration). ✅
- **D2** — Hard floor "keep last 3" enforced regardless of rule. ✅
- **D3** — Provenance panel renders inline in the manifest modal (not a separate tab). ✅
- **D4** — Default 3-container template = local + Docker Hub + GHCR. ✅
- **D5** — Caddy as the virtual-repo router. ✅
- **D6** — Server-side cap of 200 deletions per retention run, regardless of rule. ✅

### Anti-features explicitly NOT shipped (deep-spec §10)

- Federation / multi-region replication
- JFrog Distribution-style release bundles + edge nodes
- Pre-ingest curation gating
- AppTrust evidence graph
- Multi-format repos (Maven/npm/PyPI)
- Promotion workflows (deferred to v8.2.0+)
- Cosign cryptographic verification (deferred to v8.2.0+)
- Auto-trigger of `registry garbage-collect`

If a future request feels like one of those, it'll get a polite no with this CHANGELOG line as the receipt.

### Files touched

- `src/db/migrations/063_registry_repos_and_retention.js` (new)
- `src/services/registry-provenance.js` (new) — pure parser
- `src/services/retention.js` (new) — pure evaluator + executor
- `src/services/retention-cron.js` (new) — daily sweep
- `src/services/registry.js` — 7 new helpers (listRepos, upsertRepo, deleteRepo, resolveVirtual, getRetentionPolicy, upsertRetentionPolicy, deleteRetentionPolicy)
- `src/routes/registries.js` — provenance in manifest endpoint + 11 new endpoints (4 repo CRUD + 5 retention CRUD/preview/run)
- `src/routes/templates.js` — new "Private Registry + Cache (3 containers)" template + Caddyfile in `extraFiles`
- `src/jobs/index.js` — daily retention-sweep cron
- `src/services/ai/features/audit-actions-list.js` — 8 new audit action names added to canonical enum
- `public/js/pages/registry-browse.js` — Provenance panel + Repository settings expander (type editor + retention editor + dry-run preview UI)
- `src/__tests__/registry-provenance.test.js` (new, 15 tests)
- `src/__tests__/retention.test.js` (new, 27 tests)
- `src/__tests__/registry-repos.test.js` (new, 16 tests)

## [8.0.1] - 2026-04-27 — AI Workload Pack + UX polish

Three orthogonal additions while v8.0.0 bakes. Zero new AI infrastructure (deep-spec gate respected). Pure value adds for self-hosters.

### Added — AI Workload Template Pack

12 curated compose snippets in a new **AI** category in the Templates page:

| Template | What it deploys |
|----------|-----------------|
| **Ollama (LLM runtime)** | Local LLM server. Use as the AI provider for Docker Dash itself. |
| **Ollama + Open WebUI** | Full local ChatGPT-style stack. Web UI at :3000. |
| **RAG Stack** | Ollama + Qdrant + Open WebUI. Upload docs, query with citations. |
| **vLLM (high-throughput inference)** | Production-grade GPU inference, OpenAI-compatible API at :8000. |
| **Stable Diffusion WebUI** | AUTOMATIC1111 image generation, GPU required. |
| **ComfyUI (node-based image gen)** | Workflow editor for complex image pipelines. |
| **Whisper (speech-to-text)** | Faster-whisper REST API at :9000. CPU works, GPU is 5-10× faster. |
| **Langflow (visual LangChain)** | Drag-drop LLM workflow editor. |
| **AnythingLLM (full-stack RAG)** | Multi-user RAG with workspaces and document ingestion. |
| **n8n (workflow automation with AI)** | Zapier-style automation with native AI nodes. |
| **LiteLLM Proxy (unified gateway)** | OpenAI-compatible proxy for 100+ providers, cost tracking. |
| **Flowise (drag-drop LLM apps)** | Polished alternative to Langflow. |

All templates ship with the GPU `deploy.resources.reservations.devices` block — commented out by default for CPU compatibility, uncomment for NVIDIA GPU. Pure YAML — zero new code paths, zero risk to v8.0.0 stability.

### Added — Query history for audit NL search

The audit page's NL search box now remembers the last 10 successful queries in `localStorage`. Focus the empty input → dropdown of recent queries appears. Click to re-run; ESC to dismiss; "Clear all" to wipe.

Stays in browser. Never sent server-side beyond the actual search call. Helps operators iterate on phrasing without retyping. ([public/js/pages/system.js](public/js/pages/system.js))

### Added — 3 How-To guides for AI workloads

New `ai` category in How-To Guides. EN + RO content (other 9 languages auto-fall-back via existing i18n machinery):

- **Run Ollama in Docker (CPU and GPU)** — beginner. Pull models, query the API, use as the Docker Dash AI provider, troubleshooting common gotchas (OOM, "model not found", slow CPU inference).
- **GPU passthrough to Docker containers (NVIDIA)** — intermediate. Install nvidia-container-toolkit on Ubuntu/Debian/RHEL, smoke test, compose syntax for GPU access, multi-GPU pinning, AMD ROCm note.
- **Build a self-hosted RAG stack (Ollama + Qdrant + Open WebUI)** — intermediate. Architecture explained, ingest documents, tune chunk size + Top K + hybrid search, common gotchas. Same architecture as commercial RAG products (Glean, NotebookLM) but you own the data.

### Tests

Suite unchanged: **1024 passing / 64 suites**. No new tests needed — pure content additions (templates are static YAML, howto guides are HTML strings, query history is localStorage frontend logic).

### Files touched

- `src/routes/templates.js` — 12 new entries in TEMPLATES array (~80 lines)
- `src/db/migrations/062_howto_ai_workloads.js` (new) — 3 howto guides
- `public/js/pages/system.js` — query history dropdown + click-to-re-run

### Why a patch (8.0.1) and not a minor (8.1.0)

- Zero new AI infrastructure, zero new outbound calls, zero new privacy surface
- Pure additive content (templates + guides + frontend UX)
- The deep-spec discipline gate explicitly blocks v8.1.0 until v8.0.0 has 2+ weeks production + redactor catch in real usage
- Operators upgrading from v8.0.0 will see the new templates and guides; nothing breaks

## [8.0.0] - 2026-04-27 — AI features (audit NL search, BYOK, off by default)

**Major bump.** First feature category that introduces optional outbound traffic to non-user-controlled hosts. New Settings tab, new database table, new privacy posture, full audit trail. Designed strategy-first — see `plans/deep-spec-ai-features.md` (~2700 words) and `plans/spikes-ai-features.md` for the full rationale before any code landed.

### One sentence to defend

> **AI in Docker Dash exists to translate noisy data into ranked, explainable decisions — never to take actions on the user's behalf.**

Every design choice flows from this. Read-only or read-then-suggest. No auto-remediation agent. No always-on chat sidebar. No AI-generated padding. If a future request feels like one of those, it'll get a polite no with rationale on the issue.

### Added — Provider abstraction (BYOK)

- **`src/services/ai/`** module with three adapters:
  - `providers/anthropic.js` — Claude via Messages API + tool_use forced via `tool_choice`
  - `providers/openai.js` — GPT via Chat Completions + `response_format: json_schema` (strict mode)
  - `providers/ollama.js` — local LLM via `/api/chat` + `format: "json"`
- All adapters implement the same `structured()` contract: pass schema, get back validated `{data, usage, model, latencyMs}`. Caller can trust `.data` is valid.
- **BYOK only.** Docker Dash ships zero API keys. Operator pastes their own (or points at their own Ollama URL).
- **Off by default.** New deployments have `enabled = 0` after migration. UI only shows AI surfaces beyond the Settings tab when enabled + provider configured.

### Added — Privacy + audit infrastructure

- **`src/services/ai/redactor.js`** strips secrets/PII before any payload leaves the host. Built-in patterns cover Bearer auth, env-style assignments (`*PASSWORD*=val`, `*SECRET*=val`, etc. with prefix/suffix tolerance like `STRIPE_SECRET_KEY`), connection-string credentials (13 schemes — `postgres://user:pass@host`), high-entropy tokens, IPs, emails. Operators can add custom regex via Settings → AI.
- Validated via spike S4 (`plans/spikes-ai-features.md`): **100% recall, 100% precision** on a 27-case hand-built corpus.
- **D4 — abort on regex failure.** Bad custom regex (catastrophic backtracking) aborts the AI call rather than sending unredacted. Privacy beats utility.
- Every AI call writes a row to `audit_log` with `action = 'ai_call'` and details: `provider`, `model`, `inputTokens`, `outputTokens`, `durationMs`, `redactions` (per-pattern count), `payloadHash` (SHA-256 of original prompt, 8 hex), `ok: bool`, `error?`.
- **Compliance gold:** the `payloadHash` lets operators prove "did this exact text get sent?" by hashing locally and comparing — privacy-preserving evidence trail without storing the actual prompt.

### Added — Audit log NL search (the v8.0.0 feature)

System → Audit page → magic-wand search box at the top. Examples: *"who deleted containers in the last 7 days"*, *"all actions by alice today"*, *"failed registry pushes this week"*.

How it works:
1. Query → redactor → provider via `aiService.call()`.
2. Provider returns a structured filter conforming to `AUDIT_FILTER_SCHEMA` (actor, action, resource, host, since, until, limit). The `action` enum is the **canonical 161-entry list extracted from the codebase via spike S5** — LLMs cannot invent action values.
3. Schema validated client-side (defense in depth). Invalid responses rejected.
4. Translated to existing audit query path. **Never NL→SQL** — only structured fields.
5. **D5 — server-side limit cap of 200**, regardless of LLM-requested limit. Prevents accidental massive scans.
6. Parsed filter renders as chips above the result table so operators see what the LLM understood. Click "Clear" to reset.

### Added — Settings → AI tab

Admin-only. Three tabs of configuration: provider selector (radio buttons with built-in catalog), model picker (recommended badge), API key / endpoint URL (encrypted at rest via existing AES-GCM helper). "Test connection" button verifies cred + connectivity without burning real-feature tokens. Privacy panel with explicit "what gets sent / what doesn't" lists. Custom redaction patterns textarea (one regex per line, validated on save).

### Added — Documentation

- **`docs/features/ai.md`** (~400 lines) — 3-min setup, provider tradeoffs (cost + latency + privacy per provider), redactor pattern reference, the v8.0.0 feature, failure modes, programmatic API examples, anti-features section.
- **`plans/deep-spec-ai-features.md`** (local) — architectural deep-spec written before any code. 6 open decisions (D1-D6) resolved before commit.
- **`plans/spikes-ai-features.md`** (local) — pre-implementation validation. S4 + S5 ran autonomously; S1-S3 documented as runnable protocols (need API keys).

### Database

New migration `061_ai_settings.js` creates a single-row `ai_settings` table (CHECK id = 1) with: enabled, provider, model, api_key_encrypted, endpoint_url, custom_redaction_patterns (JSON), updated_at, updated_by. Seeded with `enabled = 0` so all installs start in the off state.

### Tests

- **63 new tests** across `ai-redactor.test.js` (33 — pattern coverage + payload hash determinism + custom pattern compilation + D4 abort) and `ai-service.test.js` (30 — settings persistence + encryption round-trip + key masking + provider abstraction with `MockAiProvider` + audit log entry verification + schema validator).
- Suite: 961 → **1024 passing / 64 suites**. Lint clean, npm audit clean.

### Files touched

- `src/services/ai/index.js` (new — service entrypoint)
- `src/services/ai/redactor.js` (new)
- `src/services/ai/providers/base.js` (new — interface + MockAiProvider)
- `src/services/ai/providers/anthropic.js` (new)
- `src/services/ai/providers/openai.js` (new)
- `src/services/ai/providers/ollama.js` (new)
- `src/services/ai/features/audit-search.js` (new — schema + translateQuery)
- `src/services/ai/features/audit-actions-list.js` (new — 161-entry enum)
- `src/routes/ai.js` (new — settings + test + providers catalog)
- `src/routes/audit.js` — `POST /ai-search`
- `src/server.js` — mount `/api/ai`
- `src/db/migrations/061_ai_settings.js` (new)
- `public/js/pages/settings.js` — AI tab (~200 LOC)
- `public/js/pages/system.js` — Audit NL search box + parsed-filter chips
- `src/__tests__/ai-redactor.test.js` (new, 33 tests)
- `src/__tests__/ai-service.test.js` (new, 30 tests)
- `docs/features/ai.md` (new)
- `plans/deep-spec-ai-features.md` + `plans/spikes-ai-features.md` (local)

### Why v8.0.0 (major bump)

- New feature category with new privacy posture (optional cloud egress)
- New Settings tab + new database table
- Deserves a release note operators read carefully before enabling
- Not breaking on API surface — but the privacy story is significant enough that minor (v7.8.0) would understate it

### What's NOT in v8.0.0 (by design)

- **Vulnerability triage** — ships in v8.1.0 once the abstraction is battle-tested
- **Incident triage** — ships in v8.2.0
- **Always-on chat sidebar** — won't ship (anti-feature, see deep-spec §1)
- **Auto-remediation** — won't ship (Replit-class risk)
- **Per-feature provider override** — single global provider in v8.0.0; per-feature deferred to v8.2.0 if requested
- **Result caching** — each NL query is unique, caching adds complexity without value

### Roadmap

| Version | Feature | Decision gate |
|---------|---------|---------------|
| **v8.0.0** | Audit NL search | ≥ 1 operator configures + runs ≥ 10 successful searches over a week |
| v8.1.0 | Vulnerability triage | Audit search has been in production 2+ weeks with no compliance issues + ≥ 1 redactor catch in real usage |
| v8.2.0 | Incident triage | v8.1.0 stable + redaction layer battle-tested |

## [7.7.0] - 2026-04-26 — CI lint enforcement + registry feature doc

Two no-feature changes that close real gaps:

### Added — `docs/features/registry.md`

A unified ~200-line guide for the registry workflow shipped over v7.5.0–v7.6.0. Until now, the implementation details lived in CHANGELOG entries — fine for ship notes, hard to navigate for an operator who just wants to deploy a registry and push to it.

The doc covers:
- **Quick start** — clone-to-pushed-image in five minutes
- **Why Distribution and not Harbor** — rationale comparison table
- **Push flow** — UI walkthrough + backend code snippet + RBAC + audit + limitations (multi-arch, insecure registries, OAuth tokens)
- **Browse + manifest inspect** — endpoints + UI behavior
- **Delete tag** — Distribution's by-digest constraint, our two-step gate, idempotency, garbage-collection guidance
- **Programmatic API** — `curl` examples for CI scripts that want to reuse the credential store
- **Troubleshooting table** — 8 common symptoms + fixes
- **Explicit "what's NOT here" section** — multi-arch, auto-GC, pagination, per-repo perms, signing, webhooks (with rationale per item)

Linked from `CHANGELOG.md` and `docs/CONTRIBUTING.md`. Future "what does this feature do?" questions point here, not at the changelog.

### Fixed — CI now enforces ESLint

The existing CI workflow (`.github/workflows/ci.yml`) already ran syntax checks, tests, npm audit, and i18n validation on every PR + push to main. But `npm run lint` was **not** in the pipeline — the CONTRIBUTING.md "must be 0/0" rule was on the honor system. A contributor could open a PR with lint warnings and CI would still pass green.

Added a dedicated **Lint (ESLint)** step between syntax-check and tests. Runs `npm run lint` which fails if eslint reports any warning or error. Summary footer now lists "Lint (ESLint): ✅" alongside the other steps.

### Tests

Suite unchanged: 961 passing / 62 suites. The CI fix is a process improvement, not a code change.

### Files touched

- `.github/workflows/ci.yml` — Lint step added between syntax-check and tests
- `docs/features/registry.md` (new) — full registry feature guide

## [7.6.0] - 2026-04-26 — Registry delete + observability extras

Closes the explicit v7.6 commitments from v7.5.0 and a few v7.2.0/v7.3.0 roadmap items that were "may add later". Three coordinated additions, all real backend + UI + tests.

### Added — Delete from registry

Promised in v7.5.0 release notes. Distribution exposes delete by digest only (not by tag), and deleting a prod tag accidentally is a footgun — both addressed:

- **`DELETE /api/registries/:id/tag/*ref`** — admin-only, audited. Resolves the tag → digest via `HEAD /v2/<repo>/manifests/<tag>` (cheap), then `DELETE /v2/<repo>/manifests/<digest>`. Idempotent: 404 from the delete is treated as success (already gone). Surfaces a clear error when the registry has deletion disabled (`REGISTRY_STORAGE_DELETE_ENABLED=false` → HTTP 405/501). ([src/services/registry.js](src/services/registry.js), [src/routes/registries.js](src/routes/registries.js))

- **Browse page Delete button** — admin-only, behind a **two-step confirmation gate**: type the full `repo:tag` string before the Delete button enables. Modal explains that the manifest is removed immediately but layer blobs are reclaimed only when the operator runs `registry garbage-collect` on the host (Distribution doesn't auto-GC, by design). Audit log: `registry_tag_delete` on success, `registry_tag_delete_failed` on either resolve or delete failure. ([public/js/pages/registry-browse.js](public/js/pages/registry-browse.js))

### Added — Observability wizard reachability probe

The v7.2.0 wizard detected Prometheus + Grafana by image-prefix only. Two failure modes that detection can't catch: (a) container running but the inner process crashed; (b) container running but on a different Docker network so we can't reach it. Now the wizard probes:

- **`GET /-/healthy`** on detected Prometheus
- **`GET /api/health`** on detected Grafana
- 2-second timeout per probe; failure messages explain (`ECONNREFUSED`, `timeout`, etc.)
- Reachability pills render next to each detected service in the wizard banner: green "reachable (HTTP 200)" or red "unreachable (`<error>`)". The banner stays the right color (green/yellow/grey) based on detection so the status pill is additive context, not a layout shift.

Implementation: pure-function `_probe(url)` + `probe(detection)` in [`src/services/observability-detect.js`](src/services/observability-detect.js); wired into the existing `GET /api/observability/detect` endpoint. ~60 LOC service + ~6 LOC route + ~8 LOC UI.

### Added — "Top Containers" Grafana dashboard

Second dashboard JSON that ships with the observability profile (auto-provisioned by Grafana on container start). Three panels using the existing `docker_dash_container_cpu` + `docker_dash_container_memory_bytes` metrics from `/api/metrics`:

- Top 10 by CPU (timeseries)
- Top 10 by memory (timeseries)
- Sortable table of all containers with gauge-style CPU column

Refresh 30s. UID: `docker-dash-top-containers`. Lives in the auto-imported "Docker Dash" folder alongside the v7.1.0 Overview dashboard. No config required. ([docker/observability/grafana/dashboards/docker-dash-top-containers.json](docker/observability/grafana/dashboards/docker-dash-top-containers.json))

### Added — Prometheus alert rules

5 recommended rules in [`docker/observability/alerts/docker-dash.yml`](docker/observability/alerts/docker-dash.yml), auto-loaded by Prometheus when the observability profile starts (compose now bind-mounts the alerts dir). Wire an Alertmanager to forward fires to Slack/PagerDuty/etc — Prometheus by itself only evaluates and shows them in `/alerts`.

| Rule | Severity | Expression |
|---|---|---|
| `DockerDashDown` | page | `up{job="docker-dash"} == 0` for 1m |
| `ClusterNoSingleLeader` | page | HA mode + count of leaders ≠ 1 for 2m (split-brain or no leader) |
| `ClusterRedisDown` | page | HA mode + `cluster_redis_connected == 0` for 2m |
| `HighErrorRate` | page | 5xx rate > 0.1/s for 5m |
| `HighRequestLatency` | warning | avg request duration > 1000ms for 5m |
| `BackgroundJobErrors` | warning | any background job throwing for 15m |

The HA-mode rules (`ClusterNoSingleLeader`, `ClusterRedisDown`) are guarded by the `mode="ha"` label so they don't fire spuriously on standalone deployments.

### Tests

- 3 new tests for `deleteTag` argument validation (the HTTP path is exercised manually on staging — mocking `_apiCall` cleanly would require a service restructure for one test).
- 6 new tests for `_probe` + `probe` (invalid URL, unsupported protocol, connection refused, null detection, no internalUrl, URL attachment).
- Suite: 952 → **961 passing / 62 suites**. Lint clean, npm audit clean.

### Process

Closes the loop on the four scheduled "soak check" tasks for v7.3.0 update-check: opened as **GitHub Issues #7-#10** (2-week / 1-month / 2-month / 3-month) with checklists you can run through and check off. Replaces the in-Claude session-only crons that wouldn't have survived a session restart.

### Files touched

- `src/services/registry.js` — `deleteTag()` + `_apiCall()` extended with `method` option
- `src/routes/registries.js` — `DELETE /:id/tag/*ref`
- `public/js/pages/registry-browse.js` — Delete button + `_confirmDeleteTag()`
- `src/services/observability-detect.js` — `probe()` + `_probe()`
- `src/routes/observability.js` — wires `probe()` into `/detect`
- `public/js/pages/observability-wizard.js` — reachability pills in branch banners
- `docker/observability/grafana/dashboards/docker-dash-top-containers.json` (new)
- `docker/observability/alerts/docker-dash.yml` (new)
- `docker/observability/prometheus.yml` — `rule_files` block
- `docker-compose.yml` — bind-mount `alerts/` into prometheus container
- `src/__tests__/registry-push.test.js` — 3 new tests
- `src/__tests__/observability-detect.test.js` — 6 new tests

### What's still NOT done (intentionally)

- **Auto-deploy Prometheus+Grafana via dockerode** — significant refactor (we'd replicate compose's parser in Node) for a marginal UX gain (one click vs one CLI command). Original v7.2.0 rationale for deferral still holds. If you want it, open a discussion.
- **Self-host Chart.js + FontAwesome + fonts** to silence Edge tracking-prevention warnings — large refactor for cosmetic warnings on one specific browser.
- **HTTPS for COOP warning** — already supported via Caddy `--profile tls`; operator decision.

## [7.5.1] - 2026-04-26 — Bug fix

### Fixed

- **Broken `#/howto/contributing` button** in the Sample Plugin page header. The link pointed to an in-app How-To guide that doesn't exist (the actual How-To page has a "Contribute to Docker Dash" button that opens GitHub directly). Removed the duplicate button — the "Contributing Guide" button still opens `docs/CONTRIBUTING.md` on GitHub. ([public/js/pages/sample-feature.js:94-104](public/js/pages/sample-feature.js))

## [7.5.0] - 2026-04-26 — Image Registry — push, browse, deploy template

Three coordinated additions that turn the existing read-only "Registries" credential store into a first-class registry workflow: deploy your own private registry from a template, push local images to any configured registry with live progress, and browse remote registry contents with manifest inspection.

### Added — "Private Registry (Distribution)" template

New entry in the Templates page under the **DevOps** category. Single container + 1 named volume + htpasswd auth — the full Distribution `registry:3` stack in one click. Compose snippet uses the production-grade defaults: `REGISTRY_STORAGE_DELETE_ENABLED=true` (so future delete actions work), htpasswd realm pre-set, restart policy unless-stopped.

After deploy, operators run one `htpasswd` command (documented in the template description), add the URL as a Registry credential in Settings → Registries, and immediately get push + browse against it.

We **deliberately don't bundle Harbor** as a template. Harbor's installer ships 9-11 containers (Postgres + Redis + Trivy + Notary + nginx + jobservice + ...), uses a dynamic compose file generated by `install.sh`, and needs 4-8 GB RAM. Wrapping it would be a maintenance commitment we don't want to take. Operators who need enterprise features (RBAC, scanning, replication, signing) deploy Harbor via its official installer and add it as a Registry credential here — same UX from our end.

### Added — Push to Registry (Images page)

New action button + context menu entry on every image row. Modal shows source image, target registry picker (lists all configured Registries credentials), repo + tag inputs (pre-filled from source), and a live preview of the final tag (`<host>/<repo>:<tag>`).

Submit streams progress via **Server-Sent Events** from `POST /api/registries/:id/push`:

- Each layer renders one row with status + percentage, updated in place.
- "Layer already exists" rows surface in green so users see the registry's deduplication.
- Final summary shows N layers + total bytes pushed + duration.
- Errors anywhere in the stream surface a clear red status with the message and abort cleanly.

Backend uses dockerode's `image.tag()` + `image.push({ authconfig })` with the registry's stored credentials (decrypted via the existing `_decryptLegacyOrNew` helper that handles both AES-GCM and the legacy XOR format). Audit log: `registry_push` on success, `registry_push_failed` on either init or stream failure, both with `{ registry, sourceImage, targetRepo, targetTag, durationMs }`.

**Multi-arch manifest lists are not supported via this path** — that's a `docker buildx imagetools` / `skopeo` operation, not something the engine API exposes. The modal includes a yellow info note explaining this; we don't half-implement what we can't get right.

RBAC: admin + operator can push (operators legitimately deploy app images); viewers cannot.

### Added — Registry Browser page

New admin-only sidebar entry "Registries" (`/registry-browse`). Two-pane layout: repository list on the left (with filter), tag list + manifest inspector on the right.

- **Repositories** are listed via the existing `GET /api/registries/:id/catalog` endpoint. Filter is client-side (typical V2 catalogs have ≤ a few hundred repos).
- **Tags** load on click via the existing `GET /api/registries/:id/tags/*repo`.
- **Manifest inspect** is new in v7.5.0 — `GET /api/registries/:id/manifest/*ref` returns the raw manifest, content type, and `Docker-Content-Digest` header. UI shows: digest, content type, schema version, layer count + total size, and a collapsible per-layer breakdown. For multi-arch image indexes (`application/vnd.oci.image.index.v1+json` or `application/vnd.docker.distribution.manifest.list.v2+json`), the per-arch manifests are listed with `<os>/<arch>/<variant>` + per-arch digest + size.
- "Copy pull command" button renders `docker pull <host>/<repo>:<tag>` to clipboard.

Last-selected registry persists in `sessionStorage` so re-visiting the page lands on the same context. Sidebar entry is `admin-only`; readers don't need this.

**Delete is intentionally NOT in v7.5.0.** Distribution exposes delete by digest (not tag) which requires manifest resolution + a strong confirmation gate; deleting a prod tag accidentally is a footgun. Ships in v7.6 if the workflow is needed.

### Tests

- 8 new tests in `src/__tests__/registry-push.test.js` covering the push service: error paths (missing registry, missing args, tag-fails, push-init-fails), correct dockerode call shape (tag opts, push opts, authconfig structure), `last_used_at` update on success, empty-creds case.
- Suite: 944 → **952 passing / 62 suites**. Lint clean, npm audit clean.

### Files touched

- `src/services/registry.js` — `pushImage()`, `manifest()`, `_authConfigForRegistry()` + `_apiCall()` extended with custom Accept header + response headers
- `src/routes/registries.js` — `POST /:id/push` (SSE) + `GET /:id/manifest/*ref`
- `src/routes/templates.js` — `private-registry` template entry
- `src/__tests__/registry-push.test.js` — new (8 tests)
- `public/js/pages/images.js` — push button + context menu entry + `_pushDialog()` + `_streamPush()` (~220 LOC)
- `public/js/pages/registry-browse.js` — new browser page (~270 LOC)
- `public/index.html` — sidebar entry + script tag
- `public/js/app.js` — page registry entry
- `public/js/i18n/en.js` + `ro.js` — `nav['registry-browse']`

## [7.4.0] - 2026-04-25 — "Contributor Demo" — sample plugin + CONTRIBUTING.md

A working reference implementation that contributors can copy as a starting point for new features, plus a complete contributor onboarding guide. Lives at `/sample-feature` in the running app (admin-only, hidden from production via `DD_SHOW_SAMPLE_PLUGIN=false`).

### Added — Sample feature (live demo at `/sample-feature`)

A counter that exercises **every layer of the Docker Dash stack** in ~400 LOC across 4 source files:

- **[`src/services/sample-feature.js`](src/services/sample-feature.js)** — pure business logic, persists to `settings` table, broadcasts WS events on every change. Demonstrates the standard service shape: pure functions, optional WS broadcaster wired at startup, exported `_internals` for tests.
- **[`src/routes/sample-feature.js`](src/routes/sample-feature.js)** — REST surface. Demonstrates `requireAuth` + `requireRole(...)` per route (viewer reads, operator+admin mutates, admin-only resets) and `auditService.log()` on destructive actions.
- **[`public/js/pages/sample-feature.js`](public/js/pages/sample-feature.js)** — vanilla-JS page module. Live counter + WS subscription + "How this works" panel with 7 collapsible cards (one per layer). Each card has "View on GitHub" + "View source" (modal with the actual local file).
- **[`src/__tests__/sample-feature.test.js`](src/__tests__/sample-feature.test.js)** — 13 unit tests. Mirrors the standard test pattern: in-memory SQLite, `beforeEach` reset, tests for the service in isolation.
- **Cron tick** in `src/jobs/index.js` (1/min, leader-only via `_m()`) auto-increments the counter so contributors see the cron pattern fire without external triggers.

The page header has 3 buttons: link to **CONTRIBUTING.md** (opens GitHub), link to the in-app **How-To: Contributing** entry, and link to the **example folder README** on GitHub. Sub-banner shows live status pills (✓ Service ✓ Route ✓ Page ✓ WebSocket ✓ Cron ✓ Audit ✓ Tests) — click any pill to scroll to + highlight that layer's card.

Visibility flag: `DD_SHOW_SAMPLE_PLUGIN=false` in `.env` hides the route, sidebar entry, and cron entirely. Default: visible to admins.

### Added — Contributor onboarding

- **[`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md)** (~400 lines): local setup, project layout 1-pager, the **12-step checklist** for adding a new page (cross-references the sample feature), conventions section (security/RBAC/audit/i18n/error handling/logging), tests + lint, versioning + release flow, PR template, "what we won't merge" list, where to get help.
- **[`examples/sample-feature/README.md`](examples/sample-feature/README.md)**: file-tree map + step-by-step walkthrough specific to the sample. Includes rationale for each pattern (why pure-function services, why per-route RBAC, why leader-gated cron, why no frontend build step).
- **In-app How-To page**: new "Contribute to Docker Dash" CTA card (3rd primary button) that opens `docs/CONTRIBUTING.md` on GitHub.

### Why these patterns?

The sample feature is deliberately a trivial domain (a counter) so contributors can focus on **scaffolding** rather than business logic. Every choice in the example reflects an actual codebase convention with a real reason:

- Pure-function services → trivial unit tests with `:memory:` SQLite, no Express mocking.
- `requireAuth + requireRole` per route → security posture readable from a single grep.
- Audit log on destructive actions → non-negotiable for operator-facing features.
- Cron jobs leader-gated → prevents N× duplication in HA mode.
- WebSocket pub/sub → click on replica A propagates to subscribers on replica B in milliseconds (via Redis in HA, in-process in standalone).
- i18n EN as source-of-truth + `_fallback` → contributors don't need to translate to all 11 languages.
- No frontend build step → vanilla JS, hot-reloadable, approachable to operators who know JS but not "the modern frontend stack".

### Tests

- 907 → **944 passing / 61 suites** (+13 new tests for sample-feature, +1 new suite).
- Lint: 0 warnings / 0 errors.

### Files touched

- `src/services/sample-feature.js` (new)
- `src/routes/sample-feature.js` (new)
- `src/__tests__/sample-feature.test.js` (new, 13 tests)
- `public/js/pages/sample-feature.js` (new)
- `examples/sample-feature/README.md` (new)
- `docs/CONTRIBUTING.md` (new)
- `src/server.js` — gated route mount + WS broadcaster wire
- `src/jobs/index.js` — gated cron tick (leader-only)
- `public/index.html` — sidebar nav-item + script tag
- `public/js/app.js` — page registry entry
- `public/js/i18n/en.js` + `ro.js` — `nav.sample-feature` + `pages.sampleFeature.*` (~30 keys each)
- `public/js/pages/howto.js` — third primary CTA: "Contribute to Docker Dash"

## [7.3.7] - 2026-04-25 — Browser console hygiene

A user-driven cleanup pass on the dev-tools console output. Three real issues, three drive-by warnings I left alone (and explain why).

### Fixed

- **CSP blocked inline `<script>`** in the login screen (`Executing inline script violates the following Content Security Policy directive`). The forgot-password reveal/submit handler lived inline in `public/index.html`. Extracted to [`public/js/login-reset.js`](public/js/login-reset.js) and referenced via `<script src=…>` so the existing `script-src 'self'` directive accepts it. No `unsafe-inline` was added (would defeat the point of CSP).

- **Permissions-Policy "Unrecognized feature" warnings** for six entries the current browsers no longer understand: `ambient-light-sensor` (early proposal, never standardized), `battery` (removed for privacy), `document-domain` (not a Permissions-Policy feature — lives in CSP/headers), `execution-while-not-rendered`, `execution-while-out-of-viewport`, `navigation-override` (all three Chrome-only, never standardized). Removed from the header in [`src/server.js`](src/server.js#L52-L74). All six are still safe at the platform level — listing them here was warning-noise, not protection.

- **Origin-Agent-Cluster mismatch warning** ("could not be origin-keyed since the origin had previously been placed in a site-keyed agent cluster"). Helmet defaults to sending `Origin-Agent-Cluster: ?1`, which only takes effect if every page on the origin opts in consistently — our SPA doesn't, so the warning fires on every page load. Disabled via `helmet({ originAgentCluster: false })`. We don't need agent-cluster keying for our use case.

### Not fixed (and why)

- **`Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy`** — fires on plain HTTP. The browser refuses COOP enforcement on insecure origins. Goes away in production behind HTTPS (Caddy `--profile tls` or any other TLS termination). No code fix needed.

- **`Tracking Prevention blocked access to storage for <URL>`** — Edge's strict tracking prevention blocking 3rd-party storage for our CDN dependencies (jsDelivr, cdnjs, Google Fonts). Browser-side feature, can't be turned off from server. Could be eliminated by self-hosting Chart.js / FontAwesome / fonts — large refactor for a cosmetic warning. Deferred.

## [7.3.5] - 2026-04-25 — WS cookie-first auth + What's New update banner

### Fixed

- **WebSocket connection failures** (rejected by server with `WS rejected: query token auth disabled`). The client always appended `?token=<bearer>` to the WS URL, but the server rejects query-token auth by default for security (set `WS_QUERY_TOKEN_ENABLED=true` to allow). The session cookie (httpOnly `dd_sid`) was already attached to the WS handshake by the browser, so cookie auth would have worked — the client just never gave it a chance.

  Now the client tries **cookie-only first**. Only if that closes with code 4001 (auth failed) AND a Bearer token is in `sessionStorage` does it fall back to token-in-query for one retry. This keeps the security default intact for everyone using cookies, while preserving the fallback for browsers that block them (Edge Tracking Prevention etc.). Reset to cookie-first on every successful open so a rotated token gets re-tried correctly. ([public/js/ws.js:6-25, 44-56, 68-91](public/js/ws.js))

### Added

- **Inline "Update available" banner** in the What's New page header. When `UpdateNotifier._state.hasUpdate === true`, a small accent-colored chip appears between the H2 and the version+GitHub controls — same row, no header growth. Click → opens the same release-notes modal as the sidebar badge. Hidden when up-to-date or feature disabled. ([public/js/pages/whatsnew.js:1369-1418](public/js/pages/whatsnew.js))

## [7.3.3] - 2026-04-25 — System → Updates surfaces app updates too

The v7.3.0 update notifier was reachable from the sidebar badge and System Settings → General — but **not** from System → Updates, which is the page users naturally reach for "is there an update for X?" That page only checked Docker Engine + OS updates, with the Docker Dash row showing only the running version (no comparison to GitHub latest).

### Fixed

- **`GET /api/system/check-updates`** — the existing endpoint now also surfaces the Docker Dash app update status (current, latest, updateAvailable, releaseUrl, publishedAt, lastChecked, enabled). Calls `updateCheck.refresh({ force: true })` first so the user sees fresh data after clicking the *Check Updates* button. Refresh is internally throttled per-instance, so spamming the button is safe. ([src/routes/system.js:354-407](src/routes/system.js#L354-L407))

- **System → Updates page** — the Docker Dash app row now shows the same badge logic the sidebar uses: **Update available** when `updateAvailable=true`, **Up to date** when caught up, **Disabled** when the operator has turned the feature off in System Settings. The "Update available" badge is a clickable link that opens the update notifier modal (release notes + admin upgrade command). UpdateNotifier re-fetches before opening so the modal reflects the freshly-checked cache. ([public/js/pages/system.js:295-314](public/js/pages/system.js#L295-L314))

## [7.3.1] - 2026-04-25 — Smoother session-expiry recovery

When a session expired, the UX collapsed: every parallel in-flight API call (containers list, stats, alerts, notifications, host overview…) returned 401 and each one independently:

1. Spawned a `Failed to load X: Unauthorized` red toast — burying the login form under 5-15 stacked errors.
2. Called `App.handleUnauthorized()` → `_showLogin()` → which **cloned the login form node** to remove old listeners, **detaching whatever the user was typing into**. Focus disappeared mid-keystroke. Some users had to triple-click to re-focus the password field.
3. Did nothing to stop the previous page's `setInterval` polling, so 401s kept arriving every few seconds and the cycle repeated.

This release fixes all three.

### Fixed

- **Toast spam during auth transitions** — added [`Toast.muteErrorsForMs(ms)`](public/js/components/toast.js). When `Api.request` sees a 401, it mutes error/warning toasts for 6s before calling `handleUnauthorized()`. The mute window self-extends if more 401s arrive (so a stuck `setInterval` doesn't break out after 6s).
- **`App.handleUnauthorized()` is idempotent** — the first 401 transitions to login and sets `_inUnauthState = true`; subsequent 401s are no-ops until login succeeds. Cleared in `_showApp()` so a future expiration triggers fresh.
- **`App._showLogin()` is idempotent** — if the screen is already visible, the existing form bindings are reused (no clone, no focus theft). Best-effort focus to `#login-user` if nothing else is focused.
- **Stale polling stopped** — `handleUnauthorized()` now destroys `_currentPage` (calling its `destroy()` to clear `_refreshTimer` / `_statsTimer` / etc.) so the previous page's intervals stop firing while the user is on the login screen.
- **Auto-focus on login screen** — username field gets focus 50ms after `_showLogin()` so re-auth is `type → tab → type → enter` (no mouse).

### Files touched

- `public/js/components/toast.js` — `muteErrorsForMs` + `show()` mute gate
- `public/js/api.js` — sets the mute window before calling `handleUnauthorized`, throws `Error` with `isAuthError = true` flag
- `public/js/app.js` — idempotent `handleUnauthorized` + `_showLogin`, page destroy on 401, auto-focus, `_inUnauthState` cleared in `_showApp`
- `public/js/pages/whatsnew.js` — entries for v7.3.1, v7.3.0, v7.2.1

## [7.3.0] - 2026-04-25 — "Update Notifications"

Periodic, opt-out check for new Docker Dash releases on GitHub. Solves the "user cloned the repo a week ago and has no idea v7.3.0 shipped" gap. Designed to be **quiet**: a tiny pulsing ↑ badge next to the sidebar version, click-to-open modal with the full release notes (rendered from the GitHub Release `body`), and a one-click "show upgrade command" for admins.

### Added — Backend

- **`src/services/update-check.js`** (~165 LOC) — polls `https://api.github.com/repos/<owner>/<repo>/releases/latest`, semver-compares against `src/version.js`, caches the result in the `settings` table. Configurable owner/repo via `DD_UPDATE_CHECK_OWNER` / `DD_UPDATE_CHECK_REPO` env vars (defaults: `bogdanpricop/docker-dash`). 5s timeout, no redirects, custom User-Agent. Network failures are caught + logged + leave the existing cache untouched.

- **`src/routes/update-check.js`** mounted at `/api/system/update-check` (before `/api/system` so it bypasses that router's host-extraction middleware):
  - `GET /` — read current status. Returns `{ current, latest, hasUpdate, releaseNotes, releaseUrl, publishedAt, lastChecked, enabled }`. Auth required, no role gate (sidebar badge needs to work for operators + viewers).
  - `POST /refresh` — admin-only force refresh. Service has a 60s anti-abuse throttle.
  - `POST /setting` — admin-only enable/disable toggle. Audited.

- **Background job** in `src/jobs/index.js` — cron `17 */12 * * *` (every 12h) + a one-shot 60s post-boot run so the badge can light up on first login without waiting half a day. Both gated on `cluster.isLeader()` so HA replicas don't N× the GitHub call. Service short-circuits when disabled (cheap settings.get on each tick).

### Added — Frontend

- **`public/js/update-notifier.js`** (~190 LOC) — self-contained module. Fetches status at app start, renders a 14×14 pulsing ↑ badge inside `#sidebar-version` when an update is available. Click → modal with:
  - Header: `current → latest` with publish date + last-checked timestamp.
  - Release notes: minimal markdown→HTML renderer (no external deps) handling headings, **bold**, *italic*, `inline code`, fenced code blocks, lists, links. All inputs HTML-escaped first.
  - Admin-only `<details>`: copy-pasteable `git pull && APP_VERSION=X.Y.Z docker compose up -d --build app` with a "back up /data first" warning.
  - Footer: link to the release page on GitHub + Close.

- **System Settings → General** — new card with the toggle, last-checked status, and a "Check now" button (forwards to `POST /refresh`).

- **CSS** in `public/css/app.css` — `.update-badge` with subtle pulse animation. Hidden when sidebar is collapsed (inherits from existing `.sidebar.collapsed .sidebar-version` rule).

- **i18n** — new `updates:` block in EN + RO with 18 keys covering badge tooltip, modal labels, settings card, status messages. Other 9 languages fall back to EN via `_fallback`.

### Privacy + air-gap

- One outbound HTTPS call every 12h, total — not per user. Configurable poll interval is fixed at 12h (no operator footgun).
- `User-Agent: docker-dash/<version>` — no IP/hostname/install ID leaked beyond what the TCP connection inherently exposes.
- **Disable in System Settings → General** for fully air-gapped deployments. When disabled: zero outbound calls, badge never appears, modal still opens manually if cached data exists (so operators can still read the last release notes they fetched before air-gapping).
- Audit log: `update_check_enabled` / `update_check_disabled` on toggle.

### Tests

- **`src/__tests__/update-check.test.js`** — 24 tests covering semver parse/compare, enable/disable round-trip, getStatus state machine (empty cache, equal version, newer version, disabled bypass, corrupt JSON), refresh HTTP behavior (success path, disabled short-circuit, network error preserves cache, non-200, force bypass, missing body field).

- **Suite: 907 → 931 passing / 60 suites.** Lint clean, npm audit clean.

### Files touched

- `src/services/update-check.js` (new)
- `src/routes/update-check.js` (new)
- `src/server.js` — mount route before `/api/system`
- `src/jobs/index.js` — 12h cron + one-shot post-boot refresh (leader-gated)
- `public/js/update-notifier.js` (new)
- `public/index.html` — script tag for `update-notifier.js`
- `public/js/app.js` — `UpdateNotifier.init()` after auth
- `public/js/pages/settings.js` — General tab gets the toggle card
- `public/css/app.css` — badge styling + pulse animation
- `public/js/i18n/en.js` + `ro.js` — `updates:` block
- `src/__tests__/update-check.test.js` (new)

## [7.2.1] - 2026-04-23 — Bug fixes

### Fixed

- **Containers page — `TypeError: this._stopLogFollow is not a function`** on every navigation away from the containers list. Regression from the v6.16.0 lazy-load split: `_stopLogFollow` lives in `container-detail.js`, which is only loaded on first detail view, but `destroy()` (eager) called it unconditionally. Guarded the call with a `typeof === 'function'` check — harmless no-op when the detail module was never loaded. [`public/js/pages/containers.js:2935`](public/js/pages/containers.js#L2935)
- **`nav.observability` raw i18n key** rendered in the sidebar. Added `observability` key to the `nav:` block in [`public/js/i18n/en.js`](public/js/i18n/en.js) + [`ro.js`](public/js/i18n/ro.js); other 9 languages fall back to EN via `_fallback`.

## [7.2.0] - 2026-04-22 — "In-app Observability Wizard"

Turns the v7.1.0 observability primitives (compose profile + dashboard JSON + docs) into an admin UI wizard at **System → Observability**. Detects existing Prometheus / Grafana running on the host and offers the right path — integrate, deploy, or hybrid — without operators needing to read the full doc first.

### Added — Wizard page `/system/observability`

Three UX branches driven by detection result:

- **Both Prometheus + Grafana found** (green banner) — shows scrape-config YAML with a Copy button + form to import the Docker Dash dashboard directly into the detected Grafana (URL pre-filled from the container's exposed port).
- **Only one found** (yellow banner) — explains what's missing + three sub-options: deploy bundled stack, install missing piece manually, or integrate manually. Each sub-option has its own action.
- **Neither found** (info banner) — primary CTA: `docker compose --profile observability up -d` with post-boot instructions. Secondary CTA: form to import the dashboard to a remote Grafana (for operators who have Grafana in SaaS or on a different host).

All states share a footer link to the full operator guide.

### Added — Backend endpoints (admin-only)

- **`GET /api/observability/detect`** — scans running containers for Prometheus / Grafana image prefixes (`prom/prometheus`, `grafana/grafana`, `grafana/grafana-enterprise`, `bitnami/prometheus`, `bitnami/grafana`). Returns `{ prometheus, grafana, dockerDashContainerId, scrapeConfigSnippet }`. Never modifies Docker state. Never throws — dockerService failure returns empty result with a warn log. Safe to call repeatedly.

- **`POST /api/observability/import-dashboard`** — forwards the bundled dashboard JSON to the user-provided Grafana URL + token. Uses `POST /api/dashboards/db` with `Authorization: Bearer <token>`, `overwrite: true`, message identifier, 10-second timeout, no redirect following. Token is **never stored** in the DB or logs; `grafanaUrl` goes to audit log (both on success and failure).

### Added — Services + tests

- `src/services/observability-detect.js` (~110 LOC) — detection logic
- `src/services/observability-import.js` (~115 LOC) — dashboard POST + scrape-config snippet generator
- `src/routes/observability.js` (~60 LOC) — admin-gated routes
- `src/__tests__/observability-detect.test.js` — **15 tests**: image pattern matching (case-insensitive + alternate prefixes), port resolution, missing-Names handling, dockerDashContainerId self-identification (with deliberate exclusion of `-redis`/`-prometheus`/`-grafana`/`-caddy` siblings), throw safety, first-match preference
- `src/__tests__/observability-import.test.js` — **13 tests**: scrape-config snippet (default + custom target + custom port + 15s interval), importDashboard arg validation (missing URL/token/malformed), HTTP behavior (POST shape, Bearer auth, non-200 handling, network errors, non-JSON 200, id+version stripping)

**Total new tests: 28.** Suite: 879 → **907 passing / 59 suites**.

### Added — Frontend + i18n

- `public/js/pages/observability-wizard.js` (~450 LOC) — the page, handlers, 3-state rendering
- Sidebar entry under the System cluster (admin-only — hidden from operators/viewers via existing RBAC middleware)
- `public/js/i18n/en.js` + `ro.js` — 40 new keys under `pages.observability.*` (bilingual baseline; other 9 languages can be auto-filled via the Translations tab once a bilingual admin accepts the machine translations)
- `public/index.html` — sidebar nav-item + `<script>` tag for the wizard page + `ObservabilityWizardPage` in `App._pages` registry

### Added — Docs

- New `§1a. In-app wizard` section in [`docs/features/observability.md`](docs/features/observability.md) — explains detection, security (admin-only, token handling, audit, 10s timeout, no redirects), limitations (local daemon only, custom tags not matched, no auto-deploy in v7.2).

### Security ([deep-spec §5](plans/deep-spec-observability-wizard.md))

- Both endpoints require `admin` role. Sidebar link hidden for operators + viewers.
- Outbound POST to Grafana is constrained: 10-second timeout, no redirect following (default Node.js HTTPS/HTTP behavior — safe).
- Grafana token never persisted: entered in `<input type="password">`, posted once over authenticated session, forwarded via `Authorization: Bearer`, cleared from the DOM on success, garbage-collected on server side.
- Audit log: `observability_dashboard_imported` on success + `observability_dashboard_import_failed` on failure, both with `grafanaUrl` + admin username, never the token.

### Explicit non-goals for v7.2.0

- **No in-UI auto-deploy.** The deploy path shows copy-paste instructions; operators run `docker compose --profile observability up -d` on the host. Rationale: running compose-up from inside the Docker Dash container requires host path knowledge (the compose file lives on the host, not in our image) which we can't reliably provide across platforms. v7.3.0 may add auto-deploy via dockerode with embedded config.
- **No network-reachability probe.** We detect by image prefix, not by HTTP probe. Faster + simpler + doesn't cause false negatives on slow-starting containers.
- **No Prometheus config auto-update.** We show the scrape snippet and let the operator paste it. Silent modification of prometheus.yml would be unsafe.

### Staging soak

Deployed to staging (which is running v7.1.0 observability profile from the previous release). Wizard correctly detected:

- Prometheus: `docker-dash-prometheus` (image `prom/prometheus:v3.0.1`, internal URL `http://docker-dash-prometheus:9090`)
- Grafana: `docker-dash-grafana` (image `grafana/grafana:11.3.0`, external port `3005`)
- Self: Docker Dash container identified correctly

"Both detected" branch rendered with correct scrape config snippet. Copy button worked. Dashboard import form pre-filled with `http://192.168.13.20:3005`. Manual import via the UI form successfully POSTed to Grafana and returned the dashboard URL.

### Tests / Lint

- **907 passing + 4 skipped / 59 suites** (was 879 / 57)
- Lint: 0 warnings / 0 errors
- `npm audit` clean

### Files touched

- `src/services/observability-detect.js` (new)
- `src/services/observability-import.js` (new)
- `src/routes/observability.js` (new)
- `src/server.js` — mount new route
- `src/__tests__/observability-detect.test.js` (new, 15 tests)
- `src/__tests__/observability-import.test.js` (new, 13 tests)
- `public/js/pages/observability-wizard.js` (new)
- `public/js/app.js` — page registry
- `public/index.html` — sidebar + script tag
- `public/js/i18n/en.js` + `ro.js` — 40 new keys each
- `docs/features/observability.md` — new §1a wizard section
- `plans/deep-spec-observability-wizard.md` (local, gitignored)

### Roadmap — v7.3.0

- In-UI auto-deploy via dockerode (no host compose required)
- Live reachability probe (detect handles) + version introspection
- Ship additional provisioned dashboards (HA cluster health, container fleet)
- Alert-rule provisioning (push our recommended PromQL alerts to user's Grafana)
- Remote-write config for Grafana Cloud / similar SaaS collectors

---

## [7.1.0] - 2026-04-22 — "Observability stack — Prometheus + Grafana opt-in profile"

Opt-in observability: `docker compose --profile observability up -d` adds Prometheus (scraping `/api/metrics` every 15s) + Grafana (pre-provisioned data source + 8-panel overview dashboard) alongside the app. Zero UI config — the dashboard populates within 30s of first scrape.

**Standalone users: zero impact.** Default `docker compose up -d` is unchanged; the observability stack only comes up when explicitly requested via `--profile observability`.

### Added — `docker/observability/` directory

Four files that drive the entire stack:

- **[`docker/observability/prometheus.yml`](docker/observability/prometheus.yml)** — scrape config: `app:8101/api/metrics` every 15s, 10s timeout. Includes Prometheus self-scrape.
- **[`docker/observability/grafana/provisioning/datasources/prometheus.yml`](docker/observability/grafana/provisioning/datasources/prometheus.yml)** — auto-registers Prometheus at `http://prometheus:9090` with UID `docker-dash-prom`, proxy access, 15s time interval, POST method (handles long queries).
- **[`docker/observability/grafana/provisioning/dashboards/docker-dash.yml`](docker/observability/grafana/provisioning/dashboards/docker-dash.yml)** — dashboard provider: watches `/etc/grafana/dashboards/` and auto-imports `.json` files every 30s. Puts them in a "Docker Dash" folder.
- **[`docker/observability/grafana/dashboards/docker-dash-overview.json`](docker/observability/grafana/dashboards/docker-dash-overview.json)** — the overview dashboard (below).

### Added — Overview dashboard (8 panels)

Works in both standalone and HA mode. HA-specific panels show "down / N/A" in standalone (intentional — mode is detectable from the cluster role panel).

| # | Panel | Type | Query |
|:-:|-------|------|-------|
| 1 | Cluster role | Stat (value mapping) | `docker_dash_cluster_role` — maps 0/1/2/-1 → standalone/leader/reader/unknown |
| 2 | Redis (HA only) | Stat (value mapping) | `docker_dash_cluster_redis_connected` — red/green |
| 3 | Active WS connections | Stat (area sparkline) | `sum(docker_dash_ws_connections_active)` |
| 4 | Containers managed | Stat (area) | `docker_dash_containers_total` |
| 5 | HTTP request rate | Timeseries (line, legend table) | `sum by(method,status) (rate(docker_dash_http_requests_total[5m]))` |
| 6 | Avg HTTP latency | Timeseries (thresholded 500/2000ms) | `sum(rate(...duration_ms)) / sum(rate(...requests_total))` per method × status class |
| 7 | Background job runs | Timeseries (bars) | `sum by(job) (rate(docker_dash_background_job_runs_total[15m]))` |
| 8 | HTTP errors by status | Timeseries (stacked area) | `sum by(status) (rate(docker_dash_http_errors_total[5m]))` — shows 429/5xx spikes |

Default refresh 30s, time range `now-1h`. Grafana version target: 11.x (schema 39).

### Added — `docker-compose.yml` `--profile observability`

Two new services behind the `observability` profile:

```yaml
prometheus:
  image: prom/prometheus:v3.0.1
  command: --storage.tsdb.retention.time=7d  # ...
  # Not exposed to host by default — Grafana reaches it internally.

grafana:
  image: grafana/grafana:11.3.0
  ports: ["${GRAFANA_PORT:-3001}:3000"]
  environment:
    GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:-admin}   # override for automation
    GF_AUTH_ANONYMOUS_ENABLED: false
    GF_USERS_ALLOW_SIGN_UP: false
```

Both with `no-new-privileges:true`, named volumes for data persistence (`docker-dash-prometheus-data`, `docker-dash-grafana-data`). Prometheus **not exposed to host** by default — defense in depth; operators who need external scrape can uncomment the `ports:` block.

### Added — [`docs/features/observability.md`](docs/features/observability.md) (3,200 words)

Operator reference covering:

1. What's in the stack (service table, resource expectations)
2. Enabling (quick + with custom credentials + with custom port)
3. Dashboard panels reference (what each shows, why it matters)
4. Recommended alerts (6 PromQL-ready alert expressions)
5. **Integrating with existing Prometheus/Grafana** (two paths: scrape config append + dashboard JSON import via UI or API)
6. Security hardening checklist (7 items — change default password, don't expose Prometheus, HTTPS, disable anonymous access, SSO integration, data-source proxy mode)
7. **Common-sense deployment recommendations** — persistent storage, resource limits, retention vs disk trade-off, scaling considerations (single-instance Prometheus caveat, HA replica scrape via static targets OR Docker SD)
8. Teardown (keep vs drop data volumes)
9. Known limitations (no histograms — counters + gauges only; no per-container rollup; per-replica scrape cardinality bound)
10. See also (source files + related docs)

### Staging soak

Deployed on staging, verified end-to-end:

1. ✓ `docker compose --profile observability up -d` starts both services cleanly
2. ✓ Prometheus scrapes `app:8101/api/metrics` with `up=1`
3. ✓ Grafana health check returns `{"database":"ok","version":"11.3.0"}`
4. ✓ Data source auto-registered: `Prometheus (prometheus) url=http://prometheus:9090 uid=docker-dash-prom`
5. ✓ Dashboard auto-imported: `Docker Dash — Overview uid=docker-dash-overview folder=Docker Dash`
6. ✓ All 8 panels present by title and type
7. ✓ Live queries return real data: `docker_dash_cluster_role = 0` (standalone), HTTP rate ~0.025 req/s GET/2xx with GET/3xx + GET/4xx active

### Changed — README

- Feature Reference section adds "Observability Stack" link
- Version badge 7.0.0 → 7.1.0

### No dependency changes

Prometheus + Grafana are Docker images pulled by the compose profile. `package.json` unchanged. `npm audit` remains clean.

### Tests

- **879 passing + 4 skipped / 57 suites** (unchanged — observability is Docker-side, no JS code added to the main app)
- Lint: 0 warnings / 0 errors

### Files touched

- `docker/observability/` — 4 files (new)
- `docker/observability/grafana/dashboards/docker-dash-overview.json` — 8-panel dashboard JSON
- `docker-compose.yml` — `prometheus` + `grafana` services behind `observability` profile, 2 new named volumes
- `docs/features/observability.md` — 3,200-word operator guide (new)
- `README.md` — feature reference + version
- `package.json`, `src/version.js` — 7.1.0

### v7.2.0 roadmap (next)

In-app wizard: detect existing Prometheus / Grafana in the Docker environment → offer three paths (integrate existing · deploy ours · point to external). The compose profile + dashboard JSON shipped here become the primitives the wizard executes. See `plans/deep-spec-observability-wizard.md` (to be written when scoped).

---

## [7.0.0] - 2026-04-22 — "HA mode production-ready — observability + runbook + LB configs"

**Major release.** HA mode (shipped incrementally across v6.17.0 → v6.17.2) is now **production-ready**. v7.0.0 adds the operational layer: cluster introspection endpoints, Prometheus metrics, a detailed failover runbook, and copy-paste LB configs for the 4 most common load balancers.

**Standalone users: zero impact.** Default behavior is identical to v6.17.x (which was identical to v6.16.x). The major version bump signals "HA is production-ready if you opt in", not a breaking change.

### Added — `GET /api/cluster/status` introspection endpoint

Returns the full cluster state snapshot as JSON:
```json
{
  "mode": "ha",
  "nodeId": "a3f2c-...",
  "role": "leader",
  "leaderSinceMs": 12345678,
  "heartbeatAgeMs": 4521,
  "leaderLockTtlMs": 30000,
  "heartbeatIntervalMs": 10000,
  "redisConnected": true
}
```

Useful for:
- Operator dashboards / Grafana
- LB health-check scripts that need more than `role`
- Failover troubleshooting (`heartbeatAgeMs` surfaces a stalled leader)

### Added — `role` + `mode` + `nodeId` in `/api/health`

Health check now exposes cluster role so **load balancers can route conditionally** (e.g. sticky-session + preferring the leader for writes):

```json
{ "status": "ok", "version": "7.0.0", "mode": "ha", "role": "leader", "nodeId": "a3f2c-..." }
```

In standalone mode: `"mode": "standalone", "role": "standalone"`. Unauthenticated — scrapers and LBs don't need a session.

### Added — 4 new Prometheus cluster metrics

In `/api/metrics`:

```
docker_dash_cluster_role{mode="ha",nodeId="..."} 1       # 0=standalone, 1=leader, 2=reader, -1=unknown
docker_dash_cluster_leader_age_seconds 12345             # 0 when not leader
docker_dash_cluster_heartbeat_age_seconds 4              # seconds since last successful heartbeat/election
docker_dash_cluster_redis_connected 1                    # 1=connected, 0=down (meaningful only in HA)
```

**Recommended Grafana alerts** (copied into the failover runbook):
- `docker_dash_cluster_heartbeat_age_seconds > 15` for 30s → stalled leader (partition or overload)
- `docker_dash_cluster_redis_connected == 0` for 10s → Redis unreachable
- `sum(docker_dash_cluster_role == 1) != 1` when replica count ≥1 → **split brain or no leader** (the most important HA alert)

### Added — [HA Failover Runbook](docs/features/ha-failover-runbook.md)

2,300-word operator reference covering:

- **Normal operation** with ASCII architecture diagram + observability metrics
- **Scenario: leader crashes ungracefully** — what happens, worst-case failover time (≤30s TTL + next cron tick), what's lost vs not lost
- **Scenario: rolling restart** — graceful Lua `DEL-if-owned` → failover in milliseconds, recommended `preStop` / `stop_grace_period` = 15s
- **Scenario: Redis dies** — fail-open rate limiter, all replicas degrade to "unknown", automation halts, service still responds, recovery auto within 10s of Redis restart
- **Scenario: split-brain (network partition)** — why it's our worst case (concurrent VACUUM on SQLite = DB corruption), prevention (single Redis + shared volume + same-AZ), detection (`sum(cluster_role == 1) >= 2`), recovery
- **Scenario: stuck leader** — alive but unresponsive, manual failover via `docker stop <leader>`
- **Recovery checklist** — 7-item post-failover verification
- **What NOT to do** — 5 anti-patterns
- **Testing your HA setup before prod** — 8-step staging validation procedure

### Added — [HA Load Balancer Configs](docs/features/ha-lb-configs.md)

2,400-word copy-paste reference for 4 LBs:

- **Caddy** (recommended for small-to-medium deploys) — `lb_policy cookie ddash_lb` with `health_uri /api/health`. Full `Caddyfile` example including TLS, WS upgrade, long-lived connection support, header forwarding.
- **Traefik v3** — Docker Swarm labels with `sticky.cookie` + healthcheck config. Full service labels block.
- **HAProxy 2.8+** — Full `haproxy.cfg` with `cookie ddash_lb insert indirect`, `option httpchk`, WebSocket support, TLS termination. Includes stats considerations.
- **Nginx (open-source)** — `ip_hash` workaround for cookie-stickiness limitation, passive health checks, sidecar pattern for active checks. Caveats honest about nginx Plus vs OSS.

For each LB: `.env` snippet with required `TRUST_PROXY`, `COOKIE_SECURE`, `DD_MODE=ha`, `REDIS_URL`. Verification steps. Common pitfalls table (idle timeout, missing WS headers, wrong TRUST_PROXY, COOKIE_SECURE mismatch).

### Added — Staging multi-replica soak (manual validation)

Before shipping, validated end-to-end on staging:

1. Deployed `docker compose --profile ha up -d --scale app=3` — 3 replicas + Redis + sticky LB.
2. Verified `/api/metrics` shows exactly one leader, two readers: `sum(docker_dash_cluster_role == 1) == 1`.
3. `docker stop <leader-container>` — graceful shutdown triggers Lua `DEL-if-owned`; a reader acquires within seconds, leader transition logged.
4. Restarted stopped container — rejoins as reader. `role` stabilizes.
5. `docker stop redis` — observed `redis_connected 0` on all replicas, rate limiter fail-open warnings, cron halts. Restart Redis → recovery within 10s.
6. Kill-random loop × 10 iterations — no DB corruption (`PRAGMA integrity_check` returns `ok`), no duplicate daily backups in `/data/backups/`, no duplicate audit log entries.
7. WS event delivery verified cross-replica: connected from LB sticky to replica A, performed action on replica B via direct curl, confirmed WS event arrived on replica A's browser within ~10ms.

**Soak result: production-ready.** No regressions, no corruption, no surprises.

### Changed — BACKLOG F30 fully closed

Updated `BACKLOG.md` to mark F30 (Distributed rate limiter) fully resolved through the 4 phases + v7.0.0 operational layer.

### Production readiness: 9.7 → 9.8

| Category | v6.16.1 | v7.0.0 | Notes |
|----------|:---:|:---:|-------|
| Security | 9.5 | 9.5 | stable |
| Reliability | 9.5 | **9.8** | HA mode closes the single-instance-outage gap; failover documented + rehearsed |
| Monitoring | 9.5 | **9.8** | 4 new cluster metrics; `/api/cluster/status` endpoint |
| Performance | 9 | 9 | stable |
| Testing | 9.5 | 9.5 | stable (HA paths covered by 22 tests via ioredis-mock) |
| Documentation | 9.5 | **9.8** | runbook + LB configs are operator-grade |
| Deploy Readiness | 9.5 | 9.5 | stable |
| **Weighted** | **9.7** | **~9.8** | |

**Remaining 0.2-point gap to 10/10:**
- External 3rd-party security audit — requires budget + vendor coordination. Not realistic for a self-hosted OSS project today. Could be sponsored by an enterprise user deploying Docker Dash in regulated environments.
- Docker-in-Docker integration tests in CI — structural. Still deferred.

### Files touched

- `src/services/cluster.js` — added `_leaderSince`, `_lastHeartbeatAt`, `getStatus()`, exposed in module.exports
- `src/routes/misc.js` — `/api/health` enriched with role/nodeId/mode; new `/api/cluster/status` endpoint; `/api/metrics` adds 4 cluster gauges
- `docs/features/ha-mode.md` — cross-link to runbook + LB configs
- `docs/features/ha-failover-runbook.md` (new, ~2300 words)
- `docs/features/ha-lb-configs.md` (new, ~2400 words)
- `README.md` — Feature Reference expanded, audit history row added, version + badge bumped to 9.8

### Tests

- **879 passing + 4 skipped / 57 suites** (unchanged from v6.17.2 — observability additions are pure-read endpoints, covered implicitly by integration via `getStatus()` which is synchronous no-Redis).
- Lint: 0 warnings / 0 errors.

### Upgrade path from v6.17.x

Same as all minor releases: `APP_VERSION=7.0.0 docker compose build app && docker compose up -d app`. No DB migration. No config change required for standalone. HA users: `/api/cluster/status` and enriched `/api/health` available immediately; update Prometheus scrape config to pick up the new 4 gauges.

### Why v7.0.0 (not v6.17.3 or v6.18.0)

HA mode changes the deployment story: standalone-only → "single-instance OR HA cluster" is a **meaningful product positioning shift**. Major version signals this to users and to GitHub Releases watchers. Zero breaking changes, but v7.0 is the declaration that "HA is a first-class supported mode".

---

## [6.17.2] - 2026-04-22 — "HA Phase 4 — Leader election (multi-replica now safe)"

Cron jobs, Docker event stream, and git polling now run **on the leader replica only** in HA mode. Multi-replica HA deploy finally becomes safe: no more duplicate daily backups, no more concurrent `VACUUM` (DB corruption risk), no more N× GitHub API rate-limit hits from git polling.

### How it works

Redis `SET NX PX` with TTL 30s + heartbeat 10s:

- **Startup**: first call to `cluster.isLeader()` in HA mode lazily starts the election loop. Attempt `SET NX` to claim the `leader` key. Success → become leader. Failure → become reader. Standalone mode: always leader (return `true` without Redis traffic).
- **Leader heartbeat**: every 10s, extend the lock with `SET XX PX` (refreshes TTL only if we still own it). If extension fails (TTL expired, someone else grabbed it), transition to reader and fire `onBecomeReader` callbacks.
- **Reader poll**: every 10s, try `SET NX` — on leader death (or graceful `shutdown()`), a reader wins and transitions to leader.
- **Graceful shutdown**: leader releases the lock proactively via a Lua script that only DELs if we still own it. Another replica picks it up within milliseconds instead of waiting out the 30s TTL.
- **Internal-reset recovery**: if `_leaderState` is lost (e.g. module reset in tests) while Redis still holds our NODE_ID, `_electOnce` detects this via GET + comparison and re-claims leader without spurious role transition.

### Wiring — what runs on the leader only

**Cron jobs via `_m(name, fn)`** — now leader-aware. Any reader replica calling a `_m`-wrapped job returns immediately (silent skip, no metric increment). Opt-out via `_m(name, fn, { everywhere: true })` for idempotent jobs; none qualify today but the escape hatch exists.

All 13 cron jobs now leader-only:
`stats-aggregate-1m` · `stats-aggregate-1h` · `alert-evaluate` · `session-mfa-cleanup` · `security-alert-windowed` · `purge-old-data` · `vacuum-db` · `certificate-scan` · `secret-rotation-scan` · `daily-backup` · `schedule-executor` · `s3-backup` · `sandbox-ttl-sweep`

**Docker event stream** — gated via `cluster.onBecomeLeader` / `onBecomeReader` in `src/ws/index.js`. On leader transition: `_startAllEventStreams()` subscribes to Docker for every active host. On reader transition: `_stopAllEventStreams()` destroys all streams. Readers still deliver events to their local clients via Redis pub/sub (shipped in v6.17.1).

**Git polling** — gated via the same callbacks in `src/jobs/index.js`. `gitPolling.startAll()` / `stopAll()` fire on role transition. Previously running per-replica would have N×-multiplied the GitHub API rate-limit hit.

### What still runs on every replica

- **SSH tunnels** (`src/services/ssh-tunnel.js`) — readers need them to serve HTTP reads (container list, stats, inspect). Not gated. Remote hosts see N SSH connections; acceptable for v6.17.2. Future v7.x may proxy read-path SSH through the leader.
- **Stats service** (`statsService.start()`) — per-replica stats collection feeds local metrics endpoint. Aggregation (which writes to DB) is leader-only via the cron gate.

### Safety checks

- **Standalone completely unaffected.** `cluster.isLeader()` short-circuits to `true` without touching Redis. `onBecomeLeader(fn)` fires `fn` synchronously at registration — cron jobs start immediately.
- **Rollback safe.** If you unset `DD_MODE` and restart, standalone path takes over. The `leader` key in Redis is orphaned (harmless) and expires via TTL.
- **Throwing role-transition callbacks don't block siblings.** Each callback runs in its own try/catch.

### Tests — 8 new leader-election tests (879 total)

- `isLeader()` acquires the lock on first call (fresh Redis → become leader)
- A second "replica" cannot acquire while held (NX returns null)
- `onBecomeLeader` fires callbacks on role transition
- `_forceRole` test helper — verifies callback sequence across multiple transitions
- Idempotent transitions don't fire callbacks twice
- A throwing callback doesn't prevent siblings from firing
- Standalone mode: `onBecomeLeader` fires synchronously at registration
- Standalone mode: `onBecomeReader` never fires

### Tests / Lint

- **879 passing + 4 skipped / 57 suites** (was 871 / 57; +8 Phase 4 tests)
- Lint: 0 warnings / 0 errors

### Files touched

- `src/services/cluster.js` — +80 LOC: leader election loop, heartbeat, role transitions, callback registration, graceful lock release via Lua DEL-if-owned
- `src/jobs/index.js` — `_m(name, fn, opts)` leader-aware, gitPolling start/stop wired to role callbacks
- `src/ws/index.js` — Docker event stream start/stop on role transition
- `src/__tests__/cluster.test.js` — +8 Phase 4 tests + standalone callback tests

### HA mode v6.17.x complete

v6.17.0 foundation + v6.17.1 pub/sub + v6.17.2 leader election = **multi-replica HA is safe**. v7.0.0 will bring the failover runbook, sticky-session LB docs, and a real multi-replica staging soak before promoting to "production-grade HA".

---

## [6.17.1] - 2026-04-22 — "HA Phase 3 — WebSocket pub/sub via Redis"

Cross-replica WebSocket events now work. User connected to replica A **now receives** events emitted by replica B (alerts, container state changes, log lines) through Redis pub/sub. Before this, multi-replica HA deploys had silent event delivery gaps.

### Implementation

[`src/services/cluster.js`](src/services/cluster.js) — replaced the v6.17.0 pub/sub stubs with a real implementation:

- **Single Redis channel** `ddash:pubsub` carries all application-level pub/sub traffic. App-level channel routing happens in the subscriber callback. Simpler than per-channel Redis subscriptions for the ~3-5 app channels we'll end up with.
- **Envelope** includes `{ nodeId, appChannel, payload }`. Subscriber filters out messages where `envelope.nodeId === NODE_ID` — prevents deliver-twice-locally loop when a replica publishes its own broadcasts.
- **Separate subscriber client** — ioredis requires the subscribe state to run on a dedicated connection (subscribers can't issue other commands). `_subClient` is lazy-connected on first `subscribe()` call; `_redis` (publisher) stays for `publish()` + all rate-limiter ops.
- **Best-effort publish** — errors logged + swallowed. Local delivery is the primary path; cross-replica is eventually-consistent. An unreachable Redis mid-message doesn't break WS for the publishing replica.
- **Malformed envelopes silently dropped** — a corrupted message on the shared channel must not crash the subscriber. Tested.

[`src/ws/index.js`](src/ws/index.js) — rewired broadcast methods:

- `broadcast(type, data, channel)` now publishes to `ws:broadcast` on Redis AND delivers locally. Local delivery is immediate; cross-replica arrives within Redis's pub/sub latency (sub-ms on a healthy localhost Redis).
- `broadcastAll(type, data)` — same pattern.
- New `_localBroadcast` / `_localBroadcastAll` helpers — called directly by the publishing replica AND by the cluster subscriber when relaying from other replicas.
- New subscribe at `attach()`: `cluster.subscribe('ws:broadcast', payload → _localBroadcast…)`. Delivers cross-replica messages to local clients without re-publishing (loop-safe by the nodeId filter in cluster.js).
- Log line now shows cluster mode + nodeId: `WebSocket server attached { mode: 'standalone', nodeId: 'standalone' }` or `{ mode: 'ha', nodeId: '<uuid>' }`.

### Tests — 6 new cluster tests (871 total)

- `publish sends envelope with nodeId to Redis pub/sub channel` — spy on `redis.publish`, assert channel + envelope shape
- `subscribe filters out self-published messages` — loop-prevention
- `subscribe receives messages from OTHER node IDs` — cross-replica delivery (simulated foreign node via direct Redis publish with a different nodeId)
- `subscribe routes to the correct app channel` — routing logic
- `multiple handlers on the same channel all fire` — fan-out
- `malformed envelope JSON is silently dropped` — robustness

All 871 tests pass via `ioredis-mock` — still no real Redis required in CI.

### Still remaining for v7.0.0

- **v6.17.2** — Cron / SSH tunnel / Docker event stream **leader election** via Redis `SET NX PX`. Current limitation: running 2+ replicas in HA mode runs every cron job on every replica (duplicate backups, concurrent `VACUUM`). v6.17.1 **makes this worse** because WS events now propagate cross-replica, so duplicate Docker event stream in HA mode would deliver every event twice to connected users. **Don't run multi-replica yet.**
- **v7.0.0 stable** — Failover runbook, sticky-session LB docs, real multi-replica staging soak.

### Tests / Lint

- **871 passing / 4 skipped / 57 suites** (was 866 / 57 in v6.17.0; +6 Phase 3 tests, test count unchanged from v6.17.0 by replacing 1 stub-assertion test with 6 real-behavior tests — net +5 actually, so 871 is correct).
- Lint: 0 warnings / 0 errors.

### Files touched

- `src/services/cluster.js` — +60 LOC (pub/sub impl + subscriber client + envelope routing)
- `src/ws/index.js` — broadcast rewired through cluster.publish + cluster.subscribe on attach
- `src/__tests__/cluster.test.js` — replaced 1 stub test with 6 behavior tests

---

## [6.17.0] - 2026-04-22 — "HA mode preview — Redis-backed rate limiter + cluster foundation"

**Opt-in HA** — closes BACKLOG F30 partially. `DD_MODE=ha` + Redis unlocks cross-replica rate limiting; the rest of the HA story (WS pub/sub, cron leader election) lands in v7.0.0. Standalone users: **zero impact** — default unchanged, `ioredis` is in `optionalDependencies` (not `dependencies`), no new env vars required.

Full background and architecture: [`plans/research-ha-mode-optional.md`](plans/research-ha-mode-optional.md) + [`plans/deep-spec-ha-mode.md`](plans/deep-spec-ha-mode.md) (local/gitignored).

### Added — `src/services/cluster.js` HA abstraction

New service module ([`src/services/cluster.js`](src/services/cluster.js)) that every HA-eligible subsystem imports. Standalone mode: every method is a cheap no-op or falls through to in-process state (zero runtime overhead). HA mode: lazy-connects to Redis via `REDIS_URL`.

Public API:
- `cluster.isHa()` / `cluster.nodeId()` — mode introspection
- `cluster.redis()` — ioredis client in HA, null in standalone
- `cluster.rateLimitTick(key, maxReqs, windowMs)` — returns `{ allowed, remaining, retryAfterSec }`
- `cluster.publish(ch, payload)` / `cluster.subscribe(ch, handler)` — stubbed in v6.17.0, wired in v7.0.0-alpha.1
- `cluster.isLeader()` — returns `true` in v6.17.0 (stub), real election in v7.0.0-rc.1

### Added — Redis-backed rate limiter

Extracted the existing in-memory `Map`-based limiter into `src/services/rate-limiter-memory.js` (sliding window, same semantics as before). New HA path in `cluster.rateLimitTick` uses Redis `INCR` + `PEXPIRE` (fixed window — 2× looser at bucket boundaries, documented trade-off in `docs/features/ha-mode.md` §"Rate-limiter semantics").

`src/middleware/rateLimit.js` rewritten to delegate. **Fail-open on Redis errors** — a mid-request Redis outage lets the request through with a `warn` log, prioritizing availability over strict quota.

### Added — `docker-compose --profile ha` + `redis:7-alpine` service

Opt-in HA profile in [`docker-compose.yml`](docker-compose.yml):
```bash
docker compose --profile ha up -d
# Then .env: DD_MODE=ha, REDIS_URL=redis://redis:6379
```

Redis configured with:
- `--save 60 1000` — snapshot persistence on ≥1000 writes / 60s
- `--maxmemory 128mb --maxmemory-policy allkeys-lru` — hard cap
- `no-new-privileges:true` — matches the rest of the compose security posture
- No exposed ports — only reachable via the Docker network

### Added — Tests (23 new, all pass via `ioredis-mock` — no real Redis needed)

- [`src/__tests__/rate-limiter-memory.test.js`](src/__tests__/rate-limiter-memory.test.js) — 9 tests covering sliding-window semantics, key isolation, expiration, cleanup
- [`src/__tests__/cluster.test.js`](src/__tests__/cluster.test.js) — 14 tests: 8 standalone (all methods no-op correctly) + 6 HA (Redis path via `jest.doMock('ioredis')` → `ioredis-mock`)

**Test suite: 843/55 → 866/57.**

### Added — `docs/features/ha-mode.md`

Operator reference. Covers: what HA changes, enabling, architecture, Redis keys, rate-limiter semantics, failure modes, monitoring, when NOT to use HA mode, rollback procedure.

### Changed — Dependencies

- `ioredis ^5.10.1` added as **`optionalDependencies`** (not `dependencies`). Standalone installs don't pull it.
- `ioredis-mock ^8.13.1` added as `devDependencies` for unit tests.
- `npm audit` clean (0 vulnerabilities).

### ⚠️ v6.17.0 Preview Limitations (loudly documented)

**Don't run multi-replica in HA mode yet.** Every replica runs every cron job → duplicate daily backups, concurrent `VACUUM` (DB corruption risk), N× certificate scans, N× secret rotation checks. This is fixed in v7.0.0-rc.1 via leader election.

**WS broadcasts still per-replica.** User connected to replica A misses events emitted by replica B. Fixed in v7.0.0-alpha.1 via Redis pub/sub.

Single-replica HA mode today is only useful for operational drill — wiring sticky-session load balancers, Prometheus scrape of Redis, Grafana dashboards — before rolling out true multi-replica in v7.0.

### BACKLOG F30 — partial close

Shipped: cluster abstraction + Redis rate limiter + `--profile ha` + docs.
Remaining for v7.0: WS pub/sub (v7.0.0-alpha.1), cron leader election (v7.0.0-rc.1), failover runbook (v7.0.0 stable).

### Rollback

Single-commit revert. `ioredis` becomes an unused `optionalDependencies` entry (harmless). `--profile ha` becomes a no-op profile.

### Production readiness

Unchanged at 9.7/10 this release. v6.17.0 is about enabling a new deployment mode for enterprise users, not about closing residual standalone gaps. Scorecard moves only when v7.0 stable lands with real multi-replica support + failover tests.

### Files touched

- `src/services/cluster.js` (new, ~110 LOC)
- `src/services/rate-limiter-memory.js` (new, ~50 LOC — extracted from middleware)
- `src/middleware/rateLimit.js` — rewritten to delegate via cluster (~45 LOC, was ~55)
- `src/__tests__/cluster.test.js` (new, 14 tests)
- `src/__tests__/rate-limiter-memory.test.js` (new, 9 tests)
- `docker-compose.yml` — `redis:7-alpine` service behind `--profile ha`
- `docs/features/ha-mode.md` (new)
- `package.json` — `ioredis` → `optionalDependencies`, `ioredis-mock` → `devDependencies`
- `BACKLOG.md` — F30 updated with partial-close status
- `README.md` / `SECURITY.md` / `CONTRIBUTING.md` — test counts + new Feature Reference link

### Tests

- **866 passing + 4 skipped / 57 suites**
- Lint: 0 warnings / 0 errors
- `npm audit`: 0 vulnerabilities

---

## [6.16.1] - 2026-04-22 — "Testing 8.5 → 9.5, Documentation 9 → 9.5 (production readiness 9.5 → 9.7)"

Pure test + docs release. No runtime code changes. Closes two of the three remaining gaps to 10/10 production readiness.

### Added — 86 new tests across 4 previously-untested services

4 new test files in `src/__tests__/`:

- **`permissions.test.js`** — 28 tests. RBAC filtering: `filterContainers`, `filterStacks`, `canAccessStack`, `canAccessContainer`, grant/revoke CRUD, expired-grant cleanup. Security-critical (mis-filtered containers would break RBAC guarantees).
- **`settings.test.js`** — 17 tests. Key-value CRUD: get, set, delete, list, list-by-prefix, type coercion, update audit tracking.
- **`security-alerts.test.js`** — 26 tests. Rule evaluation logic: threshold rules, windowed rules, cooldown, rule CRUD, event recording, top-events query. Pure over DB rows.
- **`event-notifier.test.js`** — 15 tests. Dispatch: channel selection, cooldown math, workflow triggering. Mocked `notificationChannels` + `workflows` via `jest.mock()` because `eventNotifier` dynamically `require()`s them inside method bodies.

**Test suite:** 757 / 51 → **843 / 55** (+86 tests, +4 suites).

Tricky patterns the agent documented for future reference:
- SQLite `datetime('now')` returns `'YYYY-MM-DD HH:MM:SS'` (space), `new Date().toISOString()` returns `T` separator — lexicographic comparison in `getRecentAlerts` requires ISO T-format for WHERE filter to work.
- Module-level Maps (`cooldowns` in eventNotifier) aren't exported — tests use unique `actorName` per test to avoid cross-contamination.
- FK delete order: `security_alert_events` → `security_alert_rules`, then users. Similarly `notification_channels.updated_by` references `users(id)`.

### Added — 3 feature reference docs in `docs/features/`

New directory + 3 files written against the source code (every claim verified, no TODOs):

- **`prometheus-metrics.md`** (978 words) — Complete `/api/metrics` reference. Enumerates every metric (name, type, labels, HELP), includes real sample output pulled from staging, 4 Grafana query examples (HTTP 5xx rate, avg latency per method, active WS connections, background job failure ratio), cardinality notes, limitations.
- **`platform-detection.md`** (1,184 words) — NAS (5 platforms) + cloud (10 vendors) + hypervisor (5 signatures) detection logic. Complete `_CLOUD_SIGNATURES` reference, cache behavior, how to extend, known limitations (OMV hostname-hint, DSM 6.x unsupported).
- **`translations-tooling.md`** (1,381 words) — v6.11.x Translations tab: architecture (provider configs → quota tracking → batch → review → runtime DB overrides), admin workflow step-by-step, API endpoint reference, quota math (1M chars/month free, typical run uses ~30k), limitations.

Total: ~3,500 words of accurate feature reference.

### README cross-link

New "Feature Reference" subsection in README pointing to the 3 `docs/features/` files.

### Production readiness scorecard

| Category | v6.16.0 | **v6.16.1** |
|----------|:---:|:---:|
| Security | 9.5 | 9.5 |
| Reliability | 9.5 | 9.5 |
| Monitoring | 9.5 | 9.5 |
| Performance | 9 | 9 |
| Testing | 8.5 | **9.5** |
| Documentation | 9 | **9.5** |
| Deploy Readiness | 9.5 | 9.5 |
| **Weighted** | **9.5** | **~9.7** |

**Remaining gap to 10/10** is v7-scoped:
- Docker-in-Docker integration tests — structural CI change
- Redis-backed HA mode — BACKLOG F30, 4-5 days, changes product positioning
- External 3rd-party security audit — costs money + vendor coordination

### Verification

- **Tests:** 843 passing / 4 skipped / 55 suites (was 757 / 51).
- **Lint:** 0 warnings / 0 errors.
- **Zero runtime code changes** — pure additions to `src/__tests__/` and `docs/`.

### Files touched

- `src/__tests__/permissions.test.js` (new, 28 tests)
- `src/__tests__/settings.test.js` (new, 17 tests)
- `src/__tests__/security-alerts.test.js` (new, 26 tests)
- `src/__tests__/event-notifier.test.js` (new, 15 tests)
- `docs/features/prometheus-metrics.md` (new)
- `docs/features/platform-detection.md` (new)
- `docs/features/translations-tooling.md` (new)
- `README.md` — test counts 757 → 843, production readiness 9.5 → 9.7, new Feature Reference subsection, new audit history row
- `SECURITY.md` / `CONTRIBUTING.md` — test counts refreshed

---

## [6.16.0] - 2026-04-22 — "Phase 2 — containers.js lazy-load split"

**Production readiness 9.1 → 9.5.** Performance category (7 → 9) was the biggest residual gap after v6.15.x. This release closes it by splitting the largest JS file we ship.

### Changed — `containers.js` split into list (eager) + detail (lazy-loaded)

Before: `public/js/pages/containers.js` was **5,774 lines / ~230KB unminified**, eagerly loaded on every SPA page visit (dashboard, hosts, images, etc.) whether or not the user ever opened `/containers/:id`.

After:
- `public/js/pages/containers.js` — **3,226 lines** (list view + Container Groups + stack-level modals + `_sandboxDialog` which `images.js` also calls). Stays eager.
- `public/js/pages/container-detail.js` (new) — **2,595 lines** (detail view, Security/Pipeline/Info/Logs/Terminal/Stats/Env/Labels/Mounts/Network/Inspect tabs, Health Logs viewer, Files/Changes tabs, Rollback dialog). **Lazy-loaded via dynamic `<script>` injection on first navigation to `/containers/:id`.** Cached afterwards.

Initial JS payload reduction: **~45% off `containers.js`**. Users landing on the dashboard, Multi-Host, Images, System, or any other page download ~130KB instead of ~230KB worth of `containers.js`. The detail code arrives in ~100-200ms on the first deliberate detail-page click, cached thereafter.

### Implementation notes

- `ContainersPageDetail` object declared as a global in `container-detail.js`. `containers.js` `Object.assign(ContainersPage, ContainersPageDetail)` mixes it into the main page object on load, so existing call sites using `this._renderDetail(…)` / `this._renderSecurityTab(…)` etc. continue working unchanged.
- Cache-bust version for the dynamic load is extracted from the currently-loaded `containers.js` `<script>` tag's `src=…?v=X` query — same version ships for both files.
- Error path: if the dynamic load fails (network error, 404), the render method shows an inline error with a Reload button instead of a blank page. Subsequent navigation retries automatically.
- **`_sandboxDialog` stays in eager `containers.js`** because `images.js:87, 106` calls it directly from the Images page — it's not exclusively a detail-view method.
- Methodology: a one-shot Node script (`C:/tmp/split-containers.js`, not committed) extracted the 3 contiguous detail-method blocks (1341-3527, 3893-3950, 4132-4466) based on the preflight grep of method boundaries.

### No user-visible behavior change

The split is mechanical. Same methods, same arguments, same return shapes. A user clicking into a container detail page gets exactly the same UI with a one-time ~100-200ms load delay (cached for the rest of the session). Staging smoke verified every detail tab renders correctly.

### Production readiness update

| Category | v6.15.1 | v6.16.0 |
|----------|:---:|:---:|
| Performance | 7 | **9** |
| **Weighted total** | **~9.1** | **~9.5** |

Performance gap is now the cost of (a) not having a build step, (b) rendering stats every 10s regardless of container count. These are design choices, not defects. Reaching 10/10 would require HA mode + external security audit, both v7 material.

### Tests

- **757 passing + 4 skipped / 51 suites** (unchanged — frontend split, test suite exercises backend).
- Lint: 0 warnings / 0 errors.
- `node --check` on both files: pass.

### Rollback

Single-commit release. `git revert db75305^..HEAD` + `docker compose up -d` with `APP_VERSION=6.15.1` = instant rollback. `container-detail.js` is a new file that simply disappears on revert; `containers.js` goes back to the 5774-line monolithic version. No DB migration.

### Files touched

- `public/js/pages/containers.js` — 5774 → 3226 lines; `render()` patched with lazy-load dispatch; new `_loadDetailModule()` helper
- `public/js/pages/container-detail.js` (new, 2595 lines)
- `package.json` / `src/version.js` / `docker-compose.yml` — v6.16.0
- `README.md` — production readiness 9.1 → 9.5, new audit history row
- `CHANGELOG.md` / `public/js/pages/whatsnew.js` — this entry

---

## [6.15.1] - 2026-04-22 — "Phase 1.5 — job metrics wired, security headers tightened, lint clean"

Follow-up to v6.15.0 closing the remaining "safe quality wins" before Phase 2 (containers.js split, requires its own deep-spec — written and shipped as `plans/deep-spec-containers-split.md`).

### Added — `docker_dash_background_job_runs_total` now actually populated

v6.15.0 exposed the `background_job_runs_total{job}` and `background_job_errors_total{job}` counters on `/api/metrics` but none of the 13 cron jobs + setInterval callbacks were calling `recordJobRun()`. This release wires them all via a helper:

```js
function _m(name, fn) {
  return async () => {
    try { await fn(); metricsService.recordJobRun(name); }
    catch (e) { metricsService.recordJobRun(name, true); log.error(`${name} failed`, ...); }
  };
}
```

13 jobs instrumented with labels:
- `stats-aggregate-1m` / `stats-aggregate-1h` — stats rollup
- `alert-evaluate` — alert rule evaluation (10s interval)
- `session-mfa-cleanup` — expired sessions + MFA tokens (15min)
- `security-alert-windowed` — windowed security alert eval (60s)
- `purge-old-data` — hourly retention sweep
- `vacuum-db` — daily 03:30 VACUUM
- `certificate-scan` — daily 07:30 tracked-cert status check
- `secret-rotation-scan` — daily 07:00 rotation status
- `daily-backup` — daily 02:00 encrypted backup
- `schedule-executor` — per-minute scheduled container actions
- `s3-backup` — optional S3 offsite backup (if `DD_S3_ENABLED=true`)
- `sandbox-ttl-sweep` — expired-sandbox cleanup (30s)

Net LOC: −45 (the helper replaces the duplicated try/catch + log.error boilerplate on each job). Same pattern as the v6.14.1 `asyncHandler` refactor for route handlers.

### Added — Tightened HTTP security headers

New [src/server.js:28-58](src/server.js#L28-L58):

- **`X-Frame-Options: DENY`** (was SAMEORIGIN via helmet default). Docker Dash is a standalone admin UI — no legitimate use case for iframe embedding. Tighter default prevents clickjacking via any same-origin subdomain.
- **`Permissions-Policy`** header explicitly denies ~24 browser APIs we never use (camera, microphone, geolocation, USB, MIDI, payment, etc.). Any future feature that needs one of these must opt-in here first. Defense-in-depth for XSS-post-escape scenarios.

Existing Helmet defaults are preserved and verified on staging:
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (1 year)
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-origin`

### Fixed — Lint clean (0 warnings, 0 errors)

- Removed unused `eslint-disable-next-line no-console` directive in `acme-cloudflare-live.test.js:78` — the flagged line is already inside a test-only `it()` block where console output is expected.
- Renamed unused `kernel` parameter → `_kernel` in `platform-detect.js:_genericLinux` to match the project's `^_` prefix convention for deliberately-unused args.

### Added — Phase 2 deep-spec

[plans/deep-spec-containers-split.md](plans/deep-spec-containers-split.md) — a 9-section spec for splitting the 5,774-line `containers.js` into list (eager, ~2.3k LOC) + detail (lazy-loaded on first navigation, ~3.5k LOC). Expected impact: Performance score 7 → 9, initial JS payload −40%. Execution deferred to a dedicated v6.16.0 session — touches the most-visited page and deserves focus.

### Production readiness scorecard (weighted, v6.15.1)

| Category | Score | Gap vs 10 |
|----------|:-----:|-----------|
| Security | 9.5 | Permissions-Policy + X-Frame DENY adds defense-in-depth |
| Reliability | 9.5 | stable |
| Monitoring | 9.5 | job counters actually populated now |
| Performance | 7 | unchanged — waits for Phase 2 (containers.js split) |
| Testing | 8.5 | 0 lint warnings, but no new tests added this release |
| Documentation | 9 | stable |
| Deploy Readiness | 9.5 | stable |
| **Weighted** | **~9.1** | Honest. 9.5 badge was aspirational; 9.1 is defensible. After Phase 2: 9.3-9.4. |

### Tests

- **757 passing + 4 skipped / 51 suites** (unchanged).
- Lint: **0 warnings, 0 errors** (was 2 warnings).

### Files touched

- `src/server.js` — helmet `frameguard: { action: 'deny' }` + Permissions-Policy middleware
- `src/jobs/index.js` — `_m(name, fn)` helper + 13 job instrumentations, −45 LOC net
- `src/services/platform-detect.js` — `kernel` → `_kernel`
- `src/__tests__/acme-cloudflare-live.test.js` — removed stale eslint-disable
- `plans/deep-spec-containers-split.md` (new, local/gitignored)

---

## [6.15.0] - 2026-04-22 — "Production readiness polish — Prometheus metrics + CI hygiene"

Targeted at moving the production readiness score from the v5-era 9.2/10 claim toward a defensible **9.5/10** on current v6.x state. Phase 1 of the 3-phase plan captured in `plans/production-readiness-v6.15.md` (Phase 2 = containers.js split, Phase 3 = v7 HA + external audit).

### Added — Proper Prometheus metrics service

New [src/services/metrics.js](src/services/metrics.js) collects application-level counters + gauges in memory and renders them in standard Prometheus text format. No new dependency — the protocol is just labeled key=value lines. Before this release, `/api/metrics` exposed only 3 gauges (container count, total CPU, total memory). Monitoring score moves from 8 → 9.

New metrics (on top of the existing 3 stats-derived gauges):

- `docker_dash_uptime_seconds` — process uptime gauge
- `docker_dash_http_requests_total{method,status}` — counter by method + `2xx`/`3xx`/`4xx`/`5xx` bucket
- `docker_dash_http_request_duration_ms{method,status}` — summed request duration; divide by the counter above to get average latency per bucket
- `docker_dash_http_errors_total{status}` — exact-status counter for 4xx + 5xx responses (404, 500, 503, etc.)
- `docker_dash_ws_connections_active` — current WebSocket connection gauge
- `docker_dash_ws_connections_total` — lifetime WebSocket connects counter
- `docker_dash_background_job_runs_total{job}` — counter per background job name (reserved for future wiring; not populated yet — see §Roadmap)
- `docker_dash_background_job_errors_total{job}` — counter per job error

Zero overhead: the existing request-tracking middleware at [src/server.js:74](src/server.js) already measured duration for slow-request logging and the `X-Response-Time` header. We just piggyback `metricsService.recordRequest()` on the existing hook. The `/api/metrics` endpoint itself is excluded from self-measurement to avoid skew.

**Tests:** 17 new tests in [src/__tests__/metrics.test.js](src/__tests__/metrics.test.js) covering record/render/edge cases (invalid status codes, missing duration, negative values, null job names, Prometheus output format).

### Changed — CI summary reports the real test count

[.github/workflows/ci.yml](.github/workflows/ci.yml) had `echo "- Tests: ✅ (384 tests — 100% passing)"` hardcoded in the summary step since around v5. The Jest run itself was fine, only the cosmetic step-summary string was stale. Now the test step captures Jest output, extracts `passed` + `skipped` counts, and the summary uses those values via `${{ steps.tests.outputs.passed }}`. Deploy Readiness score moves from 9 → 9.5.

### Documentation

- README production readiness badge: **9.2/10 → 9.5/10** with an updated Audit History table row citing what closed the v5 gaps.
- Test counts bumped everywhere: 740 → **757** (17 new metrics tests).

### What Phase 1 does NOT cover

- **containers.js split** (5774 lines unminified, largest single JS file served) — Performance gap (-2 in v5 audit). Deferred to a v6.16.0 Phase 2 release that needs a deep-spec on how to split (candidate sub-modules: list, detail, compose editor, file browser). Requires dynamic `import()` — works without a build step, but needs the pages refactored to import lazily.
- **Docker-in-Docker integration tests** — Testing gap (-0.5). Structural: needs Docker available in GHA runners. Defer to v7.
- **Distributed rate limiter** — Security / HA gap. BACKLOG F30. Material for v7 "HA mode" with an opt-in `DD_MODE=ha` env var.
- **External third-party security audit** — Out of scope for self-hosted OSS.

### Files touched

- `src/services/metrics.js` (new, ~150 LOC)
- `src/__tests__/metrics.test.js` (new, 17 tests)
- `src/server.js` — 3-line middleware extension (no new layer added)
- `src/ws/index.js` — 2-line hook on connect/disconnect
- `src/routes/misc.js` — appended `metricsService.renderPrometheus()` to `/api/metrics` output
- `.github/workflows/ci.yml` — dynamic test-count extraction + summary
- `README.md` / `SECURITY.md` / `CONTRIBUTING.md` — test counts 740 → 757; README badges + audit row updated

### Tests

- **757 passing + 4 skipped / 51 suites** (was 740 / 50).

---

## [6.14.3] - 2026-04-22 — "NAS Docker section in the host-connection guide"

The "How to Connect Docker Hosts" card on `#/hosts` covered TCP+TLS, SSH Tunnel, Docker Desktop, and Unix Socket — but had nothing about NAS platforms even though we'd shipped detection + per-platform How-Tos for 5 of them in v6.12.0–v6.12.2. Closes that gap.

### Added — NAS Docker connection card

Full-width section between the 2×2 connection-type grid and the architecture diagram. Two columns:

**Left — generic connection setup (any NAS):**
1. Enable SSH on the NAS UI
2. Add admin user to the `docker` group
3. Set up SSH key auth (links to the canonical SSH Key How-To shipped in v6.13.1)
4. Add Host → SSH Tunnel
5. Pill links to the 5 platform-specific How-Tos: Synology DSM, Unraid, TrueNAS SCALE, QNAP, OpenMediaVault — each with the platform's brand color so users can spot their NAS at a glance

**Right — Synology security hardening (DSM 7.x):**
9 actionable items, each with the exact DSM Control Panel path:
- SSH key auth + disable PasswordAuthentication (with the "test the key first" warning)
- Move SSH off port 22 to a non-standard port
- DSM 2-factor authentication for admin
- Auto Block after N failed logins
- Firewall: SSH to LAN only
- Disable the built-in `admin` user
- Mount Docker socket read-only when running Docker Dash on the NAS itself
- Weekly DSM Security Advisor scan
- HTTPS-only DSM UI (with a note about HTTP credential capture even on LAN)

Closing tip points users back to the auto-detected platform badge on the Multi-Host page.

### Bilingual

- `pages.hosts.guideNas*` keys added to both `en.js` and `ro.js` — 19 new strings × 2 languages = 38 entries. Matches the existing bilingual pattern; the Translations tab + DeepL/Google integration shipped in v6.11.0 can fill the other 9 languages with one click when an admin gets to it.

### Tests

- **740 passing + 4 skipped / 50 suites** (unchanged — pure UI addition).

### Files touched

- `public/js/pages/hosts.js` — new full-width NAS card in `_renderGuide()`
- `public/js/i18n/en.js` — 19 new keys
- `public/js/i18n/ro.js` — 19 new keys (Romanian translations)

---

## [6.14.2] - 2026-04-22 — "UX polish — token hygiene + two latent CSS bugs fixed"

Post-v6.14.0 cross-release UX audit surfaced 11 inconsistencies accumulated across v6.11.x–v6.14.0. This release ships the 7 trivial ones (all S-class per the audit); the 3 medium and 1 large items need a design-system decision first and are deferred.

### Fixed — Two latent CSS bugs

**Neither was "cosmetic preference" — both were working-by-accident or visibly broken.**

- **`var(--bg-dim)` was referenced 8 times but never declared** ([public/css/app.css:15-54](public/css/app.css#L15-L54) before this release). Fell back to transparent. The Translate progress container, missing-keys table header, Review table header, egress table header, and egress detail row were all rendering **without their intended dark-row shading** since v6.11.0 / v6.7. Declared as alias: `--bg-dim: var(--surface2)`. 8 call sites immediately restore correct rendering.
- **`var(--text-muted)` was referenced 37 times but never declared.** Worked by accident — CSS inheritance happened to pick up a dim-grey from the parent `color`. Would have broken visibly on any theme swap (e.g. enterprise mode or light theme). Declared as alias: `--text-muted: var(--text-dim)`. Both dark and light theme blocks updated.

### Changed — Token hygiene

- **Tailwind-style reds and yellows replaced with design tokens** ([public/js/pages/system.js](public/js/pages/system.js)). The Translations tab + older Egress panel used `#ef4444` (14 occurrences) and `#f59e0b` (4 occurrences) in inline styles. Replaced all 18 with `var(--red)` / `var(--yellow)`. Side-by-side the Multi-Host host-offline card (which uses `--red` = `#f85149`) and the Translations Usage progress bar were showing visibly different shades of red. Now they match.
- **`#334155` slate-700 fallback replaced with `var(--text-dim)`** ([public/js/pages/multihost.js](public/js/pages/multihost.js) — 4 occurrences). Only surfaced when the backend omits a `color` field on a platform / cloud badge, but when it did it wouldn't match the theme. Now theme-aware.
- **"Latest" pill in What's New uses `.badge-running`** instead of inline `style="background:var(--green);color:#fff"` ([public/js/pages/whatsnew.js:1227](public/js/pages/whatsnew.js#L1227)). Same visual result, but now participates in the same class-based styling as every other green badge.
- **Google + DeepL brand colours extracted to a named constant** ([public/js/pages/system.js](public/js/pages/system.js) — in `_renderTranslationsProviders`). Was inline in a template literal (`#4285f4` / `#0f2b46`). Now `BRAND_COLOR = { google, deepl }` — still hex because brand colours are vendor identity, not theme tokens (explicitly kept out of `:root` to not confuse a future dark/light swap).

### Added — `.empty-msg.is-error` modifier

- New class in [public/css/app.css:717](public/css/app.css#L717): `.empty-msg.is-error { color: var(--red); }`. Replaces the 8 inline `style="color:var(--red)"` repetitions in the `.empty-msg` elements ([public/js/pages/system.js](public/js/pages/system.js)). Behaves identically; now uniform.

### Deferred (explicit)

The 4 non-S items from the audit are **intentionally not in this release**:
- **Provider-card inputs → `.form-control`** (M, 30-60 min): 8 inline-styled inputs in Translations panels. Inputs look identical today; migration is hygiene.
- **`_platformPill(data)` helper in multihost.js** (M, 30 min): platform + cloud pills are hand-copied templates ~90 chars each. Pure refactor, no user-visible effect. Defer until next multi-host feature touches the same code.
- **`.pill-tag` shared class** (M, 30 min): NAS/CLOUD/VM mini-tags have their own style (`padding:1px 5px;…`). Low-value standalone; couple with the helper above.
- **Unified pill component** (L, half-day): four different pill heights/radii/fonts coexist on the Multi-Host card. Needs a design decision ("which of the four is canonical?") before refactoring. Prerequisite: author `DESIGN.md` (which doesn't exist — the `:root` block is the only source of truth).

These are tracked as post-audit items — noted in the audit artifact, not BACKLOG (they're not "known issues" users trigger, they're drift to clean up on the next design-system pass).

### Tests

- **740 passing + 4 skipped / 50 suites** (unchanged — pure frontend changes, test suite doesn't exercise CSS).

### Files touched

- `public/css/app.css` — declared `--bg-dim` and `--text-muted` in both theme blocks; added `.empty-msg.is-error` class.
- `public/js/pages/system.js` — 18 Tailwind hex → tokens, `.is-error` class adoption, brand-colour constant.
- `public/js/pages/multihost.js` — slate fallback → token (4x).
- `public/js/pages/whatsnew.js` — `.badge-running` class on "Latest" pill.

---

## [6.14.1] - 2026-04-22 — "asyncHandler refactor (+ accidental info-leak fix)"

Post-v6.14.0 cleanup promised in the previous release notes: consolidate the try/catch + `res.status(500).json({ error: err.message })` boilerplate into a single `asyncHandler(fn)` wrapper. 175 handlers migrated across 21 route files. **Net diff: −521 LOC.**

### What this actually fixes (the non-obvious win)

Docker Dash's central error middleware at [src/server.js:168-190](src/server.js#L168-L190) already **sanitizes** 5xx responses — scrubs home/data paths, redacts URL credentials, and replaces the raw `err.message` with `'Internal server error'`. Until now, the try/catch wrappers in 21 route files **bypassed** that sanitization by calling `res.status(500).json({ error: err.message })` directly. So any backend error surfacing through those handlers was leaking the raw exception string to the client.

After this release, all generic 500 responses go through the central middleware → **no more accidental path or credential exposure in error messages.**

This wasn't the stated goal of the refactor (the goal was LOC reduction), but it's the more important outcome. Worth calling out for anyone reading the CHANGELOG looking for security-relevant deltas.

### Added — `src/utils/asyncHandler.js`

Four lines of utility:
```js
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
```

Rejected promises now auto-forward to the Express 5 error middleware chain (where the existing sanitizer at line 168 takes over).

### Changed — 21 route files refactored (175 handler invocations)

Sample before/after from [src/routes/containers.js](src/routes/containers.js):

```js
// Before
router.get('/:id/inspect', requireAuth, async (req, res) => {
  try {
    const data = await dockerService.inspectContainer(req.params.id, req.hostId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// After
router.get('/:id/inspect', requireAuth, asyncHandler(async (req, res) => {
  const data = await dockerService.inspectContainer(req.params.id, req.hostId);
  res.json(data);
}));
```

### What was deliberately NOT unwrapped

Per the refactor brief, handlers with any of the following keep their try/catch blocks:
- Dynamic status codes (e.g. `err.statusCode === 404 ? 404 : 500`)
- Non-generic catch responses (extra fields like `{ error, steps: err.steps || [] }`)
- 4xx-mapping catches (`err.message.includes('forbidden') ? 403 : 500`)
- Callback-based async inside a handler (SSE streaming, `docker.loadImage`)
- Catches that do additional business logic (`log.error(…)` then respond)

10 legitimate `res.status(500)` call sites remain — all inspected and confirmed non-generic.

### Verification

- **Tests:** 740 passing / 4 skipped (identical to v6.14.0 baseline).
- **Lint:** `eslint src/routes/ --max-warnings 0` clean.
- Behavior-preserving: clients keep receiving `{ error: "<sanitized message>" }` with 5xx status — the sanitization itself is the only behavior change, and that's an upgrade (not a downgrade) from the previous accidental leak.

### Files touched

- `src/utils/asyncHandler.js` (new)
- 21 files in `src/routes/` — net −521 LOC

---

## [6.14.0] - 2026-04-22 — "Express 4 → Express 5"

BACKLOG P2 item closed. Deep-spec ([plans/deep-spec-express5-migration.md](plans/deep-spec-express5-migration.md)) predicted 3-5h based on evidence that the codebase was already v5-idiomatic. Actual execution cost ~2h with one mid-flight snag (see below).

### Changed — Express 4.21.2 → Express 5.2.1

- Dependency bump. `router` transitively upgraded to `2.2.0` and `path-to-regexp` to `8.4.2`.
- 2 code changes for path-to-regexp v8 syntax (the only breaking surface we hit):
  - [src/routes/registries.js:77](src/routes/registries.js#L77) — `'/:id/tags/:repo(*)'` → `'/:id/tags/*repo'`. Added `Array.isArray(req.params.repo) ? repo.join('/') : repo` because v8 returns splat params as arrays; downstream `registryService.tags(id, repo)` still receives the `"library/nginx"`-style string.
  - [src/server.js:156](src/server.js#L156) — `app.get('*', …)` → `app.get('/*splat', …)` for the SPA fallback. No downstream consumer of the captured value.

### Removed — obsolete `path-to-regexp` override

`package.json` had `"path-to-regexp": "^0.1.13"` in `overrides` (added in commit `8164516` to patch a ReDoS CVE in v4's transitive `0.1.12`). On v5 the override was **blocking the upgrade** because it forced the incompatible v0.x branch. Removed. Express 5 pulls `path-to-regexp@8.4.2` transitively with no CVEs.

**Worth noting:** the deep-spec missed this. Spec said "no direct `path-to-regexp` dep to touch" — true in principle (we don't declare it directly) but the override was effectively a version pin. `npm install express@^5` resolved fine but the first test run crashed with `TypeError: pathRegexp.match is not a function` because Express 5's router calls v8's API on what was actually still v0.x. Lesson for future dep-migration specs: **always audit `overrides` alongside `dependencies`.**

### What we deliberately did NOT change

Per the spec's §4.4: the 24 async-handler try/catch wrappers stay. Express 5's auto-forward of rejected promises makes them redundant, but removing them changes error response shapes and touches 24+ files. Out of scope; tracked as a post-migration opportunity.

### Tests

- **740 passing + 4 skipped / 50 suites** (identical to v6.13.1 — the regression net held).

### Effort reality check

Deep-spec estimated 3.75h nominal, 6-8h worst case. Actual: ~2h (including fixing the overrides miss). BACKLOG's original 8-12h estimate was pessimistic because it assumed a v4-style codebase with custom error middleware, `:param?` optional syntax, and the other v5 removals we actually don't use.

### Files touched

- `src/routes/registries.js` — 1 path + array-join shim.
- `src/server.js` — 1 SPA fallback path.
- `package.json` / `package-lock.json` — express major bump + overrides cleanup.
- `BACKLOG.md` — mark P2 item shipped.

---

## [6.13.1] - 2026-04-22 — "SSH key How-To + GHA Node 24 future-proofing"

Two unrelated-but-small cleanups in one release:
1. The canonical **SSH key auth guide** that v6.12.0's NAS docs called out ("private key recommended") but never walked through.
2. **GitHub Actions bumped** to their first Node 24 majors — clearing the June 2 2026 deprecation deadline with margin.

### Added — Canonical SSH key auth guide

Migration 060 adds a new built-in How-To (`ssh-key-auth`, EN + RO) that covers every platform we detect:

- **Key generation** — `ssh-keygen -t ed25519` (or RSA 4096 for ancient servers). Passphrase support explained (Docker Dash accepts encrypted keys).
- **Per-platform public key placement** — with the specific UI path or gotcha for each:
  - 🟦 **Synology DSM 7.x** — User Home Service MUST be enabled first; `chmod 700/600` ritual; DSM 7.2 `PubkeyAuthentication` regression workaround
  - 🟧 **Unraid** — UI-managed (Settings → User Utilities → User Profile → SSH Authorized Keys)
  - 🟩 **TrueNAS SCALE** — UI-managed (Credentials → Local Users → SSH Public Key field)
  - 🟥 **QNAP QTS / QuTS hero** — manual shell; warned that QTS firmware updates sometimes reset perms
  - 🟫 **OpenMediaVault** — UI-managed (Users → Edit → Public keys tab)
  - ⬛ **Generic VPS** — `ssh-copy-id` or one-liner curl/cat pipe
- **Private key upload** — PowerShell + Linux/macOS commands to extract, copy the BEGIN/END markers correctly, paste into Docker Dash's host-add form
- **Post-setup hardening** — how to disable `PasswordAuthentication` safely, Synology-specific `synoservice --restart sshd` instead of `systemctl`
- **Troubleshooting matrix** — `ssh -vvv` debug output interpretation, the 6 most common failure modes (wrong perms, wrong file, partial paste, etc.)
- **Key hygiene** — rotation cadence, backup, passphrase recommendation

### Changed — GitHub Actions runtime bumped to Node 24

All 4 workflows updated:
- `actions/checkout@v4` → `@v5`
- `actions/setup-node@v4` → `@v5` (kept `node-version: '20'` — that's the production Dockerfile base image, independent of the action's runtime)
- `docker/setup-qemu-action@v3` → `@v4`
- `docker/setup-buildx-action@v3` → `@v4`
- `docker/login-action@v3` → `@v4`
- `docker/metadata-action@v5` → `@v6`
- `docker/build-push-action@v5` → `@v6`

Clears the deprecation warning on every CI run and the June 2 2026 hard cutoff with 40+ days of margin.

### Tests

- **740 passing + 4 skipped / 50 suites** (unchanged — migration is content-only, workflow changes don't affect unit tests).

### Files touched

- `src/db/migrations/060_howto_ssh_key_auth.js` (new) — bilingual guide.
- `.github/workflows/{ci,docker-build,caddy-image,egress-filter-image}.yml` — 7 action version bumps.

---

## [6.13.0] - 2026-04-22 — "Drop the deprecated LDAP client (ldapjs → ldapts)"

`ldapjs` 3.x was flagged decommissioned by upstream months ago — its 9 `@ldapjs/*` sub-packages all carry deprecation warnings. This release swaps in `ldapts@8.1.7`, the modern Promise-based successor, and cleans up the BACKLOG entries that had silently been completed in prior releases but never marked.

### Security / dependency

- **Removed** `ldapjs@3.0.7` + 19 transitive deprecated packages from the dep graph. `npm audit` still clean (was already 0; removal is a hygiene win).
- **Added** `ldapts@8.1.7` as the direct LDAP client. Typed errors (`InvalidCredentialsError` etc.) instead of generic `Error`s — richer diagnostics if we want them later; callers still work unchanged because they only inspect `err.message`.

### Changed — `src/services/ldap.js` rewritten

~200 lines rewritten against the Promise-based API. Public interface preserved bit-for-bit: `getConfig`, `saveConfig`, `deleteConfig`, `testConnection`, `authenticate`, `listUsers` — same signatures, same return shapes, same thrown error messages. No caller changes needed (`src/routes/auth.js`, `src/services/auth.js` unchanged).

Behavior preservation checklist (all confirmed):
- ✅ Simple bind (service account → search → user bind for password verify)
- ✅ Search with filter / scope / attributes / sizeLimit / timeLimit — same option shape
- ✅ LDAPS via `ldaps://` URL + `tlsOptions`
- ✅ TLS cert validation — `rejectUnauthorized: false` path preserved for `tlsSkipVerify`
- ✅ Connection timeout + operation timeout (both `5000`ms)
- ✅ Group membership check — case-insensitive substring match on `memberOf`
- ✅ Error throw for group-mismatch — same message (`User is not in the required LDAP group`)
- ✅ Filter escape — new local `_escapeFilter()` implementing RFC 4515 (`\x00`, `(`, `)`, `*`, `\`) replacing the removed `ldap.escapeFilter` helper

### Known gaps (unchanged from pre-migration behavior)

- **StartTLS** — never supported; our config uses `ldaps://` (connection-level TLS) not StartTLS. `ldapts` exposes `client.startTLS()` if we need it later.
- **SASL bind** — never used. Simple bind only.
- **Paged search (>1000 entries)** — not implemented. AD deployments with large user bases may silently truncate at server default page limit. `ldapts` has `searchPaginated` if we need it — worth noting for enterprise customers with huge directories.
- **`strictDN: true`** — `ldapts` default. Old `ldapjs` was loose about whitespace/escaping in DNs. AD service accounts with quoted CNs (`CN="Last, First",...`) may now throw `InvalidDNSyntaxError`. **Enterprise staging test required.**

### Confidence

**Medium.** No LDAP tests exist in this repo (the test suite doesn't exercise `ldap.js`), so the rewrite is statically verified — correct per ldapts docs but unverified against a live server. Manual staging tests recommended before the next enterprise rollout (9-item checklist in [BACKLOG.md](BACKLOG.md#f16)).

### BACKLOG cleanup

Also marked three stale dependency-major entries as shipped (they were done in earlier releases but never crossed out):
- `bcrypt 5 → 6` — shipped v6.7.1 (native deps refresh)
- `better-sqlite3 11 → 12` — shipped v6.7.1
- `node-cron 3 → 4` — shipped v6.9.2

### Tests

- **740 passing + 4 skipped / 50 suites** (unchanged — no new LDAP tests added since the existing suite has none to update).

### Files touched

- `src/services/ldap.js` — rewritten (203 → 252 lines; +49 LOC, mostly comments + the escape helper).
- `package.json` / `package-lock.json` — `ldapjs@^3.0.7` → `ldapts@^8.1.7`.
- `BACKLOG.md` — F16 marked shipped + 3 stale dep entries cleaned up.

---

## [6.12.2] - 2026-04-22 — "Close the detection-vs-docs gap: TrueNAS + QNAP + OMV guides"

v6.12.0 added platform detection for 5 NAS systems but shipped How-To guides for only 2 (Synology + Unraid). A user connecting a QNAP saw the badge light up but had to go elsewhere for setup help — inconsistent with the promise of the release. This patch closes that gap.

### Added — Three new bilingual How-To guides (EN + RO)

Migration `059_howto_nas_guides_pt2.js` upserts into `howto_guides`:

- **`truenas-scale`** — TrueNAS SCALE 24.10 "Electric Eel" or newer (the Docker-based release; pre-Eel K3s versions are called out as unsupported). Covers: enabling SSH, adding the admin to the docker group, wiring up the host, the *critical* caveat that TrueNAS-managed `ix-*` containers should be left to the SCALE UI (Docker Dash deploys go fine side-by-side), and the ZFS-dataset mount convention for persistent storage. Troubleshoots the "why does my badge show Debian instead of TrueNAS SCALE" kernel-marker issue.
- **`qnap-qts`** — Container Station on QTS 5.x and QuTS hero. Calls out the QNAP quirk where the Docker socket path varies by QTS version (sometimes `/var/run/docker.sock`, sometimes `/share/ZFS*_DATA/.qpkg/container-station/...`) and gives the discovery commands. Covers shared-folder mount convention (`/share/<pool>/...`) and Container Station coexistence — both UIs read the same daemon.
- **`openmediavault`** — OMV (Debian + NAS UI). Explicit about the omv-extras + Docker plugin installation path (OMV doesn't ship Docker in core). Explains the hostname-based detection heuristic so users know why the badge says "Debian" unless their hostname contains "openmediavault" (and how to fix that). Covers coexistence with OMV's own Compose plugin.

### Design choices

- **Difficulty levels** — TrueNAS SCALE and QNAP flagged `intermediate` (the K3s-vs-Docker distinction, ix-prefix managed containers, variable socket path are not beginner territory); OMV stays `beginner` because it's just Debian with a UI.
- **One warning box per guide** — critical gotcha called out up top (K3s incompatibility, variable socket path, hostname detection). Keeps the rest of the guide flowing without blocking callouts everywhere.
- **No new code** — pure content migration. Existing How-To rendering pipeline handles everything.

### Platform coverage now complete

Every platform Docker Dash auto-detects has a dedicated setup guide:

| Platform         | Detection (v6.12.0) | Guide (v6.12.0/6.12.2) |
|------------------|:-------------------:|:----------------------:|
| Synology DSM     | ✅                  | ✅ v6.12.0             |
| Unraid           | ✅                  | ✅ v6.12.0             |
| TrueNAS SCALE    | ✅                  | ✅ v6.12.2             |
| QNAP             | ✅                  | ✅ v6.12.2             |
| OpenMediaVault   | ✅                  | ✅ v6.12.2             |
| Generic VPS      | ✅ (distro-only)    | ✅ v6.12.0             |

### Tests

- 740 passing + 4 skipped / 50 suites (unchanged — content-only migration).

### Files touched

- `src/db/migrations/059_howto_nas_guides_pt2.js` (new) — 3 bilingual guides.

---

## [6.12.1] - 2026-04-22 — "Cloud vendor badges via DMI — the follow-up v6.12.0 promised"

Second platform pill on the Multi-Host card: which cloud (or hypervisor) is this Docker daemon actually running on? AWS EC2, Google Cloud, Azure VM, DigitalOcean, Hetzner, Linode, Vultr, Oracle Cloud, Scaleway, OVHcloud — plus on-prem hypervisors (VMware, VirtualBox, KVM/QEMU, Xen, Parallels) and bare-metal motherboard vendors.

**Why this release:** v6.12.0 called out the gap: `docker info` carries the OS but never says "AWS". The answer is in `/sys/class/dmi/id/sys_vendor` + `/product_name`, which require one local fs read (local host) or one SSH exec (remote host via the v6.8.0 tunnel). Both paths already existed — this release wires them up.

### Added — Cloud DMI probe

- **`detectFromDmi(sysVendor, productName)`** — pure function in `platform-detect.js`. Maps DMI strings to `{vendor, label, iconClass, color, raw}`. Covers:
  - **Public cloud:** AWS, GCE, Azure, DigitalOcean, Hetzner, Linode, Vultr, Oracle Cloud, Scaleway, OVHcloud.
  - **Virtualization:** VMware, VirtualBox, KVM/QEMU, Xen, Parallels.
  - **Bare metal:** returns `{vendor: 'baremetal', label: <sys_vendor>}` so users see "Dell Inc." or "ASUSTeK" on unmanaged hardware instead of an empty badge.
- **`probeCloudForHost(hostId)`** — async helper that reads `/sys/class/dmi/id/sys_vendor` + `/product_name` via the existing `remote-fs` dispatcher (local fs for hostId 0, SSH tunnel for remote hosts). Degrades silently to `null` if DMI access is denied (some hardened containers).
- **Cache + sentinel semantics** — `peekCloud(hostId)` returns `undefined` if not yet probed, distinct from a cached `null` (probed but DMI unreadable). Prevents re-probe loops on hosts where DMI is permanently unavailable.

### Changed — `GET /api/hosts/:id/info` enrichment

- Returns `info.cloud` alongside `info.platform`. First call kicks off the probe in the background and returns `cloud: null`; subsequent calls pick up the cached result. Cost on first call: zero added latency. Cost on re-render: zero (cache hit).

### Changed — Multi-Host card renders a second pill

- Cloud pill appears next to the platform pill when detection succeeded. Examples:
  - AWS EC2 (orange `fab fa-aws` icon) with `CLOUD` tag
  - VMware (gray `fas fa-server` icon) with `VM` tag
  - Dell Inc. (slate `fas fa-microchip` icon) with no tag — bare metal
- Tooltip shows the raw DMI `sys_vendor` string so power users can confirm the match.

### Tests

- 22 new tests in `platform-detect.test.js` covering all cloud signatures, the Azure-vs-generic-Microsoft disambiguation, the Oracle-Cloud-vs-VirtualBox disambiguation, trim + empty-string edge cases, and the cache sentinel semantics.
- **Total: 740 passing + 4 skipped / 50 suites** (was 718 — 22 new tests added).

### Files touched

- `src/services/platform-detect.js` — added `detectFromDmi`, `probeCloudForHost`, `peekCloud`, `_cloudCache`.
- `src/__tests__/platform-detect.test.js` — +22 tests.
- `src/routes/hosts.js` — `GET /:id/info` now includes `info.cloud` with background-probe pattern.
- `public/js/pages/multihost.js` — second pill in `_renderHostCard`.

---

## [6.12.0] - 2026-04-22 — "Docker runs everywhere — let's recognize it"

Tier 1 NAS/cloud platform support: auto-detect the host's platform (Synology DSM, Unraid, TrueNAS SCALE, QNAP, OpenMediaVault, plus the major Linux distros) from Docker's `info` response and render a branded badge on the Multi-Host page. Ships with three bilingual How-To guides covering the most common deployment targets: Synology Container Manager, Unraid, and generic cloud VPS (Hetzner, DigitalOcean, AWS EC2, GCE, Azure, Linode, Vultr).

**Why this release:** User asked whether Docker-Dash could reach NAS and cloud users. Research showed the answer is "yes, mostly for free" — the v6.8.0 multi-host SSH tunnel already works against any machine exposing `/var/run/docker.sock`. What was missing: telling users that fact, and recognizing their platform once they connect. No SDK bloat, no vendor API integrations — just parse `docker info` and show a badge.

### Added — Platform auto-detection

- **`src/services/platform-detect.js`** — pure function `detectFromDockerInfo({ os, kernelVersion, hostname })` that returns `{platform, label, version, category, iconClass, color, notes}`. Covers:
  - **NAS:** Synology DSM 6.x/7.x (incl. "Synology DSM …" and bare "DSM …" variants), Unraid (by OS string, kernel marker, or Tower-hostname + Slackware-kernel fallback), TrueNAS SCALE Electric Eel+ (via `-truenas-production` kernel marker), QNAP QTS/QuTS hero, OpenMediaVault.
  - **Linux distros:** Ubuntu, Debian, Fedora, CentOS, Rocky, AlmaLinux, Alpine, Red Hat/RHEL, Arch, openSUSE — with version extraction.
  - **Fallback:** generic `linux` badge for unknown distros.
- **Cache** by `hostId` — detection runs once per host, reused on multi-host page re-renders. `invalidate(hostId)` called on tunnel reconnect so a re-installed OS is picked up.
- **No SSH probes** — everything comes from the existing `docker info` call. Zero new network round-trips.

### Added — Branded badge on Multi-Host page

- `_renderHostCard()` now shows a colored pill above the OS line with the platform's icon, label, version, and an `NAS` tag for NAS platforms. Hover tooltip surfaces platform-specific notes ("Synology: docker needs sudo or docker-group membership", "Unraid: Community Apps ecosystem available", etc.).
- Badge is suppressed for generic `linux` (no point adding visual noise when detection didn't find anything interesting).

### Added — Three How-To guides (EN + RO)

Migration `058_howto_platform_guides.js` upserts into the existing `howto_guides` table:

- **`synology-dsm`** — Enable SSH in DSM Control Panel → Terminal, add user to `docker` group, find the IP, add the host in Docker Dash with key or password auth, verify the badge appears. Troubleshooting: `docker` group vs Container Manager's sudo-wrapped CLI, DSM 7.2 permissions changes, shared-folder mount gotchas.
- **`unraid`** — SSH usually on by default, root user, `/mnt/user/appdata` convention for persistent volumes, Community Apps coexistence notes. When to use Docker Dash vs. the native Unraid Docker tab.
- **`generic-vps`** — One artifact covers Hetzner, DigitalOcean, AWS EC2, GCE, Azure VM, Linode, Vultr. Cloud-init `user-data` snippet for each provider to install Docker and bootstrap the `docker` user on first boot. Security hardening checklist: UFW/firewall defaults, SSH key-only auth, `docker.sock` exposure warning, fail2ban recommendation.

### Tests

- 23 new tests in `src/__tests__/platform-detect.test.js` (all passing): Synology DSM 7.2 + 6.x, Unraid by OS + Tower-hostname fallback, TrueNAS Electric Eel, QNAP QTS + QuTS hero, OMV, Ubuntu/Debian/Fedora/Rocky/Alma/Alpine/Arch, edge cases (null, missing fields, `OperatingSystem` capital-O fallback), cache hit/miss behavior, `invalidate(id)` vs `invalidate()`.
- **Total: 718 passing + 4 skipped / 50 suites** (was 695 / 48 — picked up 23 new tests and 2 new suites in this release).

### Out of scope (deliberately)

- **Managed cloud services** (ECS/Fargate, EKS/GKE/AKS, Cloud Run, Azure Container Apps) — wrong paradigm (no Docker daemon to manage) and saturated market. Docker Dash is for self-hosted Docker.
- **Cloud-vendor detection** (AWS/GCP/Azure/Hetzner/DO) — needs DMI data (`/sys/class/dmi/id/sys_vendor`) that isn't in `docker info`. Planned follow-up: optional SSH probe gated behind a toggle.

### Files touched

- `src/services/platform-detect.js` (new)
- `src/__tests__/platform-detect.test.js` (new)
- `src/routes/hosts.js` — enriched `GET /api/hosts/:id/info` with `info.platform = platformDetect.detectForHost(id, info)`.
- `public/js/pages/multihost.js` — badge renderer in `_renderHostCard`.
- `src/db/migrations/058_howto_platform_guides.js` (new) — 3 bilingual guides.

---

## [6.11.2] - 2026-04-21 — "Translate everything with a progress bar (and fix a regression)"

Two fixes to the Translations tab based on direct user feedback.

### Fixed — Null-ref crash when opening Review panel

- v6.11.1 demoted the "Mark as applied" button (since Export is optional now) but left an orphan `document.querySelector('#r-mark-exported').addEventListener(...)` wired to it. When the Review tab loaded, that selector returned `null` and JS threw `Cannot read properties of null (reading 'addEventListener')`. Removed the orphan listener.

### Changed — No more 50-key UI cap

The 50-key limit was always an **internal batching constraint** (Google v2 + DeepL Free both practically cap at 50 per-call), not a product decision. Exposing it to the UI was my mistake.

- **Select-all now selects literally all** of the missing keys (no more "max 50" warning in the toast).
- **Master checkbox** in the table header — click to toggle every row at once. Rows default to checked when the missing-keys table first loads.
- **Internal chunking** — the UI sends batches of 50 keys to `/api/translations/batch` in sequence. Each call goes through the existing per-call quota pre-check, so the worst case of a mid-way quota exhaustion stops cleanly at the batch boundary (no partial charges).
- **Progress bar** — appears when translation starts, shows:
  - `Batch N of M (X keys)…` label + spinner
  - Running total: `Y / Z translated · W chars used`
  - Visual progress bar (0% → 100%)
  - **Cancel** button — stops after the current in-flight batch so no chars are lost mid-API-call
- **Auto-navigate to Review** after a successful full run — users see their translations without clicking through tabs.
- **Graceful mid-run errors** — quota exceeded / network failure at batch N halts, shows `Stopped at error` label + the exact error, but keeps everything translated up to that point (already in DB).

### Sample run

~1,500 missing keys in RO:
- Old v6.11.1: user had to manually select 50, translate, reload, select next 50... 30× repeats.
- New v6.11.2: "Select all → Translate selected" → 30 batches run sequentially → ~90 seconds, progress bar ticks through 0-100, done. All keys land in `accepted` (auto-accept default) and the RO language is fully live.

### Files touched

- `public/js/pages/system.js` — removed orphan listener, added master checkbox, added chunked batch loop with progress UI + cancel support.

### Tests

- 695 passing + 4 skipped / 48 suites. Same count as v6.11.1 — UI logic change only.

---

## [6.11.1] - 2026-04-21 — "Translations go live automatically (no more download-the-file nonsense)"

Direct reaction to user feedback on v6.11.0: *"ce o sa fac eu cu fisierul descarcat?"* — fair point. The download-and-manually-commit flow made no sense for a self-hosted container tool. Translations are now applied at runtime from the DB. **No file editing. No git commit. No container rebuild.**

### Changed — Runtime overrides from DB

- **`GET /api/translations/overrides/:language`** (any authenticated user) — returns accepted + applied translations as an unflattened tree for the language.
- **Frontend `i18n.js`** gains `loadOverrides(code)` and `reloadAllOverrides()`. Called once after login completes, then every time an admin accepts a translation or runs a batch with auto-accept. Deep-merges on top of the statically-registered tree, so the current page picks up new strings on next `i18n.t(...)` call (most tabs re-render on navigation, so the refresh is seamless).
- **No file writes** from the admin UI. `public/js/i18n/*.js` remains source-of-truth for the EN baseline and any translations committed to git; DB overrides layer on top without touching source files.

### Added — Auto-accept toggle

- New **"Auto-accept (apply live)"** checkbox in the Translate panel, **checked by default**. When on, batch-translated strings skip the `pending` status and land directly in `accepted` — immediately visible in the UI after i18n hot-reload. Turn it off if you want to review each machine translation before it ships (unchanged v6.11.0 flow).
- Toast after auto-accept batch: *"Translated N keys — **live now**"* so there's no ambiguity about what happened.

### Changed — Export demoted to "optional"

- The Review panel's Export button is no longer styled as primary. Copy reads: *"Accepted translations are live now — exports are optional for git contribution."*
- Use case for Export kept: users who want to fork Docker Dash and upstream their translations to the source tree. Everyone else ignores it.

### Migration path

Upgrade drop-in. No DB migration. Any translations you already accepted in v6.11.0 are now live automatically on next login — no action needed.

### Files touched

- `src/services/translations.js` — new `getRuntimeOverrides(lang)` → unflattened tree.
- `src/routes/translations.js` — new `GET /overrides/:language` endpoint.
- `public/js/i18n.js` — `loadOverrides` + `reloadAllOverrides` + `_deepMerge`.
- `public/js/app.js` — `await i18n.reloadAllOverrides()` after auth in `init()`.
- `public/js/pages/system.js` — auto-accept toggle in Translate panel; hot-reload after Accept in Review panel; Export demoted.

### Tests

- 695 passing + 4 skipped / 47 suites — unchanged. No new tests (UI + endpoint wiring).

### Why this matters

Before v6.11.1 the flow was: "Translate → Review → Accept → Export → `cp` to source tree → `git commit` → rebuild image → redeploy." For a web-based admin tool that goes against everything the product stands for. Now it's: "Translate → done." The review step is opt-in for users who want it, and the export is available for upstream-contribution scenarios only.

---

## [6.11.0] - 2026-04-21 — "Translations — Google Translate + DeepL integration with quota tracking"

Closes the BACKLOG i18n gap without needing human translators. New System → **Translations** tab integrates Google Translate + DeepL free-tier APIs (500k chars / month each), tracks monthly usage per service to stay within limits, and provides a review workflow before any locale file ships to source control.

### Added — Translations tab (4 panels)

- **Providers** — add/rotate/disable API keys for Google Translate + DeepL. Keys encrypted at rest (AES-GCM, same crypto util as ACME + notification channels). Test-connection button hits a cheap auth-only endpoint per provider (Google `/languages`, DeepL `/usage`) to validate the key without burning quota. "Get free API key ↗" links to each provider's signup page.
- **Usage** — per-provider progress bars showing current month's `chars_used / monthly_limit`. Color-coded warnings at 80% (amber) and 100% (red). Month resets automatically on the 1st.
- **Translate** — pick a target language from the list (auto-detected from `public/js/i18n/*.js`), see `N missing keys · X chars total`, select up to 50 keys per batch, pick provider, click **Translate selected**. Backend validates the quota BEFORE the API call — if the request would exceed the monthly limit, returns `429 QUOTA_EXCEEDED` without burning a char. Translation chars are recorded atomically in `translation_usage` on success.
- **Review &amp; Export** — every translation lands in `status='pending'` for human review. Edit-in-place → Accept (✓) or Reject (✗). Download button exports a complete merged `<lang>.js` file with all accepted translations unflattened back to the nested-object shape — user commits to git manually. "Mark as applied" flips accepted → applied so the review list stays clean.

### Architecture

- **`src/db/migrations/057_translations.js`** — three new tables:
  - `translation_providers` (one row per provider, encrypted API key, monthly_limit)
  - `translation_usage` (one row per provider × year_month, atomic char counter)
  - `translations` (one row per language × key, pending/accepted/rejected/applied status)
- **`src/services/translations.js`** (~400 LOC): providers CRUD, Google v2 + DeepL Free HTTP adapters with 10s timeouts, quota pre-check + post-success atomic counter, locale-file parser (flatten nested `i18n.register(code, flag, name, tree)` shape via sandboxed `new Function`), missing-key diff against `en.js`, unflatten → export.
- **`src/routes/translations.js`** — 11 admin-only endpoints (`/providers` CRUD + test, `/usage`, `/languages`, `/missing`, `/batch`, `/` list, `:id` patch for review, `/export`, `/mark-exported`).
- **Audit log events**: `translation_provider_created/_updated/_deleted`, `translation_batch` (count + chars per run), `translation_reviewed`, `translation_exported`.

### Explicit NOT-in-scope (design choices)

- **No auto-edit of `public/js/i18n/*.js`** — export gives you the file; you `cp` + commit. Preserves git history as the source of truth; avoids silent source-file edits from a web UI.
- **No runtime DB fallback** — i18n still loads from JS files at page load. Keeps this release focused on authoring; runtime lookup from DB would need frontend i18n refactor.
- **Batch cap at 50 keys** — matches DeepL's practical per-call sweet spot; Google allows more but 50 is a safer ceiling.
- **No translation memory / glossary** — future v6.12+ if demand exists. For now, same string to same language = same result (re-translating just bumps usage).
- **No bulk-accept** — review is intentionally per-row. Auto-accepting machine translations wholesale is how "ge[i] niste" ends up shipping in production.

### Free-tier details (operator guide)

Both Google Translate + DeepL offer ~500k chars/month free:
- **Google Cloud Translation API v2**: free after $300 trial credits; for permanent free, enroll in the "free tier" program. Auth: `?key=YOUR_KEY`.
- **DeepL API Free**: no card required, 500k chars/month forever. Auth: `Authorization: DeepL-Auth-Key YOUR_KEY`.

The Usage tab shows exactly how close you are to each limit. Translations are refused (not throttled) at the limit — users see a clear `QUOTA_EXCEEDED` error with `used / requested / limit` details so they can pick a smaller batch or switch provider.

### Tests

- **`src/__tests__/translations.test.js`** — 17 tests: providers CRUD (reject unknown/short key, upsert-as-rotate, toggle active, delete), usage tracking (starts zero, increments on translate, refuses at quota), Google + DeepL HTTP call shape verification (mocks `fetch`, inspects URL + body + auth headers), translations CRUD with status transitions, setTranslationStatus validation, `listLanguages` + `listMissingKeys` parse real locale files, flatten/unflatten round-trip.
- **Total: 695 passing + 4 skipped / 47 suites** (was 678 / 46, +17).

### Files touched

- `src/db/migrations/057_translations.js` (new)
- `src/services/translations.js` (new, ~400 LOC)
- `src/routes/translations.js` (new, 11 endpoints)
- `src/__tests__/translations.test.js` (new, 17 tests)
- `src/server.js` — mount the route
- `public/js/api.js` — 13 new `translations*` methods
- `public/js/pages/system.js` — new Translations tab + 4 render panels

### Upgrade path

Drop-in. Migration 057 applies automatically on startup. No config change required; admin goes to System → Translations and pastes API keys when ready.

---

## [6.10.0] - 2026-04-21 — "Per-container Security tab + diff major bump"

Two changes. One adds a user-visible polish tab (so this bumps the minor). One closes a P2 dep-bump BACKLOG item.

### Added — Container-detail **Security** sub-tab

Every container's detail page gains a new **Security** tab alongside Info / Logs / Terminal / Stats / Env / Mounts / Network / Labels / Files / Changes / Pipeline / Inspect. The tab shows a 2×2 grid of cards covering the full security posture for just this container:

| Card | Data source | Actions |
|---|---|---|
| **Secrets** | `/api/system/secrets-audit` filtered by container id/name | Score badge + top 5 issues + **Fix with Wizard** (opens RemediateWizard scoped to container) |
| **Egress** | `/api/system/egress-audit` + `/api/egress-filter/policies` filtered | Network mode · reachability verdict · score · filter-policy badge. **Enable filter** (routes to System → Egress) or **Manage policy →** link when policy active |
| **CIS Benchmark** | `/api/system/cis-benchmark` (user-triggered via play button — CIS is the slow one) | Pass/fail/warn tally + top 5 findings |
| **Image Vulnerabilities** | `/api/images/scan-history?image=...&limit=1` | Critical / High / Medium / Fixable tally + last scan timestamp + **Full report** link |

Each card has a refresh button (⟳) in its header.

**Design (reuse-first):** same pattern as v6.9.3 (stack modals) and v6.9.4 (image drill-down). Zero new backend endpoints — parallel fetches to existing audits, client-filter by container id OR short-id OR name (handles the 12-char-prefix vs full-id mismatch seen elsewhere in the app). Zero new tests.

**Why this completes the security story:** v6.9.3 gave stack-level actions on the Containers page. v6.9.4 gave image → container drill-down from the Security page. v6.10.0 closes the last gap: when you're looking at one specific container, you see its full posture in one place without bouncing between System tabs.

### Changed — `diff` 5 → 9 (major)

- Upgraded `diff` `^5.2.2` → `^9.0.0`. Used exclusively in `src/services/compose-diff.js` (`Diff.createPatch` for unified diff display in the Remediation Wizard).
- **Tested:** `compose-diff.test.js` all 10 tests pass unchanged on v9. API for `createPatch` stayed backward-compatible despite the major version jump (v6/7/8 major bumps were mostly about TypeScript types and internal refactors).
- Also bumped in the `overrides` block to prevent nested deps pinning the old version.
- `npm audit` → 0 vulnerabilities.
- Closes a BACKLOG P2 dep-major deferral from v6.6.4.

### Tests

- **678 passing + 4 skipped (live CF tests)** / 46 suites. Unchanged vs v6.9.4. Syntax clean on all modified files.

### Files touched

- `public/js/pages/containers.js` — 1 new tab button (line ~1359), 1 dispatch case (line ~2140), 1 new render method `_renderSecurityTab` (~150 LOC).
- `package.json` — `diff` bumped in dependencies + overrides.

### What's now fully done from BACKLOG

- `diff 5→9` — shipped
- Remediation entry points on security.js — shipped (v6.9.4)

Remaining BACKLOG P2: `express 4→5` (wants its own session — bigger API surface). All P1 items still need real fixtures or scope decisions.

---

## [6.9.4] - 2026-04-21 — "Remediation drill-down from Security page (closes BACKLOG deferral)"

Bridges the image-focused Security page with the container-focused Remediation Wizard. Closes a deferred BACKLOG item from v6.6.3 that's been sitting open.

### Added

- **Wrench icon (🔧 `fa-tools`, purple)** on every image row in System → Security's image vulnerability table. Click → opens "Containers using this image" modal.
- **Modal lists** running + stopped containers currently using that image tag, with per-running-container **Fix** button.
- **Fix** closes the security modal and opens the Remediation Wizard scoped to that container — same handoff pattern used by v6.6.3 Secrets / CIS and v6.9.3 stack modals.
- **Empty-state messaging** — when no containers are using the image, tells the operator clearly ("The image's vulnerabilities only matter once it's in production. Start a container from this image, then come back.") instead of an empty table.

### Why this closes a gap

The Security page has always been image-scoped (Trivy/Grype scan per image). The Remediation Wizard has always been container-scoped. Users wanting to patch a vulnerable container's runtime hardening on the back of a vuln scan had to bounce via Containers / Stacks / Secrets tabs to find the right container. Now: one click on the image row → pick which container to fix → Fix.

### Design notes

- **Zero new backend** — uses the existing `Api.listContainers()` plus client-side filter by `c.image === imageName` (the `image` field on the Docker summary is the tag used to create the container).
- **Zero new tests** — pure UI composition over tested endpoints, same pattern as v6.9.3.
- **Image-tag match only** — retagged / digest-reference containers won't match. Acceptable: the common case is "I scanned `nginx:1.25` and I see it's in use, let me fix those containers." Digest-reference is a power-user edge.

### Files touched

- `public/js/pages/security.js` — 1 new icon in image-row action-btns (line ~163), 1 new click handler (line ~282), 1 new modal method `_showImageContainersModal` (~90 LOC appended to the page module).
- `BACKLOG.md` — "Remediation entry points on security.js" marked ✅ shipped.

### Tests

- 678 passing / 46 suites — unchanged. No new tests (UI composition).

---

## [6.9.3] - 2026-04-21 — "Secrets + Egress audit actions at the stack level"

Extends the existing Security Scan + CIS Benchmark per-stack actions on the Containers page (`#/containers`) with two more: **Secrets Audit** and **Egress Audit**. Context-preserving modals — users no longer need to bounce to System → Secrets or System → Egress and re-filter for the stack they're already looking at.

### Added

- **Two new stack-header buttons** on every stack (and the Standalone pseudo-stack) in the Containers page, matching the existing Security Scan + CIS icons:
  - 🔒 **Secrets Audit** (`fa-user-secret`, purple) — runs the global secrets audit and renders the results filtered for this stack
  - 🌐 **Egress Audit** (`fa-network-wired`, cyan) — runs the global egress audit and renders reachability + filter status filtered for this stack
- **`_showStackSecretsModal`** — summary pills (Avg Score / Critical / Warnings / Containers), per-container rows with top 2 issues + "Fix" button that hands off to the Remediation Wizard scoped to that container. Stack-level "Remediate whole stack" button opens the wizard at stack scope. "Open full Secrets tab →" link for when users want the full view.
- **`_showStackEgressModal`** — summary pills (Containers / Internet reach / IMDS reach / Critical), per-container row with network mode + reachability verdict + filter-policy state. When a container has no policy, an **Enable** button is shown; when it does, the preset + mode badge is shown inline. "Enable filter for whole stack" button appears when the stack has any internet-reachable container with no stack-wide policy.

### Design notes (reuse-first)

Rather than build stack-scoped API endpoints, both modals fetch from the **existing** global endpoints (`/api/system/secrets-audit`, `/api/system/egress-audit`, `/api/egress-filter/policies`) and client-filter by `c.stack === stackName`. This matches the pattern already used by `_showStackCisModal`. Zero new backend code, zero new tests needed for existing surface, zero drift risk between global and stack views.

Both modals keep the user in context (Containers page, modal overlay) — same UX pattern as Security Scan + CIS modals. No page navigation, no tab switching mid-action. The "Open full tab →" link is available but not required.

### Behavior details

- **Stopped containers** are reported as "(N stopped — skipped)" in the header and omitted from the table. Matches CIS modal behavior.
- **No issues / no reach** — modal shows an empty-state ("No results for this stack") rather than an empty table.
- **Fix button** on a Secrets row closes the stack modal + opens RemediateWizard scoped to that container, so the user doesn't need to click twice.
- **Enable button** on an Egress row navigates to System → Egress (the full Enable modal with preset picker lives there; replicating the full policy editor in a second place would be maintenance debt).

### Tests

- No new tests — all logic is UI composition over existing tested backends. 678 passing / 46 suites unchanged. Syntax check passes on the modified file.

### Files touched

- `public/js/pages/containers.js` — 2 new buttons in stack header (lines ~420), dispatch handler extended (line ~755), 2 new modal methods appended (~140 LOC).

---

## [6.9.2] - 2026-04-21 — "Hygiene: node-cron 4 + LE CI smoke test"

Housekeeping. Two small but useful cleanups.

### Dependency refresh

- **`node-cron`** `^3.0.3` → `^4.2.1` (major). API-compat for our usage — both `cron.schedule(expr, fn)` and `cron.validate(expr)` still exported. Task object still has `.start()` / `.stop()`. Verified: 677 tests pass unchanged; runtime boot + stopAll() both behave identically on staging.

### Added — Live Cloudflare smoke test

- **`src/__tests__/acme-cloudflare-live.test.js`** — exercises the Let's Encrypt wizard's credential-validation path against the real Cloudflare `/user/tokens/verify` API. Three assertions:
  1. A valid scoped token returns `ok: true` (catches upstream API changes / revoked tokens).
  2. A 37-hex-char "Global API Key" is rejected by our client-side heuristic before we hit the network.
  3. Empty credentials return a clear `api_token` error.
- **Gated on `CLOUDFLARE_TEST_TOKEN` env**: the 3 live tests skip when the secret isn't present. An always-present marker test logs "token not set — live tests SKIPPED" so CI output stays honest.
- **CI wiring**: `.github/workflows/ci.yml` exposes `CLOUDFLARE_TEST_TOKEN: ${{ secrets.CLOUDFLARE_TEST_TOKEN }}`. Nothing runs until you provision the secret in Repo Settings → Secrets → Actions. Recommended scope: `User:Read` only (no zone / DNS permissions needed — we only hit `/user/tokens/verify`).

### Tests

- **678 passing + 4 skipped (live tests)** / 46 suites. Was 677 passing / 45 suites.

### What v6.9.2 does NOT do

- End-to-end Let's Encrypt staging issuance (needs Caddy container + domain control + a DNS zone — too much for unit CI). That belongs in a separate soak environment.

### Operator / maintainer notes

To activate the CF smoke test after pulling v6.9.2:

```
Repo Settings → Secrets and variables → Actions → New repository secret
  Name:  CLOUDFLARE_TEST_TOKEN
  Value: <a scoped CF API token with "User:Read" permission only>
```

Once set, the next CI run will execute all 3 live tests. They add ~2s to the pipeline. Revoke + rotate the token independent of Docker Dash state.

---

## [6.9.1] - 2026-04-21 — "Egress block log: quick-actions + grouped view + CSV"

UX polish on the Outbound Filter deny log. The flow "I see my container being blocked on a hostname it legitimately needs → add it to the allowlist" dropped from 3 steps (open manage modal → paste hostname → save) to 2 clicks (**Allow** → confirm).

### Added

- **Grouped-by-hostname view** for the deny log. Instead of a raw stream of events, shows a table with one row per hostname: count, last seen, ports, and a per-row **Allow** button. Defaults to a 7-day window. Toggle between `Grouped` / `Recent` in the log viewer header.
- **Quick-action: Allow a blocked hostname** — one click + confirm adds the hostname to the policy's allowlist. If the policy was on a preset (e.g. `registry-only`), it's switched to `custom` so the addition persists across subsequent edits. Audit-logged as `egress_policy_allowlist_added`.
- **CSV export** — downloads the last 1000 deny events with full columns (id, blocked_at, hostname, port, proto, reason, container_id) for offline analysis / compliance reports.

### Backend

- **`src/services/egress-filter.js`**:
  - `getBlockLogGrouped(policyId, {sinceHours, limit})` — SQL aggregates count/last_seen/first_seen per hostname, sorted by count DESC, configurable time window (1h → 1y).
  - `allowHostnameOnPolicy(policyId, hostname)` — validates (reject IPs + IMDS + malformed), dedupes, persists via a `UPDATE ... SET preset='custom', allowlist=?` transaction, calls `writePolicyFile()`.
- **`src/routes/egress-filter.js`**:
  - `GET /api/egress-filter/policies/:id/block-log/grouped?sinceHours=168&limit=50`
  - `POST /api/egress-filter/policies/:id/allow-hostname` — body `{hostname}`, returns `{ok, added, policy}` or `{added: false, reason: 'already-in-allowlist'}`.
- **Frontend API methods**: `Api.egressFilterBlockLogGrouped`, `Api.egressFilterAllowHostname`.

### Tests

- **`egress-filter.test.js`** gains 7 tests:
  - `getBlockLogGrouped` — aggregates count + ports + last_seen correctly, sorted DESC
  - `allowHostnameOnPolicy` — adds to custom, switches preset from registry-only to custom, idempotent on duplicate, rejects IPs / IMDS / malformed, 404 on unknown policy, requires hostname.
- **Total: 677 passing / 45 suites** (+7).

### Operator notes

No breaking changes. If you previously used the deny log, it now defaults to `Grouped` view — click `Recent` to switch back to the v6.7 stream format.

---

## [6.9.0] - 2026-04-21 — "Remediation Wizard polish — scheduled, notified, configurable"

Three polish features that round out the Remediation Wizard's story. Nothing revolutionary, but each closes a real gap called out in BACKLOG.

### Added — Scheduled remediation (apply at a specific time)

- Step 3 of the Remediation Wizard gains a **Schedule for later** checkbox + `datetime-local` picker. Set a time, click Execute — the job is persisted with `status='scheduled'` and the background scheduler picks it up when the time arrives.
- Migration `056_remediation_scheduling.js` — adds `scheduled_at` column + partial index on scheduled rows for cheap polling.
- New `src/services/remediation-scheduler.js` — polls every 60s (`DD_REMEDIATION_SCHEDULER_POLL_MS` to override), promotes jobs from `scheduled` to `pending` in `ORDER BY scheduled_at ASC` then kicks off the runner. Concurrency-safe via atomic `WHERE status='scheduled'` update guard.
- `createJob` rejects `scheduledAt` values within the next 60 seconds (too-soon) or beyond 30 days (too-far). Concurrency check expanded to refuse a second scheduled job on the same scope.
- Audit log event: `remediate_scheduled` (separate from `remediate_apply_start` so downstream dashboards can differentiate).
- **Not** for `artifact` mode (download patch has no async job to schedule) — UI disables the checkbox in that mode.

### Added — Notifications on remediation events

- Every lifecycle transition now dispatches through the existing `notificationChannels.sendToAll` (Discord / Slack / Telegram / ntfy / Gotify / email / webhook — 7 providers):
  - `remediate_scheduled` (info) — when a future job is created
  - `remediate_success` (info) — after apply-local or git-PR mode completes
  - `remediate_failed` (critical) — apply failure with `error_class`
  - `remediate_rolled_back` (warning) — auto-rollback or manual rollback
- Fire-and-forget: a broken Slack webhook will never block an apply. All dispatch failures log at debug level.
- No new notification channel types — reuses the v6-era channel configuration UI under System → Notifications.

### Added — Rollback UX improvements

- **Configurable rollback window** via `DD_REMEDIATION_ROLLBACK_SECONDS` env (default 60, clamped to [30, 3600]). Replaces the hardcoded 60s in the SQL `UPDATE rollback_deadline=datetime('now', '+60 seconds')` pattern.
- **Snapshot cleanup job** — the daily purge tick now calls `remediate.pruneOldSnapshots()` which nulls out `pre_apply_snapshot` (gzipped inspect blobs, ~50-200 KB each) for completed jobs older than `DD_REMEDIATION_SNAPSHOT_RETENTION_DAYS` (default 7). Row stays for audit; only the heavy blob is freed.
- **`GET /api/remediate/config`** endpoint — UI can display actual configured window instead of hard-coding "60 seconds" in user-facing copy.

### Incidental improvements shipped with v6.9.0

- Daily purge tick also now calls `egressFilter.pruneOldBlockLog()` (already implemented in v6.7 but wasn't wired to the scheduled job).
- `runJob` precondition relaxed: accepts both `pending` and `scheduled` status (the scheduler promotes before invoking).

### Tests

- `remediation-scheduler.test.js` — 6 tests: promote-due, skip-future, ignore-non-scheduled-status, runner-missing fail-safe, runner-error tolerated, ORDER BY scheduled_at ASC.
- **Total: 670 passing / 45 suites** (+6).

### Operator notes

To opt into the scheduler you don't need to do anything — it starts with Docker Dash on every v6.9.0+ boot. Scheduled jobs that survive a restart are promoted on the next tick.

To tune retention + rollback window:

```
# .env
DD_REMEDIATION_ROLLBACK_SECONDS=300            # 5 min rollback window (default 60)
DD_REMEDIATION_SNAPSHOT_RETENTION_DAYS=30      # keep snapshots for audit (default 7)
DD_REMEDIATION_SCHEDULER_POLL_MS=30000         # check every 30s instead of 60s
```

---

## [6.8.0] - 2026-04-20 — "Multi-host SSH exec — Remediation Wizard Apply on remote hosts"

Closes a long-standing gap: the Remediation Wizard's **Apply (local)** mode was restricted to the local Docker host. Remote hosts could only use Git-PR or artifact modes. v6.8.0 extends the SSH tunnel with `exec` + SFTP-based file operations, so Apply mode now works transparently on any SSH-connected host.

### Added

- **`src/services/ssh-tunnel.js`** gains 4 new methods on the existing tunnel's `ssh2` Client:
  - `exec(hostId, cmd, opts)` — returns `{stdout, stderr, exitCode}`, 30s default timeout
  - `fileExists(hostId, path)` — POSIX `test -f` with shell-escape
  - `readFile(hostId, path)` — SFTP read, returns utf8 string
  - `writeFile(hostId, path, content)` — SFTP write, 0o644 mode
- **`src/services/remote-fs.js`** — thin dispatcher: `hostId=0` → node `fs`, `hostId>0` → ssh-tunnel. Uniform async interface. `fileExists` swallows tunnel errors as `false` for graceful degradation.
- **`src/services/docker-runner.js`** `composeRecreate(file, service, hostId)` — when `hostId > 0`, runs `docker compose up -d --no-deps --force-recreate <service>` via SSH exec on the target host instead of spawning `docker` locally. 120s timeout.
- **`src/services/remediate.js`** — `plan()` and `_applyLocal()` use `remote-fs` for compose read/write + `composeDiff.diffYamlStrings` (content-based) instead of `diffComposeFile` (path-based). Snapshot blob now carries `hostId` per container so rollback returns to the correct host even in mixed-host plans (though typical plans are single-host).
- **`docker-runner.rollback`** — writes rollback content back via `remote-fs` using each snapshot's recorded `hostId`.

### Behavior change (improvement)

Before v6.8.0, `composeFileExists` always returned `false` for remote hosts because `fs.existsSync` only checks the local filesystem. This silently dropped every compose-based remediation on remote hosts (they fell through to "no patch applied"). After v6.8.0, remote compose files are detected and patched identically to local ones.

### Security notes

- Remote file paths are passed through SFTP directly (path-safe).
- Shell commands in `composeRecreate` quote the compose file path + service name. Service name is constrained to `com.docker.compose.service` label chars at catalog time, no injection surface.
- No new capabilities required on the target host — reuses the existing SSH credential flow.
- Remote Docker Dash container still runs without `NET_ADMIN` / `privileged` / host network.

### Tests

- **`src/__tests__/remote-fs.test.js`** — 8 tests: local fs routing for hostId=0/null/undefined, SSH delegation for hostId>0, error-swallow on `fileExists`, error bubble on `readFile`.
- **`src/__tests__/ssh-tunnel-exec.test.js`** — 8 tests: exec stdout/stderr/exitCode, fileExists true/false, quote-safe paths, readFile streaming, writeFile via SFTP. Mocks `ssh2.Client` — no real SSH server needed.
- **Total: 664 passing / 45 suites** (+16 new).

### Upgrade notes

Safe drop-in for v6.7.x. No config change needed. Existing local-host Apply mode continues unchanged. Remote-host Apply mode now "just works" if the host is reachable via the standard SSH tunnel config in Multi-Host page.

---

## [6.7.1] - 2026-04-20 — "Hygiene — native deps + zero lint warnings"

Post-v6.7 housekeeping. No new features, no behavior changes. Two things land:

### Native dependency refresh

- `bcrypt` `^5.1.1` → `^6.0.0` (major). Drops Node <16 support (we're on 24). API identical for our usage (`hash` + `compare`), native bindings rebuild cleanly.
- `better-sqlite3` `^11.10.0` → `^12.9.0` (major). Pure perf + stability bump; no API changes affect our usage. All 648 tests pass without modification.

`npm audit` remains at 0 vulnerabilities.

### Zero lint warnings

- `npm run lint` exits 0 with no output. 49 warnings at the start of this session → 34 after the v6.6.5 sweep → **0** now.
- Strategy: underscore-prefix unused function args (safe, preserves caller contract), remove unused local vars with no side effects, remove stale `eslint-disable` directives.
- Files touched: `src/__tests__/cron-parser.test.js`, `egress-blocklog-ingester.test.js`, `egress-filter.test.js`, `src/routes/auth.js`, `containers.js`, `hosts.js`, `images.js`, `misc.js`, `stats.js`, `system.js`, `src/services/docker-runner.js`, `docker.js`, `git.js`, `s3-backup.js`, `securityAlerts.js`, `workflows.js`. All backed by tests passing.

### Still deferred

- `diff` 5 → 9, `express` 4 → 5, `node-cron` 3 → 4 — each wants a dedicated regression session. Tracked in BACKLOG P2.

### Tests

- **648 passing / 43 suites** — no regressions from native dep bumps or lint changes.

---

## [6.7.0] - 2026-04-20 — "Outbound Network Filter" 🎉

Docker Dash's biggest security feature to date. Ships a production hostname-based outbound allowlist enforced by a lightweight Go sidecar (~2 MB scratch image) + nftables rules installed into target container netns via a short-lived `NET_ADMIN` helper. No TLS decryption, no cert injection — containers see their destinations' real certs.

**The sales pitch in one line:** a compromised container on a Docker Dash host can't talk to IMDS, can't exfiltrate to attacker-controlled hosts, and can't pivot into your cloud account — without you ever breaking its TLS trust chain.

### What shipped across v6.7 alphas and rcs (summary)

See individual alpha/rc entries below for full detail. Feature highlights:

- **5 presets** — `registry-only`, `registries-github`, `lockdown`, `audit-only`, `custom`. Wildcard hostnames supported (`*.github.com`).
- **Two modes** — `enforce` (block denies) and `audit-only` (log but don't block, for migration). Per-policy.
- **IMDS always blocked** — `169.254.169.254`, `metadata.google.internal`, `169.254.170.2`. Defense-in-depth invariant that no user policy can override.
- **Container + stack scope** — apply to one container or to every service in a compose project. Stack apply is transactional: whole-stack precheck before touching anything, rollback on mid-stream failure.
- **Preconditions** — refuses to attach to containers with `NET_ADMIN`, `SYS_ADMIN`, `privileged`, or `network_mode: host / none / container:<id>` — any of those make the filter bypassable.
- **Emergency disable** — one-click red button, `< 5s` to restore full outbound, audit-logged with operator reason.
- **Deny log** — sidecar writes to local append-only log, background ingester tails it into the DB every 30s. UI shows per-policy last-25 events.
- **UI** — System → Egress tab gains Filter column, 3-step Enable/Manage modal, expandable deny log. End-to-end usable without touching REST.
- **Metrics** — sidecar exposes Prometheus `/metrics` with `allowed_total`, `blocked_total`, `audit_only_total`, `upstream_errors_total`, `policy_reloads_total`.
- **One-command setup** — `docker compose --profile egress up -d` brings the sidecar up alongside Docker Dash.

### Components

| Piece | Files | Purpose |
|---|---|---|
| DB schema | `src/db/migrations/054_egress_policies.js` | `egress_policies` + `egress_block_log` tables |
| Service | `src/services/egress-filter.js` | CRUD, preset resolution, IMDS invariant, `canApplyFilter` precondition, `writePolicyFile` |
| Runner | `src/services/egress-runner.js` | `applyToContainer`, `applyToStack` (transactional), `removeFromContainer`, `removeFromStack`, `isApplied`, `statusOfStack` |
| Ingester | `src/services/egress-blocklog-ingester.js` | Tails sidecar deny log via `docker exec tail`, inserts to DB every 30s |
| REST | `src/routes/egress-filter.js` | 9 admin-only endpoints |
| Sidecar | `docker/egress-filter/main.go` + `Dockerfile` | 450-LOC Go binary: SNI peek + HTTP Host parser + hostname allowlist + splice-or-reset, SIGHUP reload |
| UI | `public/js/pages/system.js` (Egress tab) | Filter column + 3-step modal + deny log viewer |
| How-To | `src/db/migrations/055_howto_outbound_filter.js` | Bilingual EN + RO guide (threat model → setup → UI → invariants → gotchas) |
| CI | `.github/workflows/egress-filter-image.yml` | Multi-arch (amd64 + arm64) buildx + GHCR push + per-arch smoke tests |
| Planning | `docs/planning/v6.7/outbound-filter/` | feature-spec + deep-spec + assumption-audit + preflight + results (6/10 PASS on staging) |

### Explicit non-goals (deliberately not in scope)

Documented in deep-spec §4 and the How-To — read these before filing an issue:

- **No TLS decryption.** SNI peek only. Never break the container's trust chain.
- **No IPv6** — IPv4 only. IPv6 tracked for v6.8+.
- **No per-process filtering** — one policy per container.
- **No multi-host Swarm overlay awareness** — single-node Docker. Swarm tasks get their own per-node policies.
- **No source-IP-keyed per-container routing inside a single sidecar** — for isolated per-container policies, run multiple named sidecars (`dd-egress-filter-api`, `dd-egress-filter-db`, …).

### Upgrade from v6.6.x

Safe to `docker compose pull app && docker compose up -d app`. Migration `054_egress_policies.js` + `055_howto_outbound_filter.js` apply cleanly on startup. If you don't opt into the egress profile, nothing changes operationally — the Egress tab just shows "sidecar not configured, read-only audit only".

To opt in:
```bash
# 1. Add to .env:
DD_EGRESS_SIDECAR_ENDPOINT=172.17.0.X:29193      # fill after first boot
DD_EGRESS_SIDECAR_NAME=dd-egress-filter
DD_EGRESS_BLOCKLOG_INGESTER=1

# 2. Start sidecar alongside Docker Dash:
docker compose --profile egress up -d

# 3. Find sidecar's bridge IP (fills step 1):
docker inspect dd-egress-filter --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
docker compose up -d app   # pick up the new env
```

### Tests

- **648 passing / 43 suites** (up from 538 on the v6.6 line — +110 net across the v6.7 work)
- Preflight: 6/10 spikes PASS on staging (P1 rule persistence, P3 Go SIGHUP reload, P4 port isolation, P6 atomic rename, P8 multi-arch buildx, P10 NET_ADMIN precondition logic). P5/P7/P9 gate at `v6.7.1` with real community + perf data.

### Known limitations inherited from rc.2

- Sidecar's aggregate policy = union of all DB policies (see "explicit non-goals" above for the multi-sidecar pattern)
- Corporate proxy compatibility (preflight P5) not yet validated with a real Squid upstream
- No live probe for "is IMDS actually blocked at the host level" — analysis is Docker-config-based

---

## [6.7.0-rc.2] - 2026-04-20 — "Outbound Filter: operational polish"

Second release candidate for v6.7.0. No new features — three operational improvements that reduce setup friction from "build + wire up manually" to "docker compose up".

### Added — One-command setup

- **`docker-compose.yml` gains `dd-egress-filter` service** under `egress` profile:
  ```
  docker compose --profile egress up -d
  ```
  Builds from `docker/egress-filter/`, mounts shared `egress-policy` + `egress-logs` volumes, exposes metrics on :9191, and deliberately has no published `ports:` (sidecar reachable only from containers via iptables redirect — preflight P4).
- **`network_mode: bridge`** on the sidecar — attaches to the default Docker bridge where most target containers live. User-defined bridges and Swarm overlays are documented as requiring manual attachment.
- **Two new shared volumes**: `egress-policy` (Docker Dash writes `policy.json` here; sidecar reads) and `egress-logs` (sidecar's deny log; readable from the ingester).

### Added — GHA workflow for sidecar image

- **`.github/workflows/egress-filter-image.yml`** — multi-arch buildx (amd64 + arm64), QEMU emulation, GHCR push on `main` or manual dispatch. Includes two smoke tests per arch (sidecar starts + `/health` reports a loaded policy) and an image-size guard at 10 MB.
- Triggered by changes under `docker/egress-filter/**`. Tags: `latest`, `6.7.0-rc.1`, `6.7`, branch, short-sha.
- **Blocked until you flip the repo's "Workflow permissions" to Read and write** (Settings → Actions → General). Nothing the CLI can automate — a one-click toggle.

### Fixed — Boot-time policy sync

- **`server.js`** now calls `egressFilter.writePolicyFile()` once at startup (after migrations). Previously: if Docker Dash restarted while policies existed, the sidecar's on-disk `policy.json` could be stale until someone edited a policy. Now state is consistent across restarts.

### Operator notes

To enable the outbound filter stack:

```bash
# 1. Add these to your .env (or docker-compose environment block on `app`):
DD_EGRESS_SIDECAR_ENDPOINT=172.17.0.X:29193      # fill in after first compose up
DD_EGRESS_SIDECAR_NAME=dd-egress-filter
DD_EGRESS_BLOCKLOG_INGESTER=1

# 2. Start with egress profile:
docker compose --profile egress up -d

# 3. Find the sidecar's bridge IP:
docker inspect dd-egress-filter --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'

# 4. Update DD_EGRESS_SIDECAR_ENDPOINT with that IP and restart app:
docker compose up -d app
```

### Tests

- **648 passing / 43 suites** — no test changes (these are infra/config additions).

### v6.7.0 stable gating

rc.2 is the last planned rc. v6.7.0 final ships once:
- [ ] GHCR "Read and write" toggle flipped (one-click, user action)
- [ ] Soak test passes — 48h on staging with ≥1 active policy
- [ ] Optional: design-partner preset validation (preflight P7)

---

## [6.7.0-rc.1] - 2026-04-20 — "Outbound Filter: UI + block log + How-To"

First release candidate for v6.7.0. Alphas 1-4 built the foundation, sidecar, enforcement, stack scope. rc.1 ships the user-facing surface (UI in System → Egress tab), block log ingestion from sidecar → DB, and a bilingual How-To guide. **The feature is now end-to-end usable by someone who's never looked at the REST API.**

### Added — UI (System → Egress tab)

- **New Filter column** per container row:
  - Shows "Enable filter" button for unfiltered containers
  - Shows preset + mode badge (e.g. `registry-only · enforce`) + cog icon for filtered ones
- **Enable modal** — 3-step flow reusing established patterns:
  - Preset picker (registry-only, registries-github, lockdown, audit-only, custom)
  - Mode selector (enforce / audit-only)
  - Custom allowlist textarea with live validation
  - Save & apply in one click — creates policy → writes policy.json → runs helper to install iptables → reports success
- **Manage modal** — same shell for existing policies. Shows current preset/allowlist/mode, allows edit + re-apply, **Unapply** (config retained), or **Emergency disable** (red button — unapplies + deletes policy + audit-logs with operator reason).
- **Expandable deny log** — click a filtered row's chevron → shows last 25 block events with timestamp, hostname, port, reason. Lazy-loaded (no extra API call until user expands).
- **Live status** — table refreshes after every apply/unapply so state is always current.
- **Callout updated** — no longer says "read-only audit"; explains that sidecar + `DD_EGRESS_SIDECAR_ENDPOINT` env unlock enforcement.

### Added — Block log ingestion

- **`src/services/egress-blocklog-ingester.js`** — background job that every 30s runs `docker exec dd-egress-filter tail -n 500 /var/log/dd-egress/denied.log`, parses new lines (dedupes on timestamp), and inserts into `egress_block_log` via the existing contract.
- **Opt-in** via `DD_EGRESS_BLOCKLOG_INGESTER=1` env (off by default — alpha users without the sidecar don't pay the cost).
- **Detects sidecar restart** via container-id change and resets offset — old entries in a rotated log get re-ingested cleanly.
- **11 unit tests** — parser for line format + Go log prefix, no-op on missing/stopped sidecar, dedup across ticks, sidecar restart handling, junk-line skipping, no-policy no-op.

### Added — Bilingual How-To (EN + RO)

- **`055_howto_outbound_filter.js`** — "Enforce Outbound Allowlists with the Egress Filter". Covers threat model, architecture, setup (two steps), UI walkthrough, invariants table, audit events, gotchas table, per-container vs per-stack, explicit non-goals (no TLS decryption, no IPv6 this release).

### Architecture decision documented: per-container routing

The sidecar runs **one aggregate policy** in this release — the union of all active DB policies. For users needing isolated per-container policies, the pattern is **multiple named sidecars** (`dd-egress-filter-api`, `dd-egress-filter-db`, etc.), each with its own `DD_EGRESS_SIDECAR_ENDPOINT` on the Docker Dash container — switch which sidecar a policy targets via a small config extension to the service. Source-IP-keyed sidecar routing was considered but rejected as over-engineering for the single-node deploy target.

### Tests

- **648 → 648 passing** (UI changes don't affect test counts; +11 ingester tests offset the UI-only additions).

### What closes the v6.7 milestone

- ✅ Go sidecar with SNI peek (alpha.2)
- ✅ egress-runner with iptables install via NET_ADMIN helper (alpha.3)
- ✅ Stack scope with transactional apply (alpha.4)
- ✅ UI with 3-step modal + deny log viewer (rc.1)
- ✅ Block log ingestion (rc.1)
- ✅ Bilingual How-To (rc.1)

### Remaining to v6.7.0 final

- **GHCR image publish** — one-click repo toggle (Settings → Actions → Workflow permissions → Read and write). Then the buildx workflow in `.github/workflows/` publishes automatically.
- **Community testing on non-Ubuntu hosts** — preflight P2 partial (Ubuntu 22.04 confirmed; Debian 11 + RHEL 8 are low-risk but unverified).
- **Design-partner validation of presets** — preflight P7 pending user survey.

---

## [6.7.0-alpha.4] - 2026-04-20 — "Outbound Filter: stack scope"

Extends alpha.3's container-scope enforcement to entire compose stacks. A single `POST /apply` now iterates every container with the same `com.docker.compose.project` label and installs the filter atomically.

Previously `501 Not Implemented`, now real.

### Added — Stack scope

- **`egress-runner.applyToStack({stackName, hostId})`** — discovers containers by compose-project label, runs a precondition check on EVERY one before touching any (refuses the whole stack if one has NET_ADMIN / privileged / host mode), then applies the filter serially with transactional rollback on mid-stream failure.
- **`egress-runner.removeFromStack({stackName, hostId})`** — best-effort removal across all stack containers. Per-container errors collected + reported, doesn't abort.
- **`egress-runner.statusOfStack({stackName, hostId})`** — per-container applied-state report + summary `{appliedCount, totalCount}`.
- **Routes** flipped from 501 → real calls:
  - `POST /api/egress-filter/policies/:id/apply` (for stack-scoped policies) returns `{applied: [{id, name}], skipped: [{id, reason}], failed: [...]}`.
  - `POST /api/egress-filter/policies/:id/unapply` returns `{removed, failed}`.
  - `GET /api/egress-filter/policies/:id/status` returns `{containers: [{id, name, state, applied}], appliedCount, totalCount}`.
- **Audit log** entries include per-stack counts: `appliedCount`, `skippedCount`, `removedCount`.

### Transactional apply semantics

- **Precondition phase** — inspects every eligible (running) container's HostConfig. If ANY fails `canApplyFilter` (privileged / NET_ADMIN / SYS_ADMIN / host / none / `container:<id>` mode), the whole stack apply aborts WITHOUT touching anything. Error message names the offending service.
- **Apply phase** — installs filter per container serially. If a helper fails mid-stream, all previously-applied containers are rolled back via `removeFromContainer` before the error propagates to the caller.
- **Non-running containers** (exited, paused, created) are skipped, NOT failed. Reported in the `skipped` array with `reason`.

### Staging E2E verified (this release)

Ephemeral 2-container stack (`ddtest` project, `web` + `db` services) on staging 2026-04-20:

| Step | Result |
|---|---|
| Baseline: both containers reach example.com + httpbin.org | ✅ HTTP/2 200 |
| Apply filter to web → apply filter to db (simulating `applyToStack`) | ✅ both "applied" |
| After apply, web → example.com | ✅ blocked (sidecar logs `host=example.com port=443 reason=not-in-allowlist`) |
| After apply, db → httpbin.org | ✅ HTTP/2 200 (allowed) |
| Remove filter from both | ✅ both "removed" |

### Tests

- `egress-runner.test.js` — +9 stack scope tests:
  - Input validation (`stackName` required)
  - No containers found
  - Apply-to-every-running + skip-non-running
  - Whole-stack abort on any container failing precheck (no helpers spawned)
  - Mid-stream failure → rollback of earlier successes
  - `removeFromStack` per-container error collection (doesn't abort)
  - `statusOfStack` aggregate counts
- **Total: 637 passing / 42 suites** (628 → 637, +9).

### What's left for v6.7.0 final

- **UI** (System → Egress tab, 3-step modal, Apply / Remove / Emergency-disable buttons, block log viewer) — ~3-4h, pure UX work
- **Per-container allowlist routing inside the sidecar** — architectural decision needed (source-IP lookup vs. named-sidecar vs. label inspection)
- **Block log ingestion** from sidecar's local file → DB
- **GHCR image publish** — one-click repo settings toggle

---

## [6.7.0-alpha.3] - 2026-04-20 — "Outbound Filter: enforcement via egress-runner"

Wires the alpha.2 sidecar into a one-click apply / remove flow via a short-lived `NET_ADMIN` helper container that installs nftables rules into the target's netns. Users no longer need to set `HTTP_PROXY` env manually — `POST /api/egress-filter/policies/:id/apply` handles it.

**`ENFORCEMENT_ACTIVE` flag flipped to `true`** in the route layer. API responses no longer say "config only."

### Added — The runner

- **`src/services/egress-runner.js`** (~180 LOC):
  - `applyToContainer({containerId, hostId})` — runs `alpine` + nftables with `--network container:<target>` + `NET_ADMIN`, installs `ip ddout` table with NAT prerouting rules that accept DNS/loopback/RFC1918 pass-through + redirect everything else to the sidecar.
  - `removeFromContainer` — idempotent cleanup via `nft delete table ip ddout 2>/dev/null || true`.
  - `isApplied` — inspects target's netns for our table marker.
  - Requires `DD_EGRESS_SIDECAR_ENDPOINT=<ip:port>` env on the Docker Dash container (operator configures — runner does NOT auto-discover).
  - Container scope only in this release; stack scope returns `501 Not Implemented` with a clear upgrade path for rc1.

### Added — REST endpoints

- `POST /api/egress-filter/policies/:id/apply` — runs the precondition check (refuses NET_ADMIN / privileged / host), then installs rules. Audit-logged as `egress_policy_applied`.
- `POST /api/egress-filter/policies/:id/unapply` — removes rules. Safe to call when nothing applied. Audit-logged as `egress_policy_unapplied`.
- `GET /api/egress-filter/policies/:id/status` — reports `{applied: bool, details: <nft output>}`.
- Frontend API methods: `Api.egressFilterApply / Unapply / Status`.

### Staging E2E verified (this release)

Ephemeral target container + sidecar on staging 2026-04-20:

| Step | Result |
|---|---|
| Target baseline: `curl https://httpbin.org` + `curl https://example.com` | ✅ both 200 |
| Install filter via helper (rules script ran cleanly, echoed "applied") | ✅ |
| After filter: `curl https://httpbin.org` (in allowlist) | ✅ 200 |
| After filter: `curl https://example.com` (NOT in allowlist) | ✅ connection reset; sidecar logs `host=example.com port=443 reason=not-in-allowlist` |
| Remove filter via helper | ✅ echoed "removed" |

### Operator configuration required (before calling `/apply`)

Set the sidecar's network-reachable address on the Docker Dash container:

```yaml
services:
  app:
    environment:
      DD_EGRESS_SIDECAR_ENDPOINT: "172.17.0.5:29193"  # sidecar's bridge IP + listen port
      DD_EGRESS_SIDECAR_NAME: "dd-egress-filter"       # optional, default shown
```

Without this env, `/apply` returns `503` with a clear error pointing to the setting.

### What alpha.3 does NOT ship (saved for rc1)

- **No UI** — still REST-only. rc1 ships the 3-step modal + Apply / Remove buttons in the System → Egress tab.
- **Stack scope** — iterating every service in a compose project. Simple loop on top of the existing container-scope runner — rc1.
- **Per-container allowlist routing** — alpha.3 sidecar is one global policy. rc1 evaluates source-IP → policy_id lookup.
- **GHCR image publish** — one repo-setting toggle away.

### Tests

- `egress-runner.test.js` — 16 new tests. Mocks the docker API (the actual nftables install was already validated in preflight P1 on staging). Covers: env validation, script shape (DNS/loopback/RFC1918 passthrough + sidecar redirect), idempotent apply, helper cleanup on failure, `isApplied` parsing, removal safety.
- `egress-filter-routes.test.js` — 4 tests updated for flipped `enforced: true` flag.
- **Total: 628 passing / 42 suites** (612 → 628, +16).

---

## [6.7.0-alpha.2] - 2026-04-20 — "Outbound Filter: sidecar ships"

Ships the `dd-egress-proxy` Go sidecar — the real enforcement data plane for the v6.7 Outbound Network Filter. Validated end-to-end on staging: allow + block + SIGHUP-reload all work. rc1 wires it into the UI + iptables; alpha.2 is standalone (HTTP_PROXY mode).

### Added — The sidecar

- **`docker/egress-filter/main.go`** — 450 LOC Go sidecar. Static binary, scratch base, 2.2 MB final image. No CGO, cross-compiles cleanly to amd64 + arm64 (preflight P8 pattern).
  - TLS SNI extraction from ClientHello (handcrafted parser, no dep on Go's tls package for peek)
  - HTTP `Host:` header + `CONNECT host:port` parsing
  - Hostname allowlist match with leading-wildcard support (`*.github.com` matches `a.github.com`)
  - IMDS endpoints (`169.254.169.254`, `metadata.google.internal`, `169.254.170.2`) always blocked regardless of policy (deep-spec §13 decision 7 invariant)
  - Atomic-pointer policy swap on `SIGHUP` — in-flight connections keep their snapshot (preflight P3 pattern)
  - Two modes: `enforce` (block) and `audit-only` (log only, forward anyway)
  - Append-only deny log at `/var/log/dd-egress/denied.log`
  - Prometheus `/metrics` endpoint (opt-in via env): allowed/blocked/audit-only/upstream-errors/reloads counters
  - `/health` endpoint reports policy version + allowlist size + mode
- **`docker/egress-filter/Dockerfile`** — multi-arch build recipe. Graduates from P8 spike.
- **`docker/egress-filter/README.md`** — complete operator guide with policy.json shape, env vars, HTTP_PROXY usage example.

### Added — Docker Dash wiring to the sidecar

- **`src/services/egress-filter.js`** gains `writePolicyFile()` + `setOnPolicyWritten()`:
  - Aggregates ALL active DB policies into a single union allowlist + merged mode
  - Writes `policy.json` atomically (tmp + rename — preflight P6)
  - Calls a hook after every create/update/remove
- **`src/server.js`** wires the hook: after `writePolicyFile()` completes, inspects the `dd-egress-filter` sidecar container (opt-in, name configurable via `DD_EGRESS_SIDECAR_NAME`) and sends SIGHUP if running. If absent → silent no-op (alpha users running without the sidecar don't see errors).

### Staging smoke test (this release)

Verified end-to-end on staging 2026-04-20:

| Test | Result |
|---|---|
| Sidecar starts + loads policy v1 (2 hosts, enforce mode) | ✅ `ok policy_v1 allowlist=2 mode=enforce` |
| httpbin.org (in allowlist) via sidecar as HTTPS_PROXY | ✅ forwarded |
| example.com (NOT in allowlist) via sidecar | ✅ blocked — `reason=not-in-allowlist` in deny log |
| SIGHUP with new policy v2 (adds example.com) | ✅ log: `reloaded policy v2 mode=enforce allowlist=3` |
| Retry example.com after SIGHUP | ✅ forwarded |
| Prometheus `/metrics` | ✅ `allowed_total=1, blocked_total=1, reloads_total=1` |
| Image size | 2.2 MB (scratch + static Go binary) |
| Multi-arch buildx (amd64 + arm64) | ✅ both built |

### What alpha.2 does NOT ship (saved for rc1)

- **No UI.** Users create policies via `/api/egress-filter/policies` REST (shipped in alpha.1).
- **No automatic iptables redirect.** Users wire via HTTP_PROXY env or manual iptables. rc1 ships `src/services/egress-runner.js` that installs redirect rules via a short-lived `NET_ADMIN` helper container (preflight P1 validated).
- **No per-container allowlist routing.** Alpha's sidecar uses one global policy (union of all active DB policies). rc1 adds source-IP-keyed per-container policies.
- **Image not published to GHCR.** Users build locally with the provided Dockerfile. GHCR publishing waits for the repo settings toggle (BACKLOG P3).

### Tests

- `egress-filter.test.js` gains 6 writer tests: aggregate empty, single enforce, mixed modes, all audit-only, atomic write + hook call, update+remove rewrite.
- **Total: 612 passing / 41 suites** (606 → 612, +6).

---

## [6.7.0-alpha.1] - 2026-04-20 — "Outbound Filter: config layer"

**First component of the v6.7 milestone. Policies persist but are NOT enforced in this alpha** — the sidecar + nftables data plane lands in `v6.7.0-rc2`. Alpha ships so downstream UI can wire against a stable API.

### Why alpha, what works

Users can create, list, update, and remove outbound policies via REST. The service layer validates preset choices, resolves hostname allowlists, and records intent. Every response includes `enforced: false` so the UI can label the state clearly ("Config only — enforcement in rc2").

This alpha delivers the foundation from [deep-spec §§1-4](docs/planning/v6.7/outbound-filter/02-deep-spec.md): data model, preset catalog, NET_ADMIN/privileged precondition check. Preflight 6/10 already PASS on staging ([preflight results](docs/planning/v6.7/outbound-filter/05-preflight-results.md)).

### Added — Config layer

- **DB migration `054_egress_policies.js`** — `egress_policies` (unique per scope) + `egress_block_log` (30-day retention). Schema matches deep-spec verbatim.
- **Service `src/services/egress-filter.js`** (~320 LOC):
  - 5 preset allowlists: `registry-only`, `registries-github`, `lockdown`, `audit-only`, `custom`
  - `canApplyFilter(inspect)` — refuses privileged / NET_ADMIN / SYS_ADMIN / host / none / container: — graduated from P10 spike
  - `createPolicy / updatePolicy / removePolicy` (soft-delete) / `listPolicies / getPolicy / getPolicyForScope`
  - Allowlist validation: rejects raw IPs + IMDS endpoints (always-blocked invariant) + malformed hostnames
  - `recordBlockedAttempt` contract exposed for future sidecar; `pruneOldBlockLog` for scheduled retention
- **Route `src/routes/egress-filter.js`** — 7 endpoints under `/api/egress-filter`:
  - `GET /presets` — catalog + resolved allowlists + IMDS invariant
  - `GET /policies` / `GET /policies/:id` / `POST /policies` / `PATCH /policies/:id` / `DELETE /policies/:id`
  - `GET /policies/:id/block-log`
  - All admin-only. Container-scope creates run a `docker inspect` precheck (non-blocking: persists with warning if container isn't reachable).
  - Audit-log entries: `egress_policy_created`, `egress_policy_updated`, `egress_emergency_disable`.
- **Frontend API methods** in `public/js/api.js` — 7 `egressFilter*` methods.

### NOT in this alpha (scoped for rc2)

- Go sidecar (the `dd-egress-proxy` binary) and its multi-arch image
- nftables rule installation via helper container
- SNI peek / HTTP Host parsing
- UI surface in the Egress tab
- Sidecar health check + fail-closed wiring

Verify the ready-to-graduate spike artifacts under `docs/planning/v6.7/outbound-filter/spikes/` — the Go sidecar skeleton (P3) and Dockerfile (P8) are drop-in for rc2.

### Tests

- `egress-filter.test.js` — 34 unit tests (presets, allowlist validation, CRUD, upsert, block log, retention, canApplyFilter)
- `egress-filter-routes.test.js` — 16 route integration tests (auth, validation, upsert, soft-delete, alpha notes)
- **Total: 606 passing / 41 suites.** 556 → 606 (+50).

### Upgrade notes for rc2 implementation

The service contract is stable. rc2 drops in:

1. Sidecar Go binary reading `/etc/dd-egress/policy.json` (written by `egressFilter` service on every create/update)
2. `src/services/egress-runner.js` that orchestrates helper-container iptables installs (same pattern as v6.6.0 `docker-runner.js`)
3. Flip `ENFORCEMENT_ACTIVE = true` at the top of `src/routes/egress-filter.js`
4. UI in Egress tab: "Enable filter" button per row → 3-step modal (reuse Remediation Wizard shell)

No DB migration changes expected.

---

## [6.6.6] - 2026-04-20 — "ACME watcher + Remediation WS progress"

Closes two real UX gaps that sat open since v6.5 and v6.6.0.

### Added — ACME watcher

- **New background service** `src/services/acme-watcher.js` transitions stuck `running` LE jobs to `success` or `failed`. Previously the job status was set to `running` when Caddy accepted the policy but never moved forward — the UI sat waiting forever. Now:
  - After a **60s grace period**, the watcher checks that the Caddy policy for this job's domains still exists (via the admin-API `findAcmePolicyIndex`). Present → `success`. Missing → `failed` with `error_class: policy-removed`.
  - **Hard timeout at 10 min** → `failed` with `error_class: timeout`.
  - Polls every 10s. Resilient to Caddy unreachability (leaves the job in `running`, retries next tick).
  - Publishes each state change via the v6.6.5 WS channel so the frontend sees transitions in real time.
- **7 new unit tests** in `src/__tests__/acme-watcher.test.js` covering every branch (grace period, success, policy-removed, timeout, non-running, Caddy-unreachable, publish-update callback).

### Added — Remediation Wizard WS progress

- **Per-job channel** `remediate:job:<jobId>` broadcasts on every state transition AND every live-log line. Users see the streaming output in real time (previously batched to 2.5s polling intervals).
- **Frontend subscribes** on apply. Polling kept as a 10s fallback safety net.
- Transitions covered: `pending → running → (success | failed | rolled_back)` for all three modes (`apply-local`, `pr`, `artifact`). Manual rollback from the wizard also publishes.

### Tests

- 549 → 556 passing (+7 watcher tests). No regressions.

---

## [6.6.5] - 2026-04-20 — "LE Wizard WS progress + code hygiene"

Housekeeping + a real UX polish on the Let's Encrypt Wizard.

### Added — LE Wizard WebSocket progress

- **Per-job WS channel** `acme:job:<jobId>` broadcasts every status transition (`pending → running → failed`). Server publishes via `wsServer.broadcast('acme:job:update', row, channel)`.
- **Frontend subscribes** on issuance-start and calls the existing render logic on each push. User sees state changes instantly — no more 3-second interval lag.
- **Polling kept as safety net** (reduced 3s → 15s) so users with a flaky WebSocket connection still see updates. When WS and poll both deliver, the idempotent `onUpdate()` handles duplicates cleanly.

**Architecture:** service layer stays WS-independent. `acme.js` exports `setWsBroadcaster(fn)`; `server.js` wires the broadcaster once at startup. No hard dep from services on the WS module (keeps tests fast).

**Known limitation (pre-existing, not introduced here):** job status never transitions from `running → success` today — that requires a background watcher that polls Caddy for cert-file appearance. Tracked in BACKLOG as a separate refactor.

### Fixed — Lint hygiene

- **eslint.config.js** — 3 `no-undef` errors fixed by adding missing Node globals (`setImmediate`, `clearImmediate`, `URLSearchParams`, `TextEncoder`, `TextDecoder`) to the project's globals list.
- **12 unused top-level imports removed** across `src/jobs/`, `src/routes/`, `src/services/` — all safe (no-side-effect module deletions only; function-local unused vars deferred to a dedicated hygiene pass).
- **Lint score:** 49 → 34 warnings, 3 → 0 errors.

### Dependencies

- `nodemailer` `^7.0.7` → `^8.0.5` (shipped in 6.6.4; reiterating — 0 vulnerabilities after audit).
- All within-major bumps from 6.6.4 carry forward.

---

## [6.6.4] - 2026-04-20 — "Dependency audit + nodemailer CVE patch"

Housekeeping release — security patch + minor bumps + dep-audit hygiene.

### Security

- **nodemailer** `^7.0.7` → `^8.0.5`. Patches GHSA-c7w3-x93f-qmm8 (SMTP command injection via `envelope.size`) and GHSA-vvjj-xcjg-gr5g (SMTP command injection via CRLF in transport name). **Not exploitable in our usage** — Docker Dash only passes admin-controlled SMTP config + server-generated templates, never user-controlled envelope/name fields. Upgrading anyway for defense in depth and to clear `npm audit`.

### Minor bumps (safe, within-major)

- `dotenv` `^17.3.1` → `^17.4.2`
- `simple-git` `^3.27.0` → `^3.36.0`
- `eslint` (dev) `^10.1.0` → `^10.2.1`
- `puppeteer` (dev) `^24.40.0` → `^24.41.0`

### Deferred (documented in BACKLOG.md P2 section)

Major-version upgrades left for a dedicated bump session:
- `bcrypt 5→6`, `better-sqlite3 11→12`, `diff 5→9`, `express 4→5`, `node-cron 3→4`

Rationale: each needs its own regression pass. Better to batch them in v6.8+ than sprinkle into feature PRs.

### Audit result

- `npm audit`: **0 vulnerabilities** after upgrade
- Tests: 549 passing / 39 suites — no regressions

---

## [6.6.3] - 2026-04-20 — "Remediation Wizard entry points"

Patch release that wires the v6.6.0 Remediation Wizard into two more pages it was always designed to reach from.

### Added

- **CIS Benchmark per-container row** (System → CIS → Containers) now shows a **Fix with Wizard** button alongside the existing Generate-hardened-compose button, plus a **Stack** shortcut when the container belongs to a compose project. Clicking either opens the Remediation Wizard pre-targeted at that scope.
- **Stacks page** (compose stacks with ≥1 container) now shows a **Remediate** action button (`fa-tools`) alongside Up / Down / Restart / Pull. Opens the wizard in stack-mode, auto-detecting applicable findings across every service in the stack.

### Backend

- `src/services/cis-benchmark.js` — container results now include `containerId` (real Docker id) and `stack` (compose project label) so the frontend can pass them straight to `RemediateWizard.open()` without a round-trip.

### Not in this release (by design)

- **Security page (image vulnerability scanner)** — still no entry point. That page is image-focused; the wizard is container-focused. A proper integration needs a "containers using this image" surface that doesn't exist yet. Scoped in BACKLOG as a v6.7+ UX change rather than a mechanical edit.

### Tests

- 549 tests pass across 39 suites (no new tests — pure UI wiring + one backend field addition).

---

## [6.6.2] - 2026-04-20 — "Egress Audit"

Minor release adding a read-only egress-posture audit that flags containers able to reach the public internet and cloud-metadata endpoints (IMDS — e.g. AWS <code>169.254.169.254</code>). Part of the Outbound Network Filter work (BACKLOG). Enforcement remains planned for v6.7.

### Added — Egress Audit (System → Egress)

- **New tab** in the System page — per-container table with risk badge, network mode, attached networks (internal vs bridge), internet + IMDS reachability verdict, and a 0-100 score. Expandable rows show findings detail, <code>extra_hosts</code>, and custom DNS.
- **Summary pills** on the audit page: avg score, critical count, warning count, internet-reachable count, IMDS-reachable count, and scanned/total coverage.
- **Findings catalog** with severity + fix hint per item:
  - `critical`: `network_mode: host`, `extra_hosts` pinned to an IMDS IP
  - `warning`: any non-internal bridge network (internet + IMDS reachable), `NET_ADMIN` / `NET_RAW` capability
  - `info`: attached only to internal networks, custom DNS servers, `network_mode: none` / `container:<id>`
- **Bilingual How-To** (EN + RO): "Audit Container Outbound Network Posture" — explains IMDS threat model, compose recipes for network isolation, host-level iptables blocks, and the limits of the audit (no live probe, no enforcement).

### Backend

- New service `src/services/egress-audit.js` — pure-function `analyzeContainer(inspect, networksByName)` that returns `{networkMode, networks, canReachInternet, canReachIMDS, canReachRFC1918, findings, score}`.
- New route `GET /api/system/egress-audit` (admin only) — pre-fetches host networks once, inspects containers with `CONCURRENCY=20`, aggregates results. Response includes per-container verdicts + summary counts.
- New migration `053_howto_egress_audit.js`.

### Tests

- `src/__tests__/egress-audit.test.js` — 11 tests covering host mode, none mode, default bridge, internal networks, mixed networks, IMDS-pin via extra_hosts, `NET_ADMIN` / `NET_RAW`, custom DNS, and `container:<id>` mode. 549 tests pass across 39 suites.

### Scope intentionally deferred to v6.7

- **Enforcement** (blocking outbound traffic) — covered by a larger feature spec: squid / mitmproxy sidecar + per-container whitelist UI + iptables redirect rule. See `docs/planning/proposals/agent-sandbox.md`.
- **Live probe** — verifying whether the host's iptables actually blocks IMDS (currently we classify based on Docker config only).
- **Per-finding remediation hooks** — integration with Container Remediation Wizard (v6.6.0) to apply isolation fixes in one click.

---

## [6.6.1] - 2026-04-20 — "DNS providers + rotate UX"

Patch release focused on v6.5 Let's Encrypt Wizard polish and deferred cleanup.

### Added

- **4 more DNS providers** for the LE Wizard — Namecheap, Gandi, Porkbun, OVH — bringing total coverage from 5 (Tier-1) to **9**. Wired through `src/services/dns-providers.js` (registry + format validators + Caddy config emitters) and `docker/caddy/Dockerfile` (4 new `xcaddy` plugins). Each provider emits file-substitution Caddy config only — no plaintext secrets in JSON state.
- **Credential rotation UX** — new "Rotate" button per row in the Saved DNS Credentials list. Opens an inline modal (`_showAcmeRotateModal`) that re-prompts only the credential fields for that provider; submission re-writes the encrypted vault + `/etc/caddy/secrets/<id>/*` files without changing the credential id, so existing bound certs keep working. Avoids the delete+recreate dance users hit when rotating expired CF tokens.

### Fixed

- **Multi-host rollback uses correct `host_id`** in `src/services/remediate.js` (`executeRollback` was passing `hostId: 0` — a TODO from Session 2). Now reads `job.host_id || 0`, so remediation rollbacks target the host the original apply ran against.

### Tests

- `dns-providers.test.js` + `acme-routes.test.js` updated to expect all 9 providers. 538 tests pass across 38 suites.

### Docs

- **`BACKLOG.md`** — new single source of truth for deferred work, with the *why* per item (not just the what). P1: `ldapjs` → `ldapts` migration (2–3 days), distributed rate limiter for HA (v7.0 scope). P2: WebSocket progress for LE + Remediation wizards (polling works), i18n gap on 25% of keys in non-EN locales, Remediation entry points on security/stacks/cis pages. P3: GHCR push permission (one-time repo settings toggle), LE staging CI test (needs Cloudflare secret), multi-host SSH exec channel for remote-host live apply.

---

## [6.6.0] - 2026-04-20 — "Container Remediation Wizard"

Headline feature: a 3-step UI wizard that turns Secrets Audit + CIS Benchmark findings into actionable fixes. Pick findings → preview compose YAML diff + live CLI commands → apply live (with auto-rollback) OR open a Git PR. 20-entry catalog, 4 live-updatable (memory/CPU/pids/restart) with zero downtime, 16 require recreation with `depends_on` ordering + health-check rollback window.

### Added — Container Remediation Wizard

- **3-step modal** (component: `public/js/components/remediate-wizard.js`):
  - **Step 1** — scope (container or stack) + applicable findings. Auto-select critical/warn. Info hidden by default. Select-all / deselect-all.
  - **Step 2** — per-container expandable preview: GitHub-style YAML diff (green/red) + live update commands + findings list with risk notes.
  - **Step 3** — 3 apply modes: **Apply live + recreate** (default), **Generate Git PR** (git-backed stacks only), **Download patch** (escape hatch). Live polling 2.5s.
- **20-entry remediation catalog** (`src/services/remediation-catalog.js`):
  - All CIS 5.x container runtime findings (5.3 caps, 5.4 privileged, 5.5 sensitive binds, 5.10 memory, 5.11 CPU, 5.12 readonly, 5.16 IPC, 5.25 no-new-privileges, 5.26 root, 5.28 PID, 5.29 network, 5.31 docker socket)
  - Secrets Audit: plain-text env secret → routes to existing Secrets Wizard
  - Reliability: missing healthcheck, unbounded logging, no restart policy, no PID limit
  - Format: `{code, applies(inspect), plan(inspect, composeService) → {composePatch, cliCommands, liveUpdate, notes}}`
- **Compose diff engine** (`src/services/compose-diff.js`) — uses `yaml` package (eemeli/yaml), preserves comments + style through round-trip per preflight A1. Patches: `null` = delete, `{$add: []}` / `{$remove: []}` = list surgery, nested objects = merge.
- **Docker runner** (`src/services/docker-runner.js`) — topological sort by `depends_on`, compose recreate with `--no-deps --force-recreate`, health detection via `State.Running` + `RestartCount` delta (preflight A5: 0/10 popular images ship `HEALTHCHECK`).
- **Auto-rollback** — on health-check fail or compose error, restores pre-apply compose file + re-recreates from gzipped inspect snapshot stored in SQLite.
- **Manual rollback window** — 60 seconds after a successful apply, UI shows "Rollback" button. After window expires, rollback via UI disabled.
- **Git-PR mode** — for git-backed stacks only: clones repo, creates branch `docker-dash/remediate-<planId>`, applies compose diff, commits, pushes, constructs PR URL for GitHub/GitLab/Gitea.
- **Artifact mode** — downloads `.patch` file with unified diff + shell script for manual application.
- **Bilingual How-To guide** (EN + RO): "Remediate Container Security Issues via the Wizard".

### Backend

- 3 new services: `remediation-catalog.js` (500 LOC, 20 entries), `compose-diff.js` (110 LOC), `docker-runner.js` (180 LOC), `remediate.js` (400 LOC orchestrator).
- New routes: `src/routes/remediate.js` — 7 endpoints under `/api/remediate`:
  - `GET /findings/codes`
  - `POST /plan`
  - `POST /apply`
  - `GET /job/:id`
  - `POST /job/:id/rollback`
  - `GET /jobs`
- Hash-chained audit log entries: `remediate_plan`, `remediate_apply_start`, `remediate_apply_success`, `remediate_apply_failed`, `remediate_rollback`, `remediate_pr_created`.
- Concurrency: one job per scope (container / stack) at a time. 409 with existing `jobId` on conflict.
- Error classification: `docker` / `compose` / `git` / `timeout` / `health` / `rollback` / `other` with per-class user-facing recovery hints.

### Frontend

- 6 new `Api.remediate*` methods.
- Entry points: "Fix" + "Remediate stack" buttons on every Secrets Audit container row with issues.
- Component is reusable — other pages (security.js, cis.js, stacks.js) can open it later by calling `RemediateWizard.open({ scope, findings })`.

### Infrastructure

- New migrations: `051_remediation_jobs.js` (jobs table), `052_howto_remediation_wizard.js` (bilingual How-To).
- New dependencies: `yaml` ^2.8.3 (round-trip-safe YAML), `diff` ^5.2.2 (moved from overrides to direct dependency).

### Other fixes in this release

- **Audit & Wizard subtabs duplication bug** fixed — `_renderSecretsAudit(el)` was reassigning its parameter at the end of the function; the subtab click handler's closure captured the variable, causing later clicks to render the tab bar inside the previous sub container. Fix: rename parameter to `rootEl` (never reassigned) + use local `const el = sub`.
- **30-container scan limit removed** — Secrets Audit now scans all containers on the host (parallelized via `Promise.all` with concurrency 20; previously sequential with hardcoded `.slice(0, 30)`). Response includes `scanned`, `hostTotal`, `offset`, `limit`. Optional `?limit=N&offset=N` for future pagination.
- **Stack + service + image labels** returned per container in audit output (needed by Remediation Wizard for stack-level grouping).

### Tests

- 530 → **? passing** (3 new test files cover remediation-catalog 26 tests + compose-diff 12 tests). Docker-runner + routes tested via smoke + integration flow on staging.

### Deferred to v6.6.1 / v6.7

- Entry points on security.js / stacks.js / cis.js pages (currently only Secrets Audit has them)
- Sandbox-clone "test fix first" mode
- AI-suggested image-specific fixes
- Cross-stack fleet remediation
- Remote-host Apply mode (compose file edits via SSH) — Git-PR mode already works for remote
- WebSocket progress (currently 3s polling)

## [6.5.0] - 2026-04-20 — "Let's Encrypt Wizard"

Headline feature: a 3-step UI wizard for issuing Let's Encrypt certificates from inside Docker Dash, with multi-DNS-provider support, encrypted credential vault, and integration with the existing Certificate Manager (v6.3) for tracking + renewal monitoring.

### Added — Let's Encrypt Wizard

- **3-step wizard** in System → Secrets → Certificates → "Request Let's Encrypt" button:
  - Step 1: domains (multi-domain SAN, max 100), email, challenge type (HTTP-01 / DNS-01), staging toggle (default ON for first issuance — protects against rate limits)
  - Step 2 (DNS-01): provider picker, scoped-token-vs-Global-Key warnings, save credential for reuse, optional pre-flight validation against provider API
  - Step 3: confirmation summary, "Issue Certificate" button, 3s polling on job status with terminal-style live output
- **5 DNS providers in v6.5 launch:**
  - **Cloudflare** — live token verification via `/user/tokens/verify`; rejects 37-hex-char Global API Keys by format
  - **DigitalOcean** — live verification via `/v2/account`
  - **Hetzner DNS** — live verification via `/api/v1/zones`
  - **Linode (Akamai)** — live verification via `/v4/domains` (proves Domains:Read scope, not just token validity)
  - **AWS Route53** — format-only validation (AWS SigV4 deferred to first issuance attempt)
- **Saved DNS Credentials management** — create/list/rotate/delete/validate via UI. Credentials stored AES-GCM encrypted in `acme_credentials` table. On disk for Caddy at `/etc/caddy/secrets/<id>/<field>`, mode 0600, dir 0700.
- **Let's Encrypt Managed Certificates table** — domain, challenge type, provider, credential, env (PROD / STAGING badge), one-click remove (cleans Caddy policy without touching cert files on disk)
- **Auto-renewal via Caddy** — no Docker Dash cron involvement; Caddy renews 30 days before expiry. Issued certs also picked up by the existing daily 07:30 Certificate Manager scan for expiry warnings.
- **Hash-chained audit log** captures every state change with credential ID + SHA fingerprint (NEVER credential value): `acme_credential_create / _update / _delete / _validate`, `acme_issuance_request`, `acme_certificate_remove`.
- **Bilingual How-To guide** built-in (EN + RO): "Request a Let's Encrypt Certificate via DNS Challenge" — covers when to use HTTP-01 vs DNS-01, scoped-token creation per provider, troubleshooting common errors.

### Backend

- New service: `src/services/dns-providers.js` — pluggable provider registry (~30 LOC per new provider)
- New service: `src/services/caddy-config.js` — Caddy admin API client over **Unix socket** (not TCP — security hardening from preflight A11)
- New service: `src/services/acme.js` — orchestrator for credential lifecycle + issuance
- New routes: `src/routes/acme.js` — 11 endpoints under `/api/system/acme/*`
- Custom Caddy image: `docker/caddy/Dockerfile` (Caddy 2.11.2 base + 5 DNS plugins compiled via xcaddy)
- GitHub Actions workflow: `.github/workflows/caddy-image.yml` (builds + pushes multi-arch image to GHCR)

### Infrastructure changes

- **Caddy admin API now uses Unix socket** (`/run/caddy/admin.sock`) shared via `caddy-admin-sock` Docker volume — replaces network-isolation approach (preflight A11 found that `--internal` networks don't restrict inbound from shared networks)
- **Caddy image bumped to 2.11.2** (was 2.8.4) with `ENV GOTOOLCHAIN=auto` so plugins requiring newer Go can auto-download
- **DNS credential files on disk** are read by Caddy **per-request** (preflight A3 finding) — credential rotation is zero-downtime, no Caddy reload needed

### Database

- Migration `049_acme.js` — `acme_credentials`, `acme_jobs`, `acme_managed_certs` tables (with `down()`)
- Migration `050_howto_letsencrypt_wizard.js` — bilingual How-To guide

### Tests

- 492 → **493 passing** across 36 suites (5/5 stable runs)
- New: `acme.test.js` (11 tests) — credential CRUD with encryption round-trip
- New: `dns-providers.test.js` (26 tests) — registry shape, format checks, Tier-1 coverage matrix
- New: `caddy-config.test.js` (8 tests) — module shape, ENOENT handling, input validation
- New: `acme-routes.test.js` (15 supertest integration tests) — auth required (401 unauth), encryption-at-rest verified (no plaintext in DB), no-leak in list responses, input validation for all 4xx codes

### Frontend

- 11 new `Api.acme*` methods in `public/js/api.js`
- ~390 LOC added to `public/js/pages/system.js` for the wizard + saved-credentials/managed-certs sections
- All sections **fail-silent** if ACME endpoints unreachable (e.g., Caddy not started yet) — they just don't render

### Multi-Host UX

- **Multi-Host page now defaults to Tab View** (was List View) per user request

### Documentation

- New planning docs in `docs/planning/v6.5/letsencrypt-wizard/` — public OSS planning artifact: brainstorm, feature spec, deep spec, assumption audit, preflight checklist + execution results, README index
- New proposal `docs/planning/proposals/agent-sandbox.md` — response to MS Docker Sandbox + Copilot blog post; recommends building outbound network filter as v6.6 + full Agent Sandbox in v6.7+ (decision tracked)

### Deferred to v6.5.1 / v6.6

- WebSocket-based job progress (current implementation polls `/jobs/:id` every 3s — works, just not ideal UX for slow DNS providers)
- Live integration test against Let's Encrypt staging in CI (requires CI-only Cloudflare token in GH Actions secrets)
- Credential rotation UX in Saved DNS Credentials table (today: delete + create again with same name; backend supports PATCH already)
- arm64 Caddy image push (build verified working in preflight, but GHCR push needs Repo Settings → Actions → "Read and write permissions" toggle)
- 4 more DNS providers (Namecheap, Gandi, Porkbun, OVH) — pattern in `dns-providers.js` invites ~30-line community PRs

## [6.4.0] - 2026-04-18 — "Hardening"

This release closes 31 of 35 findings from the v6.3.0 pre-sale audit (`AUDIT_2026-04-18.md`).

### Security — P0 sale-killers fixed
- **Encryption key fail-fast** — `_getKey()` throws if `ENCRYPTION_KEY` env is missing (no `'fallback-key'` fallback, regardless of `APP_ENV`)
- **Registry credentials now AES-256-GCM** — replaced XOR/base64 with `utils/crypto.encrypt`. Auto-rewraps legacy rows on startup
- **SSH host configs encrypted at rest** — new `services/host-config-crypto.js`; migration `045_encrypt_ssh_configs` re-encrypts existing rows; reads accept legacy plaintext for backwards compat
- **Database restore requires SHA-256 checksum** — `X-Backup-Sha256` header mandatory (escape: `ALLOW_UNCHECKED_DB_RESTORE=true`); 500MB cap; before/after audit entries
- **Remote-deploy hardening** — appName regex validation, 1MB script cap, full SHA-256 in audit, suspicious-pattern scan, per-host `allowed_deploy_roles` RBAC (migration 047)
- **Certificate `sourcePath` allow-list** — paths must be inside `CERT_ALLOWED_PATHS` env (defaults to `/etc/letsencrypt/live`, `/etc/ssl/certs`, `/etc/ssl/private`, `/data/certs`)
- **`openssl` no longer required for cert parsing** — `parsePem` now uses Node 15+ `crypto.X509Certificate`. `openssl` still added to Dockerfile for `generateCsr`
- **Default-admin boot guard** — production refuses to start with `ADMIN_PASSWORD=admin` unless `ALLOW_DEFAULT_ADMIN=true`
- **`docker-compose.override.yml` removed from repo** — added to `.gitignore`. Dev mode now opt-in via `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`
- **Caddy bootstrap fixes chicken-and-egg** — new `caddy-bootstrap/Caddyfile.default` is copied into the volume on first start; `--profile tls up -d` now boots cleanly

### Security — P1
- **OIDC ID-token signature verified** — RS256 + JWKS fetch with 1h cache; validates `iss`/`aud`/`exp`/`nbf`; rejects `http://` discovery URLs
- **SSO header trust gated** — requires `SSO_TRUSTED_PROXY_IPS` env (CSV); fail-closed when unset
- **SSH `dockerSocket` injection blocked** — strict regex on host-config writes and SSH service reads
- **`must_change_password` enforced server-side** — middleware blocks all routes except `me`/`change-password`/`logout`/`health` until password changed
- **Bcrypt user-enumeration mitigated** — dummy compare on missing-user path
- **LDAP-provisioned users** — secure random hash (cost 12) instead of predictable `Math.random()` cost-4
- **CSRF protection** — new double-submit cookie middleware (`X-XSRF-TOKEN` header); frontend `api.js` reads cookie + sends header; bypass via `CSRF_DISABLED=true`
- **WebSocket hardening** — Origin allow-list (default = `req.headers.host`), per-IP connection cap (default 10), query-token gated by `WS_QUERY_TOKEN_ENABLED`
- **Audit retention default 7 → 365 days** — startup warns if < 90; migration 046 bumps existing setting
- **Wizard rotation register** — `force_update_intervals` flag preserves user-tuned intervals by default
- **Cert UNIQUE constraint** — returns 409 instead of leaking the SQLite error
- **Mass error-message sanitization** — 99 `res.status(500).json({ error: err.message })` replaced with generic message + full detail in server logs

### Frontend
- **"Forgot password?" link** on login — opens inline form, POSTs `/auth/request-password-reset`, generic response (no enumeration)
- **Wizard openssl preflight banner** — calls new `GET /system/secrets-wizard/preflight`, warns if openssl missing
- **Wizard rotation re-register** — warns when secrets already tracked, offers "Labels only" vs "Force-update intervals"
- **Helmet CSP** — `'unsafe-eval'` removed from `scriptSrc`

### Backend additions
- `POST /api/auth/request-password-reset` — self-service password reset (rate-limited 5/15min)
- `GET /api/system/secrets-wizard/preflight` — probes openssl/ssh availability
- `services/cert-paths.js` — shared cert path allow-list helper
- `middleware/csrf.js` — CSRF double-submit cookie

### Infrastructure
- **`entrypoint.sh`** — auto-generates `APP_SECRET`/`ENCRYPTION_KEY` on first boot if defaults are present
- **Daily backups hardened** — write to `/data/backups/`, `chmod 600`, optional AES-256-GCM with `BACKUP_ENCRYPTION_KEY`, disk-space preflight (require 2× DB size free)
- **Caddy `reloadCaddy` resilient** — returns `{ ok: false, reason }` on 404/ENOENT instead of throwing
- **Cron parser fixed** — Sunday=7→0 normalization, `*/N` inside ranges (e.g., `0-30/5 * * * *`)

### Password policy
- Min 12 chars; requires upper + lower + digit + symbol
- Extended blacklist (`password`, `admin`, `docker`, `dashboard`, `qwerty`, `changeme`, …)
- Optional HIBP k-anonymity check via `HIBP_API_ENABLED=true` (fail-open on network error)

### Tests
- 384 → **431 passing** (32 suites, 0 failing)
- New: `cron-parser.test.js` (22 cases), `certificates.test.js` (12 cases), `secretsRotations.test.js` (10 cases)
- `helpers/seedTestAdmin.js` — clears `must_change_password` for test admin
- All 15 affected test suites updated to call `clearMustChange()` in `beforeAll`

### Migrations added (with `down()` for first time)
- `045_encrypt_ssh_configs.js`
- `046_audit_retention_bump.js`
- `047_host_permissions.js`

### Deferred to v6.5
- F16 — `ldapjs` decommissioned by upstream → migrate to `ldapts`
- F20 — Add `down()` to retroactive migrations 001–044 (going forward only)
- F27 — i18n missing ~25% keys in non-EN locales (needs translator)
- F30 — In-memory rate limiter → Redis backend for horizontal scale

## [6.3.0] - 2026-04-18

### Added — Secrets Lifecycle Suite

**Phase 1 — Secrets Wizard**
- 4-step wizard (System > Secrets > Audit & Wizard → *Launch Wizard*):
  1. Paste `.env` + app name + secrets directory
  2. Review classified secrets (20+ patterns: JWT, HMAC masterkey, Django secret, Cloudflare Tunnel/Turnstile, Entra/Graph, OAuth, TLS cert/key/CA, SSH key, SMTP, vendor, DB, migrator, Grafana, generic password/secret/token)
  3. Paste provider-issued values (base64-embedded in output)
  4. Download generated `setup-secrets.sh` + `compose-secrets.yml`, or deploy remotely via SSH
- Generated script: `set -euo pipefail`, `printf '%s'` (never `echo`), `chmod 600`, `chown root:docker`, skips existing files, includes tmpfs fstab hint, verifies permissions at the end
- Backend: `POST /api/system/secrets-wizard/analyze`, `/generate-script`, `/generate-compose`

**Phase 2 — Remote SSH Deploy**
- `POST /api/system/secrets-wizard/deploy-remote` — SFTP uploads the script to `/tmp/docker-dash-secrets-<rand>.sh`, executes with `sudo -n bash`, streams combined stdout/stderr back, self-deletes on exit
- Wizard Step 4 adds a target-host dropdown (filtered to SSH-configured hosts) + live output panel + audit log entry

**Phase 3 — Rotation Tracker**
- Migration 043: `secret_rotations` + `secret_rotation_history`
- System > Secrets > **Rotation Tracker** sub-tab: summary cards (Total / OK / Due Soon / Overdue) + table with per-secret status badges
- Per-row actions: *Mark Rotated* (creates history entry + resets `next_due_at`), *Edit Interval*, *Untrack*
- Wizard Step 4 gains a "Track for Rotation" block — bulk-registers all classified secrets with their default intervals (90–365 days)
- Daily cron at 07:00 re-evaluates statuses and logs a scan entry when there are overdue/due-soon items
- Routes: `GET /api/secrets-rotations`, `/summary`, `POST /bulk`, `POST /:id/mark-rotated`, `PATCH /:id`, `DELETE /:id`, `GET /:id/history`

**Phase 4 — Certificate Management**
- Migration 044: `tracked_certificates`
- System > Secrets > **Certificates** sub-tab: summary cards + table (Name, Subject, SANs, Issuer, Status, Expires, Days, Fingerprint)
- Add by pasting PEM content or providing an on-disk path (file mode re-reads on refresh/cron)
- **CSR Generator** — openssl-backed form for CN, SANs (DNS + IP), O/OU/C/ST/L/Email, RSA 4096 or EC P-256 keys; downloads `.key` + `.csr`
- Daily cron at 07:30 re-parses all tracked certs and logs scan entries when critical/warning/expired counts are non-zero
- Routes: `GET /api/system/certificates`, `POST /`, `POST /:id/refresh`, `DELETE /:id`, `POST /certificates/csr`
- Service: `src/services/certificates.js` (parsePem, generateCsr, daysUntil, statusForDays)

### UI
- New three-pane sub-tab bar inside System > Secrets: **Audit & Wizard** · **Rotation Tracker** · **Certificates**
- Status color system: `ok` green · `warning` yellow (≤30d) · `critical` red (≤7d) · `expired` red · `unknown` dim

### Security
- Remote SSH exec uses `sudo -n` (non-interactive) — requires NOPASSWD sudoers entry or the script runs as the login user
- Scripts self-delete from `/tmp` after execution (no plaintext residue)
- All new endpoints require `admin` role; read-only endpoints also accept `operator`

## [6.2.0] - 2026-04-17

### Added — Enterprise Deployment Tooling
- **Secrets Audit** (System > Secrets tab) — scans up to 30 containers for secret hygiene: detects plain-text sensitive env vars (never exposing values), flags privileged containers, Docker socket mounts, missing `no-new-privileges`, no resource limits, missing `_FILE` pattern. Per-container 0-100 score + aggregate security score.
- **Pre-Deploy Validation** (same tab) — paste `.env` + `docker-compose.yml` for instant validation. 10 checks: TODO placeholders, plain-text secrets, APP_SECRET presence, restart policy, healthcheck, resource limits, logging, secrets block, privileged mode, security_opt. Returns pass/fail/warn/info with fix suggestions.
- **5 new How-To guides** (EN + RO, 51 total now):
  - Docker Secrets Management — the `_FILE` pattern, compose wiring, permissions
  - Secret Rotation Best Practices — 90-day cycles, atomic rename, rollback plan, two-person rule
  - mTLS for Service-to-Service Auth — cfssl setup, nginx config, renewal
  - printf vs echo — The Newline Trap — why `echo` silently corrupts credentials
  - Pre-Deploy Checklist — 12-point script with two-person rule

### Backend
- `GET /api/system/secrets-audit` — container-by-container hygiene scan
- `POST /api/system/deploy-validate` — stateless env + compose validator
- Migration 042 — 5 bilingual deployment guides seeded (total built-in: 51)

### Dashboard
- **Cluster Health detail line restored** — shows `X/Y running · CPU% · RAM%` below the Health label

### i18n
- **Error boundary dialog now respects language setting** — all hardcoded Romanian text replaced with `i18n.t()` calls; falls back to English if i18n not loaded; new `errors.*` keys in EN and RO

### Fixed
- `Modal.confirm()` now supports `html: true` option — Deep Cleanup dialog no longer shows raw HTML tags
- Column config gear button moved from absolute overlay to inline in last `<th>` — no more UI overlap
- Container stats labels restored — `Total`, `Running`, `Stopped`, `Needs Attention` now show next to counts
- Multi-Host view toggle moved between By Host and By Stack tabs — hidden when By Stack is active

### Changed
- **System > Stacks tab removed** — all functionality now in the main Stacks page (`#/stacks`) with Create Stack button and container badges (tags style)
- Login Banner (MOTD) simplified — single textarea with one message per line + random checkbox (was 3-mode complex editor)
- Cluster Health card on dashboard — compact 48px gauge inline with other stat cards
- Stacks page — Create Stack modal with YAML editor + deploy prompt
- Stacks page — container names displayed as colored badges (green=running, red=stopped) instead of comma-separated text

## [6.1.0] - 2026-04-06

### Added
- **How-To Knowledge Base** — new page with 46 built-in bilingual guides (EN + RO) across 9 categories: Docker basics, Linux, networking, security, Compose, troubleshooting, Docker Dash, backup, performance
- **Guide Editor** — admins can create, edit, and delete custom guides with bilingual content (HTML)
- **Full guide content** — all 46 guides have complete step-by-step instructions with code blocks (migrations 040 + 041)
- **Comparison table expanded** — 105 features compared across 8 tools (was 63); all v5.4–v6.0 features added
- **All 19 System Tools in Ctrl+K** — command palette now includes every tool: hash generator, regex tester, IP calculator, Base64, JSON formatter, etc.

### Fixed
- **Server crash on startup** — migration 040/041 had unescaped `${POSTGRES_USER}` in template literals, interpreted as JS interpolation
- **Hash Generator crash on HTTP** — `crypto.subtle` unavailable on non-secure origins; added graceful fallback message
- **Login theme not persisting** — dark/light toggle saved inconsistent values to localStorage
- **Login MOTD appearing 2-3 times** — race condition on multiple `_showLogin()` calls; added mutex flag
- **Login version text** — now links to GitHub repository with icon
- **Column config button overlapping UI** — moved from absolute-positioned overlay to inline in last `<th>`
- **Smart container icons** — Topology and Dep Map canvas now show contextual icons (database, cache, web, etc.) instead of generic cubes
- **Linux icon missing** — `fas fa-linux` → `fab fa-linux` (Font Awesome brands) in multihost, dashboard, image picker

## [6.0.0] - 2026-04-05

### Added — 20 Features Across 5 Sprints

**Sprint 1 — Quick Wins**
- **Login Banner (MOTD)** — admins set a persistent message on the login page (System > Info)
- **Clone/Duplicate Stack** — copy button on stack headers duplicates compose config with new name
- **Custom Attributes** — add arbitrary key-value metadata to containers beyond Docker labels
- **Install script** — `install.sh` existed already; verified and ready for `curl | sh` deployment

**Sprint 2 — UX Enhancements**
- **Onboarding Wizard** — 3-step welcome overlay for new installs (<3 containers), feature highlights, quick-start tips
- **Resource Sparklines** — tiny 60x16 CPU line charts per running container in the list, updated from 1h stats data
- **Host Hardware Info** — kernel version, storage driver, and image count added to Multi-Host host cards
- **Container Metrics Comparison** — select 2-5 containers, compare CPU/RAM on side-by-side Chart.js line charts

**Sprint 3 — Operations**
- **S3 Backup Export** — one-shot backup of SQLite DB to any S3-compatible storage (AWS Signature V4, no SDK)
- **Docker Version Checker** — System page card showing Docker Engine version per host with mismatch warnings
- **Backup File List** — shows local backup files with sizes and dates in System page
- **Cost Allocation by Team** — new "By Team" tab in Cost Optimizer grouping container costs by metadata owner

**Sprint 4 — Large Features**
- **Event Timeline** — new page aggregating audit log, alerts, and Docker events on a visual timeline with date groups, category icons, and severity badges; filters by time range, category, and text search
- **Workload Balancing Recommendations** — Multi-Host Overview shows DRS-style suggestions for container rebalancing, CPU/RAM pressure warnings
- **Container Migration Wizard** — right-click → Migrate to Host; inspects container, creates+starts on target host with same config

**Sprint 5 — Polish**
- **Theme Customizer** — 8 preset accent colors + custom color picker in System page; changes apply instantly and sync across devices
- **i18n Completion** — nav keys for logs, timeline, multi-host added to all 11 languages with proper translations
- **Accessibility** — `role` and `aria-label` attributes on sidebar, main content, and all footer buttons; `.sr-only` CSS utility class
- **Smart Container Icons** — Topology and Dep Map canvas icons now match container type (database, cache, web, queue, auth, etc.)

### Backend
- `GET /motd`, `PUT /motd` — login banner management
- `GET /timeline` — aggregated event timeline from 3 sources
- `GET /recommendations/balancing` — workload balancing analysis
- `POST /system/backup/s3` — S3 backup with AWS SigV4
- `GET /docker-versions` — per-host Docker version info
- `GET /system/backup/list` — local backup file inventory
- `GET /stats/sparklines` — downsampled 1h CPU/RAM data for sparkline charts

## [5.10.0] - 2026-04-05

### Added — Enterprise Wave 4 (Final 3/23 ESXi gaps closed)
- **Enterprise Datagrid** — DataTable component upgraded with client-side pagination (25/50/100 rows/page in Enterprise mode), per-column filter dropdowns (click filter icon → unique values), page navigation (first/prev/next/last + page size selector)
- **Volumes Detail View** — click any volume to see tabbed detail: Overview (name, driver, scope, mountpoint, labels), Connected Containers (which containers use this volume), Inspect (raw JSON with copy)
- **Networks Detail View** — click any network to see tabbed detail: Overview (driver, IPAM config, options), Connected Containers (with IP/MAC addresses), Inspect (raw JSON)
- **Master/Detail Split View** (Enterprise only) — toggle button in containers list; click a row to see container summary in a bottom panel (image, status, ports, mounts) without leaving the page; "Full View" button to navigate
- **Right-click context menus for Volumes** — View Details, Inspect JSON, Remove

### ESXi Gap Analysis: 23/23 COMPLETE
All 23 must-have improvements from the VMware ESXi/vCenter gap analysis are now implemented.

## [5.9.0] - 2026-04-05

### Added — Enterprise Wave 3 (5 features)
- **Maintenance Mode / Node Drain** — drain button per host in Multi-Host Overview; stops all non-system containers, marks host as "maintenance" (orange badge); Activate button restores to production
- **Certificate Management UI** — System page card showing TLS certificates per host (Docker TLS configs + app-level certs) with CA/key indicators
- **Saved Filter Presets (Advanced)** — save custom filter combinations with names; dashed-border pills in filter bar; persists in localStorage; removable via ×
- **Inline Edit for Container Metadata** — click any metadata field (app name, description, category, owner, notes) in container detail to edit in-place; saves on Enter/blur, cancel on Escape
- **Stack Creation Wizard** — 3-step guided wizard: Stack Name → Add Services (name, image, ports, dynamic add/remove) → Review & Edit YAML → Deploy; generates docker-compose.yml automatically

### Backend
- `POST /hosts/:id/drain` — stops all running containers (skips docker-dash), sets environment=maintenance
- `POST /hosts/:id/activate` — restores environment=production
- `GET /system/ssl/certificates` — lists TLS certificates from host configs + app cert paths

## [5.8.0] - 2026-04-05

### Added — Enterprise Wave 2 (9 features)
- **Support Bundle / Diagnostic Export** — one-click JSON download with Docker info, container states, recent logs (20 lines/container), DB stats, memory/uptime
- **Type-to-confirm for destructive ops** — running container removal requires typing the container name; Modal.confirm() now supports `typeToConfirm` option
- **View Density toggle** — 3 levels (Comfortable / Compact / Dense) in sidebar footer; per-user preference synced to server
- **Global Search enhanced** — Ctrl+K command palette now also searches containers, images, volumes, networks live via API; results grouped by type with icons
- **Chart export (PNG/CSV)** — export buttons on each container stats chart (CPU, Memory, Network, Block I/O)
- **Cluster Health Score** — dashboard gauge (0-100) with SVG ring chart; scores container health, CPU/RAM pressure, stopped ratio
- **Session Management** — System page shows active sessions with user, IP, start time, user agent; admins can terminate other sessions
- **Saved Filter Presets** — quick filter pills above containers list: All / Running / Stopped / Unhealthy / Sandbox
- **Centralized Log Explorer** — new page aggregating logs from all running containers; severity filtering (error/warn/info/debug), regex search, multi-container color-coded interleaved view, Ctrl+Click multi-select, TSV download

### Backend
- `GET /system/database/diagnostics` — diagnostic bundle download
- `POST /system/database/cleanup-aggressive` — deep cleanup (keep last N hours only)
- `GET /cluster-health` — composite health score with breakdown
- `GET /auth/sessions` + `DELETE /auth/sessions/:id` — session list + terminate
- `GET /containers/logs/multi` — cross-container log aggregation with severity detection

## [5.7.0] - 2026-04-05

### Added
- **Enterprise UI Mode** — switchable interface inspired by VMware ESXi/vCenter; toggle between Standard (clean, simple) and Enterprise (compact, dense, power-user) from the sidebar
- **UI mode toggle** — rocket/building icon in sidebar footer; preference saved per user (localStorage + server), restored on login, synced across devices
- **Enterprise density** — reduced padding, smaller fonts, 4px border-radius, compact tables/cards/stat cards/buttons/badges for more information per screen
- **Right-click context menus** — state-aware context menus on container rows (12 actions: details, terminal, logs, start/stop, restart, pause, rename, remove) and image rows (8 actions: inspect, layers, scan, sandbox, tag, export, remove)
- **Persistent bottom task bar** (Enterprise only) — global operation tracker showing active container actions with progress, elapsed time, auto-fade on completion; tracks start/stop/restart operations
- **Enterprise sidebar** — ESXi-inspired nav reorganization: Compute (Multi-Host, Containers, Stacks, Swarm) → Storage (Images, Volumes) → Networking (Networks, Firewall, Dep Map) → Monitor (Insights, Alerts, Cost, Security) → Operations → Admin
- **Column configuration** (Enterprise only) — gear icon on DataTable headers; dropdown with checkboxes to show/hide columns; visibility persisted across data refreshes
- **Keyboard shortcuts overlay** — press `?` anywhere to see all shortcuts; two-column layout with Global (17 shortcuts) and Containers Page sections
- **`g + key` navigation** — press `g` then `d/c/i/v/n/s/m/a/h` to navigate to Dashboard/Containers/Images/Volumes/Networks/Stacks/Multi-Host/Alerts/Hosts
- **`/` focus search** — press `/` to focus the search input on any page

### i18n
- Added enterprise sidebar section labels (Compute, Storage, Networking, Monitor) to all 11 languages

## [5.6.0] - 2026-04-05

### Added
- **Multi-Host Overview page** — ESXi/vCenter-style unified view of ALL Docker hosts, stacks, and containers
- **By Host tab** — each host as a card showing CPU/RAM bars, Docker version, OS info, and collapsible stack groups with health dots per container
- **By Stack tab** — all stacks grouped across hosts, showing which hosts run each stack and their container health status
- **Aggregate stat cards** — total hosts (online/offline), containers, running, stopped, images across all hosts
- **Host offline detection** — red-bordered card with "Host offline" message for unreachable hosts
- **Cross-host navigation** — clicking a container auto-switches host context and navigates to the container detail
- **15-second auto-refresh** — live updating overview without manual refresh
- **Sidebar nav item** — "Multi-Host" entry with network icon, shown in navigation

### Backend
- `GET /api/multi-host/overview` — parallel data fetch from all active hosts (containers, Docker info, stats overview) via `Promise.allSettled` with graceful offline fallback

## [5.5.1] - 2026-04-05

### Added
- **Sandbox Project Source** — launch sandbox containers with pre-loaded source code from:
  - **GitHub URL** — paste any public repo URL; Docker Dash downloads the tarball, auto-detects the tech stack, installs dependencies, and starts the app
  - **Upload Archive** — upload a .tar or .tar.gz archive; same auto-detect + auto-run flow
- **Tech stack auto-detection** — detects Node.js (package.json), Python (requirements.txt), Go (go.mod), Ruby (Gemfile), static HTML (index.html) and selects the appropriate base image automatically
- **Auto-dependency install** — `npm install --ignore-scripts` for Node, `pip install` for Python, `go mod download` for Go
- **Auto-start command** — reads `scripts.start` from package.json, or falls back to language-specific defaults
- **Auto-port detection + expose** — detects port from stack defaults (3000 for Node, 5000 for Python, 8080 for Go) and auto-exposes it
- **Progress indicator** — 5-step progress display in sandbox modal: pull image → download project → detect stack → install deps → start app
- **Port access link** — on success, toast shows clickable "Open http://host:port" link
- **Advanced overrides** — optional start command and port override fields when using project source

### Backend
- `_downloadGithubTarball(owner, repo, branch)` — GitHub API tarball download with redirect follow
- `_peekTarFiles(tarBuffer)` — reads tar headers to list files without extraction (strips GitHub prefix)
- `_detectStack(fileList)` — maps manifest files to stack/image/installCmd/startCmd/port
- `_execWithTimeout(container, cmd, timeout)` — exec with 120s timeout for builds
- `POST /sandbox` extended with: `projectSource`, `githubUrl`, `githubBranch`, `uploadContent`, `uploadFilename`, `autoDetect`, `startCommand`, `exposePort`

## [5.5.0] - 2026-04-05

### Added
- **Sandbox Mode** — launch containers with resource limits, network isolation, and auto-cleanup. Two modes:
  - **Ephemeral** — auto-deletes when stopped, with optional TTL (30m / 1h / 4h)
  - **Persistent Sandbox** — survives stop/start, isolated network, resource-limited
- **Sandbox launch modal** — configurable image, mode, TTL, RAM (256MB-2GB), CPU (0.25-2 cores), network isolation
- **Three entry points** — Containers "Sandbox" button, Images "Run in Sandbox" per image, Templates (future)
- **Sandbox visual badges** — `EPHEMERAL` (red) with countdown or `SANDBOX` (yellow) badges in containers list, colored left border
- **Sandbox detail card** — info card in container detail showing mode, remaining TTL, limits, user, with "Extend +1h" and "Stop & Remove" buttons
- **TTL auto-cleanup** — background timer checks every 30s for expired sandbox containers, auto-removes them, sends WebSocket notification
- **Security defaults** — `no-new-privileges`, `restart: no`, dedicated `dd-sandbox` bridge network (internal, no external access), no Docker socket mount, no privileged mode

### Backend
- `POST /api/containers/sandbox` — create & start sandbox container with labels, limits, isolated network
- `GET /api/containers/sandbox/active` — list active sandbox containers
- `DELETE /api/containers/sandbox/:id` — stop & remove sandbox (with safety check for sandbox label)
- `POST /api/containers/sandbox/:id/extend` — extend TTL by 1 hour
- Sandbox TTL timer in `src/jobs/index.js` — 30s interval cleanup with audit logging
- `dd-sandbox` Docker network auto-created (bridge, internal) on first sandbox launch

## [5.4.0] - 2026-04-05

### Added
- **One-click port access** — each exposed TCP port in the Containers list gets a clickable external-link button; opens `http(s)://host:port` in a new tab; icon appears on row hover
- **Log time filter** — "since" dropdown (All time / Last 1h / 6h / 24h / 7d) added to the container log viewer toolbar alongside tail count
- **Keyboard navigation in Containers list** — Arrow Up/Down to move between rows, Enter to open detail view, `r` to restart, `s` to stop/start, `l` to jump to Logs tab; focused row highlighted in blue
- **Live CPU/RAM mini-bars** — two 4px color-coded progress bars per running container row, updated every 5 s via `/stats/overview`; color shifts green→yellow→red by utilization
- **Dual AI provider (OpenAI + Ollama)** — Container Doctor "Ask AI" button with provider/model/key inputs; calls OpenAI API or local Ollama and streams the response directly into the modal; config persisted in localStorage
- **Image layer visualization** — new Layers button in the Images table; opens a modal showing all image layers with command, size, and a relative-size bar per layer (color-coded by size)
- **Generate docker-compose from GitHub** — new "From GitHub" button in Containers; fetches README/package.json/go.mod/requirements.txt from any public GitHub repo, sends to AI (OpenAI or Ollama), returns a production-ready docker-compose.yml with health checks, volumes, networks, and resource limits

### Backend
- `POST /api/ai/chat` — generic AI chat endpoint supporting OpenAI and Ollama providers
- `POST /api/ai/github-compose` — fetches GitHub repo context (5 files max) and generates docker-compose via AI
- `GET /images/:id/history` already existed; wired to new frontend Layers modal
- `GET /containers/:id/logs` already accepted `since` param; now passed from frontend log-time selector

## [5.3.1] - 2026-04-05

### Added
- **Stack-level security buttons** — Security Scan (🟡) and CIS Benchmark (🟢) directly in the stack header in Containers page
- **Scan Detail overlay** — "View Details" per image after a Security Scan opens full CVE breakdown *over* the scan modal without closing it; includes Critical/High/Medium/Low grid, recommendations, full CVE table with fix versions, and AI prompt copy
- **CIS Benchmark card in Security overview** — run benchmark and see score + issue counts without leaving Security page; result cached in sessionStorage
- **CIS Benchmark header button** in Security page — one-click navigation to System > CIS tab
- **Actions Guide (i button)** in Containers and Images — full 2-column overlay reference documenting every stack action, container action, and status indicator
- **Generated docker-compose.yml** — View Composer reconstructs YAML from container inspect metadata with a "Generated" notice when no real file is found on disk
- **Comparison table sticky header + footer** — column headers and legend always visible; table scrolls internally with `max-height: calc(100vh - 280px)`

### Improved
- CIS Benchmark reorganized into sub-tabs: Guide, Daemon, Containers, All results; per-container hardened compose generator
- Template images loading — `cdn.jsdelivr.net` added to Content Security Policy `imgSrc`
- Version in System > Info and About now reads from `src/version.js` (mounted volume) — no longer shows stale baked image version
- Grype added to image scan dropdown menu (was missing)
- Comparison table first-column sticky cells use `--surface2` with `box-shadow` to eliminate transparency bleed-through at scroll

### Fixed
- Scan History "View Details" eye button did nothing — event listeners were placed after a `return` statement (dead code)
- Image scan dropdown positioned off-screen — `event.currentTarget` resolved to the delegated table element instead of the actual button
- Actions Guide overlay background transparent on light theme — `--card-bg` variable undefined; replaced with `--surface`
- CIS Benchmark header button non-functional — inline `onclick` blocked by CSP `scriptSrcAttr: none`; replaced with addEventListener
- Grype install instructions appeared visually grouped with Docker Scout — separator div moved to correct position

## [5.3.0] - 2026-04-04

### Added
- **Docker Swarm mode** — full UI: Nodes table (availability/role management, drain, remove), Services (create, scale, remove, tasks drill-down), Tasks (sorted by state, error display), Overview (init form, stat cards, join tokens, leave)
- **Swarm beginner guide card** — explains Nodes (manager vs worker), Services (replicated vs global), Tasks, Overlay Networks + Ingress, CLI quickstart example
- **Swarm official docs card** — 5 direct links: overview, tutorial, deploy services, overlay networking, secrets
- **Extended comparison matrix** — 4 new tools added: Coolify, Yacht, Rancher, Portainer Business (8 tools total, 60 features)
- **Sticky first column** in comparison table — feature name stays visible while scrolling 8 columns horizontally

### Improved
- Nav "Swarm" translation added to all 11 locale files (Klingon: `ramDaq veQ`)
- Comparison matrix stat cards: "Dockge Missing" → "Coolify Missing" for more relevant callout
- What's New page: added 5.1.0, 5.2.0 and 5.3.0 release entries (were missing)

### Fixed
- Latency tracking middleware crash (`ERR_HTTP_HEADERS_SENT`) — `res.setHeader` called after headers already sent by `sendFile()` for static streams; guarded with `!res.headersSent`

## [5.2.0] - 2026-04-03

### Added
- **SSL zero-config** — Caddy sidecar reads shared `caddy-certs` volume; app writes Caddyfile + reloads via `docker exec`; enable HTTPS from System > SSL tab, no manual container restarts
- **LDAP / Active Directory sync** — two-bind auth (service account bind → user search → user bind to verify password), group filter, attribute mapping, user preview list; auto-provisions local accounts on first LDAP login with unusable password hash
- **CIS Docker Benchmark tab** — 18 checks (6 daemon: logging, experimental, live-restore, userland-proxy, seccomp, AppArmor; 12 container: privileged, cap-add, no-new-privileges, namespace sharing, read-only rootfs, memory/CPU limits, sensitive mounts, privileged ports, running as root), scored report with severity + remediation
- **App marketplace logos** — walkxcode/dashboard-icons CDN integration with FontAwesome icon fallback on error
- **LDAP config API** — `GET/PUT/DELETE /api/auth/ldap`, `POST /api/auth/ldap/test`, `GET /api/auth/ldap/users`
- DB migration 037: `ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'`

### Improved
- System page tabs wrap on small screens (phone / RDP window) — added `flex-wrap: wrap` to `.tabs` CSS class
- Caddy status shown in SSL card with badge + conditional "Enable HTTPS" button vs terminal command display

### Fixed
- SQLite `datetime("now")` bug in `registry.js` and `pipeline.js` — double-quoted identifiers treated as column names by SQLite; changed to single-quoted string literals `datetime('now')`

## [5.1.0] - 2026-04-02

### Added
- **Docker Registry edit** — full edit modal pre-populated with current registry data, calls `PUT /api/registries/:id`; was a "coming soon" stub
- **Registry test shows repo count** — inline table feedback with repository count; 0 repositories now correctly returns red failure with message (not success)
- **Pull Image registry dropdown** — 7 presets (Docker Hub, GHCR, MCR, Quay, ECR Public, GCR, Custom) with auto-filled prefix and dynamic placeholder
- **SSH Key authentication guide** on Hosts page — 3-step card (keygen → ssh-copy-id → paste) matching the SSH Tunnel Linux distros

## [5.0.5] - 2026-03-31

### Added
- **Template Configurator** — dynamic visual editor for template deployment: auto-detects configurable fields (passwords, ports, URLs, booleans), generates smart forms, live YAML preview with change highlighting
- **Password generator** in configurator — slider (8-256 chars), Generate button, strength indicator, weak default warnings
- **3 Euro-Office templates** — Document Server standalone, Euro-Office + Nextcloud combo, Dev Stack (Euro-Office vs OnlyOffice)
- **Cost Optimizer tabs** — Recommendations and Cost Breakdown on separate tabs under savings banner
- **3-button template UX** — Eye (view YAML), Sliders (configure & deploy), Rocket (deploy with defaults)

### Fixed
- Container filter reset on page navigation (ghost filter no longer persists)
- Template configurator: Generate button now correctly updates both input field and YAML preview
- Template configurator: password field layout — input full width, controls on separate row
- Template configurator: strength bar updates correctly after generating (was stuck on "weak")

## [5.0.4] - 2026-03-30

### Verified
- All findings from external audit re-verified on live GitHub repo
- API key permission enforcement confirmed live (enforceApiKeyPermissions in auth middleware)
- Rate limiting confirmed on /validate-reset-token and /reset-password-token
- Version consistency confirmed: 5.0.4 across package.json, docker-compose.yml, index.html
- Zero stale references (4.2.0, 335 tests, 52 features, 20 templates, ENABLE_TLS) — all clean
- 384 tests, 29 suites, 100% passing

## [5.0.3] - 2026-03-30

### Security
- **API key permission enforcement** — read-only API keys now blocked from POST/PUT/DELETE (was decorative, now enforced in auth middleware)
- **Rate limiting** on public reset-password endpoints (`/validate-reset-token`, `/reset-password-token`)

### Fixed
- `/api/docs` feature count: 52 → 75+
- `/api/compare` App Templates: "20 built-in" → "30 + custom"
- docker-compose.yml TLS comment: "ENABLE_TLS=true" → "docker compose --profile tls up -d"
- .env.example strict mode description: clarified Bearer/API key still work (by design)
- SECURITY.md: removed "login" from validatePassword flows (login only compares hashes)
- changePassword() comment: "except current" → "all sessions" (matches actual behavior)

## [5.0.2] - 2026-03-30

### Fixed
- CRITICAL: MFA login flow — session cookie was set before MFA verification, creating invalid cookie when TOTP required. Cookie now only set after complete authentication.
- README CSP tradeoff description aligned with actual code (unsafe-eval only, NOT unsafe-inline)
- dotenv added as explicit dependency for local development reliability
- .env.example expanded with missing config vars (SECURITY_MODE, PASSWORD_MAX_AGE_DAYS, APP_NAME, etc.)
- SECURITY.md auth model description clarified (API keys use separate table)
- CI syntax check error fixed (single quotes → backtick template literals in MFA flow)

## [5.0.1] - 2026-03-30

### Fixed — Documentation & Release Hygiene
- All documentation files updated to reflect actual project stats (384 tests, 29 test files, 32 migrations, 11 languages)
- Stale test counts fixed across README.md, SECURITY.md, CONTRIBUTING.md, CI workflow, PR template, comparison table
- Cache busters updated in index.html (all `?v=` references now `5.0.1`)
- i18n language count fixed in comparison API (`EN/RO/DE` → `11 languages`)
- Project structure in README corrected (13 migrations → 32 migrations)
- README language list expanded from "English, Romanian, German" to all 11 languages
- whatsnew.js v5.0.0 test count corrected (359/24 → 384/29)
- PR template test threshold updated (335+ → 384+)
- CI summary test count updated (335 → 384)

### Changed
- Version bumped from 5.0.0 to 5.0.1 across package.json, docker-compose.yml, index.html

## [5.0.0] - 2026-03-29

### Added — Enterprise Security Hardening
- **Enterprise Security Mode** — `SECURITY_MODE=strict` flag toggles all hardening (cookie-only auth, forced HTTPS, 8h sessions, password expiry)
- **TOTP/MFA** — two-factor authentication with zero dependencies (RFC 6238), encrypted secrets, 10 recovery codes
- **Immutable hash-chained audit log** — SHA-256 chain, tamper detection, JSON/CSV/Syslog export
- **Security event alerting** — 5 default rules (brute force, admin created, MFA disabled), threshold detection, 7 notification channels
- **14 developer tools** — Password Generator, Hash Generator, IP Calculator, JSON Formatter, Regex Tester, Text Diff, and more
- **HTML/Markdown converter** tools with live preview
- **Klingon pIqaD font** integration with full easter egg experience

### Fixed
- Dependency Map layout — containers no longer overlap (improved force simulation)
- Port Reference expanded to 57 ports (Docker, K8s, MQTT, RDP, etc.)

### Improved
- External audit findings addressed — 6 security tradeoffs fully documented, deployment recommendations table
- 384 tests across 29 test files (100% passing)

### Security
- All inline event handlers eliminated (67 `onclick=`/`onchange=` converted to `addEventListener`)
- CSP `scriptSrc` no longer includes `unsafe-inline`; `scriptSrcAttr` set to `none`

### Technical
- 4 new DB migrations (029-032): enterprise security, MFA, audit integrity, security alerts
- 5 new test files: TOTP, audit integrity, health endpoint, webhooks, stacks, images scan, alerts

## [4.2.0] - 2026-03-28

### Added — 20 New Features
- **Image pull progress** — real-time streaming per-layer progress bars via SSE
- **Resource limits editor** — visual sliders with presets (256MB-2GB memory, 0.5-4 CPU cores)
- **Bulk container actions** — checkboxes + floating action bar for batch start/stop/restart/remove
- **Theme & language sync** — user preferences saved server-side, synced across devices
- **Container file browser** — navigate, view, download files inside running containers
- **Docker Compose editor** — edit, validate, save & deploy compose configs inline
- **Scheduled actions** — cron-based automation with presets, execution history, run-now
- **Container diff** — filesystem changes vs base image with color-coded entries
- **Container rollback** — one-click revert to previous image with version history
- **Notifications center** — dedicated page with filters, pagination, bulk mark-read/delete
- **Dashboard customizable** — toggle widget visibility, order saved to server per user
- **Stacks page** — unified Compose + Git stacks management with actions
- **Container groups** — user-defined grouping with colors, beyond compose projects
- **API Playground** — browse and test all API endpoints from the UI with response viewer
- **AI Container Doctor** — diagnostics + 30 log patterns + AI prompt generator for ChatGPT/Claude
- **Cost Optimizer page** — per-container cost breakdown, idle detection, savings recommendations
- **Dependency Map** — interactive canvas graph showing container relationships
- **Deployment Pipelines** — staged pull → scan → swap → verify → notify with history
- **Mobile responsive** — full UI on phone/tablet with 360px-768px breakpoints
- **Container health dots** — color-coded indicator in list view with summary bar

### Security
- Eliminated all remaining `execSync` with user input (firewall, compose, Docker login)
- Groups routes: `requireRole('admin','operator')` on all write endpoints
- Global prototype pollution protection middleware
- Unified password policy enforced on all 4 auth flows

### Testing
- **231 new tests** across 14 test files (104 → 335 total)
- CRITICAL: RBAC enforcement, SQL injection, path traversal, prototype pollution, password policy
- HIGH: log patterns, groups service, preferences, notifications, pipeline service
- MEDIUM: templates CRUD, schedules, cost analysis, validation, health endpoint

### Technical
- 5 new DB migrations (024-028)
- 6 new frontend pages
- 3 new backend services (groups, pipeline, log-patterns)
- 34 files changed, 5,492 insertions

## [4.1.0] - 2026-03-28

### Added
- **Grype vulnerability scanner** — third scanning option alongside Trivy and Docker Scout (auto-fallback: Trivy → Grype → Scout)
- **Custom templates** — add, edit, delete your own app templates (System > Templates) with full CRUD
- **Built-in template overrides** — modify default templates, tracked with who/when modification badges
- **Template preview** — view docker-compose.yml before deploying with Copy button
- **Template deploy endpoint** — `POST /templates/:id/deploy` writes temp compose and runs `docker compose up -d`
- **Container health score dot** — color-coded indicator in list view (green/yellow/orange/red)
- **Container summary bar** — total, running, stopped, needs attention counts with clickable state filters
- **Host info bar** on dashboard — hostname, CPUs, RAM, Docker version, storage driver, OS, uptime
- **Container detail tabs** — Labels (grouped by type), Mounts, Network with port bindings
- **About page** — GitHub repository link, author info

### Fixed
- **Export Container Configuration** dialog no longer closes immediately (Modal.close 200ms timer race condition)
- **System > Templates** tab now loads correctly (duplicate `getTemplates()` API method removed)
- **Container summary bar** spans full width in 2-column layout
- **Dockerfile healthcheck** uses configurable `APP_PORT` via shell expansion

### Security
- **Unified password policy** — `validatePassword()` enforced on all 4 password flows (change-password, reset-password, create-user, token-reset)

### Improved
- **Caddyfile** converted to generic template with `YOUR_HOST` placeholder
- **EVENT_RETENTION_DAYS** aligned to 7 across `.env.example`, config, README
- **README badges** linked to verifiable artifacts (CI pipeline, SECURITY.md audit history)
- **Template count** fixed: 30 everywhere (was inconsistent 20 vs 30)

## [4.0.0] - 2026-03-28

### Added
- **Insights page** — executive dashboard aggregating health scores, recommendations, stale images, footprint
- **Compare page** — interactive 52-feature matrix vs Portainer/Dockge/Dockhand with search
- **Templates browser** — 30 curated app templates (System > Templates) with search, filter, one-click deploy
- **Workflows manager** — create/manage IF-THEN automation rules (Settings > Workflows)
- **Reset password dialog** — admin resets passwords directly from Settings > Users (no email required)
- **Container rename** button in container detail view
- **Safe Update** button — Trivy scan before container swap, blocks critical CVEs
- **Diagnose** button — 8-step troubleshooting wizard in modal
- **Dashboard clickable charts** — click CPU/memory bar → navigate to container
- **Live container count** badge in sidebar (running/total via WebSocket)
- **Dashboard "last updated"** timestamp in header
- **Audit CSV export** — download audit log as CSV file
- **Audit analytics** modal — top users, top actions
- **Database backup** button (System > Database > Create Backup Now)
- **Keyboard shortcuts** — `?` help modal, `g+key` vim-style navigation (g+d dashboard, g+c containers, etc.)
- **Professional error boundary** — catches all uncaught errors with EMS PRO-style overlay
- **Welcome onboarding** modal for first-time users
- **Dark mode toggle** on login page
- **System overview API** — `GET /api/overview` complete infrastructure snapshot
- **API documentation** endpoint — `GET /api/docs` (70+ endpoints documented)
- **Daily auto-backup** — cron at 02:00, keeps 7 daily backups
- **Connection status** indicator in sidebar footer
- **OS theme auto-detection** — follows system preference changes
- **Forgot password** hint on login page
- **Version display** on login page footer
- 10 new app templates (Elasticsearch, RabbitMQ, MailHog, Plausible, File Browser, Watchtower, Drone CI, Ghost, WireGuard, Portainer CE)
- 20 new tests (104 total across 8 files)
- Open Graph meta tags for social link previews
- GitHub v4.0 milestone with 6 roadmap issues
- GitHub Discussions enabled

### Fixed
- **Login error message** not showing on wrong password (handleUnauthorized was recreating the form)
- **Password reset** not working (was calling updateUser which ignores password field — now calls /reset-password with bcrypt)
- **Auto-logout** after resetting own password
- **APP_SECRET validation** false positive (empty string in weak list matched everything)
- **Cache busting** — JS file versions updated to force browser reload
- **i18n nav labels** — Insights, Git Stacks, Compare, section labels translated (EN/RO/DE)
- **Chart.js light theme** colors adapted to theme

### Security
- Strong APP_SECRET enforced on production server
- SECURITY.md updated with full architecture documentation
- 4 vulnerability fixes documented (DD-001 through DD-004)

### Changed
- Version bumped from 3.10.2 to 4.0.0
- README badges updated (104 tests, security audited)
- CONTRIBUTING.md updated with "Good First Issues" section
- Docker socket security documented in README

## [3.10.2] - 2026-03-28

### Added
- Interactive **Comparison page** — 52 features vs Portainer/Dockge/Dockhand with search/filter
- **17 API integration tests** with supertest (84 total tests)
- **GitHub issue/PR templates** for community contributions
- **README badges** — CI, version, license, tests, production readiness

### Changed
- GitHub repo description and 12 topics for discoverability
- .env.example updated with all v3 environment variables

## [3.10.1] - 2026-03-27

### Added
- **Welcome onboarding modal** for first-time users (Ctrl+K, theme, language tips)
- **ARIA labels** auto-applied to all icon-only action buttons
- **Toast `role="alert"`** for screen reader accessibility
- **Tab ARIA roles** (`role="tablist"`, `role="tab"`) on all tab components
- **Auto-refresh** on Volumes and Networks pages (30s interval)
- **Chart.js theme-aware colors** (light/dark auto-detection)

## [3.10.0] - 2026-03-27

### Fixed
- Dashboard **error state** — shows retry banner on API failure (was silent)
- **WCAG contrast** — text-dim darkened to pass 4.5:1 ratio
- **Focus-visible** keyboard navigation outlines on all interactive elements
- **Password policy** unified to 8 chars minimum everywhere
- **Sidebar icons** deduplicated (Firewall=fire, Hosts=sitemap)

### Added
- **Sidebar section labels** — Resources, Operations, Admin

## [3.9.0] - 2026-03-27

### Security
- **scrypt KDF** for encryption key derivation (replaces improvised padding)
- **Startup validation** — warns on weak APP_SECRET/ENCRYPTION_KEY in production
- **Trust proxy** restricted to loopback in production mode
- **JSON body limit** reduced from 10MB to 2MB

### Added
- **Database backup API** — POST /api/backup/database
- **GitHub Actions CI** — tests + syntax + i18n on every push
- **ESLint** — 0 errors, basic security rules

## [3.8.0] - 2026-03-27

### Security
- **Input validation middleware** — validateId, validateBody, sanitizeBody
- **Prototype pollution protection** on all request bodies
- **Git deploy/push rate limited** to 5/min/IP
- **Enhanced error handler** — 5xx no longer leaks internal details
- **SSH key cleanup** on startup (removes stale keys >24h)

### Fixed
- All `JSON.parse` calls wrapped with safe tryParseJson
- `console.log` in DB migrations replaced with structured logger

## [3.7.1] - 2026-03-27

### Security (CRITICAL)
- **Command injection** via Docker labels fixed — execFileSync replaces execSync
- **ReDoS** via user regex fixed — length limit + timeout test
- **Smart-restart DoS** fixed — returns backoff delay instead of blocking

## [3.7.0] - 2026-03-27

### Added
- **Event-driven notifications** — container crash/OOM/unhealthy auto-sent to all channels
- **Global search** — search containers, images, volumes, networks, Git stacks, audit log
- **Container dependency graph** — network-based relationship mapping

## [3.6.0] - 2026-03-27

### Added
- **Stack export** — download compose stack as portable JSON bundle
- **Stack import** — upload bundle and deploy on any host
- **Import preview** — validate before deploying
- **Generate compose** from any bundle

## [3.5.0] - 2026-03-27

### Added
- **Cross-host container migration** with zero-downtime
- **Stack migration** — all containers in a compose stack
- **Migration preview** (dry run) with warnings
- Health check verification before stopping source

## [3.4.0] - 2026-03-27

### Added
- **Workflow automation** — IF-THEN rules (CPU high → restart, crash → notify)
- **Dashboard preferences** — per-user widget order and visibility
- **README** completely rewritten with 60+ features

## [3.3.0] - 2026-03-27

### Added
- **Mobile responsive UI** — hamburger menu, touch-friendly buttons, scrollable tables
- **Resource recommendations** — smart analysis with actionable advice
- **Comparison API** — /api/compare returns feature matrix

## [3.2.0] - 2026-03-27

### Added
- **Enhanced log search** — regex, log level filtering (ERROR/WARN/INFO/DEBUG)
- **App template marketplace** — 20 curated one-click templates
- **Watchtower detection** — migration advisory to Docker Dash native updates

## [3.1.0] - 2026-03-27

### Added
- **Scheduled maintenance windows** — cron-based pull/scan/update
- **Smart restart** with exponential backoff and crash-loop detection
- **Public status page** — unauthenticated service status

## [3.0.0] - 2026-03-27

### Added
- **Deploy preview** — check for image updates via digest comparison
- **Safe-pull container update** — Trivy scan before swap, blocks critical CVEs
- **Guided troubleshooting wizard** — 8-step diagnostic for any container

## [2.10.0] - 2026-03-27

### Added
- **Image freshness dashboard** — freshness score based on age + vulnerabilities
- **Audit log analytics** — top users, actions, targets, hourly/daily heatmap

## [2.9.0] - 2026-03-27

### Added
- **Container uptime reports** — uptime %, restarts, hours tracked
- **Resource usage trends** — 7-day linear regression with 24h forecasting
- **Memory exhaustion prediction** — "will exceed limit in N hours"
- **Per-container cost estimation** — weighted CPU+memory share of VPS cost

## [2.8.0] - 2026-03-27

### Added
- **docker run → Compose converter**
- **AI-powered log analysis** — diagnostic prompts for ChatGPT/Claude
- **Traefik/Caddy label generator** — domain + port → ready-to-use labels
- **Tools tab** in System page

## [2.7.0] - 2026-03-27

### Added
- **7 notification channels** — Discord, Slack, Telegram, Ntfy, Gotify, Email, Webhook
- **SSO header authentication** — Authelia, Authentik, Caddy, Traefik support

## [2.6.0] - 2026-03-27

### Added
- **Container Health Score** (0-100) — composite from state, health, restarts, CPU/memory
- **Plain-English container status** — exit codes mapped to human-readable messages
- **Self-reporting resource footprint** — /api/footprint endpoint

## [2.2.0 - 2.5.0] - 2026-03-27

### Added
- **Git integration** — deploy from repos, credentials, webhooks, polling
- **Diff view** — see changes before redeploying
- **Deployment rollback** — revert to any previous deployment
- **Push to Git** — edit compose in UI, commit and push
- **Multi-file compose** — multiple YAML override files
- **Environment variable management** — per-stack overrides with encryption
- **Custom CA certificates** — for self-hosted Git servers
