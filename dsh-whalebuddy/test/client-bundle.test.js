import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Load the shipped browser bundle in a bare VM context with only `window`,
 * `fetch` and `console` — the same surface the real module loader provides
 * minus React and the DOM.
 * @param {(url: string, init?: object) => Promise<object>} fetchImpl
 * @returns {{ id: string, factory: (require: (specifier: string) => unknown) => object }}
 */
function loadBundle(fetchImpl, windowExtra = {}) {
  let registered
  const window = {
    ...windowExtra,
    __ModuleLoader__: {
      load(module) {
        registered = module
      },
    },
  }
  const sandbox = { window, fetch: fetchImpl, console }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(registered, 'the bundle must call window.__ModuleLoader__.load')
  registered.window = window
  return registered
}

/**
 * A minimal React: element records plus hook cells that survive between the
 * two manual renders this test performs.
 * @returns {*}
 */
function fakeReact() {
  const cells = []
  let cursor = 0
  let effectRan = false

  const React = {
    createElement(type, props, ...children) {
      const merged = { ...props }
      const flat = children.flat()
      if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
      return { type, props: merged }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [
        cells[index],
        (value) => {
          cells[index] = typeof value === 'function' ? value(cells[index]) : value
        },
      ]
    },
    useRef(value) {
      const index = cursor
      cursor += 1
      if (!(index in cells)) cells[index] = { current: value }
      return cells[index]
    },
    useEffect(effect) {
      if (effectRan) return
      effectRan = true
      effect()
    },
  }

  /**
   * Render one pass, resetting the hook cursor the way React restarts the
   * hook list on every render.
   * @param {Function} component
   * @returns {*}
   */
  React.render = (component) => {
    cursor = 0
    return component()
  }

  return React
}

/**
 * @param {*} node
 * @param {(node: {type: string, props: object}) => boolean} predicate
 * @param {Array<*>} [out]
 * @returns {Array<*>}
 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.props?.children, predicate, out)
  return out
}

/**
 * @param {*} node
 * @returns {string}
 */
function textOf(node) {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object') return textOf(node.props?.children)
  return ''
}

const PANEL_STATE = {
  employees: [
    { slug: 'niji', name: '逆戟', role: '视频', autonomy: 'L2', updatedAt: 1 },
    { slug: 'yijiao', name: '一角', role: '美术', autonomy: 'L2', updatedAt: 2 },
  ],
  selected: 'niji',
  colleague: {
    slug: 'niji',
    files: {
      profile: '# 逆戟\n- 岗位：视频',
      hot: '热记忆一句',
      rapport: '',
      knowledge: '',
      roster: '## 同事',
      changelog: '- [2026-11-14 01:00] 收工：纠错 +1',
      tasks: JSON.stringify([{ id: 't1', text: '做一支样片', status: 'open' }]),
    },
    bound: [],
    preview: '### 身份\n# 逆戟\n- 岗位：视频',
  },
  workspaces: [{ id: 'w1', title: '示例项目', path: 'C:/work/a' }],
}

/** @param {string} url @param {object} [init] */
async function okFetch(url, init) {
  okFetch.calls.push({ url, init })
  return {
    ok: true,
    status: 200,
    async json() {
      if (url.includes('/assign')) {
        return { saved: true, bound: ['C:/work/a'], preview: '### 身份\n# 逆戟\n- 工作区：C:/work/a' }
      }
      return url.includes('/save') ? { saved: true, preview: '### 身份\n# 逆戟\n- 岗位：视频\n### 同事' } : PANEL_STATE
    },
  }
}
okFetch.calls = []

/**
 * Build the plugin the way the loader does, and register its slots on a fake
 * client context that records the descriptors.
 * @returns {{ plugin: object, registered: Array<{descriptor: object, component: Function}>, cleanups: Array<Function>, react: * }}
 */
function mountPlugin(options = {}) {
  okFetch.calls = []
  const bundle = loadBundle(okFetch, options.window)
  const react = fakeReact()
  const plugin = bundle.factory((specifier) => {
    assert.equal(specifier, 'react')
    return react
  })

  const registered = []
  const cleanups = []
  const ctx = {
    slots: {
      inject(key, callback) {
        assert.equal(typeof key, 'string')
        return callback()
      },
      register(descriptor, component) {
        registered.push({ descriptor, component })
        return () => {}
      },
    },
    effect(callback) {
      cleanups.push(callback())
      return () => {}
    },
    get(name) {
      return name === 'uiWorkspace' ? options.uiWorkspace : undefined
    },
  }
  plugin.apply(ctx)
  return { plugin, registered, cleanups, react }
}

test('the bundle registers itself under the package name', () => {
  const bundle = loadBundle(okFetch)
  assert.equal(bundle.id, 'dsh-whalebuddy')
})

test('the factory returns a slots plugin carrying the panel components', () => {
  const { plugin } = mountPlugin()
  assert.equal(plugin.name, 'whalebuddy')
  assert.equal(plugin.inject.length, 1)
  assert.equal(plugin.inject[0], 'slots')
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the sidebar row and the keyed main page', () => {
  const { registered } = mountPlugin()
  assert.equal(registered.length, 2)

  const row = registered[0].descriptor
  assert.equal(row.name, 'sidebar.panellist')
  assert.equal(row.id, 'whalebuddy')
  assert.equal(row.order, 40)
  assert.equal(row.label(), 'Whalebuddy')

  const page = registered[1].descriptor
  assert.equal(page.name, 'main')
  assert.equal(page.key, 'whalebuddy')
  assert.equal(typeof registered[0].component, 'function')
  assert.equal(typeof registered[1].component, 'function')
})

test('the sidebar glyph is drawn at the size the shell asks for', () => {
  const { registered } = mountPlugin()
  const icon = registered[0].component({ size: 22, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 22)
  assert.equal(icon.props.viewBox, '0 0 24 24')
  assert.equal(icon.props.strokeWidth, 2)
  assert.equal(icon.props['data-dsh-panel-entry'], 'whalebuddy')
  assert.equal(icon.props.children.length, 4)
})

test('the page asks the host for state, then renders the list, editor and preview', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component

  const first = react.render(Page)
  assert.equal(typeof first.type, 'string')
  assert.equal(textOf(findAll(first, (node) => node.type === 'h2')[0]), 'Whalebuddy')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(okFetch.calls[0].url, 'api/whalebuddy/state')

  const second = react.render(Page)
  const items = findAll(second, (node) => node.props?.className === 'wb-item')
  assert.equal(items.length, 2)
  assert.match(textOf(items[0]), /逆戟/)
  assert.match(textOf(items[0]), /视频/)

  const textarea = findAll(second, (node) => node.type === 'textarea')[0]
  assert.match(textarea.props.value, /# 逆戟/)

  const preview = findAll(second, (node) => node.props?.className === 'wb-pre')[0]
  assert.match(textOf(preview), /### 身份/)
})

test('the save button posts the selected file and adopts the returned preview', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component

  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  const tree = react.render(Page)

  const saveButton = findAll(
    tree,
    (node) => node.type === 'button' && textOf(node) === '保存',
  )[0]
  assert.ok(saveButton, 'the editor must offer a save button')
  saveButton.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  const save = okFetch.calls.find((call) => call.url === 'api/whalebuddy/save')
  assert.ok(save, 'saving must reach the host save route')
  assert.equal(save.init.method, 'POST')
  const body = JSON.parse(save.init.body)
  assert.equal(body.slug, 'niji')
  assert.equal(body.rel, 'profile.md')
  assert.match(body.text, /# 逆戟/)

  const updated = react.render(Page)
  const preview = findAll(updated, (node) => node.props?.className === 'wb-pre')[0]
  assert.match(textOf(preview), /### 同事/)
})

test('switching colleagues warns when an inactive tab still has unsaved work', async () => {
  const confirmCalls = []
  const { registered, react } = mountPlugin({
    window: {
      confirm(message) {
        confirmCalls.push(message)
        return false
      },
    },
  })
  const Page = registered[1].component

  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const textarea = findAll(tree, (node) => node.type === 'textarea')[0]
  textarea.props.onChange({ target: { value: '# 逆戟\n改过的一行' } })
  tree = react.render(Page)
  const hotTab = findAll(tree, (node) => node.type === 'button' && textOf(node) === '热记忆')[0]
  hotTab.props.onClick()
  tree = react.render(Page)

  // The visible tab (hot) is clean; the profile draft is not.
  const other = findAll(tree, (node) => node.props?.className === 'wb-item')[1]
  other.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(confirmCalls.length, 1, 'the switch must ask before dropping the draft')
  assert.match(confirmCalls[0], /还没保存/)
  assert.equal(
    okFetch.calls.filter((call) => call.url.startsWith('api/whalebuddy/state')).length,
    1,
    'declining the prompt must keep the current colleague',
  )
})

test('the change log tab is read-only and never saves', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component

  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const changelogTab = findAll(tree, (node) => node.type === 'button' && textOf(node) === '变更')[0]
  assert.ok(changelogTab, 'the change log has a tab')
  changelogTab.props.onClick()
  tree = react.render(Page)

  const textarea = findAll(tree, (node) => node.type === 'textarea')[0]
  assert.equal(textarea.props.readOnly, true)
  assert.equal(textarea.props.value, '- [2026-11-14 01:00] 收工：纠错 +1')
  const saveButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === '保存')[0]
  assert.equal(saveButton.props.disabled, true)
  assert.match(textOf(findAll(tree, (node) => node.props?.className === 'wb-hint')[0]), /只读/)
})

test('the tasks tab toggles a task through the save route', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component

  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const tab = findAll(tree, (node) => node.type === 'button' && textOf(node) === '待办')[0]
  assert.ok(tab, 'tasks have a tab')
  tab.props.onClick()
  tree = react.render(Page)

  const box = findAll(tree, (node) => node.type === 'input' && node.props?.type === 'checkbox')[0]
  assert.ok(box, 'the task renders a checkbox')
  assert.equal(box.props.checked, false)
  box.props.onChange()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const save = okFetch.calls.find((entry) => entry.url === 'api/whalebuddy/save')
  assert.ok(save, 'toggling saves the list')
  const body = JSON.parse(save.init.body)
  assert.equal(body.rel, 'memory/tasks.json')
  assert.match(body.text, /"status": "done"/)
  assert.match(textOf(findAll(react.render(Page), (node) => node.props?.className === 'wb-hint')[0]), /勾选即保存/)
})

test('a workspace is assigned and opened with the colleague preset', async () => {
  const started = []
  const { registered, react } = mountPlugin({
    uiWorkspace: {
      startSession(workspaceId, startOptions) {
        started.push({ workspaceId, options: startOptions })
      },
    },
  })
  const Page = registered[1].component

  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const add = findAll(tree, (node) => node.props?.className === 'wb-wsAdd')[0]
  assert.ok(add, 'the sidebar offers a workspace picker')
  add.props.onClick()
  tree = react.render(Page)
  const row = findAll(tree, (node) => node.props?.className === 'wb-ws')[0]
  assert.ok(row, 'the unbound workspace is listed after opening the picker')
  row.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const assign = okFetch.calls.find((entry) => entry.url === 'api/whalebuddy/assign')
  assert.ok(assign, 'the workspace is recorded before the session opens')
  assert.deepEqual(JSON.parse(assign.init.body), { slug: 'niji', workspaceId: 'w1' })
  assert.equal(started.length, 1)
  assert.equal(started[0].workspaceId, 'w1')
  // The bundle runs in another realm; compare a JSON copy, not prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(started[0].options)), { agentPreset: 'whalebuddy:niji' })
})

test('a shell without the slots service logs instead of throwing', () => {
  const bundle = loadBundle(okFetch)
  const react = fakeReact()
  const plugin = bundle.factory(() => react)
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    assert.doesNotThrow(() => plugin.apply({}))
  } finally {
    console.warn = original
  }
  assert.match(warnings.join('\n'), /slots service missing/)
})
