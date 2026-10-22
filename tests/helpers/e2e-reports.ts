import { type Page } from '@playwright/test'
import { mockIdFor } from './e2e-devices.js'
import type { DeviceFilter } from './e2e-types.js'

export const VENDOR = mockIdFor('vendor')
export const VENDOR_INPUT_SIZE = 64
export const VENDOR_OUTPUT_ID = 1
export const UNDECLARED_FEATURE_REPORT_ID = 0x02

export const VENDOR_CTX = {
  f: VENDOR,
  size: VENDOR_INPUT_SIZE,
  outputId: VENDOR_OUTPUT_ID,
  featureId: UNDECLARED_FEATURE_REPORT_ID
}

export type VendorCtx = typeof VENDOR_CTX

interface InputReportData {
  reportId: number
  data: number[]
  dataByteLength: number
  dataByteOffset: number
  bufferByteLength: number
}

export interface ReportEvent {
  reportId: number
  data: number[]
  dataByteLength: number
  dataByteOffset: number
  bufferByteLength: number
  listenerData: number[]
}

let nextInputReportId = 0

export async function armInputReport(
  page: Page,
  filter: DeviceFilter
): Promise<() => Promise<ReportEvent>> {
  const key = `webhidInputReport${++nextInputReportId}`
  await page.evaluate(
    async ({ f, key }) => {
      const devices = await navigator.hid.getDevices()
      const device = devices.find(
        (entry) => entry.vendorId === f.vendorId && entry.productId === f.productId
      )
      if (!device) throw new Error(`device not paired: ${JSON.stringify(f)}`)

      const pending = Promise.withResolvers<ReportEvent>()
      let propertyEvent: InputReportData | null = null
      let listenerEvent: number[] | null = null
      const toReport = (event: HIDInputReportEvent): InputReportData => ({
        reportId: event.reportId,
        data: Array.from(
          new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
        ),
        dataByteLength: event.data.byteLength,
        dataByteOffset: event.data.byteOffset,
        bufferByteLength: event.data.buffer.byteLength
      })
      const finish = () => {
        if (!propertyEvent || !listenerEvent) return
        device.oninputreport = null
        device.removeEventListener('inputreport', onInputReport)
        pending.resolve({ ...propertyEvent, listenerData: listenerEvent })
      }
      const onInputReport = (event: Event) => {
        listenerEvent = toReport(event as HIDInputReportEvent).data
        finish()
      }
      device.oninputreport = (event) => {
        propertyEvent = toReport(event)
        finish()
      }
      device.addEventListener('inputreport', onInputReport)
      window.tests!.results[key] = pending.promise
    },
    { f: filter, key }
  )

  return () =>
    page.evaluate((key) => {
      const result = window.tests!.results[key] as Promise<ReportEvent>
      return result.finally(() => {
        delete window.tests!.results[key]
      })
    }, key)
}
