'use strict';

const { createCipheriv } = require('crypto');

const IO_TIMEOUT_MS = 15_000;
const MAX_FAILURE_REASON = 4096;

function _reverseBits(value) {
  let result = 0;
  for (let bit = 0; bit < 8; bit++) result |= ((value >> bit) & 1) << (7 - bit);
  return result;
}

function vncChallengeResponse(password, challenge) {
  if (!Buffer.isBuffer(challenge) || challenge.length !== 16) throw new Error('Invalid VNC challenge');
  const source = Buffer.alloc(8);
  Buffer.from(String(password || '').slice(0, 8), 'latin1').copy(source);
  const key = Buffer.from([...source].map(_reverseBits));
  // OpenSSL 3 commonly disables single DES, while three-key DES-EDE remains
  // available. Repeating the same key three times is mathematically identical
  // to single DES (E_k(D_k(E_k(x))) = E_k(x)), as required by VNC auth.
  const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

function _u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

async function _failureReason(channel) {
  const length = (await channel.readExact(4, IO_TIMEOUT_MS)).readUInt32BE(0);
  if (length > MAX_FAILURE_REASON) throw new Error('RFB server returned an oversized failure reason');
  return length ? (await channel.readExact(length, IO_TIMEOUT_MS)).toString('utf8') : 'RFB authentication failed';
}

async function authenticateUpstream(channel, password = null) {
  const version = await channel.readExact(12, IO_TIMEOUT_MS);
  const match = /^RFB (003|004|005)\.(\d{3})\n$/.exec(version.toString('ascii'));
  if (!match) throw new Error('Provider console did not return an RFB version');
  // VMware advertises RFB 4.x/5.x extensions. Like noVNC, negotiate standard
  // RFB 3.8 so the server gracefully drops extensions we do not implement.
  const minor = match[1] === '003' ? Number(match[2]) : 8;
  const negotiatedVersion = match[1] === '003' ? version : Buffer.from('RFB 003.008\n', 'ascii');
  await channel.write(negotiatedVersion);
  let securityType;
  if (minor <= 3) {
    securityType = (await channel.readExact(4, IO_TIMEOUT_MS)).readUInt32BE(0);
    if (securityType === 0) throw new Error(await _failureReason(channel));
    if (![1, 2].includes(securityType)) throw new Error(`Unsupported RFB security type ${securityType}`);
  } else {
    const count = (await channel.readExact(1, IO_TIMEOUT_MS))[0];
    if (count === 0) throw new Error(await _failureReason(channel));
    const types = [...await channel.readExact(count, IO_TIMEOUT_MS)];
    securityType = types.includes(1) ? 1 : (password && types.includes(2) ? 2 : null);
    if (!securityType) throw new Error('Provider RFB console requires an unsupported authentication method');
    await channel.write(Buffer.from([securityType]));
  }
  if (securityType === 2) {
    if (!password) throw new Error('Provider RFB console password is unavailable');
    const challenge = await channel.readExact(16, IO_TIMEOUT_MS);
    await channel.write(vncChallengeResponse(password, challenge));
  }
  // RFB 3.7 omits SecurityResult for the None security type; 3.8 sends it.
  if (minor >= 8 || securityType === 2) {
    const result = (await channel.readExact(4, IO_TIMEOUT_MS)).readUInt32BE(0);
    if (result !== 0) {
      const reason = minor >= 8 ? await _failureReason(channel) : 'RFB authentication failed';
      throw new Error(reason);
    }
  }
  return { version: version.toString('ascii').trim(), securityType };
}

async function authenticateBrowser(channel) {
  await channel.write(Buffer.from('RFB 003.008\n', 'ascii'));
  const version = await channel.readExact(12, IO_TIMEOUT_MS);
  const match = /^RFB 003\.(\d{3})\n$/.exec(version.toString('ascii'));
  if (!match || Number(match[1]) < 7) throw new Error('Browser RFB client version is unsupported');
  await channel.write(Buffer.from([1, 1])); // one security type: None
  const selection = (await channel.readExact(1, IO_TIMEOUT_MS))[0];
  if (selection !== 1) throw new Error('Browser rejected the gateway RFB security mode');
  await channel.write(_u32(0));
}

module.exports = {
  IO_TIMEOUT_MS, vncChallengeResponse, authenticateUpstream, authenticateBrowser,
  _internals: { _reverseBits, _u32, _failureReason },
};
