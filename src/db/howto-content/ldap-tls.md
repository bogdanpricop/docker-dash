---
slug: ldap-tls
title: Verified LDAP and Active Directory transport
title_ro: Transport LDAP si Active Directory verificat
category: docker-dash
difficulty: intermediate
icon: fas fa-lock
summary: Configure verified LDAPS or StartTLS before directory passwords are sent.
summary_ro: Configureaza LDAPS sau StartTLS verificat inainte de trimiterea parolelor.
---

## Configure the directory connection

In **Settings → LDAP**, choose **StartTLS** (usually port 389) or **LDAPS** (usually
636). Both modes verify the certificate chain, validity and server name before
the service-account or user password is sent. Enter a DNS name or IP address,
not an LDAP URL, in the host field. Custom ports remain supported.

For a private PKI, obtain the issuing CA certificate through an already trusted
administrator channel and paste its PEM bundle into the CA field. A valid
self-signed server certificate can be explicitly trusted if it matches the
configured host. Never trust a certificate merely because an unverified server
returned it. With no private CA configured, the container's default trust applies.

Use a service account restricted to the directory search that Docker Dash needs.
Set its complete bind DN and password, base DN and user attribute. A required
group uses its complete DN. Test the connection, save, then verify directory
login. Local admin recovery remains available; directory passwords are never
used as a fallback local password. MFA and lockout checks still apply.

## Existing configurations and certificate rotation

The old unchecked LDAPS option now means **mandatory StartTLS**, not plaintext
LDAP. Servers that refuse StartTLS cannot receive a bind password. Configurations
with `tlsSkipVerify: true` refuse connections until an administrator saves verified
settings. There is no fallback to plaintext when the handshake fails.

When editing, an empty password or CA field preserves the saved value. **Test
Connection** also uses these saved values when left blank. Use the explicit CA
removal checkbox to return to the container's default trust. For planned CA
rotation, temporarily provide both independently verified old/new CA certificates,
rotate the server certificate, verify connections, then remove the retired CA.
Do not use a broader CA bundle than your deployment requires.

The bind password is encrypted with `ENCRYPTION_KEY`. Keep this key stable and
backed up. Old database backups can contain historical plaintext credentials;
protect them and rotate the service password as appropriate.

## Connection errors

- **Certificate issuer/chain error:** configure the verified issuer CA and ensure
  the server presents its intermediate certificates.
- **Hostname mismatch:** use the DNS name or IP address covered by the server
  certificate, or issue a corrected certificate.
- **Expired certificate:** renew it; disabling verification is not supported.
- **StartTLS rejected:** enable StartTLS on the directory or use verified LDAPS.
- **TLS handshake timeout:** check reachability, the port and the selected mode.
- **Connection lost / unencrypted reconnect refused:** retry the operation; each
  new operation establishes encryption again before authenticating.

Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0` or bypass certificate checks.

References: [LDAP authentication mechanisms (RFC 4513)](https://www.rfc-editor.org/rfc/rfc4513),
[ldapts secure transport](https://github.com/ldapts/ldapts#starttls).
