import { test, expect } from '../../helpers/browser.js'
import { navigateToPolicyCheck } from '../../helpers/browser-utils.js'

test('HIDDevice WebIDL methods and attributes', async ({ sharedPage, pageUrl }) => {
  await navigateToPolicyCheck(sharedPage, pageUrl)
  const result = await sharedPage.evaluate(() => {
    let constructorError: string | null = null
    try {
      new HIDDevice()
    } catch (error) {
      constructorError = error instanceof Error ? error.name : String(error)
    }
    const prototype = HIDDevice.prototype
    const opened = Object.getOwnPropertyDescriptor(prototype, 'opened')
    const inputReport = Object.getOwnPropertyDescriptor(prototype, 'oninputreport')
    return {
      constructorError,
      methods: {
        open: typeof prototype.open,
        close: typeof prototype.close,
        forget: typeof prototype.forget,
        sendReport: typeof prototype.sendReport,
        sendFeatureReport: typeof prototype.sendFeatureReport,
        receiveFeatureReport: typeof prototype.receiveFeatureReport
      },
      opened: {
        getter: typeof opened?.get,
        enumerable: opened?.enumerable
      },
      oninputreport: {
        getter: typeof inputReport?.get,
        setter: typeof inputReport?.set
      }
    }
  })

  expect(result).toEqual({
    constructorError: 'TypeError',
    methods: {
      open: 'function',
      close: 'function',
      forget: 'function',
      sendReport: 'function',
      sendFeatureReport: 'function',
      receiveFeatureReport: 'function'
    },
    opened: { getter: 'function', enumerable: false },
    oninputreport: { getter: 'function', setter: 'function' }
  })
})
