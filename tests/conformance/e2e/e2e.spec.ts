import { workerBase as base, expect, withSharedPage } from '../../helpers/e2e.js'
import { DEVICES, grantDevicePermission } from '../../helpers/e2e-devices.js'
import type { DeviceFilter } from '../../helpers/e2e-types.js'
import {
  armInputReport,
  VENDOR,
  VENDOR_CTX,
  VENDOR_INPUT_SIZE,
  VENDOR_OUTPUT_ID
} from '../../helpers/e2e-reports.js'
import { sendInput, waitForOutputReport, startWebhidMock } from '../../helpers/e2e-process.js'
const test = withSharedPage(base)
test.describe.configure({ mode: 'serial' })

test.describe('WebHID conformance', () => {
  test('requestDevice grants the matching device and exposes its descriptor', async ({
    page,
    vendorDevice
  }) => {
    const beforeGrant = await page.evaluate(
      async (filter: DeviceFilter) =>
        (await navigator.hid.getDevices()).filter(
          (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
        ).length,
      VENDOR
    )
    expect(beforeGrant).toBe(0)
    const overflowFilter = {
      ...VENDOR,
      vendorId: VENDOR.vendorId + 0x1_0000_0000,
      productId: VENDOR.productId + 0x1_0000
    }
    expect(await grantDevicePermission(page, [overflowFilter])).toBe(1)
    const device = await page.evaluate(async (filter: DeviceFilter) => {
      const found = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!found) throw new Error('granted device missing from getDevices()')
      const collection = found.collections.find((entry) => entry.inputReports.length > 0)
      if (!collection) throw new Error('device has no input report collection')
      const report = collection.inputReports[0]
      const item = report?.items[0]
      if (!report || !item) throw new Error('input report has no report item')
      const originalUsage = collection.usage
      collection.usage = originalUsage + 1
      const collectionMutable = collection.usage === originalUsage + 1
      collection.usage = originalUsage
      const usages = item.usages as unknown as number[]
      const originalUsageCount = usages.length
      usages.push(0)
      const nestedSequenceMutable = usages.length === originalUsageCount + 1
      usages.pop()
      const collectionDescriptor = Object.getOwnPropertyDescriptor(collection, 'usage')
      const reportDescriptor = Object.getOwnPropertyDescriptor(report, 'reportId')
      const itemDescriptor = Object.getOwnPropertyDescriptor(item, 'reportSize')
      return {
        vendorId: found.vendorId,
        productId: found.productId,
        collectionCount: found.collections.length,
        collectionsFrozen: Object.isFrozen(found.collections),
        collectionsSameObject: found.collections === found.collections,
        nestedDictionariesFrozen: [
          Object.isFrozen(collection),
          Object.isFrozen(report),
          Object.isFrozen(item)
        ],
        nestedSequencesFrozen: [
          Object.isFrozen(collection.children),
          Object.isFrozen(collection.inputReports),
          Object.isFrozen(collection.outputReports),
          Object.isFrozen(collection.featureReports),
          Object.isFrozen(report.items),
          Object.isFrozen(item.usages),
          Object.isFrozen(item.strings)
        ],
        collectionMutable,
        nestedSequenceMutable,
        dictionaryDescriptors: [collectionDescriptor, reportDescriptor, itemDescriptor].map(
          (descriptor) => [descriptor?.writable, descriptor?.enumerable, descriptor?.configurable]
        ),
        inputReportIds: found.collections.flatMap((entry) =>
          entry.inputReports.map((inputReport) => inputReport.reportId)
        ),
        outputReportIds: found.collections.flatMap((entry) =>
          entry.outputReports.map((outputReport) => outputReport.reportId)
        ),
        has64ByteInput: found.collections.some((entry) =>
          entry.inputReports.some((inputReport) =>
            inputReport.items.some(
              (reportItem) => reportItem.reportSize === 8 && reportItem.reportCount === 64
            )
          )
        )
      }
    }, VENDOR)

    expect(device.vendorId).toBe(vendorDevice.vid)
    expect(device.productId).toBe(vendorDevice.pid)
    expect(device.collectionCount).toBe(2)
    expect(device.collectionsFrozen).toBe(true)
    expect(device.collectionsSameObject).toBe(true)
    expect(device.nestedDictionariesFrozen).toEqual([false, false, false])
    expect(device.nestedSequencesFrozen).toEqual(Array(7).fill(false))
    expect(device.collectionMutable).toBe(true)
    expect(device.nestedSequenceMutable).toBe(true)
    expect(device.dictionaryDescriptors).toEqual(Array(3).fill([true, true, true]))
    expect(device.inputReportIds).toContain(VENDOR_OUTPUT_ID)
    expect(device.outputReportIds).toContain(VENDOR_OUTPUT_ID)
    expect(device.has64ByteInput).toBe(true)
  })

  test('HIDConnectionEvent requires and preserves its device', async ({ page }) => {
    const result = await page.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      const events = ['connect', 'disconnect'].map((type) => {
        const event = new HIDConnectionEvent(type, {
          device,
          bubbles: true,
          cancelable: true,
          composed: true
        })
        return {
          type: event.type,
          sameDevice: event.device === device,
          isEvent: event instanceof Event,
          bubbles: event.bubbles,
          cancelable: event.cancelable,
          composed: event.composed
        }
      })
      let missingDevice: string | null = null
      try {
        Reflect.construct(HIDConnectionEvent, ['connect', {}])
      } catch (error) {
        missingDevice = error instanceof Error ? error.name : String(error)
      }
      const fakeDevice = Object.setPrototypeOf({}, HIDDevice.prototype) as unknown as HIDDevice
      let invalidDevice: string | null = null
      try {
        new HIDConnectionEvent('connect', { device: fakeDevice })
      } catch (error) {
        invalidDevice = error instanceof Error ? error.name : String(error)
      }
      const constructorCallErrors = [
        () => {
          Reflect.apply(HIDConnectionEvent, undefined, ['connect', { device }])
        },
        () => {
          Reflect.apply(HIDInputReportEvent, undefined, [
            'inputreport',
            { device, reportId: 1, data: new DataView(new ArrayBuffer(1)) }
          ])
        }
      ].map((call) => {
        try {
          call()
          return 'accepted'
        } catch (error) {
          return error instanceof Error ? error.name : String(error)
        }
      })
      return { events, missingDevice, invalidDevice, constructorCallErrors }
    }, VENDOR)

    expect(result.events).toEqual([
      {
        type: 'connect',
        sameDevice: true,
        isEvent: true,
        bubbles: true,
        cancelable: true,
        composed: true
      },
      {
        type: 'disconnect',
        sameDevice: true,
        isEvent: true,
        bubbles: true,
        cancelable: true,
        composed: true
      }
    ])
    expect(result.missingDevice).toBe('TypeError')
    expect(result.invalidDevice).toBe('TypeError')
    expect(result.constructorCallErrors).toEqual(['TypeError', 'TypeError'])
  })

  test('HIDInputReportEvent validates members and converts octet values', async ({ page }) => {
    const result = await page.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      const data = new DataView(new ArrayBuffer(4))
      const makeEvent = (reportId: unknown) =>
        new HIDInputReportEvent('inputreport', {
          device,
          reportId: reportId as number,
          data
        })
      const values: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, -1, 256, 257, 1.9, '1']
      const convertedIds = values.map((reportId) => makeEvent(reportId).reportId)
      const missingMembers: unknown[] = [
        { reportId: 0, data },
        { device, data },
        { device, reportId: 0 }
      ]
      const missingErrors = missingMembers.map((init) => {
        try {
          new HIDInputReportEvent('inputreport', init as HIDInputReportEventInit)
          return 'accepted'
        } catch (error) {
          return error instanceof Error ? error.name : String(error)
        }
      })
      const fakeDevice = Object.setPrototypeOf({}, HIDDevice.prototype) as unknown as HIDDevice
      const fakeData = Object.setPrototypeOf({}, DataView.prototype) as unknown as DataView
      const invalidTypes = [
        { device: {}, reportId: 1, data },
        { device: fakeDevice, reportId: 1, data },
        { device, reportId: undefined, data },
        { device, reportId: 1, data: {} },
        { device, reportId: 1, data: fakeData }
      ]
      const typeErrors = invalidTypes.map((init) => {
        try {
          new HIDInputReportEvent('inputreport', init as HIDInputReportEventInit)
          return 'accepted'
        } catch (error) {
          return error instanceof Error ? error.name : String(error)
        }
      })
      const getterErrors = [
        () => {
          Object.getOwnPropertyDescriptor(HIDConnectionEvent.prototype, 'device')!.get!.call({})
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDInputReportEvent.prototype, 'device')!.get!.call({})
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDInputReportEvent.prototype, 'reportId')!.get!.call({})
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDInputReportEvent.prototype, 'data')!.get!.call({})
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDDevice.prototype, 'opened')!.get!.call({})
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDDevice.prototype, 'vendorId')!.get!.call({})
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDDevice.prototype, 'productId')!.get!.call({})
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDDevice.prototype, 'productName')!.get!.call({})
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDDevice.prototype, 'collections')!.get!.call({})
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDDevice.prototype, 'oninputreport')!.get!.call({})
        },
        () => {
          Object.getOwnPropertyDescriptor(HID.prototype, 'onconnect')!.get!.call({})
        },
        () => {
          Object.getOwnPropertyDescriptor(HID.prototype, 'ondisconnect')!.get!.call({})
        }
      ].map((read) => {
        try {
          read()
          return 'accepted'
        } catch (error) {
          return error instanceof Error ? error.name : String(error)
        }
      })
      const setterErrors = [
        () =>
          Object.getOwnPropertyDescriptor(HIDDevice.prototype, 'oninputreport')!.set!.call(
            {},
            null
          ),
        () => Object.getOwnPropertyDescriptor(HID.prototype, 'onconnect')!.set!.call({}, null),
        () => Object.getOwnPropertyDescriptor(HID.prototype, 'ondisconnect')!.set!.call({}, null)
      ].map((write) => {
        try {
          write()
          return 'accepted'
        } catch (error) {
          return error instanceof Error ? error.name : String(error)
        }
      })
      const coercionError = new Error('event conversion sentinel')
      let coercionErrorPreserved = false
      try {
        void makeEvent({
          [Symbol.toPrimitive]() {
            throw coercionError
          }
        }).reportId
      } catch (error) {
        coercionErrorPreserved = error === coercionError
      }
      const event = makeEvent(255)
      const connectionEvent = new HIDConnectionEvent('connect', { device })
      const crossBrandErrors = [
        () => {
          Object.getOwnPropertyDescriptor(HIDConnectionEvent.prototype, 'device')!.get!.call(event)
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDInputReportEvent.prototype, 'device')!.get!.call(
            connectionEvent
          )
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDInputReportEvent.prototype, 'reportId')!.get!.call(
            connectionEvent
          )
        },
        () => {
          Object.getOwnPropertyDescriptor(HIDInputReportEvent.prototype, 'data')!.get!.call(
            connectionEvent
          )
        }
      ].map((read) => {
        try {
          read()
          return 'accepted'
        } catch (error) {
          return error instanceof Error ? error.name : String(error)
        }
      })
      const stateSymbol = Object.getOwnPropertySymbols(event).find(
        (symbol) => String(symbol) === 'Symbol(webhid_ir)'
      )
      return {
        type: event.type,
        isEvent: event instanceof Event,
        isInputReportEvent: event instanceof HIDInputReportEvent,
        sameDevice: event.device === device,
        sameData: event.data === data,
        dataIsDataView: event.data instanceof DataView,
        reportId: event.reportId,
        stateSymbolExposed: stateSymbol !== undefined,
        convertedIds,
        missingErrors,
        typeErrors,
        getterErrors,
        setterErrors,
        crossBrandErrors,
        coercionErrorPreserved
      }
    }, VENDOR)

    expect(result).toMatchObject({
      type: 'inputreport',
      isEvent: true,
      isInputReportEvent: true,
      sameDevice: true,
      sameData: true,
      dataIsDataView: true,
      reportId: 255,
      convertedIds: [0, 0, 255, 0, 1, 1, 1],
      missingErrors: ['TypeError', 'TypeError', 'TypeError']
    })
    expect(result.typeErrors).toEqual(Array(5).fill('TypeError'))
    expect(result.coercionErrorPreserved).toBe(true)
    expect(result.getterErrors).toEqual(Array(12).fill('TypeError'))
    expect(result.crossBrandErrors).toEqual(Array(4).fill('TypeError'))
    expect(result.setterErrors).toEqual(Array(3).fill('TypeError'))
    expect(result.stateSymbolExposed).toBe(false)
  })

  test('HID event dispatch uses EventHandler semantics and EventTarget objects', async ({
    page
  }) => {
    const result = await page.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      const hid = navigator.hid
      const inputEvent = new HIDInputReportEvent('inputreport', {
        device,
        reportId: 1,
        data: new DataView(new ArrayBuffer(1)),
        cancelable: true
      })
      const connectionEvent = new HIDConnectionEvent('connect', { device })
      let deviceTargetMatches = false
      let hidTargetMatches = false
      let inputHandlerThisMatches = false
      const inputHandlerCalls: string[] = []
      const inputListener = function (this: HIDDevice, event: Event) {
        deviceTargetMatches =
          event.target === device && event.currentTarget === device && this === device
      }
      const connectionListener = function (this: HID, event: Event) {
        hidTargetMatches = event.target === hid && event.currentTarget === hid && this === hid
      }
      const inputBefore = () => inputHandlerCalls.push('before')
      const inputOriginal = () => inputHandlerCalls.push('original')
      const inputAfter = () => inputHandlerCalls.push('after')
      device.addEventListener('inputreport', inputListener)
      device.addEventListener('inputreport', inputBefore)
      device.oninputreport = inputOriginal
      device.addEventListener('inputreport', inputAfter)
      device.oninputreport = function (this: HIDDevice, event: Event) {
        inputHandlerThisMatches = this === device && event.currentTarget === device
        inputHandlerCalls.push('handler')
        return false
      }
      hid.addEventListener('connect', connectionListener)
      const inputDispatchResult = device.dispatchEvent(inputEvent)
      hid.dispatchEvent(connectionEvent)
      const inputDefaultPrevented = inputEvent.defaultPrevented
      device.oninputreport = null
      device.removeEventListener('inputreport', inputListener)
      device.removeEventListener('inputreport', inputBefore)
      device.removeEventListener('inputreport', inputAfter)
      hid.removeEventListener('connect', connectionListener)
      return {
        deviceTargetMatches,
        hidTargetMatches,
        inputHandlerCalls,
        inputHandlerThisMatches,
        inputDispatchResult,
        inputDefaultPrevented,
        deviceIsEventTarget: device instanceof EventTarget,
        hidIsEventTarget: hid instanceof EventTarget
      }
    }, VENDOR)

    expect(result).toEqual({
      deviceTargetMatches: true,
      hidTargetMatches: true,
      inputHandlerCalls: ['before', 'handler', 'after'],
      inputHandlerThisMatches: true,
      inputDispatchResult: false,
      inputDefaultPrevented: true,
      deviceIsEventTarget: true,
      hidIsEventTarget: true
    })
  })

  test('input and output report methods require an open device', async ({ page }) => {
    const errors = await page.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      const operations = [
        () => device.sendReport(ctx.outputId, new Uint8Array(ctx.size)),
        () => device.sendFeatureReport(ctx.featureId, new Uint8Array(4)),
        () => device.receiveFeatureReport(ctx.featureId)
      ]
      const errors: string[] = []
      for (const operation of operations) {
        try {
          await operation()
          errors.push('resolved')
        } catch (error) {
          errors.push(error instanceof Error ? error.name : String(error))
        }
      }
      return errors
    }, VENDOR_CTX)

    expect(errors).toEqual(['InvalidStateError', 'InvalidStateError', 'InvalidStateError'])
  })

  test('report methods reject octet conversion errors with Promises', async ({ page }) => {
    const results = await page.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      const operations = [
        () => device.sendReport(256, new Uint8Array(ctx.size)),
        () => device.sendFeatureReport(-1, new Uint8Array(4)),
        () => device.receiveFeatureReport(257)
      ]
      const outcomes = await Promise.all(
        operations.map(async (operation) => {
          let promise: unknown
          try {
            promise = operation()
          } catch (error) {
            return {
              returnedPromise: false,
              error: error instanceof Error ? error.name : String(error)
            }
          }
          if (!(promise instanceof Promise))
            return { returnedPromise: false, error: 'not a Promise' }
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
      const conversionError = new Error('conversion sentinel')
      let conversionReturnedPromise = false
      let conversionErrorPreserved = false
      let conversionPromise: Promise<void> | undefined
      try {
        conversionPromise = device.sendReport(
          {
            [Symbol.toPrimitive]() {
              throw conversionError
            }
          } as unknown as number,
          new Uint8Array(ctx.size)
        )
        conversionReturnedPromise = conversionPromise instanceof Promise
      } catch (error) {
        conversionErrorPreserved = error === conversionError
      }
      if (conversionPromise) {
        try {
          await conversionPromise
        } catch (error) {
          conversionErrorPreserved = error === conversionError
        }
      }
      return { outcomes, conversionReturnedPromise, conversionErrorPreserved }
    }, VENDOR_CTX)

    expect(results.outcomes).toEqual(Array(3).fill({ returnedPromise: true, error: 'TypeError' }))
    expect(results.conversionReturnedPromise).toBe(true)
    expect(results.conversionErrorPreserved).toBe(true)
  })
  test('report methods reject non-BufferSource and shared-backed views with Promises', async ({
    page
  }) => {
    const results = await page.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      const source = {
        buffer: new ArrayBuffer(ctx.size),
        byteOffset: 0,
        byteLength: ctx.size
      } as unknown as BufferSource
      const operations = [
        () => device.sendReport(ctx.outputId, source),
        () => device.sendFeatureReport(ctx.featureId, source)
      ]
      const sharedBufferAvailable = typeof SharedArrayBuffer === 'function'
      if (sharedBufferAvailable) {
        const sharedView = new Uint8Array(new SharedArrayBuffer(ctx.size))
        operations.push(() =>
          device.sendReport(ctx.outputId, sharedView as unknown as BufferSource)
        )
      }
      const outcomes = await Promise.all(
        operations.map(async (operation) => {
          let promise: unknown
          try {
            promise = operation()
          } catch (error) {
            return {
              returnedPromise: false,
              error: error instanceof Error ? error.name : String(error)
            }
          }
          if (!(promise instanceof Promise))
            return { returnedPromise: false, error: 'not a Promise' }
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
      return { outcomes, sharedBufferAvailable }
    }, VENDOR_CTX)

    expect(results.outcomes.slice(0, 2)).toEqual(
      Array(2).fill({ returnedPromise: true, error: 'TypeError' })
    )
    if (results.sharedBufferAvailable) {
      expect(results.outcomes[2]).toEqual({ returnedPromise: true, error: 'TypeError' })
    }
  })

  test('open and close update opened while concurrent requests keep their results', async ({
    page
  }) => {
    const state = await page.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      const openPromise = device.open()
      const devicesPromise = navigator.hid.getDevices()
      const [openResult, devices] = await Promise.all([openPromise, devicesPromise])
      const listed = devices.some(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      const opened = device.opened
      const closeResult = await device.close()
      return { listed, openResult, opened, closeResult, closed: !device.opened }
    }, VENDOR_CTX)

    expect(state).toEqual({
      listed: true,
      openResult: undefined,
      opened: true,
      closeResult: undefined,
      closed: true
    })
  })
  test('closing immediately aborts pending reports and blocks new operations', async ({ page }) => {
    const state = await page.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      await device.open()
      const pending = [
        device.sendReport(ctx.outputId, new Uint8Array(ctx.size)),
        device.sendFeatureReport(ctx.featureId, new Uint8Array(4)),
        device.receiveFeatureReport(ctx.featureId)
      ]
      const closePromise = device.close()
      const openedDuringClose = device.opened
      const newReportErrors = [
        device.sendReport(ctx.outputId, new Uint8Array(ctx.size)),
        device.sendFeatureReport(ctx.featureId, new Uint8Array(4)),
        device.receiveFeatureReport(ctx.featureId)
      ].map((promise) =>
        promise.then(
          () => 'resolved',
          (error) => (error instanceof Error ? error.name : String(error))
        )
      )
      const openDuringClose = device.open().then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.name : String(error))
      )
      const pendingAtCloseStart = await Promise.all(
        pending.map((promise) =>
          promise.then(
            () => 'resolved',
            (error) => (error instanceof Error ? error.name : String(error))
          )
        )
      )
      await closePromise
      return {
        openedDuringClose,
        pendingAtCloseStart,
        newReportErrors: await Promise.all(newReportErrors),
        openDuringClose: await openDuringClose
      }
    }, VENDOR_CTX)

    expect(state).toEqual({
      openedDuringClose: false,
      pendingAtCloseStart: ['AbortError', 'AbortError', 'AbortError'],
      newReportErrors: ['InvalidStateError', 'InvalidStateError', 'InvalidStateError'],
      openDuringClose: 'InvalidStateError'
    })
  })

  test('close during open waits for and closes the opening session', async ({ page }) => {
    const state = await page.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      const openResult = device.open().then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.name : String(error))
      )
      const duplicateOpenResult = device.open().then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.name : String(error))
      )
      const closeResult = device.close().then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.name : String(error))
      )
      const openedWhileOpening = device.opened
      const [openStatus, duplicateOpenStatus, closeStatus] = await Promise.all([
        openResult,
        duplicateOpenResult,
        closeResult
      ])
      const openedAfterClose = device.opened
      if (device.opened) await device.close()
      return { openStatus, duplicateOpenStatus, closeStatus, openedWhileOpening, openedAfterClose }
    }, VENDOR_CTX)

    expect(state.duplicateOpenStatus).toBe('InvalidStateError')
    expect(state.closeStatus).toBe('resolved')
    expect(state.openedWhileOpening).toBe(false)
    expect(state.openedAfterClose).toBe(false)
  })

  test('sendReport writes the selected report ID and payload', async ({ page, vendorDevice }) => {
    const outputPromise = waitForOutputReport(vendorDevice)
    await page.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      await device.open()
      await device.sendReport(ctx.outputId, new Uint8Array(ctx.size).fill(0x42))
      await device.close()
    }, VENDOR_CTX)
    const output = await outputPromise

    expect(output.data).toEqual([
      VENDOR_OUTPUT_ID,
      ...Array.from({ length: VENDOR_INPUT_SIZE }, () => 0x42)
    ])
  })

  test('inputreport delivers report ID and the exact payload to both handler forms', async ({
    page,
    vendorDevice
  }) => {
    await page.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      await device.open()
    }, VENDOR)

    const receiveReport = await armInputReport(page, VENDOR)
    const payload = new Array<number>(VENDOR_INPUT_SIZE).fill(0x31)
    payload[0] = 0xaa
    sendInput(vendorDevice, VENDOR_OUTPUT_ID, payload)
    const event = await receiveReport()

    expect(event.reportId).toBe(VENDOR_OUTPUT_ID)
    expect(event.data).toEqual(payload)
    expect(event.listenerData).toEqual(payload)
  })

  test('feature report methods reject IDs absent from the descriptor', async ({ page }) => {
    const errors = await page.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      if (!device.opened) await device.open()
      const operations = [
        () => device.sendFeatureReport(ctx.featureId, new Uint8Array(4)),
        () => device.receiveFeatureReport(ctx.featureId)
      ]
      const results: string[] = []
      for (const operation of operations) {
        try {
          await operation()
          results.push('resolved')
        } catch (error) {
          results.push(error instanceof Error ? error.name : String(error))
        }
      }
      return results
    }, VENDOR_CTX)

    expect(errors).toEqual(['NetworkError', 'NetworkError'])
  })

  test('disconnect reaches closed paired devices and reconnect restores its paired entry', async ({
    page,
    vendorDevice
  }) => {
    const siblingPage = await page.context().newPage()
    try {
      await siblingPage.goto(new URL('/tests/test-page.html', page.url()).toString(), {
        waitUntil: 'domcontentloaded'
      })
      await siblingPage.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
        timeout: 15000
      })
      const siblingClosedDevice = await siblingPage.evaluate(async (filter: DeviceFilter) => {
        const device = (await navigator.hid.getDevices()).find(
          (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
        )
        if (!device) throw new Error('vendor device is not paired in sibling page')
        window.tests!.results.closedDisconnect = null
        const onDisconnect = (event: HIDConnectionEvent) => {
          if (event.device !== device) return
          navigator.hid.removeEventListener('disconnect', onDisconnect)
          window.tests!.results.closedDisconnect = {
            closed: !device.opened,
            sameDevice: event.device === device
          }
        }
        navigator.hid.addEventListener('disconnect', onDisconnect)
        return !device.opened
      }, VENDOR)
      expect(siblingClosedDevice).toBe(true)

      await page.evaluate(async (filter: DeviceFilter) => {
        const device = (await navigator.hid.getDevices()).find(
          (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
        )
        if (!device) throw new Error('vendor device is not paired')
        window.tests!.results.disconnect = null
        const onDisconnect = (event: HIDConnectionEvent) => {
          if (event.device !== device) return
          navigator.hid.removeEventListener('disconnect', onDisconnect)
          window.tests!.results.disconnect = { closed: !device.opened }
        }
        navigator.hid.addEventListener('disconnect', onDisconnect)
        if (!device.opened) await device.open()
        window.tests!.results.disconnectReady = true
      }, VENDOR)
      await page.waitForFunction(() => window.tests!.results.disconnectReady === true)
      const mockExited = new Promise<number | null>((resolve) =>
        vendorDevice.process.once('exit', resolve)
      )
      vendorDevice.process.stdin!.write('{"cmd":"destroy"}\n')
      expect(await mockExited).toBe(0)
      await expect
        .poll(() => page.evaluate(() => window.tests!.results.disconnect))
        .toEqual({ closed: true })
      await expect
        .poll(() => siblingPage.evaluate(() => window.tests!.results.closedDisconnect))
        .toEqual({ closed: true, sameDevice: true })

      await page.evaluate((filter: DeviceFilter) => {
        window.tests!.results.connect = false
        const onConnect = (event: HIDConnectionEvent) => {
          if (
            event.device.vendorId !== filter.vendorId ||
            event.device.productId !== filter.productId
          ) {
            return
          }
          navigator.hid.removeEventListener('connect', onConnect)
          window.tests!.results.connect = true
        }
        navigator.hid.addEventListener('connect', onConnect)
      }, VENDOR)
      const replacement = startWebhidMock(
        'vendor.bin',
        vendorDevice.vid,
        vendorDevice.pid,
        DEVICES.vendor.name
      )
      await replacement.ready
      vendorDevice.process = replacement.process
      vendorDevice.ready = replacement.ready

      await page.waitForFunction(() => window.tests!.results.connect === true, undefined, {
        timeout: 10000
      })
      const isPaired = await page.evaluate(
        async (filter: DeviceFilter) =>
          (await navigator.hid.getDevices()).some(
            (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
          ),
        VENDOR
      )
      expect(isPaired).toBe(true)
    } finally {
      await siblingPage.close().catch(() => {})
    }
  })

  test('forgetting blocks operations and aborts pending reports', async ({ page }) => {
    const state = await page.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      await device.open()
      const pendingReportOutcome = device.sendReport(ctx.outputId, new Uint8Array(ctx.size)).then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.name : String(error))
      )
      const forgetPromise = device.forget()
      const openDuringForget = device.open().then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.name : String(error))
      )
      const closeDuringForget = device.close().then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.name : String(error))
      )
      const reportDuringForget = device.sendReport(ctx.outputId, new Uint8Array(ctx.size)).then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.name : String(error))
      )
      const pendingReportAtForgetStart = await pendingReportOutcome
      await forgetPromise
      const devices = await navigator.hid.getDevices()
      const closeAfterForget = await device.close().then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.name : String(error))
      )
      return {
        opened: device.opened,
        stillEnumerated: devices.some(
          (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
        ),
        pendingReportAtForgetStart,
        openDuringForget: await openDuringForget,
        closeDuringForget: await closeDuringForget,
        reportDuringForget: await reportDuringForget,
        closeAfterForget
      }
    }, VENDOR_CTX)

    expect(state).toEqual({
      opened: false,
      stillEnumerated: false,
      pendingReportAtForgetStart: 'AbortError',
      openDuringForget: 'InvalidStateError',
      closeDuringForget: 'InvalidStateError',
      reportDuringForget: 'InvalidStateError',
      closeAfterForget: 'InvalidStateError'
    })
  })
})
