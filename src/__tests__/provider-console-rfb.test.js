'use strict';

const { EventEmitter } = require('events');
const ByteChannel = require('../services/provider-console/byte-channel');
const {
  vncChallengeResponse, authenticateUpstream, authenticateBrowser,
} = require('../services/provider-console/rfb');

class ScriptedChannel {
  constructor(chunks) { this.buffer = Buffer.concat(chunks); this.writes = []; }
  async readExact(size) {
    if (this.buffer.length < size) throw new Error('script exhausted');
    const value = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return value;
  }
  async write(value) { this.writes.push(Buffer.from(value)); }
}

describe('provider console RFB credential isolation', () => {
  it('matches the VNC DES challenge response vector', () => {
    expect(vncChallengeResponse('secret', Buffer.from([...Array(16).keys()])).toString('hex'))
      .toBe('ee22539f33a5983ec12f9c2edbc995dd');
  });

  it('authenticates to an upstream VNC server without forwarding its password', async () => {
    const challenge = Buffer.from([...Array(16).keys()]);
    const channel = new ScriptedChannel([
      Buffer.from('RFB 003.008\n'), Buffer.from([1]), Buffer.from([2]), challenge, Buffer.alloc(4),
    ]);
    await expect(authenticateUpstream(channel, 'secret')).resolves.toEqual({
      version: 'RFB 003.008', securityType: 2,
    });
    expect(channel.writes[0].toString()).toBe('RFB 003.008\n');
    expect(channel.writes[1]).toEqual(Buffer.from([2]));
    expect(channel.writes[2].toString('hex')).toBe('ee22539f33a5983ec12f9c2edbc995dd');
    expect(Buffer.concat(channel.writes).toString('latin1')).not.toContain('secret');
  });

  it('offers the browser a synthetic no-auth RFB 3.8 handshake', async () => {
    const channel = new ScriptedChannel([Buffer.from('RFB 003.008\n'), Buffer.from([1])]);
    await authenticateBrowser(channel);
    expect(channel.writes).toEqual([
      Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]), Buffer.alloc(4),
    ]);
  });

  it('downgrades VMware RFB extensions to the standard 3.8 contract', async () => {
    const channel = new ScriptedChannel([
      Buffer.from('RFB 004.001\n'), Buffer.from([1]), Buffer.from([1]), Buffer.alloc(4),
    ]);
    await expect(authenticateUpstream(channel)).resolves.toMatchObject({
      version: 'RFB 004.001', securityType: 1,
    });
    expect(channel.writes[0].toString()).toBe('RFB 003.008\n');
  });

  it('reassembles partial transport frames and preserves pending bytes on relay', async () => {
    const stream = new EventEmitter();
    stream.write = jest.fn((_data, cb) => cb?.());
    stream.destroy = jest.fn();
    const channel = new ByteChannel(stream);
    stream.emit('data', Buffer.from([1, 2]));
    stream.emit('data', Buffer.from([3, 4, 5]));
    await expect(channel.readExact(4)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    const forwarded = [];
    channel.startForward(data => forwarded.push(Buffer.from(data)));
    expect(forwarded).toEqual([Buffer.from([5])]);
    stream.emit('data', Buffer.from([6, 7]));
    expect(forwarded).toEqual([Buffer.from([5]), Buffer.from([6, 7])]);
    channel.destroy();
  });
});
