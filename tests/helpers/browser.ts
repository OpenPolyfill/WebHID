import { test as base, expect, type Page } from '@playwright/test'
import type {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions
} from '@playwright/test'
import { startPolicyServer, startWptServer } from '../serve.js'
import type { Server } from 'http'
import {
  backgroundPageFixture,
  baseSharedPage,
  harnessCtxBody,
  pageFixture,
  rdpPortFixture,
  type FirefoxBgPage,
  type HarnessContext
} from './harness.js'

type Servers = { main: { port: number; server: Server }; cross: { port: number; server: Server } }
type WptServer = { port: number; server: Server }

export const test = base.extend<
  PlaywrightTestArgs & PlaywrightTestOptions & { workerHidPage: Page },
  PlaywrightWorkerArgs &
    PlaywrightWorkerOptions & {
      servers: Servers
      pageUrl: (path: string) => string
      crossUrl: (path: string) => string
      wptServer: WptServer
      wptUrl: (path: string) => string
      harnessCtx: HarnessContext
      rdpPort: number
      backgroundPage: FirefoxBgPage
      sharedPage: Page
    }
>({
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

  rdpPort: rdpPortFixture(),

  harnessCtx: [
    async ({ headless }, use) => {
      await harnessCtxBody({ headless }, use, { catchAllRoute: true })
    },
    { scope: 'worker' }
  ],

  backgroundPage: backgroundPageFixture(),

  sharedPage: [
    async ({ harnessCtx }, use) => {
      await use(await baseSharedPage(harnessCtx))
    },
    { scope: 'worker' }
  ],
  workerHidPage: async ({ backgroundPage, sharedPage, pageUrl }, use) => {
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
      await sharedPage.goto(pageUrl('/policy-check'), {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      await use(sharedPage)
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

  page: pageFixture(),

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
