# Pull-request preview environments

Docker Dash can create an isolated Compose project for a GitHub pull request received by an existing Git-stack webhook. Configure the policy from **Git Stacks → stack → PR Previews**.

## Safety model

- GitHub webhook HMAC verification is mandatory for every pull-request event, even when push auto-deploy is disabled.
- The webhook repository must match the configured Git stack.
- Forks are rejected by default. When explicitly allowed, the fork is cloned over HTTPS without the base repository credential.
- Preview variables have their own encrypted set. Production `env_overrides` are never copied into the preview checkout.
- Every service across all Compose files receives CPU, memory, PID, and single-replica limits plus preview labels and `docker-dash.protect=true`.
- Compose runs with an allowlisted process environment, so application secrets such as `APP_SECRET` cannot be interpolated from Docker Dash.
- Compose files and local build/config/secret/env paths must remain canonically inside the checkout. Host bind mounts, external or explicitly named volumes/networks, privileged mode, host namespaces, devices, capabilities, unsafe build entitlements, `include`, and `extends` are rejected before deployment begins.
- The Compose project name is generated from the stack and PR number, so it cannot collide with production.
- Closing the PR runs `compose down` without volume deletion. A label-scoped fallback removes project containers and networks if the checkout is incomplete.
- A leader-only five-minute reaper removes environments after their mandatory TTL.

The optional URL template is metadata for an external reverse proxy or ingress automation. It accepts `{pr}`, `{stack}`, and `{sha}` placeholders; Docker Dash does not modify DNS by itself.

Preview containers still execute arbitrary pull-request code and may make network requests. Always select a dedicated, disposable Docker/Podman host with an appropriate network egress policy; never use a production daemon as the preview target.

## API

- `GET|PUT /api/previews/stacks/:stackId/config`
- `GET /api/previews?stackId=:stackId`
- `POST /api/previews/:id/redeploy`
- `DELETE /api/previews/:id`
- Public lifecycle delivery continues through `POST /api/git/webhook/:token` with `X-GitHub-Event: pull_request`.
