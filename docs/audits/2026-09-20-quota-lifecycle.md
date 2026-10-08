# Quota lifetime and router traversal

Status: installed on LAN/VPS in the audited [8.96.8 deployment](2026-09-20-deployment-8.96.8.md).
The [final-image probes](2026-09-20-image-8.96.8.json) verify bundled source hashes
and repeat all twelve HTTP/Redis scenarios on each host.

The standalone limiter previously removed timestamps older than one hour during
its five-minute cleanup, regardless of the configured duration. For a two-hour
login window, cleanup could replenish the budget after roughly an hour. Short
windows also retained inactive client keys unnecessarily. Each stored entry now
retains its configured duration; cleanup expires timestamps at that duration's
boundary. Reusing a live key with a conflicting duration fails instead of
silently resetting the budget.

The API limiter is shared across several Express mounts, including routers with
the same prefix and the final `/api` fallback. A request falling through one
router could consume the same budget twice. Each limiter instance now remembers
successful admission for that request using a WeakSet. A new HTTP request must
obtain its own decision; other limiter instances and route-specific budgets
still execute. Rejected, unavailable or timed-out decisions are never cached as
allowances. Closed responses cannot advance to protected handlers.

Five regression tests failed against the former implementation. They now pass,
along with a sixth test for conflicting durations and the full suite:
361 suites, 4742 passed, one skipped; lint passed.

Twelve native checks passed on each Docker host using disposable controllers
and a private Redis namespace. The new checks verify real HTTP router fallthrough,
independent route quotas, long-window retention, prompt short-window cleanup and
expiry. The memory-window checks use a synchronous simulated clock in the test
controller; they do not claim a two-hour real-time soak. Existing Redis pause,
late completion, OOM, recovery and proxy-identity checks also passed.

The controller base is the deployed 8.96.7 image. Listed source files were overlaid
only in the disposable controller. These original observations are separate from
the subsequent bundled-image validation and deployment linked above. Source hashes and results are in the
[JSON evidence](2026-09-20-quota-lifecycle.json). Test resources were removed.

Remaining boundaries include process-restart quota resets, wall-clock changes,
distinct-source memory pressure and HA fixed-window bursts. An admitted request
continues through the same limiter without another quota decision; that allowance
does not replace authentication or authorization at each protected operation.
This change does not alter proxy trust, configured quota values or Redis policy.

Rezumat: ferestrele lungi nu mai pierd prematur istoricul, iar o cerere care trece
prin mai multe routere consuma o singura unitate din acelasi limitator. Limitele
specifice rutelor raman active. Corectia este testata pe ambele hosturi in
containere temporare si instalata prin checkpoint-ul 8.96.8.
