'use strict';

const net = require('node:net');

function endpoint(ip, port) {
  if (net.isIP(ip) !== 4 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DD_EGRESS_SIDECAR_ENDPOINT must be a valid IPv4 ip:port (1-65535)');
  }
  return { ip, port };
}

function applyScript(ip, port) {
  endpoint(ip, port);
  // Keep the existing IPv4 policy semantics in this transaction correction.
  // add/delete/recreate are submitted in ONE kernel transaction: a rejected
  // rule cannot delete the previous filter. Never flush the host ruleset.
  return `set -eu
nft -f - <<'DD_RULESET'
add table ip ddout
delete table ip ddout
table ip ddout {
 chain prerouting {
  type nat hook output priority -100; policy accept;
  ip daddr ${ip} tcp dport ${port} return
  udp dport 53 return
  tcp dport 53 return
  oifname "lo" return
  ip daddr 127.0.0.0/8 return
  ip daddr 10.0.0.0/8 return
  ip daddr 172.16.0.0/12 return
  ip daddr 192.168.0.0/16 return
  tcp dport 0-65535 dnat to ${ip}:${port}
 }
}
DD_RULESET`;
}

function removeScript() {
  return "set -eu\nprintf '%s\\n' 'add table ip ddout' 'delete table ip ddout' | nft -f -";
}

function snapshotScript() {
  // A failed netlink query is an error, not evidence that no table exists.
  // The snapshot stays in the named helper if automatic recovery fails.
  return `set -eu
umask 077
nft list tables > /tmp/dd-tables
if grep -Fxq 'table ip ddout' /tmp/dd-tables; then
 nft -snn list table ip ddout > /tmp/dd-before.nft
 test "$(wc -c < /tmp/dd-before.nft)" -le 65536
 echo DD_PRESENT
else
 : > /tmp/dd-before.nft
 echo DD_ABSENT
fi`;
}

function restoreScript() {
  return `set -eu
test -f /tmp/dd-before.nft
umask 077
printf '%s\\n' 'add table ip ddout' 'delete table ip ddout' > /tmp/dd-restore.nft
cat /tmp/dd-before.nft >> /tmp/dd-restore.nft
nft -f /tmp/dd-restore.nft
nft list tables > /tmp/dd-tables
if test -s /tmp/dd-before.nft; then
 nft -snn list table ip ddout > /tmp/dd-after.nft
 cmp /tmp/dd-before.nft /tmp/dd-after.nft
else
 if grep -Fxq 'table ip ddout' /tmp/dd-tables; then exit 1; fi
fi`;
}

module.exports = { endpoint, applyScript, removeScript, snapshotScript, restoreScript };
