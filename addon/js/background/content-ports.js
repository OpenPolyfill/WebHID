;(function () {
  const webhid = globalThis.webhid
  const ports = new Set()
  const portsByName = new Map()
  function removeContentPort(port) {
    ports.delete(port)
    const group = portsByName.get(port.name)
    if (!group) return
    group.delete(port)
    if (group.size === 0) portsByName.delete(port.name)
  }
  /** @param {object} port @returns {void} */
  function registerContentPort(port) {
    ports.add(port)
    let group = portsByName.get(port.name)
    if (!group) {
      group = new Set()
      portsByName.set(port.name, group)
    }
    group.add(port)
    port.onDisconnect.addListener(() => removeContentPort(port))
  }
  /**
   * @param {number[]|null} tabIds
   * @param {object} message
   * @param {string} portName
   * @returns {Set<number>}
   */
  function postToContentPorts(tabIds, message, portName) {
    const targets = tabIds ? new Set(tabIds) : null
    const reached = new Set()
    const selectedPorts = portName ? portsByName.get(portName) : ports
    if (!selectedPorts) return reached
    for (const port of selectedPorts) {
      const tabId = port.sender && port.sender.tab && port.sender.tab.id
      if (targets && (tabId == null || !targets.has(tabId))) continue
      try {
        port.postMessage(message)
        if (tabId != null) reached.add(tabId)
      } catch {
        removeContentPort(port)
      }
    }
    return reached
  }
  /**
   * Sends a message to every registered port with an exact name.
   * @param {string} portName
   * @param {object} message
   * @returns {boolean}
   */
  function postToNamedContentPorts(portName, message) {
    const selectedPorts = portsByName.get(portName)
    if (!selectedPorts) return false
    let delivered = false
    for (const port of selectedPorts) {
      try {
        port.postMessage(message)
        delivered = true
      } catch {
        removeContentPort(port)
      }
    }
    return delivered
  }
  /**
   * Sends one message to a registered exact endpoint.
   * @param {object} port
   * @param {object} message
   * @returns {void}
   */
  function postToContentPort(port, message) {
    if (!ports.has(port)) return
    try {
      port.postMessage(message)
    } catch {
      removeContentPort(port)
    }
  }
  webhid.export('content-ports', {
    registerContentPort,
    postToContentPorts,
    postToNamedContentPorts,
    postToContentPort
  })
})()
