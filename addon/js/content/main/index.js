;(function () {
  /** @type {import("./types.js").Logger} */
  const webhid = globalThis.webhid

  /** @type {import("./types.js").Logger} */
  const logger = webhid.import('logger')
  const pristine = webhid.import('pristine')
  const { object, reflect, types, host } = pristine
  const NativeWindow = types.Window && types.Window.constructor
  const windowObject = host.window
  const isWorker =
    typeof windowObject === 'undefined' || !NativeWindow || !(windowObject instanceof NativeWindow)
  if (!isWorker && !host.windowIsSecureContext) {
    webhid.import('logger').warn('NO POLYFILL')
    return
  }

  const http = webhid.import('http')
  const isChromium = webhid.import('isChromium')
  const GLOBAL_DEFAULTS = webhid.import('GLOBAL_DEFAULTS')
  const createSettingsStore = webhid.import('createSettingsStore')
  const isValidFilter = webhid.import('isValidFilter')
  const createWtTransport = webhid.import('createWtTransport')
  const NativeMap = types.Map.constructor
  const NativeWeakMap = types.WeakMap.constructor
  const NativeArrayBuffer = types.ArrayBuffer.constructor
  const NativeArray = types.Array.constructor
  const NativeDataView = types.DataView.constructor
  const NativeUint8Array = types.Uint8Array.constructor
  const NativeEventTarget = types.EventTarget.constructor
  const NativeMessageChannel = types.MessageChannel.constructor
  const NativeFunction = types.Function.constructor
  const NativeWorker = types.Worker ? types.Worker.constructor : null
  const NativeBlob = types.Blob ? types.Blob.constructor : null
  const NativeEvent = types.Event ? types.Event.constructor : null
  const nativeEventStopImmediatePropagation = types.Event
    ? types.Event.getDescriptor('stopImmediatePropagation').value
    : null
  const nativeEventCurrentTarget = types.Event
    ? types.Event.getDescriptor('currentTarget').get
    : null
  const nativeEventPreventDefault = types.Event
    ? types.Event.getDescriptor('preventDefault').value
    : null
  const nativeSymbolIterator = types.Symbol.getStaticDescriptor('iterator').value
  const nativeSymbolToStringTag = types.Symbol.getStaticDescriptor('toStringTag').value
  const NativeDOMException = types.DOMException ? types.DOMException.constructor : null
  const NativeError = types.Error.constructor
  const NativeTypeError = types.TypeError.constructor
  const TypeError = NativeTypeError
  const NativeObject = types.Object.constructor
  const NativePromise = types.Promise.constructor
  const Promise = NativePromise
  const nativePromiseResolve = types.Promise.getStaticDescriptor('resolve').value
  const nativePromiseReject = types.Promise.getStaticDescriptor('reject').value
  const mapOps = types.Map.proto.methods
  const weakMapOps = types.WeakMap.proto.methods
  const eventTargetOps = types.EventTarget.proto.methods
  const nativeMessagePortPostMessage = types.MessagePort.getDescriptor('postMessage').value
  const nativeMessagePortAddEventListener =
    types.MessagePort.getDescriptor('addEventListener').value
  const nativeMessagePortRemoveEventListener =
    types.MessagePort.getDescriptor('removeEventListener').value
  const nativeMessagePortClose = types.MessagePort.getDescriptor('close').value
  const nativeMessagePortStart = types.MessagePort.getDescriptor('start').value
  const messageEventDataDescriptor = types.MessageEvent
    ? types.MessageEvent.getDescriptor('data')
    : null
  const messageEventSourceDescriptor = types.MessageEvent
    ? types.MessageEvent.getDescriptor('source')
    : null
  const messageEventPortsDescriptor = types.MessageEvent
    ? types.MessageEvent.getDescriptor('ports')
    : null
  const nativeMessageEventData = messageEventDataDescriptor && messageEventDataDescriptor.get
  const nativeMessageEventSource = messageEventSourceDescriptor && messageEventSourceDescriptor.get
  const nativeMessageEventPorts = messageEventPortsDescriptor && messageEventPortsDescriptor.get
  const nativeWorkerPostMessage = types.Worker
    ? types.Worker.getDescriptor('postMessage').value
    : null
  const nativeWorkerAddEventListener = types.Worker
    ? types.Worker.getDescriptor('addEventListener').value
    : null
  const nativeWorkerTerminate = types.Worker ? types.Worker.getDescriptor('terminate').value : null
  const nativeWindowAddEventListener = host.windowAddEventListener
  const nativeWindowRemoveEventListener = host.windowRemoveEventListener
  const nativeCreateObjectURL = host.url.createObjectURL
  const nativeRevokeObjectURL = host.url.revokeObjectURL
  const nativeCryptoRandomUUID = host.cryptoRandomUUID
  const nativeSetTimeout = host.timers.setTimeout
  const nativeSelfPostMessage = host.postMessage
  const ArrayBuffer = NativeArrayBuffer
  const DataView = NativeDataView
  const Uint8Array = NativeUint8Array
  const EventTarget = NativeEventTarget
  const Event = NativeEvent
  const Object = NativeObject
  const arrayIsArray = types.Array.getStaticDescriptor('isArray').value
  const arrayOps = types.Array.proto.methods
  const nativeArrayIterator = nativeSymbolIterator ? arrayOps[nativeSymbolIterator] : null
  const stringOps = types.String.proto.methods
  const nativeClearTimeout = host.timers.clearTimeout
  const nativeCreateTrustedTypePolicy = host.trustedTypesCreatePolicy
  const nativeUserActivation = host.userActivation
  const nativeIsActiveGetter = host.userActivationIsActive
  const nativeNavigatorUserAgent = host.navigatorUserAgent
  const arrayBufferGetters = types.ArrayBuffer.proto.getters
  const dataViewGetters = types.DataView.proto.getters
  const uint8ArrayGetters = types.Uint8Array.proto.getters
  const nativeArrayBufferIsView = types.ArrayBuffer.getStaticDescriptor('isView').value
  const callNative = (fn, receiver, ...args) => reflect.apply(fn, receiver, args)
  const rejectWebIDLPromise = (error) => callNative(nativePromiseReject, NativePromise, error)
  /**
   * Defines the required non-enumerable interface prototype constructor.
   *
   * @param {object} prototype
   * @param {Function} constructor
   * @returns {void}
   */
  function defineInterfacePrototypeConstructor(prototype, constructor) {
    object.defineProperty(prototype, 'constructor', {
      value: constructor,
      writable: true,
      enumerable: false,
      configurable: true
    })
  }
  const readMessageEventData = (event) =>
    nativeMessageEventData ? callNative(nativeMessageEventData, event) : undefined
  const readMessageEventSource = (event) =>
    nativeMessageEventSource ? callNative(nativeMessageEventSource, event) : null
  const readMessageEventPorts = (event) =>
    nativeMessageEventPorts ? callNative(nativeMessageEventPorts, event) : null
  const nativeBind = types.Function.proto.methods.bind
  const permissionsObject = host.permissions
  /**
   * Gives an internal array an iterator that remains independent of page patches.
   * @param {Array} items
   * @returns {Array}
   */
  function makePristineIterable(items) {
    if (!nativeSymbolIterator || !nativeArrayIterator) return items
    object.defineProperty(items, nativeSymbolIterator, {
      value: () => nativeArrayIterator(items),
      writable: false,
      enumerable: false,
      configurable: false
    })
    return items
  }
  const executionLocationHref = isWorker ? host.selfHref : host.windowHref
  const trustedTypes = host.trustedTypes
  const Navigator = types.Navigator ? types.Navigator.constructor : null
  const TrustedTypePolicy = types.TrustedTypePolicy ? types.TrustedTypePolicy.constructor : null
  const nativeNavigatorHidDescriptor =
    !isWorker && Navigator ? object.getOwnPropertyDescriptor(Navigator.prototype, 'hid') : null
  const nativePermissionsQuery =
    host.permissionsQuery ||
    (permissionsObject && typeof permissionsObject.query === 'function'
      ? nativeBind(permissionsObject.query, permissionsObject)
      : null)
  const promiseOps = types.Promise.proto.methods
  const stringConstructor = types.String.constructor
  const uint8Ops = types.Uint8Array.proto.methods
  const nativeNumberIsFinite = host.numberIsFinite
  const nativeNumberIsInteger = host.numberIsInteger
  const nativeMathTrunc = host.mathTrunc
  const nativeJsonStringify = host.jsonStringify
  /**
   * Replaces Map instance methods with captured intrinsic operations.
   * @param {Map} value
   * @returns {Map}
   */
  function hardenMap(value) {
    object.defineProperties(value, {
      get: { value: (key) => mapOps.get(value, key) },
      set: { value: (key, item) => mapOps.set(value, key, item) },
      delete: { value: (key) => mapOps.delete(value, key) },
      has: { value: (key) => mapOps.has(value, key) },
      forEach: { value: (callback, receiver) => mapOps.forEach(value, callback, receiver) },
      entries: { value: () => mapOps.entries(value) },
      values: { value: () => mapOps.values(value) },
      keys: { value: () => mapOps.keys(value) },
      size: { get: () => types.Map.proto.getters.size(value) }
    })
    return value
  }

  /**
   * Replaces WeakMap instance methods with captured intrinsic operations.
   * @param {WeakMap} value
   * @returns {WeakMap}
   */
  function hardenWeakMap(value) {
    object.defineProperties(value, {
      get: { value: (key) => weakMapOps.get(value, key) },
      set: { value: (key, item) => weakMapOps.set(value, key, item) },
      delete: { value: (key) => weakMapOps.delete(value, key) },
      has: { value: (key) => weakMapOps.has(value, key) }
    })
    return value
  }
  /**
   * Returns the internal state for a branded interface receiver.
   *
   * @param {WeakMap<object, object>} stateMap
   * @param {*} receiver
   * @returns {object}
   * @throws {TypeError}
   */
  function requireState(stateMap, receiver) {
    const state = stateMap.get(receiver)
    if (state == null) throw new TypeError('Illegal invocation')
    return state
  }

  /**
   * @param {object} state
   * @returns {boolean}
   */
  function isDeviceOpeningOrOpen(state) {
    return state.connectionState === 'opening' || state.connectionState === 'opened'
  }

  reflect.deleteProperty(globalThis, 'webhid')

  /**
   * Reports whether the captured user activation is currently active.
   * @returns {boolean}
   */
  function hasTransientActivation() {
    return nativeIsActiveGetter && nativeUserActivation ? nativeIsActiveGetter() : false
  }

  logger.initLogger('polyfill')

  /** @type {Function|null} */
  let ttFactory = null
  let hidInstance = null
  let brokerStackOtp = null
  let brokerSetterArmed = false
  let ttReady = Promise.resolve(true)

  /** @type {Map<string, object>} */
  const inPagePlanes = hardenMap(new NativeMap())

  const {
    MSG_SEND_REPORT,
    MSG_SEND_FEATURE_REPORT,
    MSG_RECEIVE_FEATURE_REPORT,
    MSG_INPUT_BATCH,
    parseInputReports,
    buildSendFrame,
    handleControlResponse: handleControlResponseShared
  } = webhid.import('wireFormat')
  /** @type {Map<number, {deviceId: string, resolve: Function, reject: Function}>} */
  const inPagePending = hardenMap(new NativeMap())

  /**
   * @param {object} req
   * @returns {void}
   */
  function handleDataPlaneConnect(req) {
    const deviceId = req.deviceId
    const generation = req.generation
    const device = deviceId ? deviceRegistry.get(deviceId) : null
    const state = device ? devState.get(device) : null
    if (state && typeof generation === 'number') {
      if (
        generation < state.planeGeneration ||
        (generation === state.planeGeneration && state.planeReady)
      ) {
        callNative(nativeMessagePortPostMessage, bridgePort, {
          type: 'dataPlaneResponse',
          id: req.id,
          result: { ok: false, error: 'stale data plane generation' }
        })
        return
      }
      state.planeGeneration = generation
      state.planeReady = false
      state.planeUnavailable = true
      state.planeUnavailableGeneration = null
    }
    let readyNotified = false
    const wt = createWtTransport({
      onReady: () => {
        if (readyNotified) return
        readyNotified = true
        callNative(nativeMessagePortPostMessage, bridgePort, {
          type: 'dataPlaneResponse',
          id: req.id,
          result: { ok: true }
        })
      },
      onClosed: (info) => {
        const current = inPagePlanes.get(deviceId)
        if (!current || current.generation !== generation) return
        rejectInPagePending(deviceId, new NativeError('data plane closed'))
        if (info && info.willReconnect) return
        inPagePlanes.delete(deviceId)
        callNative(nativeMessagePortPostMessage, bridgePort, {
          type: 'dataPlaneEvent',
          deviceId,
          generation,
          event: { type: 'closed' }
        })
      },
      onAuthFailed: (code) => {
        const current = inPagePlanes.get(deviceId)
        if (!current || current.generation !== generation) return
        inPagePlanes.delete(deviceId)
        rejectInPagePending(deviceId, new NativeError('auth failed'))
        callNative(nativeMessagePortPostMessage, bridgePort, {
          type: 'dataPlaneEvent',
          deviceId,
          generation,
          event: { type: 'auth-failed', code }
        })
      },
      onBinary: (batch) => {
        const current = inPagePlanes.get(deviceId)
        if (!current || current.generation !== generation) return
        if (batch.length > 0 && batch[0] >= 0x81)
          return handleControlResponseShared(batch, inPagePending)
        const offset = batch.length > 0 && batch[0] === MSG_INPUT_BATCH ? 1 : 0
        pushInPageBatch(deviceId, batch, offset)
      }
    })
    inPagePlanes.set(deviceId, { wt, deviceId, generation })
    wt.connect(req.payload || {})
  }

  /**
   * @param {string} deviceId
   * @param {Uint8Array} batch
   * @param {number} offset
   * @returns {void}
   */
  function pushInPageBatch(deviceId, batch, offset) {
    const reports = parseInputReports(batch, offset)
    for (let i = 0; i < reports.length; i++) {
      const r = reports[i]
      dispatchDeviceEvent({
        eventType: 'input_report',
        deviceId,
        reportId: r.reportId,
        data: r.data
      })
    }
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleDataPlaneDisconnect(data) {
    const plane = inPagePlanes.get(data.deviceId)
    if (plane && (typeof data.generation !== 'number' || plane.generation === data.generation)) {
      if (plane.wt) plane.wt.disconnect()
      inPagePlanes.delete(data.deviceId)
      rejectInPagePending(data.deviceId, new NativeError('data plane closed'))
    }
  }

  /**
   * Rejects every in-flight in-page plane request for a device.
   * @param {string} deviceId
   * @param {Error} error
   * @returns {void}
   */
  function rejectInPagePending(deviceId, error) {
    inPagePending.forEach((entry, reqId) => {
      if (entry.deviceId === deviceId) {
        inPagePending.delete(reqId)
        entry.reject(error)
      }
    })
  }

  /**
   * Sends a request frame over an in-page plane and resolves on the daemon
   * ack. Returns null when the plane is not usable, so the caller falls back
   * to the data port (NM) path.
   * @param {object} plane
   * @param {number} msgType
   * @param {number} reportId
   * @param {Uint8Array|null} payload
   * @param {(data?: Uint8Array) => unknown} mapResolve
   * @returns {Promise<unknown>|null}
   */
  function inPageRequest(plane, msgType, reportId, payload, mapResolve) {
    if (!plane || !plane.wt || !plane.wt.isOpen()) return null
    const reqId = ++nextReqId
    const frame = buildSendFrame(msgType, reqId, reportId, payload)
    return new Promise((resolve, reject) => {
      inPagePending.set(reqId, {
        deviceId: plane.deviceId,
        resolve: (data) => resolve(mapResolve(data)),
        reject: (e) => {
          if (e instanceof NativeDOMException) {
            reject(e)
          } else if (e && e.blocked) {
            reject(new NativeDOMException('Report is blocked', 'NotAllowedError'))
          } else {
            reject(
              new NativeDOMException((e && e.message) || e || 'request failed', 'NetworkError')
            )
          }
        }
      })
      if (!plane.wt.send(frame)) {
        inPagePending.delete(reqId)
        reject(new NativeDOMException('wt not open', 'NetworkError'))
      }
    })
  }

  /** @type {Map<string, {worker: Worker, generation: number}>} */
  const mainWorldWorkers = hardenMap(new NativeMap())

  /**
   * @param {object} req
   * @returns {Promise<{result: object, transfer: object|null}>}
   */
  async function handleSpawnWorkerRequest(req) {
    const payload = req.payload || {}
    if (payload.mode === 'terminate') {
      const existing = mainWorldWorkers.get(payload.deviceId)
      if (!existing || (payload.generation != null && existing.generation !== payload.generation))
        return { result: { ok: true }, transfer: null }
      callNative(nativeWorkerTerminate, existing.worker)
      if (mainWorldWorkers.get(payload.deviceId) === existing) {
        mainWorldWorkers.delete(payload.deviceId)
      }
      return { result: { ok: true }, transfer: null }
    }
    if (!(await ttReady)) {
      return { result: { ok: false, error: 'Trusted Types policy unavailable' }, transfer: null }
    }
    const makeUrl = ttFactory || ((s) => s)
    let worker
    try {
      if (payload.mode === 'blob') {
        if (!NativeBlob || !nativeCreateObjectURL) {
          return { result: { ok: false, error: 'Blob URL creation unavailable' }, transfer: null }
        }
        const blobUrl = nativeCreateObjectURL(
          new NativeBlob(makePristineIterable([payload.bundleText || '']), {
            type: 'application/javascript'
          })
        )
        try {
          worker = new NativeWorker(makeUrl(blobUrl))
        } catch (e) {
          nativeRevokeObjectURL(blobUrl)
          throw e
        }
      } else {
        await sendRequest('armShadowSpawn', { url: executionLocationHref }, { timeoutMs: 2000 })
        worker = new NativeWorker(makeUrl(executionLocationHref))
      }
    } catch (e) {
      sendRequest('unarmShadowSpawn', { url: executionLocationHref }, { timeoutMs: 500 })
      return { result: { ok: false, error: stringConstructor(e && e.message) }, transfer: null }
    }
    const previous = mainWorldWorkers.get(payload.deviceId)
    if (previous && previous.worker !== worker) callNative(nativeWorkerTerminate, previous.worker)
    const entry = { worker, generation: payload.generation }
    mainWorldWorkers.set(payload.deviceId, entry)
    worker.onerror = (event) => {
      logger.debug('worker error:', event && event.message)
      if (mainWorldWorkers.get(payload.deviceId) === entry) {
        mainWorldWorkers.delete(payload.deviceId)
        sendRequest('unarmShadowSpawn', { url: executionLocationHref }, { timeoutMs: 500 })
        if (bridgePort) {
          callNative(nativeMessagePortPostMessage, bridgePort, {
            type: 'workerError',
            deviceId: payload.deviceId,
            generation: payload.generation,
            message: (event && event.message) || 'unknown'
          })
        }
      }
    }
    return { result: { ok: true }, transfer: null }
  }

  /**
   * Wires the data and control channels for an open device to its (possibly
   * freshly spawned) worker. Called both from the polyfill's open() and from
   * the bridge's wireWorkerPort message, which the bridge sends after spawning
   * a replacement worker on a data-plane switch (the device is already open,
   * so open() will not run again). Closes a stale data port before replacing it.
   * @param {object} state
   * @param {number} generation
   * @returns {void}
   */
  function wireDevicePort(state, generation = state.planeGeneration) {
    if (state.dataPort && state.dataPortGeneration === generation) return
    if (state.dataPort) {
      rejectPendingReports(state, new NativeDOMException('Data plane replaced', 'NetworkError'))
      detachDataPort(state)
    }
    const generationChanged = generation !== state.planeGeneration
    state.planeGeneration = generation
    state.planeReady = false
    if (generationChanged) state.planeUnavailableGeneration = null
    if (state.connectionState === 'opened') state.planeUnavailable = true
    const dataChannel = new NativeMessageChannel()
    state.dataPort = dataChannel.port1
    state.dataPortGeneration = generation
    state.dataPortHandler = (event) => onDataPortMessage(state, readMessageEventData(event))
    callNative(nativeMessagePortAddEventListener, state.dataPort, 'message', state.dataPortHandler)
    callNative(nativeMessagePortStart, state.dataPort)
    const workerEntry = mainWorldWorkers.get(state.deviceId)
    const worker = workerEntry && workerEntry.worker
    const payload = { deviceId: state.deviceId, generation }
    if (worker) {
      const controlChannel = new NativeMessageChannel()
      callNative(
        nativeWorkerPostMessage,
        worker,
        { type: 'setPorts', controlPort: controlChannel.port2, dataPort: dataChannel.port2 },
        makePristineIterable([controlChannel.port2, dataChannel.port2])
      )
      callNative(
        nativeMessagePortPostMessage,
        bridgePort,
        { id: 0, action: 'dataPort', payload: object.assign({}, payload) },
        makePristineIterable([controlChannel.port1])
      )
    } else {
      callNative(
        nativeMessagePortPostMessage,
        bridgePort,
        { id: 0, action: 'dataPort', payload },
        makePristineIterable([dataChannel.port2])
      )
    }
  }
  /**
   * @param {object} state
   * @returns {void}
   */
  function detachDataPort(state) {
    if (!state.dataPort) {
      state.dataPortGeneration = null
      return
    }
    try {
      if (state.dataPortHandler) {
        callNative(
          nativeMessagePortRemoveEventListener,
          state.dataPort,
          'message',
          state.dataPortHandler
        )
        state.dataPortHandler = null
      }
      callNative(nativeMessagePortClose, state.dataPort)
    } catch (e) {
      logger.debug('close dataPort failed', e)
    }
    state.dataPort = null
    state.dataPortGeneration = null
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleDataPlaneReady(data) {
    const device = data.deviceId ? deviceRegistry.get(data.deviceId) : null
    const state = device ? devState.get(device) : null
    if (
      !state ||
      typeof data.generation !== 'number' ||
      data.generation !== state.planeGeneration ||
      state.planeUnavailableGeneration === data.generation ||
      !isDeviceOpeningOrOpen(state)
    ) {
      return
    }
    state.planeGeneration = data.generation
    state.planeReady = true
    state.planeUnavailable = false
    state.planeUnavailableGeneration = null
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleDataPlaneUnavailable(data) {
    const device = data.deviceId ? deviceRegistry.get(data.deviceId) : null
    const state = device ? devState.get(device) : null
    if (
      !state ||
      typeof data.generation !== 'number' ||
      data.generation < state.planeGeneration ||
      !isDeviceOpeningOrOpen(state)
    )
      return
    state.planeGeneration = data.generation
    state.planeReady = false
    state.planeUnavailable = true
    state.planeUnavailableGeneration = data.generation
    rejectPendingReports(
      state,
      new NativeDOMException(data.reason || 'Data plane unavailable', 'NetworkError')
    )
    detachDataPort(state)
  }

  /**
   * @param {{deviceId?: string}} data
   * @returns {void}
   */
  function handleWireWorkerPort(data) {
    const device = data.deviceId ? deviceRegistry.get(data.deviceId) : null
    const state = device ? devState.get(device) : null
    if (
      !state ||
      !isDeviceOpeningOrOpen(state) ||
      typeof data.generation !== 'number' ||
      data.generation < state.planeGeneration
    )
      return
    wireDevicePort(state, data.generation)
  }
  /**
   * Installs the top-owned NM data port for a brokered child attachment.
   * @param {object} data
   * @param {MessagePort[]} ports
   * @returns {void}
   */
  function handleBrokerDataPortMessage(data, ports) {
    const device = data.deviceId ? deviceRegistry.get(data.deviceId) : null
    const state = device ? devState.get(device) : null
    const port = ports && ports[0]
    const validGeneration =
      state &&
      typeof data.generation === 'number' &&
      Number.isInteger(data.generation) &&
      ((state.connectionState === 'opening' &&
        (state.planeGeneration === 0 || data.generation === state.planeGeneration)) ||
        (state.connectionState === 'opened' && data.generation >= state.planeGeneration))
    if (
      !state ||
      !port ||
      !validGeneration ||
      state.planeUnavailableGeneration === data.generation ||
      !isDeviceOpeningOrOpen(state)
    ) {
      if (port) {
        try {
          callNative(nativeMessagePortClose, port)
        } catch {
          void 0
        }
      }
      return
    }
    if (state.dataPort && state.dataPortGeneration === data.generation) {
      try {
        callNative(nativeMessagePortClose, port)
      } catch {
        void 0
      }
      return
    }
    state.planeGeneration = data.generation
    if (state.dataPort) {
      rejectPendingReports(state, new NativeDOMException('Data plane replaced', 'NetworkError'))
      detachDataPort(state)
    }
    state.dataPort = port
    state.dataPortGeneration = data.generation
    state.dataPortHandler = (event) => onDataPortMessage(state, readMessageEventData(event))
    callNative(nativeMessagePortAddEventListener, state.dataPort, 'message', state.dataPortHandler)
    callNative(nativeMessagePortStart, state.dataPort)
  }
  /**
   * @param {object} data
   * @returns {void}
   */
  function handleBrokerDataPortUnavailable(data) {
    const device = data.deviceId ? deviceRegistry.get(data.deviceId) : null
    const state = device ? devState.get(device) : null
    if (
      !state ||
      typeof data.generation !== 'number' ||
      state.dataPortGeneration !== data.generation
    )
      return
    state.planeReady = false
    state.planeUnavailable = true
    state.planeUnavailableGeneration = data.generation
    rejectPendingReports(state, new NativeDOMException('Data plane unavailable', 'NetworkError'))
    detachDataPort(state)
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} [ports]
   * @returns {void}
   */
  function handleBrokerDataPort(data, ports) {
    handleBrokerDataPortMessage(data, ports || [])
  }

  /** @returns {void} */
  function setupTrustedTypesSharing() {
    if (typeof trustedTypes === 'undefined' || trustedTypes === null) return
    if (!nativeCreateTrustedTypePolicy) return
    let captured = false
    let resolveReady
    ttReady = new Promise((resolve) => {
      resolveReady = resolve
    })
    const markCaptured = (policy) => {
      if (captured) return
      captured = true
      const createScriptURL = nativeBind(policy.createScriptURL, policy)
      ttFactory = (url) => createScriptURL(url)
      resolveReady(true)
    }
    const baseRules = {
      createScriptURL: (s) => s,
      createHTML: (s) => s,
      createScript: (s) => s
    }
    const claim = (name) => {
      try {
        return nativeCreateTrustedTypePolicy(name, baseRules)
      } catch {
        return null
      }
    }

    trustedTypes.createPolicy = function (claimedName, pageRules) {
      if (captured) return nativeCreateTrustedTypePolicy(claimedName, pageRules)
      const policy = nativeCreateTrustedTypePolicy(claimedName, baseRules)
      markCaptured(policy)
      return makeWrappedPolicy(policy, claimedName, pageRules)
    }

    const cspRequest = promiseOps.then(sendRequest('getCspInfo'), (info) => {
      if (captured) return
      const names = arrayIsArray(info && info.trustedTypesNames) ? info.trustedTypesNames : []
      const candidates = names.length ? names : ['webhid-worker']
      for (let i = 0; i < candidates.length; i++) {
        const name = candidates[i]
        if (typeof name !== 'string' || name === "'none'" || name === "'allow-duplicates'") continue
        const policy = claim(name)
        if (policy) {
          markCaptured(policy)
          installTtSharing(name, policy, nativeCreateTrustedTypePolicy)
          return
        }
      }
      resolveReady(!(info && info.hasTrustedTypesRequire))
    })
    promiseOps.catch(cspRequest, () => resolveReady(true))
  }

  /**
   * @param {object} policy
   * @param {string} name
   * @param {object} [pageRules]
   * @returns {object}
   */
  function makeWrappedPolicy(policy, name, pageRules) {
    const proto = TrustedTypePolicy ? types.TrustedTypePolicy.prototype : types.Object.prototype
    const wrapperProto = object.create(proto)
    const wrapper = object.create(wrapperProto)
    const rules = pageRules || {}
    const define = (target, prop, value) => {
      object.defineProperty(target, prop, {
        value,
        writable: false,
        enumerable: false,
        configurable: false
      })
    }
    const defineMissing = (method) => {
      define(wrapperProto, method, () => {
        throw new TypeError('TrustedTypePolicy.' + method + ': Function missing.')
      })
    }
    define(wrapper, 'name', name)
    if (
      typeof rules.createScriptURL === 'function' &&
      typeof policy.createScriptURL === 'function'
    ) {
      const pageFn = rules.createScriptURL
      const origScriptURL = nativeBind(policy.createScriptURL, policy)
      define(wrapper, 'createScriptURL', (s) => origScriptURL(pageFn(s)))
    } else {
      defineMissing('createScriptURL')
    }
    const methods = ['createHTML', 'createScript']
    for (let i = 0; i < methods.length; i++) {
      const m = methods[i]
      if (typeof rules[m] === 'function' && typeof policy[m] === 'function') {
        const pageFn = rules[m]
        const orig = nativeBind(policy[m], policy)
        define(wrapper, m, (s) => orig(pageFn(s)))
      } else if (typeof rules[m] !== 'function') {
        defineMissing(m)
      }
    }
    return wrapper
  }

  /**
   * @param {string} name
   * @param {object} policy
   * @param {Function} nativeCreateTrustedTypePolicy
   * @returns {void}
   */
  function installTtSharing(name, policy, nativeCreateTrustedTypePolicy) {
    let usedOnce = false
    trustedTypes.createPolicy = function (claimedName, pageRules) {
      if (claimedName === name && !usedOnce) {
        usedOnce = true
        return makeWrappedPolicy(policy, name, pageRules)
      }
      return nativeCreateTrustedTypePolicy(claimedName, pageRules)
    }
    ttFactory = (url) => policy.createScriptURL(url)
  }

  let getOriginalStack
  if (!isWorker) {
    const stackDescriptor = types.Error.getDescriptor('stack')
    getOriginalStack = stackDescriptor && stackDescriptor.get
  }

  /** @returns {boolean} */
  function isCalledFromConsole() {
    if (isWorker) return false
    try {
      throw new NativeError()
    } catch (error) {
      const stack = getOriginalStack ? callNative(getOriginalStack, error) : ''
      if (typeof stack !== 'string') return false
      const lines = stringOps.split(stack, '\n')
      const callerFrame = arrayOps.at(lines, 2) || ''
      return stringOps.includes(callerFrame, 'debugger eval code')
    }
  }

  /** @type {number} */
  let nextReqId = 0
  /** @type {{object}} */
  const pending = {}
  if (!nativeCryptoRandomUUID) {
    throw new NativeError('WebHID polyfill requires crypto.randomUUID (secure context)')
  }
  /** @type {string} */
  const frameNonce = nativeCryptoRandomUUID()

  /** @type {MessagePort|null} */
  let bridgePort = null
  /**
   * Whether this document is a same-origin non-top frame eligible for a
   * private top-owned NM broker. Uses only browser-owned frame relationships,
   * never page-visible state.
   * @returns {boolean}
   */
  function sameOriginTopCandidate() {
    if (isWorker || windowObject === host.windowTop) return false
    const origin = host.windowOrigin
    if (!origin || origin === 'null') return false
    if (host.windowTopOrigin !== origin) return false
    return true
  }
  const fanoutCandidate = sameOriginTopCandidate()
  const bridgeReady = isWorker
    ? (() => {
        const ch = new NativeMessageChannel()
        bridgePort = ch.port1
        setupBridgePort()
        if (nativeSelfPostMessage) nativeSelfPostMessage(null, makePristineIterable([ch.port2]))
        return Promise.resolve()
      })()
    : isChromium
      ? new Promise((resolve) => {
          const onBridgeMessage = (event) => {
            const source = readMessageEventSource(event)
            const data = readMessageEventData(event)
            const ports = readMessageEventPorts(event)
            const directPort = data && data.directPort ? data.directPort : ports && ports[0]
            if (source !== windowObject || !directPort) return
            nativeWindowRemoveEventListener(windowObject, 'message', onBridgeMessage)
            brokerStackOtp = data && typeof data.S === 'string' ? data.S : null
            bridgePort = directPort
            setupBridgePort()
            if (fanoutCandidate || brokerStackOtp) armBrokerCandidateSetter()
            resolve()
          }
          nativeWindowAddEventListener(windowObject, 'message', onBridgeMessage)
        })
      : new Promise((resolve) => {
          const capturePageBridge = (candidate) => {
            const directPort = candidate && candidate.directPort ? candidate.directPort : candidate
            if (!directPort) return
            try {
              reflect.deleteProperty(globalThis, 'webhid')
              brokerStackOtp = candidate && typeof candidate.S === 'string' ? candidate.S : null
              bridgePort = directPort
              setupBridgePort()
              if (fanoutCandidate || brokerStackOtp) armBrokerCandidateSetter()
              resolve()
            } catch {
              bridgePort = null
            }
          }
          try {
            capturePageBridge(windowObject.webhid)
          } catch {
            void 0
          }
          object.defineProperty(windowObject, 'webhid', {
            configurable: true,
            set: capturePageBridge
          })
        })
  if (!isWorker) setupTrustedTypesSharing()

  /** @returns {void} */
  function setupBridgePort() {
    if (!bridgePort) return
    callNative(nativeMessagePortAddEventListener, bridgePort, 'message', (event) => {
      const data = readMessageEventData(event)
      const ports = readMessageEventPorts(event)
      if (!data) return
      const handler = BRIDGE_MESSAGE_HANDLERS[data.type]
      if (handler) handler(data, ports)
    })
    callNative(nativeMessagePortStart, bridgePort)
  }

  if (!isWorker) {
    let lifecycleNotified = false
    const notifyFrameDestroyed = () => {
      brokerStackOtp = null
      brokerSetterArmed = false
      if (Navigator && fanoutCandidate) installNavigatorHid()
      if (lifecycleNotified || !bridgePort) return
      lifecycleNotified = true
      callNative(nativeMessagePortPostMessage, bridgePort, { type: 'frameDestroyed' })
    }
    callNative(nativeWindowAddEventListener, windowObject, 'pagehide', notifyFrameDestroyed)
    callNative(nativeWindowAddEventListener, windowObject, 'unload', notifyFrameDestroyed)
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleSpawnWorkerMessage(data) {
    promiseOps.then(handleSpawnWorkerRequest(data), (r) => {
      const msg = { type: 'spawnWorkerResponse', id: data.id, result: r.result }
      if (r.transfer) {
        callNative(
          nativeMessagePortPostMessage,
          bridgePort,
          msg,
          makePristineIterable([r.transfer])
        )
      } else {
        callNative(nativeMessagePortPostMessage, bridgePort, msg)
      }
    })
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleResponseMessage(data) {
    const entry = pending[data.id]
    if (entry) {
      delete pending[data.id]
      entry.handler(data.result)
    }
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function stackToken(value) {
    return stringOps.replace(value, /[^A-Za-z0-9]/g, '_')
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} [ports]
   * @returns {void}
   */
  function handleFanoutBrokerCandidate(data, ports) {
    const port = ports && ports[0]
    if (!port || !nativeNumberIsInteger(data.frameIndex) || typeof data.stackOtp !== 'string') {
      if (port) callNative(nativeMessagePortClose, port)
      return
    }
    const nav = host.windowFrameNavigator(data.frameIndex)
    if (!nav) {
      callNative(nativeMessagePortClose, port)
      return
    }
    try {
      const invoke = new NativeFunction(
        'nav',
        'value',
        'nav.hid = value\n//# sourceURL=webhidBroker_' + stackToken(data.stackOtp)
      )
      object.defineProperty(invoke, 'name', {
        value: 'webhidBroker_' + stackToken(data.stackOtp),
        configurable: false
      })
      callNative(invoke, null, nav, port)
    } catch {
      callNative(nativeMessagePortClose, port)
    }
  }
  /** @type {object} */
  const BRIDGE_MESSAGE_HANDLERS = {
    dataPlaneConnect: handleDataPlaneConnect,
    dataPlaneDisconnect: handleDataPlaneDisconnect,
    dataPlaneReady: handleDataPlaneReady,
    dataPlaneUnavailable: handleDataPlaneUnavailable,
    spawnWorkerRequest: handleSpawnWorkerMessage,
    wireWorkerPort: handleWireWorkerPort,
    brokerDataPort: handleBrokerDataPort,
    brokerDataPortUnavailable: handleBrokerDataPortUnavailable,
    fanoutBrokerCandidate: handleFanoutBrokerCandidate,
    response: handleResponseMessage,
    settings: (data) => {
      settings.set(data.settings || {})
    },
    persistentScopeChanged: (data) => {
      settings.set(data.settings || {})
      pairedDevices = null
      deviceInfoCache = null
    },
    event: (data) => {
      dispatchDeviceEvent(data.event)
    }
  }

  /**
   * @param {string} action
   * @param {object} [payload]
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<object>}
   */
  async function sendRequest(action, payload, opts = {}) {
    await bridgeReady
    if (!bridgePort) return { s: 0 }
    return new Promise((resolve) => {
      const id = frameNonce + ':' + ++nextReqId
      const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 30000
      let settled = false
      let timer = null
      if (timeoutMs > 0) {
        timer = nativeSetTimeout(() => {
          if (settled) return
          settled = true
          delete pending[id]
          logger.warn('sendRequest timeout: ' + action + ' (id=' + id + ')')
          resolve({ s: 504 })
        }, timeoutMs)
      }
      const msg = { id, action, payload: payload || {} }
      const transfers = []
      if (payload && payload.data instanceof Uint8Array) {
        arrayOps.push(transfers, payload.data.buffer)
      }
      pending[id] = {
        handler: (result) => {
          if (settled) return
          settled = true
          if (timer) nativeClearTimeout(timer)
          delete pending[id]
          resolve(result)
        },
        msg,
        transfers
      }
      callNative(
        nativeMessagePortPostMessage,
        bridgePort,
        msg,
        transfers.length ? makePristineIterable(transfers) : undefined
      )
    })
  }

  /** @type {string[]|null} */
  let pairedDevices = null
  /** @type {Array<{deviceIds: number[]}>|null} */
  let pairedDeviceGroups = null
  /** @type {Map<string, object> | null} */
  let deviceInfoCache = null

  /** @returns {Promise<string[]>} */
  async function getPairedDevices() {
    if (pairedDevices !== null) return pairedDevices
    try {
      const result = await sendRequest('getPairedDevices')
      pairedDevices = result.hashes || []
      pairedDeviceGroups = result.groups || []
      deviceInfoCache = null
      return pairedDevices
    } catch {
      pairedDeviceGroups = []
      return []
    }
  }

  /** @returns {Promise<Map<string, object>>} */
  async function getDeviceCache() {
    if (deviceInfoCache !== null) return deviceInfoCache
    try {
      const response = await sendRequest('enumerate')
      const devices = http.isOk(response.s) && arrayIsArray(response.D) ? response.D : []
      deviceInfoCache = hardenMap(new NativeMap())
      for (let i = 0; i < devices.length; i++) {
        const device = devices[i]
        deviceInfoCache.set(device.deviceId, device)
      }
      return deviceInfoCache
    } catch {
      deviceInfoCache = hardenMap(new NativeMap())
      return deviceInfoCache
    }
  }

  const defs = GLOBAL_DEFAULTS
  const settings = createSettingsStore(defs)
  let resolveSettingsReady = null
  let settingsReadySettled = false
  const settingsReady = new NativePromise((resolve) => {
    resolveSettingsReady = resolve
  })
  /** @returns {void} */
  function markSettingsReady() {
    if (settingsReadySettled) return
    settingsReadySettled = true
    if (resolveSettingsReady) resolveSettingsReady()
    resolveSettingsReady = null
  }
  settings.on('dataPlane', (v) => logger.info('data plane changed: ' + v))
  logger.bindSettings(settings)

  promiseOps.then(
    bridgeReady,
    () => {
      promiseOps.then(
        sendRequest('getSettings', {}),
        (result) => {
          if (result) {
            settings.set(result)
            logger.info('data plane: ' + settings.dataPlane)
          }
          markSettingsReady()
        },
        markSettingsReady
      )
    },
    markSettingsReady
  )
  /** @returns {object} */
  function getPolicyContext() {
    return {}
  }

  /** @returns {Promise<object>} */
  function getPolicy() {
    return sendRequest('getPolicy', getPolicyContext())
  }

  const originalQuery = nativePermissionsQuery
  if (originalQuery && permissionsObject) {
    permissionsObject.query = async (desc) => {
      if (desc && desc.name === 'hid') {
        const policy = await getPolicy()
        return {
          state: policy && policy.hid === 'none' ? 'denied' : 'granted',
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false
        }
      }
      return originalQuery(desc)
    }
  }

  /** @type {WeakMap<object, object>} */
  const devState = hardenWeakMap(new NativeWeakMap())
  /** @type {WeakMap<object, object>} */
  const hidState = hardenWeakMap(new NativeWeakMap())
  /** @type {WeakMap<object, object>} */
  const evtState = hardenWeakMap(new NativeWeakMap())
  /** @type {WeakMap<object, object>} */
  const inputReportEventState = hardenWeakMap(new NativeWeakMap())
  /** @type {Map<string, object>} */
  const deviceRegistry = hardenMap(new NativeMap())

  /**
   * Sends a report request over the in-page plane when one is open, else the
   * device's data port, resolving with the daemon ack.
   * @param {object} state
   * @param {object} opts
   * @param {number} opts.inPageType
   * @param {string} opts.portType
   * @param {number} opts.reportId
   * @param {Uint8Array|null} opts.payload
   * @param {(data?: Uint8Array) => unknown} opts.mapResolve
   * @param {string} opts.failMessage
   * @returns {Promise<unknown>}
   */
  function sendDeviceRequest(state, opts) {
    if (state.planeUnavailable || !state.planeReady) throw new NativeError('data plane unavailable')
    const inPage = inPageRequest(
      inPagePlanes.get(state.deviceId),
      opts.inPageType,
      opts.reportId,
      opts.payload,
      opts.mapResolve
    )
    if (inPage) return inPage
    if (!state.dataPort || state.dataPortGeneration !== state.planeGeneration)
      throw new NativeError('data plane unavailable')
    const reqId = ++nextReqId
    const generation = state.planeGeneration
    const msg = { type: opts.portType, reqId, reportId: opts.reportId }
    const transfers = []
    if (opts.payload) {
      msg.data = opts.payload
      arrayOps.push(transfers, opts.payload.buffer)
    }
    return new Promise((resolve, reject) => {
      state.dataPending = state.dataPending || hardenMap(new NativeMap())
      const entry = {
        generation,
        resolve: (data) => resolve(opts.mapResolve(data)),
        reject: (e) => {
          if (e instanceof NativeDOMException) {
            reject(e)
          } else if (e && e.blocked) {
            reject(new NativeDOMException('Report is blocked', 'NotAllowedError'))
          } else {
            reject(
              new NativeDOMException((e && e.message) || e || opts.failMessage, 'NetworkError')
            )
          }
        }
      }
      state.dataPending.set(reqId, entry)
      try {
        callNative(
          nativeMessagePortPostMessage,
          state.dataPort,
          msg,
          transfers.length ? makePristineIterable(transfers) : undefined
        )
      } catch (error) {
        state.dataPending.delete(reqId)
        entry.reject(error)
      }
    })
  }

  /**
   * @constructor
   * @throws {TypeError}
   */
  function HIDDevice() {
    throw new TypeError('Illegal constructor')
  }
  HIDDevice.prototype = object.create(EventTarget.prototype)
  defineInterfacePrototypeConstructor(HIDDevice.prototype, HIDDevice)
  object.defineProperty(HIDDevice.prototype, nativeSymbolToStringTag, {
    value: 'HIDDevice',
    configurable: true
  })

  object.defineProperties(HIDDevice.prototype, {
    opened: {
      get() {
        return requireState(devState, this).connectionState === 'opened'
      },
      enumerable: true,
      configurable: true
    },
    vendorId: {
      get() {
        return requireState(devState, this).vendorId
      },
      enumerable: true,
      configurable: true
    },
    productId: {
      get() {
        return requireState(devState, this).productId
      },
      enumerable: true,
      configurable: true
    },
    productName: {
      get() {
        return requireState(devState, this).productName
      },
      enumerable: true,
      configurable: true
    },
    collections: {
      get() {
        return requireState(devState, this).collections
      },
      enumerable: true,
      configurable: true
    },
    oninputreport: {
      get() {
        const state = requireState(devState, this)
        return state.oninputreport != null ? state.oninputreport : null
      },
      /** @param {Function|null} v */
      set(v) {
        const state = requireState(devState, this)
        setEventHandler(state, 'oninputreport', 'inputReportListener', 'inputreport', v)
      },
      enumerable: true,
      configurable: true
    },
    open: {
      /** @returns {Promise<void>} */
      value: function () {
        try {
          return openDevice(requireState(devState, this))
        } catch (error) {
          return rejectWebIDLPromise(error)
        }
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    close: {
      /** @returns {Promise<void>} */
      value: function () {
        try {
          return closeDevice(requireState(devState, this))
        } catch (error) {
          return rejectWebIDLPromise(error)
        }
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    sendReport: {
      /**
       * @param {number} reportId
       * @param {ArrayBuffer|DataView|TypedArray} data
       * @returns {Promise<void>}
       */
      value: function (reportId, data) {
        try {
          const state = requireState(devState, this)
          const convertedReportId = convertEnforcedOctet(reportId)
          const buffer = copyBufferSource(data)
          return sendReportDevice(state, convertedReportId, buffer)
        } catch (error) {
          return rejectWebIDLPromise(error)
        }
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    receiveFeatureReport: {
      /**
       * @param {number} reportId
       * @returns {Promise<DataView>}
       */
      value: function (reportId) {
        try {
          const state = requireState(devState, this)
          const convertedReportId = convertEnforcedOctet(reportId)
          return receiveFeatureReportDevice(state, convertedReportId)
        } catch (error) {
          return rejectWebIDLPromise(error)
        }
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    sendFeatureReport: {
      /**
       * @param {number} reportId
       * @param {ArrayBuffer|DataView|TypedArray} data
       * @returns {Promise<void>}
       */
      value: function (reportId, data) {
        try {
          const state = requireState(devState, this)
          const convertedReportId = convertEnforcedOctet(reportId)
          const buffer = copyBufferSource(data)
          return sendFeatureReportDevice(state, convertedReportId, buffer)
        } catch (error) {
          return rejectWebIDLPromise(error)
        }
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    forget: {
      /** @returns {Promise<void>} */
      value: function () {
        try {
          return forgetDevice(requireState(devState, this))
        } catch (error) {
          return rejectWebIDLPromise(error)
        }
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    addEventListener: {
      /**
       * @param {string} type
       * @param {EventListenerOrEventListenerObject} listener
       * @param {boolean|object} [options]
       * @returns {void}
       */
      value: function (type, listener, options) {
        const state = requireState(devState, this)
        eventTargetOps.addEventListener(state.eventTarget, type, listener, options)
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    removeEventListener: {
      /**
       * @param {string} type
       * @param {EventListenerOrEventListenerObject} listener
       * @param {boolean|object} [options]
       * @returns {void}
       */
      value: function (type, listener, options) {
        const state = requireState(devState, this)
        eventTargetOps.removeEventListener(state.eventTarget, type, listener, options)
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    dispatchEvent: {
      /**
       * @param {Event} event
       * @returns {boolean}
       */
      value: function (event) {
        const state = requireState(devState, this)
        return eventTargetOps.dispatchEvent(state.eventTarget, event)
      },
      enumerable: true,
      configurable: true,
      writable: true
    }
  })

  function closeDataPort(state) {
    if (state.dataPort) {
      if (state.dataPortHandler) {
        callNative(
          nativeMessagePortRemoveEventListener,
          state.dataPort,
          'message',
          state.dataPortHandler
        )
        state.dataPortHandler = null
      }
      callNative(nativeMessagePortClose, state.dataPort)
      state.dataPort = null
    }
    state.dataPortGeneration = null
    state.planeReady = false
    state.planeUnavailable = false
    state.planeUnavailableGeneration = null
  }

  function abortDeviceReports(state, message) {
    const error = new NativeDOMException(message, 'AbortError')
    rejectInPagePending(state.deviceId, error)
    rejectPendingReports(state, error)
  }

  function openDevice(state) {
    if (state.connectionState !== 'closed') {
      return callNative(
        nativePromiseReject,
        NativePromise,
        new NativeDOMException(
          state.connectionState === 'forgotten' || state.connectionState === 'forgetting'
            ? 'Device has been forgotten'
            : 'Device is already opening or open',
          'InvalidStateError'
        )
      )
    }
    state.connectionState = 'opening'
    const openPromise = performOpenDevice(state)
    state.openPromise = openPromise
    promiseOps.then(
      openPromise,
      () => {
        if (state.openPromise === openPromise) state.openPromise = null
      },
      () => {
        if (state.openPromise === openPromise) state.openPromise = null
      }
    )
    return openPromise
  }

  async function performOpenDevice(state) {
    let backendOpened = false
    try {
      const response = await sendRequest('open', {
        deviceId: state.deviceId,
        reportSize: state.maxInputReportSize + 3
      })
      if (!http.isOk(response.s)) {
        throw new NativeError('Open failed: ' + (response.error || http.name(response.s || 0)))
      }
      backendOpened = true
      if (state.connectionState !== 'opening') {
        throw new NativeDOMException('Device opening was cancelled', 'InvalidStateError')
      }
      await bridgeReady
      if (state.connectionState !== 'opening') {
        throw new NativeDOMException('Device opening was cancelled', 'InvalidStateError')
      }
      if (typeof response.clientPlaneGeneration !== 'number') {
        throw new NativeError('Open did not establish a client data plane')
      }
      state.planeGeneration = response.clientPlaneGeneration
      if (response.clientPlaneOwner !== 'top') {
        wireDevicePort(state, state.planeGeneration)
      }
      const ready = await sendRequest('waitDataPlaneReady', {
        deviceId: state.deviceId,
        generation: state.planeGeneration
      })
      if (state.connectionState !== 'opening') {
        throw new NativeDOMException('Device opening was cancelled', 'InvalidStateError')
      }
      if (!ready || !ready.ok) {
        throw new NativeError(
          'Client data plane is not ready: ' + (ready && ready.error ? ready.error : 'unknown')
        )
      }
      state.planeReady = true
      state.planeUnavailable = false
      state.connectionState = 'opened'
      state.closingWasOpened = false
      eventTargetOps.dispatchEvent(state.eventTarget, new NativeEvent('open'))
    } catch (error) {
      closeDataPort(state)
      if (backendOpened && state.connectionState !== 'closing') {
        await promiseOps.catch(sendRequest('close', { deviceId: state.deviceId }), () => {})
      }
      if (state.connectionState === 'opening') state.connectionState = 'closed'
      if (error instanceof NativeDOMException) throw error
      throw new NativeDOMException(
        error && error.message ? error.message : 'Failed to open device',
        'NetworkError'
      )
    }
  }

  function closeDevice(state) {
    if (state.connectionState === 'forgotten' || state.connectionState === 'forgetting') {
      return callNative(
        nativePromiseReject,
        NativePromise,
        new NativeDOMException('Device has been forgotten', 'InvalidStateError')
      )
    }
    if (state.connectionState === 'closed') {
      return callNative(nativePromiseResolve, NativePromise, undefined)
    }
    if (state.connectionState === 'closing' && state.closePromise) return state.closePromise

    const wasOpened = state.connectionState === 'opened' || state.closingWasOpened
    const openPromise = state.openPromise
    state.connectionState = 'closing'
    state.closingWasOpened = wasOpened
    abortDeviceReports(state, 'Device closed')
    closeDataPort(state)

    const closePromise = performCloseDevice(state, openPromise, wasOpened)
    state.closePromise = closePromise
    promiseOps.then(
      closePromise,
      () => {
        if (state.closePromise === closePromise) state.closePromise = null
      },
      () => {
        if (state.closePromise === closePromise) state.closePromise = null
      }
    )
    return closePromise
  }

  async function performCloseDevice(state, openPromise, wasOpened) {
    if (openPromise) await promiseOps.catch(openPromise, () => {})
    const response = await sendRequest('close', { deviceId: state.deviceId })
    if (!response || !http.isOk(response.s)) {
      throw new NativeDOMException('Failed to close device', 'InvalidStateError')
    }
    if (state.connectionState === 'closing') {
      reconcileAuthoritativeLifetime(state)
      state.closingWasOpened = false
      if (wasOpened) eventTargetOps.dispatchEvent(state.eventTarget, new NativeEvent('close'))
    }
  }

  async function sendReportDevice(state, reportId, buffer) {
    if (state.connectionState !== 'opened') {
      throw new NativeDOMException('Device is not open', 'InvalidStateError')
    }
    const normalizedReportId = validateReportId(reportId, state.collections)
    try {
      logger.debug('sendReport reportId=' + normalizedReportId + ' len=' + buffer.length)
      return await sendDeviceRequest(state, {
        inPageType: MSG_SEND_REPORT,
        portType: 'send',
        reportId: normalizedReportId,
        payload: buffer,
        mapResolve: () => undefined,
        failMessage: 'send failed'
      })
    } catch (error) {
      if (error instanceof NativeDOMException) throw error
      throw new NativeDOMException(
        error && error.message ? error.message : 'send failed',
        'NetworkError'
      )
    }
  }

  async function receiveFeatureReportDevice(state, reportId) {
    if (state.connectionState !== 'opened') {
      throw new NativeDOMException('Device is not open', 'InvalidStateError')
    }
    const normalizedReportId = validateReportId(reportId, state.collections)
    try {
      return await sendDeviceRequest(state, {
        inPageType: MSG_RECEIVE_FEATURE_REPORT,
        portType: 'receiveFeature',
        reportId: normalizedReportId,
        payload: null,
        mapResolve: (data) => {
          if (!data) return new NativeDataView(new NativeArrayBuffer(0))
          const bytes = data instanceof Uint8Array ? data : new NativeUint8Array(data)
          return new NativeDataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        },
        failMessage: 'receive failed'
      })
    } catch (error) {
      if (error instanceof NativeDOMException) throw error
      throw new NativeDOMException(
        error && error.message ? error.message : 'receive failed',
        'NetworkError'
      )
    }
  }

  async function sendFeatureReportDevice(state, reportId, buffer) {
    if (state.connectionState !== 'opened') {
      throw new NativeDOMException('Device is not open', 'InvalidStateError')
    }
    const normalizedReportId = validateReportId(reportId, state.collections)
    try {
      logger.debug('sendFeatureReport reportId=' + normalizedReportId + ' len=' + buffer.length)
      return await sendDeviceRequest(state, {
        inPageType: MSG_SEND_FEATURE_REPORT,
        portType: 'sendFeature',
        reportId: normalizedReportId,
        payload: buffer,
        mapResolve: () => undefined,
        failMessage: 'send failed'
      })
    } catch (error) {
      if (error instanceof NativeDOMException) throw error
      throw new NativeDOMException(
        error && error.message ? error.message : 'send failed',
        'NetworkError'
      )
    }
  }

  function permissionGroupStates(state) {
    const ids = state.permissionDeviceIds || permissionDeviceIdsFor(state.deviceId)
    const states = [state]
    for (let i = 0; i < ids.length; i++) {
      const device = deviceRegistry.get(ids[i])
      const memberState = device ? devState.get(device) : null
      if (memberState && !arrayOps.includes(states, memberState)) arrayOps.push(states, memberState)
    }
    return states
  }

  function forgetDevice(state) {
    if (state.connectionState === 'forgotten') {
      return callNative(nativePromiseResolve, NativePromise, undefined)
    }
    const states = permissionGroupStates(state)
    for (let i = 0; i < states.length; i++) {
      if (states[i].forgetPromise) return states[i].forgetPromise
    }
    const wasOpened = []
    const operations = []
    for (let i = 0; i < states.length; i++) {
      const memberState = states[i]
      arrayOps.push(
        wasOpened,
        memberState.connectionState === 'opened' || memberState.connectionState === 'closing'
      )
      memberState.connectionState = 'forgetting'
      abortDeviceReports(memberState, 'Device forgotten')
      closeDataPort(memberState)
      if (memberState.openPromise) arrayOps.push(operations, memberState.openPromise)
      if (memberState.closePromise) arrayOps.push(operations, memberState.closePromise)
    }
    const forgetPromise = (async () => {
      for (let i = 0; i < operations.length; i++) {
        await promiseOps.catch(operations[i], () => {})
      }
      try {
        const response = await sendRequest('unpairDevice', { deviceId: state.deviceId })
        if (!response || response.success !== true) {
          throw new NativeDOMException('Failed to forget device', 'NetworkError')
        }
        pairedDevices = null
        pairedDeviceGroups = null
        deviceInfoCache = null
        for (let i = 0; i < states.length; i++) {
          const memberState = states[i]
          reconcileAuthoritativeLifetime(memberState, { forgotten: true })
          if (wasOpened[i]) {
            eventTargetOps.dispatchEvent(memberState.eventTarget, new NativeEvent('close'))
          }
          deviceRegistry.delete(memberState.deviceId)
        }
      } catch (error) {
        for (let i = 0; i < states.length; i++) {
          const memberState = states[i]
          if (memberState.connectionState !== 'forgetting') continue
          if (wasOpened[i]) {
            await promiseOps.catch(
              sendRequest('close', { deviceId: memberState.deviceId }),
              () => {}
            )
            eventTargetOps.dispatchEvent(memberState.eventTarget, new NativeEvent('close'))
          }
          memberState.connectionState = 'closed'
          memberState.closingWasOpened = false
        }
        throw error
      }
    })()
    for (let i = 0; i < states.length; i++) states[i].forgetPromise = forgetPromise
    promiseOps.then(
      forgetPromise,
      () => {
        for (let i = 0; i < states.length; i++) {
          if (states[i].forgetPromise === forgetPromise) states[i].forgetPromise = null
        }
      },
      () => {
        for (let i = 0; i < states.length; i++) {
          if (states[i].forgetPromise === forgetPromise) states[i].forgetPromise = null
        }
      }
    )
    return forgetPromise
  }

  /**
   * @param {string} deviceId
   * @returns {Promise<object | null>}
   */
  async function resolvePairedDevice(deviceId) {
    deviceInfoCache = null
    const hashes = await getPairedDevices()
    const cache = await getDeviceCache()
    if (!arrayOps.includes(hashes, deviceId)) return null
    const info = cache.get(deviceId)
    return info ? getOrCreateDevice(info) : null
  }

  /**
   * @param {object} detail
   * @returns {Promise<void>}
   */
  async function dispatchDeviceEvent(detail) {
    if (!detail) return
    if (detail.eventType === 'revoked') {
      if (detail.deviceId) await forceForgetDevice(detail.deviceId)
      return
    }
    if (detail.eventType === 'connect' || detail.eventType === 'disconnect') {
      let device = detail.deviceId ? deviceRegistry.get(detail.deviceId) : null
      if (!device && detail.eventType === 'connect' && detail.deviceId) {
        try {
          device = await resolvePairedDevice(detail.deviceId)
        } catch (e) {
          logger.debug(
            'connect event lookup failed:',
            e != null ? (e.message != null ? e.message : e) : e
          )
        }
      }
      if (detail.eventType === 'disconnect' && device) {
        const state = devState.get(device)
        reconcileAuthoritativeLifetime(state)
      }
      if (hidInstance && device) {
        if (detail.eventType === 'disconnect') deviceInfoCache = null
        const hidStateValue = hidState.get(hidInstance)
        if (hidStateValue) {
          eventTargetOps.dispatchEvent(
            hidStateValue.eventTarget,
            new HIDConnectionEvent(detail.eventType, { device: device })
          )
        }
        if (detail.eventType === 'disconnect') {
          deviceRegistry.delete(detail.deviceId)
        }
      }
      return
    }
    if (detail.eventType === 'input_report') {
      const device = detail.deviceId ? deviceRegistry.get(detail.deviceId) : null
      if (device) {
        const dataView = detail.data
          ? new DataView(
              detail.data.buffer || detail.data,
              detail.data.byteOffset || 0,
              detail.data.byteLength
            )
          : new NativeDataView(new NativeArrayBuffer(0))
        eventTargetOps.dispatchEvent(
          devState.get(device).eventTarget,
          new HIDInputReportEvent('inputreport', {
            device: device,
            reportId: detail.reportId,
            data: dataView
          })
        )
      }
      return
    }
  }

  /**
   * @param {object} state
   * @param {Error} error
   * @returns {void}
   */
  function rejectPendingReports(state, error) {
    if (!state.dataPending || !state.dataPending.size) return
    state.dataPending.forEach((entry) => {
      try {
        entry.reject(error)
      } catch (e) {
        logger.debug('reject pending report failed', e)
      }
    })
    state.dataPending.clear()
  }

  /**
   * Reconciles an opened device after an authoritative lifetime loss.
   * @param {object} state
   * @param {{forgotten?: boolean}} [options]
   * @returns {void}
   */
  function reconcileAuthoritativeLifetime(state, { forgotten = false } = {}) {
    if (!state) return
    state.connectionState = forgotten ? 'forgotten' : 'closed'
    state.closingWasOpened = false
    if (forgotten) {
      abortDeviceReports(state, 'Device forgotten')
    } else {
      const error = new NativeDOMException('Device disconnected', 'NetworkError')
      rejectInPagePending(state.deviceId, error)
      rejectPendingReports(state, error)
    }
    closeDataPort(state)
  }

  /**
   * @param {object} collection
   * @returns {boolean}
   */
  function collectionUsesReportIds(collection) {
    const reports = []
    const appendReports = (items) => {
      if (!items) return
      for (let i = 0; i < items.length; i++) arrayOps.push(reports, items[i])
    }
    appendReports(collection.inputReports)
    appendReports(collection.outputReports)
    appendReports(collection.featureReports)
    if (arrayOps.some(reports, (r) => r.reportId !== 0)) return true
    return arrayOps.some(collection.children || [], collectionUsesReportIds)
  }

  /**
   * @param {object[]} collections
   * @returns {boolean}
   */
  function deviceUsesReportIds(collections) {
    return arrayOps.some(collections || [], collectionUsesReportIds)
  }

  /**
   * Converts a WebIDL [EnforceRange] octet argument.
   *
   * @param {*} value
   * @returns {number}
   * @throws {*} The conversion error or TypeError for values outside the octet range.
   */
  function convertEnforcedOctet(value) {
    const number = +value
    if (!nativeNumberIsFinite(number)) {
      throw new TypeError('reportId must be a number in the range 0-255')
    }
    const integer = nativeMathTrunc(number)
    if (integer < 0 || integer > 255) {
      throw new TypeError('reportId must be a number in the range 0-255')
    }
    return integer || 0
  }

  /**
   * Copies bytes from a genuine WebIDL BufferSource.
   *
   * @param {*} data
   * @returns {Uint8Array}
   */
  function copyBufferSource(data) {
    let buffer
    let byteOffset
    let byteLength
    try {
      byteLength = arrayBufferGetters.byteLength(data)
      buffer = data
      byteOffset = 0
    } catch {
      if (!callNative(nativeArrayBufferIsView, NativeArrayBuffer, data)) {
        throw new NativeTypeError('data must be an ArrayBuffer or an ArrayBufferView')
      }
      try {
        buffer = dataViewGetters.buffer(data)
        byteOffset = dataViewGetters.byteOffset(data)
        byteLength = dataViewGetters.byteLength(data)
      } catch {
        buffer = uint8ArrayGetters.buffer(data)
        byteOffset = uint8ArrayGetters.byteOffset(data)
        byteLength = uint8ArrayGetters.byteLength(data)
      }
    }
    arrayBufferGetters.byteLength(buffer)
    const view = new NativeUint8Array(buffer, byteOffset, byteLength)
    return new NativeUint8Array(view)
  }

  /**
   * Converts a WebIDL octet without [EnforceRange], using integer modulo conversion.
   *
   * @param {*} value
   * @returns {number}
   * @throws {*} A ToNumber conversion error, if any.
   */
  function convertOctet(value) {
    const number = +value
    if (!nativeNumberIsFinite(number) || number === 0) return 0
    const remainder = nativeMathTrunc(number) % 256
    return remainder < 0 ? remainder + 256 : remainder
  }

  /**
   * @param {*} reportId
   * @param {object[]} collections
   * @returns {number}
   * @throws {TypeError}
   */
  function validateReportId(reportId, collections) {
    const usesReportIds = deviceUsesReportIds(collections)
    if (reportId === 0 && usesReportIds) {
      throw new TypeError('reportId must not be 0 for a device that uses report IDs')
    }
    if (reportId !== 0 && !usesReportIds) {
      throw new TypeError('reportId must be 0 for a device that does not use report IDs')
    }
    return reportId
  }

  /**
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  async function forceForgetDevice(deviceId) {
    const device = deviceRegistry.get(deviceId)
    if (!device) {
      pairedDevices = null
      pairedDeviceGroups = null
      deviceInfoCache = null
      return
    }
    const state = devState.get(device)
    if (!state || state.connectionState === 'forgotten') return
    const wasOpened = state.connectionState === 'opened' || state.connectionState === 'closing'
    reconcileAuthoritativeLifetime(state, { forgotten: true })
    if (wasOpened) eventTargetOps.dispatchEvent(state.eventTarget, new NativeEvent('close'))
    pairedDevices = null
    pairedDeviceGroups = null
    deviceInfoCache = null
    deviceRegistry.delete(state.deviceId)
  }

  /**
   * @param {object} state
   * @param {object} data
   * @returns {void}
   */
  function handleReportResult(state, data) {
    const entry = state.dataPending != null ? state.dataPending.get(data.reqId) : undefined
    if (!entry) return
    state.dataPending.delete(data.reqId)
    if (data.error) entry.reject(new NativeError(data.error))
    else if (data.type === 'featureResult') entry.resolve(data.data)
    else entry.resolve()
  }

  /**
   * @param {object} state
   * @param {object} data
   * @returns {void}
   */
  function handleInputReportBatch(state, data) {
    const device = state.self
    if (device && arrayIsArray(data.reports)) {
      for (let i = 0; i < data.reports.length; i++) {
        const r = data.reports[i]
        if (r == null) continue
        const dataView = r.data
          ? new NativeDataView(r.data)
          : new NativeDataView(new NativeArrayBuffer(0))
        eventTargetOps.dispatchEvent(
          state.eventTarget,
          new HIDInputReportEvent('inputreport', {
            device: device,
            reportId: r.reportId,
            data: dataView
          })
        )
      }
    }
  }

  /**
   * @param {object} state
   * @param {object} data
   * @returns {void}
   */
  function handleInputReport(state, data) {
    const dataView = data.data
      ? new NativeDataView(data.data)
      : new NativeDataView(new NativeArrayBuffer(0))
    const device = state.self
    if (device)
      eventTargetOps.dispatchEvent(
        state.eventTarget,
        new HIDInputReportEvent('inputreport', {
          device: device,
          reportId: data.reportId,
          data: dataView
        })
      )
  }

  /**
   * @param {object} state
   * @returns {void}
   */
  function handleDataPortDisconnectEvent(state) {
    deviceInfoCache = null
    reconcileAuthoritativeLifetime(state)
    const device = state.self
    if (device)
      eventTargetOps.dispatchEvent(
        state.eventTarget,
        new HIDConnectionEvent('disconnect', { device: device })
      )
  }

  /** @type {object} */
  const DATA_PORT_MESSAGE_HANDLERS = {
    sendResult: handleReportResult,
    featureResult: handleReportResult,
    inputReportBatch: handleInputReportBatch,
    inputReport: handleInputReport,
    disconnect: handleDataPortDisconnectEvent
  }

  /**
   * @param {object} state
   * @param {object} data
   * @returns {void}
   */
  function onDataPortMessage(state, data) {
    if (!data) return
    const handler = DATA_PORT_MESSAGE_HANDLERS[data.type]
    if (handler) handler(state, data)
  }

  const COLLECTION_INFO_MEMBERS = [
    'usagePage',
    'usage',
    'type',
    'children',
    'inputReports',
    'outputReports',
    'featureReports'
  ]
  const REPORT_INFO_MEMBERS = ['reportId', 'items']
  const REPORT_ITEM_MEMBERS = [
    'isAbsolute',
    'isArray',
    'isBufferedBytes',
    'isConstant',
    'isLinear',
    'isRange',
    'isVolatile',
    'hasNull',
    'hasPreferredState',
    'wrap',
    'usages',
    'usageMinimum',
    'usageMaximum',
    'reportSize',
    'reportCount',
    'unitExponent',
    'unitSystem',
    'unitFactorLengthExponent',
    'unitFactorMassExponent',
    'unitFactorTimeExponent',
    'unitFactorTemperatureExponent',
    'unitFactorCurrentExponent',
    'unitFactorLuminousIntensityExponent',
    'logicalMinimum',
    'logicalMaximum',
    'physicalMinimum',
    'physicalMaximum',
    'strings'
  ]

  /**
   * Copies an IDL dictionary into an ordinary mutable JavaScript object.
   *
   * @param {object} source
   * @param {string[]} members
   * @returns {object}
   */
  function copyIDLDictionary(source, members) {
    const result = object.create(NativeObject.prototype)
    for (let i = 0; i < members.length; i++) {
      const member = members[i]
      const value = source[member]
      if (value === undefined) continue
      object.defineProperty(result, member, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      })
    }
    return result
  }

  /**
   * Copies an IDL sequence into an ordinary mutable JavaScript array.
   *
   * @param {Array} source
   * @param {(value: *) => *} [convertItem]
   * @returns {Array}
   */
  function copyIDLSequence(source, convertItem) {
    const result = new NativeArray(source.length)
    for (let i = 0; i < source.length; i++) {
      const value = source[i]
      object.defineProperty(result, stringConstructor(i), {
        value: convertItem ? convertItem(value) : value,
        writable: true,
        enumerable: true,
        configurable: true
      })
    }
    return result
  }

  /**
   * @param {object} source
   * @returns {object}
   */
  function copyReportItem(source) {
    const result = copyIDLDictionary(source, REPORT_ITEM_MEMBERS)
    if (result.usages !== undefined) result.usages = copyIDLSequence(result.usages)
    if (result.strings !== undefined) result.strings = copyIDLSequence(result.strings)
    return result
  }

  /**
   * @param {object} source
   * @returns {object}
   */
  function copyReportInfo(source) {
    const result = copyIDLDictionary(source, REPORT_INFO_MEMBERS)
    if (result.items !== undefined) result.items = copyIDLSequence(result.items, copyReportItem)
    return result
  }

  /**
   * @param {object} source
   * @returns {object}
   */
  function copyCollectionInfo(source) {
    const result = copyIDLDictionary(source, COLLECTION_INFO_MEMBERS)
    if (result.children !== undefined) {
      result.children = copyIDLSequence(result.children, copyCollectionInfo)
    }
    if (result.inputReports !== undefined) {
      result.inputReports = copyIDLSequence(result.inputReports, copyReportInfo)
    }
    if (result.outputReports !== undefined) {
      result.outputReports = copyIDLSequence(result.outputReports, copyReportInfo)
    }
    if (result.featureReports !== undefined) {
      result.featureReports = copyIDLSequence(result.featureReports, copyReportInfo)
    }
    return result
  }

  /**
   * Converts the IDL sequence to a frozen outer FrozenArray.
   *
   * @param {object[]} collections
   * @returns {object[]}
   */
  function createFrozenCollections(collections) {
    return object.freeze(copyIDLSequence(collections, copyCollectionInfo))
  }

  /**
   * Implements the HTML EventHandler callback slot and stable listener.
   *
   * @param {object} state
   * @param {string} callbackKey
   * @param {string} listenerKey
   * @param {string} eventType
   * @param {*} value
   * @returns {void}
   */
  function setEventHandler(state, callbackKey, listenerKey, eventType, value) {
    const callback =
      value !== null && (typeof value === 'object' || typeof value === 'function') ? value : null
    state[callbackKey] = callback
    const listener = state[listenerKey]
    if (callback === null) {
      if (listener !== null) {
        eventTargetOps.removeEventListener(state.eventTarget, eventType, listener)
        state[listenerKey] = null
      }
      return
    }
    if (listener !== null) return
    const callbackArgs = [null]
    const eventHandlerListener = function (event) {
      const currentCallback = state[callbackKey]
      if (typeof currentCallback !== 'function') return
      const currentTarget = nativeEventCurrentTarget
        ? callNative(nativeEventCurrentTarget, event)
        : state.eventTarget
      callbackArgs[0] = event
      const returnValue = reflect.apply(currentCallback, currentTarget, callbackArgs)
      if (returnValue === false && nativeEventPreventDefault) {
        callNative(nativeEventPreventDefault, event)
      }
    }
    state[listenerKey] = eventHandlerListener
    eventTargetOps.addEventListener(state.eventTarget, eventType, eventHandlerListener)
  }

  /**
   * @param {import("./types.js").HIDDeviceInfo} deviceInfo
   * @returns {object}
   */
  function createHIDDevice(deviceInfo) {
    const obj = new NativeEventTarget()
    reflect.setPrototypeOf(obj, HIDDevice.prototype)
    const eventTarget = obj
    const state = {
      eventTarget: eventTarget,
      self: obj,
      deviceId: deviceInfo.deviceId,
      vendorId: deviceInfo.vendorId,
      productId: deviceInfo.productId,
      productName: deviceInfo.productName,
      collections: createFrozenCollections(deviceInfo.collections || []),
      connectionState: 'closed',
      openPromise: null,
      closePromise: null,
      forgetPromise: null,
      closingWasOpened: false,
      permissionDeviceIds: null,
      planeGeneration: 0,
      planeReady: false,
      planeUnavailable: false,
      planeUnavailableGeneration: null,
      dataPort: null,
      dataPortGeneration: null,
      dataPending: null,
      maxInputReportSize: deviceInfo.maxInputReportSize || 64,
      oninputreport: null,
      inputReportListener: null
    }
    devState.set(obj, state)
    return obj
  }

  /**
   * @param {number|string} deviceId
   * @returns {Array<number|string>}
   */
  function permissionDeviceIdsFor(deviceId) {
    const ids = [deviceId]
    const groups = pairedDeviceGroups || []
    for (let i = 0; i < groups.length; i++) {
      const members = groups[i].deviceIds || []
      if (!arrayOps.includes(members, deviceId)) continue
      for (let j = 0; j < members.length; j++) {
        if (!arrayOps.includes(ids, members[j])) arrayOps.push(ids, members[j])
      }
    }
    return ids
  }

  /**
   * @param {import("./types.js").HIDDeviceInfo} deviceInfo
   * @returns {object}
   */
  function getOrCreateDevice(deviceInfo) {
    const id = deviceInfo.deviceId
    if (id && deviceRegistry.has(id)) {
      const existing = deviceRegistry.get(id)
      const existingState = devState.get(existing)
      if (existingState) existingState.permissionDeviceIds = permissionDeviceIdsFor(id)
      return existing
    }
    const device = createHIDDevice(deviceInfo)
    const state = devState.get(device)
    state.permissionDeviceIds = permissionDeviceIdsFor(id)
    if (id) deviceRegistry.set(id, device)
    return device
  }

  /**
   * @constructor
   * @param {string} type
   * @param {object} init
   * @returns {Event}
   */
  function HIDInputReportEvent(type, init) {
    if (!new.target) throw new NativeTypeError('Class constructor requires new')
    const obj = types.Event.construct([type, init], new.target)
    const dictionary = init == null ? null : Object(init)
    const device = dictionary == null ? undefined : dictionary.device
    if (device === undefined) {
      throw new TypeError('HIDInputReportEventInit.device is required')
    }
    if (!devState.has(device)) {
      throw new TypeError('HIDInputReportEventInit.device must be a HIDDevice')
    }
    const reportIdValue = dictionary.reportId
    if (reportIdValue === undefined) {
      throw new TypeError('HIDInputReportEventInit.reportId is required')
    }
    const reportId = convertOctet(reportIdValue)
    const data = dictionary.data
    if (data === undefined) {
      throw new TypeError('HIDInputReportEventInit.data is required')
    }
    types.DataView.proto.getters.buffer(data)
    inputReportEventState.set(obj, { device, reportId, data })
    return obj
  }
  HIDInputReportEvent.prototype = object.create(Event.prototype)
  defineInterfacePrototypeConstructor(HIDInputReportEvent.prototype, HIDInputReportEvent)
  object.defineProperty(HIDInputReportEvent.prototype, nativeSymbolToStringTag, {
    value: 'HIDInputReportEvent',
    configurable: true
  })
  object.defineProperties(HIDInputReportEvent.prototype, {
    device: {
      get() {
        return requireState(inputReportEventState, this).device
      },
      enumerable: true,
      configurable: true
    },
    reportId: {
      get() {
        return requireState(inputReportEventState, this).reportId
      },
      enumerable: true,
      configurable: true
    },
    data: {
      get() {
        return requireState(inputReportEventState, this).data
      },
      enumerable: true,
      configurable: true
    }
  })

  /**
   * @constructor
   * @param {string} type
   * @param {object} init
   * @returns {Event}
   */
  function HIDConnectionEvent(type, init) {
    if (!new.target) throw new NativeTypeError('Class constructor requires new')
    const obj = types.Event.construct([type, init], new.target)
    const dictionary = init == null ? null : Object(init)
    const device = dictionary == null ? undefined : dictionary.device
    if (device === undefined) {
      throw new TypeError('HIDConnectionEventInit.device is required')
    }
    if (!devState.has(device)) {
      throw new TypeError('HIDConnectionEventInit.device must be a HIDDevice')
    }
    evtState.set(obj, { device })
    return obj
  }
  HIDConnectionEvent.prototype = object.create(Event.prototype)
  defineInterfacePrototypeConstructor(HIDConnectionEvent.prototype, HIDConnectionEvent)
  object.defineProperty(HIDConnectionEvent.prototype, nativeSymbolToStringTag, {
    value: 'HIDConnectionEvent',
    configurable: true
  })
  object.defineProperty(HIDConnectionEvent.prototype, 'device', {
    get() {
      return requireState(evtState, this).device
    },
    enumerable: true,
    configurable: true
  })

  /**
   * @constructor
   * @throws {TypeError}
   */
  function HID() {
    throw new TypeError('Illegal constructor')
  }
  HID.prototype = object.create(EventTarget.prototype)
  defineInterfacePrototypeConstructor(HID.prototype, HID)
  object.defineProperty(HID.prototype, nativeSymbolToStringTag, {
    value: 'HID',
    configurable: true
  })

  /**
   * Converts a WebIDL unsigned integer without [EnforceRange].
   *
   * @param {*} value
   * @param {number} bitLength
   * @returns {number}
   */
  function convertUnsignedInteger(value, bitLength) {
    const number = +value
    if (!nativeNumberIsFinite(number) || number === 0) return 0
    const modulus = 2 ** bitLength
    const remainder = nativeMathTrunc(number) % modulus
    return remainder < 0 ? remainder + modulus : remainder
  }

  /**
   * Converts a HIDDeviceFilter dictionary, ignoring unknown members.
   *
   * @param {*} value
   * @returns {object}
   */
  function convertFilterDictionary(value) {
    const dictionary = value == null ? null : Object(value)
    const filter = object.create(null)
    if (dictionary == null) return filter
    const vendorId = dictionary.vendorId
    if (vendorId !== undefined) filter.vendorId = convertUnsignedInteger(vendorId, 32)
    const productId = dictionary.productId
    if (productId !== undefined) filter.productId = convertUnsignedInteger(productId, 16)
    const usagePage = dictionary.usagePage
    if (usagePage !== undefined) filter.usagePage = convertUnsignedInteger(usagePage, 16)
    const usage = dictionary.usage
    if (usage !== undefined) filter.usage = convertUnsignedInteger(usage, 16)
    return filter
  }
  /**
   * Converts a WebIDL sequence using the source's iterator and closes it if
   * conversion of an item fails.
   *
   * @param {*} value
   * @param {string} name
   * @param {(value: *) => *} convertItem
   * @returns {Array}
   */
  function convertSequence(value, name, convertItem) {
    if (value == null) throw new TypeError(name + ' must be a sequence')
    const iteratorMethod = nativeSymbolIterator && value[nativeSymbolIterator]
    if (typeof iteratorMethod !== 'function') {
      throw new TypeError(name + ' must be a sequence')
    }
    const iterator = callNative(iteratorMethod, value)
    const iterable = object.create(null)
    object.defineProperty(iterable, nativeSymbolIterator, { value: () => iterator })
    return types.Array.static.methods.from(types.Array.constructor, iterable, convertItem)
  }

  /**
   * Converts requestDevice options using WebIDL dictionary and sequence order.
   *
   * @param {*} options
   * @returns {{filters: object[], exclusionFilters: object[], exclusionFiltersPresent: boolean}}
   * @throws {TypeError}
   */
  function normalizeRequestOptions(options) {
    const dictionary = options == null ? null : Object(options)
    if (dictionary == null) {
      throw new TypeError('HIDDeviceRequestOptions.filters is required')
    }
    const filterValues = dictionary.filters
    if (filterValues === undefined) {
      throw new TypeError('HIDDeviceRequestOptions.filters is required')
    }
    const filters = convertSequence(
      filterValues,
      'HIDDeviceRequestOptions.filters',
      convertFilterDictionary
    )
    const exclusionFiltersValue = dictionary.exclusionFilters
    const exclusionFiltersPresent = exclusionFiltersValue !== undefined
    const exclusionFilters = exclusionFiltersPresent
      ? convertSequence(
          exclusionFiltersValue,
          'HIDDeviceRequestOptions.exclusionFilters',
          convertFilterDictionary
        )
      : []
    return { filters, exclusionFilters, exclusionFiltersPresent }
  }

  /**
   * Validates filter semantics after requestDevice's security checks.
   *
   * @param {object[]} filters
   * @param {object[]} exclusionFilters
   * @param {boolean} exclusionFiltersPresent
   * @throws {TypeError}
   */
  function validateRequestOptions(filters, exclusionFilters, exclusionFiltersPresent) {
    for (let i = 0; i < filters.length; i++) {
      if (!isValidFilter(filters[i])) {
        throw new TypeError('Invalid filter in HIDDeviceRequestOptions.filters')
      }
    }
    if (exclusionFiltersPresent && exclusionFilters.length === 0) {
      throw new TypeError('HIDDeviceRequestOptions.exclusionFilters must not be empty when present')
    }
    for (let i = 0; i < exclusionFilters.length; i++) {
      if (!isValidFilter(exclusionFilters[i])) {
        throw new TypeError('Invalid filter in HIDDeviceRequestOptions.exclusionFilters')
      }
    }
  }

  /**
   * @param {{cancelled: boolean, devices?: Array<object>}} result
   * @returns {Promise<Array<object>>}
   */
  async function grantRequestedDevices(result) {
    if (result.cancelled) return []
    const devices = result.devices
    if (!devices || devices.length === 0) return []
    pairedDevices = null
    pairedDeviceGroups = null
    deviceInfoCache = null
    const granted = arrayOps.map(devices, (device) => getOrCreateDevice(device))
    const deviceIds = arrayOps.map(devices, (device) => device.deviceId)
    for (let i = 0; i < granted.length; i++) {
      const state = devState.get(granted[i])
      if (state) state.permissionDeviceIds = deviceIds
    }
    return granted
  }

  /**
   * @param {object} options
   * @param {object[]} options.filters
   * @param {object[]} [options.exclusionFilters]
   * @returns {Promise<object[]>}
   */
  async function requestDeviceImpl(options, hasActivation, calledFromConsole) {
    const { filters, exclusionFilters, exclusionFiltersPresent } = options
    await settingsReady
    const policy = await getPolicy()
    if (policy && policy.hid === 'none') {
      throw new NativeDOMException(
        'Access to HID is blocked by Permissions Policy',
        'SecurityError'
      )
    }
    if (!hasActivation && !settings.allowActivationlessRequestDevice && !calledFromConsole) {
      throw new NativeDOMException(
        'Must be handling a user gesture to perform a hid.requestDevice() call.',
        'SecurityError'
      )
    }
    validateRequestOptions(filters, exclusionFilters, exclusionFiltersPresent)
    logger.debug(
      'requestDevice filters=' +
        nativeJsonStringify(filters) +
        ' exclusionFilters=' +
        nativeJsonStringify(exclusionFilters)
    )
    return new Promise((resolve, reject) => {
      const id = frameNonce + ':' + ++nextReqId
      pending[id] = {
        handler: (result) => {
          promiseOps.then(grantRequestedDevices(result), resolve, (e) =>
            reject(
              new NativeDOMException(e != null ? e.message : 'requestDevice failed', 'NetworkError')
            )
          )
        },
        msg: null,
        transfers: []
      }
      callNative(nativeMessagePortPostMessage, bridgePort, {
        id,
        action: 'requestDevice',
        payload: { filters, exclusionFilters }
      })
    })
  }

  async function getDevicesImpl() {
    const policy = await getPolicy()
    if (policy && policy.hid === 'none') {
      throw new NativeDOMException(
        'Access to HID is blocked by Permissions Policy',
        'SecurityError'
      )
    }
    try {
      const pairedHashes = await getPairedDevices()
      const deviceCache = await getDeviceCache()
      const granted = []
      for (let i = 0; i < pairedHashes.length; i++) {
        const device = deviceCache.get(pairedHashes[i])
        if (device) arrayOps.push(granted, getOrCreateDevice(device))
      }
      logger.debug('getDevices returned ' + granted.length + ' device(s)')
      return granted
    } catch (error) {
      logger.warn('getDevices error:', error)
      return []
    }
  }

  function requestDevice(options) {
    try {
      requireState(hidState, this)
      const normalizedOptions = normalizeRequestOptions(options)
      const hasActivation = hasTransientActivation()
      const calledFromConsole = !hasActivation && isCalledFromConsole()
      return requestDeviceImpl(normalizedOptions, hasActivation, calledFromConsole)
    } catch (error) {
      return rejectWebIDLPromise(error)
    }
  }

  object.defineProperties(HID.prototype, {
    getDevices: {
      /** @returns {Promise<object[]>} */
      value: function () {
        try {
          requireState(hidState, this)
          return getDevicesImpl()
        } catch (error) {
          return rejectWebIDLPromise(error)
        }
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    ...(!isWorker
      ? {
          requestDevice: {
            /**
             * @param {object} options
             * @param {object[]} options.filters
             * @param {object[]} [options.exclusionFilters]
             * @returns {Promise<object[]>}
             */
            value: requestDevice,
            enumerable: true,
            configurable: true,
            writable: true
          }
        }
      : {}),
    addEventListener: {
      /**
       * @param {string} type
       * @param {EventListenerOrEventListenerObject} listener
       * @param {boolean|object} [options]
       * @returns {void}
       */
      value: function (type, listener, options) {
        const state = requireState(hidState, this)
        eventTargetOps.addEventListener(state.eventTarget, type, listener, options)
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    removeEventListener: {
      /**
       * @param {string} type
       * @param {EventListenerOrEventListenerObject} listener
       * @param {boolean|object} [options]
       * @returns {void}
       */
      value: function (type, listener, options) {
        const state = requireState(hidState, this)
        eventTargetOps.removeEventListener(state.eventTarget, type, listener, options)
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    dispatchEvent: {
      /**
       * @param {Event} event
       * @returns {boolean}
       */
      value: function (event) {
        const state = requireState(hidState, this)
        return eventTargetOps.dispatchEvent(state.eventTarget, event)
      },
      enumerable: true,
      configurable: true,
      writable: true
    },
    onconnect: {
      get() {
        const state = requireState(hidState, this)
        return state.onconnect != null ? state.onconnect : null
      },
      /** @param {Function|null} v */
      set(v) {
        const state = requireState(hidState, this)
        setEventHandler(state, 'onconnect', 'connectListener', 'connect', v)
      },
      enumerable: true,
      configurable: true
    },
    ondisconnect: {
      get() {
        const state = requireState(hidState, this)
        return state.ondisconnect != null ? state.ondisconnect : null
      },
      /** @param {Function|null} v */
      set(v) {
        const state = requireState(hidState, this)
        setEventHandler(state, 'ondisconnect', 'disconnectListener', 'disconnect', v)
      },
      enumerable: true,
      configurable: true
    }
  })

  /** @returns {object} */
  function createHID() {
    const obj = new NativeEventTarget()
    reflect.setPrototypeOf(obj, HID.prototype)
    const eventTarget = obj
    hidState.set(obj, {
      eventTarget: eventTarget,
      onconnect: null,
      ondisconnect: null,
      connectListener: null,
      disconnectListener: null
    })
    return obj
  }

  /**
   * Exposes a polyfill global on the current realm (window or worker).
   * @param {string} name
   * @param {object} value
   * @returns {void}
   */
  function defineWebhidGlobal(name, value) {
    object.defineProperty(isWorker ? self : globalThis, name, {
      value,
      writable: false,
      configurable: true,
      enumerable: false
    })
  }

  defineWebhidGlobal('HID', HID)
  defineWebhidGlobal('HIDDevice', HIDDevice)
  defineWebhidGlobal('HIDInputReportEvent', HIDInputReportEvent)
  defineWebhidGlobal('HIDConnectionEvent', HIDConnectionEvent)

  hidInstance = createHID()

  /** @returns {void} */
  function installNavigatorHid() {
    const target = isWorker ? object.getPrototypeOf(host.navigator) : Navigator.prototype
    object.defineProperty(target, 'hid', {
      get() {
        if (!nativeNavigatorUserAgent) {
          throw new NativeTypeError('Illegal invocation')
        }
        nativeNavigatorUserAgent(this)
        return hidInstance
      },
      ...(brokerSetterArmed
        ? {
            set(value) {
              const stack = getOriginalStack ? callNative(getOriginalStack, new NativeError()) : ''
              if (!brokerStackOtp || typeof stack !== 'string') {
                yieldNavigatorHid(value)
                return
              }
              const expected = 'webhidBroker_' + stackToken(brokerStackOtp)
              const lines = stringOps.split(stack, '\n')
              const brokerFrame = arrayOps.at(lines, 1) || ''
              if (!stringOps.includes(brokerFrame, expected)) {
                yieldNavigatorHid(value)
                return
              }
              brokerStackOtp = null
              brokerSetterArmed = false
              installNavigatorHid()
              try {
                callNative(
                  nativeMessagePortPostMessage,
                  bridgePort,
                  { type: 'fanoutCandidate' },
                  makePristineIterable([value])
                )
              } catch {
                try {
                  callNative(nativeMessagePortClose, value)
                } catch {
                  void 0
                }
              }
            }
          }
        : {}),
      configurable: true,
      enumerable: true
    })
  }
  installNavigatorHid()

  /** @param {*} value @returns {void} */
  function yieldNavigatorHid(value) {
    reflect.deleteProperty(host.navigator, 'hid')
    brokerStackOtp = null
    brokerSetterArmed = false
    if (nativeNavigatorHidDescriptor) {
      object.defineProperty(Navigator.prototype, 'hid', nativeNavigatorHidDescriptor)
      try {
        reflect.set(host.navigator, 'hid', value, host.navigator)
      } catch {
        void 0
      }
    } else {
      reflect.deleteProperty(Navigator.prototype, 'hid')
      try {
        object.defineProperty(host.navigator, 'hid', {
          value,
          writable: true,
          configurable: true,
          enumerable: true
        })
      } catch {
        void 0
      }
    }
  }
  function armBrokerCandidateSetter() {
    if (isWorker || (!fanoutCandidate && !brokerStackOtp) || brokerSetterArmed) return
    brokerSetterArmed = true
    installNavigatorHid()
  }

  /**
   * @param {{clientKey: string|null, terminated: boolean, sent: boolean}} state
   * @returns {void}
   */
  function destroyWorkerClient(state) {
    if (state.sent || !state.clientKey) return
    state.sent = true
    promiseOps.catch(
      sendRequest('workerClientDestroyed', { clientKey: state.clientKey }, { timeoutMs: 500 }),
      () => {}
    )
  }
  /**
   * @param {string|URL} url
   * @param {object} [opts]
   * @returns {Worker}
   */
  function PatchedWorker(url, opts) {
    const instance = new NativeWorker(url, opts)
    const state = { clientKey: null, terminated: false, sent: false }
    object.defineProperty(instance, 'terminate', {
      value: () => {
        state.terminated = true
        destroyWorkerClient(state)
        callNative(nativeWorkerTerminate, instance)
      }
    })
    if (nativeWorkerAddEventListener) {
      callNative(nativeWorkerAddEventListener, instance, 'message', (e) => {
        if (e.data === null && e.ports && e.ports[0]) {
          if (nativeEventStopImmediatePropagation) {
            callNative(nativeEventStopImmediatePropagation, e)
          }
          promiseOps.then(bridgeReady, () => {
            if (!bridgePort) return
            const id = frameNonce + ':' + ++nextReqId
            pending[id] = {
              handler: (result) => {
                if (!result || typeof result.clientKey !== 'string') return
                state.clientKey = result.clientKey
                if (state.terminated) destroyWorkerClient(state)
              },
              msg: null,
              transfers: []
            }
            callNative(
              nativeMessagePortPostMessage,
              bridgePort,
              { id, action: 'workerPort', payload: {} },
              makePristineIterable([e.ports[0]])
            )
          })
        }
      })
    }
    return instance
  }
  if (NativeWorker) {
    PatchedWorker.prototype = NativeWorker.prototype
    reflect.setPrototypeOf(PatchedWorker, NativeWorker)
    globalThis.Worker = PatchedWorker
  }
})()
