import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as plugin from '../lib/index.js'

test('plugin module has the Cordis shape', () => {
  assert.equal(plugin.name, 'dsh-whalebuddy')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(plugin.Config({}).dataDir, '')
})

test('locale ships zh and en metadata under the package globs', async () => {
  const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'))
  const pkg = await readJson('../package.json')
  const zh = await readJson('../locale/zh.json')
  const en = await readJson('../locale/en.json')

  assert.ok(pkg.files.includes('locale/*.json'))
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  for (const locale of [zh, en]) {
    assert.equal(typeof locale.meta.title, 'string')
    assert.notEqual(locale.meta.title, '')
    assert.equal(typeof locale.meta.description, 'string')
    assert.notEqual(locale.meta.description, '')
  }
  assert.equal(zh.meta.title, '同事')
  await assert.rejects(readFile(new URL('../locale/zh-CN.json', import.meta.url), 'utf8'))
})
