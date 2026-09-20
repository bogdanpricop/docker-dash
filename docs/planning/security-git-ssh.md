# Strict Git SSH transport

Git currently runs OpenSSH with host verification disabled for probes, clone,
preview and managed repository operations. Replace this with strict explicit
known_hosts trust attached to each SSH credential. Existing credentials without
trust remain editable but cannot authenticate until an administrator adds keys
verified through a provider's official publication or trusted management channel.

Persist the nonsecret known_hosts lines in a new monotonic database migration.
Validate bounded input and actual public-key encoding. Support exact host names,
nondefault-port host entries and hashed OpenSSH host names. Reject wildcard trust,
unknown markers, malformed keys and empty trust. Never run keyscan as an automatic
trust source. Create/edit forms expose the trust and explain it in English/Romanian;
editing trust must retain the existing private key.

Every Git client gets a deterministic SSH command: strict host checking, supplied
known_hosts only, no user/system SSH config, no agent/default-key/password fallback
and no automatic host-key updates. SSH without a managed credential is denied.
Strip inherited Git/SSH transport overrides. HTTPS operations must not acquire an
ambient SSH identity if a URL rewrite or repository config invokes SSH.

Use unique private temporary directories per operation, exclusive mode-0600 key
and trust files, and finally cleanup on success/failure. Concurrent operations
must not overwrite each other's trust or key. Existing plain keys from the old
implementation require cleanup without deleting unrelated files.

Cover all probe, clone, preview, fetch/pull, diff/status, push and rollback paths.
Use a real local SSH server and real Git/OpenSSH to prove trusted-key operation,
changed/unknown key refusal before authentication, and cleanup. Include malformed
trust, credential updates, concurrent session isolation, hostile environment and
frontend round trips. This is separate from provider TLS and Docker image issues.
