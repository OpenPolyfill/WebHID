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
