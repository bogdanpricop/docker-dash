# Verified LDAP authentication transport

Require verified encryption before every LDAP service/user bind and search.
Keep LDAPS; the existing tls=false selection now requires StartTLS instead of
plaintext LDAP. Never fall back if StartTLS is refused or certificate validation
fails. Block the library's transparent plaintext reconnect after an upgrade.
Bound TLS handshakes as well as LDAP operations. Validate host/port and reuse
bounded CA validation. Reject tlsSkipVerify on save and on legacy runtime paths.

Expose verified private CA, preserved on blank edits and explicitly removable to
use system trust. Test uses stored service password/CA when omitted, never a
masked placeholder. Preserve encrypted storage, MFA, lockout and account-source
protections. Give EN/RO migration guidance; remove certificate-bypass troubleshooting.

Test actual LDAP wire exchanges over LDAPS and StartTLS, refusal and wrong trust
before credentials, service and user binds, bounded handshake and reconnect guard.
Verify API persistence and browser payloads, then regressions and production boot.
