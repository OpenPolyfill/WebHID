import { test, expect } from '../helpers/e2e.js'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import { sendInput } from '../helpers/e2e-process.js'

const VENDOR = mockIdFor('vendor')
const PACKET = [0x10, 0x20, 0x30, 0x40, 0x50].concat(new Array(59).fill(0))

test.describe.serial('Exact frame endpoint fanout', () => {
  test('background fanout survives one frame teardown', async ({
    sharedPage,
    backgroundPage,
    vendorDevice
  }) => {
    const origin = new URL(sharedPage.url()).origin
    const settingKeys = [
      `settings :: ${origin} :: dataPlane`,
      `settings :: ${origin} :: workerPolyfillEnabled`
    ]
    const previous = await backgroundPage.evaluate(
      (keys: string[]) => browser.storage.local.get(keys),
      settingKeys
    )
    await backgroundPage.evaluate(
      ([dataPlaneKey, workerKey]) =>
        browser.storage.local.set({ [dataPlaneKey]: 'nm', [workerKey]: false }),
      settingKeys
    )
    try {
      await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
      await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', {
        timeout: 15000
      })
      expect(await grantDevicePermission(sharedPage, [VENDOR])).toBe(1)
      await sharedPage.goto(`${origin}/tests/pages/input-report-fanout.html`, {
        waitUntil: 'domcontentloaded'
      })
      await sharedPage.evaluate(() => {
        window.postMessage(
          { type: 'startFanout', iframeCount: 1, includeWorker: false },
          location.origin
        )
      })
      await sharedPage.waitForFunction(
        () => {
          const results = window.tests?.results
          const error = results?.fanoutError
          if (typeof error === 'string') throw new Error(error)
          return results?.fanoutReady === true
        },
        { timeout: 15000 }
      )
      sendInput(vendorDevice, 1, PACKET)
      await sharedPage.waitForFunction(
        () => {
          const testResults = window.tests!.results as unknown as {
            fanoutCounts?: Record<string, number>
          }
          const counts = testResults.fanoutCounts
          return counts?.page === 1 && counts['iframe-0'] === 1
        },
        { timeout: 15000 }
      )
      await sharedPage.evaluate(() => document.querySelector('iframe')?.remove())
      await expect
        .poll(
          () =>
            backgroundPage.evaluate(async () => {
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
      await sharedPage.waitForFunction(
        () => {
          const testResults = window.tests!.results as unknown as {
            fanoutCounts?: Record<string, number>
          }
          return testResults.fanoutCounts?.page === 2
        },
        { timeout: 15000 }
      )
      await expect(sharedPage.evaluate(() => window.tests?.results?.fanoutCounts)).resolves.toEqual(
        {
          page: 2,
          'iframe-0': 1
        }
      )
    } finally {
      await sharedPage.evaluate(async () => {
        for (const device of await navigator.hid.getDevices()) {
          if (device.opened) await device.close()
          await device.forget()
        }
      })
      await sharedPage.waitForFunction(
        async () => (await navigator.hid.getDevices()).length === 0,
        { timeout: 15000 }
      )
      await backgroundPage.evaluate(
        ({ keys, values }) => {
          const missing = keys.filter((key) => !(key in values))
          return browser.storage.local
            .remove(missing)
            .then(() => browser.storage.local.set(values))
        },
        { keys: settingKeys, values: previous }
      )
      await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
    }
  })

  test('pending open cannot publish after top document replacement', async ({
    sharedPage,
    backgroundPage,
    vendorDevice
  }) => {
    const origin = new URL(sharedPage.url()).origin
    const settingKey = `settings :: ${origin} :: dataPlane`
    await vendorDevice.ready
    const previous = await backgroundPage.evaluate(
      (key: string) => browser.storage.local.get(key),
      settingKey
    )
    await backgroundPage.evaluate(
      (key: string) => browser.storage.local.set({ [key]: 'nm' }),
      settingKey
    )
    try {
      await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
      await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', {
        timeout: 15000
      })
      await grantDevicePermission(sharedPage, [VENDOR])
      await backgroundPage.evaluate(() => {
        const state = globalThis as unknown as {
          webhid: {
            import(name: string): {
              openDevice: (deviceId: number) => Promise<object>
              closeDevice: (deviceId: number, token: string) => Promise<object>
            }
          }
          __originalOpenDevice?: (deviceId: number) => Promise<object>
          __originalCloseDevice?: (deviceId: number, token: string) => Promise<object>
          __openEntered?: boolean
          __releaseOpen?: () => void
        }
        const nm = state.webhid.import('NativeMessaging')
        state.__originalOpenDevice = nm.openDevice.bind(nm)
        state.__originalCloseDevice = nm.closeDevice.bind(nm)
        state.__openEntered = false
        nm.openDevice = async (deviceId: number) => {
          state.__openEntered = true
          await new Promise<void>((resolve) => {
            state.__releaseOpen = resolve
          })
          return { s: 200, i: deviceId, t: 'stale-open' }
        }
        nm.closeDevice = () => Promise.resolve({ s: 204 })
      })
      await sharedPage.evaluate(() => {
        const state = window as unknown as { pendingOpen?: Promise<unknown> }
        state.pendingOpen = (async () => {
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
          backgroundPage.evaluate(
            () => (globalThis as unknown as { __openEntered?: boolean }).__openEntered === true
          )
        )
        .toBe(true)
      await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
      await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', {
        timeout: 15000
      })
      await backgroundPage.evaluate(() => {
        ;(globalThis as unknown as { __releaseOpen?: () => void }).__releaseOpen?.()
      })
      await expect
        .poll(
          () =>
            backgroundPage.evaluate(async () => {
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
      await backgroundPage.evaluate(() => {
        const state = globalThis as unknown as {
          webhid: {
            import(name: string): {
              openDevice: (deviceId: number) => Promise<object>
              closeDevice: (deviceId: number, token: string) => Promise<object>
            }
          }
          __originalOpenDevice?: (deviceId: number) => Promise<object>
          __originalCloseDevice?: (deviceId: number, token: string) => Promise<object>
        }
        const nm = state.webhid.import('NativeMessaging')
        if (state.__originalOpenDevice) nm.openDevice = state.__originalOpenDevice
        if (state.__originalCloseDevice) nm.closeDevice = state.__originalCloseDevice
      })
      await backgroundPage.evaluate(
        ({ key, values }) =>
          browser.storage.local
            .remove(!(key in values) ? [key] : [])
            .then(() => (key in values ? browser.storage.local.set(values) : undefined)),
        { key: settingKey, values: previous }
      )
    }
  })
})
