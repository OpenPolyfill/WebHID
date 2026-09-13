import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../addon/js/background/nm.js', import.meta.url), 'utf8')

function loadNativeMessaging({ deferHandshake = false } = {}) {
  const exports = {}
  const ports = []
  const ownership = { cleared: 0, broadcasts: 0 }
  const context = {
    globalThis: null,
    setTimeout,
    clearTimeout,
    browser: {
      runtime: {
        connectNative(name) {
          const disconnectListeners = []
          const messageListeners = []
          const port = {
            name,
            postMessage(message) {
              if (message.n == null) return
              port.handshakeCalls += 1
              port.lastHandshake = message
              if (!deferHandshake) port.respondHandshake()
            },
            handshakeCalls: 0,
            lastHandshake: null,
            onMessage: {
              addListener(listener) {
                messageListeners.push(listener)
              }
            },
            onDisconnect: {
              addListener(listener) {
                disconnectListeners.push(listener)
              }
            },
            respondHandshake() {
              for (const listener of messageListeners) {
                listener({ n: port.lastHandshake.n, s: 200, w: 123, N: 'nonce' })
              }
            },
            disconnect() {
              for (const listener of disconnectListeners) listener()
            }
          }
          ports.push({ port, disconnectListeners })
          return port
        }
      }
    },
    webhid: {
      import(name) {
        if (name === 'logger') return { debug() {}, warn() {}, error() {} }
        if (name === 'decodeDeviceCollections') return () => {}
        if (name === 'bgPacked') {
          return {
            ACT: {},
            PKG_INPUT_REPORT: 1,
            PKG_SEND_REPORT: 2,
            PKG_SEND_FEATURE_REPORT: 4,
            EVT_CONNECT: 1,
            EVT_DISCONNECT: 2,
            buildPackedSend() {
              return {
                toBase64() {
                  return ''
                }
              }
            }
          }
        }
        if (name === 'bgState') return { deviceCache: [] }
        if (name === 'bgStorage') return { saveDeviceInfo() {} }
        if (name === 'bgStateOps') {
          return {
            tabsForEvent() {
              return null
            },
            collectDeviceSessionOwners() {
              return []
            },
            broadcastGlobalReset() {
              ownership.broadcasts++
            },
            clearAuthorityOwnership() {
              ownership.cleared++
            },
            clearDeviceOwnership() {},
            forTabsOfOrigin() {
              return Promise.resolve()
            }
          }
        }
        if (name === 'http')
          return {
            isOk() {
              return true
            }
          }
        if (name === 'content-ports') {
          return {
            postToContentPorts() {
              return new Set()
            },
            postToContentPort() {}
          }
        }
        throw new Error('unexpected import: ' + name)
      },
      export(name, value) {
        exports[name] = value
      }
    }
  }
  context.globalThis = context
  runInNewContext(source, context)
  return { nativeMessaging: exports.NativeMessaging, ports, ownership }
}

test('host switch retires authority once and ignores stale disconnect', async () => {
  const { nativeMessaging, ports, ownership } = loadNativeMessaging()
  await nativeMessaging.connect()
  const oldPort = ports[0]
  let pendingResult
  nativeMessaging.pending.set(1, {
    resolve(value) {
      pendingResult = value
    }
  })

  nativeMessaging.reconnectWithNewHost()

  assert.equal(nativeMessaging.port, ports[1].port)
  assert.equal(pendingResult.s, 503)
  assert.equal(ownership.cleared, 1)
  assert.equal(ownership.broadcasts, 1)

  for (const listener of oldPort.disconnectListeners) listener()
  assert.equal(nativeMessaging.port, ports[1].port)
  assert.equal(ownership.cleared, 1)
  assert.equal(ownership.broadcasts, 1)
})

test('handshake coalesces concurrent calls but refreshes later', async () => {
  const { nativeMessaging, ports } = loadNativeMessaging({ deferHandshake: true })
  await nativeMessaging.connect()

  const first = nativeMessaging.handshake()
  const second = nativeMessaging.handshake()
  assert.equal(ports[0].port.handshakeCalls, 1)

  ports[0].port.respondHandshake()
  assert.deepEqual(await Promise.all([first, second]), [
    { n: 1, s: 200, w: 123, N: 'nonce' },
    { n: 1, s: 200, w: 123, N: 'nonce' }
  ])
  const third = nativeMessaging.handshake()
  assert.equal(ports[0].port.handshakeCalls, 2)
  ports[0].port.respondHandshake()
  assert.deepEqual(await third, { n: 2, s: 200, w: 123, N: 'nonce' })
})

test('handshake after port replacement uses the new port', async () => {
  const { nativeMessaging, ports } = loadNativeMessaging({ deferHandshake: true })
  await nativeMessaging.connect()
  const first = nativeMessaging.handshake()
  ports[0].port.respondHandshake()
  await first
  ports[0].port.disconnect()
  await nativeMessaging.connect()
  const second = nativeMessaging.handshake()
  assert.equal(ports[1].port.handshakeCalls, 1)
  ports[1].port.respondHandshake()
  assert.deepEqual(await second, { n: 2, s: 200, w: 123, N: 'nonce' })
})
