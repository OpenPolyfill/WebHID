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
  test('HID interface members use Web IDL property descriptors', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate(() => {
      const methods = [
        'getDevices',
        'requestDevice',
        'addEventListener',
        'removeEventListener',
        'dispatchEvent'
      ].map((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(HID.prototype, name)
        return [
          name,
          typeof descriptor?.value,
          descriptor?.writable,
          descriptor?.enumerable,
          descriptor?.configurable
        ]
      })
      const attributes = ['onconnect', 'ondisconnect'].map((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(HID.prototype, name)
        return [
          name,
          typeof descriptor?.get,
          typeof descriptor?.set,
          descriptor?.enumerable,
          descriptor?.configurable
        ]
      })
      const constructor = Object.getOwnPropertyDescriptor(HID.prototype, 'constructor')
      const navigatorHid = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hid')
      return {
        methods,
        attributes,
        navigatorHid: {
          enumerable: navigatorHid?.enumerable,
          configurable: navigatorHid?.configurable
        },
        constructor: {
          matches: constructor?.value === HID,
          writable: constructor?.writable,
          enumerable: constructor?.enumerable,
          configurable: constructor?.configurable
        }
      }
    })

    expect(result).toEqual({
      methods: [
        ['getDevices', 'function', true, true, true],
        ['requestDevice', 'function', true, true, true],
        ['addEventListener', 'function', true, true, true],
        ['removeEventListener', 'function', true, true, true],
        ['dispatchEvent', 'function', true, true, true]
      ],
      attributes: [
        ['onconnect', 'function', 'function', true, true],
        ['ondisconnect', 'function', 'function', true, true]
      ],
      navigatorHid: { enumerable: true, configurable: true },
      constructor: {
        matches: true,
        writable: true,
        enumerable: false,
        configurable: true
      }
    })
  })

  test('EventHandler replacement preserves registration order and callback behavior', async ({
    sharedPage
  }) => {
    const result = await sharedPage.evaluate(() => {
      const target = navigator.hid
      const calls: string[] = []
      let callbackThisMatches = false
      const before = () => calls.push('before')
      const original = () => calls.push('original')
      const after = () => calls.push('after')
      target.addEventListener('connect', before)
      target.onconnect = original
      target.addEventListener('connect', after)
      target.onconnect = function (this: HID, event: Event) {
        callbackThisMatches = this === target && event.currentTarget === target
        calls.push('replacement')
        return false
      }
      const cancelableEvent = new Event('connect', { cancelable: true })
      const dispatchResult = target.dispatchEvent(cancelableEvent)
      const firstDispatch = calls.slice()
      target.onconnect = null
      target.dispatchEvent(new Event('connect'))
      const afterRemoval = calls.slice(firstDispatch.length)
      target.addEventListener('connect', () => calls.push('inactive'))
      target.onconnect = () => calls.push('reactivated')
      target.dispatchEvent(new Event('connect'))
      const afterReactivation = calls.slice(firstDispatch.length + 2)
      const objectHandler = {}
      Reflect.set(target, 'onconnect', objectHandler)
      const objectValuePreserved = target.onconnect === objectHandler
      const beforeObjectDispatch = calls.length
      target.dispatchEvent(new Event('connect'))
      const objectDispatch = calls.slice(beforeObjectDispatch)
      Reflect.set(target, 'onconnect', 1)
      const primitiveConvertedToNull = target.onconnect === null
      let disconnectThisMatches = false
      target.ondisconnect = function (this: HID) {
        disconnectThisMatches = this === target
        return false
      }
      const disconnectEvent = new Event('disconnect', { cancelable: true })
      const disconnectDispatchResult = target.dispatchEvent(disconnectEvent)
      return {
        firstDispatch,
        dispatchResult,
        defaultPrevented: cancelableEvent.defaultPrevented,
        callbackThisMatches,
        afterRemoval,
        afterReactivation,
        objectValuePreserved,
        objectDispatch,
        primitiveConvertedToNull,
        disconnectDispatchResult,
        disconnectDefaultPrevented: disconnectEvent.defaultPrevented,
        disconnectThisMatches
      }
    })

    expect(result).toEqual({
      firstDispatch: ['before', 'replacement', 'after'],
      dispatchResult: false,
      defaultPrevented: true,
      callbackThisMatches: true,
      afterRemoval: ['before', 'after'],
      afterReactivation: ['before', 'after', 'inactive', 'reactivated'],
      objectValuePreserved: true,
      objectDispatch: ['before', 'after', 'inactive'],
      primitiveConvertedToNull: true,
      disconnectDispatchResult: false,
      disconnectDefaultPrevented: true,
      disconnectThisMatches: true
    })
  })
})
test('Navigator.hid getter stays synchronous and Promise APIs reject WebIDL exceptions', async ({
  sharedPage
}) => {
  const result = await sharedPage.evaluate(async () => {
    const getter = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hid')?.get
    let getterError: string | null = null
    try {
      getter?.call({})
    } catch (error) {
      getterError = error instanceof Error ? error.name : String(error)
    }
    const calls = [
      () => Reflect.apply(HID.prototype.getDevices, {}, []),
      () => Reflect.apply(HID.prototype.requestDevice, {}, [{ filters: [] }]),
      () => navigator.hid.requestDevice({ filters: null })
    ]
    const promiseResults = await Promise.all(
      calls.map(async (invoke) => {
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
    const sentinel = new Error('requestDevice dictionary getter sentinel')
    let sentinelPreserved = false
    try {
      await navigator.hid.requestDevice({
        get filters() {
          throw sentinel
        }
      })
    } catch (error) {
      sentinelPreserved = error === sentinel
    }
    return { getterError, promiseResults, sentinelPreserved }
  })

  expect(result).toEqual({
    getterError: 'TypeError',
    promiseResults: [
      { returnedPromise: true, error: 'TypeError' },
      { returnedPromise: true, error: 'TypeError' },
      { returnedPromise: true, error: 'TypeError' }
    ],
    sentinelPreserved: true
  })
})
