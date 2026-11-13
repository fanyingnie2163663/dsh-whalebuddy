import test from 'node:test'
import assert from 'node:assert/strict'
import { createQueue, mergeExtraction, ruleExtractor } from '../lib/distill.js'

const prev = { hot: '', recent: '', rapport: '', knowledge: '', tasks: [] }

test('promises become open tasks', () => {
  const out = mergeExtraction(prev, { promises: ['周五前把登录改完'] }, '2026-11-09')
  assert.equal(out.tasks.length, 1)
  assert.equal(out.tasks[0].status, 'open')
  assert.equal(out.tasks[0].text, '周五前把登录改完')
})

test('corrections land in rapport with a date', () => {
  const out = mergeExtraction(prev, { corrections: ['别用反问句'] }, '2026-11-09')
  assert.match(out.rapport, /2026-11-09.*别用反问句/)
})

test('facts land in knowledge', () => {
  const out = mergeExtraction(prev, { facts: ['项目根目录是 D:/repo'] }, '2026-11-09')
  assert.match(out.knowledge, /D:\/repo/)
})

test('recent memory keeps the newest 800 characters', () => {
  const out = mergeExtraction({ ...prev, recent: '旧'.repeat(800) }, { report: '新'.repeat(100) }, '2026-11-09')
  assert.ok(out.recent.length <= 800)
  assert.ok(out.recent.includes('新'))
  assert.match(out.recent, /- 2026-11-09 收工：/)
})

test('an empty extraction changes nothing', () => {
  const out = mergeExtraction(prev, {}, '2026-11-09')
  assert.deepEqual(
    { hot: out.hot, recent: out.recent, rapport: out.rapport, knowledge: out.knowledge, tasks: out.tasks },
    prev,
  )
  assert.equal(out.logEntry, '')
})

test('the report becomes a dated log entry', () => {
  const out = mergeExtraction(prev, { report: '改完登录并补了测试' }, '2026-11-09')
  assert.equal(out.logEntry, '## 2026-11-09\n- 改完登录并补了测试')
})

test('a multi-line report becomes one log line and one recent line', () => {
  const out = mergeExtraction(prev, { report: '第一行\n\n第二段  有空格' }, '2026-11-09')
  assert.equal(out.logEntry, '## 2026-11-09\n- 第一行 第二段 有空格')
  assert.equal(out.recent, '- 2026-11-09 收工：第一行 第二段 有空格')
  assert.ok(!out.recent.includes('\n'))
})

test('a report is capped so one collect cannot swallow recent memory', () => {
  const out = mergeExtraction(prev, { report: '长'.repeat(500) }, '2026-11-09')
  assert.ok(out.recent.length <= 800)
  assert.ok(out.recent.startsWith('- 2026-11-09 收工：长'))
  assert.match(out.logEntry, /^## 2026-11-09\n- 长+$/)
})

test('rule extractor pulls corrections and promises', () => {
  const x = ruleExtractor('以后别用反问句。答应我周五前改完登录。')
  assert.deepEqual(x.corrections, ['以后别用反问句'])
  assert.deepEqual(x.promises, ['答应我周五前改完登录'])
})

test('ordinary 别 words are not corrections', () => {
  const x = ruleExtractor('别人都下班了。这个区别很大。特别喜欢你上次的配色。不要紧，明天再弄。分别处理这两件事。')
  assert.deepEqual(x.corrections, [])
})

test('an imperative 别 is still a correction', () => {
  const x = ruleExtractor('你别再手搓界面了。千万别手搓窗口。以后不用反问句。')
  assert.deepEqual(x.corrections, ['你别再手搓界面了', '千万别手搓窗口', '以后不用反问句'])
})

test('the assistant echo is never a correction', () => {
  const blocks = [
    { role: 'user', text: '以后别用反问句' },
    { role: 'assistant', text: '好的，记住了：以后不用反问句。' },
  ]
  const x = ruleExtractor('以后别用反问句\n\n好的，记住了：以后不用反问句。', blocks)
  assert.deepEqual(x.corrections, ['以后别用反问句'])
})

test('a user promise survives an assistant reply that repeats a marker', () => {
  const blocks = [
    { role: 'user', text: '答应我周五前改完登录' },
    { role: 'assistant', text: '好的，我记得了：以后不用反问句。' },
  ]
  const x = ruleExtractor('答应我周五前改完登录\n\n好的，我记得了：以后不用反问句。', blocks)
  assert.deepEqual(x.promises, ['答应我周五前改完登录'])
})

test('the report comes from the last assistant block, not the last paragraph', () => {
  const blocks = [
    { role: 'assistant', text: '早先的总结。' },
    { role: 'user', text: '最新的话。' },
  ]
  const x = ruleExtractor('早先的总结。\n\n最新的话。', blocks)
  assert.equal(x.report, '早先的总结。')
})

test('the queue serializes two writes for the same employee', async () => {
  const events = []
  const q = createQueue()
  await Promise.all([
    q.push('小白', async () => { events.push('a1'); await new Promise(r => setTimeout(r, 10)); events.push('a2') }),
    q.push('小白', async () => { events.push('b1') }),
  ])
  assert.deepEqual(events, ['a1', 'a2', 'b1'])
})
