import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(path, 'utf8')
const manifest = JSON.parse(read('addon/manifest.json'))
const manifestV2 = JSON.parse(read('addon/manifest.v2.json'))
const manifestChromium = JSON.parse(read('addon/manifest.chromium.json'))
const bridge = read('addon/js/content/isolated/bridge.js')
const main = read('addon/js/content/main/index.js')
const bootstrap = read('addon/js/utils/bootstrap.js')
const messages = read('addon/js/background/messages.js')
const nm = read('addon/js/background/nm.js')

function isolatedEntry(value) {
  return (
    value.content_scripts.find((entry) => entry.world === 'ISOLATED') || value.content_scripts[1]
  )
}

test('every production isolated bridge runs in every frame', () => {
  assert.equal(isolatedEntry(manifest).all_frames, true)
  assert.equal(isolatedEntry(manifestV2).all_frames, true)
  assert.equal(isolatedEntry(manifestChromium).all_frames, true)
})

test('bridge is exact-frame and uses same-document capability handoff', () => {
  assert.match(bridge, /wrappedJSObject\.webhid/)
  assert.match(bridge, /wrapReflectors: true/)
  assert.doesNotMatch(bridge, /createBootstrapGate|bootstrapReservations|frameContextBySource/)
  assert.doesNotMatch(bridge, /pagePorts|pageSourceByPort|portOrigin/)
})

test('background owns endpoint registry and exact input fanout', () => {
  assert.match(messages, /frameEndpoints/)
  assert.match(messages, /postToContentPort\(req\.port/)
  assert.match(nm, /collectDeviceSessionOwners\(deviceId\)/)
  assert.match(nm, /postToContentPort\(port/)
})
test('persistent permission events cannot cross opaque partitions', () => {
  assert.match(messages, /function postToPersistentOriginEndpoints/)
  assert.match(messages, /endpoint\.persistentOrigin === persistentOrigin/)
  assert.match(bridge, /messageEvent\.persistentOrigin === context\.persistentOrigin/)
  assert.match(bridge, /message\.persistentOrigin === persistentOrigin/)
})

test('normal frame origin listing skips opaque authorities safely', () => {
  assert.match(messages, /endpoint\.origin\.startsWith\('http:'\)/)
  assert.match(messages, /endpoint\.origin\.startsWith\('https:'\)/)
  assert.doesNotMatch(messages, /new URL\(endpoint\.origin\)\.protocol/)
})
test('frame-origin API preserves opaque persistent target metadata', () => {
  assert.match(messages, /targets\.push/)
  assert.match(messages, /kind: 'opaque'/)
  assert.match(messages, /persistentOrigin: endpoint\.persistentOrigin/)
  assert.doesNotMatch(messages, /kind: 'opaque',\s+label:/)
})
test('settings scope transitions keep one listener subscription set', () => {
  assert.match(bridge, /createSettingsListenerSet/)
  assert.match(bridge, /settingsListenerSet\.install/)
  assert.match(bridge, /logger\.bindSettings/)
})
test('authority metadata gates local origin-sensitive state', () => {
  assert.match(messages, /action: 'endpointMetadata'/)
  assert.match(messages, /typeof sender\.origin/)
  assert.match(bridge, /initializeAuthorityMetadata/)
  assert.match(bridge, /await authorityReady/)
  assert.match(main, /await settingsReady/)
})
test('scope changes resync full MAIN settings and invalidate paired devices', () => {
  assert.match(bridge, /type: 'persistentScopeChanged'/)
  assert.match(bridge, /scopeLoadGeneration/)
  assert.match(bridge, /generation !== scopeLoadGeneration/)
  assert.match(main, /persistentScopeChanged: \(data\)/)
  assert.match(main, /pairedDevices = null/)
  assert.match(main, /deviceInfoCache = null/)
})
test('MAIN settings readiness waits for the initial snapshot', () => {
  const liveSettings = main.match(/settings: \(data\) => \{[\s\S]*?\n    \},/)
  assert.ok(liveSettings)
  assert.doesNotMatch(liveSettings[0], /markSettingsReady/)
  assert.match(main, /sendRequest\('getSettings', \{\}\)[\s\S]*markSettingsReady/)
})

test('MAIN keeps direct capture without child fanout intent', () => {
  assert.doesNotMatch(main, /capturePageBridge\(windowObject\.top/)
  assert.doesNotMatch(main, /bridgePort = windowObject\.top/)
  assert.match(main, /reflect\.deleteProperty\(globalThis, 'webhid'\)/)
  assert.doesNotMatch(main, /windowTopPostMessage/)
  assert.doesNotMatch(main, /webhidFanoutRequest/)
})

test('endpoint replacement retires prior document authorities', () => {
  assert.match(messages, /frameId === 0 \|\| candidate\.frameId === frameId/)
  assert.match(messages, /frameEndpoints\.delete\(port\)/)
  assert.match(messages, /endpointAuthorityIsCurrent/)
  assert.match(messages, /closeFrameSessions/)
})

test('missing top endpoint fails child persistence closed', () => {
  assert.match(messages, /const persistentOrigin = top[\s\S]*: null/)
  assert.doesNotMatch(messages, /const top = topEndpointForTab\(tabId\)\s+if \(!top\) return/)
})

test('iframe delegation is not a presence-only grant', () => {
  assert.match(bridge, /function delegationToken/)
  assert.match(bridge, /token === 'none'/)
  assert.match(bridge, /token === 'self'/)
  assert.match(bridge, /token === 'src'/)
  assert.doesNotMatch(bridge, /some\(\(directive\) => \^\\\\s\*hid/)
})

test('top bridge multiplexes same-origin child contexts proactively', () => {
  assert.match(bridge, /const fanoutContexts = new Map\(\)/)
  assert.match(bridge, /fanoutContexts\.set\(context\.channel, context\)/)
  assert.doesNotMatch(bridge, /fanoutRequest: handleFanoutRequestMessage/)
  assert.match(bridge, /frameContexts\.get\(context\.key\) !== context/)
  assert.match(bridge, /frameContexts\.values\(\)/)
})
test('fanout registration is stateless and browser-authenticated', () => {
  assert.match(bridge, /origin !== window\.location\.origin/)
  assert.match(bridge, /identity\.frameId == null \|\| identity\.documentId == null/)
  assert.match(messages, /function handleFanoutOpen/)
  assert.match(messages, /request\.origin !== top\.origin/)
  assert.match(messages, /postToContentPort\(child\.port/)
  assert.match(messages, /pairOtp/)
  assert.match(messages, /ackOtp/)
  assert.match(messages, /fanoutOpen: handleFanoutOpen/)
  assert.doesNotMatch(messages, /fanoutEndpoints/)
})

test('ordinary requests resolve only through real control endpoints', () => {
  assert.match(messages, /function endpointForRequest\(_request, port\)/)
  assert.match(messages, /return endpointForPort\(port\)/)
  assert.match(messages, /function endpointRegistryIsCurrent/)
  assert.doesNotMatch(messages, /fanoutEndpoints/)
})

test('fanout contexts stay isolated from background endpoint lifetimes', () => {
  assert.match(bridge, /context\.isFanout = true/)
  assert.match(bridge, /if \(close && !context\.isFanout\)/)
  assert.match(bridge, /frameContexts\.delete\(context\.key\)/)
  assert.match(bridge, /context\.channel\) fanoutContexts\.delete/)
  assert.match(messages, /Background does not retain fanout state/)
})

test('fanout candidate relays through direct control without adoption', () => {
  assert.match(main, /fanoutDeliver: handleFanoutDeliverMessage/)
  assert.match(main, /nav\.hid = port/)
  assert.match(main, /bridgePort/)
  assert.match(main, /installBrokerCandidateRelay/)
  assert.match(bridge, /fanoutCandidate: handleBrokerCandidate/)
  assert.match(bridge, /brokerPairReady = true/)
  assert.match(main, /type: 'fanoutCandidate'/)
})
