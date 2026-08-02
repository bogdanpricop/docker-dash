'use strict';

const PERMISSIONS = [
  ['provider.vm.power.force', 'virtual_machine', 'force_power', 'Force power off or reboot a provider virtual machine'],
  ['provider.vm.snapshot.revert', 'provider_snapshot', 'revert', 'Revert a provider virtual machine to a snapshot'],
  ['provider.vm.snapshot.delete', 'provider_snapshot', 'delete', 'Delete a provider virtual machine snapshot'],
  ['provider.vm.migration.execute', 'virtual_machine', 'migrate', 'Execute a provider virtual machine migration'],
];

exports.up = function (db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
};

exports.down = function (db) {
  const remove = db.prepare('DELETE FROM governance_permissions WHERE permission_key=?');
  for (const [permissionKey] of PERMISSIONS) remove.run(permissionKey);
};

exports._PERMISSIONS = PERMISSIONS;
