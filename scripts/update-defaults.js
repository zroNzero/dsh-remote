import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const source = JSON.parse(await readFile(join(process.cwd(), 'probe-result.json'), 'utf8'))
const defaults = {
  node: source.node,
  platform: source.platform,
  arch: source.arch,
  ipv6: {
    hasGlobal: Boolean(source.ipv6 && source.ipv6.hasGlobal),
    hasLinkLocal: Boolean(source.ipv6 && source.ipv6.hasLinkLocal),
    hasLoopback: Boolean(source.ipv6 && source.ipv6.hasLoopback),
    bindAny: Boolean(source.ipv6 && source.ipv6.bindAny && source.ipv6.bindAny.ok),
    connectLoopback: Boolean(source.ipv6 && source.ipv6.connectLoopback && source.ipv6.connectLoopback.ok),
  },
  modules: {
    net: Boolean(source.modules && source.modules.net),
    dgram: Boolean(source.modules && source.modules.dgram),
    http: Boolean(source.modules && source.modules.http),
    crypto: Boolean(source.modules && source.modules.crypto),
  },
  spawnBlocked: Boolean(source.spawn && source.spawn.blocked),
}

const body = `// Snapshot from scripts/probe.js on the reference host.\nexport const PROBE_DEFAULTS = Object.freeze(${JSON.stringify(defaults, null, 2)})\n`
await writeFile(join(process.cwd(), 'core', 'probe-defaults.js'), body, 'utf8')
process.stdout.write('core/probe-defaults.js updated\n')
