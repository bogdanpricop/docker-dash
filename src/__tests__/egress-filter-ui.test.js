'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('emergency disable retains configuration and modal after failed firewall removal', async () => {
  const clicks = new Map(), nodes = new Map();
  const content = { querySelector: id => {
    if (!nodes.has(id)) nodes.set(id, { addEventListener: (_event, fn) => clicks.set(id, fn), value: '', style: {} });
    return nodes.get(id);
  } };
  const Api = { egressFilterGetPolicy: jest.fn(async () => ({ policy: { preset: 'registry-only', mode: 'enforce' } })),
    egressFilterUnapply: jest.fn(async () => { throw new Error('Recovery required'); }), egressFilterDeletePolicy: jest.fn() };
  const Modal = { _content: content, open: jest.fn(), close: jest.fn() };
  const Toast = { error: jest.fn(), warning: jest.fn() };
  const context = vm.createContext({ window: {}, Api, Modal, Toast, Utils: { escapeHtml: String }, confirm: () => true });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../public/js/pages/system-egress.js'), 'utf8'), context);
  context.window.SystemPageEgress._showEgressFilterModal({ mode: 'manage', policyId: 12, containerName: 'fixture', presets: [] });
  await clicks.get('#ef-emergency-disable')();
  expect(Api.egressFilterUnapply).toHaveBeenCalledWith(12);
  expect(Api.egressFilterDeletePolicy).not.toHaveBeenCalled();expect(Modal.close).not.toHaveBeenCalled();
  expect(Toast.error).toHaveBeenCalledWith('Recovery required');
});
