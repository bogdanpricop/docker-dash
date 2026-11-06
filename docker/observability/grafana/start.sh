#!/bin/sh
set -eu

# A missing or empty __FILE setting can otherwise fall back to Grafana's
# bootstrap default. Validate before invoking the official image entrypoint.
secret=${GF_SECURITY_ADMIN_PASSWORD__FILE:-}
if [ -z "$secret" ] || [ ! -f "$secret" ] || [ ! -r "$secret" ]; then
  echo 'Grafana requires a readable bootstrap password file.' >&2
  exit 1
fi
size=$(wc -c < "$secret")
if [ "$size" -gt 257 ]; then
  echo 'Grafana bootstrap password file is too large.' >&2
  exit 1
fi
password=$(cat "$secret")
case "$password" in
  *'
'*) echo 'Grafana bootstrap password must be a single line.' >&2; exit 1 ;;
esac
if [ "${#password}" -lt 20 ] || [ "${#password}" -gt 256 ] || ! grep -q '[^[:space:]]' "$secret"; then
  echo 'Grafana bootstrap password must contain 20 to 256 characters.' >&2
  exit 1
fi
unset password
exec /run.sh "$@"
