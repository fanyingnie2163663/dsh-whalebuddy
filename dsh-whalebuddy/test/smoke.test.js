import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'

test('plugin module has the Cordis shape', () => {
  assert.equal(plugin.name, 'dsh-whalebuddy')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(plugin.Config({}).dataDir, '')
})
