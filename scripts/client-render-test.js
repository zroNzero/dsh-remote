import fs from 'node:fs'

const source = fs.readFileSync('client.js', 'utf8')

let cursor = 0
let slots = []

function reactStub() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useEffect() { cursor += 1 },
  }
}

let captured = null
const windowStub = { __ModuleLoader__: { load: (def) => { captured = def } } }

const wrapped = `(function(window, require){${source}\n})`
const run = new Function('window', 'require', `return ${wrapped}(arguments[0], arguments[1])`)

const rootCtx = {
  slots: {
    inject: () => {},
    register: () => {},
  },
}
run(windowStub, () => reactStub())

const SettingsPage = captured.factory(() => reactStub()).SettingsPage

function render(props) {
  cursor = 0
  const tree = SettingsPage({ ctx: rootCtx, ...props })
  return { tree, hooks: cursor }
}

// hook slots: 0 status, 1 form, 2 error, 3 note, 4 busy, 5 workspaces
const FORM = {
  role: 'host',
  peerHost: '',
  peerPort: 3099,
  token: '',
  onOffline: '',
  allowCommands: '',
  allowCwd: '',
  qq: {
    enabled: true,
    appId: '1',
    mode: 'natural',
    whitelist: '',
    sessionId: '',
    cwd: 'D:\\PC\\dsh',
    retentionKeep: 200,
  },
}

const HOST_STATUS = {
  capabilities: { canServe: true, serveEnabled: true },
  server: { listening: true, port: 3099, addresses: [{ address: 'fe80::1', global: false }] },
  reader: { enabled: true, unread: 0 },
  qq: { state: 'ready', allowAll: true },
}

const CLIENT_STATUS = {
  capabilities: { canServe: false, serveEnabled: false },
  server: { listening: false },
  reader: { enabled: false, unread: 0 },
  qq: { state: 'disabled' },
}

// 1) first paint before config resolves
const loading = render({})

// 2) host panel with config + status
slots[0] = HOST_STATUS
slots[1] = FORM
const loaded = render({})

// 3) host panel with workspaces + selected session
slots[5] = [{
  id: 'w1',
  title: 'dsh',
  path: 'D:\\PC\\dsh',
  sessions: [{ id: 'session-1', title: 'T', live: true }],
}]
const withWs = render({})

// 4) client-only panel (mobile): no serve capability, no QQ card
slots[0] = CLIENT_STATUS
slots[1] = { ...FORM, role: 'client' }
const mobile = render({})

const counts = [loading.hooks, loaded.hooks, withWs.hooks, mobile.hooks]
const stable = counts.every((c) => c === counts[0])
const trees = [loading.tree, loaded.tree, withWs.tree, mobile.tree]
console.log('hook counts:', counts.join(','), 'stable:', stable)
console.log('all renders produced a tree:', trees.every(Boolean))
if (!stable || !trees.every(Boolean)) process.exitCode = 1
