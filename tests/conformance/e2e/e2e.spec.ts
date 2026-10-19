import { test, expect } from '../../helpers/e2e.js'
import { grantDevicePermission } from '../../helpers/e2e-devices.js'
import type { DeviceFilter } from '../../helpers/e2e-types.js'
import {
  armInputReport,
  VENDOR,
  VENDOR_CTX,
  VENDOR_INPUT_SIZE,
  VENDOR_OUTPUT_ID
} from '../../helpers/e2e-reports.js'
import { sendInput, waitForOutputReport, startWebhidMock } from '../../helpers/e2e-process.js'

type VendorCtx = typeof VENDOR_CTX

test.describe.serial('WebHID conformance', () => {
  test('requestDevice grants the matching device and exposes its descriptor', async ({
    sharedPage,
    vendorDevice
  }) => {
    const beforeGrant = await sharedPage.evaluate(
      async (filter: DeviceFilter) =>
        (await navigator.hid.getDevices()).filter(
          (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
        ).length,
      VENDOR
    )
    expect(beforeGrant).toBe(0)
    expect(await grantDevicePermission(sharedPage, [VENDOR])).toBe(1)
    const device = await sharedPage.evaluate(async (filter: DeviceFilter) => {
      const found = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!found) throw new Error('granted device missing from getDevices()')
      return {
        vendorId: found.vendorId,
        productId: found.productId,
        collectionCount: found.collections.length,
        collectionsFrozen: Object.isFrozen(found.collections),
        inputReportIds: found.collections.flatMap((collection) =>
          collection.inputReports.map((report) => report.reportId)
        ),
        outputReportIds: found.collections.flatMap((collection) =>
          collection.outputReports.map((report) => report.reportId)
        ),
        has64ByteInput: found.collections.some((collection) =>
          collection.inputReports.some((report) =>
            report.items.some((item) => item.reportSize === 8 && item.reportCount === 64)
          )
        )
      }
    }, VENDOR)

    expect(device.vendorId).toBe(vendorDevice.vid)
    expect(device.productId).toBe(vendorDevice.pid)
    expect(device.collectionCount).toBe(2)
    expect(device.collectionsFrozen).toBe(true)
    expect(device.inputReportIds).toContain(VENDOR_OUTPUT_ID)
    expect(device.outputReportIds).toContain(VENDOR_OUTPUT_ID)
    expect(device.has64ByteInput).toBe(true)
  })

  test('input and output report methods require an open device', async ({ sharedPage }) => {
    const errors = await sharedPage.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      const operations = [
        () => device.sendReport(ctx.outputId, new Uint8Array(ctx.size)),
        () => device.sendFeatureReport(ctx.featureId, new Uint8Array(4)),
        () => device.receiveFeatureReport(ctx.featureId)
      ]
      const errors: string[] = []
      for (const operation of operations) {
        try {
          await operation()
          errors.push('resolved')
        } catch (error) {
          errors.push(error instanceof Error ? error.name : String(error))
        }
      }
      return errors
    }, VENDOR_CTX)

    expect(errors).toEqual(['InvalidStateError', 'InvalidStateError', 'InvalidStateError'])
  })
  test('report methods enforce their WebIDL octet range', async ({ sharedPage }) => {
    const errors = await sharedPage.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      const operations = [
        () => device.sendReport(256, new Uint8Array(ctx.size)),
        () => device.sendFeatureReport(-1, new Uint8Array(4)),
        () => device.receiveFeatureReport(257)
      ]
      const results: string[] = []
      for (const operation of operations) {
        try {
          await operation()
          results.push('resolved')
        } catch (error) {
          results.push(error instanceof Error ? error.name : String(error))
        }
      }
      return results
    }, VENDOR_CTX)

    expect(errors).toEqual(['TypeError', 'TypeError', 'TypeError'])
  })

  test('open and close update opened and resolve with undefined', async ({ sharedPage }) => {
    const state = await sharedPage.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      const openResult = await device.open()
      const opened = device.opened
      const closeResult = await device.close()
      return { openResult, opened, closeResult, closed: !device.opened }
    }, VENDOR_CTX)

    expect(state).toEqual({
      openResult: undefined,
      opened: true,
      closeResult: undefined,
      closed: true
    })
  })
  test('sendReport writes the selected report ID and payload', async ({
    sharedPage,
    vendorDevice
  }) => {
    const outputPromise = waitForOutputReport(vendorDevice)
    await sharedPage.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      await device.open()
      await device.sendReport(ctx.outputId, new Uint8Array(ctx.size).fill(0x42))
      await device.close()
    }, VENDOR_CTX)
    const output = await outputPromise

    expect(output.data[0]).toBe(VENDOR_OUTPUT_ID)
    expect(output.data[1]).toBe(0x42)
  })

  test('inputreport delivers report ID and the exact payload to both handler forms', async ({
    sharedPage,
    vendorDevice
  }) => {
    await sharedPage.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      await device.open()
    }, VENDOR)

    const receiveReport = await armInputReport(sharedPage, VENDOR)
    const payload = new Array<number>(VENDOR_INPUT_SIZE).fill(0x31)
    payload[0] = 0xaa
    sendInput(vendorDevice, VENDOR_OUTPUT_ID, payload)
    const event = await receiveReport()

    expect(event.reportId).toBe(VENDOR_OUTPUT_ID)
    expect(event.data).toEqual(payload)
    expect(event.listenerData).toEqual(payload)
    expect(event.dataByteOffset).toBe(0)
    expect(event.dataByteLength).toBe(VENDOR_INPUT_SIZE)
    expect(event.bufferByteLength).toBe(VENDOR_INPUT_SIZE)
  })

  test('feature report methods reject IDs absent from the descriptor', async ({ sharedPage }) => {
    const errors = await sharedPage.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      if (!device.opened) await device.open()
      const operations = [
        () => device.sendFeatureReport(ctx.featureId, new Uint8Array(4)),
        () => device.receiveFeatureReport(ctx.featureId)
      ]
      const results: string[] = []
      for (const operation of operations) {
        try {
          await operation()
          results.push('resolved')
        } catch (error) {
          results.push(error instanceof Error ? error.name : String(error))
        }
      }
      return results
    }, VENDOR_CTX)

    expect(errors).toEqual(['NetworkError', 'NetworkError'])
  })

  test('disconnect closes the device and reconnect restores its paired entry', async ({
    sharedPage,
    vendorDevice
  }) => {
    await sharedPage.evaluate(async (filter: DeviceFilter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      window.tests!.results!.disconnect = null
      const onDisconnect = (event: HIDConnectionEvent) => {
        if (event.device.deviceId !== device.deviceId) return
        navigator.hid.removeEventListener('disconnect', onDisconnect)
        window.tests!.results!.disconnect = { closed: !device.opened }
      }
      navigator.hid.addEventListener('disconnect', onDisconnect)
      if (!device.opened) await device.open()
      window.tests!.results!.disconnectReady = true
    }, VENDOR)
    await sharedPage.waitForFunction(() => window.tests!.results!.disconnectReady === true)
    const mockExited = new Promise<number | null>((resolve) =>
      vendorDevice.process.once('exit', resolve)
    )
    vendorDevice.process.stdin!.write('{"cmd":"destroy"}\n')
    expect(await mockExited).toBe(0)
    await expect
      .poll(() => sharedPage.evaluate(() => window.tests!.results!.disconnect))
      .toEqual({ closed: true })

    const replacement = startWebhidMock('vendor.bin', vendorDevice.vid, vendorDevice.pid)
    await replacement.ready
    vendorDevice.process = replacement.process
    vendorDevice.ready = replacement.ready

    await expect
      .poll(
        () =>
          sharedPage.evaluate(
            async (filter: DeviceFilter) =>
              (await navigator.hid.getDevices()).some(
                (entry) =>
                  entry.vendorId === filter.vendorId && entry.productId === filter.productId
              ),
            VENDOR
          ),
        { timeout: 10000 }
      )
      .toBe(true)
  })

  test('forget revokes the grant and closes a same-origin sibling session', async ({
    sharedPage,
    httpPort
  }) => {
    const siblingPage = await sharedPage.context().newPage()
    try {
      await siblingPage.goto(`http://localhost:${httpPort}/tests/test-page.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      await siblingPage.waitForFunction(() => typeof navigator.hid !== 'undefined', {
        timeout: 15000
      })
      await sharedPage.evaluate(async (ctx) => {
        const device = (await navigator.hid.getDevices()).find(
          (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
        )
        if (!device) throw new Error('vendor device is not paired')
        await device.open()
      }, VENDOR_CTX)
      await siblingPage.evaluate(async (ctx: DeviceFilter) => {
        const device = (await navigator.hid.getDevices()).find(
          (entry) => entry.vendorId === ctx.vendorId && entry.productId === ctx.productId
        )
        if (!device) throw new Error('sibling cannot see the paired device')
        await device.open()
        ;(globalThis as typeof globalThis & { siblingDevice?: HIDDevice }).siblingDevice = device
      }, VENDOR)

      const remaining = await sharedPage.evaluate(async (ctx) => {
        const device = (await navigator.hid.getDevices()).find(
          (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
        )
        if (!device) throw new Error('vendor device is not paired')
        await device.forget()
        return (await navigator.hid.getDevices()).length
      }, VENDOR_CTX)
      const siblingError = await siblingPage.evaluate(async (ctx: VendorCtx) => {
        const device = (globalThis as typeof globalThis & { siblingDevice?: HIDDevice })
          .siblingDevice
        if (!device) throw new Error('sibling device was not retained')
        try {
          await device.sendReport(ctx.outputId, new Uint8Array(ctx.size))
          return null
        } catch (error) {
          return error instanceof Error ? error.name : String(error)
        }
      }, VENDOR_CTX)

      expect(remaining).toBe(0)
      expect(siblingError).toBe('InvalidStateError')
    } finally {
      await siblingPage.close()
    }
  })
})
