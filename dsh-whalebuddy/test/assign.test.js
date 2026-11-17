// 分配工作区：权限行、参数校验、写档案。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { assignWorkspace, canAssign } from '../lib/assign.js'

test('permission comes from the profile line', () => {
  assert.equal(canAssign('# 蓝鲸\n- 权限：分配工作区\n'), true)
  assert.equal(canAssign('# 一角\n- 岗位：美术\n'), false)
  assert.equal(canAssign(''), false)
})

test('assign binds a workspace for a permitted actor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-assign-'))
  try {
    const store = createStore(root)
    await store.create({ name: '蓝鲸', role: '统筹', presetId: '', autonomy: 'L2', workspaces: [] })
    await store.create({ name: '一角', role: '美术', presetId: '', autonomy: 'L2', workspaces: [] })
    await store.write('蓝鲸', 'profile.md', '# 蓝鲸\n- 岗位：统筹\n- 权限：分配工作区\n')
    const denied = await assignWorkspace(store, '一角', '蓝鲸', 'C:\\work\\demo')
    assert.equal(denied.ok, false)
    assert.match(denied.text, /权限/)
    const missing = await assignWorkspace(store, '蓝鲸', '座头', 'C:\\work\\demo')
    assert.equal(missing.ok, false)
    const relative = await assignWorkspace(store, '蓝鲸', '一角', 'demo')
    assert.equal(relative.ok, false)
    const ok = await assignWorkspace(store, '蓝鲸', '一角', 'C:\\work\\demo')
    assert.equal(ok.ok, true)
    const profile = await store.read('一角', 'profile.md')
    assert.match(profile, /工作区：C:\\work\\demo/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
