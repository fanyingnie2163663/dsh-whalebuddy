import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { bindWorkspace, buildPreview, changeAutonomy, changeNoticeCap, isWritable, readColleague, readPanelState, saveFile } from '../lib/host/panel-data.js'

async function seed() {
  const root = await mkdtemp(join(tmpdir(), 'whalebuddy-panel-'))
  const store = createStore(root)
  const emp = await store.create({ name: '逆戟', role: '视频', presetId: '', autonomy: 'L2', workspaces: [], temperament: '冷静' })
  await store.write('_shared', 'roster.md', '## 同事\n- 逆戟 · 视频')
  await store.write('_shared', 'user.md', '称呼：老板')
  await store.write('逆戟', 'memory/hot.md', '热记忆一句')
  await store.write('逆戟', 'memory/changelog.md', '- [2026-11-14 01:00] 收工：纠错 +1')
  await store.saveTasks('逆戟', [{ id: 't1', text: '做一支样片', status: 'open', reminded: false }])
  return { store, slug: emp.slug }
}

test('the preview carries the roster section a colleague would receive', async () => {
  const { store, slug } = await seed()
  const one = await readColleague(store, slug)
  assert.match(one.preview, /### 同事/)
  assert.match(one.preview, /逆戟 · 视频/)
  assert.match(one.preview, /热记忆一句/)
  assert.match(one.files.changelog, /收工：纠错/)
  assert.doesNotMatch(one.preview, /收工：纠错/, 'the change log is never injected')
  assert.match(one.files.tasks, /做一支样片/)
  assert.match(one.preview, /做一支样片/)
})

test('the preview carries the shared user profile, like the real injection', async () => {
  const { store, slug } = await seed()
  const one = await readColleague(store, slug)
  assert.match(one.preview, /### 关于你/)
  assert.match(one.preview, /称呼：老板/)
})

test('save refuses a path outside the whitelist', async () => {
  const { store, slug } = await seed()
  await assert.rejects(() => saveFile(store, slug, '../../etc/passwd', 'x'), /not a console-editable file/)
})

test('save refuses an oversized file', async () => {
  const { store, slug } = await seed()
  await assert.rejects(() => saveFile(store, slug, 'memory/hot.md', 'x'.repeat(64 * 1024 + 1)), /larger than 64 KB/)
})

test('saving a file returns the preview it produces', async () => {
  const { store, slug } = await seed()
  const out = await saveFile(store, slug, 'memory/hot.md', '改过的一句')
  assert.equal(out.saved, true)
  assert.match(out.preview, /改过的一句/)
  assert.match((await store.read(slug, 'memory/changelog.md')) ?? '', /控制台：memory\/hot\.md/)
})

test('the roster saves into the shared slug, not the colleague', async () => {
  const { store, slug } = await seed()
  await saveFile(store, slug, '_shared/roster.md', '## 同事\n- 新内容')
  assert.match((await store.read('_shared', 'roster.md')) ?? '', /新内容/)
  assert.match((await readColleague(store, slug)).preview, /新内容/)
})

test('binding a workspace appends once and keeps the rest of the profile', async () => {
  const { store, slug } = await seed()
  await bindWorkspace(store, slug, 'C:/work/one')
  await bindWorkspace(store, slug, 'C:/work/two')
  const again = await bindWorkspace(store, slug, 'C:/work/one')

  const colleague = await readColleague(store, slug)
  assert.deepEqual(colleague.bound, ['C:/work/one', 'C:/work/two'])
  assert.ok(colleague.files.profile.includes('- 岗位：视频'))
  assert.ok(colleague.files.profile.includes('# 逆戟'))
  assert.equal(colleague.files.profile.split('- 工作区：').length - 1, 1)
  assert.deepEqual(again.bound, colleague.bound)
  assert.ok(again.preview.includes('C:/work/one'))
  const log = (await store.read(slug, 'memory/changelog.md')) ?? ''
  assert.equal(log.split('工作区 +').length - 1, 2)
})

test('panel state selects the first colleague when none is named', async () => {
  const { store, slug } = await seed()
  const state = await readPanelState(store)
  assert.equal(state.selected, slug)
  assert.equal(state.employees.length, 1)
})

test('panel state carries the raw board and the same rows parsed once', async () => {
  const { store } = await seed()
  const board = [
    '| 状态 | 谁 | 什么 | 时间 |',
    '|---|---|---|---|',
    '| 在做 | 逆戟 | 把样片剪到 60 秒 | 2026-11-18 11:30 |',
    '| 已定 | 蓝鲸 | 不进图的决策 | 2026-11-18 |',
    '',
    '## 已定',
  ].join('\n')
  await store.write('_shared', 'board.md', board)

  const state = await readPanelState(store)
  assert.equal(state.board, board)
  assert.deepEqual(state.tasksView.rows, [
    { status: '在做', who: '逆戟', what: '把样片剪到 60 秒', time: '2026-11-18 11:30' },
  ])
  assert.equal(state.tasksView.badRows, 1)
})

test('whitelist is exact, not a prefix match', () => {
  assert.equal(isWritable('profile.md'), true)
  assert.equal(isWritable('memory/hot.md.bak'), false)
  assert.equal(isWritable('memory/secret.md'), false)
})

test('preview without a roster renders no roster heading', () => {
  assert.doesNotMatch(buildPreview({ profile: 'p' }), /### 同事/)
})

test('changing autonomy records the change and returns the whole panel', async () => {
  const { store, slug } = await seed()
  const out = await changeAutonomy(store, slug, 'L3')

  assert.equal(out.updated.autonomy, 'L3')
  assert.equal(out.selected, slug)
  assert.equal(out.employees[0].autonomy, 'L3')
  assert.match(out.colleague.files.profile, /- 档位：L3/)
  assert.match(out.colleague.preview, /档位：L3/)
  assert.match((await store.read(slug, 'memory/changelog.md')) ?? '', /控制台：档位 → L3/)
})

test('saving a profile whose autonomy line changed updates the snapshot and the index', async () => {
  const { store, slug } = await seed()

  // A level the console does not know must not be read as a prefix of one it does.
  await saveFile(store, slug, 'profile.md', '# 逆戟\n- 岗位：视频\n- 档位：L10\n- 工作区：\n- 脾气：冷静\n')
  assert.equal((await store.list())[0].autonomy, 'L2')

  const out = await saveFile(store, slug, 'profile.md', '# 逆戟\n- 岗位：视频\n- 档位：L1\n- 工作区：\n- 脾气：冷静\n')

  assert.equal(out.employees[0].autonomy, 'L1')
  assert.equal((await store.list())[0].autonomy, 'L1')
  const state = JSON.parse((await store.read(slug, 'state.json')) ?? '{}')
  assert.equal(state.autonomy, 'L1')
  assert.match(out.preview, /档位：L1/)
})


test('readColleague carries notices and the daily cap', async () => {
  const { store, slug } = await seed()
  await store.write(slug, 'memory/notices.json', JSON.stringify([{ id: 'n1', at: 1, kind: 'collect', text: '改完了。', detail: '' }]))

  const one = await readColleague(store, slug)
  assert.equal(one.notices.length, 1)
  assert.equal(one.notices[0].text, '改完了。')
  assert.equal(one.noticeCap, 2)
})

test('changeNoticeCap writes the cap and records it', async () => {
  const { store, slug } = await seed()

  const out = await changeNoticeCap(store, slug, 3)

  assert.equal(out.colleague.noticeCap, 3)
  assert.match((await store.read(slug, 'state.json')) ?? '', /"noticeCap": 3/)
  assert.match((await store.read(slug, 'memory/changelog.md')) ?? '', /上限 → 3/)
})

test('changing autonomy refuses a level it does not know', async () => {
  const { store, slug } = await seed()

  await assert.rejects(() => changeAutonomy(store, slug, 'L9'), /autonomy/)
  assert.equal((await store.list())[0].autonomy, 'L2')
})
