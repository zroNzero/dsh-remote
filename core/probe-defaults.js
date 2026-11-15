// Snapshot from scripts/probe.js on the reference host.
export const PROBE_DEFAULTS = Object.freeze({
  "node": "v24.17.0",
  "platform": "win32",
  "arch": "x64",
  "ipv6": {
    "hasGlobal": false,
    "hasLinkLocal": true,
    "hasLoopback": true,
    "bindAny": true,
    "connectLoopback": true
  },
  "modules": {
    "net": true,
    "dgram": true,
    "http": true,
    "crypto": true
  },
  "spawnBlocked": false
})
