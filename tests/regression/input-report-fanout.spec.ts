import { test, expect } from '../helpers/e2e.js'
import type { Page } from '@playwright/test'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import { sendInput } from '../helpers/e2e-process.js'
import { getWebHidExtension } from '../helpers/harness.js'
import type { FirefoxExtension } from '@openpolyfill/firefox-addon-playwright-harness'

const VENDOR = mockIdFor('vendor')
const PACKET = [0x10, 0x20, 0x30, 0x40, 0x50].concat(new Array(59).fill(0))

async function prepareFanoutPage(
  page: Page,
  extension: FirefoxExtension,
  enableWorker: boolean
): Promise<void> {
  const origin = new URL(page.url()).origin
  await extension.background!.evaluate<void>(
    ({ siteOrigin, enableWorker }: { siteOrigin: string; enableWorker: boolean }) =>
      browser.storage.local.set({
        [`settings :: ${siteOrigin} :: dataPlane`]: 'nm',
        [`settings :: ${siteOrigin} :: workerPolyfillEnabled`]: enableWorker
      }),
    [{ siteOrigin: origin, enableWorker }]
  )
  await page.goto(`${origin}/tests/test-page.html`, {
    waitUntil: 'domcontentloaded'
  })
  await page.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
    timeout: 15000
  })
  await page.waitForFunction(
    async () => (await navigator.hid.getDevices()).length === 0,
    undefined,
    { timeout: 15000 }
  )
  expect(await grantDevicePermission(page, [VENDOR])).toBe(1)

  if (enableWorker) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
      timeout: 15000
    })
  }

  await page.goto(`${origin}/tests/pages/input-report-fanout.html`, {
    waitUntil: 'domcontentloaded'
  })
}

test.describe.serial('OpenPolyfill input report fan-out', () => {
  test('worker close leaves the window client operational', async ({
    page,
    extensions,
    vendorDevice
  }) => {
    const extension = getWebHidExtension(extensions)
    const origin = new URL(page.url()).origin
    try {
      await prepareFanoutPage(page, extension, true)
      await page.evaluate(() => {
        window.postMessage(
          { type: 'startFanout', iframeCount: 0, includeWorker: true },
          location.origin
        )
      })
      await page.waitForFunction(() => window.tests?.results?.fanoutReady === true, undefined, {
        timeout: 15000
      })
      sendInput(vendorDevice, 1, PACKET)
      await page.waitForFunction(
        () => {
          const counts = window.tests?.results?.fanoutCounts as
            { page?: number; worker?: number } | undefined
          return counts?.page === 1 && counts.worker === 1
        },
        undefined,
        { timeout: 15000 }
      )
      await page.waitForFunction(() => window.tests?.results?.workerClosed === true, undefined, {
        timeout: 15000
      })
      sendInput(vendorDevice, 1, PACKET)
      await page.waitForFunction(
        () => {
          const counts = window.tests?.results?.fanoutCounts as { page?: number } | undefined
          return counts?.page === 2
        },
        undefined,
        { timeout: 15000 }
      )
      await expect(page.evaluate(() => window.tests?.results?.fanoutCounts)).resolves.toEqual({
        page: 2,
        worker: 1
      })
    } finally {
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
      await page.waitForFunction(
        async () => (await navigator.hid.getDevices()).length === 0,
        undefined,
        { timeout: 15000 }
      )
    }
  })

  test('frame replacement and removal do not duplicate parent reports', async ({
    page,
    extensions,
    vendorDevice
  }) => {
    const extension = getWebHidExtension(extensions)
    test.setTimeout(60000)
    const origin = new URL(page.url()).origin
    const settingKeys = [
      `settings :: ${origin} :: dataPlane`,
      `settings :: ${origin} :: workerPolyfillEnabled`
    ]
    await extension.background!.evaluate<void>(
      (keys: string[]) => browser.storage.local.set({ [keys[0]]: 'ws', [keys[1]]: false }),
      [settingKeys]
    )
    try {
      await page.goto(`${origin}/tests/test-page.html`, {
        waitUntil: 'domcontentloaded'
      })
      await page.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
        timeout: 15000
      })
      expect(await grantDevicePermission(page, [VENDOR])).toBe(1)
      await page.evaluate(() => {
        const iframe = document.createElement('iframe')
        iframe.id = 'frame-owner'
        iframe.src = '/tests/test-page.html'
        document.body.appendChild(iframe)
      })
      await expect
        .poll(
          () =>
            page
              .frames()
              .some(
                (frame) =>
                  frame !== page.mainFrame() && frame.url() === `${origin}/tests/test-page.html`
              ),
          { timeout: 15000 }
        )
        .toBe(true)
      const child = page
        .frames()
        .find(
          (frame) => frame !== page.mainFrame() && frame.url() === `${origin}/tests/test-page.html`
        )
      if (!child) throw new Error('child frame was not attached')
      await child.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
        timeout: 15000
      })
      await page.evaluate(async () => {
        const device = (await navigator.hid.getDevices())[0]
        if (!device) throw new Error('top frame device missing')
        await device.open()
        window.tests!.results.reportCount = 0
        device.addEventListener('inputreport', () => {
          window.tests!.results.reportCount = (window.tests!.results.reportCount as number) + 1
        })
      })
      await child.evaluate(async () => {
        const device = (await navigator.hid.getDevices())[0]
        if (!device) throw new Error('child frame device missing')
        await device.open()
      })
      sendInput(vendorDevice, 1, PACKET)
      await page.waitForFunction(() => window.tests?.results.reportCount === 1, undefined, {
        timeout: 15000
      })
      await child.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
      await child.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
        timeout: 15000
      })
      await child.evaluate(async () => {
        const device = (await navigator.hid.getDevices())[0]
        if (!device) throw new Error('reloaded child device missing')
        await device.open()
      })
      sendInput(vendorDevice, 1, PACKET)
      await page.waitForFunction(() => window.tests?.results.reportCount === 2, undefined, {
        timeout: 15000
      })
      await page.evaluate(() => document.querySelector('#frame-owner')?.remove())
      sendInput(vendorDevice, 1, PACKET)
      await page.waitForFunction(() => window.tests?.results.reportCount === 3, undefined, {
        timeout: 15000
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
})
