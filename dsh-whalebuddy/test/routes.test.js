import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { createPanelRoutes, isConsoleRequestAllowed, isLoopbackRequest, ROUTES } from '../lib/host/routes.js'

/** Seed one colleague and a roster, the way the panel expects to find them. */
async function seed() {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-routes-'))
  const store = createStore(root)
  const employee = await store.create({
    name: '逆戟',
    role: '视频',
    presetId: '',
    autonomy: 'L2',
    workspaces: [],
    temperament: '冷静',
  })
  await store.write('_shared', 'roster.md', '## 同事\n- 逆戟 · 视频')
  await store.write(employee.slug, 'memory/hot.md', '热记忆一句')
  return { store, slug: employee.slug, root }
}

/**
 * Mount the route list on a real loopback http server, the way the harness
 * web server does: exact path match, handler gets (req, res).
 * @param {ReturnType<typeof createPanelRoutes>} routes
 */
async function mount(routes) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const route = routes.find((candidate) => candidate.path === path)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'no route' }))
      return
    }
    void route.handler(req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * @param {string} base
 * @param {string} path
 * @param {{ method?: string, body?: unknown, raw?: string }} [options]
 */
async function call(base, path, options = {}) {
  const response = await fetch(base + path, {
    method: options.method ?? 'GET',
    headers: options.body === undefined && options.raw === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  })
  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return { status: response.status, body }
}

test('state returns the colleagues and the preview one of them really receives', async () => {
  const { store } = await seed()
  const server = await mount(createPanelRoutes({ store }))
  try {
    const answer = await call(server.base, ROUTES.state)
    assert.equal(answer.status, 200)
    assert.equal(answer.body.employees.length, 1)
    assert.equal(answer.body.selected, '逆戟')
    assert.match(answer.body.colleague.files.profile, /# 逆戟/)
    assert.match(answer.body.colleague.preview, /### 同事/)
    assert.match(answer.body.colleague.preview, /逆戟 · 视频/)
  } finally {
    await server.close()
  }
})

test('state carries the workspaces the host reports', async () => {
  const { store } = await seed()
  const workspaces = [{ id: 'w1', title: '项目', path: 'C:/work/project' }]
  const server = await mount(createPanelRoutes({ store, listWorkspaces: () => workspaces }))
  try {
    const answer = await call(server.base, ROUTES.state)
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body.workspaces, workspaces)
    assert.deepEqual(answer.body.colleague.bound, [])
  } finally {
    await server.close()
  }
})

test('assign records the host workspace path and answers with the new preview', async () => {
  const { store, slug } = await seed()
  const server = await mount(
    createPanelRoutes({
      store,
      workspacePath: (id) => (id === 'w1' ? 'C:/work/project' : undefined),
    }),
  )
  try {
    const unknown = await call(server.base, ROUTES.assign, {
      method: 'POST',
      body: { slug, workspaceId: 'ghost' },
    })
    assert.equal(unknown.status, 404)

    const answer = await call(server.base, ROUTES.assign, {
      method: 'POST',
      body: { slug, workspaceId: 'w1' },
    })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body.bound, ['C:/work/project'])
    assert.ok(answer.body.preview.includes('C:/work/project'))
    assert.ok(((await store.read(slug, 'profile.md')) ?? '').includes('- 工作区：C:/work/project'))
  } finally {
    await server.close()
  }
})

test('state honours the requested slug', async () => {
  const { store, slug } = await seed()
  const server = await mount(createPanelRoutes({ store }))
  try {
    const answer = await call(server.base, `${ROUTES.state}?slug=${encodeURIComponent(slug)}`)
    assert.equal(answer.body.selected, slug)
    assert.match(answer.body.colleague.files.hot, /热记忆一句/)
  } finally {
    await server.close()
  }
})

test('save writes the file and answers with the fresh preview', async () => {
  const { store, slug } = await seed()
  const server = await mount(createPanelRoutes({ store }))
  try {
    const answer = await call(server.base, ROUTES.save, {
      method: 'POST',
      body: { slug, rel: 'memory/hot.md', text: '改过的一句' },
    })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.saved, true)
    assert.match(answer.body.preview, /改过的一句/)
    assert.match(await store.read(slug, 'memory/hot.md'), /改过的一句/)
  } finally {
    await server.close()
  }
})

test('save refuses a path outside the whitelist with 403', async () => {
  const { store, slug } = await seed()
  const server = await mount(createPanelRoutes({ store }))
  try {
    const answer = await call(server.base, ROUTES.save, {
      method: 'POST',
      body: { slug, rel: '../../etc/passwd', text: 'x' },
    })
    assert.equal(answer.status, 403)
  } finally {
    await server.close()
  }
})

test('save refuses a file over 64 KB with 413', async () => {
  const { store, slug } = await seed()
  const server = await mount(createPanelRoutes({ store }))
  try {
    const answer = await call(server.base, ROUTES.save, {
      method: 'POST',
      body: { slug, rel: 'memory/hot.md', text: 'x'.repeat(100 * 1024) },
    })
    assert.equal(answer.status, 413)
  } finally {
    await server.close()
  }
})

test('save refuses a slug that is not an existing colleague with 404', async () => {
  const { store } = await seed()
  const server = await mount(createPanelRoutes({ store }))
  try {
    const answer = await call(server.base, ROUTES.save, {
      method: 'POST',
      body: { slug: 'ghost', rel: 'memory/hot.md', text: 'x' },
    })
    assert.equal(answer.status, 404)
  } finally {
    await server.close()
  }
})

test('save still allows the shared roster for a known colleague', async () => {
  const { store, slug } = await seed()
  const server = await mount(createPanelRoutes({ store }))
  try {
    const answer = await call(server.base, ROUTES.save, {
      method: 'POST',
      body: { slug, rel: '_shared/roster.md', text: '## 同事\n- 新内容' },
    })
    assert.equal(answer.status, 200)
    assert.match(await store.read('_shared', 'roster.md'), /新内容/)
  } finally {
    await server.close()
  }
})

test('save rejects a broken JSON body with 400', async () => {
  const { store } = await seed()
  const server = await mount(createPanelRoutes({ store }))
  try {
    const answer = await call(server.base, ROUTES.save, { method: 'POST', raw: '{not json' })
    assert.equal(answer.status, 400)
  } finally {
    await server.close()
  }
})

test('save rejects the wrong method with 405', async () => {
  const { store } = await seed()
  const server = await mount(createPanelRoutes({ store }))
  try {
    const answer = await call(server.base, ROUTES.save)
    assert.equal(answer.status, 405)
  } finally {
    await server.close()
  }
})

test('create adds the colleague, selects it, and runs the preset hook once', async () => {
  const { store } = await seed()
  const created = []
  const server = await mount(createPanelRoutes({ store, onCreate: (employee) => { created.push(employee.slug) } }))
  try {
    const answer = await call(server.base, ROUTES.create, {
      method: 'POST',
      body: { name: '小白', role: '日常', autonomy: 'L1' },
    })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.created.name, '小白')
    assert.equal(answer.body.selected, answer.body.created.slug)
    assert.equal(answer.body.employees.length, 2)
    assert.deepEqual(created, [answer.body.created.slug])
    assert.match(answer.body.colleague.files.profile, /岗位：日常/)
    assert.match(answer.body.colleague.files.profile, /档位：L1/)
  } finally {
    await server.close()
  }
})

test('create falls back to L2 for an unknown autonomy level', async () => {
  const { store } = await seed()
  const server = await mount(createPanelRoutes({ store }))
  try {
    const answer = await call(server.base, ROUTES.create, {
      method: 'POST',
      body: { name: '临时', autonomy: 'L9' },
    })
    assert.equal(answer.body.created.autonomy, 'L2')
  } finally {
    await server.close()
  }
})

test('create without a name answers 400', async () => {
  const { store } = await seed()
  const server = await mount(createPanelRoutes({ store }))
  try {
    const answer = await call(server.base, ROUTES.create, { method: 'POST', body: { name: '  ' } })
    assert.equal(answer.status, 400)
  } finally {
    await server.close()
  }
})

test('a refusing fence answers 403 before the handler runs', async () => {
  const { store } = await seed()
  const server = await mount(createPanelRoutes({ store, allow: () => false }))
  try {
    const answer = await call(server.base, ROUTES.state)
    assert.equal(answer.status, 403)
  } finally {
    await server.close()
  }
})

test('the loopback fallback accepts local addresses only', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.7' } }), false)
  assert.equal(isLoopbackRequest({}), false)
})

test('a connection service that admits the request wins over the address', () => {
  const ctx = { get: () => ({ requestRejection: () => undefined }) }
  assert.equal(isConsoleRequestAllowed(ctx, { socket: { remoteAddress: '10.0.0.7' } }), true)
})

test('a connection service that rejects leans on the loopback check', () => {
  const ctx = { get: () => ({ requestRejection: () => ({ status: 403 }) }) }
  assert.equal(isConsoleRequestAllowed(ctx, { socket: { remoteAddress: '10.0.0.7' } }), false)
  assert.equal(isConsoleRequestAllowed(ctx, { socket: { remoteAddress: '127.0.0.1' } }), true)
})
