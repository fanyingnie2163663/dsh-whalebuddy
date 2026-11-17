import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PACKS, compileRows, normalizePack } from '../lib/packs.js'
import { buildPresetDefinition } from '../lib/presets.js'

const packs = new Map(DEFAULT_PACKS.map((pack) => [pack.id, normalizePack(pack)]))
const emp = { slug: '小白', name: '小白', role: '日常', autonomy: 'L2', updatedAt: 0 }

test('a kit that matches no template row falls back to the whole template', () => {
  const template = [
    { id: 'base', name: 'some-base-plugin' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
  ]
  const rows = compileRows(template, packs, ['core'], { skillsDir: '/data/小白/skills' })
  assert.deepEqual(rows.map((row) => row.id), ['base', 'skill-filesystem'])
  assert.deepEqual(rows[1].config.customSkillDirs, ['/data/小白/skills'])
})

test('the preset row carries the kit tool gate, and omits an empty one', () => {
  const gated = buildPresetDefinition(emp, [], undefined, { toolDeny: ['ego_click'] })
  const own = gated.plugins.find((row) => row.name === '@fanyingnie/dsh-whalebuddy')
  assert.deepEqual(own.config, { employee: '小白', toolDeny: ['ego_click'] })

  const open = buildPresetDefinition(emp, [])
  const plain = open.plugins.find((row) => row.name === '@fanyingnie/dsh-whalebuddy')
  assert.equal('toolDeny' in plain.config, false)
})
