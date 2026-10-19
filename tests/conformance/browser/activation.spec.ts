import { test, expect } from '../../helpers/browser.js'
import { navigateToPolicyCheck } from '../../helpers/browser-utils.js'
test.describe('requestDevice conformance', () => {
  let origin: string
  const settingKey = () => `settings :: ${origin} :: allowActivationlessRequestDevice`

  test.beforeAll(async ({ backgroundPage, servers }) => {
    origin = `http://localhost:${servers.main.port}`
    await backgroundPage.evaluate((key) => browser.storage.local.remove(key), settingKey())
  })

  test('requestDevice without user activation rejects with SecurityError', async ({
    sharedPage,
    pageUrl
  }) => {
    await sharedPage.goto(pageUrl('/policy-check?no-activation'), {
      waitUntil: 'domcontentloaded'
    })
    await sharedPage.waitForFunction(
      () =>
        document.documentElement.dataset.requestDeviceProbeReady === 'true' &&
        navigator.userActivation.isActive === false,
      undefined,
      { timeout: 10000 }
    )
    await sharedPage.locator('#no-activation-probe').click()
    await sharedPage.waitForFunction(
      () =>
        document.documentElement.dataset.requestDeviceProbeActive === 'false' &&
        document.documentElement.dataset.requestDeviceProbeResult != null,
      undefined,
      { timeout: 10000 }
    )
    const result = await sharedPage
      .locator('html')
      .getAttribute('data-request-device-probe-result')
    expect(result).toBe('SecurityError')
  })

  test('requestDevice validates option and filter shapes', async ({
    backgroundPage,
    sharedPage,
    pageUrl
  }) => {
    await backgroundPage.evaluate((key) => browser.storage.local.set({ [key]: true }), settingKey())
    try {
      await navigateToPolicyCheck(sharedPage, pageUrl)
      const result = await sharedPage.evaluate(async () => {
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
        const errors: string[] = []
        for (const option of options) {
          try {
            await requestDevice(option)
            errors.push('resolved')
          } catch (error) {
            errors.push(error instanceof Error ? error.name : String(error))
          }
        }
        return errors
      })
      expect(result).toEqual(new Array(8).fill('TypeError'))
    } finally {
      await backgroundPage.evaluate((key) => browser.storage.local.remove(key), settingKey())
    }
  })
})
