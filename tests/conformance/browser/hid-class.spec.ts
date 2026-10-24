import { test, expect } from '../../helpers/browser.js'

test.describe('HID WebIDL', () => {
  test('navigator.hid is a SameObject HID EventTarget in a secure context', async ({ page }) => {
    const result = await page.evaluate(() => {
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
  test('HID interface methods inherit EventTarget methods and expose Web IDL descriptors', async ({
    page
  }) => {
    const result = await page.evaluate(() => {
      const methods = ['getDevices', 'requestDevice'].map((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(HID.prototype, name)
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
          Object.prototype.hasOwnProperty.call(HID.prototype, name),
          Reflect.get(HID.prototype, name) === Reflect.get(EventTarget.prototype, name),
          Object.getOwnPropertyDescriptor(EventTarget.prototype, name)?.enumerable
        ]
      )
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
      const interfacePrototype = Object.getOwnPropertyDescriptor(HID, 'prototype')
      const navigatorHid = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hid')
      return {
        methods,
        eventTargetMethods,
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
        },
        interfacePrototype: {
          matches: interfacePrototype?.value === HID.prototype,
          writable: interfacePrototype?.writable,
          enumerable: interfacePrototype?.enumerable,
          configurable: interfacePrototype?.configurable
        }
      }
    })

    expect(result).toEqual({
      methods: [
        ['getDevices', 'function', true, true, true],
        ['requestDevice', 'function', true, true, true]
      ],
      eventTargetMethods: [
        ['addEventListener', false, true, true],
        ['removeEventListener', false, true, true],
        ['dispatchEvent', false, true, true]
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
      },
      interfacePrototype: {
        matches: true,
        writable: false,
        enumerable: false,
        configurable: false
      }
    })
  })

  test('EventHandler replacement preserves registration order and callback behavior', async ({
    page
  }) => {
    const result = await page.evaluate(() => {
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
  page
}) => {
  const result = await page.evaluate(async () => {
    const getter = Reflect.get(
      Object.getOwnPropertyDescriptor(Navigator.prototype, 'hid') ?? {},
      'get'
    ) as ((this: unknown) => unknown) | undefined
    let getterError: string | null = null
    try {
      getter?.call({})
    } catch (error) {
      getterError = error instanceof Error ? error.name : String(error)
    }
    const getDevices = Reflect.get(HID.prototype, 'getDevices') as (...args: unknown[]) => unknown
    const requestDeviceMethod = Reflect.get(HID.prototype, 'requestDevice') as (
      ...args: unknown[]
    ) => unknown
    const requestDevice = navigator.hid.requestDevice.bind(navigator.hid) as unknown as (
      options?: unknown
    ) => Promise<unknown>
    const calls = [
      () => Reflect.apply(getDevices, {}, []),
      () => Reflect.apply(requestDeviceMethod, {}, [{ filters: [] }]),
      () => requestDevice({ filters: null })
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
      await requestDevice({
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
