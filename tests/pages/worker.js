async function tryCatch(fn) {
  try {
    await fn()
    return { ok: true }
  } catch (e) {
    return { ok: false, name: e.name, message: e.message }
  }
}

;(async function () {
  var workerNavigatorHidGetterError
  try {
    var getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'hid').get
    getter.call({})
    workerNavigatorHidGetterError = 'accepted'
  } catch (e) {
    workerNavigatorHidGetterError = e.name
  }
  var result = {
    hasNavigatorHid: typeof navigator !== 'undefined' && 'hid' in navigator,
    hasHID: typeof self.HID === 'function',
    hasHIDDevice: typeof self.HIDDevice === 'function',
    hasHIDInputReportEvent: typeof self.HIDInputReportEvent === 'function',
    hasHIDConnectionEvent: typeof self.HIDConnectionEvent === 'function',
    getDevicesResult: await tryCatch(() => navigator.hid.getDevices()),
    hasRequestDevice: 'requestDevice' in navigator.hid,
    workerNavigatorHidGetterError: workerNavigatorHidGetterError
  }

  try {
    new self.HID()
    result.illegalConstructor = { ok: true }
  } catch (e) {
    result.illegalConstructor = { ok: false, name: e.name, message: e.message }
  }

  self.postMessage(result)
})()
