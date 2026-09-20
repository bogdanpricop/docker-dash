'use strict';

process.env.APP_SECRET = 'ws-path-routing-test-secret';
process.env.ENCRYPTION_KEY = 'ws-path-routing-test-key';

const { EventEmitter } = require('events');
const exported = require('../ws');

describe('WebSocket endpoint routing', () => {
  test('the shared /ws endpoint leaves dedicated gateway paths untouched', () => {
    const server = new EventEmitter();
    const instance = new exported.WsServer();
    instance._startAllEventStreams = jest.fn();
    instance.attach(server);
    const handleUpgrade = jest.spyOn(instance.wss, 'handleUpgrade').mockImplementation(() => {});
    const socket = new EventEmitter();

    server.emit('upgrade', { url: '/ws/provider-console', headers: {}, socket }, socket, Buffer.alloc(0));
    expect(handleUpgrade).not.toHaveBeenCalled();

    server.emit('upgrade', { url: '/ws?channel=events', headers: {}, socket }, socket, Buffer.alloc(0));
    expect(handleUpgrade).toHaveBeenCalledTimes(1);

    clearInterval(instance._heartbeatInterval);
    instance.wss.close();
  });
});
