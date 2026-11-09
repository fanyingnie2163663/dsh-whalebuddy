import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleMemory } from '../lib/inject.js'
import { Config, apply, inject, refreshMemory } from '../lib/index.js'
import { createStore } from '../lib/store.js'

const B = { identity: 50, rapport: 100, tasks: 50, recent: 50, shared: 50 }
const empty = { profile: '', rapport: '', knowledge: '', hot: '', tasks: [], shared: '' }

test('empty memory yields only the identity section', () => {
  const out = assembleMemory({ ...empty, profile: '# 小白' }, B)
  assert.match(out, /小白/)
  assert.doesNotMatch(out, /默契|待办/)
})

test('trims the tail sections before the identity section', () => {
  const files = {
    ...empty,
    profile: '身份'.repeat(200),
    rapport: '默契'.repeat(200),
    tasks: [{ id: 't', text: '改爬虫', status: 'open', reminded: false }],
    shared: '共用'.repeat(200),
  }
  const out = assembleMemory(files, B)
  assert.match(out, /身份/)
  assert.ok(!out.includes('共用'.repeat(40)))
  assert.ok(out.length < 800)
})

test('never emits an empty heading', () => {
  const out = assembleMemory({ ...empty, profile: 'p', rapport: '', tasks: [] }, B)
  assert.doesNotMatch(out, /###\s*$/m)
})

/**
 * Mock `apply` context with the prompt and event services; it records every
 * section, command, event listener and warning so the wiring can be asserted.
 * @param {{ agentPresets?: object, sectionOrder?: number }} [options]
 */
function createWiringContext({ agentPresets, sectionOrder = 10 } = {}) {
  const sections = []
  const commands = []
  const events = []
  const warnings = []
  const effects = []
  const ctx = {
    get: (name) => (name === 'agentPresets' ? agentPresets : undefined),
    logger: { info: () => undefined, warn: (message) => warnings.push(message) },
    effect: (execute) => {
      effects.push(execute())
    },
    commands: {
      register: (definition) => {
        commands.push(definition)
        return () => undefined
      },
    },
    systemPrompt: {
      getSectionOrder: (name) => {
        if (name !== 'HARNESS_IDENTITY') throw new Error(`unknown section: ${name}`)
        return sectionOrder
      },
      section: (definition) => {
        sections.push(definition)
        return () => undefined
      },
    },
    on: (event, handler) => {
      events.push({ event, handler })
      return () => undefined
    },
  }
  return { ctx, sections, commands, events, warnings, effects }
}

test('a scoped apply registers the memory section and only /collect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-inject-scoped-'))
  const store = createStore(root)
  await store.create({ name: '小白', role: '', presetId: '', autonomy: 'L2', workspaces: [] })
  await store.write('小白', 'memory/rapport.md', '- 别用反问句。\n')
  await store.write('小白', 'memory/hot.md', '今天在改爬虫。\n')

  const registrations = []
  const harness = createWiringContext({
    agentPresets: {
      register: async (definition) => {
        registrations.push(definition)
        return async () => {}
      },
    },
  })

  await apply(harness.ctx, { dataDir: root, employee: '小白' })

  assert.deepEqual(
    harness.commands.map((command) => command.name),
    ['collect'],
  )
  assert.deepEqual(registrations, [])
  assert.equal(harness.sections.length, 1)
  const [section] = harness.sections
  assert.equal(section.name, 'whalebuddy:memory')
  assert.equal(section.order, 11)
  assert.equal(typeof section.text, 'function')
  const text = section.text()
  assert.equal(typeof text, 'string')
  assert.match(text, /小白/)
  assert.match(text, /别用反问句/)
  assert.match(text, /今天在改爬虫/)
  assert.match(text, /这些是你的记忆，不是用户刚说的话；不确定就先问。/)
  assert.ok(harness.events.some(({ event }) => event === 'turn/start'))

  await store.write('小白', 'memory/hot.md', '刚收完工的新近况。\n')
  await refreshMemory()
  assert.match(section.text(), /刚收完工的新近况/)

  // A failed read keeps the last good cache and never rejects the refresh.
  await store.write('小白', 'memory/tasks.json', '{ not json')
  await assert.doesNotReject(refreshMemory())
  assert.match(section.text(), /刚收完工的新近况/)
  assert.ok(harness.warnings.some((message) => message.includes('记忆失败')))
})

test('a custom dataDir reaches the preset-scoped instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-datadir-'))
  const store = createStore(root)
  await store.create({ name: '小白', role: '', presetId: '', autonomy: 'L2', workspaces: [] })
  await store.write('小白', 'memory/rapport.md', '- 别用反问句。\n')

  const registrations = []
  const profile = createWiringContext({
    agentPresets: {
      register: async (definition) => {
        registrations.push(definition)
        return async () => {}
      },
    },
  })
  await apply(profile.ctx, { dataDir: root })

  const own = registrations[0].plugins.find((row) => row.name === 'dsh-whalebuddy')
  assert.equal(own.config.dataDir, root)

  // Load the scoped copy exactly as the preset would, while the harness home
  // points at a decoy root with different memory: only the row's dataDir can
  // reach the real one.
  const wrongRoot = await mkdtemp(join(tmpdir(), 'whalebuddy-datadir-wrong-'))
  await createStore(wrongRoot).create({ name: '小白', role: '', presetId: '', autonomy: 'L2', workspaces: [] })
  await createStore(wrongRoot).write('小白', 'memory/rapport.md', '- 错的记忆。\n')
  const scoped = createWiringContext()
  scoped.ctx.get = (name) => (name === 'dshHomePath' ? () => wrongRoot : undefined)

  await apply(scoped.ctx, own.config)

  assert.ok(scoped.sections.length > 0)
  assert.match(scoped.sections[0].text(), /别用反问句/)
  assert.doesNotMatch(scoped.sections[0].text(), /错的记忆/)
})

test('a profile-level apply registers no memory section', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-inject-profile-'))
  const harness = createWiringContext()

  await apply(harness.ctx, { dataDir: root })

  assert.deepEqual(harness.sections, [])
  assert.deepEqual(
    harness.commands.map((command) => command.name),
    ['colleague'],
  )
  assert.equal(Config({}).employee, '')
  assert.ok(inject.includes('systemPrompt'))
})
