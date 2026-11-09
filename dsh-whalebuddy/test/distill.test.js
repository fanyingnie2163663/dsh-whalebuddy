import test from 'node:test'
import assert from 'node:assert/strict'
import { createQueue, mergeExtraction, ruleExtractor } from '../lib/distill.js'

const prev = { hot: '', rapport: '', knowledge: '', tasks: [] }

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

test('hot memory keeps the newest 800 characters', () => {
  const out = mergeExtraction({ ...prev, hot: '旧'.repeat(800) }, { report: '新'.repeat(100) }, '2026-11-09')
  assert.ok(out.hot.length <= 800)
  assert.ok(out.hot.includes('新'))
})

test('an empty extraction changes nothing', () => {
  const out = mergeExtraction(prev, {}, '2026-11-09')
  assert.deepEqual({ hot: out.hot, rapport: out.rapport, knowledge: out.knowledge, tasks: out.tasks }, prev)
  assert.equal(out.logEntry, '')
})

test('the report becomes a dated log entry', () => {
  const out = mergeExtraction(prev, { report: '改完登录并补了测试' }, '2026-11-09')
  assert.equal(out.logEntry, '## 2026-11-09\n- 改完登录并补了测试')
})

test('rule extractor pulls corrections and promises', () => {
  const x = ruleExtractor('以后别用反问句。答应我周五前改完登录。')
  assert.deepEqual(x.corrections, ['以后别用反问句'])
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
