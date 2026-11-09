import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, createEmployeeCommand, resolveDataDir } from '../lib/index.js'
import { createStore } from '../lib/store.js'

const office = async () => createStore(await mkdtemp(join(tmpdir(), 'whalebuddy-command-')))

const invoke = (rawInput) => ({ rawInput })

const seedEmployee = (store, name) =>
  store.create({ name, role: '', presetId: '', autonomy: 'L2', workspaces: [] })

/**
 * A fake `agentPresets` service that records row resolution, registrations and
 * disposals, so tests can tell load-time from per-create work.
 * @param {{ document?: string, disposed?: string[], failIds?: string[] }} [options]
 */
function fakeAgentPresets({ document = '- name: base\n', disposed = [], failIds = [] } = {}) {
  const calls = { resolve: 0, readDocument: 0 }
  const registrations = []
  const service = {
    resolve: async () => {
      calls.resolve += 1
      return { id: 'default' }
    },
    readDocument: async () => {
      calls.readDocument += 1
      return { content: document }
    },
    register: async (definition) => {
      registrations.push(definition)
      if (failIds.includes(definition.id)) throw new Error('registry down')
      return async () => {
        disposed.push(definition.id)
      }
    },
  }
  return { service, calls, registrations, disposed }
}

/**
 * Mock `apply` context: captures every effect disposer, every registered
 * command and every warning, with an optional `agentPresets` service.
 * @param {object} [agentPresets]
 * @param {string[]} [warnings]
 */
function createApplyHarness(agentPresets, warnings = []) {
  const effects = []
  const commands = []
  const ctx = {
    get: (name) => (name === 'agentPresets' ? agentPresets : undefined),
    logger: {
      info: () => undefined,
      warn: (message) => warnings.push(message),
    },
    effect: (execute) => {
      effects.push(execute())
    },
    commands: {
      register: (definition) => {
        commands.push(definition)
        return () => undefined
      },
    },
  }
  return { ctx, effects, commands, warnings }
}

test('the colleague command advertises its name and input hint', () => {
  const command = createEmployeeCommand(createStore(join(tmpdir(), 'whalebuddy-unused')))
  assert.equal(command.name, 'colleague')
  assert.equal(command.description, '创建或列出同事')
  assert.deepEqual(command.input, { hint: 'new <名字> | ls' })
  assert.equal(typeof command.handler, 'function')
})

test('/colleague new <默认名> creates an L2 colleague with that temperament', async () => {
  const store = await office()
  const result = await createEmployeeCommand(store).handler(invoke('new 逆戟'))
  assert.deepEqual(result, { kind: 'success', text: '已创建同事「逆戟」（逆戟）。' })
  const [employee] = await store.list()
  assert.equal(employee.role, '')
  assert.equal(employee.autonomy, 'L2')
  assert.match(await store.read('逆戟', 'profile.md'), /- 脾气：锋利、直接、话少，适合写码与挑错/)
})

test('/colleague new <自定义名> leaves the temperament unset', async () => {
  const store = await office()
  const result = await createEmployeeCommand(store).handler(invoke('new 阿望'))
  assert.deepEqual(result, { kind: 'success', text: '已创建同事「阿望」（阿望）。' })
  assert.match(await store.read('阿望', 'profile.md'), /- 脾气：未定/)
})

test('/colleague new without a name explains the syntax', async () => {
  const store = await office()
  const handler = createEmployeeCommand(store).handler
  assert.deepEqual(await handler(invoke('new')), { kind: 'error', text: '给个名字：/colleague new 小白' })
  assert.deepEqual(await handler(invoke('new   ')), { kind: 'error', text: '给个名字：/colleague new 小白' })
  assert.deepEqual(await store.list(), [])
})

test('/colleague ls lists one colleague per line', async () => {
  const store = await office()
  const handler = createEmployeeCommand(store).handler
  assert.deepEqual(await handler(invoke('ls')), { kind: 'success', text: '还没有同事：/colleague new 小白' })
  assert.deepEqual(await handler(invoke('  ')), { kind: 'success', text: '还没有同事：/colleague new 小白' })
  await handler(invoke('new 小白'))
  await store.create({ name: '逆戟', role: '写码的', presetId: '', autonomy: 'L3', workspaces: [] })
  assert.deepEqual(await handler(invoke('ls')), {
    kind: 'success',
    text: '小白 · 未定 · L2\n逆戟 · 写码的 · L3',
  })
})

test('an unknown subcommand reports the usage', async () => {
  const store = await office()
  assert.deepEqual(await createEmployeeCommand(store).handler(invoke('rm 小白')), {
    kind: 'error',
    text: '用法：/colleague new <名字> | ls',
  })
})

test('store failures become error results instead of throwing', async () => {
  const command = createEmployeeCommand({
    list: async () => {
      throw new Error('index.json is corrupt')
    },
    create: async () => {
      throw new Error('disk full')
    },
  })
  assert.deepEqual(await command.handler(invoke('ls')), {
    kind: 'error',
    text: '读取同事列表失败：index.json is corrupt',
  })
  assert.deepEqual(await command.handler(invoke('new 小白')), {
    kind: 'error',
    text: '创建同事失败：disk full',
  })
})

test('the data root prefers config, then dshHomePath, then ~/.dsh', () => {
  const fallback = join(homedir(), '.dsh', 'whalebuddy')
  assert.equal(resolveDataDir({ get: () => undefined }, { dataDir: 'D:/colleagues' }), 'D:/colleagues')
  assert.equal(resolveDataDir({ get: () => undefined }, {}), fallback)
  assert.equal(resolveDataDir({ get: () => undefined }, { dataDir: '' }), fallback)
  assert.equal(resolveDataDir({ get: () => 'not a function' }, { dataDir: '' }), fallback)
  assert.equal(
    resolveDataDir({ get: (name) => (name === 'dshHomePath' ? (segment) => `/dsh/home/${segment}` : undefined) }, {}),
    '/dsh/home/whalebuddy',
  )
})

test('apply registers /colleague through an effect disposer', () => {
  const registered = []
  const disposed = []
  let effectDisposer
  const ctx = {
    get: () => undefined,
    logger: { info: () => undefined },
    effect: (execute) => {
      effectDisposer = execute()
    },
    commands: {
      register: (definition) => {
        registered.push(definition)
        return () => disposed.push(definition.name)
      },
    },
  }
  apply(ctx, { dataDir: join(tmpdir(), 'whalebuddy-apply-test') })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'colleague')
  assert.equal(typeof effectDisposer, 'function')
  effectDisposer()
  assert.deepEqual(disposed, ['colleague'])
})

test('apply registers a preset for each existing colleague', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-apply-preset-'))
  await seedEmployee(createStore(root), '小白')
  const fake = fakeAgentPresets()
  const harness = createApplyHarness(fake.service)

  await apply(harness.ctx, { dataDir: root })

  assert.deepEqual(
    fake.registrations.map((definition) => definition.id),
    ['whalebuddy:小白'],
  )
  assert.equal(fake.registrations[0].plugins[0].name, 'base')
})

test('/colleague new registers the new colleague preset immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-apply-create-'))
  await seedEmployee(createStore(root), '小白')
  const fake = fakeAgentPresets()
  const harness = createApplyHarness(fake.service)
  await apply(harness.ctx, { dataDir: root })

  const result = await harness.commands[0].handler(invoke('new 逆戟'))

  assert.deepEqual(result, { kind: 'success', text: '已创建同事「逆戟」（逆戟）。' })
  assert.deepEqual(
    fake.registrations.map((definition) => definition.id),
    ['whalebuddy:小白', 'whalebuddy:逆戟'],
  )
  assert.equal(fake.registrations[1].plugins[0].name, 'base')
  assert.equal(fake.calls.resolve, 1)
  assert.equal(fake.calls.readDocument, 1)
})

test('apply on a fresh install skips template resolution and preset registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-apply-empty-'))
  const fake = fakeAgentPresets()
  const harness = createApplyHarness(fake.service)

  await apply(harness.ctx, { dataDir: root })

  assert.deepEqual(fake.registrations, [])
  assert.deepEqual(fake.calls, { resolve: 0, readDocument: 0 })
  assert.deepEqual(harness.warnings, [])
})

test('template rows resolve once and are reused by later creates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-apply-reuse-'))
  const fake = fakeAgentPresets()
  const harness = createApplyHarness(fake.service)
  await apply(harness.ctx, { dataDir: root })

  await harness.commands[0].handler(invoke('new 小白'))
  await harness.commands[0].handler(invoke('new 逆戟'))

  assert.deepEqual(
    fake.registrations.map((definition) => definition.id),
    ['whalebuddy:小白', 'whalebuddy:逆戟'],
  )
  assert.equal(fake.calls.resolve, 1)
  assert.equal(fake.calls.readDocument, 1)
})

test('a failed preset registration is logged but still creates the colleague', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-apply-fail-'))
  const fake = fakeAgentPresets({ failIds: ['whalebuddy:逆戟'] })
  const harness = createApplyHarness(fake.service)
  await apply(harness.ctx, { dataDir: root })

  const result = await harness.commands[0].handler(invoke('new 逆戟'))

  assert.deepEqual(result, { kind: 'success', text: '已创建同事「逆戟」（逆戟）。' })
  assert.ok(harness.warnings.some((message) => message.includes('预设注册失败')))
})

test('/colleague new still works without an agentPresets service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-apply-nopresets-'))
  const harness = createApplyHarness(undefined)
  await apply(harness.ctx, { dataDir: root })

  const result = await harness.commands[0].handler(invoke('new 逆戟'))

  assert.deepEqual(result, { kind: 'success', text: '已创建同事「逆戟」（逆戟）。' })
  assert.equal(harness.effects.length, 1)
  assert.ok(harness.warnings.some((message) => message.includes('没有 agentPresets')))
})

test('unload disposes every collected preset disposer, newest first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-apply-unload-'))
  const store = createStore(root)
  await seedEmployee(store, '小白')
  await seedEmployee(store, '逆戟')
  const fake = fakeAgentPresets()
  const harness = createApplyHarness(fake.service)
  await apply(harness.ctx, { dataDir: root })
  await harness.commands[0].handler(invoke('new 阿望'))

  assert.equal(harness.effects.length, 2)
  await harness.effects[0]()

  assert.deepEqual(fake.disposed, ['whalebuddy:阿望', 'whalebuddy:逆戟', 'whalebuddy:小白'])
})
