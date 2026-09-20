# Remote secret script execution without temporary files

The SSH secret deployment route uploaded a 0600 file into /tmp and removed it only
after normal execution. Upload errors, exec rejection or transport interruption
could retain secret-bearing files. It also had no durable start record and could
return an unqualified server error after uncertain remote effects.

The shared executor now sends the payload on a host-verified SSH channel. A Bash
wrapper reads the complete input into a non-exported variable and verifies its
SHA-256 before execution. Nothing is written to a script file or placed in command
arguments. Script commands use a descriptor separate from standard input, which
is EOF, including when running through non-interactive sudo. The wrapper removes
inherited export attributes and disables shell tracing before handling the input.

The execution has a 120-second absolute deadline and a combined 1 MiB output limit.
Input is limited to 1 MiB of UTF-8 bytes, without NUL. The result requires the
verified-payload marker and an explicit exit status. Connection/channel errors,
timeouts and overflow close the transport and cannot return success. Lost
confirmation after submission is reported as uncertain, not as proof that no
commands ran. No automatic retry or application-data rollback is attempted.

A durable audit intent precedes SSH execution. Completion/failure uses the same
operation ID and records only metadata/hash, without script or output. Failed
intent storage prevents execution. Responses disable cache storage. Boolean sudo,
canonical positive host IDs and malformed host deployment authorization are
validated before connecting. Existing administrator/writeable and SSH trust checks
remain in place. English/Romanian wizard guidance and how-to content describe the
requirements and interruption boundary.

## Evidence

- Full regression: 354 suites, 4,605 passed, one existing live test skipped.
  After the final inherited-variable guard, the focused rerun passed 32 tests.
- Real SSH/Bash tests cover complete input, UTF-8, quotes, heredocs, trailing
  newlines, tampering, stdin isolation, inherited exported variables, early exit,
  nonzero exit, rejected exec, lost connection/status, bad framing, output bounds
  and the absolute timeout. Host-key rejection precedes authentication.
- Route tests cover audit content, durable intent failure, access/trust gates,
  input validation and uncertain-outcome reporting.
- Read-only canaries on LAN and VPS used the current user's key and previously
  trusted host fingerprints. Both executed the verified script, preserved Unicode
  and quoting, and rejected the wrong host key before submission. Passwordless
  sudo is unavailable for the LAN user (exit 1); VPS root completed sudo (exit 0).
  These canaries created no files and changed no remote configuration.
- Current live inventory: zero secrets_deploy_remote audit rows and zero matching
  legacy temporary scripts on either host. This does not inspect archived backups
  or establish the absence of every kind of secret elsewhere in audit history.

[Sanitized live evidence](2026-09-20-remote-secret-execution.json).
The SSH channel lifecycle follows the [SSH2 API](https://github.com/mscdex/ssh2#channel).

## Boundaries and rollout

The target needs Bash, sha256sum and /dev/fd. A secret held in process memory can
still be accessed by a privileged host administrator; the script's own commands
can intentionally create files, export variables or emit secrets. A disconnected
remote process is not guaranteed to stop. Confirm the host state before retrying.
Historical files/exports/backups from older releases require a retention review;
this change does not delete them or rewrite the existing audit hash chain.

This patch is not an application rollout. The live application checkpoint remains
8.96.3; these source changes are intended for the next tested rollout. The previous
full-image vulnerabilities and LAN Docker TCP exposure remain open separately.
