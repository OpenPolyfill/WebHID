import { test, expect } from '../../helpers/browser.js'
import { navigateToPolicyCheck } from '../../helpers/browser-utils.js'

test('HIDDevice WebIDL members use the specified property descriptors', async ({
  sharedPage,
  pageUrl
}) => {
  await navigateToPolicyCheck(sharedPage, pageUrl)
  const result = await sharedPage.evaluate(() => {
    let constructorError: string | null = null
    try {
      new HIDDevice()
    } catch (error) {
      constructorError = error instanceof Error ? error.name : String(error)
    }
    const methods = [
      'open',
      'close',
      'forget',
      'sendReport',
      'sendFeatureReport',
      'receiveFeatureReport',
      'addEventListener',
      'removeEventListener',
      'dispatchEvent'
    ].map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(HIDDevice.prototype, name)
      return [
        name,
        typeof descriptor?.value,
        descriptor?.writable,
        descriptor?.enumerable,
        descriptor?.configurable
      ]
    })
    const attributes = [
      'opened',
      'vendorId',
      'productId',
      'productName',
      'collections',
      'oninputreport'
    ].map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(HIDDevice.prototype, name)
      return [
        name,
        typeof descriptor?.get,
        typeof descriptor?.set,
        descriptor?.enumerable,
        descriptor?.configurable
      ]
    })
    const eventAttributes = [
      Object.getOwnPropertyDescriptor(HIDInputReportEvent.prototype, 'device'),
      Object.getOwnPropertyDescriptor(HIDInputReportEvent.prototype, 'reportId'),
      Object.getOwnPropertyDescriptor(HIDInputReportEvent.prototype, 'data'),
      Object.getOwnPropertyDescriptor(HIDConnectionEvent.prototype, 'device')
    ].map((descriptor) => [
      typeof descriptor?.get,
      typeof descriptor?.set,
      descriptor?.enumerable,
      descriptor?.configurable
    ])
    const constructors = [
      {
        matches:
          Object.getOwnPropertyDescriptor(HIDDevice.prototype, 'constructor')?.value === HIDDevice,
        descriptor: Object.getOwnPropertyDescriptor(HIDDevice.prototype, 'constructor')
      },
      {
        matches:
          Object.getOwnPropertyDescriptor(HIDInputReportEvent.prototype, 'constructor')?.value ===
          HIDInputReportEvent,
        descriptor: Object.getOwnPropertyDescriptor(HIDInputReportEvent.prototype, 'constructor')
      },
      {
        matches:
          Object.getOwnPropertyDescriptor(HIDConnectionEvent.prototype, 'constructor')?.value ===
          HIDConnectionEvent,
        descriptor: Object.getOwnPropertyDescriptor(HIDConnectionEvent.prototype, 'constructor')
      }
    ].map(({ matches, descriptor }) => ({
      matches,
      writable: descriptor?.writable,
      enumerable: descriptor?.enumerable,
      configurable: descriptor?.configurable
    }))
    return { constructorError, methods, attributes, eventAttributes, constructors }
  })

  expect(result).toEqual({
    constructorError: 'TypeError',
    methods: [
      ['open', 'function', true, true, true],
      ['close', 'function', true, true, true],
      ['forget', 'function', true, true, true],
      ['sendReport', 'function', true, true, true],
      ['sendFeatureReport', 'function', true, true, true],
      ['receiveFeatureReport', 'function', true, true, true],
      ['addEventListener', 'function', true, true, true],
      ['removeEventListener', 'function', true, true, true],
      ['dispatchEvent', 'function', true, true, true]
    ],
    attributes: [
      ['opened', 'function', 'undefined', true, true],
      ['vendorId', 'function', 'undefined', true, true],
      ['productId', 'function', 'undefined', true, true],
      ['productName', 'function', 'undefined', true, true],
      ['collections', 'function', 'undefined', true, true],
      ['oninputreport', 'function', 'function', true, true]
    ],
    eventAttributes: [
      ['function', 'undefined', true, true],
      ['function', 'undefined', true, true],
      ['function', 'undefined', true, true],
      ['function', 'undefined', true, true]
    ],
    constructors: Array(3).fill({
      matches: true,
      writable: true,
      enumerable: false,
      configurable: true
    })
  })
})
test('HIDDevice Promise methods reject WebIDL brand errors', async ({ sharedPage }) => {
  const results = await sharedPage.evaluate(async () => {
    const receiver = {}
    const methods = [
      () => Reflect.apply(HIDDevice.prototype.open, receiver, []),
      () => Reflect.apply(HIDDevice.prototype.close, receiver, []),
      () => Reflect.apply(HIDDevice.prototype.forget, receiver, []),
      () => Reflect.apply(HIDDevice.prototype.sendReport, receiver, [1, new Uint8Array(0)]),
      () => Reflect.apply(HIDDevice.prototype.sendFeatureReport, receiver, [1, new Uint8Array(0)]),
      () => Reflect.apply(HIDDevice.prototype.receiveFeatureReport, receiver, [1])
    ]
    return Promise.all(
      methods.map(async (invoke) => {
        let promise: unknown
        try {
          promise = invoke()
        } catch (error) {
          return {
            returnedPromise: false,
            error: error instanceof Error ? error.name : String(error)
          }
        }
        if (!(promise instanceof Promise)) return { returnedPromise: false, error: 'not a Promise' }
        try {
          await promise
          return { returnedPromise: true, error: null }
        } catch (error) {
          return {
            returnedPromise: true,
            error: error instanceof Error ? error.name : String(error)
          }
        }
      })
    )
  })

  expect(results).toEqual(Array(6).fill({ returnedPromise: true, error: 'TypeError' }))
})
