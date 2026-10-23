class NativeDoorhanger {
  static notificationId = 'webHID-chooseDevice'

  #window
  #popup
  #requests = new Map()
  #queue = []
  #active = null
  #destroyed = false
  #template
  #menu
  #menuPopup
  #label
  #empty
  #onUnload

  constructor(window, onUnload) {
    this.#window = window
    this.#popup = window.PopupNotifications
    const doc = window.document
    const source = doc.getElementById('webSerial-choosePort-notification')
    if (!source || !this.#popup) throw new Error('WebSerial doorhanger template unavailable')
    if (doc.getElementById(NativeDoorhanger.notificationId + '-notification')) {
      throw new Error('Native WebHID picker already initialized in this window')
    }
    this.#template = source.cloneNode(true)
    for (const node of [this.#template, ...this.#template.querySelectorAll('[id]')]) {
      if (node.id.startsWith('webSerial-')) {
        node.id = 'webHID-' + node.id.slice('webSerial-'.length)
      }
    }
    this.#template.id = NativeDoorhanger.notificationId + '-notification'
    this.#menu = this.#template.querySelector('#webHID-selectPort-menulist')
    this.#menuPopup = this.#template.querySelector('#webHID-selectPort-menupopup')
    this.#label = this.#template.querySelector('#webHID-selectPort-label')
    this.#empty = this.#template.querySelector('#webHID-no-ports-available')
    this.#label.removeAttribute('data-l10n-id')
    this.#label.setAttribute('control', this.#menu.id)
    this.#empty.removeAttribute('data-l10n-id')
    source.parentNode.appendChild(this.#template)
    this.#onUnload = () => {
      this.destroy()
      onUnload()
    }
    window.addEventListener('unload', this.#onUnload, { once: true })
  }

  keyFor(tabId, requestId) {
    return String(tabId) + ':' + String(requestId)
  }

  show(browser, input) {
    if (this.#destroyed) throw new Error('Native WebHID picker has been destroyed')
    const key = this.keyFor(input.tabId, input.requestId)
    if (this.#requests.has(key)) throw new Error('Duplicate native picker request')
    return new Promise((resolve, reject) => {
      const entry = {
        key,
        browser,
        tabId: input.tabId,
        requestId: input.requestId,
        message: input.message,
        name: input.name ?? '',
        groups: input.groups ?? [],
        loading: input.loading ?? false,
        error: input.error ?? null,
        selectLabel: input.selectLabel ?? 'Select a HID device',
        emptyText: input.emptyText ?? 'No devices available',
        loadingText: input.loadingText ?? 'Searching for devices...',
        connectLabel: input.connectLabel ?? 'Connect',
        cancelLabel: input.cancelLabel ?? 'Cancel',
        phase: 'queued',
        notification: null,
        primaryAction: null,
        resolve,
        reject
      }
      this.#requests.set(key, entry)
      this.#queue.push(entry)
      this.pump()
    })
  }

  update(tabId, requestId, input) {
    const entry = this.#requests.get(this.keyFor(tabId, requestId))
    if (!entry) return false
    const selectedId = this.#active === entry ? entry.groups[this.#menu.selectedIndex]?.id : null
    if (Object.hasOwn(input, 'groups')) entry.groups = input.groups
    if (Object.hasOwn(input, 'loading')) entry.loading = input.loading
    if (Object.hasOwn(input, 'error')) entry.error = input.error
    if (Object.hasOwn(input, 'emptyText')) entry.emptyText = input.emptyText
    if (this.#active === entry) this.render(entry, selectedId)
    return true
  }

  cancel(tabId, requestId) {
    const entry = this.#requests.get(this.keyFor(tabId, requestId))
    if (!entry) return false
    this.settle(entry, null, true)
    return true
  }

  state(tabId, requestId) {
    const entry = this.#requests.get(this.keyFor(tabId, requestId))
    if (!entry) return { phase: 'idle' }
    return {
      phase: entry.phase,
      requestId: entry.requestId,
      loading: entry.loading,
      error: entry.error,
      deviceCount: entry.groups.length
    }
  }

  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#window.removeEventListener('unload', this.#onUnload)
    for (const entry of [...this.#requests.values()]) this.settle(entry, null, true)
    const remove = () => this.#template.remove()
    if (this.#template.parentNode === this.#popup.panel) {
      this.#popup.panel.addEventListener('popuphidden', remove, { once: true })
    } else {
      remove()
    }
  }

  pump() {
    if (this.#destroyed || this.#active || !this.#queue.length) return
    const entry = this.#queue.shift()
    if (!this.#requests.has(entry.key)) return this.pump()
    this.#active = entry
    entry.phase = 'opening'
    const primaryAction = {
      label: entry.connectLabel,
      accessKey: 'C',
      disabled: true,
      callback: () => {
        const group = entry.groups[this.#menu.selectedIndex]
        this.settle(entry, group?.id ?? null, false)
      }
    }
    entry.primaryAction = primaryAction
    try {
      this.render(entry)
      entry.notification = this.#popup.show(
        entry.browser,
        NativeDoorhanger.notificationId,
        entry.message,
        'serial-notification-icon',
        primaryAction,
        [
          {
            label: entry.cancelLabel,
            accessKey: 'a',
            callback: () => this.settle(entry, null, false)
          }
        ],
        {
          displayURI: false,
          name: entry.name,
          persistent: true,
          hideClose: true,
          popupIconURL: 'chrome://browser/skin/notification-icons/serial.svg',
          eventCallback: (topic) => {
            if (this.#active !== entry) return
            if (topic === 'showing') entry.phase = 'opening'
            if (topic === 'shown') entry.phase = 'open'
            if (topic === 'removed') this.settle(entry, null, false)
          }
        }
      )
    } catch (error) {
      this.#requests.delete(entry.key)
      this.#active = null
      entry.reject(error)
      Promise.resolve().then(() => this.pump())
    }
  }

  render(entry, selectedId = null) {
    this.#label.textContent = entry.selectLabel
    const enabled = !entry.loading && !entry.error && entry.groups.length > 0
    this.#menu.hidden = !enabled
    this.#empty.hidden = enabled
    this.#empty.textContent = entry.error || (entry.loading ? entry.loadingText : entry.emptyText)
    this.#menuPopup.replaceChildren()
    if (enabled) {
      for (const group of entry.groups) {
        const item = this.#window.document.createXULElement('menuitem')
        item.setAttribute('label', group.label)
        item.setAttribute('value', group.id)
        this.#menuPopup.appendChild(item)
      }
      const index = entry.groups.findIndex((group) => group.id === selectedId)
      this.#menu.selectedIndex = index >= 0 ? index : 0
    }
    entry.primaryAction.disabled = !enabled
    this.#template.toggleAttribute('mainactiondisabled', !enabled)
  }

  settle(entry, groupId, removeNotification) {
    if (!this.#requests.has(entry.key)) return
    this.#requests.delete(entry.key)
    this.#queue = this.#queue.filter((candidate) => candidate !== entry)
    if (this.#active === entry) this.#active = null
    const selected = groupId != null && entry.groups.some((group) => group.id === groupId)
    entry.phase = 'closed'
    entry.resolve({
      requestId: entry.requestId,
      selected,
      groupId: selected ? groupId : null
    })
    if (removeNotification) entry.notification?.remove()
    Promise.resolve().then(() => this.pump())
  }
}

this.webhidNativePicker = class extends ExtensionAPI {
  getAPI(context) {
    if (!this.controllers) {
      this.controllers = new Map()
      this.requests = new Map()
      this.extension.callOnClose({
        close: () => {
          for (const controller of this.controllers.values()) controller.destroy()
          this.controllers.clear()
          this.requests.clear()
        }
      })
    }
    const keyFor = (input) => String(input.tabId) + ':' + String(input.requestId)
    return {
      webhidNativePicker: {
        show: (input) => {
          try {
            const tabEntry = context.extension.tabManager.get(input.tabId)
            const nativeTab = tabEntry?.nativeTab
            const browser = nativeTab?.linkedBrowser
            if (!browser) {
              throw new Error(
                `Firefox tab ${input.tabId} does not expose a linked browser: ${String(nativeTab)}`
              )
            }
            const window = browser.documentGlobal
            if (!window) throw new Error(`Browser window unavailable for tab ${input.tabId}`)
            let controller = this.controllers.get(window)
            if (!controller) {
              controller = new NativeDoorhanger(window, () => this.controllers.delete(window))
              this.controllers.set(window, controller)
            }
            const requestKey = keyFor(input)
            const result = controller.show(browser, input)
            this.requests.set(requestKey, controller)
            return result
              .finally(() => this.requests.delete(requestKey))
              .catch((error) => ({
                requestId: input.requestId,
                selected: false,
                groupId: null,
                error: String(error)
              }))
          } catch (error) {
            return Promise.resolve({
              requestId: input.requestId,
              selected: false,
              groupId: null,
              error: String(error)
            })
          }
        },
        update: async (input) =>
          this.requests.get(keyFor(input))?.update(input.tabId, input.requestId, input) ?? false,
        cancel: async (input) =>
          this.requests.get(keyFor(input))?.cancel(input.tabId, input.requestId) ?? false,
        getState: async (input) =>
          this.requests.get(keyFor(input))?.state(input.tabId, input.requestId) ?? { phase: 'idle' }
      }
    }
  }
}
