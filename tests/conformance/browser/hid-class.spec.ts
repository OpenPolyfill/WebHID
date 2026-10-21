import { test, expect } from '../../helpers/browser.js'
import { navigateToPolicyCheck } from '../../helpers/browser-utils.js'

test.describe('HID WebIDL', () => {
  test.beforeEach(async ({ sharedPage, pageUrl }) => {
    await navigateToPolicyCheck(sharedPage, pageUrl)
  })

  test('navigator.hid is a SameObject HID EventTarget in a secure context', async ({
    sharedPage
  }) => {
    const result = await sharedPage.evaluate(() => {
      let constructorError: string | null = null
      try {
        new HID()
      } catch (error) {
        constructorError = error instanceof Error ? error.name : String(error)
      }
      return {
        exists: typeof navigator.hid !== 'undefined',
        sameObject: navigator.hid === navigator.hid,
        isHID: navigator.hid instanceof HID,
        isEventTarget: navigator.hid instanceof EventTarget,
        tag: Object.prototype.toString.call(navigator.hid),
        constructorError
      }
    })

    expect(result).toEqual({
      exists: true,
      sameObject: true,
      isHID: true,
      isEventTarget: true,
      tag: '[object HID]',
      constructorError: 'TypeError'
    })
  })

  test('connect event handler attributes and EventTarget listeners dispatch', async ({
    sharedPage
  }) => {
    const result = await sharedPage.evaluate(() => {
      const calls: string[] = []
      const handler = () => calls.push('handler')
      const listener = () => calls.push('listener')
      navigator.hid.onconnect = handler
      navigator.hid.ondisconnect = handler
      navigator.hid.addEventListener('connect', listener)
      navigator.hid.dispatchEvent(new Event('connect'))
      navigator.hid.removeEventListener('connect', listener)
      navigator.hid.dispatchEvent(new Event('connect'))
      return {
        attributes: navigator.hid.onconnect === handler && navigator.hid.ondisconnect === handler,
        calls
      }
    })

    expect(result).toEqual({
      attributes: true,
      calls: ['handler', 'listener', 'handler']
    })
  })
})
test('Navigator.hid getter and HID methods enforce WebIDL brands', async ({ sharedPage }) => {
  const results = await sharedPage.evaluate(() => {
    const invoke = (callback: () => unknown) => {
      try {
        const result = callback()
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          void Promise.resolve(result).catch(() => {})
        }
        return 'accepted'
      } catch (error) {
        return error instanceof Error ? error.name : String(error)
      }
    }
    const getter = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hid')?.get
    return [
      invoke(() => getter?.call({})),
      invoke(() => Reflect.apply(HID.prototype.getDevices, {}, [])),
      invoke(() => Reflect.apply(HID.prototype.requestDevice, {}, [{ filters: [] }]))
    ]
  })

  expect(results).toEqual(['TypeError', 'TypeError', 'TypeError'])
})
