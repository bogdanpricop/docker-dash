# Managed GitOps write-back

Managed write-back stores Docker Dash's secret-free fleet declaration in an existing Git stack repository. Configure it from **Git Stacks → Managed Git**.

The exported file is deterministic: the informational `exportedAt` timestamp is removed before hashing. A write-back plan contains the unified diff and is bound to the local and remote heads, current file hash, generated document hash, repository stack, and target path.

Apply recomputes the plan and rejects stale hashes. It also refuses to proceed when the local checkout differs from the remote branch. Commits use the existing Git-stack credential and never force-push.

Manual mode requires a reviewed plan and an explicit **Commit & Push**. Optional automatic mode runs only after a successful Fleet GitOps apply. A Git conflict does not roll back the already-applied local reconciliation; it is returned and audited as a separate write-back result.

## API

- `GET|PUT /api/gitops/managed`
- `POST /api/gitops/managed/:id/plan`
- `POST /api/gitops/managed/:id/apply`

