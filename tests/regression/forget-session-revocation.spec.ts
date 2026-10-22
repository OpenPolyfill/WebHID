import { test, expect } from '../helpers/e2e.js'
import { grantDevicePermission, mockDeviceName } from '../helpers/e2e-devices.js'
import { startWebhidMock, stopWebhidMock } from '../helpers/e2e-process.js'
import { VENDOR, VENDOR_CTX } from '../helpers/e2e-reports.js'

test('forget revokes every device in a grant group across same-origin documents', async ({
  sharedPage,
  httpPort,
  vendorDevice
}) => {
  await vendorDevice.ready
  const secondDevice = startWebhidMock(
    'vendor.bin',
    VENDOR.vendorId,
    VENDOR.productId + 1,
    mockDeviceName
  )
  const siblingPage = await sharedPage.context().newPage()
  try {
    await secondDevice.ready
    expect(await grantDevicePermission(sharedPage, [{ vendorId: VENDOR.vendorId }])).toBe(2)
    await siblingPage.goto(`http://localhost:${httpPort}/tests/test-page.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await siblingPage.waitForFunction(() => typeof navigator.hid !== 'undefined', {
      timeout: 15000
    })
    await siblingPage.evaluate(async (ctx) => {
      const devices = (await navigator.hid.getDevices())
        .filter((device) => device.vendorId === ctx.f.vendorId)
        .sort((left, right) => left.productId - right.productId)
      if (devices.length !== 2) throw new Error('sibling cannot see both granted interfaces')
      await devices[1].open()
      window.tests!.results!.grantGroupDevices = devices
    }, VENDOR_CTX)

    const localState = await sharedPage.evaluate(async (ctx) => {
      const devices = (await navigator.hid.getDevices())
        .filter((device) => device.vendorId === ctx.f.vendorId)
        .sort((left, right) => left.productId - right.productId)
      if (devices.length !== 2) throw new Error('expected both granted interfaces')
      await Promise.all(devices.map((device) => device.open()))
      const pendingReports = devices.map((device) =>
        device.sendReport(ctx.outputId, new Uint8Array(ctx.size)).then(
          () => 'resolved',
          (error) => (error instanceof Error ? error.name : String(error))
        )
      )
      const forgetPromise = devices[0].forget()
      const openedDuringForget = devices.map((device) => device.opened)
      const openDuringForget = devices.map((device) =>
        device.open().then(
          () => 'resolved',
          (error) => (error instanceof Error ? error.name : String(error))
        )
      )
      const reportDuringForget = devices.map((device) =>
        device.sendReport(ctx.outputId, new Uint8Array(ctx.size)).then(
          () => 'resolved',
          (error) => (error instanceof Error ? error.name : String(error))
        )
      )
      const pendingReportErrors = await Promise.all(pendingReports)
      await forgetPromise
      return {
        productIds: devices.map((device) => device.productId),
        pendingReportErrors,
        openedDuringForget,
        openDuringForget: await Promise.all(openDuringForget),
        reportDuringForget: await Promise.all(reportDuringForget),
        openedAfterForget: devices.map((device) => device.opened)
      }
    }, VENDOR_CTX)

    expect(localState.productIds).toEqual([VENDOR.productId, VENDOR.productId + 1])
    expect(localState.openedDuringForget).toEqual([false, false])
    expect(localState.pendingReportErrors).toEqual(['AbortError', 'AbortError'])
    expect(localState.openDuringForget).toEqual(['InvalidStateError', 'InvalidStateError'])
    expect(localState.reportDuringForget).toEqual(['InvalidStateError', 'InvalidStateError'])
    expect(localState.openedAfterForget).toEqual([false, false])

    await expect
      .poll(() =>
        siblingPage.evaluate(() => {
          const devices = window.tests!.results!.grantGroupDevices as HIDDevice[]
          return devices[1].opened
        })
      )
      .toBe(false)

    const siblingState = await siblingPage.evaluate(async () => {
      const devices = window.tests!.results!.grantGroupDevices as HIDDevice[]
      const openErrors: (string | null)[] = []
      for (const device of devices) {
        try {
          await device.open()
          openErrors.push(null)
        } catch (error) {
          openErrors.push(error instanceof Error ? error.name : String(error))
        }
      }
      return {
        openErrors,
        visibleDeviceCount: (await navigator.hid.getDevices()).length
      }
    })
    expect(siblingState.openErrors).toEqual(['InvalidStateError', 'InvalidStateError'])
    expect(siblingState.visibleDeviceCount).toBe(0)
  } finally {
    await siblingPage.close()
    stopWebhidMock(secondDevice)
  }
})
