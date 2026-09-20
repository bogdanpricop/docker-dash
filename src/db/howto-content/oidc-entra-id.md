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
<p>OIDC identifies an account by its verified <code>iss</code> and <code>sub</code>, not its username or email. A username collision creates a separate account with a suffix; it does not inherit the matching account's roles or permissions. Changing the profile username preserves the bound account. Only an explicitly verified, unused email is stored as contact data. Historical SSO accounts without a verified binding remain for administrator review, with their old credentials revoked; the new account does not automatically inherit their permissions. Review the verified provider identity and grant the required role and resource permissions through Settings before retiring an old record. Password recovery for external accounts belongs to the identity provider.</p>
<p lang="ro">Contul OIDC este identificat prin <code>iss</code> si <code>sub</code> verificate, nu prin nume sau email. Un nume deja folosit creeaza un cont separat, cu sufix, fara mostenirea permisiunilor contului existent. Modificarea numelui de profil pastreaza identitatea asociata. Conturile SSO istorice fara o asociere verificabila se pastreaza pentru analiza administratorului, dar credentialele lor vechi sunt revocate. Verifica identitatea la furnizor si acorda explicit rolul si permisiunile necesare contului nou. Parola unui cont extern se recupereaza la furnizor.</p>
<p>Complete sign-in in the same browser and within five minutes. Docker Dash uses a temporary HttpOnly cookie, PKCE S256 and a verified ID-token nonce to bind the callback to your login. Starting another SSO login in the same browser replaces the previous flow. If the state is invalid or expired, or an update happened during sign-in, start again from the login page. The callback must use the same application host as the login page. Production deployments should use HTTPS with the correct trusted-proxy and secure-cookie configuration.</p>
<p lang="ro">Finalizeaza conectarea in acelasi browser, in cel mult cinci minute. Un cookie temporar HttpOnly, PKCE S256 si nonce-ul verificat din ID token leaga raspunsul furnizorului de conectarea initiata. O noua conectare SSO in acelasi browser o inlocuieste pe cea anterioara. Dupa expirare, eroare de state sau actualizarea aplicatiei in timpul conectarii, reia conectarea. Callback-ul trebuie sa foloseasca acelasi host al aplicatiei. In productie foloseste HTTPS si configureaza corect proxy-ul de incredere si cookie-urile securizate.</p>
<ul>
  <li><strong>First login of a new user</strong>: a local user record is created with the role resolved from their groups, or <code>OIDC_DEFAULT_ROLE</code> if no group lists are configured or none match.</li>
  <li><strong>Subsequent logins</strong> (when ANY of the three <code>OIDC_ROLE_*_GROUPS</code> lists is configured AND the IdP actually sent the groups claim): the role is <strong>re-evaluated every time</strong> — so removing someone from the Entra admin group demotes them on their next sign-in. Logged as <code>SSO user role updated from IdP</code>.</li>
  <li><strong>When no group lists are configured</strong>: existing users' roles are NEVER touched by OIDC — an admin you promoted manually inside Docker Dash stays admin.</li>
</ul>

<h3>Empty, missing or incomplete groups</h3>
<p>When group mapping is configured, an explicit empty groups array means no group membership: the account receives <code>OIDC_DEFAULT_ROLE</code> (viewer unless configured otherwise). A missing, malformed or incomplete claim <strong>refuses sign-in</strong> and revokes the bound account's sessions, personal API keys, pending MFA challenges and reset links. The stored role is retained for review but no new session is issued. Common causes include:</p>
<ul>
  <li>A user is in <strong>more than 200 Entra groups</strong> and Entra emits the "groups overage" indicator (<code>_claim_names.groups</code> with a Microsoft Graph URL) instead of the actual list.</li>
  <li>A tenant admin re-saves the app registration and <strong>accidentally untoggles the groups claim</strong> in Token configuration.</li>
  <li>An intermediary OIDC broker <strong>strips the <code>groups</code> scope</strong>.</li>
  <li>The verified ID token omits groups. Userinfo may supplement profile fields for the same subject, but cannot replace the verified role claims or bypass ID-token validation.</li>
</ul>
<p>Fix claim emission at the provider, restrict the relevant groups, or configure a complete app-role claim. Docker Dash does not fetch overage groups from Microsoft Graph. An unrelated groups overage does not invalidate a complete custom <code>roles</code> claim. Audit actions are <code>oidc_authorization_denied</code> and <code>oidc_authorization_changed</code>. Successful sign-in after correction creates a new session; old API keys and sessions remain revoked. Mapped role changes also revoke the previous credentials before issuing the new session. A later audit failure cannot undo that revocation.</p>
<p lang="ro">Daca maparea grupurilor este activata, lista goala aplica rolul implicit configurat. Lipsa grupurilor, valorile invalide sau o lista incompleta refuza conectarea si revoca sesiunile, cheile API personale, provocarile MFA si linkurile de resetare ale contului asociat. Corecteaza furnizarea grupurilor sau foloseste un claim complet de roluri. Dupa corectie, reia conectarea si inlocuieste explicit cheile API revocate. Schimbarea rolului mapat revoca de asemenea credentialele anterioare. Fara mapare de grupuri, rolurile administrate local sunt pastrate.</p>

<h3>Troubleshooting</h3>
<ul>
  <li><strong>"Failed to discover OIDC endpoints"</strong> — check <code>OIDC_ISSUER_URL</code>; it must include the trailing <code>/v2.0</code> and resolve from inside the Docker Dash container. Test: <code>docker exec docker-dash curl -sf $OIDC_ISSUER_URL/.well-known/openid-configuration | head</code>.</li>
  <li><strong>"Token exchange failed"</strong> — usually a redirect-URI mismatch. The URI registered in Entra and <code>OIDC_REDIRECT_URI</code> must be byte-identical.</li>
  <li><strong>User gets <code>viewer</code> even though they should be admin</strong> — check the IdP claim configuration and the server's groups-claim warning; if the <code>groups</code> claim is absent, redo step 3. The application session cookie is not an ID token. Do not copy credentials into token-debugging websites.</li>
  <li><strong>"OIDC identity verification failed"</strong> — the provider must issue a valid RS256 ID token for this client, including the requested nonce and a stable subject. Userinfo cannot replace a missing or invalid ID token.</li>
  <li><strong>Browser shows <code>aria-hidden</code> warnings</strong> — unrelated to OIDC; a known modal-component a11y issue tracked separately.</li>
</ul>

<div class="tip-box">
  <i class="fas fa-lightbulb"></i>
  <strong>Tip:</strong> The same env-var contract works for Okta, Keycloak, Google Workspace, Authentik, Authelia, and any other OIDC-compliant IdP — just point <code>OIDC_ISSUER_URL</code> at their issuer and use that provider's group-claim names. Entra is the most-requested, hence this guide; if you set up another, send a PR with a matching guide.
</div>
