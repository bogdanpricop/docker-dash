'use strict';

// v8.9.16-alpha.1 — SSH keygen: validates the OpenSSH public-key wire format
// against ssh2's parser (the same lib that will use these keys to connect).

const { generateKeyPair, _internals } = require('../services/ssh-keygen');
const { utils: sshUtils } = require('ssh2');

function firstSshString(blobB64) {
  const blob = Buffer.from(blobB64, 'base64');
  const len = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + len).toString();
}

describe('ssh-keygen (v8.9.16-alpha.1)', () => {
  describe('ed25519', () => {
    let kp;
    beforeAll(() => { kp = generateKeyPair({ type: 'ed25519', comment: 'dockerdash@test' }); });

    it('emits an ssh-ed25519 authorized_keys line with the comment', () => {
      const parts = kp.publicKey.split(' ');
      expect(parts[0]).toBe('ssh-ed25519');
      expect(parts[2]).toBe('dockerdash@test');
      expect(firstSshString(parts[1])).toBe('ssh-ed25519');
    });

    it('private key is an OpenSSH private key', () => {
      expect(kp.privateKey).toMatch(/-----BEGIN OPENSSH PRIVATE KEY-----/);
    });

    it('fingerprint is SHA256:…', () => {
      expect(kp.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    });

    it('ssh2 parses the private key AND its derived public key matches ours', () => {
      const parsed = sshUtils.parseKey(kp.privateKey);
      expect(parsed).not.toBeInstanceOf(Error);
      // ssh2's public SSH blob must equal the blob we encoded.
      const ours = Buffer.from(kp.publicKey.split(' ')[1], 'base64');
      expect(parsed.getPublicSSH().equals(ours)).toBe(true);
    });

    it('ssh2 parses our public key line', () => {
      const parsedPub = sshUtils.parseKey(kp.publicKey);
      expect(parsedPub).not.toBeInstanceOf(Error);
      expect(parsedPub.type).toBe('ssh-ed25519');
    });
  });

  describe('rsa', () => {
    let kp;
    beforeAll(() => { kp = generateKeyPair({ type: 'rsa', bits: 2048, comment: 'rsa@test' }); });

    it('emits an ssh-rsa line', () => {
      expect(kp.publicKey.split(' ')[0]).toBe('ssh-rsa');
      expect(firstSshString(kp.publicKey.split(' ')[1])).toBe('ssh-rsa');
    });

    it('ssh2 parses the RSA private key and public blob matches', () => {
      const parsed = sshUtils.parseKey(kp.privateKey);
      expect(parsed).not.toBeInstanceOf(Error);
      const ours = Buffer.from(kp.publicKey.split(' ')[1], 'base64');
      expect(parsed.getPublicSSH().equals(ours)).toBe(true);
    });
  });

  describe('mpint encoding', () => {
    it('prepends 0x00 when the high bit is set', () => {
      const out = _internals._sshMpint(Buffer.from([0x80, 0x01]));
      // length(3) + 00 80 01
      expect(out).toEqual(Buffer.from([0, 0, 0, 3, 0x00, 0x80, 0x01]));
    });
    it('strips leading zeros', () => {
      const out = _internals._sshMpint(Buffer.from([0x00, 0x00, 0x7f]));
      expect(out).toEqual(Buffer.from([0, 0, 0, 1, 0x7f]));
    });
  });
});
