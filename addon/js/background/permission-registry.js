;(function () {
  const webhid = globalThis.webhid
  const logger = webhid.import('logger')
  const { getAllowedDevices } = webhid.import('bgStorage')
  const { persistentSiteScope } = webhid.import('persistentSiteScope')
  const { frameEndpoints } = webhid.import('bgState')
  const api = browser.permissions.web

  if (!api || typeof api.register !== 'function') {
    throw new Error('Permission Registry background runtime was not loaded')
  }

  // Background message senders are browser-authenticated. Prefer the exact
  // document endpoint, which also carries the top-origin-derived opaque scope.
  function scopeForSender(sender) {
    const endpoint = [...frameEndpoints.values()].find((entry) =>
      !entry.retired && entry.tabId === sender.tab?.id &&
      entry.frameId === sender.frameId &&
      entry.documentId && entry.documentId === sender.documentId &&
      entry.origin === sender.origin
    )
    if (endpoint) return endpoint.persistentOrigin || null
    return persistentSiteScope(sender.origin || '', sender.url || '', null)
  }

  async function stateForScope(scope) {
    if (!scope) return 'prompt'
    const ids = await getAllowedDevices(scope)
    return ids.length ? 'granted' : 'prompt'
  }

  let registration = null
  const ready = Promise.resolve(api.register({ name: 'hid', backend: 'auto' }, {
    async query(_descriptor, sender) {
      return stateForScope(scopeForSender(sender))
    }
  })).then((handle) => {
    registration = handle || null
    return handle
  })
  ready.catch((error) => logger.error('Permission Registry registration failed', error))

  // Workers use the owning document's Registry state and policy. No parallel
  // Permissions-Policy parser or separate grant store is introduced.
  async function stateForWorker(endpoint) {
    await ready
    const allowed = typeof api.policyAllowsForPage === 'function'
      ? await api.policyAllowsForPage(endpoint.tabId, endpoint.frameId, 'hid')
      : await globalThis.XrayPermissionPolicy.allows({
          ...endpoint.port.sender,
          tab: { id: endpoint.tabId },
          frameId: endpoint.frameId,
          documentId: endpoint.documentId,
          origin: endpoint.origin,
          url: endpoint.url
        }, 'hid')
    if (!allowed) return 'denied'
    if (typeof api.getForPage === 'function') {
      const result = await api.getForPage(endpoint.tabId, endpoint.frameId, 'hid')
      return result?.registered ? result.state : 'denied'
    }
    return stateForScope(endpoint.persistentOrigin)
  }

  function notifyWorkers(scope) {
    for (const endpoint of frameEndpoints.values()) {
      if (scope && endpoint.persistentOrigin !== scope) continue
      if (endpoint.retired) continue
      try { endpoint.port.postMessage({ action: 'registryPermissionChanged', name: 'hid' }) }
      catch { /* A closing document has no remaining workers. */ }
    }
  }

  // The privileged backend reads Services.perms, not the ordinary query adapter.
  async function syncFrame(endpoint) {
    await ready
    if (typeof api.setForPage !== 'function') {
      // A query issued before the WebHID control endpoint is initialized must
      // be refreshed as soon as its authenticated persistent scope is known.
      await registration?.notify()
      return
    }
    if (!endpoint.persistentOrigin) return
    if (!endpoint.documentId || !Number.isInteger(endpoint.tabId) ||
        !Number.isInteger(endpoint.frameId)) return
    const ids = await getAllowedDevices(endpoint.persistentOrigin)
    if (frameEndpoints.get(endpoint.port) !== endpoint) return
    // Do not assign the state to a replacement document after navigation.
    const frame = await browser.webNavigation.getFrame({
      tabId: endpoint.tabId,
      frameId: endpoint.frameId,
      documentId: endpoint.documentId
    }).catch(() => null)
    if (frame?.documentId !== endpoint.documentId) return
    if (frameEndpoints.get(endpoint.port) !== endpoint) return
    await api.setForPage(
      endpoint.tabId, endpoint.frameId, 'hid', ids.length ? 'granted' : 'prompt'
    )
  }

  async function notifyOrigin(persistentOrigin) {
    await ready
    if (typeof api.setForPage === 'function') {
      const matching = [...frameEndpoints.values()].filter(
        (endpoint) => endpoint.persistentOrigin === persistentOrigin
      )
      await Promise.all(matching.map((endpoint) => syncFrame(endpoint)))
    } else {
      await registration?.notify()
    }
    notifyWorkers(persistentOrigin)
  }

  if (api.onChanged?.addListener) {
    api.onChanged.addListener((name) => {
      if (name === 'hid') notifyWorkers(null)
    })
  }

  webhid.export('bgPermissionRegistry', { ready, syncFrame, notifyOrigin, stateForWorker })
})()
