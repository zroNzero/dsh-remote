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

// 1) loading state (form null) — simulates first paint before fetch resolves
cursor = 0
slots = []
const loading = render({})

// 2) second render with form present — this is where hook-order violations throw
slots[1] = {
  role: 'host',
  peerHost: '',
  allowCommands: '',
  allowCwd: '',
  qq: { enabled: true, appId: '1', mode: 'natural', whitelist: '', sessionId: '', cwd: 'D:\\PC\\dsh', retentionKeep: 200 },
}
slots[2] = { capabilities: { canServe: true, serveEnabled: true } }
slots[3] = { qq: { state: 'ready' } }
const loaded = render({})

// 3) loaded render with workspaces populated
slots[9] = [{ id: 'w1', title: 'dsh', path: 'D:\\PC\\dsh', sessions: [{ id: 'session-1', title: 'T' }] }]
const withWs = render({})

// 4) remote snapshot present
slots[10] = { workspaceCwd: 'D:\\PC\\dsh', workspaceSessionId: '', workspaces: [{ id: 'w1', title: 'dsh', path: 'D:\\PC\\dsh', sessions: [] }] }
const withRemote = render({})

const counts = [loading.hooks, loaded.hooks, withWs.hooks, withRemote.hooks]
console.log('hook counts:', counts.join(','), 'stable:', counts.every((c) => c === counts[0]))
console.log('all renders produced a tree:', Boolean(loading.tree && loaded.tree && withWs.tree && withRemote.tree))
