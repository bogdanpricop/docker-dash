'use strict';

// v8.9.16-alpha.1 — SSH keypair generation using Node's stdlib crypto only
// (no new deps). Produces the OpenSSH authorized_keys public-key line and a
// PEM private key. Used by the System → Tools "SSH Key Deployer" wizard.
//
// Node's crypto can generate ed25519/RSA keys and export the PRIVATE key as
// PEM directly, but it does NOT emit the OpenSSH public-key wire format. We
// build that by hand from the public JWK (RFC 4253 / OpenSSH conventions):
//   ed25519: "ssh-ed25519" + string(32-byte pubkey)
//   rsa:     "ssh-rsa"     + mpint(e) + mpint(n)

const crypto = require('crypto');

/** SSH "string": 4-byte big-endian length prefix + bytes. */
function _sshString(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/** SSH "mpint": two's-complement big-endian; a leading 0x00 is prepended when
 *  the high bit is set so the value stays positive. */
function _sshMpint(buf) {
  // Strip leading zero bytes (but keep at least one byte).
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  let b = buf.subarray(i);
  if (b.length && (b[0] & 0x80)) b = Buffer.concat([Buffer.from([0]), b]);
  return _sshString(b);
}

function _b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Build the OpenSSH authorized_keys line for a KeyObject public key. */
function _openSshPublicKey(publicKey, comment) {
  const jwk = publicKey.export({ format: 'jwk' });
  let blob, type;
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    type = 'ssh-ed25519';
    const pub = _b64urlToBuf(jwk.x); // 32 raw bytes
    blob = Buffer.concat([_sshString(Buffer.from(type)), _sshString(pub)]);
  } else if (jwk.kty === 'RSA') {
    type = 'ssh-rsa';
    const e = _b64urlToBuf(jwk.e);
    const n = _b64urlToBuf(jwk.n);
    blob = Buffer.concat([_sshString(Buffer.from(type)), _sshMpint(e), _sshMpint(n)]);
  } else {
    throw new Error(`Unsupported key type for OpenSSH export: ${jwk.kty}/${jwk.crv || ''}`);
  }
  const line = `${type} ${blob.toString('base64')}`;
  return comment ? `${line} ${comment}` : line;
}

/** Build an UNENCRYPTED OpenSSH private key (ed25519) — the format ssh2 and
 *  OpenSSH both read. Node only exports PKCS#8 (which ssh2 can't parse for
 *  ed25519), so we assemble the openssh-key-v1 container by hand. */
function _openSshPrivateKeyEd25519(seed, pub, comment) {
  const keytype = Buffer.from('ssh-ed25519');
  const pubBlob = Buffer.concat([_sshString(keytype), _sshString(pub)]);
  const priv = Buffer.concat([seed, pub]); // 64 bytes: seed || public
  const check = crypto.randomBytes(4);
  let privSection = Buffer.concat([
    check, check,
    _sshString(keytype), _sshString(pub), _sshString(priv),
    _sshString(Buffer.from(comment || '')),
  ]);
  // Pad to a multiple of 8 with 1,2,3,…
  const pad = (8 - (privSection.length % 8)) % 8;
  if (pad) privSection = Buffer.concat([privSection, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);

  const container = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    _sshString(Buffer.from('none')),   // ciphername
    _sshString(Buffer.from('none')),   // kdfname
    _sshString(Buffer.alloc(0)),       // kdfoptions
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(1, 0); return b; })(), // numkeys
    _sshString(pubBlob),               // public key
    _sshString(privSection),           // private section
  ]);
  const b64 = container.toString('base64').replace(/(.{70})/g, '$1\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END OPENSSH PRIVATE KEY-----\n`;
}

/** OpenSSH-style SHA256 fingerprint of the public-key blob (base64, no padding). */
function _fingerprint(openSshLine) {
  const b64 = openSshLine.split(' ')[1];
  const blob = Buffer.from(b64, 'base64');
  const hash = crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return `SHA256:${hash}`;
}

/**
 * Generate an SSH keypair.
 * @param {object} opts
 * @param {'ed25519'|'rsa'} [opts.type='ed25519']
 * @param {number} [opts.bits=4096] RSA modulus size
 * @param {string} [opts.comment] appended to the public-key line
 * @returns {{ type, publicKey, privateKey, fingerprint, comment }}
 */
function generateKeyPair(opts = {}) {
  const type = opts.type === 'rsa' ? 'rsa' : 'ed25519';
  const comment = (opts.comment || '').replace(/[\r\n]/g, '').slice(0, 200);

  let keyPair, privateKey;
  if (type === 'ed25519') {
    keyPair = crypto.generateKeyPairSync('ed25519');
    // ssh2 can't parse Node's PKCS#8 ed25519 — emit the OpenSSH format from
    // the raw seed (jwk.d) + public (jwk.x).
    const jwk = keyPair.privateKey.export({ format: 'jwk' });
    const seed = _b64urlToBuf(jwk.d);
    const pub = _b64urlToBuf(jwk.x);
    privateKey = _openSshPrivateKeyEd25519(seed, pub, comment);
  } else {
    const bits = [2048, 3072, 4096].includes(opts.bits) ? opts.bits : 4096;
    keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
    // PKCS#1 ("BEGIN RSA PRIVATE KEY") — parsed by ssh2 and OpenSSH.
    privateKey = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  }

  const publicKey = _openSshPublicKey(keyPair.publicKey, comment);
  return { type, publicKey, privateKey, fingerprint: _fingerprint(publicKey), comment };
}

module.exports = {
  generateKeyPair,
  _internals: { _sshString, _sshMpint, _openSshPublicKey, _fingerprint },
};
