;(function () {
  class WebHidNativePickerHelper {
    constructor({ api, enumerate, groupDevices, groupIdFor }) {
      this.api = api
      this.enumerate = enumerate
      this.groupDevices = groupDevices
      this.groupIdFor = groupIdFor
      this.requests = new Map()
    }

    keyFor(tabId, requestId) {
      return String(tabId) + ':' + String(requestId)
    }

    async show(input) {
      const key = this.keyFor(input.tabId, input.requestId)
      if (this.requests.has(key)) throw new Error('Duplicate native picker request')
      const entry = {
        key,
        tabId: input.tabId,
        requestId: input.requestId,
        filters: input.filters ?? [],
        exclusionFilters: input.exclusionFilters ?? [],
        groups: new Map(),
        generation: 0,
        loading: true,
        error: null,
        filterApplied: false,
        phase: 'opening'
      }
      this.requests.set(key, entry)
      try {
        const pending = this.api.show({
          tabId: entry.tabId,
          requestId: entry.requestId,
          name: input.origin,
          message: 'Allow <> to connect to a HID device?',
          groups: [],
          loading: true,
          selectLabel: 'Select a HID device',
          emptyText: 'No devices available',
          loadingText: 'Searching for devices...',
          errorText: 'Unable to enumerate devices',
          connectLabel: 'Connect',
          cancelLabel: 'Cancel'
        })
        void this.refreshDevices(entry.tabId, entry.requestId).catch(() => {
          this.cancel(entry.tabId, entry.requestId).catch(() => {})
        })
        const result = await pending
        if (result.error) throw new Error(result.error)
        entry.phase = 'closed'
        return { devices: result.selected ? (entry.groups.get(result.groupId) ?? []) : [] }
      } finally {
        entry.generation++
        this.requests.delete(key)
      }
    }

    async refreshDevices(tabId, requestId) {
      const entry = this.requests.get(this.keyFor(tabId, requestId))
      if (!entry) return false
      const generation = ++entry.generation
      entry.loading = true
      entry.error = null
      entry.phase = 'loading'
      let response
      try {
        response = await this.enumerate(entry.filters, entry.exclusionFilters)
      } catch {
        if (this.requests.get(entry.key) !== entry || generation !== entry.generation) return false
        entry.groups = new Map()
        entry.loading = false
        entry.error = 'Unable to enumerate devices'
        entry.phase = 'error'
        return this.api.update({ tabId, requestId, groups: [], loading: false, error: entry.error })
      }
      if (this.requests.get(entry.key) !== entry || generation !== entry.generation) return false
      return this.applyDevices(entry, response.devices, response.filtered === true)
    }

    async applyDevices(entry, devices, filterApplied) {
      const grouped = this.groupDevices(devices)
      const options = []
      const groupMap = new Map()
      for (const [name, group] of grouped.entries()) {
        const id = String(this.groupIdFor(group))
        groupMap.set(id, group.slice())
        options.push({ id, label: name })
      }
      entry.groups = groupMap
      entry.loading = false
      entry.error = null
      entry.filterApplied = filterApplied
      entry.phase = 'open'
      return this.api.update({
        tabId: entry.tabId,
        requestId: entry.requestId,
        groups: options,
        loading: false,
        error: '',
        emptyText: filterApplied ? 'No matching devices' : 'No devices available'
      })
    }

    async cancel(tabId, requestId) {
      const entry = this.requests.get(this.keyFor(tabId, requestId))
      if (!entry) return false
      entry.generation++
      entry.phase = 'cancelling'
      return this.api.cancel({ tabId, requestId })
    }

    async destroy() {
      await Promise.allSettled(
        [...this.requests.values()].map((entry) => this.cancel(entry.tabId, entry.requestId))
      )
    }
  }

  globalThis.WebHidNativePickerHelper = WebHidNativePickerHelper
})()
