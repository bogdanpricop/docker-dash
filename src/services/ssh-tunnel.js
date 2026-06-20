'use strict';

const net = require('net');
const log = require('../utils/logger')('ssh-tunnel');

// Validate docker socket path — must be an absolute path with safe characters only (FIX #13)
const SOCKET_RE = /^\/[a-zA-Z0-9_./-]+$/;

class SshTunnelService {
  constructor() {
    this._tunnels = new Map(); // hostId → { client, localPort, server, reconnectTimer }
  }

  /** Get existing tunnel info */
  getTunnel(hostId) {
    return this._tunnels.get(hostId) || null;
  }

  /** Create SSH tunnel for a host config */
  async createTunnel(hostConfig) {
    const { id, sshConfig } = hostConfig;
    if (!sshConfig) throw new Error('SSH configuration is required');

    // Validate dockerSocket path (FIX #13)
    if (sshConfig.dockerSocket && !SOCKET_RE.test(sshConfig.dockerSocket)) {
      throw new Error('Invalid dockerSocket path');
    }

    // Close existing tunnel if any
    this.closeTunnel(id);

    const { Client } = require('ssh2');
    const remoteSocketPath = sshConfig.dockerSocket || '/var/run/docker.sock';

    return new Promise((resolve, reject) => {
      const sshClient = new Client();
      let localServer = null;
      let resolved = false;

      const connectOpts = {
        host: sshConfig.host,
        port: sshConfig.port || 22,
        username: sshConfig.username,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };

      if (sshConfig.privateKey) {
        connectOpts.privateKey = sshConfig.privateKey;
        if (sshConfig.passphrase) connectOpts.passphrase = sshConfig.passphrase;
      } else if (sshConfig.password) {
        connectOpts.password = sshConfig.password;
      }

      // Wait for SSH to be ready, THEN start local server
      sshClient.on('ready', () => {
        log.info(`SSH connected to ${sshConfig.host}:${sshConfig.port || 22} for host ${id}`);

        // Create local TCP server that forwards each connection through SSH to Docker socket
        // Try 3 methods in order: openssh streamlocal, socat, raw shell redirect
        localServer = net.createServer((localSocket) => {
          this._forwardConnection(sshClient, remoteSocketPath, localSocket, id);
        });

        localServer.listen(0, '127.0.0.1', () => {
          const localPort = localServer.address().port;
          log.info(`SSH tunnel ready for host ${id}`, { localPort, remote: `${sshConfig.host}:${remoteSocketPath}` });

          const tunnelInfo = {
            client: sshClient,
            localPort,
            server: localServer,
            hostId: id,
            reconnectTimer: null,
            // v8.7.27 — reconnect-attempt counter for exponential backoff.
            // Reset to 0 on every successful createTunnel; bumped each
            // time _scheduleReconnect fires. Capped delay at 5 min.
            reconnectAttempts: 0,
          };
          this._tunnels.set(id, tunnelInfo);
          resolved = true;
          resolve(tunnelInfo);
        });

        localServer.on('error', (err) => {
          log.error(`Tunnel local server error for host ${id}`, err.message);
          if (!resolved) { resolved = true; reject(err); }
        });
      });

      sshClient.on('error', (err) => {
        log.error(`SSH error for host ${id}`, err.message);
        if (!resolved) { resolved = true; reject(err); }
        else { this._scheduleReconnect(hostConfig); }
      });

      sshClient.on('close', () => {
        log.warn(`SSH connection closed for host ${id}`);
        if (resolved) this._scheduleReconnect(hostConfig);
      });

      // Timeout for connection
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { sshClient.end(); } catch {}
          reject(new Error(`SSH connection timeout to ${sshConfig.host}:${sshConfig.port || 22}`));
        }
      }, 20000);

      sshClient.on('ready', () => clearTimeout(timeout));
      sshClient.on('error', () => clearTimeout(timeout));

      sshClient.connect(connectOpts);
    });
  }

  /** Close tunnel for a host */
  closeTunnel(hostId) {
    const tunnel = this._tunnels.get(hostId);
    if (!tunnel) return;

    if (tunnel.reconnectTimer) clearTimeout(tunnel.reconnectTimer);
    try { tunnel.server?.close(); } catch {}
    try { tunnel.client?.end(); } catch {}
    this._tunnels.delete(hostId);
    log.info(`SSH tunnel closed for host ${hostId}`);
  }

  /** Close all tunnels */
  closeAll() {
    for (const [hostId] of this._tunnels) {
      this.closeTunnel(hostId);
    }
  }

  /** Forward a local TCP connection through SSH to the remote Docker socket */
  _forwardConnection(sshClient, remoteSocketPath, localSocket, hostId) {
    const pipe = (stream) => {
      localSocket.pipe(stream);
      stream.pipe(localSocket);
      localSocket.on('error', () => { try { stream.destroy(); } catch {} });
      stream.on('error', () => { try { localSocket.destroy(); } catch {} });
      stream.on('close', () => { try { localSocket.destroy(); } catch {} });
      localSocket.on('close', () => { try { stream.destroy(); } catch {} });
    };

    // Determine best method (cached after first success)
    const method = this._forwardMethod?.get(hostId);

    if (method === 'socat' || method === 'nc') {
      // Use previously successful method
      const cmd = method === 'socat'
        ? `socat STDIO UNIX-CONNECT:${remoteSocketPath}`
        : `nc -U ${remoteSocketPath}`;
      sshClient.exec(cmd, (err, stream) => {
        if (err) { localSocket.destroy(); return; }
        pipe(stream);
      });
      return;
    }

    if (method === 'streamlocal') {
      sshClient.openssh_forwardOutStreamLocal(remoteSocketPath, (err, stream) => {
        if (err) { localSocket.destroy(); return; }
        pipe(stream);
      });
      return;
    }

    // First connection: try each method
    if (!this._forwardMethod) this._forwardMethod = new Map();

    // Method 1: openssh_forwardOutStreamLocal (cleanest, no extra tools)
    sshClient.openssh_forwardOutStreamLocal(remoteSocketPath, (err, stream) => {
      if (!err) {
        log.info(`SSH tunnel host ${hostId}: using streamlocal method`);
        this._forwardMethod.set(hostId, 'streamlocal');
        pipe(stream);
        return;
      }

      // Method 2: socat (widely available)
      sshClient.exec(`socat STDIO UNIX-CONNECT:${remoteSocketPath}`, (err2, stream2) => {
        if (!err2) {
          log.info(`SSH tunnel host ${hostId}: using socat method`);
          this._forwardMethod.set(hostId, 'socat');
          pipe(stream2);
          return;
        }

        // Method 3: nc -U (netcat with unix socket support)
        sshClient.exec(`nc -U ${remoteSocketPath}`, (err3, stream3) => {
          if (!err3) {
            log.info(`SSH tunnel host ${hostId}: using nc method`);
            this._forwardMethod.set(hostId, 'nc');
            pipe(stream3);
            return;
          }

          log.error(`SSH tunnel host ${hostId}: all forward methods failed — streamlocal: ${err.message}, socat: ${err2.message}, nc: ${err3.message}`);
          localSocket.destroy();
        });
      });
    });
  }

  _scheduleReconnect(hostConfig) {
    const tunnel = this._tunnels.get(hostConfig.id);
    if (!tunnel) return;
    if (tunnel.reconnectTimer) return; // Already scheduled

    // v8.7.27 — exponential backoff with infinite retry. Pre-fix this
    // method scheduled ONE retry then on failure left the tunnel
    // permanently dead — any transient network outage longer than 15s
    // meant the host stayed offline in Docker Dash until manual
    // intervention. Now retries forever with backoff capped at 5 min.
    const attempts = (tunnel.reconnectAttempts || 0) + 1;
    tunnel.reconnectAttempts = attempts;
    const delayMs = Math.min(15_000 * Math.pow(2, attempts - 1), 5 * 60_000);

    try { tunnel.server?.close(); } catch {}

    tunnel.reconnectTimer = setTimeout(async () => {
      // The old tunnel slot is freed BEFORE we attempt createTunnel so
      // that createTunnel can install a fresh entry. We hold onto the
      // attempt counter across the gap so a successful reconnect can
      // reset it (createTunnel sets reconnectAttempts back to 0).
      this._tunnels.delete(hostConfig.id);
      log.info(`Reconnecting SSH tunnel for host ${hostConfig.id} (attempt ${attempts})`);
      try {
        await this.createTunnel(hostConfig);
        // Success — counter was reset inside createTunnel.
      } catch (err) {
        log.error(`SSH reconnect failed for host ${hostConfig.id} (attempt ${attempts}): ${err.message}`);
        // Re-insert a placeholder so _scheduleReconnect can find a
        // tunnel object and schedule another attempt. Same shape as a
        // live tunnel entry but with no client/server.
        this._tunnels.set(hostConfig.id, {
          client: null, localPort: null, server: null,
          hostId: hostConfig.id, reconnectTimer: null,
          reconnectAttempts: attempts,
        });
        this._scheduleReconnect(hostConfig);
      }
    }, delayMs);
  }

  /** Test SSH connection without creating persistent tunnel */
  async testConnection(sshConfig) {
    // Validate dockerSocket path (FIX #13)
    if (sshConfig.dockerSocket && !SOCKET_RE.test(sshConfig.dockerSocket)) {
      throw new Error('Invalid dockerSocket path');
    }

    const { Client } = require('ssh2');
    return new Promise((resolve, reject) => {
      const client = new Client();
      const timeout = setTimeout(() => {
        try { client.end(); } catch {}
        reject(new Error(`SSH connection timeout (10s) to ${sshConfig.host}:${sshConfig.port || 22}`));
      }, 10000);

      client.on('ready', () => {
        clearTimeout(timeout);
        // Verify Docker socket is accessible + check socat
        const socketPath = sshConfig.dockerSocket || '/var/run/docker.sock';
        client.exec(`echo "socket=$(test -S ${socketPath} && echo ok || echo missing)" && echo "socat=$(which socat 2>/dev/null && echo ok || echo missing)" && echo "docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo no-docker)"`, (err, stream) => {
          if (err) {
            client.end();
            resolve({ ok: true, dockerVersion: 'unknown (exec failed)' });
            return;
          }
          let output = '';
          stream.on('data', (d) => { output += d.toString(); });
          stream.on('close', () => {
            client.end();
            const lines = output.trim().split('\n');
            const info = {};
            for (const line of lines) {
              const [k, v] = line.split('=');
              if (k && v) info[k.trim()] = v.trim();
            }
            const warnings = [];
            if (info.socket === 'missing') warnings.push(`Docker socket ${socketPath} not found`);
            if (info.socat === 'missing') warnings.push('socat not installed (run: apt install socat / apk add socat)');
            if (info.docker === 'no-docker') warnings.push('Docker CLI not found or not in docker group');
            resolve({
              ok: true,
              dockerVersion: (info.docker && info.docker !== 'no-docker') ? info.docker : 'not detected',
              socketPath,
              socat: info.socat !== 'missing',
              warnings: warnings.length > 0 ? warnings : undefined,
            });
          });
        });
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      const opts = {
        host: sshConfig.host,
        port: sshConfig.port || 22,
        username: sshConfig.username,
        readyTimeout: 10000,
      };
      if (sshConfig.privateKey) {
        opts.privateKey = sshConfig.privateKey;
        if (sshConfig.passphrase) opts.passphrase = sshConfig.passphrase;
      } else if (sshConfig.password) {
        opts.password = sshConfig.password;
      }

      client.connect(opts);
    });
  }

  // ─── Remote exec + fs (v6.8.0) ────────────────────────
  //
  // For features like the Remediation Wizard's apply-local mode on remote
  // hosts — needs to read/write compose files over SSH + run shell commands.
  // Reuses the existing tunnel's ssh2 Client instance. If no tunnel exists,
  // returns a clear error (caller should ensure the host has a tunnel first).

  async exec(hostId, cmd, { timeoutMs = 30000 } = {}) {
    const tunnel = this._tunnels.get(hostId);
    if (!tunnel || !tunnel.client) {
      throw new Error(`No SSH tunnel for host ${hostId}. Initialize via initSshTunnels() first.`);
    }
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`SSH exec timeout after ${timeoutMs}ms: ${cmd}`)), timeoutMs);
      tunnel.client.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(to); return reject(err); }
        let stdout = '';
        let stderr = '';
        stream.on('data', (d) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        stream.on('close', (code) => {
          clearTimeout(to);
          resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : -1 });
        });
        stream.on('error', (e) => { clearTimeout(to); reject(e); });
      });
    });
  }

  async fileExists(hostId, remotePath) {
    // POSIX `test -f` returns 0 if file exists, 1 if not. Quote the path to
    // defend against spaces. Callers must pass an absolute, already-validated
    // path — this is NOT a safe interface for user input.
    const { exitCode } = await this.exec(hostId, `test -f '${remotePath.replace(/'/g, "'\\''")}'`);
    return exitCode === 0;
  }

  async readFile(hostId, remotePath) {
    const tunnel = this._tunnels.get(hostId);
    if (!tunnel?.client) throw new Error(`No SSH tunnel for host ${hostId}`);
    return new Promise((resolve, reject) => {
      tunnel.client.sftp((err, sftp) => {
        if (err) return reject(err);
        const chunks = [];
        const stream = sftp.createReadStream(remotePath);
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', reject);
      });
    });
  }

  async writeFile(hostId, remotePath, content) {
    const tunnel = this._tunnels.get(hostId);
    if (!tunnel?.client) throw new Error(`No SSH tunnel for host ${hostId}`);
    return new Promise((resolve, reject) => {
      tunnel.client.sftp((err, sftp) => {
        if (err) return reject(err);
        const stream = sftp.createWriteStream(remotePath, { mode: 0o644 });
        stream.on('close', resolve);
        stream.on('error', reject);
        stream.end(content, 'utf8');
      });
    });
  }
}

module.exports = new SshTunnelService();
