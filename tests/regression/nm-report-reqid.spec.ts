import { test, expect } from '../helpers/e2e.js'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import type { Page } from '@playwright/test'

const VENDOR = mockIdFor('vendor')

async function closeDevice(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const device = (await navigator.hid.getDevices())[0]
    if (!device) return
    if (device.opened) await device.close()
    await device.forget()
  })
}

test.describe.serial('NM report request routing', () => {
  test('routes concurrent reports from page contexts independently', async ({
    page,
    extension,
    vendorDevice
  }) => {
    await vendorDevice.ready
    const origin = new URL(page.url()).origin
    await extension.background!.evaluate(
      (siteOrigin: string) => {
        return browser.storage.local.set({ [`settings :: ${siteOrigin} :: dataPlane`]: 'nm' })
      },
      [origin]
    )
    await page.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
      timeout: 15000
    })
    await page.evaluate(async () => {
      for (const device of await navigator.hid.getDevices()) {
        if (device.opened) await device.close()
        await device.forget()
      }
    })
    expect(await grantDevicePermission(page, [VENDOR])).toBe(1)
    await page.goto(`${origin}/tests/pages/nm-report-reqid.html`, {
      waitUntil: 'domcontentloaded'
    })
    await page.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
      timeout: 15000
    })

    await page.evaluate(() => {
      window.postMessage({ type: 'start' }, location.origin)
    })
    await page.waitForFunction(
      () => {
        const results = window.tests?.results
        if (typeof results?.reportError === 'string') throw new Error(results.reportError)
        return results?.reportResults !== undefined
      },
      undefined,
      { timeout: 15000 }
    )

    await expect(page.evaluate(() => window.tests?.results?.reportResults)).resolves.toEqual({
      first: 'ok',
      second: 'ok'
    })
    await closeDevice(page)
    await page.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
  })
})
