import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(
  new URL('../../addon/js/background/webrequest.js', import.meta.url),
  'utf8'
)

export function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

export function loadWebRequest({ siteSettings = Promise.resolve({}) } = {}) {
  const exports = {}
  const listeners = new Map()
  const filters = new Map()
  const workerPolyfillSites = new Set()
  const addListener = (name) => ({
    addListener(listener, filter) {
      const entries = listeners.get(name) || []
      entries.push({ listener, filter })
      listeners.set(name, entries)
    }
  })
  const browser = {
    runtime: {
      getManifest: () => ({ manifest_version: 3 }),
      getBrowserInfo: () => Promise.resolve({ version: '150' }),
      getURL: (path) => path
    },
    storage: {
      session: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve()
      }
    },
    webRequest: {
      onBeforeRequest: addListener('onBeforeRequest'),
      onBeforeSendHeaders: addListener('onBeforeSendHeaders'),
      onBeforeRedirect: addListener('onBeforeRedirect'),
      onErrorOccurred: addListener('onErrorOccurred'),
      onHeadersReceived: addListener('onHeadersReceived'),
      filterResponseData(requestId) {
        let finish
        const done = new Promise((resolve) => {
          finish = resolve
        })
        const filter = {
          writes: [],
          closed: false,
          disconnected: false,
          done,
          write(data) {
            this.writes.push(Uint8Array.from(data))
          },
          close() {
            this.closed = true
            finish()
          },
          disconnect() {
            this.disconnected = true
            finish()
          },
          output() {
            const size = this.writes.reduce((total, chunk) => total + chunk.byteLength, 0)
            const output = new Uint8Array(size)
            let offset = 0
            for (const chunk of this.writes) {
              output.set(chunk, offset)
              offset += chunk.byteLength
            }
            return output
          }
        }
        filters.set(requestId, filter)
        return filter
      }
    }
  }
  const imports = {
    logger: { debug() {}, warn() {}, error() {} },
    isChromium: false,
    bgState: {
      workerPolyfillSites,
      permissionsPolicy: new Map(),
      frameDelegations: new Map(),
      shadowArms: new Map()
    },
    bgBundle: {
      ensureWorkerBundle: () => Promise.resolve(''),
      ensureWorkerPolyfillBundle: () => Promise.resolve('/* worker polyfill */')
    },
    bgCsp: {
      parseCspForWorkerSpawn: () => ({
        needsBlobFallback: true,
        workerSrc: ["'self'"],
        connectSrc: null,
        workerSrcBlocked: false,
        connectSrcBlocked: false,
        hasTrustedTypesRequire: false,
        shadowBlocked: false
      }),
      rewriteCspValue: (value) => ({ value: value + ' blob:', modified: true }),
      rewriteCspForBlob: () => null,
      urlOrigin: (value) => new URL(value).origin,
      frameKey: (tabId, frameId, origin) => `${tabId}:${frameId}:${origin}`,
      documentFrameKey: () => '',
      allowInlineScript: () => null
    },
    loadSiteSettings: () => siteSettings,
    bundleFiles: { mv2MainWorld: [] }
  }
  const webhid = {
    import(name) {
      if (!(name in imports)) throw new Error('unexpected import: ' + name)
      return imports[name]
    },
    export(name, value) {
      exports[name] = value
    }
  }
  const context = {
    browser,
    webhid,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Map,
    Set,
    Promise
  }
  context.globalThis = context
  runInNewContext(source, context)
  exports.registerWebRequestHandlers({
    workerPolyfillEnabled: true,
    workerSpawnMode: 'blob'
  })
  return { listeners, filters, workerPolyfillSites }
}

export function listenerFor(listeners, name, type) {
  return listeners.get(name).find(({ filter }) => filter.types.includes(type)).listener
}

export function sendWorkerScript(harness, chunks) {
  const details = {
    requestId: 'worker-request',
    type: 'script',
    url: 'https://example.test/worker.js'
  }
  listenerFor(harness.listeners, 'onBeforeRequest', 'script')(details)
  listenerFor(
    harness.listeners,
    'onBeforeSendHeaders',
    'script'
  )({
    requestId: details.requestId,
    requestHeaders: [{ name: 'Sec-Fetch-Dest', value: 'worker' }]
  })
  const filter = harness.filters.get(details.requestId)
  for (const chunk of chunks) filter.ondata({ data: chunk })
  filter.onstop()
  return filter
}
