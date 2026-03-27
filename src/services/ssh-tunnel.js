'use strict';

const net = require('net');
const log = require('../utils/logger')('ssh-tunnel');

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
    // Clean up dead tunnel
    if (tunnel) {
      if (tunnel.reconnectTimer) return; // Already scheduled
      try { tunnel.server?.close(); } catch {}
      tunnel.reconnectTimer = setTimeout(async () => {
        this._tunnels.delete(hostConfig.id);
        log.info(`Reconnecting SSH tunnel for host ${hostConfig.id}`);
        try {
          await this.createTunnel(hostConfig);
        } catch (err) {
          log.error(`SSH reconnect failed for host ${hostConfig.id}: ${err.message}`);
        }
      }, 15000);
    }
  }

  /** Test SSH connection without creating persistent tunnel */
  async testConnection(sshConfig) {
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
}

module.exports = new SshTunnelService();
