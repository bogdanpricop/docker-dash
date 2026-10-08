'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

describe('V4.6a governance UI and routing contract', () => {
  test('mounts the governance API and page', () => {
    expect(read('src/server.js')).toContain("app.use('/api/governance'");
    expect(read('public/index.html')).toContain('href="#/governance"');
    expect(read('public/index.html')).toContain('/js/pages/governance.js');
    expect(read('public/js/app.js')).toContain('governance:       () => GovernancePage');
  });

  test('surfaces roles, hierarchy, invitations, ownership and all three quota dimensions', () => {
    const page = read('public/js/pages/governance.js');
    for (const contract of [
      'createGovernanceRole', 'createGovernanceScope', 'createGovernanceBinding',
      'createGovernanceProject', 'createGovernanceInvitation', 'transferGovernanceProjectOwner',
      'updateGovernanceProject', '_toggleProjectStatus',
      'cpu_millicores', 'memory_bytes', 'storage_bytes',
    ]) expect(page).toContain(contract);
    expect(read('public/js/i18n/en.js')).toContain("title: 'Governance'");
    expect(read('public/js/i18n/ro.js')).toContain('title: "Guvernanță"');
  });
});
