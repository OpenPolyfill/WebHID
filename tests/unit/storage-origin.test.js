import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(
  new URL('../../addon/js/background/storage.js', import.meta.url),
  'utf8'
)

function loadStorage() {
  const exports = {}
  let openCalls = 0
  const context = {
    globalThis: null,
    indexedDB: {
      open() {
        openCalls++
        throw new Error('opaque origin must not open IndexedDB')
      }
    },
    webhid: {
      import(name) {
        if (name === 'logger') return { debug() {} }
        if (name === 'bgState') return { deviceCache: [] }
        throw new Error('unexpected import: ' + name)
      },
      export(name, value) {
        exports[name] = value
      }
    }
  }
  context.globalThis = context
  runInNewContext(source, context)
  return { exports, getOpenCalls: () => openCalls }
}

test('opaque origin cannot read or persist HID grants', async () => {
  const { exports, getOpenCalls } = loadStorage()

  const storage = exports.bgStorage
  assert.equal(JSON.stringify(await storage.getAllowedDevices('null')), '[]')
  await storage.addAllowedDevice('null', 7)
  await storage.removeAllowedDevice('null', 7)
  await storage.recordGrantGroup('null', [7, 8])
  assert.equal(JSON.stringify(await storage.getGrantGroupsForOrigin('null')), '[]')
  assert.equal(getOpenCalls(), 0)
})
