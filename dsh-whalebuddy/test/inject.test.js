import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleMemory } from '../lib/inject.js'
import { Config, apply, inject } from '../lib/index.js'
import { createStore } from '../lib/store.js'

const B = { identity: 50, rapport: 100, tasks: 50, recent: 50, shared: 50 }
const empty = { profile: '', rapport: '', knowledge: '', hot: '', recent: '', tasks: [], shared: '' }

/**
 * Poll until an awaited async refresh has landed in the cache.
 * @param {() => boolean} check
 * @param {string} what
 * @returns {Promise<void>}
 */
async function until(check, what) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${what}`)
}

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
  // The refresh hangs off `session/event` `turn/start`; the second listener
  // only drops a disposed session's transcript buffer.
  await store.write('小白', 'memory/hot.md', 'turn 开始时读到的近况。\n')
  harness.events[0].handler({}, { type: 'turn/start' })
  await until(() => section.text().includes('turn 开始时读到的近况'), 'turn/start refresh')
  assert.deepEqual(
    harness.events.map(({ event }) => event),
    ['session/event', 'session/disposed'],
  )

  await store.write('小白', 'memory/hot.md', '刚收完工的新近况。\n')
  harness.events[0].handler({}, { type: 'turn/start' })
  await until(() => section.text().includes('刚收完工的新近况'), 'turn/start refresh after a write')

  // A failed read keeps the last good cache and never rejects the refresh.
  await store.write('小白', 'memory/tasks.json', '{ not json')
  harness.events[0].handler({}, { type: 'turn/start' })
  await until(
    () => harness.warnings.some((message) => message.includes('记忆失败')),
    'a failed refresh warns',
  )
  assert.match(section.text(), /刚收完工的新近况/)
})

test('memory text reaches the section without prompt interpolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-inject-interp-'))
  const store = createStore(root)
  await store.create({ name: '小白', role: '', presetId: '', autonomy: 'L2', workspaces: [] })
  await store.write('小白', 'memory/hot.md', '模板字面量 {{user.name}} 与 {{today}} 原样保留。\n')

  const harness = createWiringContext()
  await apply(harness.ctx, { dataDir: root, employee: '小白' })

  const [section] = harness.sections
  assert.equal(section.interpolate, false)
  assert.match(section.text(), /\{\{user\.name\}\}/)
  assert.match(section.text(), /\{\{today\}\}/)
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

test('roster sits between identity and rapport', () => {
  const out = assembleMemory({ ...empty, profile: '# 小白', roster: '- 逆戟 · 视频', rapport: '默契一句' }, B)
  const iIdentity = out.indexOf('### 身份')
  const iRoster = out.indexOf('### 同事')
  const iRapport = out.indexOf('### 默契')
  assert.ok(iRoster > iIdentity && iRoster < iRapport, out)
})

test('no roster means no heading', () => {
  const out = assembleMemory({ ...empty, profile: 'p' }, B)
  assert.doesNotMatch(out, /### 同事/)
})

test('roster is truncated at a sentence boundary', () => {
  const out = assembleMemory({ ...empty, profile: 'p', roster: '第一句。'.repeat(300) }, B)
  const count = (out.match(/第一句。/g) ?? []).length
  assert.ok(count > 100 && count < 300, 'truncated to the 700-char budget: ' + count)
  assert.ok(out.includes('…'), 'truncation marked with an ellipsis')
})
