import { test, expect } from '../../helpers/e2e.js'
import { VENDOR } from '../../helpers/e2e-reports.js'
import { mockDeviceName } from '../../helpers/e2e-devices.js'
import { getWebHidExtension } from '../../helpers/harness.js'

type FirefoxChromeWindow = typeof globalThis & {
  gBrowser: {
    selectedBrowser: {
      currentURI: { spec: string }
    }
  }
}

test('privileged picker renders and grants selection in Firefox chrome', async ({
  page,
  chromePages,
  extensions,
  vendorDevice
}) => {
  const extension = getWebHidExtension(extensions)
  const requesterUrl = page.url()
  const origin = new URL(requesterUrl).origin
  const settingKey = `settings :: ${origin} :: devicePickerMode`
  const available = await extension.background!.evaluate(() => Boolean(browser.webhidNativePicker))
  test.skip(!available, 'Requires the experimental addon build with the privileged picker API.')

  await extension.background!.evaluate(
    (key: string) => browser.storage.local.set({ [key]: 'privileged' }),
    [settingKey]
  )
  await vendorDevice.ready
  await page.evaluate((filters) => window.tests!.helper.requestDevice!(filters), [VENDOR])
  await expect
    .poll(() =>
      extension.background!.evaluate(() => {
        const backgroundWebhid = (
          globalThis as unknown as {
            webhid: {
              import: (name: string) => { frameEndpoints: Map<unknown, unknown> }
            }
          }
        ).webhid
        return backgroundWebhid.import('bgState').frameEndpoints.size
      })
    )
    .toBeGreaterThan(0)

  const windows = await chromePages()
  let requestChromePage = null
  for (const candidate of windows) {
    const selectedUrl = await candidate.evaluate(() => {
      const chromeWindow = globalThis as FirefoxChromeWindow
      return chromeWindow.gBrowser.selectedBrowser.currentURI.spec
    })
    if (selectedUrl === requesterUrl) {
      requestChromePage = candidate
      break
    }
  }
  if (!requestChromePage) throw new Error('Firefox chrome window for the requester was not found')

  const result = page.evaluate(() => window.tests!.helper.requestDeviceResult!())
  await page.bringToFront()
  await page.locator('#request-device-btn').click()

  const popup = requestChromePage.locator('#notification-popup')
  const notification = popup.locator('#webHID-chooseDevice-notification')
  await expect(popup).toBeVisible()
  await expect(notification).toBeVisible()
  const menu = notification.locator('#webHID-selectPort-menulist')
  await expect(menu).toBeVisible()
  const labels = await menu
    .locator('menupopup menuitem')
    .evaluateAll((items) => items.map((item) => item.getAttribute('label')))
  expect(labels).toContain(mockDeviceName)
  await popup.locator('.popup-notification-primary-button').click()
  expect(await result).toBe(1)
})
