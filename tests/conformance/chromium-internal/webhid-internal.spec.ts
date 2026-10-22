import { expect, workerBase as base, withSharedPage } from '../../helpers/e2e.js'
import { grantDevicePermission, mockDeviceName } from '../../helpers/e2e-devices.js'
import type { DeviceFilter } from '../../helpers/e2e-types.js'
import { armInputReport } from '../../helpers/e2e-reports.js'
import {
  sendInput,
  startWebhidMock,
  stopWebhidMock,
  waitForOutputReport,
  type WebhidMockProcess
} from '../../helpers/e2e-process.js'
import type { Page } from '@playwright/test'
const test = withSharedPage(base)
test.describe.configure({ mode: 'serial' })

const deviceVendorId = 0x16c0
const deviceProductId = 1
const deviceFilter: DeviceFilter = { vendorId: deviceVendorId, productId: deviceProductId }
const inputReportId = 4
const outputReportId = 4
const featureReportId = 5

type MockEvent = { event: string; id?: number; data?: number[] }

let mock: WebhidMockProcess | null = null

async function cancelDevicePermission(page: Page, filters: DeviceFilter[]): Promise<number> {
  await page.evaluate(() => {
    window.tests!.results.pickerStarted = new Promise<void>((resolve) => {
      const check = () => {
        if (document.querySelector('#webhid-shadow-host')?.getAttribute('aria-busy') !== 'true') {
          return false
        }
        observer.disconnect()
        resolve()
        return true
      }
      const observer = new MutationObserver(check)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['aria-busy'],
        childList: true,
        subtree: true
      })
      check()
    })
  })
  await page.evaluate((requestedFilters) => {
    window.tests!.helper.requestDevice!(requestedFilters)
  }, filters)
  await page.locator('#request-device-btn').click()

  const pickerState = await page.evaluate(() => {
    const started = window.tests!.results.pickerStarted as Promise<void>
    const request = window.tests!.helper.requestDeviceResult!()
    return Promise.race([
      started.then(() => 'opened' as const),
      request.then(
        () => 'settled' as const,
        () => 'rejected' as const
      )
    ])
  })
  if (pickerState !== 'opened') {
    throw new Error(`requestDevice did not open its chooser: ${pickerState}`)
  }

  await page.waitForFunction(
    () => document.querySelector('#webhid-shadow-host')?.getAttribute('aria-busy') === 'false',
    undefined,
    { timeout: 15000 }
  )
  const requestResult = page.evaluate(() => window.tests!.helper.requestDeviceResult!())
  await page.locator('#webhid-shadow-host').locator('#webhidCancelBtn').click()
  return requestResult
}

function waitForMockEvent(device: WebhidMockProcess, eventName: string): Promise<MockEvent> {
  const stdout = device.process.stdout
  if (!stdout) throw new Error('webhid-mock stdout is unavailable')

  return new Promise((resolvePromise, reject) => {
    let buffered = ''
    const timer = setTimeout(() => {
      stdout.off('data', onData)
      reject(new Error(`Timed out waiting for webhid-mock event ${eventName}`))
    }, 5000)
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString()
      for (;;) {
        const newline = buffered.indexOf('\n')
        if (newline < 0) return
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        try {
          const event = JSON.parse(line) as MockEvent
          if (event.event !== eventName) continue
          clearTimeout(timer)
          stdout.off('data', onData)
          resolvePromise(event)
          return
        } catch {
          continue
        }
      }
    }
    stdout.on('data', onData)
  })
}

test.describe('Chromium internal WebHID tests on Firefox addon', () => {
  test.beforeAll(async () => {
    mock = startWebhidMock('chromium-internal.bin', deviceVendorId, deviceProductId, mockDeviceName)
    await mock.ready
  })

  test.afterAll(() => {
    if (mock) stopWebhidMock(mock)
    mock = null
  })

  test('requestDevice rejects malformed filters and cancellation returns no devices', async ({
    page
  }) => {
    await page.evaluate(() => {
      const button = document.createElement('button')
      button.id = 'request-device-validation'
      button.addEventListener('click', () => {
        const options: unknown[] = [
          undefined,
          {},
          { filters: null },
          { filters: {} },
          { filters: [{}] },
          { filters: [{ productId: 1 }] },
          { filters: [{ usage: 1 }] },
          { exclusionFilters: [] }
        ]
        const requestDevice = navigator.hid.requestDevice.bind(navigator.hid) as unknown as (
          options?: unknown
        ) => Promise<unknown>
        const requests = options.map((option) => {
          try {
            return Promise.resolve(requestDevice(option)).then(
              () => 'resolved',
              (error: unknown) => (error instanceof Error ? error.name : String(error))
            )
          } catch (error) {
            return Promise.resolve(error instanceof Error ? error.name : String(error))
          }
        })
        void Promise.all(requests).then((errors) => {
          window.tests!.results.requestDeviceValidation = errors
        })
      })
      document.body.append(button)
    })
    await page.locator('#request-device-validation').click()
    await page.waitForFunction(
      () => Array.isArray(window.tests!.results.requestDeviceValidation),
      undefined,
      { timeout: 10000 }
    )
    const errors = await page.evaluate(
      () => window.tests!.results.requestDeviceValidation as string[]
    )
    expect(errors).toEqual(new Array(8).fill('TypeError'))

    await expect(
      grantDevicePermission(page, [{ vendorId: deviceVendorId, productId: deviceProductId + 1 }])
    ).rejects.toThrow('picker has no selectable devices')
    expect(await cancelDevicePermission(page, [deviceFilter])).toBe(0)
    expect(await page.evaluate(async () => (await navigator.hid.getDevices()).length)).toBe(0)
  })

  test('requestDevice exposes descriptor metadata and preserves device identity', async ({
    page
  }) => {
    expect(await page.evaluate(async () => (await navigator.hid.getDevices()).length)).toBe(0)
    expect(await grantDevicePermission(page, [deviceFilter])).toBe(1)

    const details = await page.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('granted mock device is missing')
      window.tests!.results.firstDevice = device
      const collection = device.collections[0]
      const unitItem = collection.inputReports.find((report) => report.reportId === 2)?.items[0]
      const rangeItem = collection.inputReports.find((report) => report.reportId === 3)?.items[0]
      return {
        vendorId: device.vendorId,
        productId: device.productId,
        collectionCount: device.collections.length,
        usagePage: collection.usagePage,
        usage: collection.usage,
        collectionType: collection.type,
        inputReportIds: collection.inputReports.map((report) => report.reportId),
        outputReportIds: collection.outputReports.map((report) => report.reportId),
        featureReportIds: collection.featureReports.map((report) => report.reportId),
        unit: unitItem && {
          exponent: unitItem.unitExponent,
          system: unitItem.unitSystem,
          length: unitItem.unitFactorLengthExponent,
          mass: unitItem.unitFactorMassExponent,
          time: unitItem.unitFactorTimeExponent
        },
        range: rangeItem && {
          isRange: rangeItem.isRange,
          usageMinimum: rangeItem.usageMinimum,
          usageMaximum: rangeItem.usageMaximum
        }
      }
    }, deviceFilter)
    expect(details).toMatchObject({
      vendorId: deviceFilter.vendorId,
      productId: deviceFilter.productId,
      collectionCount: 1,
      usagePage: 0xff00,
      usage: 1,
      collectionType: 1,
      inputReportIds: [1, 2, 3, 4],
      outputReportIds: [outputReportId],
      featureReportIds: [featureReportId],
      unit: { exponent: -4, system: 'si-linear', length: 1, mass: 1, time: -2 },
      range: { isRange: true, usageMinimum: 0x00090001, usageMaximum: 0x00090008 }
    })

    expect(await grantDevicePermission(page, [deviceFilter])).toBe(1)
    const identity = await page.evaluate(async () => {
      const original = window.tests!.results.firstDevice as HIDDevice
      const requestedDevices = window.tests!.results.requestDeviceDevices as HIDDevice[]
      const enumerated = (await navigator.hid.getDevices())[0]
      return {
        sameRequestObject: requestedDevices[0] === original,
        sameEnumerationObject: enumerated === original
      }
    })
    expect(identity).toEqual({ sameRequestObject: true, sameEnumerationObject: true })
  })

  test('open and close follow connection state', async ({ page }) => {
    const state = await page.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('mock device is not paired')
      await device.close()
      await device.open()
      const opened = device.opened
      let secondOpenError: string | null = null
      try {
        await device.open()
      } catch (error) {
        secondOpenError = error instanceof Error ? error.name : String(error)
      }
      await device.close()
      const closed = !device.opened
      await device.open()
      const reopened = device.opened
      await device.close()
      return { opened, secondOpenError, closed, reopened }
    }, deviceFilter)
    expect(state).toEqual({
      opened: true,
      secondOpenError: 'InvalidStateError',
      closed: true,
      reopened: true
    })
  })

  test('input, output, and feature reports use declared report IDs', async ({ page }) => {
    const deviceMock = mock
    if (!deviceMock) throw new Error('webhid-mock was not started')

    await page.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('mock device is not paired')
      await device.open()
    }, deviceFilter)

    const payload = [0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]
    const outputPromise = waitForOutputReport(deviceMock)
    await page.evaluate(
      async ({ filter, data, reportId }) => {
        const device = (await navigator.hid.getDevices()).find(
          (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
        )
        if (!device) throw new Error('mock device is not paired')
        await device.sendReport(reportId, new Uint8Array(data))
      },
      { filter: deviceFilter, data: payload, reportId: outputReportId }
    )
    expect((await outputPromise).data).toEqual([outputReportId, ...payload])

    const featurePromise = waitForMockEvent(deviceMock, 'set_report')
    await page.evaluate(
      async ({ filter, data, reportId }) => {
        const device = (await navigator.hid.getDevices()).find(
          (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
        )
        if (!device) throw new Error('mock device is not paired')
        await device.sendFeatureReport(reportId, new Uint8Array(data))
      },
      { filter: deviceFilter, data: payload, reportId: featureReportId }
    )
    expect((await featurePromise).event).toBe('set_report')

    const receiveReport = await armInputReport(page, deviceFilter)
    sendInput(deviceMock, inputReportId, payload)
    const event = await receiveReport()
    expect(event.reportId).toBe(inputReportId)
    expect(event.data).toEqual(payload)
    expect(event.listenerData).toEqual(payload)

    await page.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (device?.opened) await device.close()
    }, deviceFilter)
  })

  test('forget revokes access and a new chooser grant restores it', async ({ page }) => {
    const forgotten = await page.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('mock device is not paired')
      await device.open()
      await device.forget()
      const remaining = await navigator.hid.getDevices()
      let openError: string | null = null
      try {
        await device.open()
      } catch (error) {
        openError = error instanceof Error ? error.name : String(error)
      }
      await device.forget()
      return { opened: device.opened, remaining: remaining.length, openError }
    }, deviceFilter)
    expect(forgotten).toEqual({ opened: false, remaining: 0, openError: 'InvalidStateError' })

    expect(await grantDevicePermission(page, [deviceFilter])).toBe(1)
    const reopened = await page.evaluate(async () => {
      const device = (await navigator.hid.getDevices())[0]
      await device.open()
      const opened = device.opened
      await device.close()
      return opened
    })
    expect(reopened).toBe(true)
  })

  test('disconnect closes the device and reconnect preserves its permission', async ({ page }) => {
    const currentMock = mock
    if (!currentMock) throw new Error('webhid-mock was not started')

    await page.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('mock device is not paired')
      window.tests!.results.disconnect = null
      const onDisconnect = (event: HIDConnectionEvent) => {
        if (event.device !== device) return
        navigator.hid.removeEventListener('disconnect', onDisconnect)
        window.tests!.results.disconnect = { closed: !device.opened }
      }
      navigator.hid.addEventListener('disconnect', onDisconnect)
      if (!device.opened) await device.open()
      window.tests!.results.disconnectReady = true
    }, deviceFilter)
    await page.waitForFunction(() => window.tests!.results.disconnectReady === true)

    const mockExited = new Promise<number | null>((resolve) =>
      currentMock.process.once('exit', resolve)
    )
    currentMock.process.stdin!.write('{"cmd":"destroy"}\n')
    expect(await mockExited).toBe(0)
    await expect
      .poll(() => page.evaluate(() => window.tests!.results.disconnect))
      .toEqual({
        closed: true
      })

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
    }, deviceFilter)
    const replacement = startWebhidMock(
      'chromium-internal.bin',
      deviceVendorId,
      deviceProductId,
      mockDeviceName
    )
    mock = replacement
    await replacement.ready
    await page.waitForFunction(() => window.tests!.results.connect === true, undefined, {
      timeout: 15000
    })

    const remainsPaired = await page.evaluate(
      async (filter: DeviceFilter) =>
        (await navigator.hid.getDevices()).some(
          (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
        ),
      deviceFilter
    )
    expect(remainsPaired).toBe(true)
  })
})
