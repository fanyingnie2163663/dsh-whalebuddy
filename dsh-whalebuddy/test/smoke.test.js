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

test('manifest declares the DSH line and the surfaces it uses', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.private, false)
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(pkg.dsh.kind, 'plugin')
  assert.match(pkg.engines.dsh, /^>=0\.2\.2-0 <0\.3\.0$/)
  assert.deepEqual(pkg.dsh.capabilities, [
    'fs:read',
    'fs:write',
    'network:ingress',
    'sessions:read',
    'system-prompt:write',
  ])
  assert.deepEqual(pkg.dsh.labels, [])
  assert.ok(pkg.files.includes('README.md'))
  assert.match(await readFile(new URL('../README.md', import.meta.url), 'utf8'), /Whalebuddy/)
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
  assert.equal(zh.meta.title, 'Whalebuddy')
  await assert.rejects(readFile(new URL('../locale/zh-CN.json', import.meta.url), 'utf8'))
})
