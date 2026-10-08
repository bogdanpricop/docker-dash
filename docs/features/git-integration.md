# Git integration and multi-host deploys

Git Stacks clone a repository once inside Docker Dash, then run the selected Compose files against one or more registered Docker-compatible hosts. Manual deploys, polling, webhooks, drift scans, and rollbacks use the same target list.

## Create a multi-host Git Stack

1. Register every Docker or Podman daemon under **Hosts** and confirm it is active.
2. Open **Git Stacks** and select **Deploy from Git**.
3. Enter the repository, branch, Compose path, and optional Git credential.
4. Under **Deployment Targets**, select at least one host.
5. Optionally enable **Progressive rollout** under Advanced Options, then create the stack. Docker Dash clones once and deploys to the selected hosts.

The detail page shows the latest commit, timestamp, status, and error independently for every target. **Manage** changes the target set when no deploy is running. Existing single-host stacks are migrated automatically and continue to use their original host.

## Connection behavior

- Socket hosts use their configured Unix socket.
- TCP hosts use their configured daemon address and port.
- TLS hosts receive a short-lived client certificate directory which is deleted after the Compose command.
- SSH hosts use Docker Dash's existing local SSH tunnel.

The Docker CLI context is rebuilt for every target. Inherited `DOCKER_HOST`, `DOCKER_CONTEXT`, and TLS variables are removed so one target cannot leak into the next deploy.

## Important bind-mount limitation

Compose is evaluated by Docker Dash, but bind-mount source paths are resolved by the target Docker daemon. A source such as `/srv/app/data` must therefore exist on every selected target at the same path. Prefer named volumes when hosts do not share the same filesystem layout.

## Progressive rollout and health gates

Sequential deployment remains the default for compatibility. A stack can opt into progressive waves from its detail page:

- **Fixed** waves use the configured wave size throughout the deployment.
- **Exponential** waves start small and multiply up to the maximum parallel-target limit.
- An optional delay can be inserted between successful waves.
- The health gate waits for every Compose container on a target to be running and, where configured, healthy before advancing.
- On a failed wave the rollout can pause, continue, or roll back only the targets already attempted. Targets that never received the new commit remain untouched.

The deployment history stores the exact policy and per-target outcome for each run, including wave number, health result, rollback result, and untouched targets. Changing the stack policy affects future deployments only.

## Failure and audit behavior

With the default sequential mode, a failed host does not prevent the remaining targets from being attempted. Progressive mode applies its configured failure action after the active wave finishes. The stack-level deployment is marked failed if any target fails, while each target retains its own success, failure, rollback, or untouched status and sanitized error. Audit history contains one `git_stack_deploy_target` entry per attempted target and includes the host, commit, trigger, wave, status, and actor. Policy changes are recorded as `git_stack_rollout_policy_update`.

Operators need `operate` permission on every target in a stack; viewers need `view` permission on every target to see it. Administrators retain full access.

## Pull-request previews

Each Git Stack can opt into GitHub pull-request previews on a dedicated host. A valid signed `pull_request` webhook creates an isolated Compose project for the reviewed head SHA, applies per-service CPU and memory limits, injects only preview-specific variables, and assigns a mandatory expiry. Production environment overrides are never copied. Closing the PR or reaching the TTL removes containers and empty preview networks while preserving volumes.

Fork pull requests are rejected by default. If an administrator explicitly enables them, Docker Dash clones the HTTPS head repository without reusing the base repository credential. See [Pull-request preview environments](preview-environments.md) for setup and threat-model details.
