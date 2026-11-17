import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { changeKit, readPanelState } from '../lib/host/panel-data.js'
import { createPanelRoutes } from '../lib/host/routes.js'
import { createEmployeeCommand } from '../lib/index.js'
import { DEFAULT_PACKS, normalizePack } from '../lib/packs.js'

const packs = new Map(DEFAULT_PACKS.map((pack) => [pack.id, normalizePack(pack)]))

async function seed(role = '视频') {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-kit-'))
  const store = createStore(root)
  const employee = await store.create({
    name: '逆戟',
    role,
    presetId: 'ops-ptc',
    autonomy: 'L2',
    workspaces: [],
    temperament: '冷静',
  })
  return { store, slug: employee.slug, root }
}

test('setKit keeps the rest of the state and refuses an empty kit', async () => {
  const { store, slug } = await seed()
  assert.deepEqual(await store.setKit(slug, ['core', 'browser']), ['core', 'browser'])
  const state = await store.state(slug)
  assert.deepEqual(state.kit, ['core', 'browser'])
  assert.equal(state.presetId, 'ops-ptc')
  assert.equal(state.autonomy, 'L2')
  await assert.rejects(store.setKit(slug, []), /at least one pack/)
  await assert.rejects(store.setKit('ghost', ['core']), /no colleague/)
})

test('the panel shows a role-suggested kit and changeKit records the change', async () => {
  const { store, slug } = await seed('视频')
  const first = await readPanelState(store, slug, { packs })
  assert.deepEqual(first.kit, ['core', 'research', 'browser'])
  assert.equal(first.colleague.kit.length, 3)
  const browser = first.packs.find((pack) => pack.id === 'browser')
  assert.equal(browser.selected, true)

  const next = await changeKit(store, slug, ['core', 'browser'], packs)
  assert.deepEqual(next.kit, ['core', 'browser'])
  assert.equal(next.packs.find((pack) => pack.id === 'browser').selected, true)
  assert.match(await store.read(slug, 'memory/changelog.md'), /工具箱/)
})

test('/colleague kit lists and edits through the injected writer', async () => {
  const { store, slug } = await seed('美术')
  const writes = []
  const command = createEmployeeCommand(store, {
    packs,
    readKit: async (target) => {
      const state = await store.state(target)
      return Array.isArray(state.kit) && state.kit.length > 0 ? state.kit : ['core', 'research']
    },
    writeKit: async (target, kit) => {
      writes.push([target, kit])
      return store.setKit(target, kit)
    },
  })

  const list = await command.handler({ rawInput: 'kit' })
  assert.equal(list.kind, 'success')
  assert.match(list.text, new RegExp(slug))

  const added = await command.handler({ rawInput: 'kit ' + slug + ' add shell' })
  assert.equal(added.kind, 'success')
  assert.deepEqual(writes[0], [slug, ['core', 'research', 'shell']])

  const reset = await command.handler({ rawInput: 'kit ' + slug + ' reset' })
  assert.equal(reset.kind, 'success')
  assert.deepEqual(writes[1], [slug, ['core', 'research', 'browser']])

  const bad = await command.handler({ rawInput: 'kit ' + slug + ' wat' })
  assert.equal(bad.kind, 'error')
})

test('POST /api/whalebuddy/kit saves through onKitChange and returns the new panel', async () => {
  const { store, slug } = await seed('视频')
  const seen = []
  const routes = createPanelRoutes({
    store,
    packs,
    allow: () => true,
    onKitChange: async (target, kit) => {
      seen.push([target, kit])
      return store.setKit(target, kit)
    },
  })
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const route = routes.find((candidate) => candidate.path === path)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  const base = 'http://127.0.0.1:' + port
  try {
    const answer = await fetch(base + '/api/whalebuddy/kit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, kit: ['core', 'browser'] }),
    })
    assert.equal(answer.status, 200)
    const body = await answer.json()
    assert.deepEqual(seen[0], [slug, ['core', 'browser']])
    assert.deepEqual(body.kit, ['core', 'browser'])
    assert.equal(body.packs.find((pack) => pack.id === 'browser').selected, true)

    const bad = await fetch(base + '/api/whalebuddy/kit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, kit: [] }),
    })
    assert.equal(bad.status, 400)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
