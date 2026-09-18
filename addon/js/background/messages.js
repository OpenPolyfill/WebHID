;(function () {
  const webhid = globalThis.webhid
  const { registerContentPort, postToContentPort } = webhid.import('content-ports')
  const pristine = webhid.import('pristine')
  const http = webhid.import('http')
  const logger = webhid.import('logger')
  const isChromium = webhid.import('isChromium')
  const decodeDeviceCollections = webhid.import('decodeDeviceCollections')
  const loadEffectiveSettings = webhid.import('loadEffectiveSettings')
  const persistentSiteScope = webhid.import('persistentSiteScope')
  const {
    deviceCache,
    pendingPicker,
    permissionsPolicy,
    frameDelegations,
    frameEndpoints,
    fanoutEndpoints,
    pageActionVisibility
  } = webhid.import('bgState')
  const {
    saveDeviceInfoBatch,
    getDeviceInfo,
    getAllowedDevices,
    addAllowedDevice,
    removeAllowedDevice,
    removeDeviceInfo,
    recordGrantGroup,
    getGrantGroupsForOrigin,
    deleteGrantGroups,
    getAllAllowedByOrigin
  } = webhid.import('bgStorage')
  const {
    registerDeviceTab,
    registerDeviceSession,
    unregisterDeviceSession,
    unregisterDeviceTab,
    isTabAuthorizedForDevice,
    isSessionOwnedBy,
    registerFrameLifetime,
    isFrameLifetimeActive,
    purgeFrame,
    collectDeviceSessionsForOrigin,
    getDeviceSessionOwner,
    setDeviceSessionPlane,
    collectDevicePlaneStatuses,
    collectOpenDeviceIdsForTab,
    setBadgeRefresh,
    closeForCleanup,
    closeFrameSessions
  } = webhid.import('bgStateOps')
  const { urlOrigin, frameKey, documentFrameKey } = webhid.import('bgCsp')
  const NativeMessaging = webhid.import('NativeMessaging')
  const bgPacked = webhid.import('bgPacked')
  const { ensureWorkerBundle } = webhid.import('bgBundle')

  /** @type {number} */
  let lastHidPermission = 2

  /** @type {object|null} */
  let actionApi = null
  /**
   * Projects authoritative tab session ownership onto the badge.
   * @param {number} tabId
   * @returns {void}
   */
  function refreshTabDeviceBadge(tabId) {
    if (!actionApi || tabId == null) return
    const count = collectOpenDeviceIdsForTab(tabId).length
    actionApi.setBadgeText({ text: count > 0 ? String(count) : '', tabId })
  }

  let nextEndpointId = 0
  /**
   * Returns the registered live top-frame endpoint for a tab.
   * @param {number} tabId
   * @returns {object|null}
   */
  function topEndpointForTab(tabId) {
    for (const endpoint of frameEndpoints.values()) {
      if (endpoint.tabId === tabId && endpoint.frameId === 0 && endpointDocumentIsLive(endpoint))
        return endpoint
    }
    return null
  }
  /**
   * Sends browser-authenticated endpoint metadata to its exact bridge.
   * @param {object} endpoint
   * @returns {void}
   */
  function sendEndpointMetadata(endpoint) {
    try {
      endpoint.port.postMessage({
        action: 'endpointMetadata',
        channel: endpoint.channel,
        endpointId: endpoint.id,
        tabId: endpoint.tabId,
        frameId: endpoint.frameId,
        documentId: endpoint.documentId,
        origin: endpoint.origin,
        url: endpoint.url,
        persistentOrigin: endpoint.persistentOrigin
      })
    } catch {
      void 0
    }
  }
  /**
   * Refreshes persistence partitions after a top-frame endpoint changes.
   * @param {number} tabId
   * @returns {void}
   */
  function refreshEndpointPersistence(tabId) {
    const top = topEndpointForTab(tabId)
    for (const endpoint of [...frameEndpoints.values(), ...fanoutEndpoints.values()]) {
      if (endpoint.tabId !== tabId) continue
      const persistentOrigin = top
        ? persistentSiteScope(endpoint.origin, endpoint.url, top.origin)
        : null
      if (endpoint.persistentOrigin === persistentOrigin) continue
      const previousPersistentOrigin = endpoint.persistentOrigin
      endpoint.persistentOrigin = persistentOrigin
      if (previousPersistentOrigin !== undefined) {
        void closeFrameSessions(endpoint.tabId, endpoint.frameKey, (deviceId, token) =>
          NativeMessaging.closeDevice(deviceId, token)
        ).catch((e) => logger.debug('scope transition cleanup failed', e))
      }
      sendEndpointMetadata(endpoint)
    }
  }
  /**
   * Removes picker requests owned by an endpoint.
   * @param {object} endpoint
   * @returns {void}
   */
  function clearPendingPickerForEndpoint(endpoint) {
    for (const [tabId, request] of pendingPicker) {
      if (request.ownerEndpointId !== endpoint.id && request.uiEndpointId !== endpoint.id) continue
      pendingPicker.delete(tabId)
    }
  }
  /**
   * @param {object} endpoint
   * @returns {boolean}
   */
  function hasOtherLiveEndpoint(endpoint) {
    for (const candidate of frameEndpoints.values()) {
      if (
        candidate !== endpoint &&
        !candidate.retired &&
        candidate.tabId === endpoint.tabId &&
        candidate.frameId === endpoint.frameId &&
        candidate.documentId === endpoint.documentId
      )
        return true
    }
    for (const candidate of fanoutEndpoints.values()) {
      if (
        candidate !== endpoint &&
        !candidate.retired &&
        candidate.tabId === endpoint.tabId &&
        candidate.frameId === endpoint.frameId &&
        candidate.documentId === endpoint.documentId
      )
        return true
    }
    return false
  }
  /**
   * Retires one endpoint and all state owned by its document lifetime. A
   * top-frame endpoint's retirement cascades to every logical fanout endpoint
   * multiplexed over the same runtime port.
   * @param {object} endpoint
   * @returns {Promise<void>|null}
   */
  function retireEndpoint(endpoint) {
    if (endpoint.retired) return null
    clearPendingPickerForEndpoint(endpoint)
    const preserveDocumentState = hasOtherLiveEndpoint(endpoint)
    endpoint.retired = true
    const cascades = []
    if (!endpoint.channel) {
      for (const candidate of [...fanoutEndpoints.values()]) {
        if (candidate.port === endpoint.port && !candidate.retired) {
          const retired = retireEndpoint(candidate)
          if (retired) cascades.push(retired)
        }
      }
    }
    fanoutEndpoints.delete(endpoint.channel)
    if (frameEndpoints.get(endpoint.port) === endpoint) frameEndpoints.delete(endpoint.port)
    cancelEndpointDelegations(endpoint)
    const exactKey = documentFrameKey(endpoint.tabId, endpoint.frameId, endpoint.documentId)
    if (!preserveDocumentState) {
      frameDelegations.delete(exactKey)
      permissionsPolicy.delete(exactKey)
    }
    const purge = purgeFrame(endpoint.tabId, endpoint.frameKey, (deviceId, token) =>
      NativeMessaging.closeDevice(deviceId, token)
    ).catch((e) => logger.debug('frame endpoint cleanup failed', e))
    if (cascades.length === 0) return purge
    return Promise.all([...cascades, purge]).catch((e) =>
      logger.debug('fanout retire cascade failed', e)
    )
  }
  /**
   * Whether `endpoint` is still registered as live against the delivery port.
   * Logical fanout endpoints share the top frame's runtime port.
   * @param {object} endpoint
   * @param {object} port
   * @returns {boolean}
   */
  function endpointRegistryIsCurrent(endpoint, port) {
    if (endpoint.channel) {
      return fanoutEndpoints.get(endpoint.channel) === endpoint && endpoint.port === port
    }
    return frameEndpoints.get(port) === endpoint
  }
  /**
   * @param {object} endpoint
   * @param {object} port
   * @param {string|null|undefined} persistentOrigin
   * @returns {boolean}
   */
  function endpointAuthorityIsCurrent(endpoint, port, persistentOrigin) {
    return (
      endpointRegistryIsCurrent(endpoint, port) &&
      isFrameLifetimeActive(endpoint.tabId, endpoint.frameKey) &&
      endpoint.persistentOrigin === persistentOrigin
    )
  }
  /**
   * @param {object} endpoint
   * @returns {boolean}
   */
  function endpointDocumentIsLive(endpoint) {
    return (
      endpointRegistryIsCurrent(endpoint, endpoint.port) &&
      isFrameLifetimeActive(endpoint.tabId, endpoint.frameKey)
    )
  }
  /**
   * Selects the trusted persistence partition for one request.
   * @param {object} request
   * @returns {string|null}
   */
  function persistenceOriginForRequest(request) {
    return Object.prototype.hasOwnProperty.call(request, 'persistentOrigin')
      ? request.persistentOrigin
      : request.origin || null
  }
  /**
   * Captures the browser-owned persistence authority for one request.
   * @param {object} request
   * @param {object} _sender
   * @param {object|undefined} port
   * @returns {{endpoint: object|null, port: object|undefined, persistentOrigin: string}|null}
   */
  function scopeAuthorityForRequest(request, _sender, port) {
    const endpoint = port ? endpointForRequest(request, port) : null
    if (port && !endpoint) return null
    const persistentOrigin = endpoint
      ? endpoint.persistentOrigin
      : persistenceOriginForRequest(request)
    if (!persistentOrigin) return null
    if (endpoint && !endpointAuthorityIsCurrent(endpoint, port, persistentOrigin)) return null
    return { endpoint, port, persistentOrigin }
  }
  /**
   * @param {{endpoint: object|null, port: object|undefined, persistentOrigin: string}} authority
   * @returns {boolean}
   */
  function scopeAuthorityIsCurrent(authority) {
    return (
      !authority.endpoint ||
      endpointAuthorityIsCurrent(authority.endpoint, authority.port, authority.persistentOrigin)
    )
  }
  /**
   * Registers one browser-owned exact frame endpoint.
   * @param {object} port
   * @returns {object|null}
   */
  function registerFrameEndpoint(port) {
    const sender = port.sender || {}
    const tabId = sender.tab?.id
    const frameId = Number.isInteger(sender.frameId) ? sender.frameId : null
    const documentId =
      typeof sender.documentId === 'string' && sender.documentId ? sender.documentId : null
    const origin = typeof sender.origin === 'string' && sender.origin ? sender.origin : null
    const url = typeof sender.url === 'string' ? sender.url : ''
    if (tabId == null || frameId == null || !origin) return null
    for (const candidate of [...frameEndpoints.values()]) {
      if (candidate.tabId === tabId && (frameId === 0 || candidate.frameId === frameId))
        retireEndpoint(candidate)
    }
    for (const candidate of [...fanoutEndpoints.values()]) {
      if (candidate.tabId !== tabId) continue
      if (frameId === 0 || (candidate.frameId === frameId && candidate.documentId !== documentId))
        retireEndpoint(candidate)
    }
    const endpoint = {
      id: 'endpoint-' + ++nextEndpointId,
      port,
      tabId,
      frameId,
      documentId,
      origin,
      url,
      persistentOrigin: undefined,
      frameKey: 'endpoint-' + nextEndpointId
    }
    frameEndpoints.set(port, endpoint)
    if (!registerFrameLifetime(tabId, endpoint.frameKey)) {
      frameEndpoints.delete(port)
      return null
    }
    refreshEndpointPersistence(tabId)
    for (const logical of [...fanoutEndpoints.values()]) {
      if (
        !logical.pendingSeed ||
        logical.tabId !== tabId ||
        logical.frameId !== frameId ||
        logical.documentId !== documentId ||
        !endpointDocumentIsLive(logical)
      )
        continue
      const seed = logical.pendingSeed
      delete logical.pendingSeed
      postToContentPort(port, {
        action: 'fanoutPairSeed',
        channel: logical.channel,
        pairOtp: seed.pairOtp,
        ackOtp: seed.ackOtp
      })
    }
    return endpoint
  }
  /**
   * @param {object} port
   * @returns {object|null}
   */
  function endpointForPort(port) {
    return (port && frameEndpoints.get(port)) || null
  }
  /**
   * Resolves the endpoint a request is attributed to. Requests carrying a
   * fanout channel tag resolve to that logical endpoint, validated against the
   * delivery port; unknown or retired channels never fall back to the top
   * endpoint.
   * @param {object} request
   * @param {object} port
   * @returns {object|null}
   */
  function endpointForRequest(request, port) {
    if (typeof request.channel === 'string' && request.channel) {
      const logical = fanoutEndpoints.get(request.channel) || null
      if (!logical || logical.retired || logical.port !== port) return null
      return logical
    }
    return endpointForPort(port)
  }
  /**
   * Backwards-compatible alias used by handlers that resolve by sender.
   * @param {object} request
   * @param {object} sender
   * @param {object} port
   * @returns {object|null}
   */
  function endpointForSender(request, sender, port) {
    return endpointForRequest(request, port)
  }
  const delegationPending = new Map()
  let nextDelegationId = 0
  /**
   * Resolves the parent endpoint for an exact child document. Logical fanout
   * endpoints can be parents of other fanout endpoints sharing the same port.
   * @param {object} endpoint
   * @returns {object|null}
   */
  function parentEndpointFor(endpoint) {
    const entry = policyEntryForDocument(
      endpoint.tabId,
      endpoint.frameId,
      endpoint.documentId,
      endpoint.origin
    )
    const parentFrameId = entry && entry.parentFrameId >= 0 ? entry.parentFrameId : 0
    const parentDocumentId = entry && entry.parentDocumentId
    if (endpoint.frameId === 0) return null
    for (const candidate of [...frameEndpoints.values(), ...fanoutEndpoints.values()]) {
      if (
        candidate.tabId === endpoint.tabId &&
        candidate.frameId === parentFrameId &&
        (!parentDocumentId || candidate.documentId === parentDocumentId) &&
        candidate.documentId &&
        candidate !== endpoint &&
        (endpoint.channel || candidate.port !== endpoint.port)
      )
        return candidate
    }
    return null
  }
  /**
   * Queries the exact parent endpoint for iframe delegation.
   * @param {object} endpoint
   * @returns {Promise<boolean>}
   */
  function queryFrameDelegation(endpoint) {
    const parent = parentEndpointFor(endpoint)
    if (!parent) return Promise.resolve(false)
    const requestId = 'delegation:' + ++nextDelegationId
    return new Promise((resolve) => {
      delegationPending.set(requestId, { endpoint, parent, resolve })
      postToContentPort(parent.port, {
        action: 'frameDelegationQuery',
        requestId,
        childFrameId: endpoint.frameId,
        childDocumentId: endpoint.documentId,
        childOrigin: endpoint.origin,
        parentOrigin: parent.origin
      })
    })
  }
  /**
   * Cancels delegation queries involving a retired endpoint.
   * @param {object} endpoint
   * @returns {void}
   */
  function cancelEndpointDelegations(endpoint) {
    for (const [requestId, pending] of delegationPending) {
      if (pending.endpoint !== endpoint && pending.parent !== endpoint) continue
      delegationPending.delete(requestId)
      pending.resolve(false)
    }
  }
  /**
   * Sends a persistence-scope event only to endpoints owning that scope.
   * @param {string|null} persistentOrigin
   * @param {object} message
   * @returns {number}
   */
  function postToPersistentOriginEndpoints(persistentOrigin, message) {
    if (!persistentOrigin) return 0
    let delivered = 0
    for (const endpoint of frameEndpoints.values()) {
      if (endpoint.persistentOrigin !== persistentOrigin) continue
      postToContentPort(endpoint.port, message)
      delivered++
    }
    return delivered
  }
  /**
   * Replaces the in-memory device cache with `devices` (decoded), persisting
   * them afterwards.
   * @param {object[]} devices
   * @returns {void}
   */
  function refreshDeviceCache(devices) {
    decodeDeviceCollections(devices)
    deviceCache.length = 0
    deviceCache.push(...devices)
    saveDeviceInfoBatch(devices)
  }

  /**
   * @param {string} authorityOrigin
   * @param {string|null} persistentOrigin
   * @param {number[]} deviceIds
   * @returns {Promise<void>}
   */
  async function notifyAllowedDevicesChanged(authorityOrigin, persistentOrigin, deviceIds) {
    postToPersistentOriginEndpoints(persistentOrigin, {
      action: 'allowedDevicesChanged',
      origin: authorityOrigin,
      persistentOrigin,
      deviceIds
    })
  }

  /**
   * @param {string|null} persistentOrigin
   * @param {string} authorityOrigin
   * @param {Set<number>} toRevoke
   * @param {object[]} memberGroups
   * @param {() => boolean} [isCurrent]
   * @returns {Promise<boolean>}
   */
  async function revokeDevices(
    persistentOrigin,
    authorityOrigin,
    toRevoke,
    memberGroups,
    isCurrent = () => true
  ) {
    for (const deviceId of toRevoke) {
      if (!isCurrent()) return false
      await removeAllowedDevice(persistentOrigin, deviceId)
      if (!isCurrent()) return false
      removeDeviceInfo(deviceId)
      const tokens = collectDeviceSessionsForOrigin(deviceId, persistentOrigin)
      for (const token of tokens) {
        const owner = getDeviceSessionOwner(deviceId, token)
        if (owner) unregisterDeviceTab(deviceId, owner.tabId)
        await closeForCleanup(deviceId, token, (id, sessionToken) =>
          NativeMessaging.closeDevice(id, sessionToken)
        )
        if (!isCurrent()) return false
      }
    }
    if (!isCurrent()) return false
    await deleteGrantGroups(memberGroups.map((g) => g.id))
    if (!isCurrent()) return false
    const deviceIds = await getAllowedDevices(persistentOrigin)
    if (!isCurrent()) return false
    for (const deviceId of toRevoke) {
      postToPersistentOriginEndpoints(persistentOrigin, {
        action: 'webhidDeviceEvent',
        event: {
          eventType: 'revoked',
          deviceId,
          origin: authorityOrigin,
          persistentOrigin
        }
      })
    }
    notifyAllowedDevicesChanged(authorityOrigin, persistentOrigin, deviceIds)
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleEnumerate(request, sender, sendResponse) {
    const filter = {
      filters: Array.isArray(request.filters) ? request.filters : [],
      exclusionFilters: Array.isArray(request.exclusionFilters) ? request.exclusionFilters : []
    }
    const hasFilter = filter.filters.length > 0 || filter.exclusionFilters.length > 0
    NativeMessaging.enumerateDevices(hasFilter ? filter : undefined)
      .then((response) => {
        if (http.isOk(response.s) && response.D) {
          if (hasFilter) decodeDeviceCollections(response.D)
          else refreshDeviceCache(response.D)
        }
        sendResponse(hasFilter ? Object.assign({}, response, { filtered: true }) : response)
      })
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   *
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleEnumeratePaired(request, sender, sendResponse, port) {
    const authority = scopeAuthorityForRequest(request, sender, port)
    const origin = authority?.persistentOrigin
    if (!authority || !origin) {
      sendResponse({ s: 403 })
      return true
    }
    NativeMessaging.enumerateDevices()
      .then(async (response) => {
        if (!scopeAuthorityIsCurrent(authority)) {
          sendResponse({ s: 503 })
          return
        }
        if (http.isOk(response.s) && response.D) {
          const ids = await getAllowedDevices(origin)
          if (!scopeAuthorityIsCurrent(authority)) {
            sendResponse({ s: 503 })
            return
          }
          const paired = response.D.filter((d) => ids.includes(d.deviceId))
          decodeDeviceCollections(paired)
          sendResponse({ s: response.s, D: paired })
        } else {
          sendResponse(response)
        }
      })
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleHandshake(request, sender, sendResponse) {
    NativeMessaging.handshake()
      .then(sendResponse)
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetBackendStatus(request, sender, sendResponse) {
    ;(async () => {
      try {
        const resp = await NativeMessaging.handshake()
        if (typeof resp.P === 'number') lastHidPermission = resp.P
        sendResponse({
          nmConnected: NativeMessaging.port != null,
          daemonReachable: http.isOk(resp.s),
          hidPermission: typeof resp.P === 'number' ? resp.P : lastHidPermission,
          lastError: NativeMessaging.lastError || null
        })
      } catch {
        sendResponse({
          nmConnected: NativeMessaging.port != null,
          daemonReachable: false,
          hidPermission: lastHidPermission,
          lastError: NativeMessaging.lastError || null
        })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleRecordGrantGroup(request, sender, sendResponse, port) {
    ;(async () => {
      try {
        const authority = scopeAuthorityForRequest(request, sender, port)
        const origin = authority?.persistentOrigin
        if (!authority || !origin || !Array.isArray(request.deviceIds)) {
          sendResponse({ success: false })
          return
        }
        await recordGrantGroup(origin, request.deviceIds)
        if (!scopeAuthorityIsCurrent(authority)) {
          sendResponse({ success: false, error: 'stale frame authority' })
          return
        }
        sendResponse({ success: true })
      } catch (e) {
        sendResponse({ success: false, error: e.message })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleGetGrantGroups(request, sender, sendResponse, port) {
    ;(async () => {
      try {
        const authority = scopeAuthorityForRequest(request, sender, port)
        if (!authority) {
          sendResponse({ success: false, groups: [] })
          return
        }
        const groups = await getGrantGroupsForOrigin(authority.persistentOrigin)
        sendResponse(
          scopeAuthorityIsCurrent(authority)
            ? { success: true, groups }
            : { success: false, groups: [] }
        )
      } catch {
        sendResponse({ success: false, groups: [] })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetAllPairedDevices(request, sender, sendResponse) {
    ;(async () => {
      try {
        const byOrigin = await getAllAllowedByOrigin()
        const origins = []
        for (const [origin, deviceIds] of byOrigin.entries()) {
          const devices = []
          for (const deviceId of deviceIds) {
            const info = await getDeviceInfo(deviceId)
            devices.push({
              deviceId,
              name: info ? info.productName || '' : '',
              vendorId: info ? info.vendorId || 0 : 0,
              productId: info ? info.productId || 0 : 0,
              manufacturer: info ? info.manufacturer || '' : ''
            })
          }
          origins.push({ origin, devices })
        }
        origins.sort((a, b) => a.origin.localeCompare(b.origin))
        sendResponse({ success: true, origins })
      } catch (e) {
        sendResponse({ success: false, error: e.message, origins: [] })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleOpen(request, sender, sendResponse, port) {
    const authority = scopeAuthorityForRequest(request, sender, port)
    const endpoint = authority?.endpoint
    const persistentOrigin = authority?.persistentOrigin
    if (!authority || !endpoint || !persistentOrigin) {
      sendResponse({ s: 403 })
      return true
    }
    const { tabId, frameKey } = endpoint
    const authorityOrigin = endpoint.origin
    getAllowedDevices(persistentOrigin)
      .then((deviceIds) => {
        if (!scopeAuthorityIsCurrent(authority)) {
          sendResponse({ s: 503 })
          return
        }
        if (!deviceIds.includes(request.deviceId)) {
          sendResponse({ s: 403 })
          return
        }
        NativeMessaging.openDevice(request.deviceId)
          .then(async (response) => {
            if (typeof response.P === 'number') lastHidPermission = response.P
            if (http.isOk(response.s) && response.i) {
              const stillAllowed = (await getAllowedDevices(persistentOrigin)).includes(
                request.deviceId
              )
              const ownerStillCurrent = scopeAuthorityIsCurrent(authority)
              if (!stillAllowed || !ownerStillCurrent) {
                if (response.t)
                  await closeForCleanup(response.i, response.t, (id, token) =>
                    NativeMessaging.closeDevice(id, token)
                  )
                sendResponse({ s: ownerStillCurrent ? 403 : 503 })
                return
              }
              let sessionRegistered = true
              if (response.t) {
                sessionRegistered = registerDeviceSession(response.i, response.t, {
                  tabId,
                  frameId: endpoint.frameId,
                  documentId: endpoint.documentId,
                  origin: authorityOrigin,
                  persistentOrigin,
                  frameKey,
                  port,
                  clientKey: request.clientKey
                })
              }
              if (!sessionRegistered) {
                if (response.t)
                  await closeForCleanup(response.i, response.t, (id, token) =>
                    NativeMessaging.closeDevice(id, token)
                  )
                sendResponse({ s: 503 })
                return
              }
              registerDeviceTab(response.i, tabId)
            }
            sendResponse(response)
          })
          .catch(() => sendResponse({ s: 500 }))
      })
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * @param {object} sender
   * @param {number} deviceId
   * @returns {boolean}
   */
  function tabAllowsDevice(sender, deviceId) {
    const tabId = sender.tab != null ? sender.tab.id : undefined
    return isTabAuthorizedForDevice(tabId, deviceId)
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleClose(request, sender, sendResponse, port) {
    const endpoint = endpointForSender(request, sender, port)
    const tabId = endpoint?.tabId
    if (!endpoint || !isTabAuthorizedForDevice(tabId, request.deviceId)) {
      sendResponse({ s: 403 })
      return true
    }
    if (
      request.T &&
      !isSessionOwnedBy(
        request.deviceId,
        request.T,
        endpoint.origin,
        endpoint.tabId,
        endpoint.frameKey,
        request.clientKey,
        port
      )
    ) {
      sendResponse({ s: 403 })
      return true
    }
    NativeMessaging.closeDevice(request.deviceId, request.T)
      .then((response) => {
        if (http.isOk(response.s)) {
          unregisterDeviceTab(request.deviceId, tabId)
          if (request.T) unregisterDeviceSession(request.deviceId, request.T)
        }
        sendResponse(response)
      })
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * Closes all sessions owned by one exact bridge endpoint.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  async function handleFrameDestroyed(request, sender, sendResponse, port) {
    const endpoint = endpointForSender(request, sender, port)
    if (endpoint) {
      const cleanup = retireEndpoint(endpoint)
      refreshEndpointPersistence(endpoint.tabId)
      if (cleanup) await cleanup
    }
    sendResponse({ s: 204 })
    return true
  }

  /**
   * Registers a logical fanout endpoint on behalf of one exact child document.
   * The top-frame bridge requests it after authenticating the child through
   * browser-owned frame identity; persistent partitioning follows the same
   * site scope as any other endpoint. The background issues two pairing
   * nonces: the child presents pairOtp over the mux channel to prove the
   * port's page end is the real polyfill, and the bridge presents ackOtp to
   * prove its end is the background-brokered bridge. ackOtp reaches the
   * child bridge only over its control port, never a page-visible surface.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleFanoutOpen(request, sender, sendResponse, port) {
    const top = endpointForPort(port)
    if (
      !top ||
      top.frameId !== 0 ||
      !endpointDocumentIsLive(top) ||
      typeof request.channel !== 'string' ||
      !request.channel ||
      fanoutEndpoints.has(request.channel) ||
      !Number.isInteger(request.frameId) ||
      request.frameId <= 0 ||
      typeof request.documentId !== 'string' ||
      !request.documentId ||
      request.origin !== top.origin
    ) {
      sendResponse({ ok: false })
      return false
    }
    for (const candidate of [...fanoutEndpoints.values()]) {
      if (candidate.tabId === top.tabId && candidate.frameId === request.frameId)
        retireEndpoint(candidate)
    }
    const endpoint = {
      id: 'fanout-' + ++nextEndpointId,
      channel: request.channel,
      port,
      tabId: top.tabId,
      frameId: request.frameId,
      documentId: request.documentId,
      origin: request.origin,
      url: typeof request.url === 'string' ? request.url : '',
      persistentOrigin: undefined,
      frameKey: 'fanout-' + nextEndpointId
    }
    fanoutEndpoints.set(request.channel, endpoint)
    if (!registerFrameLifetime(endpoint.tabId, endpoint.frameKey)) {
      fanoutEndpoints.delete(request.channel)
      sendResponse({ ok: false })
      return false
    }
    endpoint.persistentOrigin = top.persistentOrigin
      ? persistentSiteScope(endpoint.origin, endpoint.url, top.origin)
      : null
    const pairOtp = pristine.host.cryptoRandomUUID()
    const ackOtp = pristine.host.cryptoRandomUUID()
    endpoint.pairOtp = pairOtp
    endpoint.ackOtp = ackOtp
    deliverFanoutPairSeed(endpoint, pairOtp, ackOtp)
    sendResponse({
      ok: true,
      endpointId: endpoint.id,
      channel: endpoint.channel,
      persistentOrigin: endpoint.persistentOrigin,
      pairOtp,
      ackOtp
    })
    return false
  }
  /**
   * Sends the pairing nonces to the child frame's own bridge over its control
   * port, deferring when the child bridge has not connected yet (the MAIN
   * world boots first and may relay the request before its bridge registers).
   * @param {object} endpoint
   * @param {string} pairOtp
   * @param {string} ackOtp
   * @returns {void}
   */
  function deliverFanoutPairSeed(endpoint, pairOtp, ackOtp) {
    let childPort = null
    for (const candidate of frameEndpoints.values()) {
      if (
        candidate.tabId === endpoint.tabId &&
        candidate.frameId === endpoint.frameId &&
        candidate.documentId === endpoint.documentId &&
        endpointDocumentIsLive(candidate)
      ) {
        childPort = candidate
        break
      }
    }
    if (childPort) {
      postToContentPort(childPort.port, {
        action: 'fanoutPairSeed',
        channel: endpoint.channel,
        pairOtp,
        ackOtp
      })
    } else {
      endpoint.pendingSeed = { pairOtp, ackOtp }
    }
  }

  /**
   * Closes a daemon session returned by an open whose browser owner died.
   * @param {object} request
   * @param {object} _sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleCleanupSession(request, _sender, sendResponse) {
    closeForCleanup(request.deviceId, request.sessionToken, (deviceId, token) =>
      NativeMessaging.closeDevice(deviceId, token)
    ).then((confirmed) => sendResponse({ s: confirmed ? 204 : 503 }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleRevokeDevice(request, sender, sendResponse, port) {
    ;(async () => {
      try {
        const authority = scopeAuthorityForRequest(request, sender, port)
        const persistentOrigin = authority?.persistentOrigin
        const authorityOrigin = authority?.endpoint?.origin || request.origin || ''
        if (!authority || !persistentOrigin || !authorityOrigin) {
          sendResponse({ success: false, error: 'no origin' })
          return
        }
        const targetIds =
          Array.isArray(request.deviceIds) && request.deviceIds.length
            ? request.deviceIds.map((id) => Number(id))
            : [Number(request.deviceId)]
        const groups = await getGrantGroupsForOrigin(persistentOrigin)
        if (!scopeAuthorityIsCurrent(authority)) {
          sendResponse({ success: false, error: 'stale frame authority' })
          return
        }
        const memberGroups = groups.filter((g) => g.deviceIds.some((id) => targetIds.includes(id)))
        /** @type {Set<number>} */
        const toRevoke = new Set(targetIds)
        for (const g of memberGroups) {
          for (const id of g.deviceIds) toRevoke.add(Number(id))
        }
        const completed = await revokeDevices(
          persistentOrigin,
          authorityOrigin,
          toRevoke,
          memberGroups,
          () => scopeAuthorityIsCurrent(authority)
        )
        sendResponse(
          completed && scopeAuthorityIsCurrent(authority)
            ? { success: true }
            : { success: false, error: 'stale frame authority' }
        )
      } catch (e) {
        sendResponse({ success: false, error: e.message })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleSetDataPlane(request, sender, sendResponse, port) {
    const endpoint = endpointForSender(request, sender, port)
    if (!endpoint || !tabAllowsDevice(sender, request.deviceId)) {
      sendResponse({ s: 403 })
      return true
    }
    if (
      request.sessionToken &&
      !isSessionOwnedBy(
        request.deviceId,
        request.sessionToken,
        endpoint.origin,
        endpoint.tabId,
        endpoint.frameKey,
        request.clientKey,
        port
      )
    ) {
      sendResponse({ s: 403 })
      return true
    }
    NativeMessaging.sendRequest({
      a: bgPacked.ACT.sdp,
      i: request.deviceId,
      m: request.mode,
      T: request.sessionToken
    })
      .then(sendResponse)
      .catch(() => sendResponse({ s: 500 }))
    return true
  }
  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleSendReport(request, sender, sendResponse) {
    if (!tabAllowsDevice(sender, request.deviceId)) {
      sendResponse({ s: 403 })
      return true
    }
    NativeMessaging.sendReport(request.deviceId, request.reportId || 0, request.data)
      .then(sendResponse)
      .catch(() => sendResponse({ s: 500 }))
    return true
  }
  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleReceiveFeatureReport(request, sender, sendResponse) {
    if (!tabAllowsDevice(sender, request.deviceId)) {
      sendResponse({ s: 403 })
      return true
    }
    NativeMessaging.receiveFeatureReport(request.deviceId, request.reportId)
      .then(sendResponse)
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleSendFeatureReport(request, sender, sendResponse) {
    if (!tabAllowsDevice(sender, request.deviceId)) {
      sendResponse({ s: 403 })
      return true
    }
    NativeMessaging.sendFeatureReport(request.deviceId, request.reportId || 0, request.data)
      .then(sendResponse)
      .catch(() => sendResponse({ s: 500 }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleGetPairedDevices(request, sender, sendResponse, port) {
    ;(async () => {
      try {
        const authority = scopeAuthorityForRequest(request, sender, port)
        if (!authority) {
          sendResponse({ success: false, hashes: [] })
          return
        }
        const deviceIds = await getAllowedDevices(authority.persistentOrigin)
        sendResponse(
          scopeAuthorityIsCurrent(authority)
            ? { success: true, hashes: deviceIds }
            : { success: false, hashes: [] }
        )
      } catch (e) {
        sendResponse({ success: false, error: e.message, hashes: [] })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handlePairDevice(request, sender, sendResponse, port) {
    ;(async () => {
      try {
        const authority = scopeAuthorityForRequest(request, sender, port)
        const origin = authority?.persistentOrigin
        if (!authority || !origin || !request.device) {
          sendResponse({ success: false, hashes: [] })
          return
        }
        await addAllowedDevice(origin, request.device.deviceId)
        if (!scopeAuthorityIsCurrent(authority)) {
          sendResponse({ success: false, hashes: [] })
          return
        }
        const deviceIds = await getAllowedDevices(origin)
        if (!scopeAuthorityIsCurrent(authority)) {
          sendResponse({ success: false, hashes: [] })
          return
        }
        await notifyAllowedDevicesChanged(request.origin, origin, deviceIds)
        sendResponse(
          scopeAuthorityIsCurrent(authority)
            ? { success: true, hashes: deviceIds }
            : { success: false, hashes: [] }
        )
      } catch (e) {
        sendResponse({ success: false, error: e.message, hashes: [] })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleUnpairDevice(request, sender, sendResponse, port) {
    ;(async () => {
      try {
        const authority = scopeAuthorityForRequest(request, sender, port)
        const origin = authority?.persistentOrigin
        if (!authority || !origin) {
          sendResponse({ success: false, hashes: [] })
          return
        }
        if (request.deviceId) {
          await removeAllowedDevice(origin, request.deviceId)
          if (!scopeAuthorityIsCurrent(authority)) {
            sendResponse({ success: false, hashes: [] })
            return
          }
          removeDeviceInfo(request.deviceId)
        }
        const deviceIds = await getAllowedDevices(origin)
        if (!scopeAuthorityIsCurrent(authority)) {
          sendResponse({ success: false, hashes: [] })
          return
        }
        if (request.deviceId) await notifyAllowedDevicesChanged(request.origin, origin, deviceIds)
        sendResponse(
          scopeAuthorityIsCurrent(authority)
            ? { success: true, hashes: deviceIds }
            : { success: false, hashes: [] }
        )
      } catch (e) {
        sendResponse({ success: false, error: e.message })
      }
    })()
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleGetAllowedDevices(request, sender, sendResponse, port) {
    ;(async () => {
      try {
        const authority = scopeAuthorityForRequest(request, sender, port)
        if (!authority) {
          sendResponse({ deviceIds: [] })
          return
        }
        const deviceIds = await getAllowedDevices(authority.persistentOrigin)
        sendResponse(scopeAuthorityIsCurrent(authority) ? { deviceIds } : { deviceIds: [] })
      } catch {
        sendResponse({ deviceIds: [] })
      }
    })()
    return true
  }

  /**
   * Returns tab-wide open devices from authoritative background sessions.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetOpenDeviceIds(request, sender, sendResponse) {
    const tabId = Number.isInteger(request.tabId) ? request.tabId : sender.tab?.id
    sendResponse({
      ids: tabId == null ? [] : collectOpenDeviceIdsForTab(tabId, request.origin)
    })
    return false
  }

  /**
   * Returns tab-wide data-plane state from authoritative session owners.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} [port]
   * @returns {boolean}
   */
  function handleGetDataPlaneStatus(request, sender, sendResponse, port) {
    const tabId = Number.isInteger(request.tabId) ? request.tabId : sender.tab?.id
    const endpoint = endpointForSender(request, sender, port)
    const requestedOrigin =
      typeof request.statusOrigin === 'string' ? request.statusOrigin : null
    const endpointOrigin = endpoint ? endpoint.persistentOrigin || endpoint.origin : ''
    const origin =
      endpoint && requestedOrigin
        ? [...frameEndpoints.values()].some(
            (candidate) =>
              candidate.tabId === endpoint.tabId &&
              (candidate.persistentOrigin || candidate.origin) === requestedOrigin &&
              endpointDocumentIsLive(candidate)
          )
          ? requestedOrigin
          : endpointOrigin
        : endpointOrigin || request.origin
    const statuses = tabId == null ? [] : collectDevicePlaneStatuses(tabId, origin)
    const response = () => ({
      planes: statuses.map(({ deviceId, plane, mode, generation, ready }) => ({
        deviceId,
        plane,
        mode,
        generation,
        ready: ready === true
      })),
      defaultPlane: webhid.import('GLOBAL_DEFAULTS').dataPlane
    })
    loadEffectiveSettings(origin || '')
      .then((settings) => sendResponse({ ...response(), defaultPlane: settings.dataPlane }))
      .catch(() => sendResponse(response()))
    return true
  }

  /**
   * Updates one exact session's data-plane status.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleSetDataPlaneStatus(request, sender, sendResponse, port) {
    const endpoint = endpointForSender(request, sender, port)
    const deviceId = Number(request.deviceId)
    const ok =
      endpoint &&
      Number.isInteger(deviceId) &&
      typeof request.sessionToken === 'string' &&
      isSessionOwnedBy(
        deviceId,
        request.sessionToken,
        endpoint.origin,
        endpoint.tabId,
        endpoint.frameKey,
        request.clientKey,
        port
      )
    if (!ok) {
      sendResponse({ s: 403 })
      return false
    }
    const plane =
      request.plane == null
        ? null
        : {
            plane: request.plane,
            mode: request.mode == null ? null : request.mode,
            generation: request.generation,
            ready: request.ready === true
          }
    sendResponse({
      s: setDeviceSessionPlane(deviceId, request.sessionToken, port, plane) ? 204 : 403
    })
    return false
  }

  /**
   * Updates the tab badge from all exact frame/session owners.
   * @param {object} request
   * @param {object} sender
   * @returns {boolean}
   */
  function handleDeviceCountChanged(request, sender) {
    refreshTabDeviceBadge(sender.tab?.id)
    return false
  }

  /**
   * Shows the page action for a tab that has used the WebHID API.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleShowPageAction(request, sender, sendResponse) {
    const tabId = sender.tab != null ? sender.tab.id : undefined
    if (isChromium || !browser.pageAction || tabId == null) {
      sendResponse({})
      return false
    }
    pageActionVisibility.markUsed(tabId).catch((e) => logger.debug('pageAction.show failed', e))
    sendResponse({})
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetDeviceCache(request, sender, sendResponse) {
    if (deviceCache.length === 0) {
      NativeMessaging.enumerateDevices()
        .then((response) => {
          if (http.isOk(response.s) && response.D) {
            refreshDeviceCache(response.D)
          }
          sendResponse({ devices: deviceCache })
        })
        .catch(() => sendResponse({ devices: deviceCache }))
      return true
    }
    saveDeviceInfoBatch(deviceCache)
    sendResponse({ devices: deviceCache })
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetDeviceInfo(request, sender, sendResponse) {
    const fromPage = sender.url != null && !sender.url.startsWith(browser.runtime.getURL(''))
    if (fromPage) {
      getAllowedDevices(request.origin || '').then((ids) => {
        const tabId = sender.tab != null ? sender.tab.id : undefined
        if (ids.includes(request.deviceId) || isTabAuthorizedForDevice(tabId, request.deviceId)) {
          getDeviceInfo(request.deviceId).then((device) => sendResponse({ device }))
        } else {
          sendResponse({ device: null })
        }
      })
      return true
    }
    getDeviceInfo(request.deviceId).then((device) => sendResponse({ device }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleFetchResource(request, sender, sendResponse) {
    const path = request.path
    if (!path || typeof path !== 'string' || path.includes('..')) {
      sendResponse({ error: 'invalid path' })
      return false
    }
    fetch(browser.runtime.getURL(path))
      .then((r) => r.text())
      .then((text) => sendResponse({ text }))
      .catch((e) => sendResponse({ error: e.message || String(e) }))
    return true
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetCspInfo(request, sender, sendResponse) {
    const tabId = sender.tab != null ? sender.tab.id : undefined
    if (tabId == null) {
      sendResponse(null)
      return false
    }
    const authorityOrigin = typeof sender.origin === 'string' ? sender.origin : ''
    const documentUrlOrigin = urlOrigin(sender.url || '')
    if (!authorityOrigin || !documentUrlOrigin) {
      sendResponse(null)
      return false
    }
    const key = `csp:${frameKey(tabId, sender.frameId ?? 0, documentUrlOrigin)}`
    browser.storage.session
      .get(key)
      .then((r) => sendResponse(r[key] ?? null))
      .catch(() => sendResponse(null))
    return true
  }

  /**
   * Relays the frame-origin list for a tab from its top-frame bridge. The
   * popup passes its active tab's id; page messages carry it via sender.tab.
   * @param {object} request
   * @param {object} sender
   * @param {Function} sendResponse
   * @returns {boolean}
   */
  function handleGetFrameOrigins(request, sender, sendResponse) {
    const tabId = request.tabId != null ? request.tabId : sender.tab ? sender.tab.id : undefined
    if (tabId == null) {
      sendResponse({ origins: [], targets: [] })
      return false
    }
    const origins = []
    const targets = []
    const seen = new Set()
    const endpoints = [...frameEndpoints.values()]
      .filter((endpoint) => endpoint.tabId === tabId)
      .sort((a, b) => a.frameId - b.frameId)
    for (const endpoint of endpoints) {
      const isHttp = endpoint.origin.startsWith('http:') || endpoint.origin.startsWith('https:')
      if (isHttp) {
        if (seen.has(endpoint.origin)) continue
        seen.add(endpoint.origin)
        origins.push(endpoint.origin)
        targets.push({
          kind: 'origin',
          label: endpoint.origin,
          origin: endpoint.origin,
          persistentOrigin: endpoint.persistentOrigin
        })
      } else if (endpoint.persistentOrigin && !seen.has(endpoint.persistentOrigin)) {
        seen.add(endpoint.persistentOrigin)
        targets.push({
          kind: 'opaque',
          origin: endpoint.origin,
          persistentOrigin: endpoint.persistentOrigin
        })
      }
    }
    sendResponse({ origins, targets })
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetWorkerBundle(request, sender, sendResponse) {
    ensureWorkerBundle()
      .then((text) => sendResponse({ text }))
      .catch((e) => sendResponse({ error: e.message || String(e) }))
    return true
  }

  /**
   * Opens the picker in a dedicated popup window.
   * @returns {void}
   */
  function openPickerWindow() {
    const sW = globalThis.screen?.availWidth || 1280
    const sH = globalThis.screen?.availHeight || 720
    const winW = Math.min(380, sW - 20)
    const winH = Math.min(480, sH - 80)
    browser.windows
      .create({
        type: 'popup',
        url: 'js/internal/pages/picker/index.html',
        width: winW,
        height: winH,
        left: Math.max(0, Math.round((sW - winW) / 2)),
        top: Math.max(0, Math.round((sH - winH) / 2))
      })
      .catch(() => {})
  }

  /**
   * Restores the page action visibility and popup after a picker closes.
   * @param {number} tabId
   * @returns {void}
   */
  function restorePageAction(tabId) {
    if (isChromium || !browser.pageAction || tabId == null) return
    Promise.all([
      pageActionVisibility.reconcile(tabId),
      browser.pageAction.setIcon({ tabId, path: 'icons/gamepad.svg' }),
      browser.pageAction.setPopup({
        tabId,
        popup: 'js/internal/pages/popup/index.html'
      })
    ]).catch((e) => logger.debug('restore pageAction failed', e))
  }

  /**
   * Opens the picker as a pageAction popup, alerting the user via a
   * notification when the requesting tab is not the active one.
   * @param {object} req
   * @param {number} tabId
   * @param {string} origin
   * @returns {void}
   */
  function openPickerPageAction(tabId, origin) {
    if (isChromium) return
    pageActionVisibility
      .reconcile(tabId)
      .then(() =>
        Promise.all([
          browser.pageAction.setIcon({
            tabId,
            path: 'icons/gamepad.alert.svg'
          }),
          browser.pageAction.setPopup({
            tabId,
            popup: 'js/internal/pages/picker/index.html'
          })
        ])
      )
      .then(() => {
        if (browser.pageAction.openPopup) return browser.pageAction.openPopup()
      })
      .catch((e) => logger.debug('openPickerPageAction failed', e))
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        const tab = tabs[0]
        if (tab && tab.id !== tabId) {
          browser.notifications.create('webhid-picker', {
            type: 'basic',
            iconUrl: browser.runtime.getURL('icons/icon.svg'),
            title: 'WebHID',
            message: `A website (${origin}) is requesting a HID device. Click to choose.`
          })
        }
      })
      .catch(() => {})
  }

  /**
   * Cancels a page-action picker after the requesting page times out.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleCancelPicker(request, sender, sendResponse) {
    const tabId = sender.tab != null ? sender.tab.id : undefined
    const req = tabId != null ? pendingPicker.get(tabId) : null
    if (req && req.requestId === request.requestId) {
      pendingPicker.delete(tabId)
      if (req.mode === 'pageAction') {
        restorePageAction(tabId)
        if (browser.notifications) browser.notifications.clear('webhid-picker').catch(() => {})
      }
    }
    sendResponse({ ok: true })
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleShowPicker(request, sender, sendResponse, port) {
    const endpoint = endpointForSender(request, sender, port)
    const tabId = endpoint?.tabId
    if (!endpoint) {
      sendResponse({ error: 'no frame endpoint' })
      return false
    }
    const req = {
      requestId: request.requestId,
      tabId,
      ownerEndpointId: endpoint.id,
      uiEndpointId: null,
      port,
      filters: request.filters || [],
      exclusionFilters: request.exclusionFilters || [],
      origin: endpoint.origin,
      mode: request.mode || 'pageAction'
    }
    if (req.mode === 'modal') {
      const top = [...frameEndpoints.values()].find(
        (candidate) => candidate.tabId === tabId && candidate.frameId === 0
      )
      if (!top) {
        sendResponse({ error: 'top frame endpoint unavailable' })
        return false
      }
      req.uiPort = top.port
      req.uiEndpointId = top.id
      pendingPicker.set(tabId, req)
      postToContentPort(top.port, {
        action: 'showInlinePicker',
        requestId: req.requestId,
        filters: req.filters,
        exclusionFilters: req.exclusionFilters
      })
    } else {
      pendingPicker.set(tabId, req)
      if (req.mode === 'window') openPickerWindow()
      else openPickerPageAction(tabId, endpoint.origin)
    }
    sendResponse({ ok: true })
    return false
  }

  /**
   * Accepts a picker result from the registered top-frame UI host.
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  function handleInlinePickerResult(request, sender, sendResponse, port) {
    const req = [...pendingPicker.values()].find(
      (candidate) => candidate.requestId === request.requestId
    )
    if (!req || req.uiPort !== port) {
      sendResponse({ ok: false })
      return false
    }
    pendingPicker.delete(req.tabId)
    postToContentPort(req.port, {
      action: 'pickerResult',
      requestId: req.requestId,
      selected: request.selected === true,
      devices: request.selected === true ? request.devices : null
    })
    sendResponse({ ok: true })
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleGetPendingPicker(request, sender, sendResponse) {
    sendResponse(pendingPicker.size > 0 ? [...pendingPicker.values()][0] : null)
    return false
  }

  /**
   * Resolves a policy record to the document ID observed by the browser.
   * @param {number} tabId
   * @param {number} frameId
   * @param {string} documentId
   * @param {string} origin
   * @returns {object|null}
   */
  function policyEntryForDocument(tabId, frameId, documentId, origin) {
    const exactKey = documentFrameKey(tabId, frameId, documentId)
    let entry = permissionsPolicy.get(exactKey)
    if (!entry) {
      const pendingKey = documentFrameKey(tabId, frameId, '')
      entry = permissionsPolicy.get(pendingKey) || null
      if (entry && entry.origin === origin) {
        permissionsPolicy.delete(pendingKey)
        entry.documentId = documentId
        permissionsPolicy.set(exactKey, entry)
      }
    }
    return entry && entry.origin === origin ? entry : null
  }
  /**
   * Ensures every cross-origin container edge in the exact ancestry has a
   * browser-authenticated delegation result.
   * @param {object} endpoint
   * @returns {Promise<boolean>}
   */
  async function ensureFrameDelegations(endpoint) {
    let child = endpoint
    const visited = new Set()
    while (child && child.frameId !== 0) {
      const key = documentFrameKey(child.tabId, child.frameId, child.documentId)
      if (visited.has(key)) return false
      visited.add(key)
      const entry = policyEntryForDocument(
        child.tabId,
        child.frameId,
        child.documentId,
        child.origin
      )
      if (!entry || !entry.parentKey) return false
      const parent = parentEndpointFor(child)
      const parentEntry = permissionsPolicy.get(entry.parentKey)
      if (!parent || !parentEntry || !parentEntry.origin) return false
      const delegated = await queryFrameDelegation(child)
      if (!endpointDocumentIsLive(child)) return false
      frameDelegations.set(key, delegated)
      child = parent
    }
    return !!child
  }
  /**
   * @param {object} entry
   * @param {Set<string>} visited
   * @returns {boolean}
   */
  function effectivePolicyAllowsEntry(entry, visited = new Set()) {
    if (!entry || entry.effective.kind === 'none') return false
    const key = documentFrameKey(entry.tabId, entry.frameId, entry.documentId)
    if (visited.has(key)) return false
    visited.add(key)
    if (entry.parentKey) {
      const parent = permissionsPolicy.get(entry.parentKey)
      if (!parent || !effectivePolicyAllowsEntry(parent, visited)) return false
      if (frameDelegations.get(key) !== true) return false
    }
    return (
      entry.effective.kind === 'all' ||
      (entry.effective.kind === 'list' && entry.effective.origins.includes(entry.origin))
    )
  }
  /**
   * @param {object} request
   * @param {object} sender
   * @returns {{policy: {hid: string}}}
   */
  function policyForRequest(request, sender) {
    const tabId = sender.tab?.id
    const frameId = Number.isInteger(sender.frameId) ? sender.frameId : null
    const documentId = typeof sender.documentId === 'string' ? sender.documentId : null
    const requestedOrigin = typeof sender.origin === 'string' ? sender.origin : ''
    if (tabId == null || frameId == null || !documentId || !requestedOrigin) {
      return { policy: { hid: 'none' } }
    }
    const entry = policyEntryForDocument(tabId, frameId, documentId, requestedOrigin)
    return effectivePolicyAllowsEntry(entry)
      ? { policy: { hid: 'allowed' } }
      : { policy: { hid: 'none' } }
  }
  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @param {object} port
   * @returns {boolean}
   */
  async function handleGetPolicy(request, sender, sendResponse, port) {
    const endpoint = endpointForSender(request, sender, port)
    if (
      !endpoint ||
      !(await ensureFrameDelegations(endpoint)) ||
      !endpointDocumentIsLive(endpoint)
    ) {
      sendResponse({ policy: { hid: 'none' } })
      return false
    }
    sendResponse(policyForRequest(request, sender))
    return false
  }
  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleSetFrameDelegation(request, sender, sendResponse) {
    const tabId = sender.tab?.id
    const frameId = Number.isInteger(sender.frameId) ? sender.frameId : null
    const documentId = typeof sender.documentId === 'string' ? sender.documentId : null
    const origin = typeof sender.origin === 'string' ? sender.origin : ''
    if (tabId == null || frameId == null || !documentId || !origin) {
      sendResponse({ ok: false })
      return false
    }
    const exactKey = documentFrameKey(tabId, frameId, documentId)
    const entry = policyEntryForDocument(tabId, frameId, documentId, origin)
    if (!entry || entry.origin !== origin) {
      sendResponse({ ok: false })
      return false
    }
    frameDelegations.set(exactKey, request.delegated === true)
    sendResponse({ ok: true })
    return false
  }
  /**
   * Arms the shadow-URL interception for the next worker script request from
   * the given tab+document, so the polyfill's own data-worker spawn is
   * distinguishable from a page self-worker. The webRequest handler consumes
   * one arm per matching request.
   * @param {object} request
   * @param {object} sender
   * @param {Function} sendResponse
   * @returns {boolean}
   */
  function handleArmShadowSpawn(request, sender, sendResponse) {
    const tabId = request.tabId != null ? request.tabId : sender.tab ? sender.tab.id : null
    const url = typeof request.url === 'string' ? request.url : ''
    const arm = webhid.import('armShadowSpawn')
    if (arm) arm(tabId, url)
    sendResponse({ ok: true })
    return false
  }

  /**
   *
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handleUnarmShadowSpawn(request, sender, sendResponse) {
    const tabId = request.tabId != null ? request.tabId : sender.tab ? sender.tab.id : null
    const url = typeof request.url === 'string' ? request.url : ''
    const unarm = webhid.import('unarmShadowSpawn')
    if (unarm) unarm(tabId, url)
    sendResponse({ ok: true })
    return false
  }

  /**
   * @param {object} request
   * @param {object} sender
   * @param {function(*): void} sendResponse
   * @returns {boolean}
   */
  function handlePickerResult(request, sender, sendResponse) {
    const pickerPage = browser.runtime.getURL('js/internal/pages/picker/index.html')
    if (sender.url == null || !sender.url.startsWith(pickerPage)) {
      logger.warn('pickerResult rejected: sender is not the picker page')
      sendResponse({ ok: false })
      return false
    }
    const { requestId, selected, devices } = request
    let tabId = request.tabId
    if (tabId == null && pendingPicker.size > 0) tabId = [...pendingPicker.keys()][0]
    const req = tabId != null ? pendingPicker.get(tabId) : null
    if (tabId != null) pendingPicker.delete(tabId)
    if (req?.mode === 'pageAction' && !isChromium) {
      restorePageAction(tabId)
      if (browser.notifications) browser.notifications.clear('webhid-picker').catch(() => {})
    }
    if (request.windowId != null) browser.windows.remove(request.windowId).catch(() => {})
    if (req?.port) {
      postToContentPort(req.port, {
        action: 'pickerResult',
        requestId,
        selected,
        devices: selected ? devices : null
      })
    }
    sendResponse({ ok: true })
    return false
  }

  /** @type {object} */
  const HANDLERS = {
    enumerate: handleEnumerate,
    enumeratePaired: handleEnumeratePaired,
    handshake: handleHandshake,
    getBackendStatus: handleGetBackendStatus,
    recordGrantGroup: handleRecordGrantGroup,
    getGrantGroups: handleGetGrantGroups,
    getAllPairedDevices: handleGetAllPairedDevices,
    open: handleOpen,
    close: handleClose,
    frameDestroyed: handleFrameDestroyed,
    fanoutOpen: handleFanoutOpen,
    revokeDevice: handleRevokeDevice,
    cleanupSession: handleCleanupSession,
    setDataPlane: handleSetDataPlane,
    sendReport: handleSendReport,
    receiveFeatureReport: handleReceiveFeatureReport,
    sendFeatureReport: handleSendFeatureReport,
    getPairedDevices: handleGetPairedDevices,
    pairDevice: handlePairDevice,
    unpairDevice: handleUnpairDevice,
    getAllowedDevices: handleGetAllowedDevices,
    getOpenDeviceIds: handleGetOpenDeviceIds,
    getDataPlaneStatus: handleGetDataPlaneStatus,
    getDataPlaneStatusForOrigin: handleGetDataPlaneStatus,
    setDataPlaneStatus: handleSetDataPlaneStatus,
    deviceCountChanged: handleDeviceCountChanged,
    showPageAction: handleShowPageAction,
    getDeviceCache: handleGetDeviceCache,
    getDeviceInfo: handleGetDeviceInfo,
    fetchResource: handleFetchResource,
    getCspInfo: handleGetCspInfo,
    getFrameOrigins: handleGetFrameOrigins,
    getWorkerBundle: handleGetWorkerBundle,
    showPicker: handleShowPicker,
    cancelPicker: handleCancelPicker,
    getPendingPicker: handleGetPendingPicker,
    setFrameDelegation: handleSetFrameDelegation,
    getPolicy: handleGetPolicy,
    armShadowSpawn: handleArmShadowSpawn,
    unarmShadowSpawn: handleUnarmShadowSpawn,
    pickerResult: handlePickerResult,
    inlinePickerResult: handleInlinePickerResult
  }

  /**
   * Posts one uncorrelated response onto a control port for requests rejected
   * before handler dispatch.
   * @param {object} port
   * @param {object} request
   * @param {object} response
   * @returns {void}
   */
  function sendPortResponseStatic(port, request, response) {
    const responseMessage = { ...(response || {}) }
    if (request.reqId != null) responseMessage.reqId = request.reqId
    try {
      port.postMessage(responseMessage)
    } catch {
      void 0
    }
  }

  /**
   * Registers the background message dispatcher.
   * @param {{actionApi: object|null}} deps
   * @returns {void}
   */
  function registerMessageHandlers(deps) {
    actionApi = deps.actionApi
    setBadgeRefresh(refreshTabDeviceBadge)
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
      const handler = HANDLERS[request.action]
      if (!handler) return false
      return handler(request, sender, sendResponse)
    })
    browser.runtime.onConnect.addListener((port) => {
      registerContentPort(port)
      const endpoint = port.name === 'webhid-control' ? registerFrameEndpoint(port) : null
      port.onMessage.addListener((request) => {
        if (request.action === 'frameDelegationResult') {
          const pending = delegationPending.get(request.requestId)
          if (!pending || pending.parent.port !== port) return
          delegationPending.delete(request.requestId)
          pending.resolve(request.delegated === true)
          return
        }
        const logical =
          typeof request.channel === 'string' && request.channel
            ? fanoutEndpoints.get(request.channel) || null
            : null
        if (logical && (logical.retired || logical.port !== port)) {
          sendPortResponseStatic(port, request, { s: 403 })
          return
        }
        const attributed = logical || endpoint
        const sender = attributed
          ? {
              ...(port.sender || {}),
              frameId: attributed.frameId,
              documentId: attributed.documentId,
              origin: attributed.origin,
              url: attributed.url
            }
          : port.sender
        const effectiveRequest = attributed
          ? {
              ...request,
              origin: attributed.origin,
              persistentOrigin: attributed.persistentOrigin,
              ...(request.action === 'getDataPlaneStatusForOrigin' &&
              typeof request.statusOrigin === 'string'
                ? { statusOrigin: request.statusOrigin }
                : {})
            }
          : request
        const handler = HANDLERS[effectiveRequest.action]
        if (!handler) return
        let responded = false
        const sendPortResponse = (response) => {
          if (responded) return
          responded = true
          const responseMessage = { ...(response || {}) }
          if (effectiveRequest.reqId != null) responseMessage.reqId = effectiveRequest.reqId
          try {
            port.postMessage(responseMessage)
          } catch {
            void 0
          }
        }
        try {
          const result = handler(effectiveRequest, sender, sendPortResponse, port)
          if (result && typeof result.then === 'function') {
            result.catch(() => sendPortResponse({ s: 500 }))
          } else if (result !== true && !responded) {
            sendPortResponse(result || {})
          }
        } catch {
          sendPortResponse({ s: 500 })
        }
      })
      if (endpoint) {
        port.onDisconnect.addListener(() => {
          const cleanup = retireEndpoint(endpoint)
          refreshEndpointPersistence(endpoint.tabId)
          if (cleanup) void cleanup
        })
      }
    })
  }

  webhid.export('backgroundEventFanout', { postToPersistentOriginEndpoints })
  webhid.export('registerMessageHandlers', registerMessageHandlers)
})()
