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
  test('requestDevice converts WebIDL dictionaries before returning a Promise', async ({
    sharedPage,
    pageUrl
  }) => {
    await sharedPage.goto(
      pageUrl('/policy-check?no-activation&request-device-dictionary-conversion'),
      { waitUntil: 'domcontentloaded' }
    )
    await sharedPage.waitForFunction(
      () => document.documentElement.dataset.requestDeviceProbeReady === 'true',
      undefined,
      { timeout: 10000 }
    )
    await sharedPage.locator('#no-activation-probe').click()
    await sharedPage.waitForFunction(
      () => document.documentElement.dataset.requestDeviceProbeResult === 'done',
      undefined,
      { timeout: 10000 }
    )
    const result = await sharedPage.evaluate(() => {
      return window.tests!.results.requestDeviceDictionaryConversion as {
        immediateErrors: string[]
        convertedAtReturn: string[]
        promiseError: string | null
      }
    })

    expect(result.immediateErrors).toEqual(Array(8).fill('TypeError'))
    expect(result.convertedAtReturn).toEqual(['vendorId', 'productId', 'usagePage', 'usage'])
    expect(result.promiseError).toBe('SecurityError')
  })

  test('requestDevice rejects filters with only unknown dictionary members', async ({
    sharedPage,
    pageUrl
  }) => {
    await navigateToPolicyCheck(sharedPage, pageUrl)
    const options = [
      { filters: [{ futureMember: true }] },
      { filters: [{ vendorId: 1 }], exclusionFilters: [{ futureMember: true }] }
    ]
    const results: string[] = []
    for (const [index, requestOptions] of options.entries()) {
      const buttonId = `unknown-filter-${index}`
      await sharedPage.evaluate(
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
                void navigator.hid.requestDevice(requestOptions as HIDDeviceRequestOptions).then(
                  () => {
                    root.dataset.filterValidation = 'resolved'
                  },
                  (error) => {
                    root.dataset.filterValidation =
                      error instanceof Error ? error.name : String(error)
                  }
                )
              } catch (error) {
                root.dataset.filterValidation = error instanceof Error ? error.name : String(error)
              }
            },
            { once: true }
          )
          document.body.append(button)
        },
        { buttonId, requestOptions }
      )
      await sharedPage.locator(`#${buttonId}`).click()
      const completion = await sharedPage.waitForFunction(
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
        await sharedPage.keyboard.press('Escape')
        await sharedPage.waitForFunction(
          () => document.documentElement.dataset.filterValidation !== 'pending'
        )
      }
      results.push(
        await sharedPage.evaluate(() => document.documentElement.dataset.filterValidation ?? '')
      )
      await sharedPage.locator(`#${buttonId}`).evaluate((button) => button.remove())
    }

    expect(results).toEqual(['TypeError', 'TypeError'])
  })
})
