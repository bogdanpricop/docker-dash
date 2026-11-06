'use strict';

jest.mock('../db', () => ({ getDb: () => ({ prepare: () => ({ get: () => ({ id: 7 }) }) }) }));
const { hostScope, matchesContainer } = require('../services/egress-policy-scope');
const id = 'a'.repeat(64);
const info = { Id: id, Config: { Labels: { 'com.docker.compose.project': 'project-a' } } };

test.each([[0, 7, true], [7, 0, true], [7, 7, true], [0, 8, false], [8, 0, false], [8, 8, true]])(
  'host %i matches policy host %i: %s', (host, policyHost, expected) => {
    expect(!!hostScope(host)(policyHost)).toBe(expected);
  });

test.each([
  ['container', id, 7, true], ['container', id.slice(0, 12), 0, true],
  ['container', 'a'.repeat(11), 0, false], ['container', 'b'.repeat(64), 0, false],
  ['stack', 'project-a', 7, true], ['stack', 'project-b', 0, false],
  ['stack', 'project-a', 8, false], ['unknown', 'project-a', 0, false],
])('scope %s/%s on host %i matches: %s', (scopeType, scopeKey, hostId, expected) => {
  expect(matchesContainer({ scopeType, scopeKey, hostId }, info, hostScope(0))).toBe(expected);
});
