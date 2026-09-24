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

test('top bridge consumes child offers without top-initiated pairing', () => {
  assert.match(bridge, /const fanoutContexts = new Map\(\)/)
  assert.match(bridge, /fanoutContexts\.set\(channel, context\)/)
  assert.match(bridge, /function handleFanoutBrokerOffer/)
  assert.doesNotMatch(bridge, /fanoutOpen/)
  assert.doesNotMatch(bridge, /fanoutPairSeed/)
})

test('child offer waits for its exact direct control endpoint', () => {
  assert.match(bridge, /controlPort = browser\.runtime\.connect\(\{ name: 'webhid-control' \}\)[\s\S]*fanoutChildOffer/)
  assert.match(messages, /function handleFanoutChildOffer/)
  assert.match(messages, /const child = endpointForPort\(port\)/)
  assert.match(messages, /const top = child && topEndpointForTab\(child\.tabId\)/)
  assert.match(messages, /authOtp/)
  assert.match(messages, /ackOtp/)
  assert.doesNotMatch(messages, /fanoutOpen/)
})

test('fanout contexts stay isolated from background endpoint lifetimes', () => {
  assert.match(bridge, /context\.isFanout = true/)
  assert.match(bridge, /if \(close && !context\.isFanout\)/)
  assert.match(bridge, /frameContexts\.delete\(context\.key\)/)
  assert.match(bridge, /fanoutContexts\.delete\(context\.channel\)/)
  assert.match(messages, /postToContentPort\(top\.port/)
  assert.doesNotMatch(messages, /fanoutEndpoints/)
})

test('stack OTP handoff and isolated mutual authentication remain separate', () => {
  assert.match(main, /fanoutBrokerCandidate: handleFanoutBrokerCandidate/)
  assert.match(main, /webhidBroker_/)
  assert.match(main, /yieldNavigatorHid/)
  assert.match(main, /brokerStackOtp = null/)
  assert.match(bridge, /fanoutCandidate: handleBrokerCandidate/)
  assert.match(bridge, /type: 'fanoutAuthA'/)
  assert.match(bridge, /type: 'fanoutAuthB'/)
  assert.match(bridge, /brokerPairReady = true/)
  assert.doesNotMatch(main, /fanoutDeliver/)
})
test('hostile setter values yield to ordinary page semantics', () => {
  assert.match(main, /yieldNavigatorHid\(value\)/)
  assert.match(main, /reflect\.deleteProperty\(Navigator\.prototype, 'hid'\)/)
  assert.match(main, /object\.defineProperty\(host\.navigator, 'hid'/)
})

test('allowed device IDs normalize daemon values before authorization', () => {
  assert.match(bridge, /new Set\(resp\.deviceIds\.map\(\(deviceId\) => String\(deviceId\)\)\)/)
  assert.match(bridge, /allowed\.has\(String\(deviceId\)\)/)
  assert.match(bridge, /new Set\(message\.deviceIds\.map\(\(deviceId\) => String\(deviceId\)\)\)/)
})

test('loaded authorization misses refresh before denying', () => {
  assert.match(bridge, /loadedOrigins\.delete\(origin\)/)
  assert.match(bridge, /allowedByOrigin\.delete\(origin\)/)
  assert.match(bridge, /loadAllowedDeviceIds\(origin\)/)
})

test('broker runtime requests normalize IDs and preserve response dispatch', () => {
  assert.match(bridge, /const key = String\(deviceId\)[\s\S]*runtimeDataPorts\.get\(key\)/)
  assert.match(bridge, /msg: message,[\s\S]*kind: 'broker-page'/)
  assert.match(bridge, /handleWorkerReportResponse\(\s*\{\s*\.\.\.pending\.msg/)
  assert.match(bridge, /dataPending\.delete\(reqId\)[\s\S]*handleWorkerReportResponse\(/)
})

test('stack and mutual-auth OTPs invalidate across stale lifetimes', () => {
  assert.match(bridge, /message\.frameId !== identity\.frameId/)
  assert.match(bridge, /message\.documentId !== identity\.documentId/)
  assert.match(bridge, /invalidateBrokerPairOffer\(\)/)
  assert.match(bridge, /stackOtp = null/)
  assert.match(bridge, /setTimeout\(\(\) =>/)
  assert.match(main, /brokerStackOtp = null/)
})
