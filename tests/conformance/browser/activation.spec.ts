import { test, expect } from '../../helpers/browser.js'

test.describe('requestDevice conformance', () => {
  test('requestDevice returns a rejected Promise without user activation', async ({
    page,
    pageUrl
  }) => {
    await page.goto(pageUrl('/policy-check?no-activation'), {
      waitUntil: 'domcontentloaded'
    })
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.requestDeviceProbeReady === 'true' &&
        navigator.userActivation.isActive === false,
      undefined,
      { timeout: 10000 }
    )
    await page.locator('#no-activation-probe').click()
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.requestDeviceProbeActive === 'false' &&
        document.documentElement.dataset.requestDeviceProbeResult != null,
      undefined,
      { timeout: 10000 }
    )
    const result = await page.locator('html').getAttribute('data-request-device-probe-result')
    expect(result).toBe('SecurityError')
  })

  test('requestDevice rejects invalid option and filter shapes as Promises', async ({ page }) => {
    await page.evaluate(() => {
      const button = document.createElement('button')
      button.id = 'request-device-validation'
      button.addEventListener('click', () => {
        const options: unknown[] = [
          { filters: [{}] },
          { filters: [{ productId: 1 }] },
          { filters: [{ usage: 1 }] },
          { exclusionFilters: [] }
        ]
        const requestDevice = navigator.hid.requestDevice.bind(navigator.hid) as unknown as (
          options?: unknown
        ) => Promise<unknown>
        const results = options.map((option) => {
          let promise: Promise<unknown>
          try {
            promise = requestDevice(option)
          } catch (error) {
            return Promise.resolve(`threw:${error instanceof Error ? error.name : String(error)}`)
          }
          if (!(promise instanceof Promise)) return Promise.resolve('not-a-Promise')
          return promise.then(
            () => 'resolved',
            (error: unknown) => `rejected:${error instanceof Error ? error.name : String(error)}`
          )
        })
        void Promise.all(results).then((outcomes) => {
          document.documentElement.dataset.requestDeviceValidationResults = JSON.stringify(outcomes)
        })
      })
      document.body.append(button)
    })
    await page.locator('#request-device-validation').click()
    await page.waitForFunction(
      () => document.documentElement.dataset.requestDeviceValidationResults != null,
      undefined,
      { timeout: 10000 }
    )
    const errors = await page.evaluate(
      () => JSON.parse(document.documentElement.dataset.requestDeviceValidationResults!) as string[]
    )
    expect(errors).toEqual(new Array(4).fill('rejected:TypeError'))
  })
  test('requestDevice converts dictionaries and rejects conversion errors as Promises', async ({
    page,
    pageUrl
  }) => {
    await page.goto(pageUrl('/policy-check?no-activation&request-device-dictionary-conversion'), {
      waitUntil: 'domcontentloaded'
    })
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.requestDeviceProbeReady === 'true' &&
        typeof navigator.hid !== 'undefined',
      undefined,
      { timeout: 10000 }
    )
    await page.locator('#no-activation-probe').click()
    await page.waitForFunction(
      () => document.documentElement.dataset.requestDeviceProbeResult === 'done',
      undefined,
      { timeout: 10000 }
    )
    const result = await page.evaluate(() => {
      return window.tests!.results.requestDeviceDictionaryConversion as {
        conversionResults: Array<{ returnedPromise: boolean; error: string }>
        convertedAtReturn: string[]
        promiseError: string | null
        promiseReturned: boolean
        coercionReturnedPromise: boolean
        coercionErrorPreserved: boolean
      }
    })

    expect(result.conversionResults).toEqual(
      Array(8).fill({ returnedPromise: true, error: 'TypeError' })
    )
    expect(result.convertedAtReturn).toEqual(['vendorId', 'productId', 'usagePage', 'usage'])
    expect(result.promiseError).toBe('SecurityError')
    expect(result.promiseReturned).toBe(true)
    expect(result.coercionReturnedPromise).toBe(true)
    expect(result.coercionErrorPreserved).toBe(true)
  })

  test('requestDevice rejects filters with only unknown dictionary members as Promises', async ({
    page
  }) => {
    const options = [
      { filters: [{ futureMember: true }] },
      { filters: [{ vendorId: 1 }], exclusionFilters: [{ futureMember: true }] }
    ]
    const results: string[] = []
    for (const [index, requestOptions] of options.entries()) {
      const buttonId = `unknown-filter-${index}`
      await page.evaluate(
        ({ buttonId, requestOptions }) => {
          const button = document.createElement('button')
          button.id = buttonId
          button.textContent = 'Request with unknown filter members'
          button.addEventListener(
            'click',
            () => {
              const root = document.documentElement
              root.dataset.filterValidation = 'pending'
              try {
                const promise = navigator.hid.requestDevice(
                  requestOptions as HIDDeviceRequestOptions
                )
                if (!(promise instanceof Promise)) {
                  root.dataset.filterValidation = 'not-a-Promise'
                  return
                }
                void promise.then(
                  () => {
                    root.dataset.filterValidation = 'resolved'
                  },
                  (error) => {
                    root.dataset.filterValidation =
                      error instanceof Error ? error.name : String(error)
                  }
                )
              } catch (error) {
                root.dataset.filterValidation = `threw:${error instanceof Error ? error.name : String(error)}`
              }
            },
            { once: true }
          )
          document.body.append(button)
        },
        { buttonId, requestOptions }
      )
      await page.locator(`#${buttonId}`).click()
      const completion = await page.waitForFunction(
        () => {
          const result = document.documentElement.dataset.filterValidation
          if (result !== 'pending') return { state: 'settled', result }
          if (
            document.querySelector('#webhid-shadow-host')?.getAttribute('aria-busy') === 'false'
          ) {
            return { state: 'chooser' }
          }
          return false
        },
        undefined,
        { timeout: 10000 }
      )
      const state = (await completion.jsonValue()) as {
        state: string
        result?: string
      }
      if (state.state === 'chooser') {
        await page.keyboard.press('Escape')
        await page.waitForFunction(
          () => document.documentElement.dataset.filterValidation !== 'pending'
        )
      }
      results.push(
        await page.evaluate(() => document.documentElement.dataset.filterValidation ?? '')
      )
      await page.locator(`#${buttonId}`).evaluate((button) => button.remove())
    }

    expect(results).toEqual(['TypeError', 'TypeError'])
  })
})
