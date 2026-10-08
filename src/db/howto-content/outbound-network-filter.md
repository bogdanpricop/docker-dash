---
title: Enforce Outbound Allowlists with the Egress Filter
summary: Restrict which external hosts a container can reach. SNI-based allowlist, IMDS-always-blocked, audit-only mode for migration, emergency disable per policy. Sidecar + iptables architecture.
category: security
difficulty: intermediate
icon: fas fa-shield-alt
---

<h2>The threat model</h2>
<p>A compromised container's biggest weapon is unrestricted outbound. It can:</p>
<ul>
  <li><strong>Read cloud-role credentials</strong> from the IMDS endpoint (<code>169.254.169.254</code>) and pivot into AWS/GCP/Azure</li>
  <li><strong>Exfiltrate data</strong> to attacker-controlled hosts</li>
  <li><strong>Call home</strong> to a C2 server for persistence</li>
</ul>
<p>The Outbound Filter authorizes proxied IPv4 TCP connections per container or stack. The current firewall excludes DNS, loopback and RFC1918 destinations; IPv6 and non-TCP traffic are not covered. It is not a complete network sandbox. Metadata protection in the proxy does not prove that every alternate network path is blocked.</p>

<h2>Overlapping container and stack policies</h2>
<p>Matching policies share one firewall table. Unapply keeps that table when another active policy covers the same container and Docker host, including the default-host alias. The response reports retained / retainedFor; stack responses separate retained and removed containers. Policy lookup happens while the target's Docker reservation is held, before removing rules.</p>
<p>An active saved policy is protected even when its individual apply history is unknown. If Unapply reports a shared filter, this policy still participates in proxy authorization. Emergency disable removes this policy configuration after successful unapply/retention; other policies keep their filter. Removing the last applicable policy can restore outbound access. A missing table is reported as missing, not as protected.</p>

<h2>Required container capability configuration</h2>
<p>Docker grants NET_RAW by default. Packet sockets can bypass the IP OUTPUT firewall, so applying a filter and authorizing proxy connections require an explicit drop:</p>
<pre><code>services:
  workload:
    cap_drop: [NET_RAW]</code></pre>
<p>Dropping ALL also satisfies this requirement. Remove NET_RAW/ALL from cap_add, recreate the workload, then apply the policy to its current container ID. A non-root user alone does not replace the explicit capability drop. Docker Dash does not recreate workloads automatically for this change.</p>
<p>Legacy filters can still be inspected and removed. Status reports safeToFilter: false and a safetyError for a target retaining NET_RAW; an existing nftables table is not proof of safe enforcement. After upgrading, new proxy connections from these legacy targets are denied until the capability is removed. IPv6, non-TCP traffic and the documented private-network exceptions remain outside current coverage.</p>

<h2>Applying rules and recovering a failure</h2>
<p>Each container's IPv4 table is replaced in one nftables transaction. Invalid rules preserve the previous table. A stack is updated sequentially: all targets are reserved and their policies saved first; if a later update fails, attempted targets are restored from those snapshots. This is not one atomic transaction across the stack. Counters and live connection state are not rolled back.</p>
<p>The API reports the actual rollback results. If recovery or cleanup cannot be confirmed, it retains a helper named <code>dd-egress-lock-&lt;full-container-id&gt;</code> and attempts to stop it. Its <code>/tmp/dd-before.nft</code> file contains the previous policy; an empty file means no table existed. The reservation prevents another operation from overwriting recovery evidence. Do not automatically remove these helpers or retry through another tool.</p>
<p>For recovery, an administrator must inspect the helper's <code>com.docker-dash.egress-target</code>, <code>egress-started-at</code> and <code>egress-pid</code> labels (all prefixed with <code>com.docker-dash.</code>) and compare them with the target's current ID, start time and PID. A restarted target has a different network namespace: do not restore an old snapshot there blindly. Preserve the snapshot privately, restore or reconcile the intended policy, verify the table and then remove the reservation. Application/process interruption leaves the same evidence for manual reconciliation.</p>
<p>Prebuild the helper on each selected Docker daemon so restrictive existing policies cannot prevent package installation:</p>
<pre><code>docker build -t docker-dash-egress-helper:local docker/egress-helper
# Set DD_EGRESS_HELPER_IMAGE to this image's immutable sha256 ID in Docker Dash.</code></pre>
<p>The default is <code>docker-dash-egress-helper:local</code>, built by the egress Compose profile. It contains nftables, retains its package inventory and excludes apk-tools and zlib. An explicitly configured legacy Alpine image can still install nftables before any mutation; it is not the default. A missing helper image or unavailable preparation fails without changing rules. Commands have a 45-second observation deadline and 128 KiB combined output limit. A timeout is an uncertain outcome, not proof that nothing ran. Emergency disable retains the policy if firewall removal fails.</p>

<h2>Architecture</h2>
<p>Three moving parts:</p>
<ol>
  <li><strong>Sidecar</strong> (<code>docker-dash-egress-filter</code>, Go, ~2MB image): listens on port 29193, peeks TLS SNI or HTTP Host on each connection, checks the allowlist, forwards or resets. No TLS decryption.</li>
  <li><strong>Runner</strong> (inside Docker Dash): runs a short-lived <code>docker-dash-egress-helper:local</code> helper container with <code>NET_ADMIN</code> that installs nftables rules into the target container's netns, redirecting all non-DNS/non-RFC1918 TCP to the sidecar.</li>
  <li><strong>DB + UI</strong>: policy config, block log ingestion, per-policy apply/unapply via REST (<code>/api/egress-filter/...</code>).</li>
</ol>

<h2>Setup — two steps</h2>

<h3>1. Run the sidecar</h3>
<p>Use the repository's Compose profile from its root, on the same Docker host as the application and filtered workloads:</p>
<pre><code>docker compose --profile egress up -d --build dd-egress-filter</code></pre>
<p>This also builds the default helper and runs a short bootstrap check with no network, no capabilities and a read-only filesystem. The sidecar starts only after that check exits successfully. The runner creates separate helpers with NET_ADMIN only when an administrator applies or removes a filter.</p>
<p>The application and sidecar share the policy directory and private <code>resolver.sock</code>. Docker Dash writes schema 2 and authorizes each TCP source using live container identity and intersected policies. Do not replace this with a standalone schema-1 file or mount only <code>policy.json</code>: those instructions do not provide per-container application authorization. The sidecar has no published ports or Docker socket.</p>

<h3>2. Configure Docker Dash</h3>
<p>Configure these environment variables on the application, using the actual sidecar address and the prebuilt helper image ID:</p>
<pre><code>services:
  app:
    environment:
      DD_EGRESS_SIDECAR_ENDPOINT: "172.17.0.5:29193"  # sidecar bridge IP:port
      DD_EGRESS_SIDECAR_NAME: "dd-egress-filter"       # defaults shown
      DD_EGRESS_HELPER_IMAGE: "sha256:YOUR_VERIFIED_HELPER_IMAGE_ID"
      DD_EGRESS_BLOCKLOG_INGESTER: "1"                 # enables background deny log tailing</code></pre>
<p>Restart Docker Dash. The sidecar gets SIGHUP on every policy change automatically.</p>

<h2>Using the UI</h2>

<p>Go to <strong>System → Egress</strong>. You see:</p>
<ul>
  <li><strong>Audit overview</strong> (from v6.6.2) — which containers can reach internet + IMDS</li>
  <li><strong>Filter column</strong> — per row, either "Enable filter" button or an active-policy badge</li>
</ul>

<h3>Enable filter (first time)</h3>
<ol>
  <li>Click <strong>Enable filter</strong> on any row</li>
  <li>Pick a preset:
    <ul>
      <li><strong>Registry-only</strong> — Docker / npm / pypi / rubygems. For build containers + runtime images that only pull deps.</li>
      <li><strong>Registries + GitHub</strong> — above plus GitHub/GHCR. For CI-style workloads.</li>
      <li><strong>Lockdown</strong> — nothing. For batch jobs, databases, containers that shouldn't talk to the internet.</li>
      <li><strong>Audit-only</strong> — logs but doesn't block. <em>Use this first</em> during migration — run a day, check the deny log, THEN flip to <code>enforce</code>.</li>
      <li><strong>Custom</strong> — paste your own hostname list.</li>
    </ul>
  </li>
  <li>Review the allowlist preview</li>
  <li>Click <strong>Save &amp; apply</strong>. The filter is active within ~2 seconds.</li>
</ol>

<h3>Block log</h3>
<p>Click a row's chevron to expand. The deny log shows the last 25 attempts with hostname, port, and reason. Entries live in the <code>egress_block_log</code> DB table, retained 30 days / max 10k rows.</p>

<h3>Emergency disable</h3>
<p>Click the cog icon on any filtered row → <strong>Emergency disable</strong>. This unapplies the filter AND deletes the policy. Container regains full outbound in &lt;5 seconds. The action is audit-logged.</p>

<h2>What gets blocked (the invariants)</h2>
<table style="width:100%;border-collapse:collapse;font-size:12px">
<tr><th style="text-align:left;border-bottom:1px solid var(--border);padding:6px">Destination</th><th style="text-align:left;border-bottom:1px solid var(--border);padding:6px">Behavior</th></tr>
<tr><td style="padding:6px"><code>169.254.169.254</code>, <code>metadata.google.internal</code>, <code>169.254.170.2</code></td><td style="padding:6px"><strong>Always blocked</strong> — even if the user adds them to a custom allowlist. Defense in depth.</td></tr>
<tr><td style="padding:6px"><code>127.0.0.0/8</code> (loopback)</td><td style="padding:6px">Always allowed — never broken by the filter.</td></tr>
<tr><td style="padding:6px">Port 53 TCP/UDP (DNS)</td><td style="padding:6px">Always allowed — containers need name resolution.</td></tr>
<tr><td style="padding:6px">RFC1918 (<code>10/8</code>, <code>172.16/12</code>, <code>192.168/16</code>)</td><td style="padding:6px">Allowed — preserves service-to-service on Docker bridges. Tighten per-stack in a future release.</td></tr>
<tr><td style="padding:6px">Everything else</td><td style="padding:6px">Hostname extracted (SNI or HTTP Host), checked against allowlist. Wildcard support (<code>*.github.com</code>).</td></tr>
</table>

<h2>Audit-log events</h2>
<p>Every action is hash-chained in the audit log (System → Audit):</p>
<ul>
  <li><code>egress_policy_created</code> / <code>_updated</code> / <code>_applied</code> / <code>_unapplied</code></li>
  <li><code>egress_emergency_disable</code> — with reason</li>
</ul>

<h2>Common gotchas</h2>
<table style="width:100%;border-collapse:collapse;font-size:12px">
<tr><th style="text-align:left;border-bottom:1px solid var(--border);padding:6px">Symptom</th><th style="text-align:left;border-bottom:1px solid var(--border);padding:6px">Cause &amp; fix</th></tr>
<tr><td style="padding:6px">"Cannot apply filter to a container with NET_ADMIN"</td><td style="padding:6px">Container can modify its own iptables → bypass. Drop <code>NET_ADMIN</code> + <code>SYS_ADMIN</code> + <code>privileged</code> first via Remediation Wizard, then re-apply.</td></tr>
<tr><td style="padding:6px">"DD_EGRESS_SIDECAR_ENDPOINT not set"</td><td style="padding:6px">Set the env var on Docker Dash, restart. See Setup step 2.</td></tr>
<tr><td style="padding:6px">Container can't reach registries after apply</td><td style="padding:6px">Preset missing the registry hostname. Try <code>Audit-only</code> first, see what it would block, then refine.</td></tr>
<tr><td style="padding:6px">Block log is empty</td><td style="padding:6px">Either nothing's been attempted yet, OR the ingester isn't running (<code>DD_EGRESS_BLOCKLOG_INGESTER=1</code>).</td></tr>
<tr><td style="padding:6px">Stack apply aborted at "db" — failed precheck</td><td style="padding:6px">One container in the stack has NET_ADMIN/privileged. Whole-stack abort is deliberate — we refuse to create half-filtered stacks.</td></tr>
</table>

<h2>Per-container vs. per-stack</h2>
<p>Both scopes work. For a compose stack, the policy applies to every container with the matching <code>com.docker.compose.project</code> label. Apply is transactional: if one container fails precheck, the whole stack is refused. Mid-stream failures roll back already-applied containers.</p>

<h2>What's deliberately NOT in this release</h2>
<ul>
  <li><strong>TLS decryption</strong> — we never break the container's trust chain</li>
  <li><strong>Per-process filtering</strong> inside a container — one policy per container</li>
  <li><strong>Source-IP-routed per-container allowlists</strong> in the sidecar — today the sidecar runs a single aggregate policy (union of all active). If you need isolated per-container policies, run multiple named sidecars (dd-egress-filter-api, dd-egress-filter-db, etc.)</li>
  <li><strong>IPv6</strong> — IPv4 only this release</li>
</ul>
