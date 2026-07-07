# vSphere SSH Telemetry (esxcli / vim-cmd)

> Batch 3 of the vSphere expansion. Module: [`src/services/vsphere-ssh.js`](../../src/services/vsphere-ssh.js). Zero new deps (ssh2 + stdlib). CommonJS.

## Why a second client

The SOAP client ([`src/services/vsphere.js`](../../src/services/vsphere.js)) already returns host CPU/mem/uptime/version/build, the VM list, datastores, networks, services, and host info (DNS/NTP/BIOS/serial/license/boot). This SSH client is deliberately narrow: it collects **only the telemetry SOAP cannot easily surface** — physical hardware sensors, installed patches (VIBs), and physical NIC link state — by running a curated set of **read-only** `esxcli` commands over SSH.

SSH telemetry is **opt-in per host**: it activates only when the host's `daemon_config` carries an optional `sshConfig = { host, port?, user, privateKey|password, passphrase? }` (same shape `migration-vm.js` uses for Proxmox). The SOAP fields `{ endpoint, username, password, skipTlsVerify }` are untouched. `decryptDaemonConfig` is reused from the SOAP module.

## Commands used

All commands are **static strings** (no user input is ever interpolated — zero injection surface) and strictly read-only (`get`/`list` verbs only). Every command uses the global `--formatter=json` option so we `JSON.parse` structured output instead of scraping tables.

| Section | Command | `--formatter=json`? | Parser |
|---|---|---|---|
| System | `esxcli --formatter=json system version get` | Yes | `parseVersion` |
| System | `esxcli --formatter=json system hostname get` | Yes | `parseHostname` |
| System | `esxcli --formatter=json hardware platform get` | Yes | `parsePlatform` |
| System | `esxcli --formatter=json hardware cpu global get` | Yes | `parseCpu` (counts) |
| System | `esxcli --formatter=json hardware cpu list` | Yes | `parseCpu` (brand string) |
| System | `esxcli --formatter=json hardware memory get` | Yes | `parseMemory` |
| Sensors | `esxcli --formatter=json hardware ipmi sdr list` | Yes* | `parseSensors` |
| Patches | `esxcli --formatter=json software vib list` | Yes | `parseVibs` |
| NICs | `esxcli --formatter=json network nic list` | Yes | `parseNics` |

\* `--formatter=json` is a documented global esxcli option available on ESXi 6.5+, so in principle it works for **every** command above. The IPMI SDR JSON output could not be verified against a live BMC in this session — the parser is written to tolerate several plausible key names (see below). `vim-cmd` is intentionally **not** used: it emits vimsh/perl-ish text (no JSON formatter), and everything of value here is reachable via `esxcli`.

## Parsed output shapes

Parsers use a normalized `pick()` lookup (lowercase, strip non-alphanumerics) so `"ProductName"`, `"Product Name"`, and `"productName"` all match — this absorbs key-casing/spacing drift across ESXi 6.7 / 7.0 / 8.0. "get" commands may return either a single object or a one-element array; `firstRow()`/`asArray()` normalize both.

```js
// getSystem(sshConfig)
{
  version, product, build, update, patch,
  hostname, fqdn, domain,
  platform: { vendor, model, serial, uuid, enclosureSerial, ipmiSupported },
  cpu:      { model, cores, threads, packages },
  memoryBytes, numaNodes,
}

// getSensors(sshConfig)
{
  fans:           [{ name, type, reading, units, state, severity }],
  powerSupplies:  [ ...same shape ],
  temperatures:   [ ...same shape ],
  voltages:       [ ...same shape ],
  other:          [ ...same shape ],
  overall: { total, degraded: [names], healthy, status: 'green'|'yellow'|'red'|'unknown' },
}
// severity ∈ ok|warning|critical|unknown; status is the worst severity seen.

// getVibs(sshConfig)
[{ name, version, vendor, acceptanceLevel, installDate, creationDate, id }]

// getNics(sshConfig)
[{ name, driver, link, speedMbps, duplex, mac, description, mtu, pciDevice, adminStatus }]
```

Sensor bucketing is by `SensorType` keyword (fan / temperature / voltage / power|current|watt|psu|supply) with a fallback to the sensor name, so it survives BMCs that label types loosely. `reading` is coerced to a number (a `"3000 RPM"` string yields `3000`); units are preserved separately.

## Public API

| Export | Purpose |
|---|---|
| `fromHostRow(row)` | Decrypts `daemon_config`, validates `sshConfig`, returns a client with bound methods. Throws if the row is not vSphere or has no usable `sshConfig`. |
| `testSsh(sshConfig)` | Connects, runs `system version get`, returns `{ ok, version, product, build }`. For a "Test SSH" button. |
| `getSensors(sshConfig)` | Hardware sensors (see shape above). |
| `getVibs(sshConfig)` | Installed VIBs. |
| `getNics(sshConfig)` | Physical NICs. |
| `getSystem(sshConfig)` | System summary. |
| `collectAll(sshConfig)` | One connection, all four sections best-effort; a failing section is `null`, not a total failure → `{ sensors, vibs, nics, system }`. |
| `CMD` | The frozen command catalog (for display/audit). |
| `_internals` | Pure parsers + error helpers, exported for unit testing. |

Each single-section call opens one SSH connection and closes it in a `finally`. `collectAll` reuses a single connection for all commands (run sequentially to respect ESXi's low `MaxSessions`). Connect timeout 20 s, per-command timeout 15 s, stdout capped at 512 KB per command.

## Error handling

`_friendlySshError` maps low-level ssh2 errors to actionable messages:

| Condition | Message |
|---|---|
| `ECONNREFUSED` | "SSH not enabled on this ESXi host … Host → Actions → Services → Enable Secure Shell (SSH)." |
| `ETIMEDOUT` / `EHOSTUNREACH` / `ENETUNREACH` | "ESXi host … is unreachable over SSH." |
| `ENOTFOUND` | "… could not be resolved (DNS lookup failed)." |
| auth failure | "SSH authentication failed for user@host …" |

`_cmdError` classifies non-zero exits: `not found` → "Command unavailable on this ESXi host", `permission/denied` → "Permission denied running …", otherwise the raw exit code + trimmed stderr.

## Target versions & caveats

- **ESXi 6.7, 7.0, 8.0** (standalone / free / paid). Commands and JSON formatter are stable across this range.
- **IPMI SDR requires a server-class BMC.** On consumer/whitebox hardware `hardware ipmi sdr list` returns an empty set → `overall.status: 'unknown'`. This is expected, not an error.
- **SSH is disabled by default** on ESXi. Until the operator enables it, `testSsh`/collection surface the friendly "SSH not enabled" message.
- **Not verified against a live host this session** — specifically the exact JSON key names of `hardware ipmi sdr list` vary by BMC vendor; the tolerant `pick()` candidates cover the common Dell/HPE/Supermicro shapes but may need one more candidate name once tested on real hardware.

## Out (with rationale)

- **`storage core adapter/device list`** — large output, and the SOAP datastore view already covers the operator's day-to-day storage need. Deferred until there's a concrete UI for it.
- **`system syslog config get` / `system ntp get`** — SOAP `getHostInfo` already returns NTP servers; syslog detail is low-value for the dashboard's read-only posture.
- **`vim-cmd hostsvc/hostsummary`** — no JSON formatter; everything useful is already reachable via `esxcli` with clean JSON.
- **Any write/set command** — this module is read-only by charter. Mutations (services, power) stay out of the SSH surface entirely.
