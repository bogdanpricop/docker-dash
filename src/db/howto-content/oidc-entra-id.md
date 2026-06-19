---
title: OIDC SSO with Microsoft Entra ID (Azure AD)
summary: Wire Docker Dash to Microsoft Entra ID so users sign in with their corporate account, and map Entra groups to admin / operator / viewer roles.
category: security
difficulty: intermediate
icon: fab fa-microsoft
---

<h2>OIDC SSO with Microsoft Entra ID (Azure AD)</h2>
<p>Docker Dash supports OpenID Connect with any standards-compliant identity provider. This guide walks through the Entra ID setup end-to-end, including <strong>group → role mapping</strong> so your Azure AD groups own who's an admin, operator, or viewer.</p>

<h3>1. Register the app in Entra ID</h3>
<ol>
  <li><strong>Microsoft Entra admin center</strong> → <strong>App registrations</strong> → <strong>New registration</strong>.</li>
  <li><strong>Name</strong>: <code>Docker Dash</code> (or whatever you like).</li>
  <li><strong>Supported account types</strong>: usually <em>Accounts in this organizational directory only</em>.</li>
  <li><strong>Redirect URI</strong>: <em>Web</em> + your callback URL, e.g. <code>https://dockerdash.example.com/api/auth/oidc/callback</code>.</li>
  <li>Click <strong>Register</strong>. From the overview page, copy the <strong>Application (client) ID</strong> and the <strong>Directory (tenant) ID</strong>.</li>
</ol>

<h3>2. Create a client secret</h3>
<ol>
  <li>In the app registration → <strong>Certificates &amp; secrets</strong> → <strong>New client secret</strong>.</li>
  <li>Pick an expiration (24 months max — schedule a rotation reminder).</li>
  <li><strong>Copy the secret VALUE immediately</strong> — Entra hides it after you leave the page.</li>
</ol>

<h3>3. (Optional but recommended) Emit the groups claim</h3>
<p>Required if you want to map Azure AD groups to Docker Dash roles.</p>
<ol>
  <li>In the app registration → <strong>Token configuration</strong> → <strong>Add groups claim</strong>.</li>
  <li>Select <em>Security groups</em> (most common). Under <em>ID token</em>, leave <em>Group ID</em> ticked.</li>
  <li>Save.</li>
</ol>
<p class="warn-text"><i class="fas fa-exclamation-triangle"></i> Entra returns group <strong>object IDs (GUIDs)</strong> in the claim, not display names. Note down the GUIDs of the groups you want to use — Microsoft Entra admin center → Groups → click each group → copy the Object ID.</p>
<p class="warn-text"><i class="fas fa-exclamation-triangle"></i> If a user is in more than 200 groups, Entra emits an overage indicator instead of the list. The current Docker Dash implementation does not call Microsoft Graph to resolve overage — keep the relevant groups under that limit, or restrict the assignment to those groups only.</p>

<h3>4. Configure Docker Dash (env vars)</h3>
<p>Set these on the Docker Dash container (e.g. in <code>.env</code> or your <code>docker-compose.yml</code> <code>environment:</code> block) and restart:</p>
<pre><code># --- Core OIDC ---
OIDC_ENABLED=true
OIDC_ISSUER_URL=https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0
OIDC_CLIENT_ID=&lt;application-client-id&gt;
OIDC_CLIENT_SECRET=&lt;the-secret-VALUE-from-step-2&gt;
OIDC_REDIRECT_URI=https://dockerdash.example.com/api/auth/oidc/callback

# Role for new users when no group mapping is configured.
OIDC_DEFAULT_ROLE=viewer

# --- Group → role mapping (optional; v8.7.6+) ---
# The claim that lists groups. Entra defaults to "groups". If you set up
# App Roles instead and want to map those, use "roles".
OIDC_GROUP_CLAIM=groups

# Comma-separated. Use Entra group object IDs (GUIDs) — these are case-
# insensitive. Admin precedence > operator > viewer when a user is in
# multiple groups.
OIDC_ROLE_ADMIN_GROUPS=11111111-1111-1111-1111-111111111111
OIDC_ROLE_OPERATOR_GROUPS=22222222-2222-2222-2222-222222222222
OIDC_ROLE_VIEWER_GROUPS=33333333-3333-3333-3333-333333333333
</code></pre>
<p><strong>Replace the GUID placeholders with your real Azure group object IDs.</strong> Leave a list empty (or omit the env var) to skip that role.</p>

<h3>5. Sign in</h3>
<ol>
  <li>Open the Docker Dash login page. With <code>OIDC_ENABLED=true</code>, a <strong>Sign in with SSO</strong> button appears under the username/password form.</li>
  <li>Click it → you'll be redirected to <code>login.microsoftonline.com</code>, complete the corporate sign-in (MFA, Conditional Access etc. applied by Entra), and come back signed in to Docker Dash.</li>
  <li>The session uses the same cookie-based auth as local accounts. Every successful OIDC login writes an <code>oidc_login</code> audit entry.</li>
</ol>

<h3>How role assignment works</h3>
<ul>
  <li><strong>First login of a new user</strong>: a local user record is created with the role resolved from their groups, or <code>OIDC_DEFAULT_ROLE</code> if no group lists are configured or none match.</li>
  <li><strong>Subsequent logins</strong> (when ANY of the three <code>OIDC_ROLE_*_GROUPS</code> lists is configured AND the IdP actually sent the groups claim): the role is <strong>re-evaluated every time</strong> — so removing someone from the Entra admin group demotes them on their next sign-in. Logged as <code>SSO user role updated from IdP</code>.</li>
  <li><strong>When no group lists are configured</strong>: existing users' roles are NEVER touched by OIDC — an admin you promoted manually inside Docker Dash stays admin.</li>
</ul>

<h3>Behavior when the groups claim is absent (v8.7.8+)</h3>
<p>If group mapping is configured but the IdP <strong>doesn't return a usable groups claim</strong> on a particular sign-in, Docker Dash <strong>preserves the existing user's role</strong> instead of falling back to <code>OIDC_DEFAULT_ROLE</code>. This protects against silent admin-to-viewer demotions when:</p>
<ul>
  <li>A user is in <strong>more than 200 Entra groups</strong> and Entra emits the "groups overage" indicator (<code>_claim_names.groups</code> with a Microsoft Graph URL) instead of the actual list.</li>
  <li>A tenant admin re-saves the app registration and <strong>accidentally untoggles the groups claim</strong> in Token configuration.</li>
  <li>An intermediary OIDC broker <strong>strips the <code>groups</code> scope</strong>.</li>
  <li>The id_token verification falls through to the userinfo endpoint and userinfo doesn't carry the groups claim.</li>
</ul>
<p>The event is logged at <code>warn</code> level: <code>OIDC: groups claim absent or unusable — existing user role preserved (no demotion).</code> If the overage indicator was present, the log line includes <code>hasOverageIndicator: true</code> so you can spot the >200-group case immediately.</p>
<p class="warn-text"><i class="fas fa-exclamation-triangle"></i> For users in the overage state, role updates from Entra group changes will NOT take effect automatically — they keep whatever role they had at the last successful resolved-groups login. Either restrict those users to fewer groups, or manage their role manually in the Users page.</p>

<h3>Troubleshooting</h3>
<ul>
  <li><strong>"Failed to discover OIDC endpoints"</strong> — check <code>OIDC_ISSUER_URL</code>; it must include the trailing <code>/v2.0</code> and resolve from inside the Docker Dash container. Test: <code>docker exec docker-dash curl -sf $OIDC_ISSUER_URL/.well-known/openid-configuration | head</code>.</li>
  <li><strong>"Token exchange failed"</strong> — usually a redirect-URI mismatch. The URI registered in Entra and <code>OIDC_REDIRECT_URI</code> must be byte-identical.</li>
  <li><strong>User gets <code>viewer</code> even though they should be admin</strong> — likely a groups-claim issue. Check the ID token in the browser (DevTools → Network → callback request → response cookie) or inspect the audit log entry; if the <code>groups</code> claim is absent, redo step 3.</li>
  <li><strong>Browser shows <code>aria-hidden</code> warnings</strong> — unrelated to OIDC; a known modal-component a11y issue tracked separately.</li>
</ul>

<div class="tip-box">
  <i class="fas fa-lightbulb"></i>
  <strong>Tip:</strong> The same env-var contract works for Okta, Keycloak, Google Workspace, Authentik, Authelia, and any other OIDC-compliant IdP — just point <code>OIDC_ISSUER_URL</code> at their issuer and use that provider's group-claim names. Entra is the most-requested, hence this guide; if you set up another, send a PR with a matching guide.
</div>
