import { test, expect } from '../../helpers/browser.js'
import { navigateToPolicyCheck } from '../../helpers/browser-utils.js'

test('WebHID remains usable after page code replaces realm intrinsics', async ({
  sharedPage,
  pageUrl
}) => {
  await navigateToPolicyCheck(sharedPage, pageUrl)

  const result = await sharedPage.evaluate(async () => {
    const pushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'push')!
    const includesDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'includes')!
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!
    Array.prototype.push = () => {
      throw new Error('poisoned Array.push')
    }
    String.prototype.includes = () => {
      throw new Error('poisoned String.includes')
    }
    Array.prototype[Symbol.iterator] = () => {
      throw new Error('poisoned Array iterator')
    }

    try {
      const hid = navigator.hid
      let eventReceived = false
      const listener = () => {
        eventReceived = true
      }
      hid.addEventListener('connect', listener)
      hid.dispatchEvent(new Event('connect'))
      hid.removeEventListener('connect', listener)
      const devices = await hid.getDevices()
      return {
        sameObject: hid === navigator.hid,
        eventReceived,
        deviceCount: devices.length
      }
    } finally {
      Object.defineProperty(Array.prototype, 'push', pushDescriptor)
      Object.defineProperty(String.prototype, 'includes', includesDescriptor)
      Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor)
    }
  })

  expect(result.sameObject).toBe(true)
  expect(result.eventReceived).toBe(true)
  expect(typeof result.deviceCount).toBe('number')
})
