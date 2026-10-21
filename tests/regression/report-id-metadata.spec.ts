import { test, expect } from '../helpers/e2e.js'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import type { DeviceFilter } from '../helpers/e2e-types.js'

const VENDOR = mockIdFor('vendor')

test.describe.serial('HID report ID metadata', () => {
  test('report validation stays independent of mutable public collections', async ({
    sharedPage,
    vendorDevice: _vendorDevice
  }) => {
    const clearDevices = async () =>
      sharedPage.evaluate(async () => {
        for (const device of await navigator.hid.getDevices()) {
          if (device.opened) await device.close()
          await device.forget()
        }
      })

    await clearDevices()
    expect(await grantDevicePermission(sharedPage, [VENDOR])).toBe(1)

    try {
      const errors = await sharedPage.evaluate(async (filter: DeviceFilter) => {
        const device = (await navigator.hid.getDevices()).find(
          (entry) => entry.vendorId === filter.vendorId && entry.productId === filter.productId
        )
        if (!device) throw new Error('vendor device is not paired')
        await device.open()
        const originalReportIds: Array<{ report: { reportId: number }; reportId: number }> = []
        const visit = (collections: typeof device.collections) => {
          for (const collection of collections) {
            const reportGroups = [
              collection.inputReports,
              collection.outputReports,
              collection.featureReports
            ]
            for (const reports of reportGroups) {
              for (const report of reports) {
                originalReportIds.push({ report, reportId: report.reportId })
                report.reportId = 0
              }
            }
            visit(collection.children)
          }
        }
        try {
          visit(device.collections)
          const operations = [
            device.sendReport(0, new Uint8Array(0)),
            device.sendFeatureReport(0, new Uint8Array(0)),
            device.receiveFeatureReport(0)
          ]
          return await Promise.all(
            operations.map(async (operation) => {
              try {
                await operation
                return 'resolved'
              } catch (error) {
                return error instanceof Error ? error.name : String(error)
              }
            })
          )
        } finally {
          for (const { report, reportId } of originalReportIds) report.reportId = reportId
          await device.close()
        }
      }, VENDOR)

      expect(errors).toEqual(['TypeError', 'TypeError', 'TypeError'])
    } finally {
      await clearDevices()
    }
  })
})
