'use strict';
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');

test('server revocation returns to login without reconnecting or putting the bearer token in a URL', () => {
  const sockets=[],schedule=jest.fn(),cancel=jest.fn(),unauthorized=jest.fn();
  const context={location:{protocol:'https:',host:'fixture.test'},window:{},Api:{_bearerToken:'private-fixture-token'},
    App:{handleUnauthorized:unauthorized},setTimeout:schedule,clearTimeout:cancel,console,
    WebSocket:class { constructor(url){this.url=url;this.readyState=0;sockets.push(this);} close(){} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../public/js/ws.js'),'utf8')+'\nglobalThis.fixtureWS=WS;',context);
  context.fixtureWS.connect(); expect(sockets[0].url).toBe('wss://fixture.test/ws');
  sockets[0].readyState=1;sockets[0].onopen(); schedule.mockClear();
  sockets[0].onclose({code:4003});
  expect(unauthorized).toHaveBeenCalledTimes(1); expect(schedule).not.toHaveBeenCalled();
  expect(context.fixtureWS._useTokenFallback).toBe(false); expect(context.fixtureWS._intentionalClose).toBe(true);
});
