import { test, expect } from '../helpers/e2e.js'
import { grantDevicePermission } from '../helpers/e2e-devices.js'
import { sendInput, waitForOutputReport } from '../helpers/e2e-process.js'
import {
  armInputReport,
  VENDOR,
  VENDOR_CTX,
  VENDOR_INPUT_SIZE,
  VENDOR_OUTPUT_ID
} from '../helpers/e2e-reports.js'

test('WebHID report I/O works with the WebTransport dataPlane setting', async ({
  sharedPage,
  backgroundPage,
  vendorDevice
}) => {
  const origin = new URL(sharedPage.url()).origin
  const settingKey = `settings :: ${origin} :: dataPlane`
  const previous = await backgroundPage.evaluate(async (key) => {
    const values = (await browser.storage.local.get(key)) as Record<string, unknown>
    return {
      exists: Object.prototype.hasOwnProperty.call(values, key),
      value: values[key] as string | undefined
    }
  }, settingKey)

  try {
    await backgroundPage.evaluate((key) => browser.storage.local.set({ [key]: 'wt' }), settingKey)
    await sharedPage.reload({ waitUntil: 'domcontentloaded' })
    await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', {
      timeout: 15000
    })
    expect(await grantDevicePermission(sharedPage, [VENDOR])).toBe(1)

    await sharedPage.evaluate(async (filter) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      await device.open()
    }, VENDOR)

    const outputPromise = waitForOutputReport(vendorDevice)
    await sharedPage.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (!device) throw new Error('vendor device is not paired')
      await device.sendReport(ctx.outputId, new Uint8Array(ctx.size).fill(0x42))
    }, VENDOR_CTX)
    const output = await outputPromise
    expect(output.data.slice(0, 2)).toEqual([VENDOR_OUTPUT_ID, 0x42])

    const receiveReport = await armInputReport(sharedPage, VENDOR)
    const payload = new Array<number>(VENDOR_INPUT_SIZE).fill(0x53)
    payload[0] = 0xab
    sendInput(vendorDevice, VENDOR_OUTPUT_ID, payload)
    const input = await receiveReport()
    expect(input.reportId).toBe(VENDOR_OUTPUT_ID)
    expect(input.data).toEqual(payload)
    expect(input.dataByteOffset).toBe(0)
    expect(input.dataByteLength).toBe(VENDOR_INPUT_SIZE)
    expect(input.bufferByteLength).toBe(input.dataByteLength)

    await sharedPage.evaluate(async (ctx) => {
      const device = (await navigator.hid.getDevices()).find(
        (entry) => entry.vendorId === ctx.f.vendorId && entry.productId === ctx.f.productId
      )
      if (device?.opened) await device.close()
    }, VENDOR_CTX)
  } finally {
    if (previous.exists) {
      await backgroundPage.evaluate(
        ({ key, value }) => browser.storage.local.set({ [key]: value }),
        { key: settingKey, value: previous.value }
      )
    } else {
      await backgroundPage.evaluate((key) => browser.storage.local.remove(key), settingKey)
    }
    await sharedPage.reload({ waitUntil: 'domcontentloaded' })
  }
})
