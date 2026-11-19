# Runtime corrections found during AI Compute release validation

The unchanged application base failed the final image gate on 20 November 2026. Grype reported seven high-severity Node.js advisories and four OpenSSL advisory IDs across `openssl`, `libssl3` and `libcrypto3`.

* Pin the official Node.js **24.22.3** Alpine image by manifest digest, matching the development/CI engine pin. [Node.js November security release](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases/) fixes CVE-2026-123863, CVE-2026-123864, CVE-2026-123865, CVE-2026-123866, CVE-2026-123872, CVE-2026-123874 and CVE-2026-126051, as well as the medium/low findings listed upstream.
* Require Alpine **3.5.9-r1** or newer for OpenSSL and both shared libraries. [Alpine 3.24 security metadata](https://secdb.alpinelinux.org/v3.24/main.json) explicitly records backports for CVE-2026-88822, CVE-2026-88823, CVE-2026-95691, CVE-2026-95692 and CVE-2026-107496 in that package revision. The upstream 3.5.10 version boundary must not be mistaken for absence of these distribution backports.
* Explicit minimum APK revisions invalidate the previously cached vulnerable package layer. The Node base digest also invalidates inherited runtime layers.

No vulnerability exceptions or severity thresholds were relaxed. Existing scanner binaries and their reviewed source/package inventories remain unchanged. Host deployments must also receive the updated Node binary and APK libraries; copying application sources onto an old runtime alone is insufficient.
