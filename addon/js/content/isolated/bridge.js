;(function () {
  'use strict'

  /** @type {import("./types.js").Logger} */
  const logger = webhid.import('logger')
  const isChromium = webhid.import('isChromium')
  const http = webhid.import('http')
  const createSettingsStore = webhid.import('createSettingsStore')
  const createSettingsListenerSet = webhid.import('createSettingsListenerSet')
  const createScopedSettingsLoader = webhid.import('createScopedSettingsLoader')
  const loadEffectiveSettings = webhid.import('loadEffectiveSettings')
  const loadSiteSettings = webhid.import('loadSiteSettings')
  const parseSettingsKey = webhid.import('parseSettingsKey')
  const WebHidDevicePicker = webhid.import('WebHidDevicePicker')
  logger.initLogger('bridge')
  const frameInstanceId = 'frame-' + crypto.randomUUID()
  const pageChannel = new MessageChannel()
  const fanoutCandidate = (function () {
    if (window === window.top) return false
    const origin = window.location.origin
    if (!origin || origin === 'null') return false
    try {
      if (window.top.location.origin !== origin) return false
    } catch {
      return false
    }
    return true
  })()
  let stackOtp = fanoutCandidate ? crypto.randomUUID() : null
  const bootstrapValue = fanoutCandidate
    ? { directPort: pageChannel.port2, S: stackOtp, stackOtp }
    : pageChannel.port2
  if (isChromium) window.postMessage(bootstrapValue, '*', [pageChannel.port2])
  else {
    window.wrappedJSObject.webhid = globalThis.cloneInto(bootstrapValue, window, {
      wrapReflectors: true
    })
  }
  const pagePort = pageChannel.port1
  const controlQueue = []
  let controlPort = null
  let controlPending = null
  let nextHandshakeReqId = 0
  const handshakePending = new Map()
  const pickerResultHandlers = new Map()
  let authorityOrigin = ''
  let persistentOrigin = null
  let scopeLoadGeneration = 0
  let authorityFailed = false
  let resolveAuthorityReady = null
  const authorityReady = new Promise((resolve) => {
    resolveAuthorityReady = resolve
  })
  /** @type {number|null} */
  let brokerPairTimer = null
  /** @type {((event: MessageEvent) => void)|null} */
  let brokerPairHandler = null
  /** @type {MessagePort|null} */
  let pendingBrokerPort = null
  /** @type {MessagePort|null} */
  let brokerPort = null
  let brokerPairReady = false
  /** @type {{stackOtp: string, authOtp: string, ackOtp: string, frameId: number, documentId: string, origin: string}|null} */
  let brokerPairOffer = null
  /** @type {Map<string, {resolve: Function, reject: Function}>} */
  const brokerPending = new Map()
  /** @type {Set<string>} plane keys whose NM traffic was ever brokered */
  const brokerAttachedKeys = new Set()
  let nextBrokerRequestId = 0
  /** @type {Map<string, {deviceId: string, clientKey: string, generation: number}>} */
  const brokerAttachments = new Map()
  const fanoutContexts = new Map()
  let nextFanoutChannel = 0
  /** @returns {void} */
  function pumpControlQueue() {
    if (controlPending || controlQueue.length === 0) return
    controlPending = controlQueue.shift()
    try {
      controlPort.postMessage(controlPending.request)
    } catch (error) {
      controlPending.reject(error)
      controlPending = null
      pumpControlQueue()
    }
  }
  /**
   * Sends one background control request over the serialized control queue.
   * The context argument documents the requesting frame for call sites;
   * the background attributes every request to the control port's own
   * registered endpoint.
   * @param {object} request
   * @param {FrameContext|null} [context]
   * @returns {Promise<object>}
   */
  function sendBackgroundRequest(request, context = null) {
    return new Promise((resolve, reject) => {
      controlQueue.push({ request, resolve, reject, context })
      pumpControlQueue()
    })
  }
  /**
   * Sends the startup daemon handshake over the persistent control port without
   * occupying the serialized request slot used by page operations.
   * @returns {Promise<object>}
   */
  function sendHandshakeRequest() {
    return new Promise((resolve, reject) => {
      const reqId = 'handshake:' + ++nextHandshakeReqId
      handshakePending.set(reqId, { resolve, reject })
      try {
        controlPort.postMessage({ action: 'handshake', reqId })
      } catch (error) {
        handshakePending.delete(reqId)
        reject(error)
      }
    })
  }
  /** @param {MessagePort} port @returns {void} */
  function wireControlPort(port) {
    port.onMessage.addListener((message) => {
      if (message && message.action === 'fanoutPairOffer') {
        handleFanoutPairOffer(message)
        return
      }
      if (message && message.action === 'fanoutBrokerOffer') {
        handleFanoutBrokerOffer(message)
        return
      }
      if (message && message.action === 'endpointMetadata') {
        initializeAuthorityMetadata(message)
        return
      }
      if (message && message.action === 'pickerResult') {
        const handler = pickerResultHandlers.get(message.requestId)
        if (handler) handler(message)
        return
      }
      if (message && message.action === 'frameDelegationQuery') {
        port.postMessage({
          action: 'frameDelegationResult',
          requestId: message.requestId,
          delegated: frameDelegationForChild(message)
        })
        return
      }
      if (message && message.action === 'showInlinePicker') {
        if (!devicePicker) return
        devicePicker
          .show(message.filters || [], message.exclusionFilters || [])
          .then((result) =>
            sendBackgroundRequest({
              action: 'inlinePickerResult',
              requestId: message.requestId,
              selected: !!(result.devices && result.devices.length),
              devices: result.devices || null
            })
          )
          .catch((e) => logger.debug('inline picker failed', e))
        return
      }
      if (message && message.action === 'globalReset') {
        handleGlobalReset()
        return
      }
      if (
        message &&
        message.action === 'allowedDevicesChanged' &&
        Array.isArray(message.deviceIds) &&
        message.persistentOrigin === persistentOrigin
      ) {
        const origin = message.persistentOrigin
        allowedByOrigin.set(
          origin,
          new Set(message.deviceIds.map((deviceId) => String(deviceId)))
        )
        loadedOrigins.add(origin)
        flushAllowedDeviceIdsQueue(origin)
        return
      }
      if (message && message.action === 'webhidDeviceEvent' && message.event) {
        handleBackgroundEvent(message)
        return
      }
      if (message && message.reqId != null) {
        const pending = handshakePending.get(message.reqId)
        if (pending) {
          handshakePending.delete(message.reqId)
          pending.resolve(message)
          return
        }
      }
      if (controlPending) {
        const pending = controlPending
        controlPending = null
        pending.resolve(message)
        pumpControlQueue()
      }
    })
    port.onDisconnect.addListener(() => {
      const error = new Error('background port disconnected')
      authorityFailed = true
      settleAuthorityReady()
      for (const pending of handshakePending.values()) pending.reject(error)
      handshakePending.clear()
      if (controlPending) {
        controlPending.reject(error)
        controlPending = null
      }
      for (const pending of controlQueue) pending.reject(error)
      controlQueue.length = 0
      handleGlobalReset()
    })
  }
  /** @type {object|null} */
  let devicePicker = null
  let localStarted = false
  /**
   * Runs the full local bridge path: owns its endpoint, serves its own frame,
   * and connects the control port.
   * @returns {void}
   */
  function startLocal() {
    if (localStarted) return
    localStarted = true
    controlPort = browser.runtime.connect({ name: 'webhid-control' })
    wireControlPort(controlPort)
    if (fanoutCandidate && stackOtp) {
      controlPort.postMessage({ action: 'fanoutChildOffer', stackOtp })
    }
    wireStatusListener()
    wireBackgroundEventListener()
    wireStorageListener()
    wireAllowedDevicesListener()
    if (window === window.top) {
      devicePicker = new WebHidDevicePicker()
      document.documentElement.appendChild(devicePicker.host)
    }
    if (fanoutCandidate) {
      window.addEventListener('pagehide', invalidateBrokerPairOffer)
      window.addEventListener('unload', invalidateBrokerPairOffer)
    }
    acceptBootstrapPort(pagePort, window, authorityOrigin || '', browserFrameIdentity(window))
    ;(async () => {
      let resp = null
      try {
        resp = await sendHandshakeRequest()
      } catch (e) {
        logger.warn('handshake failed:', e.message)
      }
      await authorityReady
      if (!authorityOrigin || authorityFailed) {
        logger.warn('endpoint authority metadata unavailable')
        return
      }
      if (!http.isOk(resp && resp.s) || !resp.w) return
      wsPort = resp.w
      wsNonce = resp.N || null
      wtPort = resp.W || null
      wtCertHash = resp.H || null
      if (!wsNonce) {
        logger.warn(
          'handshake: daemon did not send ws_nonce (old version?); ' +
            'WS data plane will fall back to NM'
        )
      }
      await loadSettingsForOrigin(persistentOrigin || '')
      loadAllowedDeviceIds(persistentOrigin || '')
    })()
  }

  const PAGE_BLOCKED_ACTIONS = new Set([
    'pairDevice',
    'recordGrantGroup',
    'getGrantGroups',
    'getAllPairedDevices',
    'revokeDevice',
    'getDeviceCache',
    'getDeviceInfo',
    'showPicker',
    'pickerResult',
    'setFrameDelegation'
  ])

  const PAGE_ACTION_API_ACTIONS = new Set([
    'getPolicy',
    'getPairedDevices',
    'enumerate',
    'requestDevice',
    'open',
    'close',
    'sendReport',
    'receiveFeatureReport',
    'sendFeatureReport',
    'unpairDevice'
  ])
  let pageActionMarked = false

  /**
   * Marks the current tab as using WebHID so its page action becomes visible.
   * @returns {void}
   */
  function markPageActionUsed(origin = authorityOrigin) {
    if (pageActionMarked || settingsForOrigin(origin).hidePageAction) return
    pageActionMarked = true
    sendBackgroundRequest({ action: 'showPageAction' }).catch(() => {
      pageActionMarked = false
    })
  }

  /**
   * The exact browser document represented by this bridge instance.
   * @typedef {object} FrameContext
   * @property {string} key
   * @property {number} generation
   * @property {MessagePort} port
   * @property {Window} source
   * @property {string} origin
   * @property {string|null} persistentOrigin
   * @property {number|null} frameId
   * @property {string|null} documentId
   * @property {boolean} destroyed
   * @property {Map<string, string>} sessions
   */
  /** @type {Map<string, FrameContext>} context key -> adopted context */
  const frameContexts = new Map()
  /** @type {Map<MessagePort, FrameContext>} */
  const frameContextByPort = new Map()
  /** @type {Map<MessagePort, Map<string, string>>} */
  const clientSessions = new Map()
  /** @type {Map<MessagePort, string>} */
  const clientKeysByPort = new Map()
  /** @type {Map<string, MessagePort>} */
  const requestPortMap = new Map()
  let nextFrameGeneration = 0

  /**
   * Reads browser-authenticated identity for this exact document.
   * @param {Window} source
   * @returns {{frameId: number|null, documentId: string|null}}
   */
  function browserFrameIdentity(source) {
    let frameId = null
    let documentId = null
    try {
      const getFrameId = browser.runtime.getFrameId
      if (typeof getFrameId === 'function') frameId = getFrameId(source)
    } catch {
      void 0
    }
    try {
      const getDocumentId = browser.runtime.getDocumentId
      if (typeof getDocumentId === 'function') documentId = getDocumentId(source)
    } catch {
      void 0
    }
    return {
      frameId: Number.isInteger(frameId) && frameId >= 0 ? frameId : null,
      documentId: typeof documentId === 'string' && documentId ? documentId : null
    }
  }
  /**
   * Installs the request dispatch wiring on a page port.
   * @param {MessagePort} port
   * @param {Window} source
   * @returns {void}
   */
  function wirePagePort(port, source) {
    port.onmessage = (event) => {
      const data = event.data
      if (!data) return
      const handler = PAGE_PORT_HANDLERS[data.type]
      if (handler) {
        handler(data, port, event.ports || [])
        return
      }
      dispatchPortMessage(port, event, source)
    }
    if (typeof port.start === 'function') port.start()
  }
  /**
   * @param {MessagePort} port
   * @param {Window} source
   * @param {string} origin
   * @param {{frameId: number|null, documentId: string|null}} identity
   * @returns {FrameContext}
   */
  function acceptBootstrapPort(port, source, origin, identity) {
    const context = createFrameContext(port, source, origin, identity)
    wirePagePort(port, source)
    logger.debug('[bridge] exact page port established', context.key)
    return context
  }
  /**
   * @param {MessagePort} port
   * @param {Window} source
   * @param {string} origin
   * @param {{frameId: number|null, documentId: string|null}} identity
   * @returns {FrameContext}
   */
  function createFrameContext(port, source, origin, identity) {
    const context = {
      key: frameInstanceId + '/exact-' + ++nextFrameGeneration,
      generation: nextFrameGeneration,
      port,
      source,
      origin,
      frameId: identity.frameId,
      documentId: identity.documentId,
      persistentOrigin: null,
      destroyed: false,
      sessions: new Map()
    }
    frameContexts.set(context.key, context)
    frameContextByPort.set(port, context)
    clientSessions.set(port, context.sessions)
    clientKeysByPort.set(port, 'window')
    return context
  }

  /**
   * @param {MessagePort} port
   * @returns {FrameContext|null}
   */
  function frameContextForPort(port) {
    return (port && frameContextByPort.get(port)) || null
  }
  /**
   * Resolves this bridge's own frame context (never a fanout child's).
   * @returns {FrameContext|null}
   */
  function ownContext() {
    return frameContextForPort(pagePort)
  }
  /**
   * @param {FrameContext} context
   * @param {MessagePort} port
   * @returns {{port: MessagePort, clientKey: string, sessions: Map<string, string>}|null}
   */
  function clientForPort(context, port) {
    if (!context || !port || frameContextByPort.get(port) !== context) return null
    const clientKey = clientKeysByPort.get(port)
    const sessions = clientSessions.get(port)
    if (typeof clientKey !== 'string' || !sessions) return null
    return { port, clientKey, sessions }
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @returns {string}
   */
  function planeKey(context, deviceId) {
    return context.key + '\u0000' + deviceId
  }
  /**
   * @param {string} key
   * @returns {FrameContext|null}
   */
  function contextForPlaneKey(key) {
    const separator = key.indexOf('\u0000')
    if (separator < 0) return null
    return frameContexts.get(key.slice(0, separator)) || null
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  function deviceIdForPlaneKey(key) {
    const separator = key.indexOf('\u0000')
    if (separator < 0) return key
    const rest = key.slice(separator + 1)
    const clientSeparator = rest.indexOf('\u0000')
    return clientSeparator < 0 ? rest : rest.slice(0, clientSeparator)
  }
  /**
   * @param {string} key
   * @returns {string}
   */
  function clientKeyForPlaneKey(key) {
    const separator = key.indexOf('\u0000')
    if (separator < 0) return 'window'
    const rest = key.slice(separator + 1)
    const clientSeparator = rest.indexOf('\u0000')
    return clientSeparator < 0 ? 'window' : rest.slice(clientSeparator + 1)
  }

  /**
   * @param {FrameContext} context
   * @returns {Array<{port: MessagePort, sessions: Map<string, string>, clientKey: string}>}
   */
  function sessionsForContext(context) {
    const result = []
    for (const [port, owner] of frameContextByPort) {
      if (owner !== context) continue
      const sessions = clientSessions.get(port)
      const clientKey = clientKeysByPort.get(port)
      if (sessions && typeof clientKey === 'string') result.push({ port, sessions, clientKey })
    }
    return result
  }
  /**
   * @param {Map<string, string>} sessions
   * @returns {string|null}
   */
  function clientKeyForSessions(sessions) {
    for (const [port, ownerSessions] of clientSessions) {
      if (ownerSessions !== sessions) continue
      const clientKey = clientKeysByPort.get(port)
      return typeof clientKey === 'string' ? clientKey : null
    }
    return null
  }
  /**
   * @param {Map<string, string>} sessions
   * @returns {MessagePort|null}
   */
  function clientPortForSessions(sessions) {
    for (const [port, ownerSessions] of clientSessions) {
      if (ownerSessions === sessions) return port
    }
    return null
  }
  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} clientKey
   * @returns {string}
   */
  function planeKeyForClient(context, deviceId, clientKey) {
    return clientKey === 'window'
      ? planeKey(context, deviceId)
      : planeKey(context, deviceId) + '\u0000' + clientKey
  }
  /**
   * @param {FrameContext} context
   * @param {string} clientKey
   * @returns {object|null}
   */
  function clientForKey(context, clientKey) {
    for (const [port, owner] of frameContextByPort) {
      if (owner !== context || clientKeysByPort.get(port) !== clientKey) continue
      const sessions = clientSessions.get(port)
      if (sessions) return { port, sessions }
    }
    return null
  }

  function wireStatusListener() {
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
      const isStatusRequest =
        request.action === 'getDataPlaneStatus' ||
        request.action === 'getDataPlaneStatusForOrigin'
      if (
        request.action !== 'getOpenDeviceIds' &&
        !isStatusRequest &&
        request.action !== 'getFrameOrigins'
      )
        return false
      const trustedOriginRequest =
        request.action === 'getDataPlaneStatusForOrigin' &&
        sender?.id === browser.runtime.id &&
        typeof request.origin === 'string'
      const origin = trustedOriginRequest
        ? request.origin
        : persistentOrigin || authorityOrigin || window.location.origin
      const backgroundRequest = {
        action: trustedOriginRequest ? 'getDataPlaneStatusForOrigin' : request.action,
        ...(request.action === 'getDataPlaneStatus'
          ? {}
          : trustedOriginRequest
            ? { statusOrigin: origin }
            : { origin })
      }
      sendBackgroundRequest(backgroundRequest)
        .then(async (response) => {
          if (!isStatusRequest) {
            sendResponse(response)
            return
          }
          const settings = await loadSettingsForOrigin(origin)
          sendResponse({ ...response, defaultPlane: settings.dataPlane })
        })
        .catch(() => sendResponse({ ids: [], planes: [], origins: [] }))
      return true
    })
  }
  /**
   * @param {string} deviceId
   * @returns {object}
   */
  function ensureRuntimeDataPort(deviceId) {
    const key = String(deviceId)
    const existing = runtimeDataPorts.get(key)
    if (existing) return existing
    const port = browser.runtime.connect({ name: `webhid-data:${key}` })
    runtimeDataPorts.set(key, port)
    port.onMessage.addListener((message) => {
      if (message && message.reqId != null) {
        const pending = dataPending.get(message.reqId)
        if (!pending || String(pending.deviceId) !== key) return
        dataPending.delete(message.reqId)
        if (pending.kind === 'broker-page') {
          handleWorkerReportResponse(
            { ...pending.msg, reqId: pending.pageRequestId },
            pending.replyPort,
            message
          )
        } else {
          handleWorkerReportResponse(pending.msg, pending.port, message)
        }
        maybeDisconnectRuntimeDataPort(key)
        return
      }
      if (message && message.event) {
        forwardInputReportToAttachments(key, message.event)
        handleBackgroundEvent(message)
      }
    })
    port.onDisconnect.addListener(() => {
      if (runtimeDataPorts.get(key) !== port) return
      runtimeDataPorts.delete(key)
      for (const attachment of brokerAttachments.values()) {
        if (attachment.deviceId !== key || !attachment.dataPort) continue
        try {
          attachment.dataPort.postMessage({ type: 'disconnect' })
        } catch {
          void 0
        }
      }
      for (const [reqId, pending] of dataPending) {
        if (String(pending.deviceId) !== key) continue
        dataPending.delete(reqId)
        if (pending.kind === 'broker-page') {
          try {
            handleWorkerReportResponse(
              { ...pending.msg, reqId: pending.pageRequestId },
              pending.replyPort,
              { s: 503 }
            )
          } catch {
            void 0
          }
        } else {
          handleWorkerReportResponse(pending.msg, pending.port, { s: 503 })
        }
      }
    })
    return port
  }

  /**
   * @typedef {object} WorkerEntry
   * @property {'spawning'|'ready'|'closing'} state
   * @property {object|null} worker proxy, null while the control port has
   * not arrived yet. Never overload the map value to mean both "exists but
   * not ready" and "does not exist".
   * @property {number} generation
   */
  /** @type {Map<string, WorkerEntry>} */
  const workers = new Map()
  /** @type {Map<string, {generation: number, clientPort: MessagePort}>} */
  const workerGenerations = new Map()

  /**
   * Returns the ready worker proxy for a frame/device plane, or null while
   * the worker is still spawning (or absent).
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} [clientKey]
   * @returns {object|null}
   */
  function getWorker(context, deviceId, clientKey = 'window') {
    const entry = workers.get(planeKeyForClient(context, deviceId, clientKey))
    return entry ? entry.worker : null
  }
  /** @type {Set<string>} */
  const workerReadyDevices = new Set()
  /** @type {Map<string, object>} */
  const connectParams = new Map()
  /** @type {Map<string, string>} */
  const deviceTransports = new Map()
  /** @type {Set<string>} */
  const nmPlanes = new Set()
  /** @type {Map<string, Set<MessagePort>>} */
  const dataPorts = new Map()
  /** @type {Map<FrameContext, Set<MessagePort>>} */
  const workerPagePorts = new Map()
  /** @type {Map<string, object>} deviceId -> shared NM runtime port */
  const runtimeDataPorts = new Map()
  /** @type {Map<string, number>} */
  const readyGenerations = new Map()
  /** @type {Map<string, {generation: number, local: boolean, authoritative: boolean}>} */
  const planeReadiness = new Map()
  /** @type {Map<string, object>} */
  const pendingPlaneReady = new Map()
  /** @type {Map<number, {msg: object, port: MessagePort, key: string, deviceId: string}>} */
  const dataPending = new Map()
  let dataReqSeq = 0
  /** @returns {number} */
  function allocateDataReqId() {
    do {
      dataReqSeq = dataReqSeq >= Number.MAX_SAFE_INTEGER ? 1 : dataReqSeq + 1
    } while (dataPending.has(dataReqSeq))
    return dataReqSeq
  }
  /** @type {Map<string, number>} */
  const nmOpenAttempts = new Map()
  /** @param {string} key @returns {void} */
  function retainNmOpenAttempt(key) {
    nmOpenAttempts.set(key, (nmOpenAttempts.get(key) || 0) + 1)
  }
  /** @param {string} key @returns {void} */
  function releaseNmOpenAttempt(key) {
    const remaining = (nmOpenAttempts.get(key) || 0) - 1
    if (remaining > 0) nmOpenAttempts.set(key, remaining)
    else nmOpenAttempts.delete(key)
  }
  /**
   * @param {Iterable<string>} keys
   * @param {string} deviceId
   * @returns {boolean}
   */
  function hasDeviceKey(keys, deviceId) {
    for (const key of keys) {
      const separator = key.indexOf('\u0000')
      if (separator >= 0 && deviceIdForPlaneKey(key) === String(deviceId)) return true
    }
    return false
  }
  /**
   * @param {string} deviceId
   * @returns {void}
   */
  function maybeDisconnectRuntimeDataPort(deviceId) {
    const key = String(deviceId)
    if (hasDeviceKey(nmPlanes, key) || hasDeviceKey(nmOpenAttempts.keys(), key)) return
    for (const attachment of brokerAttachments.values()) {
      if (attachment.deviceId === key) return
    }
    for (const pending of dataPending.values()) {
      if (String(pending.deviceId) === key) return
    }
    const port = runtimeDataPorts.get(key)
    if (!port) return
    runtimeDataPorts.delete(key)
    try {
      port.disconnect()
    } catch (e) {
      logger.debug('runtime data port cleanup failed', e)
    }
  }
  /**
   * Disconnects a data Port created for an open that did not succeed.
   * @param {FrameContext} context
   * @param {string} deviceId
   * @returns {void}
   */
  function discardFailedOpenDataPort(context, deviceId, clientKey = 'window') {
    if (!context || deviceId == null) return
    const key = planeKeyForClient(context, deviceId, clientKey)
    const client = clientForKey(context, clientKey)
    const sessions = client ? client.sessions : context.sessions
    if (sessions.has(deviceId) || nmOpenAttempts.has(key)) return
    maybeDisconnectRuntimeDataPort(deviceId)
  }
  /** @type {number|null} */
  let wsPort = null
  /** @type {string|null} */
  let wsNonce = null
  /** @type {number|null} */
  let wtPort = null
  /** @type {string|null} */
  let wtCertHash = null
  /** @type {import("./types.js").SettingsStore} */
  const settings = createSettingsStore(webhid.import('GLOBAL_DEFAULTS'))
  /** @type {Map<string, import("./types.js").SettingsStore>} */
  const settingsByOrigin = new Map()
  /**
   * Maps authority identity to its persistent settings partition.
   * @param {string} origin
   * @returns {string}
   */
  function settingsScopeForOrigin(origin) {
    return origin === authorityOrigin ? persistentOrigin || '' : origin
  }
  function settingsForOrigin(origin) {
    const scope = settingsScopeForOrigin(origin)
    if (settingsByOrigin.has(scope)) return settingsByOrigin.get(scope)
    const store = createSettingsStore(webhid.import('GLOBAL_DEFAULTS'))
    settingsByOrigin.set(scope, store)
    installSettingsListeners(origin, store)
    return store
  }
  const settingsLoader = createScopedSettingsLoader(
    loadEffectiveSettings,
    settingsScopeForOrigin,
    settingsForOrigin,
    () => authorityOrigin,
    (error, scope) => logger.warn('load settings failed for', scope, ':', error.message)
  )
  /**
   * @param {string} origin
   * @returns {Promise<import("./types.js").SettingsStore>}
   */
  function loadSettingsForOrigin(origin) {
    return settingsLoader.load(origin)
  }
  /** @returns {void} */
  function settleAuthorityReady() {
    if (!resolveAuthorityReady) return
    resolveAuthorityReady()
    resolveAuthorityReady = null
  }
  /**
   * Applies browser-authenticated endpoint metadata to one frame context.
   * @param {FrameContext} context
   * @param {object} metadata
   * @returns {void}
   */
  function applyContextMetadata(context, metadata) {
    if (!context || !metadata || typeof metadata.origin !== 'string' || !metadata.origin) return
    if (context.origin && context.origin !== metadata.origin) return
    context.origin = metadata.origin
    context.persistentOrigin =
      typeof metadata.persistentOrigin === 'string' && metadata.persistentOrigin
        ? metadata.persistentOrigin
        : null
    if (Number.isInteger(metadata.frameId)) context.frameId = metadata.frameId
    if (typeof metadata.documentId === 'string' && metadata.documentId)
      context.documentId = metadata.documentId
  }
  /**
   * Applies browser-authenticated endpoint metadata before origin-sensitive work.
   * @param {object} metadata
   * @returns {void}
   */
  function initializeAuthorityMetadata(metadata) {
    if (!metadata || typeof metadata.origin !== 'string' || !metadata.origin) return
    if (authorityOrigin && authorityOrigin !== metadata.origin) return
    const nextPersistentOrigin =
      typeof metadata.persistentOrigin === 'string' && metadata.persistentOrigin
        ? metadata.persistentOrigin
        : null
    const firstInitialization = !authorityOrigin
    const previousPersistentOrigin = persistentOrigin
    const scopeChanged = persistentOrigin !== nextPersistentOrigin
    authorityOrigin = metadata.origin
    persistentOrigin = nextPersistentOrigin
    if (frameContexts.size > 0) {
      applyContextMetadata(ownContext(), metadata)
    }
    if (firstInitialization || scopeChanged) {
      settingsByOrigin.clear()
      settingsLoader.clear()
      settingsByOrigin.set(persistentOrigin || '', settings)
      installSettingsListeners(authorityOrigin, settings)
      if (scopeChanged) {
        allowedByOrigin.delete(previousPersistentOrigin || '')
        loadedOrigins.delete(previousPersistentOrigin || '')
        loadAllowedDeviceIds(persistentOrigin || '')
      }
    }
    if (scopeChanged && !firstInitialization) {
      const expectedScope = persistentOrigin
      const generation = ++scopeLoadGeneration
      void loadSettingsForOrigin(authorityOrigin).then((store) => {
        if (generation !== scopeLoadGeneration || persistentOrigin !== expectedScope) return
        for (const context of frameContexts.values()) {
          if (context.destroyed || context.persistentOrigin !== expectedScope) continue
          try {
            context.port.postMessage({
              type: 'persistentScopeChanged',
              settings: store.getAll()
            })
          } catch (e) {
            logger.debug('scope resync delivery failed', e)
          }
        }
      })
    }
    settleAuthorityReady()
  }
  /** @type {Map<string, number>} */
  const spawnGen = new Map()
  /**
   * Starts a new exact client/device plane generation.
   * @param {string} key
   * @returns {number}
   */
  function beginPlaneGeneration(key) {
    const generation = (spawnGen.get(key) || 0) + 1
    spawnGen.set(key, generation)
    readyGenerations.delete(key)
    planeReadiness.set(key, { generation, local: false, authoritative: false })
    const pending = pendingPlaneReady.get(key)
    if (pending && pending.generation !== generation) {
      clearTimeout(pending.timer)
      pendingPlaneReady.delete(key)
      pending.resolve({ ok: false, stale: true })
    }
    return generation
  }

  /**
   * @param {string} key
   * @param {number} generation
   * @param {'local'|'authoritative'} prerequisite
   * @returns {void}
   */
  function markPlanePrerequisite(key, generation, prerequisite) {
    if (spawnGen.get(key) !== generation) return
    let state = planeReadiness.get(key)
    if (!state || state.generation !== generation) {
      state = { generation, local: false, authoritative: false }
      planeReadiness.set(key, state)
    }
    state[prerequisite] = true
    if (!state.local || !state.authoritative) return
    const wasReady = readyGenerations.get(key) === generation
    readyGenerations.set(key, generation)
    if (!wasReady) notifyPlaneReady(key, generation)
    const pending = pendingPlaneReady.get(key)
    if (!pending || pending.generation !== generation) return
    clearTimeout(pending.timer)
    pendingPlaneReady.delete(key)
    pending.resolve({ ok: true })
  }

  /**
   * @param {string} key
   * @param {number} generation
   * @returns {void}
   */
  function markPlaneReady(key, generation) {
    markPlanePrerequisite(key, generation, 'local')
    markPlanePrerequisite(key, generation, 'authoritative')
  }

  /**
   * @param {string} key
   * @param {number} generation
   * @returns {void}
   */
  function markPlaneLocalReady(key, generation) {
    markPlanePrerequisite(key, generation, 'local')
  }

  /**
   * @param {string} key
   * @param {number} generation
   * @returns {void}
   */
  function markPlaneAuthoritativeReady(key, generation) {
    markPlanePrerequisite(key, generation, 'authoritative')
  }
  /**
   * @param {string} key
   * @param {number} generation
   * @returns {void}
   */
  function notifyPlaneReady(key, generation) {
    if (spawnGen.get(key) !== generation) return
    const context = contextForPlaneKey(key)
    if (!context) return
    const client = clientForKey(context, clientKeyForPlaneKey(key))
    if (!client) return
    notifyBackgroundPlaneStatus(key, generation, true)
    try {
      client.port.postMessage({
        type: 'dataPlaneReady',
        deviceId: deviceIdForPlaneKey(key),
        generation
      })
    } catch (e) {
      logger.debug('data plane ready notification failed', e)
    }
  }
  /**
   * Publishes exact session plane state for background aggregation.
   * @param {string} key
   * @param {number} generation
   * @param {boolean} ready
   * @param {boolean} [available]
   * @returns {void}
   */
  function notifyBackgroundPlaneStatus(key, generation, ready, available = true) {
    const context = contextForPlaneKey(key)
    if (!context) return
    const clientKey = clientKeyForPlaneKey(key)
    const client = clientForKey(context, clientKey)
    const deviceId = Number(deviceIdForPlaneKey(key))
    const token = client?.sessions.get(deviceId)
    if (!token) return
    const plane = nmPlanes.has(key)
      ? 'nm'
      : inPageDevices.has(key)
        ? 'wt'
        : deviceTransports.get(key) || settingsForOrigin(context.origin).dataPlane
    const mode = plane === 'nm' ? null : inPageDevices.has(key) ? 'inpage' : 'worker'
    sendBackgroundRequest(
      {
        action: 'setDataPlaneStatus',
        deviceId,
        sessionToken: token,
        clientKey,
        plane: available ? plane : null,
        mode,
        generation,
        ready
      },
      context
    ).catch((e) => logger.debug('data plane status update failed', e))
  }

  /**
   * @param {string} key
   * @param {number} generation
   * @param {string} reason
   * @returns {void}
   */
  function notifyPlaneUnavailable(key, generation, reason) {
    if (spawnGen.get(key) !== generation) return
    const context = contextForPlaneKey(key)
    if (!context) return
    const client = clientForKey(context, clientKeyForPlaneKey(key))
    if (!client) return
    notifyBackgroundPlaneStatus(key, generation, false, true)
    try {
      client.port.postMessage({
        type: 'dataPlaneUnavailable',
        deviceId: deviceIdForPlaneKey(key),
        generation,
        reason
      })
    } catch (e) {
      logger.debug('data plane unavailable notification failed', e)
    }
  }
  /** @type {Map<string, Set<string>>} origin -> allowed device ids */
  const allowedByOrigin = new Map()
  /** @type {Set<string>} origins whose allowed set is loaded. */
  const loadedOrigins = new Set()
  /** @type {Map<string, Promise<void>>} */
  const allowedLoads = new Map()
  const allowedDeviceIdsQueue = []
  /**
   * Returns whether an origin may own persistent HID grant state.
   * @param {string} origin
   * @returns {boolean}
   */
  function isPersistentGrantOrigin(origin) {
    return typeof origin === 'string' && origin.length > 0 && origin !== 'null'
  }

  /**
   * Resolves all queued isDeviceAllowed promises for `origin`.
   * @param {string} origin
   * @returns {void}
   */
  function flushAllowedDeviceIdsQueue(origin) {
    const allowed = allowedByOrigin.get(origin) || new Set()
    for (let i = allowedDeviceIdsQueue.length - 1; i >= 0; i--) {
      if (allowedDeviceIdsQueue[i].origin === origin) {
        const { deviceId, resolve } = allowedDeviceIdsQueue[i]
        allowedDeviceIdsQueue.splice(i, 1)
        resolve(allowed.has(String(deviceId)))
      }
    }
  }
  /**
   * Checks whether a device is in the allowed set for `origin`, loading that
   * origin lazily when necessary.
   * @param {string} deviceId
   * @param {string} origin
   * @returns {Promise<boolean>}
   */
  function isDeviceAllowed(deviceId, origin) {
    if (!origin) return Promise.resolve(false)
    if (!isPersistentGrantOrigin(origin)) return Promise.resolve(false)
    if (loadedOrigins.has(origin)) {
      const allowed = allowedByOrigin.get(origin) || new Set()
      if (allowed.has(String(deviceId))) return Promise.resolve(true)
      loadedOrigins.delete(origin)
      allowedByOrigin.delete(origin)
    }
    const pending = new Promise((resolve) => {
      allowedDeviceIdsQueue.push({ origin, deviceId, resolve })
    })
    if (!allowedLoads.has(origin)) {
      const load = loadAllowedDeviceIds(origin).finally(() => allowedLoads.delete(origin))
      allowedLoads.set(origin, load)
    }
    return pending
  }

  /**
   * Loads the allowed device IDs for `origin` from the background.
   * @param {string} origin
   * @returns {Promise<void>}
   */
  async function loadAllowedDeviceIds(origin) {
    if (!isPersistentGrantOrigin(origin)) {
      allowedByOrigin.set(origin, new Set())
      loadedOrigins.add(origin)
      flushAllowedDeviceIdsQueue(origin)
      return
    }
    try {
      const resp = await sendBackgroundRequest({
        action: 'getAllowedDevices',
        origin
      })
      if (resp && Array.isArray(resp.deviceIds)) {
        allowedByOrigin.set(
          origin,
          new Set(resp.deviceIds.map((deviceId) => String(deviceId)))
        )
      } else {
        allowedByOrigin.set(origin, new Set())
      }
    } catch (e) {
      logger.warn('loadAllowedDeviceIds failed for', origin, ':', e.message)
      allowedByOrigin.set(origin, new Set())
    }
    loadedOrigins.add(origin)
    flushAllowedDeviceIdsQueue(origin)
  }

  /**
   * @param {string} sessionToken
   * @returns {Promise<string|null>}
   */
  async function computeWsAuthHash(sessionToken) {
    if (!wsNonce || !sessionToken) return null
    const data = new TextEncoder().encode(sessionToken + wsNonce)
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {{keepPort?: boolean, clientKey?: string, clientPort?: MessagePort, notifyUnavailable?: boolean, unavailableReason?: string}} [opts]
   * @returns {Promise<void>}
   */
  async function despawnDataPlane(
    context,
    deviceId,
    {
      keepPort = false,
      clientKey = 'window',
      clientPort,
      notifyUnavailable = false,
      unavailableReason = 'data plane unavailable'
    } = {}
  ) {
    const key = planeKeyForClient(context, deviceId, clientKey)
    const currentGeneration = spawnGen.get(key)
    if (brokerAttachments.has(key)) await detachNmBroker(context, deviceId, clientKey)
    if (notifyUnavailable && currentGeneration != null)
      notifyPlaneUnavailable(key, currentGeneration, unavailableReason)
    beginPlaneGeneration(key)
    if (inPageDevices.has(key)) {
      inPageDevices.delete(key)
      const targetPort = clientPort || clientForKey(context, clientKey)?.port || context.port
      if (targetPort)
        targetPort.postMessage({
          type: 'dataPlaneDisconnect',
          deviceId,
          generation: currentGeneration
        })
    }
    const entry = workers.get(key)
    const record = workerGenerations.get(key)
    const workerGeneration = entry ? entry.generation : record && record.generation
    workers.delete(key)
    workerReadyDevices.delete(key)
    workerGenerations.delete(key)
    if (entry && entry.worker) {
      try {
        entry.worker.terminate()
      } catch (e) {
        logger.debug('worker proxy cleanup failed', e)
      }
    }
    if (workerGeneration != null) {
      const targetPort =
        clientPort ||
        (record && record.clientPort) ||
        clientForKey(context, clientKey)?.port ||
        context.port
      if (targetPort) {
        await requestMainWorldSpawn(
          context,
          { mode: 'terminate', deviceId, generation: workerGeneration },
          targetPort
        ).catch((e) => logger.debug('main worker cleanup failed', e))
      }
    }
    if (!keepPort) {
      const ports = dataPorts.get(key)
      if (ports) {
        for (const port of ports) {
          try {
            port.onmessage = null
            port.close()
          } catch (e) {
            logger.debug('port cleanup failed', e)
          }
        }
      }
      dataPorts.delete(key)
    }
    for (const [reqId, pending] of dataPending) {
      if (pending.key !== key) continue
      dataPending.delete(reqId)
      if (pending.kind === 'broker-page') {
        try {
          pending.replyPort.postMessage({ reqId: pending.pageRequestId, s: 503 })
        } catch {
          void 0
        }
      } else {
        handleWorkerReportResponse(pending.msg, pending.port, { s: 503 })
      }
    }
    for (const [reqId, pending] of pendingPlaneSpawns) {
      if (pending.key !== key) continue
      clearTimeout(pending.timer)
      pendingPlaneSpawns.delete(reqId)
      pending.resolve(false)
    }
    connectParams.delete(key)
    deviceTransports.delete(key)
    nmPlanes.delete(key)
    planeReadiness.delete(key)
    readyGenerations.delete(key)
    maybeDisconnectRuntimeDataPort(deviceId)
  }
  /** @type {Map<string, string>} */
  const cachedSpawnModes = new Map()

  /**
   * @param {FrameContext} context
   * @returns {Promise<string>}
   */
  async function resolveSpawnMode(context) {
    const origin = context.origin
    const originSettings = await loadSettingsForOrigin(origin)
    const cached = cachedSpawnModes.get(origin)
    if (cached) return cached
    if (isChromium) {
      cachedSpawnModes.set(origin, 'blob')
      return 'blob'
    }
    let mode = originSettings.workerSpawnMode
    const settingsScope = settingsScopeForOrigin(origin)
    if (settingsScope) {
      const site = await loadSiteSettings(settingsScope)
      if (site.workerSpawnMode !== undefined) mode = site.workerSpawnMode
    }
    if (mode === 'blob') {
      cachedSpawnModes.set(origin, 'blob')
      return 'blob'
    }
    try {
      const info = await sendBackgroundRequest({
        action: 'getCspInfo',
        origin
      })
      if (info && info.needsBlobFallback) {
        if (mode === 'shadow') {
          cachedSpawnModes.set(origin, 'nm')
          return 'nm'
        }
        const mv2 = browser.runtime.getManifest().manifest_version === 2
        if (!mv2 && info.headerShadowBlocked) {
          cachedSpawnModes.set(origin, 'nm')
          return 'nm'
        }
        cachedSpawnModes.set(origin, 'blob')
        return 'blob'
      }
    } catch (e) {
      logger.debug('getCspInfo failed for', origin, e)
    }
    cachedSpawnModes.set(origin, 'shadow')
    return 'shadow'
  }

  /**
   * @returns {Promise<string>}
   */
  async function fetchWorkerBundle() {
    const resp = await sendBackgroundRequest({ action: 'getWorkerBundle' })
    if (!resp || !resp.text) throw new Error('worker bundle fetch failed')
    return resp.text
  }

  /** @type {Map<string, object>} */
  const pendingSpawns = new Map()
  let spawnReqSeq = 0
  /** @type {Set<string>} */
  const inPageDevices = new Set()
  /** @type {Map<string, {resolve: Function, timer: ReturnType<typeof setTimeout>, key: string, generation: number}>} */
  const pendingPlaneSpawns = new Map()
  let planeReqSeq = 0

  /**
   * @param {FrameContext} context
   * @param {object} payload
   * @param {MessagePort} [clientPort]
   * @returns {Promise<object>}
   */
  function requestMainWorldSpawn(context, payload, clientPort = context.port) {
    const port = clientPort
    if (!port) return Promise.reject(new Error('no page port for worker spawn'))
    return new Promise((resolve, reject) => {
      const id = 'spawn:' + ++spawnReqSeq
      const timer = setTimeout(() => {
        pendingSpawns.delete(id)
        reject(new Error('worker spawn request timeout'))
      }, 10000)
      pendingSpawns.set(id, { resolve, reject, timer, context })
      port.postMessage({ type: 'spawnWorkerRequest', id, payload })
    })
  }

  /**
   * @param {object} port
   * @returns {object}
   */
  function makeWorkerProxy(port) {
    const proxy = {}
    let onerrorHandler = null
    proxy.postMessage = (msg, transfer) => port.postMessage(msg, transfer)
    proxy.terminate = () => port.postMessage({ type: 'terminate' })
    Object.defineProperty(proxy, 'onmessage', {
      set(fn) {
        port.onmessage = (event) => {
          if (event.data && event.data.type === 'worker-error') {
            if (onerrorHandler) onerrorHandler({ message: event.data.message })
          } else if (fn) {
            fn(event)
          }
        }
      },
      configurable: true
    })
    Object.defineProperty(proxy, 'onerror', {
      set(fn) {
        onerrorHandler = fn
      },
      configurable: true
    })
    return proxy
  }

  /**
   * Asks the page to spawn a main-world worker in the given mode.
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} mode
   * @param {MessagePort} [clientPort]
   * @param {number} generation
   * @returns {Promise<object>}
   */
  async function attemptWorkerSpawn(context, deviceId, mode, clientPort, generation) {
    if (mode === 'blob') {
      return requestMainWorldSpawn(
        context,
        {
          mode: 'blob',
          bundleText: await fetchWorkerBundle(),
          deviceId,
          generation
        },
        clientPort
      )
    }
    return requestMainWorldSpawn(context, { mode: 'shadow', deviceId, generation }, clientPort)
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {number} wsPort
   * @param {object} [opts]
   * @param {number} gen
   * @returns {Promise<boolean>}
   */
  async function spawnWorker(context, deviceId, sessionToken, wsPort, opts = {}, gen) {
    const clientKey = opts.clientKey || 'window'
    const key = planeKeyForClient(context, deviceId, clientKey)
    const existing = workers.get(key)
    const existingRecord = workerGenerations.get(key)
    const existingGeneration = existing ? existing.generation : existingRecord?.generation
    if (existing && existing.generation === gen) return true
    if (existing || existingRecord) {
      workers.delete(key)
      workerReadyDevices.delete(key)
      workerGenerations.delete(key)
      if (existing?.worker) {
        try {
          existing.worker.terminate()
        } catch (e) {
          logger.debug('stale worker proxy cleanup failed', e)
        }
      }
      connectParams.delete(key)
      const targetPort =
        opts.clientPort ||
        existingRecord?.clientPort ||
        clientForKey(context, clientKey)?.port ||
        context.port
      if (targetPort && existingGeneration != null) {
        await requestMainWorldSpawn(
          context,
          { mode: 'terminate', deviceId, generation: existingGeneration },
          targetPort
        ).catch((e) => logger.debug('stale main worker cleanup failed', e))
      }
    }
    const wsAuthHash = await computeWsAuthHash(sessionToken)
    if (!wsAuthHash) {
      logger.warn(
        'cannot derive WS auth hash for',
        deviceId,
        '; wsNonce missing, falling back to NM'
      )
      return false
    }
    let spawnResult = null
    const spawnMode = await resolveSpawnMode(context)
    if (spawnMode === 'nm') return false
    try {
      spawnResult = await attemptWorkerSpawn(
        context,
        deviceId,
        spawnMode,
        opts.clientPort || context.port,
        gen
      )
    } catch (e) {
      logger.warn('worker spawn failed for', deviceId, '(', spawnMode, '):', e.message)
    }
    if (!spawnResult || !spawnResult.ok) return false
    if (spawnGen.get(key) !== gen) {
      requestMainWorldSpawn(
        context,
        { mode: 'terminate', deviceId, generation: gen },
        opts.clientPort || context.port
      ).catch(() => {})
      return false
    }
    workers.set(key, { state: 'spawning', worker: null, generation: gen })
    deviceTransports.set(key, opts.wtPort != null ? 'wt' : 'ws')
    connectParams.set(key, {
      transport: opts.wtPort != null ? 'wt' : 'ws',
      wsPort: opts.wtPort != null ? undefined : wsPort,
      wtPort: opts.wtPort != null ? opts.wtPort : undefined,
      wtCertHash: opts.wtPort != null ? opts.wtCertHash : undefined,
      token: wsAuthHash,
      reportSize: opts.reportSize || 64,
      logLevel: logger.level
    })
    workerGenerations.set(key, {
      generation: gen,
      clientPort: opts.clientPort || context.port
    })
    return true
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {object} opts
   * @returns {Promise<boolean>}
   */
  async function spawnInPageDataPlane(context, deviceId, sessionToken, opts) {
    const wsAuthHash = await computeWsAuthHash(sessionToken)
    if (!wsAuthHash || !context.port) return false
    const key = planeKeyForClient(context, deviceId, opts.clientKey || 'window')
    const clientPort = opts.clientPort || context.port
    return new Promise((resolve) => {
      const id = 'plane:' + ++planeReqSeq
      const timer = setTimeout(() => {
        pendingPlaneSpawns.delete(id)
        inPageDevices.delete(key)
        resolve(false)
      }, 10000)
      pendingPlaneSpawns.set(id, { resolve, timer, key, generation: opts.generation })
      inPageDevices.add(key)
      clientPort.postMessage({
        generation: opts.generation,
        type: 'dataPlaneConnect',
        id,
        deviceId,
        payload: {
          transport: 'wt',
          wtPort: opts.wtPort,
          wtCertHash: opts.wtCertHash,
          token: wsAuthHash,
          reportSize: opts.reportSize || 64,
          logLevel: logger.level
        }
      })
    })
  }

  /**
   * Switches one client/device plane to the shared NM runtime transport.
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {string} clientKey
   * @param {number} generation
   * @param {{rewire?: boolean, retire?: boolean, clientPort?: MessagePort}} [opts]
   * @returns {Promise<number|null>}
   */
  async function fallbackToNm(
    context,
    deviceId,
    sessionToken,
    clientKey,
    generation,
    { rewire = false, retire = false, clientPort } = {}
  ) {
    const key = planeKeyForClient(context, deviceId, clientKey)
    if (spawnGen.get(key) !== generation) return null
    if (retire) {
      await despawnDataPlane(context, deviceId, {
        clientKey,
        clientPort,
        notifyUnavailable: true,
        unavailableReason: 'data plane recovery'
      })
      generation = spawnGen.get(key)
    }
    if (
      context.destroyed ||
      frameContexts.get(context.key) !== context ||
      spawnGen.get(key) !== generation
    )
      return null
    const brokered = fanoutCandidate && brokerPairReady
    if (!brokered) ensureRuntimeDataPort(deviceId)
    let response
    try {
      response = await sendBackgroundRequest(
        {
          action: 'setDataPlane',
          deviceId,
          mode: 'nm',
          sessionToken,
          frameKey: context.key,
          origin: context.origin,
          clientKey
        },
        context
      )
    } catch (e) {
      logger.debug('setDataPlane NM fallback failed', e)
    }
    if (!response || !http.isOk(response.s)) {
      if (spawnGen.get(key) === generation) {
        await despawnDataPlane(context, deviceId, { clientKey, clientPort })
        notifyPlaneUnavailable(key, spawnGen.get(key), 'NM fallback rejected')
      }
      return null
    }
    if (
      context.destroyed ||
      frameContexts.get(context.key) !== context ||
      spawnGen.get(key) !== generation
    ) {
      if (spawnGen.get(key) === generation)
        await despawnDataPlane(context, deviceId, { clientKey, clientPort })
      return null
    }
    if (brokered) {
      const attached = await attachNmBroker(context, deviceId, sessionToken, clientKey, generation)
      if (!attached) {
        await despawnDataPlane(context, deviceId, { clientKey, clientPort })
        notifyPlaneUnavailable(key, generation, 'NM broker attach failed')
        return null
      }
    }
    nmPlanes.add(key)
    deviceTransports.delete(key)
    markPlaneAuthoritativeReady(key, generation)
    if (rewire && !brokered) {
      const targetPort = clientPort || clientForKey(context, clientKey)?.port || context.port
      if (!targetPort) {
        if (spawnGen.get(key) === generation) {
          await despawnDataPlane(context, deviceId, { clientKey, clientPort })
          notifyPlaneUnavailable(key, spawnGen.get(key), 'NM fallback wiring unavailable')
        }
        return null
      }
      targetPort.postMessage({
        type: 'wireWorkerPort',
        deviceId,
        generation
      })
    }
    return generation
  }
  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {number} wsPort
   * @param {object} [opts]
   * @returns {Promise<number|null>}
   */
  async function spawnDataPlane(context, deviceId, sessionToken, wsPort, opts = {}) {
    const clientKey = opts.clientKey || 'window'
    const key = planeKeyForClient(context, deviceId, clientKey)
    const gen = beginPlaneGeneration(key)
    const spawnOpts = { ...opts, clientKey, generation: gen }
    let ok
    if (settingsForOrigin(context.origin).useWorker === false && opts.wtPort != null) {
      ok = await spawnInPageDataPlane(context, deviceId, sessionToken, spawnOpts)
    } else {
      ok = await spawnWorker(context, deviceId, sessionToken, wsPort, spawnOpts, gen)
      if (ok && opts.rewire) {
        ;(opts.clientPort || context.port).postMessage({
          type: 'wireWorkerPort',
          deviceId,
          generation: gen
        })
      }
    }
    if (!ok && spawnGen.get(key) === gen) {
      logger.warn('data plane spawn failed for', deviceId, '; falling back to NM')
      const fallbackGeneration = await fallbackToNm(
        context,
        deviceId,
        sessionToken,
        clientKey,
        gen,
        {
          rewire: !!opts.rewire,
          clientPort: opts.clientPort
        }
      )
      return fallbackGeneration
    }
    return gen
  }
  /**
   * Waits for the exact generation of a client/device plane, falling back to
   * NM when the requested worker generation cannot become ready.
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} clientKey
   * @param {number} generation
   * @param {string} sessionToken
   * @returns {Promise<object>}
   */
  function waitForPlaneReady(context, deviceId, clientKey, generation, sessionToken) {
    const key = planeKeyForClient(context, deviceId, clientKey)
    if (context.destroyed || frameContexts.get(context.key) !== context)
      return Promise.resolve({ ok: false, destroyed: true })
    if (spawnGen.get(key) !== generation) return Promise.resolve({ ok: false, stale: true })
    if (readyGenerations.get(key) === generation) return Promise.resolve({ ok: true })
    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        const pending = pendingPlaneReady.get(key)
        if (!pending || pending.generation !== generation) return
        pendingPlaneReady.delete(key)
        if (spawnGen.get(key) !== generation) {
          resolve({ ok: false, stale: true })
          return
        }
        const fallbackGeneration = await fallbackToNm(
          context,
          deviceId,
          sessionToken,
          clientKey,
          generation,
          { rewire: true, retire: true }
        )
        if (fallbackGeneration == null) {
          resolve({ ok: false, error: 'data plane unavailable' })
          return
        }
        resolve(
          await waitForPlaneReady(context, deviceId, clientKey, fallbackGeneration, sessionToken)
        )
      }, 10000)
      pendingPlaneReady.set(key, { generation, resolve, timer })
    })
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} _ports
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handlePlaneReadyRequest(data, _ports, requestPort) {
    const context = frameContextForPort(requestPort)
    const client = context && clientForPort(context, requestPort)
    const sessions = client && client.sessions
    const clientKey = client && client.clientKey
    const generation = data.payload && data.payload.generation
    const deviceId = data.payload && data.payload.deviceId
    const token = sessions && deviceId != null ? sessions.get(deviceId) : null
    const result =
      context && client && deviceId != null && typeof generation === 'number' && token
        ? await waitForPlaneReady(context, deviceId, clientKey, generation, token)
        : { ok: false, error: 'data plane request is not owned by this client' }
    replyToPage({ type: 'response', id: data.id, result })
  }

  /**
   * @param {object} msg
   * @param {ArrayBuffer[]} [transfer]
   * @returns {void}
   */
  function replyToPage(msg, transfer) {
    if (msg != null && msg.id != null) {
      const port = requestPortMap.get(msg.id)
      if (port) {
        requestPortMap.delete(msg.id)
        port.postMessage(msg, transfer)
        return
      }
    }
    if (msg != null && (msg.type === 'event' || msg.type === 'settings')) {
      for (const context of frameContexts.values()) {
        try {
          context.port.postMessage(msg, transfer)
        } catch (e) {
          logger.debug('page event delivery failed', e)
        }
      }
    }
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleSpawnWorkerResponse(data) {
    const pending = pendingSpawns.get(data.id)
    if (pending) {
      clearTimeout(pending.timer)
      pendingSpawns.delete(data.id)
      pending.resolve(data.result || {})
    }
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handlePlaneResponse(data) {
    const pending = pendingPlaneSpawns.get(data.id)
    if (pending) {
      clearTimeout(pending.timer)
      pendingPlaneSpawns.delete(data.id)
      const ok = !!(data.result && data.result.ok)
      if (ok) markPlaneReady(pending.key, pending.generation)
      pending.resolve(ok)
    }
  }

  /**
   * @param {object} data
   * @param {MessagePort} port
   * @returns {void}
   */
  function handleDataPlaneEvent(data, port) {
    const context = frameContextForPort(port)
    const client = context && clientForPort(context, port)
    if (!context || !client) return
    const deviceId = data.deviceId
    const clientKey = client.clientKey
    const key = planeKeyForClient(context, deviceId, clientKey)
    const generation = data.generation
    if (typeof generation !== 'number' || spawnGen.get(key) !== generation) return
    const ev = data.event || {}
    if (ev.type === 'closed' || ev.type === 'auth-failed') {
      inPageDevices.delete(key)
      handleWorkerErrorEvent(
        {
          deviceId,
          generation,
          message:
            ev.type === 'auth-failed' ? 'in-page transport auth failed' : 'in-page transport closed'
        },
        port,
        generation
      ).catch((e) => logger.debug('in-page transport recovery failed', e))
    }
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} token
   * @param {string} clientKey
   * @param {MessagePort} clientPort
   * @param {number} failedGeneration
   * @returns {Promise<number|null>}
   */
  async function recoverDataPlane(
    context,
    deviceId,
    token,
    clientKey,
    clientPort,
    failedGeneration
  ) {
    const key = planeKeyForClient(context, deviceId, clientKey)
    if (spawnGen.get(key) !== failedGeneration) return null
    await despawnDataPlane(context, deviceId, {
      clientKey,
      clientPort,
      notifyUnavailable: true,
      unavailableReason: 'data plane recovery'
    })
    const generation = spawnGen.get(key)
    if (context.destroyed || frameContexts.get(context.key) !== context) return null
    const originSettings = settingsForOrigin(context.origin)
    if (originSettings.dataPlane === 'nm') {
      return fallbackToNm(context, deviceId, token, clientKey, generation, {
        rewire: true,
        clientPort
      })
    }
    if (originSettings.dataPlane === 'wt' && wtPort != null) {
      return spawnDataPlane(context, deviceId, token, null, {
        wtPort,
        wtCertHash,
        clientKey,
        clientPort,
        rewire: true
      })
    }
    if (originSettings.dataPlane === 'ws' || originSettings.dataPlane === 'wt') {
      return spawnDataPlane(context, deviceId, token, wsPort, {
        clientKey,
        clientPort,
        rewire: true
      })
    }
    return fallbackToNm(context, deviceId, token, clientKey, generation, {
      rewire: true,
      clientPort
    })
  }

  /**
   * @param {object} data
   * @param {MessagePort} port
   * @returns {Promise<void>}
   */
  async function handleWorkerErrorEvent(data, port, generation) {
    const context = frameContextForPort(port)
    const client = context && clientForPort(context, port)
    if (!context || !client) return
    const deviceId = data.deviceId
    const clientKey = client.clientKey
    const key = planeKeyForClient(context, deviceId, clientKey)
    const currentGeneration = spawnGen.get(key)
    const signalGeneration = generation != null ? generation : data.generation
    if (signalGeneration != null && currentGeneration !== signalGeneration) return
    const sessions = client.sessions
    logger.warn('worker errored for', deviceId, ':', data.message)
    const token = sessions.get(deviceId) || null
    if (!token) {
      await despawnDataPlane(context, deviceId, { clientKey, clientPort: port })
      return
    }
    await recoverDataPlane(context, deviceId, token, clientKey, port, currentGeneration)
  }

  /**
   * Handles a lifecycle signal authenticated by the receiving page port.
   * @param {object} data
   * @param {MessagePort} port
   * @returns {void}
   */
  function handleFrameDestroyedMessage(data, port) {
    const context = frameContextForPort(port)
    if (context) destroyFrameContext(context).catch((e) => logger.debug('frame cleanup failed', e))
  }
  /**
   * @param {MessagePort} port
   * @returns {void}
   */
  function closeBrokerCandidate(port) {
    if (!port) return
    try {
      port.close()
    } catch {
      void 0
    }
  }

  function invalidateBrokerPairOffer() {
    brokerPairOffer = null
    stackOtp = null
    if (brokerPairTimer) {
      clearTimeout(brokerPairTimer)
      brokerPairTimer = null
    }
    if (brokerPairHandler && pendingBrokerPort) {
      pendingBrokerPort.removeEventListener('message', brokerPairHandler)
    }
    brokerPairHandler = null
    if (pendingBrokerPort) closeBrokerCandidate(pendingBrokerPort)
    pendingBrokerPort = null
  }

  /**
   * @param {object} message
   * @returns {void}
   */
  function handleFanoutPairOffer(message) {
    if (!fanoutCandidate || brokerPairReady) return
    const identity = browserFrameIdentity(window)
    if (
      !identity ||
      !Number.isInteger(identity.frameId) ||
      identity.frameId <= 0 ||
      typeof identity.documentId !== 'string' ||
      !identity.documentId ||
      message.frameId !== identity.frameId ||
      message.documentId !== identity.documentId ||
      message.origin !== window.location.origin ||
      typeof message.authOtp !== 'string' ||
      typeof message.ackOtp !== 'string'
    )
      return
    if (brokerPairOffer || brokerPairTimer || pendingBrokerPort) {
      invalidateBrokerPairOffer()
      return
    }
    if (!stackOtp) return
    brokerPairOffer = {
      stackOtp,
      authOtp: message.authOtp,
      ackOtp: message.ackOtp,
      frameId: identity.frameId,
      documentId: identity.documentId,
      origin: message.origin
    }
  }

  /**
   * @param {MessagePort} port
   * @param {{stackOtp: string, authOtp: string, ackOtp: string}} offer
   * @returns {void}
   */
  function startBrokerPairing(port, offer) {
    if (!fanoutCandidate || brokerPort || !port || !offer || brokerPairHandler) {
      closeBrokerCandidate(port)
      return
    }
    const handler = (event) => {
      const data = event.data
      if (!data || data.type !== 'fanoutAuthB' || data.otp !== offer.ackOtp) return
      if (brokerPairTimer) {
        clearTimeout(brokerPairTimer)
        brokerPairTimer = null
      }
      port.removeEventListener('message', handler)
      brokerPairHandler = null
      pendingBrokerPort = null
      brokerPairOffer = null
      stackOtp = null
      brokerPort = port
      brokerPairReady = true
      port.addEventListener('message', (brokerEvent) =>
        handleChildBrokerMessage(brokerEvent.data, brokerEvent)
      )
      logger.debug('[bridge] private NM broker paired')
    }
    brokerPairHandler = handler
    pendingBrokerPort = port
    try {
      port.addEventListener('message', handler)
      port.start()
      port.postMessage({ type: 'fanoutAuthA', otp: offer.authOtp })
    } catch {
      invalidateBrokerPairOffer()
      return
    }
    brokerPairTimer = setTimeout(() => {
      if (pendingBrokerPort !== port || brokerPairHandler !== handler) return
      invalidateBrokerPairOffer()
    }, 5000)
  }

  /**
   * @param {object} _data
   * @param {MessagePort} requestPort
   * @param {MessagePort[]} ports
   * @returns {void}
   */
  function handleBrokerCandidate(_data, requestPort, ports) {
    logger.debug('pair candidate received')
    const candidate = ports && ports[0]
    const offer = brokerPairOffer
    if (!fanoutCandidate || requestPort !== pagePort || !candidate || !offer) {
      closeBrokerCandidate(candidate)
      return
    }
    startBrokerPairing(candidate, offer)
  }

  /**
   * @param {object} message
   * @param {MessagePort} requestPort
   * @returns {void}
   */
  function handleChildBrokerMessage(message, requestPort) {
    if (
      message.requestId &&
      (message.type === 'nmAttachResult' || message.type === 'nmDetachResult')
    ) {
      const pending = brokerPending.get(message.requestId)
      if (!pending) return
      brokerPending.delete(message.requestId)
      pending.resolve({
        result: message.result || { ok: message.ok === true, s: message.s },
        ports: requestPort && requestPort.ports ? requestPort.ports : []
      })
      return
    }
    if (message.type === 'nmPlaneUnavailable') {
      const key = message.key
      const attachment = brokerAttachments.get(key)
      if (attachment) {
        brokerAttachments.delete(key)
        try {
          pagePort.postMessage({
            type: 'brokerDataPortUnavailable',
            deviceId: attachment.deviceId,
            generation: attachment.generation
          })
        } catch {
          void 0
        }
      }
      brokerAttachedKeys.delete(key)
      for (const [requestId, pending] of brokerPending) {
        if (pending.key !== key) continue
        brokerPending.delete(requestId)
        pending.resolve({ s: 503 })
      }
    }
    return
  }
  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} clientKey
   * @returns {string}
   */
  function brokerAttachmentKey(context, deviceId, clientKey) {
    return planeKeyForClient(context, deviceId, clientKey)
  }

  /**
   * @param {object} message
   * @param {string} key
   * @param {MessagePort[]} [transfer]
   * @returns {Promise<object>}
   */
  function sendBrokerRequest(message, key, transfer) {
    if (!brokerPort || !brokerPairReady) return Promise.reject(new Error('NM broker unavailable'))
    const requestId = frameInstanceId + ':broker:' + ++nextBrokerRequestId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = brokerPending.get(requestId)
        if (!pending) return
        brokerPending.delete(requestId)
        reject(new Error('NM broker request timed out'))
      }, 10000)
      brokerPending.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
        key
      })
      try {
        brokerPort.postMessage({ ...message, requestId, key }, transfer || [])
      } catch (error) {
        brokerPending.delete(requestId)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {string} clientKey
   * @param {number} generation
   * @returns {Promise<boolean>}
   */
  async function attachNmBroker(context, deviceId, sessionToken, clientKey, generation) {
    const key = brokerAttachmentKey(context, deviceId, clientKey)
    if (!brokerPort || !brokerPairReady) return false
    const dataChannel = new MessageChannel()
    const pageDataPort = dataChannel.port2
    try {
      const response = await sendBrokerRequest(
        {
          type: 'nmAttach',
          deviceId,
          sessionToken,
          clientKey,
          generation
        },
        key,
        [dataChannel.port1]
      )
      const result = response && response.result ? response.result : response
      if (!result || result.ok !== true) {
        pageDataPort.close()
        return false
      }
      try {
        pagePort.postMessage(
          { type: 'brokerDataPort', deviceId, generation },
          [pageDataPort]
        )
      } catch {
        try {
          pageDataPort.close()
        } catch {
          void 0
        }
        await sendBrokerRequest({ type: 'nmDetach', deviceId, clientKey }, key).catch(() => {})
        return false
      }
      markPlaneLocalReady(key, generation)
      brokerAttachments.set(key, { deviceId, clientKey, generation })
      brokerAttachedKeys.add(key)
      return true
    } catch {
      try {
        pageDataPort.close()
      } catch {
        void 0
      }
      await sendBrokerRequest({ type: 'nmDetach', deviceId, clientKey }, key).catch(() => {})
      return false
    }
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} clientKey
   * @returns {Promise<void>}
   */
  async function detachNmBroker(context, deviceId, clientKey) {
    const key = brokerAttachmentKey(context, deviceId, clientKey)
    if (!brokerAttachments.has(key)) return
    brokerAttachments.delete(key)
    brokerAttachedKeys.delete(key)
    if (!brokerPort || !brokerPairReady) return
    await sendBrokerRequest({ type: 'nmDetach', deviceId, clientKey }, key).catch(() => {})
  }


  /**
   * Handles report requests arriving on the data port transferred to a child
   * MAIN realm. The top owns the other endpoint and the shared NM runtime port.
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} clientKey
   * @param {object} message
   * @param {MessagePort} replyPort
   * @returns {void}
   */
  function handleTopChildDataMessage(context, deviceId, clientKey, message, replyPort) {
    if (!message) return
    if (message.type !== 'send' && message.type !== 'sendFeature' && message.type !== 'receiveFeature')
      return
    const key = brokerAttachmentKey(context, deviceId, clientKey)
    if (!brokerAttachments.has(key)) {
      handleWorkerReportResponse(message, replyPort, { s: 503 })
      return
    }
    const action =
      message.type === 'send'
        ? 'sendReport'
        : message.type === 'sendFeature'
          ? 'sendFeatureReport'
          : 'receiveFeatureReport'
    const reqId = allocateDataReqId()
    const request = {
      action,
      reqId,
      deviceId: Number(deviceId),
      reportId: message.reportId
    }
    if (message.type !== 'receiveFeature') request.data = message.data
    dataPending.set(reqId, {
      msg: message,
      kind: 'broker-page',
      deviceId,
      key,
      replyPort,
      pageRequestId: message.reqId
    })
    try {
      ensureRuntimeDataPort(deviceId).postMessage(request)
    } catch {
      dataPending.delete(reqId)
      handleWorkerReportResponse(
        { ...message, reqId: message.reqId },
        replyPort,
        { s: 503 }
      )
    }
  }



  /**
   * Handles only the authenticated NM broker protocol on a top-owned private
   * port. Ordinary page control never reaches this function.
   * @param {FrameContext} context
   * @param {MessageEvent} event
   * @returns {void}
   */
  function handleTopBrokerMessage(context, event) {
    const broker = context.brokerPort || context.port
    const message = event.data
    if (!message || !context.paired || context.destroyed) return
    if (message.type === 'brokerClosing') {
      for (const [attachmentKey, attachment] of brokerAttachments) {
        if (attachment.context !== context) continue
        brokerAttachments.delete(attachmentKey)
        if (attachment.dataPort) {
          try {
            attachment.dataPort.close()
          } catch {
            void 0
          }
        }
        for (const [reqId, pending] of dataPending) {
          if (pending.key !== attachmentKey) continue
          dataPending.delete(reqId)
          if (pending.kind === 'broker-page') {
            try {
              pending.replyPort.postMessage({ reqId: pending.pageRequestId, s: 503 })
            } catch {
              void 0
            }
          }
        }
        maybeDisconnectRuntimeDataPort(attachment.deviceId)
      }
      return
    }
    if (message.type === 'nmAttach') {
      const deviceId = String(message.deviceId)
      const clientKey = typeof message.clientKey === 'string' ? message.clientKey : 'window'
      const key = brokerAttachmentKey(context, deviceId, clientKey)
      const attachmentDataPort = event.ports && event.ports[0]
      if (!attachmentDataPort) {
        broker.postMessage({
          type: 'nmAttachResult',
          requestId: message.requestId,
          result: { ok: false, error: 'Missing broker data port' }
        })
        return
      }
      attachmentDataPort.onmessage = (dataEvent) =>
        handleTopChildDataMessage(context, deviceId, clientKey, dataEvent.data, attachmentDataPort)
      attachmentDataPort.start()
      brokerAttachments.set(key, {
        context,
        deviceId,
        clientKey,
        generation: message.generation,
        sessionToken: message.sessionToken,
        dataPort: attachmentDataPort
      })
      ensureRuntimeDataPort(deviceId)
      try {
        broker.postMessage({
          type: 'nmAttachResult',
          requestId: message.requestId,
          result: { ok: true }
        })
      } catch {
        brokerAttachments.delete(key)
        try {
          attachmentDataPort.close()
        } catch {
          void 0
        }
        maybeDisconnectRuntimeDataPort(deviceId)
      }
      return
    }
    if (message.type === 'nmDetach') {
      const deviceId = String(message.deviceId)
      const clientKey = typeof message.clientKey === 'string' ? message.clientKey : 'window'
      const key = brokerAttachmentKey(context, deviceId, clientKey)
      const attachment = brokerAttachments.get(key)
      brokerAttachments.delete(key)
      if (attachment && attachment.dataPort) {
        try {
          attachment.dataPort.close()
        } catch {
          void 0
        }
      }
      for (const [requestId, pending] of dataPending) {
        if (pending.key !== key) continue
        dataPending.delete(requestId)
        if (pending.kind === 'broker-page') {
          try {
            pending.replyPort.postMessage({ reqId: pending.pageRequestId, s: 503 })
          } catch {
            void 0
          }
        }
      }
      maybeDisconnectRuntimeDataPort(deviceId)
      broker.postMessage({
        type: 'nmDetachResult',
        requestId: message.requestId,
        result: { ok: true }
      })
      return
    }
  }
  /**
   * @param {Window} childWindow
   * @returns {number}
   */
  function frameIndexForWindow(childWindow) {
    for (let index = 0; index < window.frames.length; index++) {
      if (window.frames[index] === childWindow) return index
    }
    return -1
  }

  /**
   * @param {Window} root
   * @param {{frameId: number, documentId: string}} identity
   * @returns {Window|null}
   */
  function findChildWindow(root, identity) {
    for (let index = 0; index < root.frames.length; index++) {
      try {
        const child = root.frames[index]
        const current = browserFrameIdentity(child)
        if (current.frameId === identity.frameId && current.documentId === identity.documentId)
          return child
        const nested = findChildWindow(child, identity)
        if (nested) return nested
      } catch {
        void 0
      }
    }
    return null
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleFanoutBrokerOffer(data) {
    const child = data.child
    if (
      !child ||
      child.origin !== window.location.origin ||
      typeof child.stackOtp !== 'string' ||
      !child.stackOtp ||
      typeof data.authOtp !== 'string' ||
      !data.authOtp ||
      typeof data.ackOtp !== 'string' ||
      !data.ackOtp ||
      !Number.isInteger(child.frameId) ||
      child.frameId <= 0 ||
      typeof child.documentId !== 'string' ||
      !child.documentId
    )
      return
    const childWindow = findChildWindow(window, child)
    const frameIndex = childWindow && frameIndexForWindow(childWindow)
    if (!childWindow || frameIndex < 0) return
    const current = browserFrameIdentity(childWindow)
    if (current.frameId !== child.frameId || current.documentId !== child.documentId) return
    for (const context of fanoutContexts.values()) {
      if (context.frameId !== child.frameId) continue
      if (context.documentId === child.documentId) return
      destroyFrameContext(context).catch(() => {})
    }
    if (fanoutContexts.size >= 32) return
    const channel = 'fanout:' + frameInstanceId + ':' + ++nextFanoutChannel
    const childPort = new MessageChannel()
    const context = createFrameContext(childPort.port1, childWindow, child.origin, {
      frameId: child.frameId,
      documentId: child.documentId
    })
    context.persistentOrigin = persistentOrigin
    context.brokerPort = childPort.port1
    context.channel = channel
    context.isFanout = true
    context.pairAuthOtp = data.authOtp
    context.pairAckOtp = data.ackOtp
    context.pairStackOtp = child.stackOtp
    fanoutContexts.set(channel, context)
    childPort.port1.addEventListener('message', (event) => {
      const pairData = event.data
      if (
        !context.paired &&
        pairData &&
        pairData.type === 'fanoutAuthA' &&
        pairData.otp === context.pairAuthOtp &&
        !context.destroyed
      ) {
        context.paired = true
        try {
          childPort.port1.postMessage({ type: 'fanoutAuthB', otp: context.pairAckOtp })
        } catch {
          destroyFrameContext(context).catch(() => {})
          return
        }
        logger.debug('[bridge] fanout broker paired', context.channel)
        return
      }
      if (context.paired) handleTopBrokerMessage(context, event)
    })
    childPort.port1.start()
    setTimeout(() => {
      if (!context.paired) destroyFrameContext(context).catch(() => {})
    }, 5000)
    try {
      pagePort.postMessage(
        {
          type: 'fanoutBrokerCandidate',
          frameIndex,
          stackOtp: child.stackOtp
        },
        [childPort.port2]
      )
    } catch {
      destroyFrameContext(context).catch(() => {})
    }
  }

  /** @type {object} */
  const PAGE_PORT_HANDLERS = {
    spawnWorkerResponse: handleSpawnWorkerResponse,
    dataPlaneResponse: handlePlaneResponse,
    dataPlaneEvent: handleDataPlaneEvent,
    fanoutCandidate: handleBrokerCandidate,
    workerError: (data, port) =>
      handleWorkerErrorEvent(data, port).catch((e) =>
        logger.debug('worker error recovery failed', e)
      ),
    frameDestroyed: handleFrameDestroyedMessage
  }

  /**
   * @param {object} data
   * @returns {string}
   */
  function getRequestOrigin(data) {
    const port = requestPortMap.get(data.id)
    return frameContextForPort(port)?.persistentOrigin || persistentOrigin || ''
  }

  /**
   * Dispatches one message arriving on a request port: maps its request id to
   * the port and routes it to the request handler.
   * @param {MessagePort} port
   * @param {MessageEvent} event
   * @param {Window|null} source
   * @returns {void}
   */
  function dispatchPortMessage(port, event, source) {
    const data = event.data
    if (data && data.id != null) requestPortMap.set(data.id, port)
    handleRequest(data, event.ports, source, port)
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} ports
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handleWorkerPortRequest(data, ports, requestPort) {
    const p = ports && ports[0]
    const context = frameContextForPort(requestPort)
    if (!p || !context) return
    frameContextByPort.set(p, context)
    clientSessions.set(p, new Map())
    const clientKey = 'worker-' + ++nextFrameGeneration
    clientKeysByPort.set(p, clientKey)
    let workerPorts = workerPagePorts.get(context)
    if (!workerPorts) {
      workerPorts = new Set()
      workerPagePorts.set(context, workerPorts)
    }
    workerPorts.add(p)
    p.onmessage = (event) => dispatchPortMessage(p, event, null)
    if (typeof p.start === 'function') p.start()
    requestPort.postMessage({
      type: 'response',
      id: data.id,
      result: { ok: true, clientKey }
    })
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} ports
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handleDataPortRequest(data, ports, requestPort) {
    const deviceId = data.payload && data.payload.deviceId
    const generation = data.payload && data.payload.generation
    const port = ports && ports[0]
    const context = frameContextForPort(requestPort)
    requestPortMap.delete(data.id)
    if (deviceId == null || !port || !context) {
      logger.warn('data-port: missing deviceId, port, or frame')
      if (port) port.close()
      return
    }
    const client = clientForPort(context, requestPort)
    if (!client) {
      try {
        port.close()
      } catch (e) {
        logger.debug('unowned data port close failed', e)
      }
      return
    }
    const allowed = await isDeviceAllowed(deviceId, context.persistentOrigin || '')
    if (!allowed) {
      logger.warn('data-port: not authorized for device', deviceId)
      try {
        port.close()
      } catch (e) {
        logger.debug('unauthorized port close failed', e)
      }
      return
    }
    const currentClient = clientForPort(context, requestPort)
    if (
      !currentClient ||
      currentClient.port !== client.port ||
      currentClient.sessions !== client.sessions ||
      currentClient.clientKey !== client.clientKey
    ) {
      try {
        port.close()
      } catch (e) {
        logger.debug('stale client data port close failed', e)
      }
      return
    }
    const clientKey = client.clientKey
    const key = planeKeyForClient(context, deviceId, clientKey)
    if (spawnGen.get(key) !== generation) {
      try {
        port.close()
      } catch (e) {
        logger.debug('stale data port close failed', e)
      }
      return
    }
    const entry = workers.get(key)
    if (entry && entry.generation === generation) {
      const proxy = makeWorkerProxy(port)
      workers.set(key, { state: 'ready', worker: proxy, generation })
      proxy.onmessage = (event) => {
        const data = event.data
        if (!data || !data.type) return
        if (data.type === 'ready') {
          logger.info('worker ready for', deviceId)
          workerReadyDevices.add(key)
          markPlaneReady(key, generation)
          const originSettings = settingsForOrigin(context.origin)
          proxy.postMessage({
            type: 'settings',
            dataPlane: originSettings.dataPlane,
            logLevel: originSettings.logLevel
          })
          return
        }
        if (data.type === 'auth-failed') {
          logger.warn('worker auth-failed for', deviceId, 'code=' + data.code + '; recovering')
          if (
            getWorker(context, deviceId, clientKey) === proxy &&
            spawnGen.get(key) === generation
          ) {
            handleWorkerErrorEvent(
              { deviceId, generation, message: 'worker transport auth failed' },
              requestPort,
              generation
            ).catch((e) => logger.debug('worker auth recovery failed', e))
          }
          return
        }
        if (data.type === 'closed') {
          logger.warn('worker closed for', deviceId)
          if (getWorker(context, deviceId, clientKey) === proxy) {
            handleWorkerErrorEvent(
              { deviceId, generation, message: 'transport closed' },
              requestPort,
              generation
            ).catch((e) => logger.debug('worker recovery failed', e))
          }
        }
      }
      const params = connectParams.get(key)
      if (params) {
        connectParams.delete(key)
        proxy.postMessage(Object.assign({ type: 'connect' }, params))
      }
      logger.debug('worker control port received for device', deviceId, context.key)
      return
    }
    let devicePorts = dataPorts.get(key)
    if (!devicePorts) {
      devicePorts = new Set()
      dataPorts.set(key, devicePorts)
    }
    devicePorts.add(port)
    markPlaneLocalReady(key, generation)
    logger.debug('data port received for device', deviceId, context.key)
    port.onmessage = (event) => onDataPortMessage(context, deviceId, event.data, port, clientKey)
  }
  /**
   * @param {object} data
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handleGetCspInfoRequest(data, _ports, requestPort) {
    const context = frameContextForPort(requestPort)
    try {
      const resp = await sendBackgroundRequest({ action: 'getCspInfo' }, context)
      replyToPage({ type: 'response', id: data.id, result: resp || {} })
    } catch {
      replyToPage({ type: 'response', id: data.id, result: {} })
    }
  }
  /**
   * @param {string} token
   * @returns {string|null}
   */
  function delegationToken(token) {
    if (!token) return null
    const first = token[0]
    const last = token[token.length - 1]
    if (first === "'" || first === '"') {
      if (last !== first || token.length < 2) return null
      return token.slice(1, -1)
    }
    if (last === "'" || last === '"') return null
    return token
  }
  /**
   * @param {string} value
   * @param {string} [base]
   * @returns {string|null}
   */
  function originFromDelegationUrl(value, base) {
    try {
      const url = base ? new URL(value, base) : new URL(value)
      const origin = url.origin
      return typeof origin === 'string' && origin !== 'null' ? origin : null
    } catch {
      return null
    }
  }
  /**
   * @param {Element} frame
   * @param {{childOrigin: string, parentOrigin: string}} query
   * @param {string[]} tokens
   * @returns {boolean}
   */
  function allowHidDirective(frame, query, tokens) {
    if (tokens.length === 0) {
      const src = frame.getAttribute('src') || ''
      const sourceOrigin = src ? originFromDelegationUrl(src, document.baseURI) : query.parentOrigin
      return sourceOrigin === query.childOrigin
    }
    for (const rawToken of tokens) {
      const token = delegationToken(rawToken)
      if (token === null) return false
      if (token === 'none') return false
      if (token === '*') return true
      if (token === 'self' && query.childOrigin === query.parentOrigin) return true
      if (token === 'src') {
        const src = frame.getAttribute('src') || ''
        const sourceOrigin = src
          ? originFromDelegationUrl(src, document.baseURI)
          : query.parentOrigin
        if (sourceOrigin === query.childOrigin) return true
        continue
      }
      if (originFromDelegationUrl(token) === query.childOrigin) return true
    }
    return false
  }
  /**
   * @param {{childFrameId: number, childDocumentId: string, childOrigin: string, parentOrigin: string}} query
   * @returns {boolean}
   */
  function frameDelegationForChild(query) {
    try {
      const getFrameId = browser.runtime.getFrameId
      const getDocumentId = browser.runtime.getDocumentId
      if (
        typeof getFrameId !== 'function' ||
        typeof getDocumentId !== 'function' ||
        typeof query.childOrigin !== 'string' ||
        typeof query.parentOrigin !== 'string'
      )
        return false
      for (const frame of document.querySelectorAll('iframe,frame')) {
        if (getFrameId(frame) !== query.childFrameId) continue
        if (getDocumentId(frame) !== query.childDocumentId) continue
        const directives = (frame.getAttribute('allow') || '')
          .split(';')
          .filter((directive) => directive.trim().toLowerCase().startsWith('hid'))
        if (directives.length === 0) return query.childOrigin === query.parentOrigin
        for (const directive of directives) {
          const tokens = directive.trim().split(/\s+/)
          if (tokens.shift()?.toLowerCase() !== 'hid') return false
          if (!allowHidDirective(frame, query, tokens)) return false
        }
        return true
      }
    } catch {
      void 0
    }
    return false
  }
  /**
   * @param {FrameContext} context
   * @returns {boolean}
   */
  function hasHidDelegation(context) {
    return context.frameId === 0
  }
  /**
   * @param {object} data
   * @param {MessagePort[]} _ports
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handleGetPolicyRequest(data, _ports, requestPort) {
    const context = frameContextForPort(requestPort)
    if (!context || context.destroyed || !context.source) {
      replyToPage({ type: 'response', id: data.id, result: { hid: 'none' } })
      return
    }
    try {
      let response = null
      if (hasHidDelegation(context)) {
        const delegationResponse = await sendBackgroundRequest(
          {
            action: 'setFrameDelegation',
            delegated: true
          },
          context
        )
        if (delegationResponse?.ok)
          response = await sendBackgroundRequest({ action: 'getPolicy' }, context)
      } else {
        response = await sendBackgroundRequest({ action: 'getPolicy' }, context)
      }
      replyToPage({
        type: 'response',
        id: data.id,
        result: response ? response.policy || { hid: 'none' } : { hid: 'none' }
      })
    } catch (e) {
      replyToPage({
        type: 'response',
        id: data.id,
        result: { hid: 'none', _err: String(e) }
      })
    }
  }

  /**
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleGetSettingsRequest(data, _ports, requestPort) {
    try {
      const context = frameContextForPort(requestPort)
      const origin = context ? context.origin : ''
      const store = await loadSettingsForOrigin(origin)
      replyToPage({ type: 'response', id: data.id, result: store.getAll() })
    } catch {
      replyToPage({ type: 'response', id: data.id, result: {} })
    }
  }

  /**
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleRequestDeviceRequest(data, _ports, requestPort) {
    const payload = data.payload || {}
    const filters = payload.filters || []
    const exclusionFilters = payload.exclusionFilters || []
    const context = frameContextForPort(requestPort)
    const origin = context ? context.persistentOrigin || '' : persistentOrigin || ''
    const originSettings = await loadSettingsForOrigin(origin)
    const pickerMode =
      isChromium && originSettings.devicePickerMode === 'pageAction'
        ? 'modal'
        : originSettings.devicePickerMode

    sendBackgroundRequest(
      {
        action: 'showPicker',
        requestId: data.id,
        filters,
        exclusionFilters,
        mode: pickerMode,
        origin
      },
      context
    ).catch((e) => logger.debug('showPicker send failed', e))
    const pickerTimeout = setTimeout(() => {
      pickerResultHandlers.delete(data.id)
      sendBackgroundRequest(
        {
          action: 'cancelPicker',
          requestId: data.id
        },
        context
      ).catch((e) => logger.debug('cancelPicker send failed', e))
      replyToPage({
        type: 'response',
        id: data.id,
        result: { cancelled: true }
      })
    }, 30000)
    const onPickerResult = async (msg) => {
      if (msg.action !== 'pickerResult' || msg.requestId !== data.id) return
      clearTimeout(pickerTimeout)
      pickerResultHandlers.delete(data.id)
      if (msg.selected && msg.devices) {
        await grantSelectedDevices(getRequestOrigin(data), msg.devices)
        replyToPage({
          type: 'response',
          id: data.id,
          result: { devices: msg.devices }
        })
      } else {
        replyToPage({
          type: 'response',
          id: data.id,
          result: { cancelled: true }
        })
      }
    }
    pickerResultHandlers.set(data.id, onPickerResult)
    return
  }

  /**
   * Runs the post-open data-plane spawn for a device.
   * @param {object} response
   * @param {FrameContext} context
   * @param {Map<string, string>} sessions
   * @param {{port: MessagePort, clientKey: string, sessions: Map<string, string>}} client
   * @returns {Promise<{accepted: boolean, error?: string}>}
   */
  async function handleOpenSuccess(response, context, sessions, client) {
    const deviceId = response.i
    if (
      !context ||
      context.destroyed ||
      frameContexts.get(context.key) !== context ||
      !client ||
      client.sessions !== sessions
    )
      return { accepted: false, error: 'initial client ownership check failed' }
    const currentClient = clientForPort(context, client.port)
    if (
      !currentClient ||
      currentClient.port !== client.port ||
      currentClient.sessions !== sessions ||
      currentClient.clientKey !== client.clientKey
    )
      return { accepted: false, error: 'client mapping changed during open' }
    const clientKey = client.clientKey
    const clientPort = client.port
    sessions.set(deviceId, response.t)
    sendBackgroundRequest({ action: 'deviceCountChanged' }).catch((e) =>
      logger.debug('deviceCountChanged (open) failed', e)
    )
    logger.debug('open ok deviceId=' + deviceId + ' wsPort=' + response.w)
    const key = planeKeyForClient(context, deviceId, clientKey)
    const dataPlane = settingsForOrigin(context.origin).dataPlane
    let generation
    if (dataPlane === 'nm' || nmPlanes.has(key)) {
      generation = beginPlaneGeneration(key)
      nmPlanes.add(key)
      const brokered = fanoutCandidate && brokerPairReady
      if (brokered) {
        const attached = await attachNmBroker(
          context,
          deviceId,
          response.t,
          clientKey,
          generation
        )
        if (!attached) {
          nmPlanes.delete(key)
          return { accepted: false, error: 'NM broker attach failed' }
        }
        response.clientPlaneOwner = 'top'
      } else {
        ensureRuntimeDataPort(deviceId)
      }
      markPlaneAuthoritativeReady(key, generation)
    } else if (dataPlane === 'ws') {
      generation = await spawnDataPlane(context, deviceId, response.t, response.w || wsPort, {
        clientKey,
        clientPort
      })
    } else if (dataPlane === 'wt') {
      if (wtPort != null) {
        generation = await spawnDataPlane(context, deviceId, response.t, null, {
          wtPort,
          wtCertHash,
          clientKey,
          clientPort
        })
      } else {
        generation = await spawnDataPlane(context, deviceId, response.t, response.w || wsPort, {
          clientKey,
          clientPort
        })
      }
    }
    if (generation == null) return { accepted: false, error: 'data plane authority setup failed' }
    notifyBackgroundPlaneStatus(key, generation, readyGenerations.get(key) === generation)
    response.clientPlaneGeneration = generation
    return { accepted: true }
  }

  /**
   * Tears down the data plane after a device close.
   * @param {object} payload
   * @param {FrameContext} context
   * @param {Map<string, string>} sessions
   * @param {string} clientKey
   * @returns {Promise<void>}
   */
  async function handleCloseSuccess(payload, context, sessions, clientKey) {
    const deviceId = payload.deviceId
    logger.debug('close deviceId=' + deviceId)
    sessions.delete(deviceId)
    await despawnDataPlane(context, deviceId, { clientKey })
    sendBackgroundRequest({ action: 'deviceCountChanged' }).catch((e) =>
      logger.debug('deviceCountChanged (close) failed', e)
    )
  }
  /**
   *
   * @param {string} origin
   * @param {Array<{deviceId: number}>} devices
   */
  async function grantSelectedDevices(origin, devices) {
    await Promise.all(
      devices.map((device) =>
        sendBackgroundRequest({
          action: 'pairDevice',
          origin,
          device: { deviceId: device.deviceId }
        }).catch(() => {})
      )
    )
    if (devices.length > 1) {
      await sendBackgroundRequest({
        action: 'recordGrantGroup',
        origin,
        deviceIds: devices.map((device) => device.deviceId)
      }).catch((e) => logger.debug('recordGrantGroup failed', e))
    }
    await loadAllowedDeviceIds(persistentOrigin || '')
  }

  /**
   * Routes open/close and other pass-through device actions to the background.
   * @param {object} data
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handleGenericRequest(data, requestPort) {
    const { id, action, payload } = data
    const context = frameContextForPort(requestPort)
    const client = context && clientForPort(context, requestPort)
    const sessions = client && client.sessions
    const origin = context ? context.persistentOrigin || '' : getRequestOrigin(data)
    let nmOpenAttempt = false
    let response = null
    const deviceId = payload && payload.deviceId
    const clientKey = client && client.clientKey
    const key =
      context && deviceId != null && clientKey
        ? planeKeyForClient(context, deviceId, clientKey)
        : null
    try {
      if (PAGE_BLOCKED_ACTIONS.has(action)) {
        replyToPage({ type: 'response', id, result: { s: 403 } })
        return
      }
      if ((action === 'open' || action === 'close') && (!context || !client)) {
        replyToPage({ type: 'response', id, result: { s: 403 } })
        return
      }
      if (action === 'open') await loadSettingsForOrigin(origin)
      if (action === 'open') {
        const allowed = await isDeviceAllowed(deviceId, origin)
        if (!allowed) {
          replyToPage({ type: 'response', id, result: { s: 403 } })
          return
        }
        const currentClient = clientForPort(context, requestPort)
        if (
          context.destroyed ||
          frameContexts.get(context.key) !== context ||
          frameContextForPort(requestPort) !== context ||
          !currentClient ||
          currentClient.port !== client.port ||
          currentClient.sessions !== client.sessions ||
          currentClient.clientKey !== client.clientKey
        ) {
          replyToPage({ type: 'response', id, result: { s: 503 } })
          return
        }
        if (settingsForOrigin(origin).dataPlane === 'nm' || nmPlanes.has(key)) {
          if (!(fanoutCandidate && brokerPairReady)) ensureRuntimeDataPort(deviceId)
          retainNmOpenAttempt(key)
          nmOpenAttempt = true
        }
      }
      const effectiveAction =
        action === 'enumerate'
          ? 'enumeratePaired'
          : action === 'unpairDevice'
            ? 'revokeDevice'
            : action
      const msg = Object.assign({}, payload || {}, {
        action: effectiveAction,
        origin,
        frameKey: context ? context.key : undefined,
        clientKey
      })
      let reservedToken = null
      if (action === 'close') {
        reservedToken = sessions.get(deviceId) || null
        if (reservedToken) msg.T = reservedToken
      }
      response = await sendBackgroundRequest(msg, context)
      if (action === 'open' && http.isOk(response.s) && response.t) {
        const openResult = await handleOpenSuccess(response, context, sessions, client)
        if (!openResult.accepted) {
          if (sessions) sessions.delete(deviceId)
          try {
            await despawnDataPlane(context, deviceId, { clientKey })
          } catch (e) {
            logger.debug('failed-open data plane cleanup failed', e)
          }
          await sendBackgroundRequest({
            action: 'cleanupSession',
            deviceId: response.i,
            sessionToken: response.t
          }).catch((e) => logger.debug('late-open cleanup failed', e))
          response = { s: 503, error: openResult.error }
        }
        if (!openResult.accepted) discardFailedOpenDataPort(context, deviceId, clientKey)
        if (nmOpenAttempt) {
          releaseNmOpenAttempt(key)
          nmOpenAttempt = false
        }
      } else if (action === 'open') {
        if (nmOpenAttempt) {
          releaseNmOpenAttempt(key)
          nmOpenAttempt = false
        }
        discardFailedOpenDataPort(context, deviceId, clientKey)
      }
      if (action === 'close') {
        if (http.isOk(response.s)) {
          await handleCloseSuccess(payload, context, sessions, clientKey)
        } else if (reservedToken) {
          sessions.set(deviceId, reservedToken)
        }
      }
      const transfers = response && response.d instanceof Uint8Array ? [response.d.buffer] : []
      replyToPage(
        { type: 'response', id, result: response },
        transfers.length ? transfers : undefined
      )
    } catch {
      if (action === 'open' && nmOpenAttempt) {
        releaseNmOpenAttempt(key)
      }
      if (action === 'open') {
        if (sessions) sessions.delete(deviceId)
        if (response && response.t) {
          try {
            await despawnDataPlane(context, deviceId, { clientKey })
          } catch (e) {
            logger.debug('failed-open data plane cleanup failed', e)
          }
          await sendBackgroundRequest({
            action: 'cleanupSession',
            deviceId: response.i,
            sessionToken: response.t
          }).catch(() => {})
        }
        discardFailedOpenDataPort(context, deviceId, clientKey)
      }
      replyToPage({ type: 'response', id, result: { s: 500 } })
    }
  }

  /**
   * Cleans up sessions owned by a terminated worker client.
   * @param {object} data
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handleWorkerClientDestroyed(data, requestPort) {
    const context = frameContextForPort(requestPort)
    const clientKey = data.payload && data.payload.clientKey
    if (!context || typeof clientKey !== 'string') return
    const workerPort = [...clientKeysByPort.entries()].find(
      ([port, key]) => key === clientKey && frameContextByPort.get(port) === context
    )?.[0]
    if (!workerPort) return
    const sessions = clientSessions.get(workerPort)
    if (sessions) {
      for (const [deviceId, token] of sessions) {
        await sendBackgroundRequest(
          {
            action: 'close',
            deviceId,
            T: token,
            origin: context.origin,
            frameKey: context.key,
            clientKey
          },
          context
        ).catch(() => {})
        await despawnDataPlane(context, deviceId, { clientKey })
      }
      sessions.clear()
    }
    for (const [id, port] of requestPortMap) {
      if (port === workerPort) requestPortMap.delete(id)
    }
    clientSessions.delete(workerPort)
    clientKeysByPort.delete(workerPort)
    frameContextByPort.delete(workerPort)
    try {
      workerPort.onmessage = null
      workerPort.close()
    } catch (e) {
      logger.debug('worker client port cleanup failed', e)
    }
    const workerPorts = workerPagePorts.get(context)
    if (workerPorts) {
      workerPorts.delete(workerPort)
      if (workerPorts.size === 0) workerPagePorts.delete(context)
    }
  }
  /** @type {object} */
  const REQUEST_HANDLERS = {
    workerPort: handleWorkerPortRequest,
    workerClientDestroyed: handleWorkerClientDestroyed,
    dataPort: handleDataPortRequest,
    waitDataPlaneReady: handlePlaneReadyRequest,
    getCspInfo: handleGetCspInfoRequest,
    getPolicy: handleGetPolicyRequest,
    getSettings: handleGetSettingsRequest,
    requestDevice: handleRequestDeviceRequest
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} ports
   * @param {Window|null} _source
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handleRequest(data, ports, _source, requestPort) {
    if (!data || data.id === undefined) return
    if (data.action === 'getPolicy') await authorityReady
    if (authorityFailed || !authorityOrigin) {
      replyToPage({ type: 'response', id: data.id, result: { s: 503 } })
      return
    }
    logger.debug('req action=' + data.action + ' id=' + data.id)

    const requestContext = frameContextForPort(requestPort)
    if (PAGE_ACTION_API_ACTIONS.has(data.action)) {
      markPageActionUsed(requestContext ? requestContext.origin : authorityOrigin)
    }

    const handler = REQUEST_HANDLERS[data.action]
    if (handler) {
      await handler(data, ports, requestPort)
      return
    }
    await handleGenericRequest(data, requestPort)
  }

  /**
   * @param {FrameContext} context
   * @param {{close?: boolean, notify?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async function destroyFrameContext(context, { close = true, notify = false } = {}) {
    if (!context || context.destroyed || frameContexts.get(context.key) !== context) return
    const clientRecords = sessionsForContext(context).map(({ port, sessions, clientKey }) => ({
      port,
      sessions,
      clientKey
    }))
    const clientPorts = new Map(clientRecords.map(({ port, clientKey }) => [clientKey, port]))
    const planePrefix = context.key + '\u0000'
    const planes = new Map()
    const addPlaneKey = (key) => {
      if (typeof key !== 'string' || !key.startsWith(planePrefix)) return
      const parts = key.split('\u0000')
      const deviceId = parts[1]
      if (!deviceId) return
      const clientKey = parts[2] || 'window'
      planes.set(key, { deviceId, clientKey, clientPort: clientPorts.get(clientKey) })
    }
    for (const { sessions, clientKey, port } of clientRecords) {
      for (const deviceId of sessions.keys()) {
        const key = planeKeyForClient(context, deviceId, clientKey)
        planes.set(key, { deviceId, clientKey, clientPort: port })
      }
    }
    for (const keys of [
      workers.keys(),
      workerReadyDevices,
      connectParams.keys(),
      deviceTransports.keys(),
      nmPlanes,
      dataPorts.keys(),
      inPageDevices,
      nmOpenAttempts.keys(),
      spawnGen.keys(),
      readyGenerations.keys(),
      pendingPlaneReady.keys()
    ]) {
      for (const key of keys) addPlaneKey(key)
    }

    context.destroyed = true
    if (context.port === pagePort) invalidateBrokerPairOffer()
    if (context.port === pagePort && brokerPort) {
      try {
        brokerPort.postMessage({ type: 'brokerClosing' })
      } catch {
        void 0
      }
      try {
        brokerPort.close()
      } catch {
        void 0
      }
      brokerPort = null
      brokerPairReady = false
      if (brokerPairTimer) {
        clearTimeout(brokerPairTimer)
        brokerPairTimer = null
      }
      for (const attachmentKey of [...brokerAttachments.keys()]) {
        const attachment = brokerAttachments.get(attachmentKey)
        brokerAttachments.delete(attachmentKey)
        brokerAttachedKeys.delete(attachmentKey)
        if (attachment?.dataPort) {
          try {
            attachment.dataPort.close()
          } catch {
            void 0
          }
        }
        if (attachment) maybeDisconnectRuntimeDataPort(attachment.deviceId)
      }
      for (const [requestId, pending] of brokerPending) {
        brokerPending.delete(requestId)
        pending.reject(new Error('NM broker closed'))
      }
    }
    const workerPorts = new Set(workerPagePorts.get(context) || [])
    const allClientPorts = new Set(clientRecords.map(({ port }) => port))
    for (const port of workerPorts) allClientPorts.add(port)
    for (const port of allClientPorts) {
      frameContextByPort.delete(port)
      clientSessions.delete(port)
      clientKeysByPort.delete(port)
      for (const [id, mappedPort] of requestPortMap) {
        if (mappedPort === port) requestPortMap.delete(id)
      }
    }
    workerPagePorts.delete(context)
    for (const [id, pending] of pendingSpawns) {
      if (pending.context !== context) continue
      clearTimeout(pending.timer)
      pendingSpawns.delete(id)
      pending.reject(new Error('frame destroyed'))
    }
    if (close && !context.isFanout) {
      await sendBackgroundRequest(
        {
          action: 'frameDestroyed',
          frameKey: context.key,
          frameId: context.frameId,
          documentId: context.documentId
        },
        context
      ).catch((e) => logger.debug('frame session cleanup request failed', e))
    }
    const notifiedDevices = new Set()
    for (const { deviceId, clientKey, clientPort } of planes.values()) {
      await despawnDataPlane(context, deviceId, { clientKey, clientPort })
      if (!notify || notifiedDevices.has(deviceId)) continue
      if (!clientRecords.some(({ sessions }) => sessions.has(deviceId))) continue
      notifiedDevices.add(deviceId)
      try {
        context.port.postMessage({
          type: 'event',
          event: { eventType: 'disconnect', deviceId }
        })
      } catch (e) {
        logger.debug('frame reset notification failed', e)
      }
    }
    for (const { sessions } of clientRecords) sessions.clear()
    for (const port of workerPorts) {
      try {
        port.onmessage = null
        port.close()
      } catch (e) {
        logger.debug('worker page port cleanup failed', e)
      }
    }
    for (const [attachmentKey, attachment] of brokerAttachments) {
      if (attachment.context !== context) continue
      brokerAttachments.delete(attachmentKey)
      try {
        const childBroker = attachment.context.brokerPort || attachment.context.port
        childBroker.postMessage({ type: 'nmPlaneUnavailable', key: attachmentKey })
      } catch {
        void 0
      }
      if (attachment.dataPort) {
        try {
          attachment.dataPort.close()
        } catch {
          void 0
        }
      }
      for (const [reqId, pending] of dataPending) {
        if (pending.key !== attachmentKey) continue
        dataPending.delete(reqId)
        if (pending.kind === 'broker-page') {
          try {
            pending.replyPort.postMessage({ reqId: pending.pageRequestId, s: 503 })
          } catch {
            void 0
          }
        }
      }
      maybeDisconnectRuntimeDataPort(attachment.deviceId)
    }
    try {
      context.port.onmessage = null
      context.port.close()
    } catch (e) {
      logger.debug('frame page port cleanup failed', e)
    }
    frameContexts.delete(context.key)
    if (context.channel) fanoutContexts.delete(context.channel)
  }

  /**
   * Clears daemon-derived ownership while retaining live browser frame ports.
   * @returns {Promise<void>}
   */
  async function resetAuthorityState() {
    const contexts = [...frameContexts.values()]
    for (const context of contexts) {
      const clientSessionsForFrame = sessionsForContext(context)
      const deviceIds = new Set()
      for (const { sessions } of clientSessionsForFrame) {
        for (const deviceId of sessions.keys()) deviceIds.add(deviceId)
      }
      for (const deviceId of deviceIds) {
        const clients = clientSessionsForFrame.filter(({ sessions }) => sessions.has(deviceId))
        if (clients.length === 0) {
          await despawnDataPlane(context, deviceId)
          continue
        }
        for (const { port, sessions, clientKey } of clients) {
          sessions.delete(deviceId)
          await despawnDataPlane(context, deviceId, { clientKey })
          try {
            port.postMessage({
              type: 'event',
              event: { eventType: 'disconnect', deviceId }
            })
          } catch (e) {
            logger.debug('authority reset notification failed', e)
          }
        }
      }
    }
  }
  /**
   * Routes shared-port NM input reports to paired child bridges.
   * @param {string} deviceId
   * @param {object} messageEvent
   * @returns {void}
   */
  function forwardInputReportToAttachments(deviceId, messageEvent) {
    const data = messageEvent && messageEvent.data
    for (const attachment of brokerAttachments.values()) {
      if (
        attachment.deviceId !== String(deviceId) ||
        !attachment.dataPort ||
        messageEvent?.eventType !== 'input_report'
      )
        continue
      try {
        const copy =
          data == null
            ? new Uint8Array(0)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data)
              : new Uint8Array(new Uint8Array(data))
        attachment.dataPort.postMessage(
          {
            type: 'inputReport',
            reportId: messageEvent.reportId,
            data: copy.buffer
          },
          [copy.buffer]
        )
      } catch (e) {
        logger.debug('forward inputReport to data port failed', e)
      }
    }
  }


  /** @returns {void} */
  function handleGlobalReset() {
    logger.warn('global reset: clearing daemon state')
    resetAuthorityState()
      .catch((e) => logger.debug('authority reset failed', e))
      .finally(() =>
        sendBackgroundRequest({ action: 'deviceCountChanged' }).catch((e) =>
          logger.debug('deviceCountChanged (reset) failed', e)
        )
      )
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {object} messageEvent
   * @returns {Promise<void>}
   */
  async function reconcileFrameDevice(context, deviceId, messageEvent) {
    const clients = sessionsForContext(context).filter(({ sessions }) => sessions.has(deviceId))
    if (clients.length === 0) return
    for (const { port, sessions, clientKey } of clients) {
      sessions.delete(deviceId)
      await despawnDataPlane(context, deviceId, { clientKey })
      try {
        port.postMessage({ type: 'event', event: messageEvent })
      } catch (e) {
        logger.debug('frame device reconciliation failed', e)
      }
    }
  }
  /**
   * Forwards an NM input report to every frame that owns the device.
   * @param {object} messageEvent
   * @returns {boolean} true when a port handled the report
   */
  function forwardInputReportToPage(messageEvent) {
    let handled = false
    for (const context of frameContexts.values()) {
      for (const { port, sessions, clientKey } of sessionsForContext(context)) {
        if (!sessions.has(messageEvent.deviceId)) continue
        const key = planeKeyForClient(context, messageEvent.deviceId, clientKey)
        if (
          workers.has(key) ||
          inPageDevices.has(key) ||
          !nmPlanes.has(key) ||
          brokerAttachments.has(key)
        )
          continue
        try {
          const data = messageEvent.data
          const copy = data != null && ArrayBuffer.isView(data) ? new Uint8Array(data) : data
          port.postMessage({
            type: 'event',
            event: { ...messageEvent, data: copy }
          })
          handled = true
        } catch (e) {
          logger.debug('forward inputReport to NM client failed', e)
        }
      }
    }
    return handled
  }

  /**
   * @param {object} message
   * @returns {void}
   */
  function handleBackgroundEvent(message) {
    const messageEvent = message.event
    if (messageEvent.eventType === 'input_report') {
      forwardInputReportToPage(messageEvent)
      return
    }
    if (messageEvent.eventType === 'disconnect') {
      const contexts = [...frameContexts.values()]
      for (const context of contexts) {
        reconcileFrameDevice(context, messageEvent.deviceId, messageEvent).catch((e) =>
          logger.debug('disconnect reconciliation failed', e)
        )
      }
    } else if (messageEvent.eventType === 'revoked') {
      const contexts = [...frameContexts.values()].filter(
        (context) =>
          messageEvent.persistentOrigin &&
          messageEvent.persistentOrigin === context.persistentOrigin
      )
      for (const context of contexts) {
        reconcileFrameDevice(context, messageEvent.deviceId, messageEvent).catch((e) =>
          logger.debug('revoke reconciliation failed', e)
        )
      }
    } else {
      replyToPage({ type: 'event', event: messageEvent })
    }
    if (
      devicePicker &&
      devicePicker.isOpen &&
      (messageEvent.eventType === 'connect' || messageEvent.eventType === 'disconnect')
    ) {
      devicePicker.refreshDevices()
    }
  }

  function wireBackgroundEventListener() {
    browser.runtime.onMessage.addListener((message) => {
      if (message.action === 'globalReset') {
        handleGlobalReset()
        return
      }
      if (message.action === 'webhidDeviceEvent' && message.event) {
        handleBackgroundEvent(message)
      }
    })
  }

  /**
   * Sends the report result back over the device's data port.
   * @param {object} msg
   * @param {MessagePort|null} port
   * @param {object|null} response
   * @returns {void}
   */
  function handleWorkerReportResponse(msg, port, response) {
    if (!port) return
    const status = response ? response.s : 500
    if (msg.type === 'receiveFeature') {
      if (status === 403) {
        try {
          port.postMessage({
            type: 'featureResult',
            reqId: msg.reqId,
            error: 'blocked'
          })
        } catch (e) {
          logger.debug('postMessage featureResult blocked failed', e)
        }
        return
      }
      const data = http.isOk(status) && response.d ? response.d : null
      try {
        port.postMessage({
          type: 'featureResult',
          reqId: msg.reqId,
          data: data || null
        })
      } catch (e) {
        logger.debug('postMessage featureResult data failed', e)
      }
      return
    }
    let error = null
    if (status === 403) error = 'blocked'
    else if (!http.isOk(status)) error = 'send failed'
    try {
      port.postMessage({
        type: msg.type === 'send' ? 'sendResult' : 'featureResult',
        reqId: msg.reqId,
        error
      })
    } catch (e) {
      logger.debug('postMessage sendResult failed', e)
    }
  }
  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {object} msg
   * @param {MessagePort} port
   * @param {string} [clientKey]
   * @returns {void}
   */
  function onDataPortMessage(context, deviceId, msg, port, clientKey = 'window') {
    if (!msg) return
    if (msg.type === 'send' || msg.type === 'sendFeature' || msg.type === 'receiveFeature') {
      const action =
        msg.type === 'send'
          ? 'sendReport'
          : msg.type === 'sendFeature'
            ? 'sendFeatureReport'
            : 'receiveFeatureReport'
      markPageActionUsed(context.origin)
      const key = planeKeyForClient(context, deviceId, clientKey)
      if (fanoutCandidate && brokerAttachedKeys.has(key)) {
        handleWorkerReportResponse(msg, port, { s: 503 })
        return
      }
      const payload = { deviceId, reportId: msg.reportId }
      if (msg.type === 'send' || msg.type === 'sendFeature') payload.data = msg.data
      const reqId = allocateDataReqId()
      const request = Object.assign({ action, reqId }, payload)
      const dataPort = ensureRuntimeDataPort(deviceId)
      dataPending.set(reqId, { msg, port, key, deviceId })
      try {
        dataPort.postMessage(request)
      } catch {
        dataPending.delete(reqId)
        handleWorkerReportResponse(msg, port, { s: 500 })
      }
    }
  }

  /**
   * Respawns active planes for the requested origin and mode.
   * @param {string} dp
   * @param {string} origin
   * @returns {void}
   */
  function respawnPlanesForMode(dp, origin) {
    if (dp !== 'ws' && dp !== 'wt') return
    for (const context of frameContexts.values()) {
      if (context.origin !== origin) continue
      for (const { sessions } of sessionsForContext(context)) {
        const clientKey = clientKeyForSessions(sessions)
        const clientPort = clientPortForSessions(sessions)
        for (const [deviceId, token] of sessions) {
          const opts = { clientKey, clientPort, rewire: true }
          if (dp === 'wt' && wtPort != null) {
            spawnDataPlane(context, deviceId, token, null, {
              ...opts,
              wtPort,
              wtCertHash
            })
          } else {
            spawnDataPlane(context, deviceId, token, wsPort, opts)
          }
        }
      }
    }
  }

  /**
   * @param {string} dp
   * @param {string} origin
   * @returns {Promise<void>}
   */
  async function applyDataPlane(dp, origin) {
    const active = []
    for (const context of frameContexts.values()) {
      if (context.origin !== origin) continue
      for (const { sessions } of sessionsForContext(context)) {
        const clientKey = clientKeyForSessions(sessions)
        const clientPort = clientPortForSessions(sessions)
        for (const [deviceId, token] of sessions) {
          active.push({ context, deviceId, token, clientKey, clientPort })
        }
      }
    }
    for (const { context, deviceId, clientKey, clientPort } of active) {
      await despawnDataPlane(context, deviceId, {
        clientKey,
        clientPort,
        notifyUnavailable: true,
        unavailableReason: 'data plane switching'
      })
    }
    if (dp === 'nm') {
      for (const { context, deviceId, token, clientKey, clientPort } of active) {
        const key = planeKeyForClient(context, deviceId, clientKey)
        let response
        try {
          response = await sendBackgroundRequest(
            {
              action: 'setDataPlane',
              deviceId,
              mode: dp,
              sessionToken: token,
              frameKey: context.key,
              origin: context.origin,
              clientKey
            },
            context
          )
        } catch (e) {
          logger.debug('applyDataPlane failed for device', deviceId, e)
        }
        if (!response || !http.isOk(response.s)) {
          await despawnDataPlane(context, deviceId, { clientKey, clientPort })
          notifyPlaneUnavailable(key, spawnGen.get(key), 'live NM switch rejected')
          continue
        }
        const generation = beginPlaneGeneration(key)
        nmPlanes.add(key)
        const brokered = fanoutCandidate && brokerPairReady
        if (brokered) {
          const attached = await attachNmBroker(context, deviceId, token, clientKey, generation)
          if (!attached) {
            nmPlanes.delete(key)
            await despawnDataPlane(context, deviceId, { clientKey, clientPort })
            notifyPlaneUnavailable(key, generation, 'NM broker attach failed')
            continue
          }
        } else {
          ensureRuntimeDataPort(deviceId)
          markPlaneLocalReady(key, generation)
        }
        markPlaneAuthoritativeReady(key, generation)
        if (!brokered) {
          clientPort.postMessage({
            type: 'wireWorkerPort',
            deviceId,
            generation
          })
        }
      }
    } else {
      respawnPlanesForMode(dp, origin)
      for (const { context, deviceId, token, clientKey } of active) {
        sendBackgroundRequest(
          {
            action: 'setDataPlane',
            deviceId,
            mode: dp,
            sessionToken: token,
            frameKey: context.key,
            origin: context.origin,
            clientKey
          },
          context
        ).catch((e) => logger.debug('applyDataPlane failed for device', deviceId, e))
      }
    }
    logger.info('data plane changed:', dp, 'open devices:', active.length)
  }

  const settingsListenerSet = createSettingsListenerSet()
  /**
   * @param {string} origin
   * @param {import("./types.js").SettingsStore} store
   * @returns {void}
   */
  function installSettingsListeners(origin, store) {
    logger.bindSettings(store)
    settingsListenerSet.install(store, [
      [
        'hidePageAction',
        (hidden) => {
          if (!hidden) pageActionMarked = false
        }
      ],
      ['dataPlane', (dp) => applyDataPlane(dp, origin)],
      [
        'workerSpawnMode',
        () => {
          cachedSpawnModes.delete(origin)
          applyDataPlane(store.dataPlane, origin)
        }
      ],
      ['useWorker', () => applyDataPlane(store.dataPlane, origin)],
      [
        ['dataPlane', 'logLevel'],
        () => {
          const all = store.getAll()
          const patch = { dataPlane: all.dataPlane, logLevel: all.logLevel }
          for (const [port, context] of frameContextByPort) {
            if (context.origin === origin) port.postMessage({ type: 'settings', settings: patch })
          }
          for (const [key, entry] of workers) {
            const context = contextForPlaneKey(key)
            if (context && context.origin === origin && entry.worker) {
              entry.worker.postMessage({ type: 'settings', ...patch })
            }
          }
        }
      ]
    ])
  }

  function wireStorageListener() {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      for (const [key, change] of Object.entries(changes)) {
        const parsed = parseSettingsKey(key)
        if (!parsed) continue
        if (parsed.scope === 'global') {
          for (const store of settingsByOrigin.values()) {
            store.set({ [parsed.name]: change.newValue })
          }
        } else if (persistentOrigin && parsed.origin === persistentOrigin) {
          settingsForOrigin(authorityOrigin).set({ [parsed.name]: change.newValue })
        }
      }
    })
  }
  function wireAllowedDevicesListener() {
    browser.runtime.onMessage.addListener((message) => {
      if (
        message.action === 'allowedDevicesChanged' &&
        Array.isArray(message.deviceIds) &&
        message.persistentOrigin === persistentOrigin
      ) {
        const origin = message.persistentOrigin
        allowedByOrigin.set(
          origin,
          new Set(message.deviceIds.map((deviceId) => String(deviceId)))
        )
        loadedOrigins.add(origin)
        flushAllowedDeviceIdsQueue(origin)
      }
    })
  }
  startLocal()
})()
