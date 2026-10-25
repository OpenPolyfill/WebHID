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
  pageUrl: (path: string) => string
  crossUrl: (path: string) => string
  wptUrl: (path: string) => string
}

export const test = createHarnessFixtures(base).extend<BrowserTestFixtures, BrowserWorkerFixtures>({
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
    async ({ extensions, page, context, pageUrl }, use) => {
      await configureDaemonMode(getWebHidExtension(extensions), 'daemon-nm')
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
      await use()
    },
    { auto: true }
  ],
  workerHidPage: async ({ extensions, page, pageUrl }, use) => {
    const extension = getWebHidExtension(extensions)
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
