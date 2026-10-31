import assert from 'node:assert/strict'
import test from 'node:test'
import { deferred, loadWebRequest, listenerFor } from './webrequest-helpers.js'

test('meta CSP rewrite disconnects after preserving chunks received during async lookup', async () => {
  const setting = deferred()
  const harness = loadWebRequest({ siteSettings: setting.promise })
  const details = {
    requestId: 'document-request',
    type: 'main_frame',
    url: 'https://example.test/',
    tabId: 1,
    frameId: 0
  }
  listenerFor(harness.listeners, 'onBeforeRequest', 'main_frame')(details)
  const filter = harness.filters.get(details.requestId)
  const first = new TextEncoder().encode(
    '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"></head>'
  )
  const rest = new TextEncoder().encode('<body>the response tail remains intact</body></html>')
  filter.ondata({ data: first.buffer })
  filter.ondata({ data: rest.buffer })
  setting.resolve({})
  await filter.done

  const html = new TextDecoder().decode(filter.output())
  assert.match(html, /content="script-src \'self\' blob:"/)
  assert.ok(html.endsWith('<body>the response tail remains intact</body></html>'))
  assert.equal(filter.disconnected, true)
  assert.equal(filter.closed, false)
})

test('same-frame navigation ignores a delayed prior CSP header store', async () => {
  const oldSettings = deferred()
  const settings = [
    Promise.resolve({}),
    oldSettings.promise,
    Promise.resolve({}),
    Promise.resolve({})
  ]
  let settingsCalls = 0
  const harness = loadWebRequest({
    siteSettings: () => settings[settingsCalls++] || Promise.resolve({})
  })
  const onBeforeRequest = listenerFor(harness.listeners, 'onBeforeRequest', 'main_frame')
  const responseListeners = harness.listeners
    .get('onHeadersReceived')
    .filter(({ filter }) => filter.types.includes('main_frame'))
  const storeHeaders = responseListeners[responseListeners.length - 1].listener
  const first = {
    requestId: 'same-frame-nav-a',
    type: 'main_frame',
    url: 'https://example.test/first',
    tabId: 7,
    frameId: 0,
    documentId: 'document-a',
    responseHeaders: [{ name: 'Content-Security-Policy', value: "default-src 'self'" }]
  }
  const second = {
    ...first,
    requestId: 'same-frame-nav-b',
    url: 'https://example.test/second',
    documentId: 'document-b'
  }

  onBeforeRequest(first)
  const firstMetaFilter = harness.filters.get(first.requestId)
  const firstStore = storeHeaders(first)
  onBeforeRequest(second)
  const secondMetaFilter = harness.filters.get(second.requestId)
  await storeHeaders(second)

  oldSettings.resolve({})
  await firstStore

  const stored = harness.sessionStore.get('csp:7:0:https://example.test')
  assert.equal(stored.__webhidNavigationGeneration, 2)
  assert.equal(stored.__webhidDocumentId, 'document-b')

  firstMetaFilter.onstop()
  secondMetaFilter.onstop()
  await Promise.all([firstMetaFilter.done, secondMetaFilter.done])
})

test('late meta CSP processing cannot overwrite the next same-origin document', async () => {
  const harness = loadWebRequest()
  const onBeforeRequest = listenerFor(harness.listeners, 'onBeforeRequest', 'main_frame')
  const responseListeners = harness.listeners
    .get('onHeadersReceived')
    .filter(({ filter }) => filter.types.includes('main_frame'))
  const storeHeaders = responseListeners[responseListeners.length - 1].listener
  const first = {
    requestId: 'meta-nav-a',
    type: 'main_frame',
    url: 'https://example.test/first',
    tabId: 8,
    frameId: 0,
    documentId: 'document-a',
    responseHeaders: [{ name: 'Content-Security-Policy', value: "default-src 'self'" }]
  }
  const second = {
    ...first,
    requestId: 'meta-nav-b',
    url: 'https://example.test/second',
    documentId: 'document-b'
  }

  onBeforeRequest(first)
  const firstMetaFilter = harness.filters.get(first.requestId)
  await storeHeaders(first)
  onBeforeRequest(second)
  const secondMetaFilter = harness.filters.get(second.requestId)
  await storeHeaders(second)

  const html = new TextEncoder().encode(
    '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"></head></html>'
  )
  firstMetaFilter.ondata({ data: html.buffer })
  await firstMetaFilter.done

  const stored = harness.sessionStore.get('csp:8:0:https://example.test')
  assert.equal(stored.__webhidNavigationGeneration, 2)
  assert.equal(stored.__webhidDocumentId, 'document-b')

  secondMetaFilter.onstop()
  await secondMetaFilter.done
})

test('redirect hops on the same requestId advance the CSP navigation identity', async () => {
  const harness = loadWebRequest()
  const onBeforeRequest = listenerFor(harness.listeners, 'onBeforeRequest', 'main_frame')
  const responseListeners = harness.listeners
    .get('onHeadersReceived')
    .filter(({ filter }) => filter.types.includes('main_frame'))
  const storeHeaders = responseListeners[responseListeners.length - 1].listener
  const redirect = {
    requestId: 'redirect-chain',
    type: 'main_frame',
    url: 'https://example.test/redirect',
    tabId: 9,
    frameId: 0,
    responseHeaders: [{ name: 'Content-Security-Policy', value: "default-src 'self'" }]
  }
  const final = {
    ...redirect,
    url: 'https://example.test/final',
    documentId: 'final-document'
  }

  onBeforeRequest(redirect)
  const redirectMetaFilter = harness.filters.get(redirect.requestId)
  await storeHeaders(redirect)
  onBeforeRequest(final)
  const finalMetaFilter = harness.filters.get(final.requestId)
  await storeHeaders(final)
  await storeHeaders(redirect)

  const stored = harness.sessionStore.get('csp:9:0:https://example.test')
  assert.equal(harness.cspFrameNavigations.get('9:0').requestId, final.requestId)
  assert.equal(harness.cspFrameNavigations.get('9:0').url, final.url)
  assert.equal(stored.__webhidNavigationGeneration, 2)
  assert.equal(stored.__webhidDocumentId, 'final-document')

  redirectMetaFilter.onstop()
  finalMetaFilter.onstop()
  await Promise.all([redirectMetaFilter.done, finalMetaFilter.done])
})
