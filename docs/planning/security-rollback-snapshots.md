# Encrypted rollback snapshots

Container history stores environment variables, commands and mount configuration
needed for rollback. Encrypt the complete snapshot with the existing AES-256-GCM
key before persistence, including a versioned envelope bound to the history row's
host, container identity, name and image identity. Reject damaged ciphertext,
wrong keys, plaintext inserted after migration and mismatched context before
any Docker mutation. Do not expose snapshots through the history API.

Migrate existing nonempty snapshots atomically, preserving malformed legacy JSON
as encrypted data that still cannot be restored. Never silently discard a record
or continue an update when the required history write/encryption fails. Leave
null historical snapshots compatible with the existing administrator-only
fallback. Do not claim to erase previous backups, WAL contents or free pages.

Verify migration, authenticated round trips, wrong keys, corruption, swapped rows,
all four history writers and rollback/API behavior using actual SQLite. Document
key recovery and backup limitations in English/Romanian product help. Transactional
Docker replacement and historical audit-log cleanup remain separate work.
