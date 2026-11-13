---
title: CIS Docker Benchmark Guide
summary: Understand and implement CIS Docker Benchmark recommendations for host and container hardening.
category: security
difficulty: intermediate
icon: fas fa-clipboard-check
---

<h2>CIS Docker Benchmark Guide</h2>
<p>The CIS Docker Benchmark (v1.6) is the industry standard checklist for securing Docker environments. It covers host configuration, daemon settings, image hygiene, and container runtime settings.</p>

<h3>Key Areas of the Benchmark</h3>

<h4>Section 1 — Host Configuration</h4>
<ul>
  <li>Keep the host OS and kernel up to date</li>
  <li>Only install Docker on dedicated hosts when possible</li>
  <li>Audit Docker daemon files: <code>auditctl -w /usr/bin/dockerd -k docker</code></li>
</ul>

<h4>Section 2 — Docker Daemon Configuration</h4>
<pre><code>// /etc/docker/daemon.json (CIS-recommended settings)
{
  "icc": false,              // disable inter-container communication by default
  "log-level": "info",
  "live-restore": true,      // containers keep running during daemon restart
  "userland-proxy": false,
  "no-new-privileges": true
}</code></pre>

<h4>Section 4 — Container Images</h4>
<ul>
  <li>Use official or trusted base images</li>
  <li>Do not use the <code>:latest</code> tag in production</li>
  <li>Scan images for CVEs before deployment</li>
  <li>Use non-root users inside containers</li>
</ul>

<h4>Section 5 — Container Runtime</h4>
<ul>
  <li>Do not run containers with <code>--privileged</code></li>
  <li>Do not mount sensitive host paths (<code>/etc</code>, <code>/proc</code>)</li>
  <li>Set memory and CPU limits on all containers</li>
  <li>Use read-only root filesystems: <code>--read-only</code></li>
</ul>

<h3>Docker Dash CIS Tool</h3>
<p>In Docker Dash, go to <strong>Security → CIS Benchmark</strong> to run an automated check against these rules. Each item shows pass/fail status with remediation instructions.</p>

<p>Use Security → Scheduled scans to run the benchmark periodically and send a report summary to a notification channel.</p>
