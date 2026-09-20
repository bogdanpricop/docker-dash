#!/bin/sh
# Auto-generate APP_SECRET and ENCRYPTION_KEY on first boot if missing.
# IMPORTANT: respects existing environment variables (set via Docker Compose
# env_file, -e flags, or Kubernetes secrets) — only writes to ENV_FILE when the
# variable is unset OR the value is the well-known placeholder.
set -e
umask 077

export ENV_FILE="${ENV_FILE:-/data/.env}"

is_placeholder() {
  case "$1" in
    ''|'generate-a-random-string-here'|'change-me'|'CHANGE_ME'|'change-me-to-a-random-32-char-hex') return 0 ;;
    *) return 1 ;;
  esac
}

ensure_secret() {
  key="$1"
  # Read CURRENT runtime value (env wins over file — env_file in compose loads here)
  eval "current=\${$key:-}"
  if ! is_placeholder "$current"; then
    return 0  # Already set to a real value — never touch it
  fi
  # Reuse persisted secrets after a container restart. Parse dotenv as data;
  # never source a file that could contain shell substitutions or commands.
  stored_val=$(node -e '
    const fs = require("fs");
    const file = process.argv[1];
    if (fs.existsSync(file)) process.stdout.write(require("dotenv").parse(fs.readFileSync(file))[process.argv[2]] || "");
  ' "$ENV_FILE" "$key")
  if ! is_placeholder "$stored_val"; then
    # Tighten older generated files where the mounted file is writable. A
    # read-only secret mount retains the permissions set by its provider.
    if [ -w "$ENV_FILE" ]; then chmod 600 "$ENV_FILE"; fi
    export "$key=$stored_val"
    return 0
  fi
  # Generate once; atomic replacement with mode 0600 and no secret-bearing .bak.
  new_val=$(openssl rand -hex 32)
  DD_BOOTSTRAP_VALUE="$new_val" node -e '
    const fs = require("fs"), crypto = require("crypto");
    const [file, key] = process.argv.slice(1);
    const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const lines = previous.split(/\r?\n/).filter(line => !new RegExp("^\\s*(?:export\\s+)?" + key + "\\s*=").test(line));
    const temporary = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
    try {
      fs.writeFileSync(temporary, lines.join("\n").replace(/\n*$/, "\n") + key + "=" + process.env.DD_BOOTSTRAP_VALUE + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  ' "$ENV_FILE" "$key"
  export "${key}=${new_val}"
  echo "[entrypoint] Generated ${key} (was unset/placeholder)"
}

ensure_secret APP_SECRET
ensure_secret ENCRYPTION_KEY

exec "$@"
