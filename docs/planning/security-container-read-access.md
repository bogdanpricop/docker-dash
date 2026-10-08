# Container read authorization

An authenticated user with a stack deny rule can still request several named
container read endpoints directly. Pipeline status additionally accepts an
execution ID without binding it to the requested host and container.

Apply the existing fail-closed container view middleware to every single-container
read route that lacks an equivalent check, including metadata by name, files,
exports, diagnostics and deployment history. The authorization must run before
the route reads files, history or other restricted data. Global administrators
retain their documented stack override.

Pipeline status must validate a positive numeric execution ID, compare the
stored host to the selected host, resolve the requested container and compare
its canonical ID to the stored original container ID. New pipelines persist the
canonical inspected ID. Unknown or mismatched executions return 404 without
disclosing their content. This status route addresses a live original container;
historical runs after replacement remain accessible through the separately
authorized container history route. Legacy rows containing only short IDs do
not pass the exact-ID status check.

Regression tests must exercise all newly guarded paths with a denied operator,
including file download/export, and demonstrate that another host or container's
execution cannot be read even by changing only the execution ID. A matching
execution remains readable. Broad inventory, graph and historical-name reuse
authorization require separate review; this change does not declare them safe.

The adjacent rollback endpoint also accepts a global history ID. Bind the selected
row to the current container name and host before any image lookup or mutation.
Reject a self rollback. Parse historical configuration before stopping anything,
and require the operator's permission on its historical stack too. Operators
cannot use a legacy record lacking configuration as an authorization fallback.
History responses must omit configuration snapshots containing environment
secrets and mount configuration. Snapshot retention/encryption and transactional
rollback remain separate work.

If the authorization inspection cannot be completed, return a fail-closed 503
without raw Docker connection details (404 for a missing container). Do not run
the endpoint's remaining work in either case.
