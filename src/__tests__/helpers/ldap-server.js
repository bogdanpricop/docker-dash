'use strict';
// Isolated LDAP wire fixture. Public test certificates only; never a real directory.
const net = require('node:net'), tls = require('node:tls'), fs = require('node:fs'), path = require('node:path');
const { BerWriter } = require('ldapts');
const fixture = file => fs.readFileSync(path.join(__dirname, '../fixtures/provider-tls', file), 'utf8');
function response(id, tag, code = 0) {
  const w = new BerWriter(); w.startSequence(); w.writeInt(id); w.startSequence(tag);
  w.writeEnumeration(code); w.writeString(''); w.writeString(code ? 'fixture rejection' : '');
  w.endSequence(); w.endSequence(); return w.buffer;
}
function entry(id) {
  const w = new BerWriter(); w.startSequence(); w.writeInt(id); w.startSequence(0x64);
  w.writeString('uid=alice,dc=fixture'); w.startSequence();
  for (const [name, value] of Object.entries({ uid: 'alice', mail: 'alice@example.invalid', displayName: 'Alice Fixture' })) {
    w.startSequence(); w.writeString(name); w.startSequence(0x31); w.writeString(value); w.endSequence(); w.endSequence();
  }
  w.endSequence(); w.endSequence(); w.endSequence(); return w.buffer;
}
function tlv(buffer, offset = 0) {
  if (buffer.length < offset + 2) return null;
  const tag = buffer[offset++]; let length = buffer[offset++];
  if (length & 0x80) {
    const bytes = length & 0x7f; if (bytes < 1 || bytes > 4) throw Error('Invalid fixture BER length');
    if (buffer.length < offset + bytes) return null;
    length = buffer.readUIntBE(offset, bytes); offset += bytes;
  }
  if (length > 1048576) throw Error('Fixture LDAP frame too large');
  if (buffer.length < offset + length) return null;
  return { tag, data: buffer.subarray(offset, offset + length), end: offset + length };
}
async function createLdapServer({ ldaps = false, certificate = 'server.pem', rejectStartTls = false, stallHandshake = false } = {}) {
  const sockets = new Set(), binds = [], operations = []; let connections = 0;
  const options = { key: fixture('server.key'), cert: fixture(certificate) };
  function track(socket) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); }
  function handle(socket, encrypted) {
    track(socket); let buffer = Buffer.alloc(0);
    const onData = data => {
      buffer = Buffer.concat([buffer, data]);
      try {
        let frame;
        while ((frame = tlv(buffer))) {
          buffer = buffer.subarray(frame.end);
          const idPart = tlv(frame.data), id = idPart.data.readUIntBE(0, idPart.data.length);
          const op = tlv(frame.data, idPart.end); operations.push({ tag: op.tag, encrypted });
          if (op.tag === 0x77) {
            if (rejectStartTls) { socket.write(response(id, 0x78, 52)); continue; }
            socket.off('data', onData);
            socket.write(response(id, 0x78), () => {
              if (stallHandshake) {
                socket.on('data', () => {});
                if (stallHandshake === 'trickle') {
                  // Wait for ClientHello so the LDAP response cannot consume
                  // the TLS header before the client upgrades its socket.
                  socket.once('data', () => {
                    socket.write(Buffer.from([0x16, 0x03, 0x03, 0x10, 0x00]));
                    const timer = setInterval(() => socket.write(Buffer.alloc(1)), 200);
                    socket.once('close', () => clearInterval(timer));
                  });
                }
                return;
              }
              const upgraded = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(options) });
              handle(upgraded, true);
            });
            return;
          }
          if (op.tag === 0x60) {
            const version = tlv(op.data), dn = tlv(op.data, version.end), password = tlv(op.data, dn.end);
            binds.push({ encrypted, dn: dn.data.toString(), password: password.data.toString() });
            const valid = ['service-password', 'user-password'].includes(password.data.toString());
            socket.write(response(id, 0x61, valid ? 0 : 49));
          } else if (op.tag === 0x63) socket.write(Buffer.concat([entry(id), response(id, 0x65)]));
          else if (op.tag === 0x42) socket.end();
        }
      } catch (err) { socket.destroy(err); }
    };
    socket.on('data', onData);
  }
  const server = ldaps ? tls.createServer(options, socket => handle(socket, true)) : net.createServer(socket => handle(socket, false));
  server.on('connection', socket => { connections++; track(socket); }); server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, binds, operations, get connections() { return connections; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createLdapServer, fixture };
