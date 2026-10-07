# docker.amond.ro production deployment

Date: 2026-10-07

Docker Dash 8.96.15 is published at:

- `https://docker.amond.ro`
- System page: `https://docker.amond.ro/#/system`

## Request path

1. Cloudflare proxies `docker.amond.ro`.
2. The hostname-specific Cloudflare configuration rule
   `Docker Dash Full Strict` selects strict origin TLS only when
   `http.host eq "docker.amond.ro"`.
3. Traefik terminates origin TLS with a Cloudflare Origin CA certificate whose
   only SAN is `docker.amond.ro`.
4. Traefik reaches `docker-dash:8101` over the private
   `proxy_default` Docker network.

The origin certificate is valid from 2026-10-07 through 2041-10-03. Its private
key was generated on the VPS and remains there with mode `0600`; only the CSR
was sent to Cloudflare.

## Exposure and application settings

- The application port is bound to `127.0.0.1:8101`, not a public interface.
- The temporary Caddy listener on port 8443 is stopped.
- `COOKIE_SECURE=true`.
- `BASE_URL` and `PUBLIC_URL` are `https://docker.amond.ro`.
- WebSocket origins allow the production hostname.
- `TRUST_PROXY` is restricted to the Traefik Docker network CIDR.

## Verification

- The public health endpoint returned Docker Dash 8.96.15 with status `ok`.
- The public root returned HTTP 200 through Cloudflare.
- The direct Traefik route returned the same health response with the hostname
  forced to the VPS IP.
- HSTS, CSP, frame denial, content-type protection, and no-referrer headers
  were present.
- The application container remained read-only, dropped all Linux
  capabilities, used `no-new-privileges`, and had zero restarts.
- Public connections to ports 8101 and 8443 failed after the cutover.
