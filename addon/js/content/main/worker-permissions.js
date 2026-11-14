/**
 * Dedicated Worker Permissions adapter. The owning document's Permission Registry
 * remains the only policy/state authority; the worker borrows its control Port.
 */
;(function () {
  const webhid = globalThis.webhid

  function installWorkerPermissions(requestState) {
    const workerNavigator = globalThis.navigator
    if (!workerNavigator || typeof requestState !== 'function') return () => {}

    const nativePermissions = workerNavigator.permissions
    const nativeQuery = typeof nativePermissions?.query === 'function'
      ? nativePermissions.query
      : null
    const internal = new WeakMap()
    const statusEntries = new WeakMap()
    const statuses = new Set()
    const finalizer = typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry((ref) => statuses.delete(ref))
      : null
    const token = Symbol('webhid-worker-permissions')
    let generation = 0

    // Firefox has no WorkerNavigator.permissions binding on some targets.
    // Supply the missing WebIDL facade only within the injected worker.
    class PermissionStatusFallback extends EventTarget {
      constructor(key, state) {
        if (key !== token) throw new TypeError('Illegal constructor')
        super()
        internal.set(this, { state, onchange: null })
      }
      get name() {
        if (!internal.has(this)) throw new TypeError('Illegal invocation')
        return 'hid'
      }
      get state() {
        const entry = internal.get(this)
        if (!entry) throw new TypeError('Illegal invocation')
        return entry.state
      }
      get onchange() {
        const entry = internal.get(this)
        if (!entry) throw new TypeError('Illegal invocation')
        return entry.onchange
      }
      set onchange(callback) {
        const entry = internal.get(this)
        if (!entry) throw new TypeError('Illegal invocation')
        if (entry.onchange) this.removeEventListener('change', entry.onchange)
        entry.onchange = typeof callback === 'function' ? callback : null
        if (entry.onchange) this.addEventListener('change', entry.onchange)
      }
    }
    for (const name of ['name', 'state', 'onchange']) {
      const descriptor = Object.getOwnPropertyDescriptor(PermissionStatusFallback.prototype, name)
      Object.defineProperty(PermissionStatusFallback.prototype, name, {
        ...descriptor, enumerable: true
      })
    }
    Object.defineProperty(PermissionStatusFallback.prototype, Symbol.toStringTag, {
      value: 'PermissionStatus', configurable: true
    })

    function track(status, state) {
      const entry = { state, dispatching: false }
      if (nativeQuery) {
        statusEntries.set(status, entry)
        // Keep the native PermissionStatus reflector and EventTarget methods.
        // Only shadow this one donor, leaving Firefox's other statuses intact.
        Object.defineProperties(status, {
          name: { configurable: true, enumerable: true, get: () => 'hid' },
          state: { configurable: true, enumerable: true, get: () => entry.state }
        })
        status.addEventListener('change', (event) => {
          if (!entry.dispatching) event.stopImmediatePropagation()
        }, { capture: true })
      } else {
        const original = internal.get(status)
        internal.set(status, { ...original, state })
      }
      const ref = new WeakRef(status)
      statuses.add(ref)
      finalizer?.register(status, ref)
      return status
    }

    const changeQueue = []
    let changeChannel = null
    function scheduleChange(status, entry) {
      if (!changeChannel) {
        changeChannel = new MessageChannel()
        changeChannel.port1.onmessage = () => changeQueue.shift()?.()
      }
      changeQueue.push(() => {
        entry.dispatching = true
        try { status.dispatchEvent(new Event('change')) }
        finally { entry.dispatching = false }
      })
      changeChannel.port2.postMessage(null)
    }

    async function getState() {
      // A revocation racing an earlier reply must never restore stale state.
      if (globalThis.isSecureContext === false) return 'denied'
      while (true) {
        const current = generation
        const state = await requestState()
        if (current !== generation) continue
        return ['granted', 'prompt', 'denied'].includes(state) ? state : 'denied'
      }
    }

    async function queryHid() {
      const [state, status] = await Promise.all([
        getState(),
        nativeQuery
          ? nativeQuery.call(nativePermissions, { name: 'persistent-storage' })
          : Promise.resolve(new PermissionStatusFallback(token, 'denied'))
      ])
      return track(status, state)
    }

    if (nativeQuery) {
      // Preserve the original method for every non-HID permission.
      Object.defineProperty(nativePermissions, 'query', {
        configurable: true, writable: true,
        value: function query(descriptor) {
          return Promise.resolve().then(() => {
            if (descriptor?.name === 'hid') return queryHid()
            return nativeQuery.apply(this, arguments)
          })
        }
      })
    } else {
      class Permissions {
        constructor(key) {
          if (key !== token) throw new TypeError('Illegal constructor')
        }
        query(descriptor) {
          return Promise.resolve().then(() => {
            if (descriptor === null ||
                (typeof descriptor !== 'object' && typeof descriptor !== 'function')) {
              throw new TypeError('PermissionDescriptor must be an object')
            }
            if (descriptor.name !== 'hid') throw new TypeError('Unknown permission name')
            return queryHid()
          })
        }
      }
      const queryDescriptor = Object.getOwnPropertyDescriptor(Permissions.prototype, 'query')
      Object.defineProperty(Permissions.prototype, 'query', {
        ...queryDescriptor, enumerable: true
      })
      Object.defineProperty(Permissions.prototype, Symbol.toStringTag, {
        value: 'Permissions', configurable: true
      })
      Object.defineProperty(Object.getPrototypeOf(workerNavigator), 'permissions', {
        configurable: true, enumerable: true,
        get() {
          if (this !== workerNavigator) throw new TypeError('Illegal invocation')
          return permissions
        }
      })
      const permissions = new Permissions(token)
      if (typeof globalThis.Permissions === 'undefined') globalThis.Permissions = Permissions
      if (typeof globalThis.PermissionStatus === 'undefined') {
        globalThis.PermissionStatus = PermissionStatusFallback
      }
    }

    function refresh() {
      generation++
      getState().then((state) => {
        for (const ref of statuses) {
          const status = ref.deref()
          if (!status) { statuses.delete(ref); continue }
          const entry = nativeQuery ? statusEntries.get(status) : internal.get(status)
          if (!entry || entry.state === state) continue
          entry.state = state
          scheduleChange(status, entry)
        }
      }).catch(() => {})
    }

    return refresh
  }

  webhid.export('installWorkerPermissions', installWorkerPermissions)
})()
