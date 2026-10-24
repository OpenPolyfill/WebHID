import { test as base, expect, type Page } from '@playwright/test'
import { fulfillWptReportRoute, startTestServer, type ServerHandle } from '../serve.js'
import { createHarnessFixtures } from './harness.js'

interface BrowserTestFixtures {
  workerHidPage: Page
}

interface BrowserWorkerFixtures {
  testServer: ServerHandle
  pageUrl: (path: string) => string
  crossUrl: (path: string) => string
  wptUrl: (path: string) => string
}

export const test = createHarnessFixtures(base).extend<BrowserTestFixtures, BrowserWorkerFixtures>({
  testServer: [
    async ({}, use) => {
      const server = await startTestServer()
      await use(server)
      server.server.close()
    },
    { scope: 'worker', auto: true }
  ],
  pageUrl: [
    async ({ testServer }, use) => {
      await use((path: string) => `http://localhost:${testServer.port}${path}`)
    },
    { scope: 'worker' }
  ],
  crossUrl: [
    async ({ testServer }, use) => {
      await use((path: string) => `http://127.0.0.1:${testServer.port}${path}`)
    },
    { scope: 'worker' }
  ],
  wptUrl: [
    async ({ testServer }, use) => {
      await use((path: string) => `http://localhost:${testServer.port}${path}`)
    },
    { scope: 'worker' }
  ],
  page: async ({ page, context, pageUrl }, use) => {
    await context.route('**/resources/testharnessreport.js', fulfillWptReportRoute)
    await page.goto(pageUrl('/policy-check'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
      timeout: 15000
    })
    await use(page)
  },
  workerHidPage: async ({ extension, page, pageUrl }, use) => {
    const key = `settings :: ${new URL(pageUrl('')).origin} :: workerPolyfillEnabled`
    const previous = await extension.background!.evaluate<{
      exists: boolean
      value: boolean | undefined
    }>(
      async (settingKey: string) => {
        const values = (await browser.storage.local.get(settingKey)) as Record<string, unknown>
        return {
          exists: Object.prototype.hasOwnProperty.call(values, settingKey),
          value: values[settingKey] as boolean | undefined
        }
      },
      [key]
    )
    try {
      await extension.background!.evaluate(
        (settingKey) => browser.storage.local.set({ [settingKey]: true }),
        [key]
      )
      await page.goto(pageUrl('/policy-check'), {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      await use(page)
    } finally {
      await extension.background!.evaluate(
        ({
          settingKey,
          previous
        }: {
          settingKey: string
          previous: { exists: boolean; value: boolean | undefined }
        }) => {
          if (previous.exists) return browser.storage.local.set({ [settingKey]: previous.value })
          return browser.storage.local.remove(settingKey)
        },
        [{ settingKey: key, previous }]
      )
    }
  }
})

export { expect }
