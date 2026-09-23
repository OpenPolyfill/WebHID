import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const source = readFileSync(
  new URL('../../addon/js/background/messages.js', import.meta.url),
  'utf8'
)

function loadMessages() {
  let registerMessageHandlers
  const frameEndpoints = new Map()
  const pendingPicker = new Map()
  const permissionsPolicy = new Map()
  const frameDelegations = new Map()
  const frameLifetimes = new Map()
  const ports = []
  let purgeCalls = 0
  const onConnect = []
  const onMessage = []
  const persistentSiteScope = (origin) => origin
  const documentFrameKey = (tabId, frameId, documentId) => `${tabId}:${frameId}:${documentId || ''}`
  const stateOps = {
    registerFrameLifetime(tabId, frameKey) {
      let frames = frameLifetimes.get(tabId)
      if (!frames) {
        frames = new Map()
        frameLifetimes.set(tabId, frames)
      }
      if (frames.get(frameKey) === 0) return false
      frames.set(frameKey, (frames.get(frameKey) || 0) + 1)
      return true
    },
    isFrameLifetimeActive(tabId, frameKey) {
      return frameLifetimes.get(tabId)?.get(frameKey) > 0
    },
    purgeFrame() {
      purgeCalls++
      return Promise.resolve()
    },
    closeForCleanup: () => Promise.resolve(true),
    setBadgeRefresh() {},
    registerDeviceTab() {},
    registerDeviceSession() {
      return true
    },
    unregisterDeviceSession() {},
    unregisterDeviceTab() {},
    isTabAuthorizedForDevice() {
      return false
    },
    isSessionOwnedBy() {
      return false
    },
    getDeviceSessionOwner() {
      return null
    },
    setDeviceSessionPlane() {
      return false
    },
    collectDevicePlaneStatuses() {
      return []
    },
    collectOpenDeviceIdsForTab() {
      return []
    },
    collectDeviceSessionsForOrigin() {
      return []
    },
    clearDeviceSessionsForOrigin() {},
    purgeTab() {}
  }
  const browser = {
    runtime: {
      onConnect: {
        addListener(listener) {
          onConnect.push(listener)
        }
      },
      onMessage: {
        addListener(listener) {
          onMessage.push(listener)
        }
      },
      getURL(path) {
        return 'moz-extension://test/' + path
      }
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => ({})
    },
    windows: { remove: async () => {} },
    notifications: { clear: async () => {} },
    storage: { session: { get: async () => ({}) } }
  }
  const nativeMessaging = {
    port: {},
    enumerateDevices: async () => ({ s: 200, D: [] }),
    handshake: async () => ({ s: 200 }),
    closeDevice: async () => ({ s: 204 }),
    openDevice: async () => ({ s: 403 })
  }
  const imports = {
    pristine: { host: { cryptoRandomUUID: () => 'test-otp' } },
    'content-ports': {
      registerContentPort() {},
      postToContentPort(port, message) {
        port.postMessage(message)
      }
    },
    loadEffectiveSettings: async () => ({ dataPlane: 'nm' }),
    http: { isOk: (status) => status >= 200 && status < 300 },
    logger: { debug() {}, warn() {}, error() {} },
    isChromium: false,
    decodeDeviceCollections() {},
    persistentSiteScope,
    bgState: {
      deviceCache: [],
      pendingPicker,
      permissionsPolicy,
      frameDelegations,
      frameEndpoints,
      pageActionVisibility: {}
    },
    bgStorage: {
      saveDeviceInfoBatch() {},
      getDeviceInfo: async () => null,
      getAllowedDevices: async () => [],
      addAllowedDevice: async () => {},
      removeAllowedDevice: async () => {},
      removeDeviceInfo() {},
      recordGrantGroup: async () => {},
      getGrantGroupsForOrigin: async () => [],
      deleteGrantGroups: async () => {},
      getAllAllowedByOrigin: async () => new Map()
    },
    bgStateOps: stateOps,
    bgCsp: {
      urlOrigin: (url) => new URL(url).origin,
      frameKey: (tabId, frameId, origin) => `${tabId}:${frameId}:${origin}`,
      documentFrameKey
    },
    NativeMessaging: nativeMessaging,
    bgPacked: { ACT: {} },
    bgBundle: { ensureWorkerBundle: async () => null },
    GLOBAL_DEFAULTS: { dataPlane: 'nm' },
    armShadowSpawn() {},
    unarmShadowSpawn() {}
  }
  const context = {
    globalThis: null,
    browser,
    webhid: {
      import(name) {
        if (!(name in imports)) throw new Error('unexpected import: ' + name)
        return imports[name]
      },
      export(name, value) {
        if (name === 'registerMessageHandlers') registerMessageHandlers = value
      }
    }
  }
  context.globalThis = context
  runInNewContext(source, context)
  registerMessageHandlers({ actionApi: null })

  function connect(sender) {
    const messageListeners = []
    const disconnectListeners = []
    const postedMessages = []
    const port = {
      name: 'webhid-control',
      sender,
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
      postMessage(message) {
        postedMessages.push(message)
      },
      postedMessages,
      receive(request) {
        for (const listener of messageListeners) listener(request)
      },
      disconnect() {
        for (const listener of disconnectListeners) listener()
      }
    }
    ports.push(port)
    for (const listener of onConnect) listener(port)
    return port
  }

  return {
    connect,
    pendingPicker,
    frameEndpoints,
    ports,
    getPurgeCalls: () => purgeCalls
  }
}

const sender = (frameId, documentId) => ({
  tab: { id: 1 },
  frameId,
  documentId,
  origin: 'https://frame-' + frameId + '.test',
  url: 'https://frame-' + frameId + '.test/'
})

const sameOriginSender = (frameId, documentId) => ({
  tab: { id: 1 },
  frameId,
  documentId,
  origin: 'https://same.test',
  url: 'https://same.test/frame-' + frameId
})

test('proactive retirement clears picker requests owned by request endpoint', () => {
  const state = loadMessages()
  const oldPort = state.connect(sender(0, 'old'))
  state.pendingPicker.set(1, {
    port: oldPort,
    ownerEndpointId: state.frameEndpoints.get(oldPort).id,
    uiEndpointId: null
  })
  state.connect(sender(0, 'new'))
  assert.equal(state.pendingPicker.size, 0)
  assert.equal(state.getPurgeCalls(), 1)
})

test('proactive retirement clears modal pickers owned by UI endpoint', () => {
  const state = loadMessages()
  const oldUiPort = state.connect(sender(0, 'old'))
  const requestPort = state.connect(sender(1, 'request'))
  state.pendingPicker.set(1, {
    port: requestPort,
    ownerEndpointId: state.frameEndpoints.get(requestPort).id,
    uiPort: oldUiPort,
    uiEndpointId: state.frameEndpoints.get(oldUiPort).id
  })
  state.connect(sender(0, 'new'))
  assert.equal(state.pendingPicker.size, 0)
})

test('retiring an unrelated sibling leaves the picker intact', () => {
  const state = loadMessages()
  const uiPort = state.connect(sender(0, 'ui'))
  const requestPort = state.connect(sender(1, 'request'))
  state.pendingPicker.set(1, {
    port: requestPort,
    ownerEndpointId: state.frameEndpoints.get(requestPort).id,
    uiPort,
    uiEndpointId: state.frameEndpoints.get(uiPort).id
  })
  const sibling = state.connect(sender(2, 'sibling'))
  state.connect(sender(2, 'replacement'))
  assert.equal(state.pendingPicker.size, 1)
  assert.equal(state.pendingPicker.get(1).port, requestPort)
  assert.equal(sibling.name, 'webhid-control')
})

test('disconnect after proactive retirement is idempotent', () => {
  const state = loadMessages()
  const oldPort = state.connect(sender(0, 'old'))
  const sibling = state.connect(sender(1, 'sibling'))
  state.pendingPicker.set(1, {
    port: sibling,
    ownerEndpointId: state.frameEndpoints.get(sibling).id,
    uiPort: oldPort,
    uiEndpointId: state.frameEndpoints.get(oldPort).id
  })
  state.connect(sender(0, 'new'))
  assert.equal(state.pendingPicker.size, 0)
  const purgeCalls = state.getPurgeCalls()
  assert.doesNotThrow(() => oldPort.disconnect())
  assert.equal(state.getPurgeCalls(), purgeCalls)
})

test('child offer replies to the exact child and forwards fresh A/B to top', () => {
  const state = loadMessages()
  const topPort = state.connect(sameOriginSender(0, 'top'))
  const childPort = state.connect(sameOriginSender(1, 'child'))
  childPort.receive({ action: 'fanoutChildOffer', stackOtp: 'stack-otp' })
  const childOffer = childPort.postedMessages.find(
    (message) => message.action === 'fanoutPairOffer'
  )
  const topOffer = topPort.postedMessages.find(
    (message) => message.action === 'fanoutBrokerOffer'
  )
  assert.deepEqual({ ...childOffer }, {
    action: 'fanoutPairOffer',
    authOtp: 'test-otp',
    ackOtp: 'test-otp',
    frameId: 1,
    documentId: 'child',
    origin: 'https://same.test'
  })
  assert.deepEqual({ ...topOffer, child: { ...topOffer.child } }, {
    action: 'fanoutBrokerOffer',
    authOtp: 'test-otp',
    ackOtp: 'test-otp',
    child: {
      frameId: 1,
      documentId: 'child',
      origin: 'https://same.test',
      stackOtp: 'stack-otp'
    }
  })
  assert.equal(state.frameEndpoints.size, 2)
})

test('child offer fails closed without a live top endpoint', () => {
  const state = loadMessages()
  const childPort = state.connect(sameOriginSender(1, 'child'))
  childPort.receive({ action: 'fanoutChildOffer', stackOtp: 'stack-otp' })
  assert.equal(childPort.postedMessages.at(-1).ok, false)
  assert.equal(state.frameEndpoints.size, 1)
})
