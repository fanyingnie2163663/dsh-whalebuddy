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
function loadBundle(fetchImpl, windowExtra = {}, globals = {}) {
  let registered
  const window = {
    ...windowExtra,
    __ModuleLoader__: {
      load(module) {
        registered = module
      },
    },
  }
  const sandbox = { window, fetch: fetchImpl, console, ...globals }
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
    notices: [
      { id: 'n1', at: new Date(2026, 10, 14, 18, 42).getTime(), kind: 'collect', text: '改完了。', detail: '待办 +1' },
    ],
    noticeCap: 2,
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
      if (url.includes('/notices/read')) {
        return { unread: 0, latest: null, bySlug: {} }
      }
      if (url.includes('/update')) {
        const sent = init && init.body ? JSON.parse(init.body) : {}
        if (typeof sent.noticeCap === 'number') {
          return {
            ...PANEL_STATE,
            colleague: { ...PANEL_STATE.colleague, noticeCap: sent.noticeCap },
          }
        }
        return {
          updated: { slug: 'niji', name: '逆戟', role: '视频', autonomy: 'L3', updatedAt: 3 },
          employees: [
            { slug: 'niji', name: '逆戟', role: '视频', autonomy: 'L3', updatedAt: 3 },
            { slug: 'yijiao', name: '一角', role: '美术', autonomy: 'L2', updatedAt: 2 },
          ],
          selected: 'niji',
          colleague: {
            slug: 'niji',
            files: {
              ...PANEL_STATE.colleague.files,
              profile: '# 逆戟\n- 岗位：视频\n- 档位：L3',
              changelog: '- [2026-11-14 01:00] 控制台：档位 → L3',
            },
            bound: [],
            preview: '### 身份\n# 逆戟\n- 档位：L3',
          },
          workspaces: PANEL_STATE.workspaces,
        }
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
  const bundle = loadBundle(options.fetch ?? okFetch, options.window, options.globals)
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
  assert.equal(icon.props.children.length, 6)
  assert.equal(icon.props['data-wb-unread'], '0')
  assert.ok(findAll(icon, (node) => node.props?.['data-wb-dot'] !== undefined)[0], 'the unread dot exists')
  assert.equal(textOf(findAll(icon, (node) => node.type === 'title')[0]), 'Whalebuddy')
})

test('the watcher marks the real rail row when the glyph is not ours', async () => {
  const row = {
    textContent: 'Whalebuddy',
    classes: new Set(),
    classList: {
      add(name) {
        row.classes.add(name)
      },
      remove(name) {
        row.classes.delete(name)
      },
    },
  }
  const doc = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === '.wb-label-unread') return []
      if (selector === '*') return [row]
      return [row]
    },
  }
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { unread: 2, latest: { slug: 'niji', name: '逆戟', text: '收工：待办 +2', at: Date.now() } }
    },
  })

  mountPlugin({ fetch: fetchImpl, globals: { document: doc }, window: { setInterval: () => 1, clearInterval: () => {} } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(row.classes.has('wb-label-unread'), true)
})

test('the sidebar glyph polls notices and paints its own dot', async () => {
  const titleNode = { textContent: '' }
  const svgNode = {
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value
    },
    querySelector(selector) {
      return selector === 'title' ? titleNode : null
    },
  }
  const doc = {
    visibilityState: 'visible',
    querySelector(selector) {
      return svgNode
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const timers = {
    setInterval() {
      return 1
    },
    clearInterval() {
      timers.cleared = true
    },
  }
  const fetchImpl = async (url) => {
    fetchImpl.calls.push({ url })
    return {
      ok: true,
      status: 200,
      async json() {
        return { unread: 1, latest: { slug: 'niji', name: '逆戟', text: '收工：待办 +2', at: Date.now() } }
      },
    }
  }
  fetchImpl.calls = []

  const { cleanups } = mountPlugin({
    fetch: fetchImpl,
    globals: { document: doc },
    window: { setInterval: timers.setInterval, clearInterval: timers.clearInterval },
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(fetchImpl.calls[0].url, 'api/whalebuddy/notices')
  assert.equal(svgNode.attrs['data-wb-unread'], '1')
  assert.match(titleNode.textContent, /逆戟/)
  assert.match(titleNode.textContent, /收工/)

  cleanups[0]()
  assert.equal(timers.cleared, true)
})

test('the page asks the host for state, then renders the rail, dossier and preview', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component

  const first = react.render(Page)
  assert.equal(textOf(findAll(first, (node) => node.type === 'h1')[0]), '同事')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(okFetch.calls[0].url, 'api/whalebuddy/state')

  const tree = react.render(Page)
  const items = findAll(tree, (node) => node.props?.className === 'wb-item')
  assert.equal(items.length, 2)
  assert.match(textOf(items[0]), /逆戟/)
  assert.match(textOf(items[0]), /视频/)
  assert.match(textOf(items[0]), /月|分钟前|小时前|刚刚/)

  const chips = findAll(tree, (node) => node.props?.className === 'wb-chip')
  assert.ok(chips.some((chip) => /L2/.test(textOf(chip))), 'the autonomy chip renders')
  assert.equal(textOf(findAll(tree, (node) => node.props?.className === 'wb-chip wb-chipMono')[0]), 'whalebuddy:niji')

  const preview = findAll(tree, (node) => node.props?.className === 'wb-pre')[0]
  assert.match(textOf(preview), /### 身份/)

  const memoryTab = findAll(
    tree,
    (node) => node.type === 'button' && node.props?.role === 'tab' && /记忆/.test(textOf(node)),
  )[0]
  assert.ok(memoryTab, 'memory has a tab')
  memoryTab.props.onClick()
  const memoryView = react.render(Page)
  assert.match(textOf(memoryView), /热记忆一句/)
  assert.match(textOf(memoryView), /memory\/hot\.md · 第 1 行/)
})

test('the save button posts the edited surface and adopts the returned preview', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component

  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const editButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === '编辑')[0]
  assert.ok(editButton, 'the profile card offers an editor')
  editButton.props.onClick()
  tree = react.render(Page)

  const textarea = findAll(tree, (node) => node.type === 'textarea')[0]
  assert.match(textarea.props.value, /# 逆戟/)

  const saveButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === '保存')[0]
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

test('a profile save that changes the level refreshes the dossier chip', async () => {
  const fetchImpl = async (url, init) => {
    fetchImpl.calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      async json() {
        if (url.includes('/save')) {
          return {
            saved: true,
            bound: [],
            preview: '### 身份\n# 逆戟\n- 档位：L1',
            employees: [
              { slug: 'niji', name: '逆戟', role: '视频', autonomy: 'L1', updatedAt: 4 },
              { slug: 'yijiao', name: '一角', role: '美术', autonomy: 'L2', updatedAt: 2 },
            ],
          }
        }
        return PANEL_STATE
      },
    }
  }
  fetchImpl.calls = []

  const { registered, react } = mountPlugin({ fetch: fetchImpl })
  const Page = registered[1].component
  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const editButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === '编辑')[0]
  assert.ok(editButton, 'the profile card offers an editor')
  editButton.props.onClick()
  tree = react.render(Page)

  const textarea = findAll(tree, (node) => node.type === 'textarea')[0]
  textarea.props.onChange({ target: { value: '# 逆戟\n- 岗位：视频\n- 档位：L1' } })
  tree = react.render(Page)

  const saveButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === '保存')[0]
  saveButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const save = fetchImpl.calls.find((entry) => entry.url === 'api/whalebuddy/save')
  assert.ok(save, 'the edited profile is posted')
  assert.match(JSON.parse(save.init.body).text, /档位：L1/)

  tree = react.render(Page)
  const chip = findAll(tree, (node) => node.props?.className === 'wb-chip' && /L1/.test(textOf(node)))[0]
  assert.ok(chip, 'the dossier chip follows the saved profile level')
})

test('picking another autonomy level posts to the update route and adopts the answer', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component

  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const levels = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'wb-level')
  assert.equal(levels.length, 3, 'all three levels are offered')
  assert.equal(levels.filter((node) => node.props['data-on'] !== undefined).length, 1, 'exactly one level is current')
  assert.match(textOf(levels.find((node) => node.props['data-on'] !== undefined)), /L2/)

  const l3 = levels.find((node) => /L3/.test(textOf(node)))
  assert.ok(l3, 'L3 is offered')
  l3.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const call = okFetch.calls.find((entry) => entry.url === 'api/whalebuddy/update')
  assert.ok(call, 'changing a level posts to the update route')
  assert.equal(call.init.method, 'POST')
  assert.deepEqual(JSON.parse(call.init.body), { slug: 'niji', autonomy: 'L3' })

  tree = react.render(Page)
  const chip = findAll(tree, (node) => node.props?.className === 'wb-chip' && /L3/.test(textOf(node)))[0]
  assert.ok(chip, 'the dossier chip follows the new level')
  const active = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'wb-level' && node.props['data-on'] !== undefined)
  assert.match(textOf(active[0]), /L3/)
})

test('the notice card shows her note and marks it read', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component
  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const notice = findAll(tree, (node) => node.props?.className === 'wb-notice')[0]
  assert.ok(notice, 'the notice card renders')
  assert.match(textOf(notice), /改完了。/)
  assert.match(textOf(notice), /18:42/)

  const read = findAll(notice, (node) => node.type === 'button' && textOf(node) === '知道了')[0]
  assert.ok(read, 'the note offers 知道了')
  read.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const call = okFetch.calls.find((entry) => entry.url === 'api/whalebuddy/notices/read')
  assert.ok(call, 'marking read posts to the notices route')
  assert.deepEqual(JSON.parse(call.init.body), { slug: 'niji', id: 'n1' })
})

test('the daily cap stepper posts the next value', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component
  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const value = findAll(tree, (node) => node.props?.className === 'wb-capValue')[0]
  assert.equal(textOf(value), '2')
  const plus = findAll(tree, (node) => node.type === 'button' && node.props?.['aria-label'] === '增加上限')[0]
  assert.ok(plus, 'the stepper offers +')
  plus.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const call = okFetch.calls.find((entry) => entry.url === 'api/whalebuddy/update')
  assert.ok(call, 'the cap change posts to update')
  assert.deepEqual(JSON.parse(call.init.body), { slug: 'niji', noticeCap: 3 })
})

test('L1 hides the cap stepper and says she will not come', async () => {
  const fetchImpl = async (url) => {
    fetchImpl.calls.push({ url })
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          employees: [{ slug: 'niji', name: '逆戟', role: '视频', autonomy: 'L1', updatedAt: 1 }],
          selected: 'niji',
          colleague: { ...PANEL_STATE.colleague, notices: [], noticeCap: 2 },
          workspaces: [],
        }
      },
    }
  }
  fetchImpl.calls = []

  const { registered, react } = mountPlugin({ fetch: fetchImpl })
  const Page = registered[1].component
  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  const tree = react.render(Page)

  assert.equal(findAll(tree, (node) => node.props?.className === 'wb-stepBtn').length, 0)
  assert.match(textOf(tree), /随叫随到/)
})

test('switching colleagues warns when another surface still has unsaved work', async () => {
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

  const memoryTab = findAll(
    tree,
    (node) => node.type === 'button' && node.props?.role === 'tab' && /记忆/.test(textOf(node)),
  )[0]
  memoryTab.props.onClick()
  tree = react.render(Page)

  const editButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === '编辑')[0]
  editButton.props.onClick()
  tree = react.render(Page)
  const textarea = findAll(tree, (node) => node.type === 'textarea')[0]
  textarea.props.onChange({ target: { value: '改过的一句' } })
  tree = react.render(Page)

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

test('the change log tab is read-only', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component

  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const changelogTab = findAll(
    tree,
    (node) => node.type === 'button' && node.props?.role === 'tab' && /变更/.test(textOf(node)),
  )[0]
  assert.ok(changelogTab, 'the change log has a tab')
  changelogTab.props.onClick()
  tree = react.render(Page)

  assert.equal(findAll(tree, (node) => node.type === 'textarea').length, 0, 'no editor on a read-only surface')
  assert.match(textOf(tree), /收工/)
  assert.match(textOf(tree), /纠错 \+1/)
  assert.equal(findAll(tree, (node) => node.type === 'button' && textOf(node) === '保存').length, 0)
})

test('the console defaults to dark and the header toggles it', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component

  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)
  assert.equal(tree.props['data-wb-theme'], 'dark')

  const toggle = findAll(tree, (node) => node.type === 'button' && textOf(node) === '浅色')[0]
  assert.ok(toggle, 'the header offers a light switch')
  toggle.props.onClick()
  tree = react.render(Page)
  assert.equal(tree.props['data-wb-theme'], 'light')

  const back = findAll(tree, (node) => node.type === 'button' && textOf(node) === '深色')[0]
  back.props.onClick()
  tree = react.render(Page)
  assert.equal(tree.props['data-wb-theme'], 'dark')
})

test('the tasks tab toggles a task through the save route', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component

  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const tab = findAll(
    tree,
    (node) => node.type === 'button' && node.props?.role === 'tab' && /待办/.test(textOf(node)),
  )[0]
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
})

test('the onboarding wizard prefills a persona and posts the colleague', async () => {
  const { registered, react } = mountPlugin()
  const Page = registered[1].component

  react.render(Page)
  await new Promise((resolve) => setImmediate(resolve))
  let tree = react.render(Page)

  const newButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === '＋ 新同事')[0]
  assert.ok(newButton, 'the rail offers a new colleague')
  newButton.props.onClick()
  tree = react.render(Page)
  assert.match(textOf(tree), /先给她起个名字/)

  const persona = findAll(
    tree,
    (node) => node.type === 'button' && node.props?.className === 'wb-option' && /逆戟/.test(textOf(node)),
  )[0]
  assert.ok(persona, 'the persona cards render')
  persona.props.onClick()
  tree = react.render(Page)

  for (let step = 0; step < 3; step += 1) {
    const next = findAll(tree, (node) => node.type === 'button' && textOf(node) === '下一步')[0]
    assert.ok(next, 'the wizard advances')
    next.props.onClick()
    tree = react.render(Page)
  }

  const submit = findAll(tree, (node) => node.type === 'button' && textOf(node) === '建她')[0]
  assert.ok(submit, 'the last step creates')
  submit.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const call = okFetch.calls.find((entry) => entry.url === 'api/whalebuddy/create')
  assert.ok(call, 'creating posts to the host')
  const body = JSON.parse(call.init.body)
  assert.equal(body.name, '逆戟')
  assert.equal(body.role, '写码')
  assert.equal(body.autonomy, 'L2')
  assert.match(body.temperament, /锋利/)
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
  assert.ok(add, 'the profile offers a workspace picker')
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
