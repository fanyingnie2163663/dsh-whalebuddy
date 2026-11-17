// 工单进上下文：store 读 inbox，注入里排在「同事」之前。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { assembleMemory } from '../lib/inject.js'

test('store.orders reads inbox and tolerates a missing one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-orders-'))
  try {
    const store = createStore(root)
    assert.deepEqual(await store.orders('阿宁'), [])
    await mkdir(join(root, '阿宁', 'inbox'), { recursive: true })
    await writeFile(join(root, '阿宁', 'inbox', 'j1.md'), '# 工单 j1\n把卡片改了\n')
    const items = await store.orders('阿宁')
    assert.equal(items.length, 1)
    assert.equal(items[0].id, 'j1')
    assert.ok(items[0].text.includes('把卡片改了'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('injected memory puts 工单 before 同事', () => {
  const text = assembleMemory({ profile: '# 阿宁', roster: '- 蓝鲸 · 统筹', orders: [{ id: 'j1', text: '# 工单 j1\n改卡片' }] })
  assert.ok(text.includes('### 工单'))
  assert.ok(text.includes('j1'))
  assert.ok(text.indexOf('### 工单') < text.indexOf('### 同事'))
})
