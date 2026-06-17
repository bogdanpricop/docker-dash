# Deployment recipes

Ready-to-customize `docker-compose.yml` files for the common Docker Dash deployment patterns. **All seven recipes are also generated live and interactively** inside the running app — open **System → Tools → Deployment Configurator** to set the values for your environment, see the YAML rebuild as you type, and Copy/Download the result.

These static files are the same content the wizard emits, with the recipe defaults baked in — useful for browsing on GitHub.

## Which one is for me?

| Setup | File | Recipe id |
|---|---|---|
| Just trying it out, or behind a LAN-only proxy | [`compose.standalone.yml`](compose.standalone.yml) | `standalone` |
| Want HTTPS with one line, zero config | [`compose.caddy.yml`](compose.caddy.yml) | `caddy` |
| Already running Traefik v3 (plain Compose) | [`compose.traefik.yml`](compose.traefik.yml) | `traefik` |
| Already running Nginx Proxy Manager | [`compose.npm.yml`](compose.npm.yml) | `npm` |
| Docker Swarm + Traefik | [`compose.swarm-traefik.yml`](compose.swarm-traefik.yml) | `swarm-traefik` |
| Need HA (2 replicas + Redis leader election) | [`compose.ha.yml`](compose.ha.yml) | `ha` |
| Deploying on a Synology DSM NAS | [`compose.synology.yml`](compose.synology.yml) | `synology` |

## Before you deploy any of these

**Edit the credentials placeholders** — at minimum:

1. `ADMIN_PASSWORD` — first-login admin password (Docker Dash forces a change on first login regardless, but pick something other than the placeholder).
2. `ENCRYPTION_KEY` — must be **at least 32 characters**; this encrypts secrets at rest (git credentials, OIDC client secret, registry passwords, etc.). **Rotating it later requires re-entering every stored credential.**
3. For HA: `REDIS_URL` password must match the `--requirepass` value on the Redis service.

For recipes with a reverse proxy in front (`caddy`, `traefik`, `npm`, `swarm-traefik`), also set:
- `PUBLIC_URL` to `https://your.domain` so OIDC redirects and absolute links work correctly.
- For Caddy: the email under `tls` (Let's Encrypt notifications).
- For Traefik / Swarm-Traefik: the `network` (must exist + be attached to Traefik) and `certResolver` (must be configured in your Traefik static config) match your setup.

## Deploy

```bash
# Plain Compose
docker compose -f compose.<id>.yml up -d

# Docker Swarm (only for compose.swarm-traefik.yml)
docker stack deploy -c compose.swarm-traefik.yml docker-dash

# Synology DSM
# Container Manager → Project → Create → "Create docker-compose.yml" → paste compose.synology.yml
```

## Re-generating from source

If you edit a recipe template in `public/js/components/deployment-configurator.js`, snapshot the updated examples with:

```bash
node scripts/generate-deployment-examples.js
```

That's the single source of truth — these files are derived from it. Tests in `src/__tests__/deployment-recipes.test.js` guarantee every recipe stays parseable.
