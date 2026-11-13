import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendChange, changeStamp } from '../lib/changelog.js'
import { createStore } from '../lib/store.js'

const employee = (name) => ({ name, role: '', presetId: '', autonomy: 'L2', workspaces: [] })

test('changeStamp pads a local date and time', () => {
  assert.equal(changeStamp(new Date(2026, 10, 14, 1, 5)), '2026-11-14 01:05')
})

test('appendChange keeps earlier lines and stamps each one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-changelog-'))
  const store = createStore(root)
  const created = await store.create(employee('小白'))

  await appendChange(store, created.slug, '控制台', 'memory/hot.md（3 字）')
  await appendChange(store, created.slug, '收工', '纠错 +1')

  const text = (await store.read(created.slug, 'memory/changelog.md')) ?? ''
  const lines = text.trim().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^- \[20\d\d-\d\d-\d\d \d\d:\d\d\] 控制台：memory\/hot\.md（3 字）$/)
  assert.match(lines[1], /^- \[20\d\d-\d\d-\d\d \d\d:\d\d\] 收工：纠错 \+1$/)
})
