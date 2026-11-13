import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'
import { ROUTES } from '../lib/host/routes.js'

/**
 * A profile-level context just rich enough for `apply`: commands, the optional
 * `agentPresets`/`webServer` injections, and an effect runner that keeps the
 * cleanup so unload can be exercised.
 * @param {{ routes: Array<*>, released: string[], warnings: string[] }} sink
 */
async function fakeProfileContext(sink) {
  const dataDir = await mkdtemp(join(tmpdir(), 'whalebuddy-mount-'))
  let consoleCleanup
  const ctx = {
    logger: { info: () => undefined, warn: (message) => sink.warnings.push(message) },
    get: () => undefined,
    effect: (execute) => execute(),
    commands: { register: () => () => undefined },
    inject(deps, callback) {
      if (deps.includes('webServer')) {
        callback({
          webServer: {
            register(route) {
              sink.routes.push(route)
              return () => sink.released.push(route.path)
            },
          },
          effect(execute) {
            consoleCleanup = execute()
            return consoleCleanup
          },
        })
      } else if (deps.includes('agentPresets')) {
        callback({ get: () => undefined })
      }
      return () => undefined
    },
  }
  return { ctx, config: { dataDir }, cleanup: () => consoleCleanup?.() }
}

test('the profile-level load mounts all seven console routes', async () => {
  const sink = { routes: [], released: [], warnings: [] }
  const { ctx, config } = await fakeProfileContext(sink)
  await plugin.apply(ctx, config)

  assert.equal(sink.routes.length, 7)
  assert.deepEqual(
    sink.routes.map((route) => route.path).sort(),
    [ROUTES.assign, ROUTES.create, ROUTES.notices, ROUTES.noticesRead, ROUTES.save, ROUTES.state, ROUTES.update].sort(),
  )
  for (const route of sink.routes) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
})

test('a large startup log is rotated before appending', async () => {
  const sink = { routes: [], released: [], warnings: [] }
  const { ctx, config } = await fakeProfileContext(sink)
  const log = join(config.dataDir, '_startup.log')
  await writeFile(log, 'x'.repeat(70 * 1024), 'utf8')

  await plugin.apply(ctx, config)
  // Startup notes are fire-and-forget; wait for the rotation to land.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await stat(`${log}.1`)
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  assert.equal((await stat(`${log}.1`)).size, 70 * 1024)
  assert.ok((await stat(log)).size < 70 * 1024)
})

test('unloading the plugin releases every console route', async () => {
  const sink = { routes: [], released: [], warnings: [] }
  const { ctx, config, cleanup } = await fakeProfileContext(sink)
  await plugin.apply(ctx, config)

  cleanup()
  assert.equal(sink.released.length, 7)
  assert.deepEqual(
    sink.released.sort(),
    [ROUTES.assign, ROUTES.create, ROUTES.notices, ROUTES.noticesRead, ROUTES.save, ROUTES.state, ROUTES.update].sort(),
  )
})

test('a colleague-scoped load never mounts the console', async () => {
  const sink = { routes: [], released: [], warnings: [] }
  const { ctx, config } = await fakeProfileContext(sink)
  await plugin.apply(ctx, { ...config, employee: 'niji' })

  assert.equal(sink.routes.length, 0)
})
