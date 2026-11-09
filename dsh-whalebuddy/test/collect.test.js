import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { createStore } from '../lib/store.js'

const EMPTY_TRANSCRIPT = '这个会话没攒到可收的文字。'
const COLLECT_DESCRIPTION = '收工：把这次会话里值得留下的写进记忆'

/** Local-date stamp, matching the plugin's own `YYYY-MM-DD` rule. */
function today() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const employee = (name) => ({ name, role: '', presetId: '', autonomy: 'L2', workspaces: [] })

/**
 * Mock context for one preset-scoped instance. Records the prompt section, the
 * registered command and every `session/event` listener so the test can drive
 * the transcript exactly like a live session would.
 * @param {{ events?: boolean }} [options]
 */
function createScopedHarness({ events = true } = {}) {
  const sections = []
  const commands = []
  const listeners = []
  const warnings = []
  /** @type {Record<string, unknown>} */
  const ctx = {
    get: () => undefined,
    logger: { info: () => undefined, warn: (message) => warnings.push(message) },
    effect: (execute) => execute(),
    commands: {
      register: (definition) => {
        commands.push(definition)
        return () => undefined
      },
    },
    systemPrompt: {
      getSectionOrder: () => 10,
      section: (definition) => {
        sections.push(definition)
        return () => undefined
      },
    },
  }
  if (events) {
    ctx.on = (event, handler) => {
      listeners.push({ event, handler })
      return () => undefined
    }
  }
  return { ctx, sections, commands, listeners, warnings }
}

/**
 * Feed one message event with a single text block.
 * @param {ReturnType<typeof createScopedHarness>} harness
 * @param {'user/message' | 'assistant/message'} type
 * @param {string} text
 */
function emitText(harness, type, text) {
  const listener = harness.listeners.find((entry) => entry.event === 'session/event')
  assert.ok(listener, 'session/event listener is registered')
  listener.handler({}, { type, data: { message: { content: [{ type: 'text', text }] } } })
}

test('/collect writes the distilled memory and refreshes only its own instance', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'whalebuddy-collect-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'whalebuddy-collect-b-'))
  const storeA = createStore(rootA)
  const storeB = createStore(rootB)
  await storeA.create(employee('小白'))
  await storeB.create(employee('逆戟'))

  const a = createScopedHarness()
  await apply(a.ctx, { dataDir: rootA, employee: '小白' })
  // Apply B second so the module-scope `memoryRefresher` points at B. A collect
  // in A must still refresh A (ruling R9), never the singleton.
  const b = createScopedHarness()
  await apply(b.ctx, { dataDir: rootB, employee: '逆戟' })

  assert.deepEqual(a.commands.map((command) => command.name), ['collect'])
  assert.equal(a.commands[0].description, COLLECT_DESCRIPTION)

  emitText(a, 'user/message', '以后别用反问句。')
  emitText(a, 'assistant/message', '登录改完了。')
  const result = await a.commands[0].handler({ rawInput: '' })
  assert.deepEqual(result, { kind: 'success', text: '收工了。2 条新记忆' })

  const stamp = today()
  assert.match(await storeA.read('小白', 'memory/rapport.md'), new RegExp(`\\[${stamp}\\] 纠错：以后别用反问句`))
  assert.match(await storeA.read('小白', 'memory/hot.md'), /登录改完了/)
  assert.match(await storeA.read('小白', `memory/log/${stamp}.md`), new RegExp(`## ${stamp}\\n- 登录改完了`))
  assert.deepEqual(JSON.parse(await storeA.read('小白', 'memory/tasks.json')), [])
  assert.equal(await storeA.read('小白', 'memory/knowledge.md'), '')

  // The local refresh ran: A's cached section now sees the write-back.
  assert.match(a.sections[0].text(), /以后别用反问句/)
  assert.match(a.sections[0].text(), /登录改完了/)
  // And B, the current module singleton, was not refreshed with A's memory.
  assert.doesNotMatch(b.sections[0].text(), /以后别用反问句/)
})

test('/collect keeps the newest tail of a long transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-collect-long-'))
  await createStore(root).create(employee('小白'))
  const harness = createScopedHarness()
  await apply(harness.ctx, { dataDir: root, employee: '小白' })

  // 9000 filler characters push the stale paragraph out of the last 8000.
  const filler = '填充'.repeat(4500)
  emitText(harness, 'assistant/message', '早先的总结。')
  emitText(harness, 'user/message', filler)
  emitText(harness, 'user/message', '以后别用反问句。记得周五前写完测试。')
  emitText(harness, 'assistant/message', '最新一段总结：把登录改完。')

  const result = await harness.commands[0].handler({})

  assert.deepEqual(result, { kind: 'success', text: '收工了。3 条新记忆' })
  const store = createStore(root)
  const stamp = today()
  const log = await store.read('小白', `memory/log/${stamp}.md`)
  assert.match(log, /最新一段总结：把登录改完。/)
  assert.doesNotMatch(log, /早先的总结/)
  const hot = await store.read('小白', 'memory/hot.md')
  assert.match(hot, /最新一段总结：把登录改完。/)
  assert.doesNotMatch(hot, /早先的总结/)
  assert.match(await store.read('小白', 'memory/rapport.md'), /以后别用反问句/)
  const tasks = JSON.parse(await store.read('小白', 'memory/tasks.json'))
  assert.deepEqual(tasks.map((task) => task.text), ['记得周五前写完测试'])
})

test('/collect with an empty transcript is an error and writes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-collect-empty-'))
  await createStore(root).create(employee('小白'))
  const harness = createScopedHarness()
  await apply(harness.ctx, { dataDir: root, employee: '小白' })

  const result = await harness.commands[0].handler({})

  assert.deepEqual(result, { kind: 'error', text: EMPTY_TRANSCRIPT })
  const store = createStore(root)
  assert.equal(await store.read('小白', 'memory/hot.md'), undefined)
  assert.equal(await store.read('小白', 'memory/rapport.md'), undefined)
  assert.equal(await store.read('小白', 'memory/knowledge.md'), undefined)
  assert.equal(await store.read('小白', 'memory/tasks.json'), undefined)
  assert.equal(await store.read('小白', `memory/log/${today()}.md`), undefined)
})

test('/collect without the event API reports the empty transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-collect-noevents-'))
  await createStore(root).create(employee('小白'))
  const harness = createScopedHarness({ events: false })
  await apply(harness.ctx, { dataDir: root, employee: '小白' })

  const result = await harness.commands[0].handler({})

  assert.deepEqual(result, { kind: 'error', text: EMPTY_TRANSCRIPT })
  assert.equal(await createStore(root).read('小白', 'memory/hot.md'), undefined)
})

test('/collect reports a write failure and keeps the transcript for a retry', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'whalebuddy-collect-broken-'))
  const notADirectory = join(parent, 'not-a-directory')
  await writeFile(notADirectory, 'x')

  const harness = createScopedHarness()
  await apply(harness.ctx, { dataDir: notADirectory, employee: '小白' })
  emitText(harness, 'assistant/message', '登录改完了。')

  const first = await harness.commands[0].handler({})
  assert.equal(first.kind, 'error')
  assert.match(first.text, /^收工失败：/)

  // The buffer was not cleared, so the retry reports the same write failure
  // instead of "nothing to collect".
  const second = await harness.commands[0].handler({})
  assert.equal(second.kind, 'error')
  assert.match(second.text, /^收工失败：/)
})
