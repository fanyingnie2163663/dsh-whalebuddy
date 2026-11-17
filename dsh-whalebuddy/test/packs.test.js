import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_PACKS,
  compileRows,
  compileToolDeny,
  describeToolSurface,
  globMatch,
  loadPacks,
  normalizeKit,
  normalizePack,
  suggestKit,
} from '../lib/packs.js'

const packs = new Map(DEFAULT_PACKS.map((pack) => [pack.id, normalizePack(pack)]))

test('normalizePack keeps valid packs and refuses malformed ids', () => {
  assert.equal(normalizePack({ id: 'Bad Id' }), undefined)
  const pack = normalizePack({ id: 'design', name: ' 设计 ', include: ['tool-fs', 7], tools: ['ego_*'] })
  assert.equal(pack.name, '设计')
  assert.deepEqual(pack.include, ['tool-fs'])
  assert.deepEqual(pack.tools, ['ego_*'])
})

test('globMatch matches ids and plugin names with * and ?', () => {
  assert.equal(globMatch('tool-fs', 'tool-fs'), true)
  assert.equal(globMatch('ego_*', 'ego_click'), true)
  assert.equal(globMatch('a.b', 'axb'), false)
  assert.equal(globMatch('a.b', 'a.b'), true)
  assert.equal(globMatch('web_?earch', 'web_search'), true)
})

test('normalizeKit keeps known ids in order and always carries core', () => {
  assert.deepEqual(normalizeKit(['shell', 'nope', 'core', 'shell'], packs), ['core', 'shell'])
  assert.deepEqual(normalizeKit([], packs), ['core'])
})

test('compileRows filters the template, points skills at the colleague, and appends pack rows', () => {
  const template = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'whalebuddy-memory', name: '@fanyingnie/dsh-whalebuddy' },
  ]
  const rows = compileRows(template, packs, ['core'], { skillsDir: '/data/一角/skills' })
  assert.deepEqual(rows.map((row) => row.id), ['persona', 'tool-fs', 'skill-filesystem'])
  assert.deepEqual(rows[2].config.customSkillDirs, ['/data/一角/skills'])
})

test('compileRows adds a shell row only when the shell pack is selected', () => {
  const template = [
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  ]
  assert.deepEqual(compileRows(template, packs, ['core']).map((row) => row.id), ['tool-fs'])
  assert.deepEqual(compileRows(template, packs, ['core', 'shell']).map((row) => row.id), ['tool-fs', 'tool-bash'])
})

test('compileRows appends explicit rows from a pack and dedupes them', () => {
  const custom = normalizePack({
    id: 'custom',
    name: '自定义',
    rows: [
      { id: 'extra', name: 'some-plugin' },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    ],
  })
  const local = new Map(packs).set('custom', custom)
  const rows = compileRows([{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }], local, ['core', 'custom'])
  assert.deepEqual(rows.map((row) => row.id), ['tool-fs', 'extra'])
})

test('compileToolDeny hides tools of unselected packs and keeps unclassified ones', () => {
  const known = ['ego_click', 'web_search', 'bash', 'ops_bash', 'read', 'run_code']
  assert.deepEqual(compileToolDeny(packs, ['core'], known), ['bash', 'ego_click', 'ops_bash', 'web_search'])
  assert.deepEqual(compileToolDeny(packs, ['core', 'shell', 'research'], known), ['ego_click'])
  assert.deepEqual(compileToolDeny(packs, ['core', 'browser', 'research', 'shell'], known), [])
  assert.equal(compileToolDeny(packs, ['core'], known).includes('run_code'), false)
})

test('describeToolSurface lists issued and withheld packs with a no-guessing rule', () => {
  const text = describeToolSurface(packs, ['core', 'shell', 'research'])
  assert.match(text, /有：基座/)
  assert.match(text, /命令行（bash \/ pwsh）/)
  assert.match(text, /资料（web_search \/ web_fetch）/)
  assert.match(text, /没有：日程、委派、浏览器、审查、Office、插件管理/)
  assert.match(text, /不要“试一下”/)
})

test('suggestKit follows the role and falls back to the default kit', () => {
  assert.deepEqual(suggestKit('美术'), ['core', 'research', 'browser'])
  assert.deepEqual(suggestKit('资料'), ['core', 'research', 'browser'])
  assert.deepEqual(suggestKit('开发'), ['core', 'shell', 'research', 'review'])
  assert.deepEqual(suggestKit(''), ['core', 'shell', 'research'])
})

test('rows no pack claims stay in every kit', () => {
  const template = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona' },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    { id: 'tool-executor-ptc', name: '@deepseek-ai/dsh-tool-executor-ptc' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  ]
  const rows = compileRows(template, packs, ['core'])
  assert.deepEqual(rows.map((row) => row.id), [
    'persona',
    'tool-ask-user',
    'tool-todo',
    'present',
    'tool-executor-ptc',
  ])
})

test('loadPacks merges YAML overrides from _shared/packs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-packs-'))
  await mkdir(join(root, '_shared', 'packs'), { recursive: true })
  await writeFile(join(root, '_shared', 'packs', 'core.yml'), 'id: core\nname: 核心\ninclude: [tool-fs]\n')
  await writeFile(join(root, '_shared', 'packs', 'design.yml'), 'id: design\nname: 设计\nrows:\n  - id: image\n    name: some-image-plugin\n')
  await writeFile(join(root, '_shared', 'packs', 'broken.yml'), 'id: [\n')
  const merged = await loadPacks(root)
  assert.equal(merged.get('core').name, '核心')
  assert.equal(merged.get('design').name, '设计')
  assert.equal(merged.has('shell'), true)
})
