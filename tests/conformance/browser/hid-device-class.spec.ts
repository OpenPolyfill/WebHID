import { test, expect } from '../../helpers/browser.js'
import { navigateToPolicyCheck } from '../../helpers/browser-utils.js'

test('HIDDevice inherits EventTarget methods and exposes Web IDL descriptors', async ({
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
      'receiveFeatureReport'
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
    const eventTargetMethods = ['addEventListener', 'removeEventListener', 'dispatchEvent'].map(
      (name) => [
        name,
        Object.prototype.hasOwnProperty.call(HIDDevice.prototype, name),
        Reflect.get(HIDDevice.prototype, name) === Reflect.get(EventTarget.prototype, name),
        Object.getOwnPropertyDescriptor(EventTarget.prototype, name)?.enumerable
      ]
    )
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
    const interfaceDescriptors = (constructor: { prototype: object }) => {
      const constructorDescriptor = Object.getOwnPropertyDescriptor(
        constructor.prototype,
        'constructor'
      )
      const prototypeDescriptor = Object.getOwnPropertyDescriptor(constructor, 'prototype')
      return {
        constructor: {
          matches: constructorDescriptor?.value === constructor,
          writable: constructorDescriptor?.writable,
          enumerable: constructorDescriptor?.enumerable,
          configurable: constructorDescriptor?.configurable
        },
        interfacePrototype: {
          matches: prototypeDescriptor?.value === constructor.prototype,
          writable: prototypeDescriptor?.writable,
          enumerable: prototypeDescriptor?.enumerable,
          configurable: prototypeDescriptor?.configurable
        }
      }
    }
    const constructors = [HIDDevice, HIDInputReportEvent, HIDConnectionEvent].map(
      interfaceDescriptors
    )
    return {
      constructorError,
      methods,
      eventTargetMethods,
      attributes,
      eventAttributes,
      constructors
    }
  })

  expect(result).toEqual({
    constructorError: 'TypeError',
    methods: [
      ['open', 'function', true, true, true],
      ['close', 'function', true, true, true],
      ['forget', 'function', true, true, true],
      ['sendReport', 'function', true, true, true],
      ['sendFeatureReport', 'function', true, true, true],
      ['receiveFeatureReport', 'function', true, true, true]
    ],
    eventTargetMethods: [
      ['addEventListener', false, true, true],
      ['removeEventListener', false, true, true],
      ['dispatchEvent', false, true, true]
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
      constructor: {
        matches: true,
        writable: true,
        enumerable: false,
        configurable: true
      },
      interfacePrototype: {
        matches: true,
        writable: false,
        enumerable: false,
        configurable: false
      }
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
