import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slugify, createStore } from '../lib/store.js'

const root = () => mkdtemp(join(tmpdir(), 'whalebuddy-'))

const input = (over = {}) => ({
  name: '小白',
  role: 'r',
  presetId: 'default',
  autonomy: 'L2',
  workspaces: [],
  ...over,
})

test('slugify keeps CJK and lowercases latin', () => {
  assert.equal(slugify('小白'), '小白')
  assert.equal(slugify('Orca'), 'orca')
  assert.equal(slugify('a b/c'), 'a-b-c')
})

test('slugify normalizes NFKC and strips separators', () => {
  assert.equal(slugify('Ａ Ｂ'), 'a-b')
  assert.equal(slugify(' a//b  c '), 'a-b-c')
  assert.equal(slugify('/:*?"<>|\\'), 'colleague')
  assert.equal(slugify(''), 'colleague')
})

test('a fresh root lists nothing and create makes the root', async () => {
  const dir = join(await root(), 'nested', 'whalebuddy')
  const store = createStore(dir)
  assert.deepEqual(await store.list(), [])
  const e = await store.create(input())
  assert.equal(e.slug, '小白')
  assert.equal((await store.list()).length, 1)
})

test('create writes profile and index entry', async () => {
  const dir = await root()
  const store = createStore(dir)
  const e = await store.create({ name: '逆戟', role: '写码的', presetId: 'default', autonomy: 'L2', workspaces: [] })
  assert.equal(e.slug, '逆戟')
  const profile = await readFile(join(dir, '逆戟', 'profile.md'), 'utf8')
  assert.match(profile, /逆戟/)
  const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
  assert.equal(index.employees.length, 1)
})

test('create lays out the employee directories', async () => {
  const dir = await root()
  const store = createStore(dir)
  const e = await store.create(input())
  for (const rel of ['', 'memory', 'memory/log', 'skills', 'pending']) {
    const info = await stat(join(dir, e.slug, rel))
    assert.ok(info.isDirectory(), `${rel || 'employee'} should be a directory`)
  }
  await assert.rejects(stat(join(dir, e.slug, 'profile.md.tmp')))
  await assert.rejects(stat(join(dir, 'index.json.tmp')))
})

test('profile follows the fixed template', async () => {
  const dir = await root()
  const store = createStore(dir)
  const full = await store.create(input({ name: '逆戟', role: '写码的', workspaces: ['w1', 'w2'], temperament: '急性子' }))
  assert.equal(
    await readFile(join(dir, full.slug, 'profile.md'), 'utf8'),
    '# 逆戟\n- 岗位：写码的\n- 档位：L2\n- 工作区：w1, w2\n- 脾气：急性子\n',
  )
  const bare = await store.create(input({ name: '一角', workspaces: [], temperament: '' }))
  assert.equal(
    await readFile(join(dir, bare.slug, 'profile.md'), 'utf8'),
    '# 一角\n- 岗位：r\n- 档位：L2\n- 工作区：\n- 脾气：未定\n',
  )
})

test('index.json keeps exactly the employee summaries', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create(input({ name: '小白', role: '日常' }))
  await store.create(input({ name: '逆戟', role: '写码的', workspaces: ['w1'] }))
  const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
  assert.deepEqual(Object.keys(index).sort(), ['employees'])
  assert.deepEqual(index.employees.map((e) => e.slug), ['小白', '逆戟'])
  assert.deepEqual(Object.keys(index.employees[0]).sort(), ['autonomy', 'name', 'role', 'slug', 'updatedAt'])
  assert.equal(index.employees[1].name, '逆戟')
  const listed = await store.list()
  assert.deepEqual(listed.map((e) => e.slug), ['小白', '逆戟'])
  assert.equal(typeof listed[0].updatedAt, 'number')
})

test('duplicate names get a numeric suffix', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create({ name: '小白', role: 'r', presetId: 'default', autonomy: 'L2', workspaces: [] })
  const second = await store.create({ name: '小白', role: 'r', presetId: 'default', autonomy: 'L2', workspaces: [] })
  assert.equal(second.slug, '小白-2')
})

test('a duplicate never rewrites the existing employee', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create(input())
  await store.write('小白', 'keep.txt', 'original')
  const second = await store.create(input({ role: '另一个岗位' }))
  assert.equal(second.slug, '小白-2')
  assert.equal(await store.read('小白', 'keep.txt'), 'original')
})

test('create refuses a name whose 50 candidates are taken', async () => {
  const dir = await root()
  const store = createStore(dir)
  await mkdir(join(dir, '小白'), { recursive: true })
  for (let i = 2; i <= 50; i += 1) await mkdir(join(dir, `小白-${i}`))
  await assert.rejects(store.create(input()), /小白/)
})

test('concurrent creates keep every index entry', async () => {
  const dir = await root()
  const store = createStore(dir)
  await Promise.all(Array.from({ length: 5 }, (_, index) => store.create(input({ name: `同事${index}` }))))
  const employees = await store.list()
  assert.equal(employees.length, 5)
  assert.equal(new Set(employees.map((employee) => employee.slug)).size, 5)
})

test('write is atomic and read round-trips', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create({ name: '蓝鲸', role: 'r', presetId: 'default', autonomy: 'L1', workspaces: [] })
  await store.write('蓝鲸', 'memory/hot.md', '# 热记忆\n')
  assert.equal(await store.read('蓝鲸', 'memory/hot.md'), '# 热记忆\n')
  const left = await readdir(join(dir, '蓝鲸', 'memory'))
  assert.deepEqual(left.filter((name) => name.endsWith('.tmp')), [])
})

test('write creates missing parents and read misses cleanly', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create(input({ name: '蓝鲸' }))
  await store.write('蓝鲸', 'pending/deep/note.md', 'hi')
  assert.equal(await store.read('蓝鲸', 'pending/deep/note.md'), 'hi')
  assert.equal(await store.read('蓝鲸', 'memory/missing.md'), undefined)
  await assert.rejects(store.write('蓝鲸', '../escape.md', 'x'))
  await assert.rejects(store.read('../escape', 'profile.md'))
})

test('tasks round-trip through JSON', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create({ name: '一角', role: 'r', presetId: 'default', autonomy: 'L2', workspaces: [] })
  const tasks = [{ id: 't1', text: '把爬虫登录改完', status: 'open', reminded: false }]
  await store.saveTasks('一角', tasks)
  assert.deepEqual(await store.tasks('一角'), tasks)
})

test('a missing task file is an empty list and saving is pretty JSON', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create(input())
  assert.deepEqual(await store.tasks('小白'), [])
  const tasks = [{ id: 't1', text: '改完', status: 'open', reminded: false }]
  await store.saveTasks('小白', tasks)
  const raw = await readFile(join(dir, '小白', 'memory', 'tasks.json'), 'utf8')
  assert.equal(raw, `${JSON.stringify(tasks, null, 2)}\n`)
  await assert.rejects(stat(join(dir, '小白', 'memory', 'tasks.json.tmp')))
})

test('repair rebuilds a missing index from the directories', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create(input({ name: '小白', role: '日常' }))
  await store.create(input({ name: '逆戟', role: '视频', autonomy: 'L1' }))
  await rm(join(dir, 'index.json'))

  const out = await store.repair()
  assert.equal(out.changed, true)
  assert.deepEqual(out.employees.map((employee) => employee.name), ['小白', '逆戟'])
  const orca = out.employees.find((employee) => employee.name === '逆戟')
  assert.equal(orca.role, '视频')
  assert.equal(orca.autonomy, 'L1')
  assert.equal((await store.list()).length, 2)
})

test('repair rebuilds a corrupt index', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create(input({ name: '一角', role: '美术' }))
  await writeFile(join(dir, 'index.json'), '{ not json', 'utf8')

  const out = await store.repair()
  assert.equal(out.changed, true)
  assert.deepEqual(out.employees.map((employee) => employee.slug), ['一角'])
  assert.equal((await store.list())[0].role, '美术')
})

test('repair drops an index row whose directory is gone', async () => {
  const dir = await root()
  const store = createStore(dir)
  const first = await store.create(input({ name: '小白' }))
  await store.create(input({ name: '逆戟' }))
  await rm(join(dir, first.slug), { recursive: true, force: true })

  const out = await store.repair()
  assert.equal(out.changed, true)
  assert.deepEqual(out.employees.map((employee) => employee.slug), ['逆戟'])
  assert.deepEqual((await store.list()).map((employee) => employee.slug), ['逆戟'])
})

test('repair leaves a matching index untouched', async () => {
  const dir = await root()
  const store = createStore(dir)
  await store.create(input())
  const before = await readFile(join(dir, 'index.json'), 'utf8')
  const out = await store.repair()
  assert.equal(out.changed, false)
  assert.equal(await readFile(join(dir, 'index.json'), 'utf8'), before)
})

test('create records the preset and autonomy snapshot', async () => {
  const dir = await root()
  const store = createStore(dir)
  const e = await store.create(input({ presetId: 'coder', autonomy: 'L3' }))
  const state = JSON.parse(await readFile(join(dir, e.slug, 'state.json'), 'utf8'))
  assert.deepEqual(state, { presetId: 'coder', autonomy: 'L3' })
})

test('setAutonomy rewrites the profile line and the state snapshot', async () => {
  const dir = await root()
  const store = createStore(dir)
  const created = await store.create(input({ presetId: 'coder', autonomy: 'L2' }))
  const updated = await store.setAutonomy(created.slug, 'L3')

  assert.equal(updated.autonomy, 'L3')
  const profile = await readFile(join(dir, created.slug, 'profile.md'), 'utf8')
  assert.match(profile, /- 档位：L3/)
  assert.doesNotMatch(profile, /档位：L2/)
  const state = JSON.parse(await readFile(join(dir, created.slug, 'state.json'), 'utf8'))
  assert.deepEqual(state, { presetId: 'coder', autonomy: 'L3' })
  assert.equal((await store.list())[0].autonomy, 'L3')
})

test('setAutonomy rebuilds a missing state file instead of leaving it behind', async () => {
  const dir = await root()
  const store = createStore(dir)
  const created = await store.create(input({ presetId: 'default', autonomy: 'L2' }))
  await rm(join(dir, created.slug, 'state.json'))

  await store.setAutonomy(created.slug, 'L1')

  // presetId lived only in the snapshot; with it gone the level still lands.
  const state = JSON.parse(await readFile(join(dir, created.slug, 'state.json'), 'utf8'))
  assert.deepEqual(state, { presetId: '', autonomy: 'L1' })
})

test('setAutonomy refuses a level it does not know and changes nothing', async () => {
  const dir = await root()
  const store = createStore(dir)
  const created = await store.create(input({ autonomy: 'L2' }))

  await assert.rejects(() => store.setAutonomy(created.slug, 'L9'), /autonomy/)
  assert.match(await readFile(join(dir, created.slug, 'profile.md'), 'utf8'), /- 档位：L2/)
  const state = JSON.parse(await readFile(join(dir, created.slug, 'state.json'), 'utf8'))
  assert.equal(state.autonomy, 'L2')
})

test('setAutonomy refuses a colleague that does not exist', async () => {
  const dir = await root()
  const store = createStore(dir)

  await assert.rejects(() => store.setAutonomy('ghost', 'L1'), /ghost/)
  await assert.rejects(stat(join(dir, 'ghost')))
})

test('default names carry a temperament', async () => {
  const { DEFAULT_NAMES } = await import('../lib/names.js')
  assert.deepEqual(DEFAULT_NAMES.map(n => n.name), ['小白', '逆戟', '座头', '一角', '蓝鲸'])
  assert.ok(DEFAULT_NAMES.every(n => n.temperament.length > 0))
})

test('default names pair each whale with its designed temperament', async () => {
  const { DEFAULT_NAMES } = await import('../lib/names.js')
  assert.deepEqual(DEFAULT_NAMES, [
    { name: '小白', nameEn: 'Beluga', temperament: '温和、耐心，适合日常与陪伴' },
    { name: '逆戟', nameEn: 'Orca', temperament: '锋利、直接、话少，适合写码与挑错' },
    { name: '座头', nameEn: 'Humpback', temperament: '爱唱爱总结，适合复盘与讲故事' },
    { name: '一角', nameEn: 'Narwhal', temperament: '钻研、刨根问底，适合研究与查资料' },
    { name: '蓝鲸', nameEn: 'Blue', temperament: '大、稳、扛重活' },
  ])
})
