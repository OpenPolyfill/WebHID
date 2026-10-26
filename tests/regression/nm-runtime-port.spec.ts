import { test, expect } from '../helpers/e2e.js'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import { sendInput } from '../helpers/e2e-process.js'
import { getWebHidExtension } from '../helpers/harness.js'

const VENDOR = mockIdFor('vendor')
const PACKET = [0x10, 0x20, 0x30, 0x40, 0x50].concat(new Array(59).fill(0))
interface NativeMessagingApi {
  openDevice: (deviceId: number) => Promise<object>
  closeDevice: (deviceId: number, token: string) => Promise<object>
}

interface BackgroundTestState {
  helper: {
    originalOpenDevice?: NativeMessagingApi['openDevice']
    originalCloseDevice?: NativeMessagingApi['closeDevice']
    releaseOpen?: () => void
  }
  results: { openEntered?: boolean }
}

interface BackgroundWebhid {
  import(name: string): NativeMessagingApi
}

test.describe.serial('Exact frame endpoint fanout', () => {
  test('background fanout survives one frame teardown', async ({
    page,
    extensions,
    vendorDevice
  }) => {
    const extension = getWebHidExtension(extensions)
    const origin = new URL(page.url()).origin
    const settingKeys = [
      `settings :: ${origin} :: dataPlane`,
      `settings :: ${origin} :: workerPolyfillEnabled`
    ]
    await extension.background!.evaluate<void>(
      ([dataPlaneKey, workerKey]: string[]) =>
        browser.storage.local.set({ [dataPlaneKey]: 'nm', [workerKey]: false }),
      [settingKeys]
    )
    try {
      await page.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
        timeout: 15000
      })
      expect(await grantDevicePermission(page, [VENDOR])).toBe(1)
      await page.goto(`${origin}/tests/pages/input-report-fanout.html`, {
        waitUntil: 'domcontentloaded'
      })
      await page.evaluate(() => {
        window.postMessage(
          { type: 'startFanout', iframeCount: 1, includeWorker: false },
          location.origin
        )
      })
      await page.waitForFunction(
        () => {
          const results = window.tests?.results
          const error = results?.fanoutError
          if (typeof error === 'string') throw new Error(error)
          return results?.fanoutReady === true
        },
        undefined,
        { timeout: 15000 }
      )
      sendInput(vendorDevice, 1, PACKET)
      await page.waitForFunction(
        () => {
          const testResults = window.tests!.results as unknown as {
            fanoutCounts?: Record<string, number>
          }
          const counts = testResults.fanoutCounts
          return counts?.page === 1 && counts['iframe-0'] === 1
        },
        undefined,
        { timeout: 15000 }
      )
      await page.evaluate(() => document.querySelector('iframe')?.remove())
      await expect
        .poll(
          () =>
            extension.background!.evaluate(async () => {
              const tabs = await browser.tabs.query({ active: true, currentWindow: true })
              const tab = tabs[0]
              if (!tab || tab.id == null) return 0
              const status = (await browser.tabs.sendMessage(tab.id, {
                action: 'getDataPlaneStatus'
              })) as { planes?: unknown[] } | null
              return status?.planes?.length || 0
            }),
          { timeout: 15000 }
        )
        .toBe(1)
      sendInput(vendorDevice, 1, PACKET)
      await page.waitForFunction(
        () => {
          const testResults = window.tests!.results as unknown as {
            fanoutCounts?: Record<string, number>
          }
          return testResults.fanoutCounts?.page === 2
        },
        undefined,
        { timeout: 15000 }
      )
      await expect(page.evaluate(() => window.tests?.results?.fanoutCounts)).resolves.toEqual({
        page: 2,
        'iframe-0': 1
      })
    } finally {
      await page.evaluate(async () => {
        for (const device of await navigator.hid.getDevices()) {
          if (device.opened) await device.close()
          await device.forget()
        }
      })
      await page.waitForFunction(
        async () => (await navigator.hid.getDevices()).length === 0,
        undefined,
        { timeout: 15000 }
      )
      await page.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
    }
  })

  test('pending open cannot publish after top document replacement', async ({
    page,
    extensions,
    vendorDevice
  }) => {
    const extension = getWebHidExtension(extensions)
    const origin = new URL(page.url()).origin
    const settingKey = `settings :: ${origin} :: dataPlane`
    await vendorDevice.ready
    await extension.background!.evaluate(
      (key: string) => browser.storage.local.set({ [key]: 'nm' }),
      [settingKey]
    )
    try {
      await page.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
        timeout: 15000
      })
      await grantDevicePermission(page, [VENDOR])
      await extension.background!.evaluate(() => {
        const state = globalThis as unknown as {
          webhid: BackgroundWebhid
          tests: BackgroundTestState
        }
        state.tests = state.tests || { helper: {}, results: {} }
        const { helper, results } = state.tests
        const nm = state.webhid.import('NativeMessaging')
        helper.originalOpenDevice = nm.openDevice.bind(nm)
        helper.originalCloseDevice = nm.closeDevice.bind(nm)
        results.openEntered = false
        nm.openDevice = async (deviceId: number) => {
          results.openEntered = true
          const { promise, resolve } = Promise.withResolvers<void>()
          helper.releaseOpen = () => resolve()
          await promise
          return { s: 200, i: deviceId, t: 'stale-open' }
        }
        nm.closeDevice = () => Promise.resolve({ s: 204 })
      })
      await page.evaluate(() => {
        window.tests!.results.pendingOpen = (async () => {
          const devices = await navigator.hid.getDevices()
          if (!devices[0]) throw new Error('paired device missing')
          try {
            await devices[0].open()
          } catch {
            return
          }
        })()
      })
      await expect
        .poll(() =>
          extension.background!.evaluate(() => {
            const testState = globalThis.tests as unknown as BackgroundTestState
            return testState.results.openEntered === true
          })
        )
        .toBe(true)
      await page.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
        timeout: 15000
      })
      await extension.background!.evaluate(() => {
        const testState = globalThis.tests as unknown as BackgroundTestState
        testState.helper.releaseOpen?.()
      })
      await expect
        .poll(
          () =>
            extension.background!.evaluate(async () => {
              const tabs = await browser.tabs.query({ active: true, currentWindow: true })
              const tab = tabs[0]
              if (!tab || tab.id == null) return []
              const raw = (await browser.tabs.sendMessage(tab.id, {
                action: 'getOpenDeviceIds'
              })) as { ids?: string[] } | null
              return raw?.ids || []
            }),
          { timeout: 15000 }
        )
        .toEqual([])
    } finally {
      await extension.background!.evaluate(() => {
        const state = globalThis as unknown as {
          webhid: BackgroundWebhid
          tests: BackgroundTestState
        }
        const nm = state.webhid.import('NativeMessaging')
        if (state.tests.helper.originalOpenDevice) {
          nm.openDevice = state.tests.helper.originalOpenDevice
        }
        if (state.tests.helper.originalCloseDevice) {
          nm.closeDevice = state.tests.helper.originalCloseDevice
        }
      })
    }
  })
})
