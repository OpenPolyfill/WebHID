import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../addon/js/background/nm.js', import.meta.url), 'utf8')

function loadNativeMessaging({ deferHandshake = false } = {}) {
  const exports = {}
  const ports = []
  const ownership = { cleared: 0, broadcasts: 0 }
  const packedReports = []
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
            ACT: { hs: 8, open: 2, close: 3 },
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
            postToContentPorts(_tabId, message, dataPortName) {
              if (!message.event) return new Set()
              const event = message.event
              packedReports.push({
                dataPortName,
                event: {
                  eventType: event.eventType,
                  deviceId: event.deviceId,
                  reportId: event.reportId,
                  data: Array.from(event.data)
                }
              })
              return new Set([dataPortName])
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
  return { nativeMessaging: exports.NativeMessaging, ports, ownership, packedReports }
}

test('packed NM input reports reach their device data port', () => {
  const { nativeMessaging, packedReports } = loadNativeMessaging()
  const frame = Buffer.from([1, 42, 0, 0, 0, 7, 3, 0, 0x11, 0x22, 0x33]).toString('base64')

  nativeMessaging.handleNativeMessage({ d: frame })

  assert.deepEqual(packedReports, [
    {
      dataPortName: 'webhid-data:42',
      event: {
        eventType: 'input_report',
        deviceId: 42,
        reportId: 7,
        data: [0x11, 0x22, 0x33]
      }
    }
  ])
})

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
  nativeMessaging.lateOpenRequests.add(99)

  nativeMessaging.reconnectWithNewHost()

  assert.equal(nativeMessaging.port, ports[1].port)
  assert.equal(nativeMessaging.lateOpenRequests.size, 0)
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

test('late successful response to a timed-out open closes its orphan session', async () => {
  const { nativeMessaging } = loadNativeMessaging()
  const requests = []
  nativeMessaging.port = {
    postMessage(message) {
      requests.push(message)
    }
  }
  nativeMessaging.REQUEST_TIMEOUT_MS = 1
  const opening = nativeMessaging.openDevice(42)
  await assert.rejects(opening, /NM request timed out/)
  assert.equal(nativeMessaging.pending.size, 0)
  assert.equal(nativeMessaging.lateOpenRequests.has(requests[0].n), true)

  const closed = []
  nativeMessaging.closeDevice = async (deviceId, token) => {
    closed.push({ deviceId, token })
    return { s: 204 }
  }
  nativeMessaging.handleNativeMessage({
    n: requests[0].n,
    s: 201,
    i: 42,
    t: 'late-session'
  })
  await Promise.resolve()

  assert.deepEqual(closed, [{ deviceId: 42, token: 'late-session' }])
  assert.equal(nativeMessaging.lateOpenRequests.has(requests[0].n), false)
  nativeMessaging.handleNativeMessage({
    n: requests[0].n + 1,
    s: 201,
    i: 42,
    t: 'not-a-timed-out-open'
  })
  await Promise.resolve()
  assert.equal(closed.length, 1)
})
