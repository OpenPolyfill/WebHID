import { test, expect } from '../helpers/e2e.js'
import { grantDevicePermission } from '../helpers/e2e-devices.js'
import { VENDOR, VENDOR_CTX } from '../helpers/e2e-reports.js'

test('forget closes a same-origin sibling session', async ({
  sharedPage,
  httpPort,
  vendorDevice
}) => {
  await vendorDevice.ready
  expect(await grantDevicePermission(sharedPage, [VENDOR])).toBe(1)

  const siblingPage = await sharedPage.context().newPage()
  try {
    await siblingPage.goto(`http://localhost:${httpPort}/tests/test-page.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await siblingPage.waitForFunction(() => typeof navigator.hid !== 'undefined', {
      timeout: 15000
    })
    await sharedPage.evaluate(async (filter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      await device.open()
    }, VENDOR)
    await siblingPage.evaluate(async (filter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('sibling cannot see the paired device')
      await device.open()
      window.tests!.results!.siblingDevice = device
    }, VENDOR)

    await sharedPage.evaluate(async (filter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      await device.forget()
    }, VENDOR)
    const siblingError = await siblingPage.evaluate(async (ctx) => {
      const device = window.tests!.results!.siblingDevice as HIDDevice | undefined
      if (!device) throw new Error('sibling device was not retained')
      try {
        await device.sendReport(ctx.outputId, new Uint8Array(ctx.size))
        return null
      } catch (error) {
        return error instanceof Error ? error.name : String(error)
      }
    }, VENDOR_CTX)

    expect(siblingError).toBe('InvalidStateError')
  } finally {
    await siblingPage.close()
  }
})
