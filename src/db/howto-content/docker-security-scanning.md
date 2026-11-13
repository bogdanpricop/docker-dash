---
title: Container Security Scanning
summary: Scan images for CVEs with Trivy, Grype, and Docker Scout. Understand severity levels.
category: security
difficulty: beginner
icon: fas fa-search
---

<h2>Container Security Scanning</h2>
<p>Vulnerability scanning checks your images against known CVE databases, identifying OS packages and libraries that have publicly disclosed security issues.</p>

<h3>Trivy (Most Popular, Open Source)</h3>
<pre><code># Install
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh

# Scan an image
trivy image nginx:latest

# JSON output for CI
trivy image --format json --output results.json nginx:latest

# Fail CI if CRITICAL vulnerabilities found
trivy image --exit-code 1 --severity CRITICAL nginx:latest</code></pre>

<h3>Grype (Anchore, Fast)</h3>
<pre><code># Install
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh

# Scan
grype nginx:latest

# Only critical/high
grype nginx:latest --fail-on high</code></pre>

<h3>Docker Scout (Built into Docker CLI)</h3>
<pre><code>docker scout cves nginx:latest
docker scout recommendations nginx:latest  # suggests updates</code></pre>

<h3>Understanding Severity Levels</h3>
<ul>
  <li><strong>Critical</strong> — Remotely exploitable, no authentication required. Fix immediately</li>
  <li><strong>High</strong> — Significant impact, may be exploitable. Fix within days</li>
  <li><strong>Medium</strong> — Limited impact or requires complex exploitation. Plan to fix</li>
  <li><strong>Low</strong> — Minimal risk. Fix in normal maintenance cycles</li>
  <li><strong>Negligible/Unknown</strong> — Informational only</li>
</ul>

<h3>Scanning in Docker Dash</h3>
<p>Go to <strong>Security → Vulnerability Scanner</strong>, select an image, and click <strong>Scan</strong>. Results are grouped by severity with CVE IDs, affected packages, and fix versions displayed.</p>

<h3>CI Integration (GitHub Actions)</h3>
<pre><code>- name: Scan with Trivy
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: myapp:latest
    severity: CRITICAL,HIGH
    exit-code: 1</code></pre>

<h3>Scheduled scans</h3>
<p>As an administrator, open Security → Scheduled scans. Choose a Docker host, Image vulnerabilities or CIS Docker Benchmark, and a frequency. The preview shows the next runs in the scheduler timezone. Choose a notification channel to receive the totals and a link to the report.</p>
<p>Image reports count findings per image and package, including findings with a fixed version available. CIS reports show passed checks, warnings, failures, and coverage. Run now queues a scan. Check History for its result and delivery status.</p>
