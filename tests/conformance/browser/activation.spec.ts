import { test, expect } from '../../helpers/browser.js'
import { navigateToPolicyCheck } from '../../helpers/browser-utils.js'

test.describe('requestDevice conformance', () => {
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
    const result = await sharedPage.locator('html').getAttribute('data-request-device-probe-result')
    expect(result).toBe('SecurityError')
  })

  test('requestDevice validates option and filter shapes', async ({ sharedPage, pageUrl }) => {
    await navigateToPolicyCheck(sharedPage, pageUrl)
    await sharedPage.evaluate(() => {
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
        const results = options.map((option) => {
          try {
            return Promise.resolve(requestDevice(option)).then(
              () => 'resolved',
              (error: unknown) => (error instanceof Error ? error.name : String(error))
            )
          } catch (error) {
            return Promise.resolve(error instanceof Error ? error.name : String(error))
          }
        })
        void Promise.all(results).then((errors) => {
          document.documentElement.dataset.requestDeviceValidationResults = JSON.stringify(errors)
        })
      })
      document.body.append(button)
    })
    await sharedPage.locator('#request-device-validation').click()
    await sharedPage.waitForFunction(
      () => document.documentElement.dataset.requestDeviceValidationResults != null,
      undefined,
      { timeout: 10000 }
    )
    const errors = await sharedPage.evaluate(
      () => JSON.parse(document.documentElement.dataset.requestDeviceValidationResults!) as string[]
    )
    expect(errors).toEqual(new Array(8).fill('TypeError'))
  })
})
