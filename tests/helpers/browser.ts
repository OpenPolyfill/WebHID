import { test as base, expect, type Page } from '@playwright/test'
import { startPolicyServer, startWptServer } from '../serve.js'
import type { Server } from 'node:http'
import { createHarnessFixtures, defaultRouteHandler, getFirefoxBackgroundPage } from './harness.js'

type Servers = { main: { port: number; server: Server }; cross: { port: number; server: Server } }
type WptServer = { port: number; server: Server }

interface BrowserTestFixtures {
  workerHidPage: Page
}

interface BrowserWorkerFixtures {
  servers: Servers
  pageUrl: (path: string) => string
  crossUrl: (path: string) => string
  wptServer: WptServer
  wptUrl: (path: string) => string
}

export const test = createHarnessFixtures(base).extend<BrowserTestFixtures, BrowserWorkerFixtures>({
  servers: [
    async ({}, use) => {
      const main = await startPolicyServer()
      const cross = await startPolicyServer()
      await use({ main, cross })
      main.server.close()
      cross.server.close()
    },
    { scope: 'worker', auto: true }
  ],
  wptServer: [
    async ({}, use) => {
      const server = await startWptServer()
      await use(server)
      server.server.close()
    },
    { scope: 'worker' }
  ],
  wptUrl: [
    async ({ wptServer }, use) => {
      await use((path: string) => `http://localhost:${wptServer.port}${path}`)
    },
    { scope: 'worker' }
  ],
  page: async ({ page, context, pageUrl }, use) => {
    await context.route('**/*', defaultRouteHandler)
    await page.goto(pageUrl('/policy-check'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })
    await use(page)
  },
  workerHidPage: async ({ extension, page, pageUrl }, use) => {
    const backgroundPage = getFirefoxBackgroundPage(extension)
    const key = `settings :: ${new URL(pageUrl('')).origin} :: workerPolyfillEnabled`
    const previous = await backgroundPage.evaluate(async (settingKey) => {
      const values = (await browser.storage.local.get(settingKey)) as Record<string, unknown>
      return {
        exists: Object.prototype.hasOwnProperty.call(values, settingKey),
        value: values[settingKey] as boolean | undefined
      }
    }, key)
    try {
      await backgroundPage.evaluate(
        (settingKey) => browser.storage.local.set({ [settingKey]: true }),
        key
      )
      await page.goto(pageUrl('/policy-check'), {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      await use(page)
    } finally {
      await backgroundPage.evaluate(
        ({ settingKey, previous }) => {
          if (previous.exists) return browser.storage.local.set({ [settingKey]: previous.value })
          return browser.storage.local.remove(settingKey)
        },
        { settingKey: key, previous }
      )
    }
  },
  pageUrl: [
    async ({ servers }, use) => {
      await use((path: string) => `http://localhost:${servers.main.port}${path}`)
    },
    { scope: 'worker' }
  ],
  crossUrl: [
    async ({ servers }, use) => {
      await use((path: string) => `http://localhost:${servers.cross.port}${path}`)
    },
    { scope: 'worker' }
  ]
})

export { expect }
