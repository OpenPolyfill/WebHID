import { test as base, expect, type Page } from '@playwright/test'
import {
  CROSS_POLICY_ORIGIN,
  fulfillPolicyRoute,
  fulfillWptRoute,
  POLICY_ORIGIN,
  POLICY_ROUTE_PATHS,
  WPT_CROSS_ORIGIN,
  WPT_ORIGIN,
  WPT_ROUTE_PATHS
} from '../serve.js'
import { waitForPermResult } from './browser-utils.js'
import { configureDaemonMode, createHarnessFixtures, getWebHidExtension } from './harness.js'

interface BrowserTestFixtures {
  browserSetup: void
  workerHidPage: Page
}

interface BrowserWorkerFixtures {
  workerPolyfillEnabled: boolean
  pageUrl: (path: string) => string
  crossUrl: (path: string) => string
  wptUrl: (path: string) => string
}

export const test = createHarnessFixtures(base).extend<BrowserTestFixtures, BrowserWorkerFixtures>({
  workerPolyfillEnabled: [false, { scope: 'worker', option: true }],
  pageUrl: [
    async ({}, use) => {
      await use((path: string) => `${POLICY_ORIGIN}${path}`)
    },
    { scope: 'worker' }
  ],
  crossUrl: [
    async ({}, use) => {
      await use((path: string) => `${CROSS_POLICY_ORIGIN}${path}`)
    },
    { scope: 'worker' }
  ],
  wptUrl: [
    async ({}, use) => {
      await use((path: string) => `${WPT_ORIGIN}${path}`)
    },
    { scope: 'worker' }
  ],
  browserSetup: [
    async ({ extensions, page, context, pageUrl, workerPolyfillEnabled }, use) => {
      const extension = getWebHidExtension(extensions)
      await configureDaemonMode(extension, 'daemon-nm')
      await context.route(
        (url) =>
          (url.origin === POLICY_ORIGIN || url.origin === CROSS_POLICY_ORIGIN) &&
          POLICY_ROUTE_PATHS.includes(url.pathname),
        fulfillPolicyRoute
      )
      await context.route(
        (url) =>
          (url.origin === WPT_ORIGIN || url.origin === WPT_CROSS_ORIGIN) &&
          WPT_ROUTE_PATHS.includes(url.pathname),
        fulfillWptRoute
      )
      await page.goto(pageUrl('/policy-check'), {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      await page.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
        timeout: 15000
      })
      await waitForPermResult(page)
      if (workerPolyfillEnabled) {
        const settingKey = 'settings :: workerPolyfillEnabled'
        await extension.background!.evaluate(
          async (key: string) => {
            const stored = (await browser.storage.local.get(key)) as Record<string, unknown>
            const waitForValue = (value: boolean) =>
              new Promise<void>((resolve, reject) => {
                const onChanged = (
                  changes: Record<string, { newValue?: unknown }>,
                  area: string
                ) => {
                  if (area !== 'local' || changes[key]?.newValue !== value) return
                  browser.storage.onChanged.removeListener(onChanged)
                  resolve()
                }
                browser.storage.onChanged.addListener(onChanged)
                browser.storage.local.set({ [key]: value }).catch((error: unknown) => {
                  browser.storage.onChanged.removeListener(onChanged)
                  reject(error instanceof Error ? error : new Error(String(error)))
                })
              })
            if (stored[key] === true) await waitForValue(false)
            await waitForValue(true)
          },
          [settingKey]
        )
      }
      await use()
    },
    { auto: true }
  ],
  workerHidPage: async ({ extensions, page, pageUrl }, use) => {
    const extension = getWebHidExtension(extensions)
    const key = `settings :: ${new URL(pageUrl('')).origin} :: workerPolyfillEnabled`
    await extension.background!.evaluate(
      (settingKey) => browser.storage.local.set({ [settingKey]: true }),
      [key]
    )
    await use(page)
  }
})

export { expect }
