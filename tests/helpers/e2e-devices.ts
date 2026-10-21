import { type Page } from '@playwright/test'
import type { DeviceFilter } from './e2e-types.js'

export const DEVICES = {
  vendor: { vid: 0x16c0, pid: 0x0001, descriptor: 'vendor.bin' }
} as const

export type DeviceKey = keyof typeof DEVICES

export function mockIdFor(which: DeviceKey): DeviceFilter {
  return { vendorId: DEVICES[which].vid, productId: DEVICES[which].pid }
}

declare global {
  interface Window {
    tests?: {
      helper?: {
        requestDevice?: (filters: DeviceFilter[]) => void
        requestDeviceResult?: () => Promise<number>
      }
      results?: Record<string, unknown>
    }
  }
}

export async function grantDevicePermission(page: Page, filters: DeviceFilter[]): Promise<number> {
  await page.evaluate(() => {
    const results = window.tests!.results!
    results.pickerStarted = new Promise<void>((resolve) => {
      const check = () => {
        if (document.querySelector('#webhid-shadow-host')?.getAttribute('aria-busy') !== 'true') {
          return false
        }
        observer.disconnect()
        resolve()
        return true
      }
      const observer = new MutationObserver(check)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['aria-busy'],
        childList: true,
        subtree: true
      })
      check()
    })
  })
  await page.evaluate((flt: DeviceFilter[]) => window.tests!.helper!.requestDevice!(flt), filters)
  await page.locator('#request-device-btn').click()
  const pickerStart = await page.evaluate(() => {
    const started = window.tests!.results!.pickerStarted as Promise<void>
    const request = window.tests!.helper!.requestDeviceResult!()
    return Promise.race([
      started.then(() => ({ state: 'opened' as const })),
      request.then(
        (count) => ({ state: 'settled' as const, count }),
        (error: unknown) => ({
          state: 'rejected' as const,
          error: error instanceof Error ? error.message : String(error)
        })
      )
    ])
  })
  if (pickerStart.state !== 'opened') {
    throw new Error(
      `grantDevicePermission: requestDevice did not open its chooser: ${JSON.stringify(pickerStart)}`
    )
  }
  await page.waitForFunction(
    () => document.querySelector('#webhid-shadow-host')?.getAttribute('aria-busy') === 'false',
    undefined,
    { timeout: 15000 }
  )
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')

  const count = await page.evaluate(() => window.tests!.helper!.requestDeviceResult!())
  if (count === 0) {
    throw new Error(
      'grantDevicePermission: requestDevice resolved with no devices. ' +
        'The chooser did not return a device matching the filter.'
    )
  }
  return count
}
