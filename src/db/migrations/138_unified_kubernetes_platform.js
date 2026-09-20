'use strict';

const PERMISSIONS = [
  ['kubernetes_unified.manage', 'kubernetes_unified', 'manage', 'Manage unified Kubernetes topology, metrics, policy and lifecycle evidence'],
  ['kubernetes_vm_policy.manage', 'kubernetes_vm_policy', 'manage', 'Evaluate VM GitOps and admission policy evidence'],
  ['kubernetes_cluster_catalog.manage', 'kubernetes_cluster_catalog', 'manage', 'Plan curated Kubernetes cluster provisioning workflows'],
  ['application_environment.manage', 'application_environment', 'manage', 'Manage modernization maps, image provenance and unified application environments'],
];

const ADMISSION_POLICIES = [
  ['secure-boot-required', 'Secure boot required', 'security', 'VirtualMachine firmware must use EFI secure boot.'],
  ['trusted-image-source', 'Trusted image source', 'supply_chain', 'ContainerDisk and DataVolume images must use configured source prefixes.'],
  ['bounded-resources', 'Bounded resources', 'reliability', 'VM CPU and memory requests must be explicit and within configured ceilings.'],
  ['approved-networks', 'Approved networks', 'network', 'Secondary Multus attachments must be allowlisted.'],
  ['ownership-labels', 'Ownership labels', 'governance', 'Application, owner and environment labels must be present.'],
];

const CLUSTER_CATALOG = [
  ['aks-arc', 'AKS enabled by Azure Arc', 'azure', ['clusterName','region','nodeCount','kubernetesVersion','networkRef','credentialProfileRef'],
    ['validate_subscription_and_region','validate_network_and_identity','plan_control_plane','plan_node_pool','register_arc','verify_cluster_health']],
  ['nutanix-nke', 'Nutanix Kubernetes Engine', 'nutanix', ['clusterName','prismProject','nodeCount','kubernetesVersion','networkRef','credentialProfileRef'],
    ['validate_prism_project','validate_image_and_network','plan_control_plane','plan_workers','register_nke','verify_cluster_health']],
  ['openshift', 'Red Hat OpenShift', 'redhat', ['clusterName','baseDomain','platform','nodeCount','pullSecretRef','sshKeyRef'],
    ['validate_entitlement_refs','validate_dns_and_network','plan_install_config','plan_bootstrap','plan_control_plane_workers','verify_operators']],
  ['cloudstack-cks', 'CloudStack Kubernetes Service', 'cloudstack', ['clusterName','zone','serviceOffering','nodeCount','kubernetesVersion','networkRef','credentialProfileRef'],
    ['validate_zone_and_offerings','validate_network','plan_control_plane','plan_workers','register_cks','verify_cluster_health']],
  ['rancher', 'Rancher-managed Kubernetes', 'rancher', ['clusterName','provider','nodeCount','kubernetesVersion','networkRef','credentialProfileRef'],
    ['validate_rancher_access','validate_provider_and_network','plan_cluster','plan_machine_pools','register_agent','verify_cluster_health']],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kubernetes_unified_evidence_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('topology','metrics','policy','gitops','lifecycle')),
      namespace_scope TEXT,
      evidence_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kubernetes_vm_gitops_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      vm_name TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('flux','argo','repository')),
      repository_url TEXT NOT NULL,
      repository_path TEXT NOT NULL,
      revision TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      desired_hash TEXT NOT NULL,
      live_hash TEXT,
      state TEXT NOT NULL CHECK(state IN ('in_sync','drift','missing')),
      dry_run_json TEXT NOT NULL,
      controller_status_json TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kubernetes_vm_admission_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0.0',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kubernetes_vm_admission_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER REFERENCES docker_hosts(id) ON DELETE SET NULL,
      namespace TEXT NOT NULL,
      vm_name TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      results_json TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('pass','warn','fail')),
      evaluation_hash TEXT NOT NULL UNIQUE,
      enforced INTEGER NOT NULL DEFAULT 0 CHECK(enforced=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kubernetes_cluster_provisioning_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      stages_json TEXT NOT NULL,
      curated INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kubernetes_cluster_provisioning_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_id INTEGER NOT NULL REFERENCES kubernetes_cluster_provisioning_catalog(id) ON DELETE RESTRICT,
      plan_name TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      prechecks_json TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','blocked')),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS virtualization_modernization_maps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source_vm_ref TEXT NOT NULL,
      target_platform TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      stages_json TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      readiness_score INTEGER NOT NULL CHECK(readiness_score BETWEEN 0 AND 100),
      map_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shared_image_provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_kind TEXT NOT NULL CHECK(image_kind IN ('oci','vm')),
      image_ref TEXT NOT NULL,
      digest TEXT NOT NULL,
      source_url TEXT NOT NULL,
      sbom_json TEXT NOT NULL,
      signatures_json TEXT NOT NULL,
      links_json TEXT NOT NULL,
      trust_state TEXT NOT NULL CHECK(trust_state IN ('externally_verified','unverified','unknown')),
      evidence_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS unified_application_environments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      environment TEXT NOT NULL CHECK(environment IN ('development','test','staging','production','other')),
      owner TEXT NOT NULL,
      components_json TEXT NOT NULL,
      relationships_json TEXT NOT NULL,
      environment_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_kubernetes_unified_snapshot ON kubernetes_unified_evidence_snapshots(host_id,evidence_kind,created_at);
    CREATE INDEX IF NOT EXISTS idx_kubernetes_vm_gitops_host ON kubernetes_vm_gitops_plans(host_id,namespace,vm_name,created_at);
    CREATE INDEX IF NOT EXISTS idx_modernization_vm ON virtualization_modernization_maps(source_vm_ref,created_at);
    CREATE INDEX IF NOT EXISTS idx_image_provenance_ref ON shared_image_provenance(image_kind,image_ref,created_at);
  `);

  const permissionInsert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) permissionInsert.run(...permission);
  const siteAdmin = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (siteAdmin) {
    const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
    for (const permission of PERMISSIONS) grant.run(siteAdmin.id, permission[0]);
  }
  const policyInsert = db.prepare(`INSERT OR IGNORE INTO kubernetes_vm_admission_policies
    (slug,name,category,description) VALUES (?,?,?,?)`);
  for (const policy of ADMISSION_POLICIES) policyInsert.run(...policy);
  const catalogInsert = db.prepare(`INSERT OR IGNORE INTO kubernetes_cluster_provisioning_catalog
    (slug,name,provider,parameters_json,stages_json) VALUES (?,?,?,?,?)`);
  for (const [slug, name, provider, parameters, stages] of CLUSTER_CATALOG) {
    catalogInsert.run(slug, name, provider, JSON.stringify(parameters), JSON.stringify(stages));
  }
};

exports._PERMISSIONS = PERMISSIONS;
exports._ADMISSION_POLICIES = ADMISSION_POLICIES;
exports._CLUSTER_CATALOG = CLUSTER_CATALOG;
