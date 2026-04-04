'use strict';

const { getDb } = require('../db');
const https = require('https');
const http = require('http');
const config = require('../config');
const log = require('../utils/logger')('registry');

class RegistryService {
  list() {
    return getDb().prepare('SELECT id, name, url, username, is_default, created_at, last_used_at FROM registries ORDER BY name').all();
  }

  get(id) {
    return getDb().prepare('SELECT * FROM registries WHERE id = ?').get(id);
  }

  create({ name, url, username, password, createdBy }) {
    const encrypted = password ? this._encrypt(password) : null;
    const result = getDb().prepare(
      'INSERT INTO registries (name, url, username, password_encrypted, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(name, url.replace(/\/+$/, ''), username || null, encrypted, createdBy);
    return result.lastInsertRowid;
  }

  update(id, { name, url, username, password }) {
    const db = getDb();
    if (password) {
      db.prepare('UPDATE registries SET name=?, url=?, username=?, password_encrypted=?, last_used_at=NULL WHERE id=?')
        .run(name, url.replace(/\/+$/, ''), username || null, this._encrypt(password), id);
    } else {
      db.prepare('UPDATE registries SET name=?, url=?, username=? WHERE id=?')
        .run(name, url.replace(/\/+$/, ''), username || null, id);
    }
  }

  remove(id) {
    getDb().prepare('DELETE FROM registries WHERE id = ?').run(id);
  }

  async testConnection(id) {
    const reg = this.get(id);
    if (!reg) throw new Error('Registry not found');
    try {
      const result = await this._apiCall(reg, '/v2/');
      return { ok: true, status: result.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async catalog(id, limit = 100) {
    const reg = this.get(id);
    if (!reg) throw new Error('Registry not found');
    const data = await this._apiCall(reg, `/v2/_catalog?n=${limit}`);
    getDb().prepare("UPDATE registries SET last_used_at = datetime('now') WHERE id = ?").run(id);
    return data.body?.repositories || [];
  }

  async tags(id, repo) {
    const reg = this.get(id);
    if (!reg) throw new Error('Registry not found');
    const data = await this._apiCall(reg, `/v2/${repo}/tags/list`);
    return data.body?.tags || [];
  }

  getAuthForImage(imageName) {
    const db = getDb();
    // Match registry URL from image name
    const registries = db.prepare('SELECT * FROM registries').all();
    for (const reg of registries) {
      const host = new URL(reg.url).hostname;
      if (imageName.startsWith(host + '/') || imageName.startsWith(host + ':')) {
        return {
          username: reg.username,
          password: reg.password_encrypted ? this._decrypt(reg.password_encrypted) : '',
          serveraddress: reg.url,
        };
      }
    }
    return null;
  }

  _encrypt(text) {
    if (!text) return null;
    const key = config.security.encryptionKey;
    if (!key || key === 'change-me-to-a-random-32-char-hex') return Buffer.from(text).toString('base64');
    // Simple XOR encryption with the key (for simplicity; a real app would use AES)
    const keyBuf = Buffer.from(key, 'utf8');
    const textBuf = Buffer.from(text, 'utf8');
    const encrypted = Buffer.alloc(textBuf.length);
    for (let i = 0; i < textBuf.length; i++) {
      encrypted[i] = textBuf[i] ^ keyBuf[i % keyBuf.length];
    }
    return 'x:' + encrypted.toString('base64');
  }

  _decrypt(encrypted) {
    if (!encrypted) return '';
    if (!encrypted.startsWith('x:')) return Buffer.from(encrypted, 'base64').toString('utf8');
    const key = config.security.encryptionKey;
    const encBuf = Buffer.from(encrypted.slice(2), 'base64');
    const keyBuf = Buffer.from(key, 'utf8');
    const decrypted = Buffer.alloc(encBuf.length);
    for (let i = 0; i < encBuf.length; i++) {
      decrypted[i] = encBuf[i] ^ keyBuf[i % keyBuf.length];
    }
    return decrypted.toString('utf8');
  }

  _apiCall(reg, path) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, reg.url);
      const mod = url.protocol === 'https:' ? https : http;
      const headers = { 'Accept': 'application/json' };

      if (reg.username && reg.password_encrypted) {
        const pass = this._decrypt(reg.password_encrypted);
        headers['Authorization'] = 'Basic ' + Buffer.from(`${reg.username}:${pass}`).toString('base64');
      }

      const req = mod.get(url, { headers, timeout: 10000, rejectUnauthorized: false }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }
}

module.exports = new RegistryService();
