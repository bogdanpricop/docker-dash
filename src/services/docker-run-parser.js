'use strict';

// v8.9.7-alpha.1 — Dockge G06 closure: parse a `docker run` command line
// into a compose service definition. Intended for the "paste-command"
// converter UI on the Stacks page.
//
// Handles the common flags: image, --name, -p/--publish, -v/--volume,
// -e/--env, --env-file, --restart, --network, --user, -w/--workdir,
// --entrypoint, --hostname, --dns, --add-host, --privileged, --cap-add,
// --cap-drop, --security-opt, --tmpfs, --device, -d/--detach, --rm,
// --label, plus positional args after the image become `command:`.
//
// Not intended to be a 100% coverage compat layer for every docker run
// flag — the goal is "80% of homelab recipes convert clean."

const yaml = require('yaml');

/**
 * Tokenize a shell command line respecting single/double quotes and \\ escapes.
 * Returns an array of tokens with quotes stripped.
 */
function tokenize(str) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let escaped = false;
  const push = () => { if (cur.length) { tokens.push(cur); cur = ''; } };
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    cur += ch;
  }
  if (quote) throw new Error(`Unterminated ${quote} quote in command`);
  push();
  return tokens;
}

/**
 * Parse a `docker run` command line into a compose service dict.
 * Throws on malformed input.
 */
function parseDockerRun(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    throw new Error('command is required');
  }
  const tokens = tokenize(cmd.trim());
  // Skip leading `sudo` and `docker`/`docker run`
  let i = 0;
  while (i < tokens.length && (tokens[i] === 'sudo' || tokens[i] === 'docker' || tokens[i] === 'run')) i++;
  if (i >= tokens.length) throw new Error('No image in command');

  const svc = {};
  let containerName = null;
  let image = null;
  const args = [];

  // Helper: consume an option that takes an equals-value or a next-token value.
  const consumeVal = (tok) => {
    const eq = tok.indexOf('=');
    if (eq > 0) return tok.slice(eq + 1);
    i++;
    if (i >= tokens.length) throw new Error(`Option ${tok.split('=')[0]} needs a value`);
    return tokens[i];
  };
  const optName = (tok) => tok.split('=')[0];

  // Loop through flags until we hit a bare token (the image)
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-d' || t === '--detach') continue;
    if (t === '--rm') continue;
    if (t === '-i' || t === '--interactive') continue;
    if (t === '-t' || t === '--tty') { svc.tty = true; continue; }
    if (t === '--privileged') { svc.privileged = true; continue; }
    if (t === '--init') { svc.init = true; continue; }
    if (t.startsWith('--name')) { containerName = consumeVal(t); continue; }
    if (t === '-p' || t === '--publish' || t.startsWith('--publish=') || t.startsWith('-p=')) {
      svc.ports = svc.ports || [];
      svc.ports.push(consumeVal(t));
      continue;
    }
    if (t === '-v' || t === '--volume' || t.startsWith('--volume=') || t.startsWith('-v=')) {
      svc.volumes = svc.volumes || [];
      svc.volumes.push(consumeVal(t));
      continue;
    }
    if (t === '-e' || t === '--env' || t.startsWith('--env=') || t.startsWith('-e=')) {
      svc.environment = svc.environment || [];
      svc.environment.push(consumeVal(t));
      continue;
    }
    if (t.startsWith('--env-file')) {
      svc.env_file = svc.env_file || [];
      svc.env_file.push(consumeVal(t));
      continue;
    }
    if (t.startsWith('--restart')) { svc.restart = consumeVal(t); continue; }
    if (t === '--network' || t.startsWith('--network=') || t === '--net' || t.startsWith('--net=')) {
      svc.networks = svc.networks || [];
      svc.networks.push(consumeVal(t));
      continue;
    }
    if (t === '-u' || t === '--user' || t.startsWith('--user=') || t.startsWith('-u=')) {
      svc.user = consumeVal(t);
      continue;
    }
    if (t === '-w' || t === '--workdir' || t.startsWith('--workdir=') || t.startsWith('-w=')) {
      svc.working_dir = consumeVal(t);
      continue;
    }
    if (t.startsWith('--entrypoint')) { svc.entrypoint = consumeVal(t); continue; }
    if (t === '-h' || t === '--hostname' || t.startsWith('--hostname=') || t.startsWith('-h=')) {
      svc.hostname = consumeVal(t);
      continue;
    }
    if (t.startsWith('--dns=') || t === '--dns') {
      svc.dns = svc.dns || [];
      svc.dns.push(consumeVal(t));
      continue;
    }
    if (t.startsWith('--add-host')) {
      svc.extra_hosts = svc.extra_hosts || [];
      svc.extra_hosts.push(consumeVal(t));
      continue;
    }
    if (t.startsWith('--cap-add')) {
      svc.cap_add = svc.cap_add || [];
      svc.cap_add.push(consumeVal(t));
      continue;
    }
    if (t.startsWith('--cap-drop')) {
      svc.cap_drop = svc.cap_drop || [];
      svc.cap_drop.push(consumeVal(t));
      continue;
    }
    if (t.startsWith('--security-opt')) {
      svc.security_opt = svc.security_opt || [];
      svc.security_opt.push(consumeVal(t));
      continue;
    }
    if (t.startsWith('--tmpfs')) {
      svc.tmpfs = svc.tmpfs || [];
      svc.tmpfs.push(consumeVal(t));
      continue;
    }
    if (t.startsWith('--device')) {
      svc.devices = svc.devices || [];
      svc.devices.push(consumeVal(t));
      continue;
    }
    if (t === '-l' || t === '--label' || t.startsWith('--label=') || t.startsWith('-l=')) {
      svc.labels = svc.labels || [];
      svc.labels.push(consumeVal(t));
      continue;
    }
    if (t.startsWith('--memory') || t.startsWith('-m=') || t === '-m') {
      svc.mem_limit = consumeVal(t);
      continue;
    }
    if (t.startsWith('--cpus')) { svc.cpus = consumeVal(t); continue; }
    // Log-driver, log-opt, sysctl → pass through as unknown warnings
    if (t.startsWith('--') || t.startsWith('-')) {
      // Unknown flag with value; try to consume the value
      if (!t.includes('=') && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++;
      continue;
    }
    // First bare token = image; the rest = command
    image = t;
    i++;
    for (; i < tokens.length; i++) args.push(tokens[i]);
    break;
  }

  if (!image) throw new Error('No image found in command');
  svc.image = image;
  if (args.length) svc.command = args;

  const serviceName = (containerName || image.split('/').pop().split(':')[0] || 'service')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .toLowerCase();

  const compose = {
    services: {
      [serviceName]: svc,
    },
  };
  if (containerName) compose.services[serviceName].container_name = containerName;

  return {
    service_name: serviceName,
    yaml: yaml.stringify(compose),
    service: svc,
  };
}

module.exports = { parseDockerRun, tokenize };
