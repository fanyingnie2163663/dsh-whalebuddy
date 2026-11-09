import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPresetDefinition, registerEmployeePresets, resolveTemplateRows } from '../lib/presets.js'

const emp = { slug: '小白', name: '小白', role: '日常', autonomy: 'L2', updatedAt: 0 }

test('preset carries the employee slug in its own row', () => {
  const def = buildPresetDefinition(emp, [{ id: 'base', name: 'some-base-plugin' }])
  assert.equal(def.id, 'whalebuddy:小白')
  assert.equal(def.name, '小白')
  const own = def.plugins.find(r => r.name === 'dsh-whalebuddy')
  assert.deepEqual(own.config, { employee: '小白' })
  assert.equal(def.plugins[0].name, 'some-base-plugin')
})

test('a custom data root rides along in the preset row', () => {
  const def = buildPresetDefinition(emp, [], 'D:/colleagues')
  const own = def.plugins.find(r => r.name === 'dsh-whalebuddy')
  assert.deepEqual(own.config, { employee: '小白', dataDir: 'D:/colleagues' })
})

test('register returns a disposer that unregisters every employee', async () => {
  const registered = []
  const registry = { register: async (d) => { registered.push(d.id); return async () => {} } }
  const dispose = await registerEmployeePresets(registry, [emp, { ...emp, slug: '逆戟', name: '逆戟' }], [])
  assert.deepEqual(registered.sort(), ['whalebuddy:小白', 'whalebuddy:逆戟'])
  await dispose()
})

test('one failing registration does not stop the others', async () => {
  const registry = {
    register: async (d) => {
      if (d.id.endsWith('逆戟')) throw new Error('boom')
      return async () => {}
    },
  }
  await assert.doesNotReject(
    registerEmployeePresets(registry, [emp, { ...emp, slug: '逆戟', name: '逆戟' }], []),
  )
})

test('resolveTemplateRows prefers config rows, then the default preset YAML', async () => {
  const agentPresets = {
    resolve: async () => ({ id: 'default' }),
    readDocument: async () => ({ content: '- name: base\n  config: { a: 1 }\n' }),
  }
  assert.deepEqual(await resolveTemplateRows(agentPresets, [{ name: 'cfg' }]), [{ name: 'cfg' }])
  const rows = await resolveTemplateRows(agentPresets, [])
  assert.equal(rows[0].name, 'base')
  assert.equal(rows[0].config.a, 1)
})

test('resolveTemplateRows keeps !!js expressions for the Loader', async () => {
  const source = {
    resolve: async () => ({ id: 'default' }),
    readDocument: async () => ({
      content: [
        '- name: tool-pwsh',
        "  disabled: !!js process.platform !== 'win32'",
        '- name: tool-bash',
        '  disabled: false',
        '- name: tool-web',
        '  config: { enabled: true }',
      ].join('\n'),
    }),
  }

  const rows = await resolveTemplateRows(source, [])

  assert.equal(rows[0].name, 'tool-pwsh')
  assert.deepEqual(rows[0].disabled, { __jsExpr: "process.platform !== 'win32'" })
  assert.equal(rows[1].disabled, false)
  assert.equal(rows[2].config.enabled, true)
})

test('resolveTemplateRows returns [] when nothing parses', async () => {
  const agentPresets = {
    resolve: async () => ({ id: 'default' }),
    readDocument: async () => ({ content: 'just a string' }),
  }
  assert.deepEqual(await resolveTemplateRows(agentPresets, []), [])
})

test('resolveTemplateRows accepts plugins or rows inside the document and survives registry failures', async () => {
  const source = (content) => ({
    resolve: async () => ({ id: 'default' }),
    readDocument: async () => ({ content }),
  })
  assert.deepEqual(await resolveTemplateRows(source('plugins:\n  - name: base\n'), []), [{ name: 'base' }])
  assert.deepEqual(await resolveTemplateRows(source('rows:\n  - id: base\n    name: base\n'), []), [
    { id: 'base', name: 'base' },
  ])

  const broken = {
    resolve: async () => {
      throw new Error('boom')
    },
    readDocument: async () => ({ content: '' }),
  }
  assert.deepEqual(await resolveTemplateRows(broken, []), [])
})
