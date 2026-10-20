import { test, expect } from '../../helpers/browser.js'
import type { Page } from '@playwright/test'

const WPT_ORIGIN = 'https://wpt.live'
const WORKER_SETTING = 'settings :: workerPolyfillEnabled'

interface WptTestResult {
  name: string
  status: number
  message: string
}

interface WptRunResult {
  harnessStatus: number
  harnessMessage: string | null
  tests: WptTestResult[]
}

interface WptWindow extends Window {
  add_completion_callback?: (
    callback: (
      tests: Array<{ name: string; status: number; message: string }>,
      status: { status: number; message: string | null }
    ) => void
  ) => void
  __webhidWptResult?: WptRunResult
}

let previousWorkerSetting: { exists: boolean; value: boolean | undefined } | undefined

test.beforeAll(async ({ backgroundPage }) => {
  previousWorkerSetting = await backgroundPage.evaluate(async (key) => {
    const values = (await browser.storage.local.get(key)) as Record<string, boolean | undefined>
    return {
      exists: Object.prototype.hasOwnProperty.call(values, key),
      value: values[key]
    }
  }, WORKER_SETTING)
  await backgroundPage.evaluate((key) => browser.storage.local.set({ [key]: true }), WORKER_SETTING)
})

test.afterAll(async ({ backgroundPage }) => {
  if (!previousWorkerSetting) return
  await backgroundPage.evaluate(
    ({ key, previous }) =>
      previous.exists
        ? browser.storage.local.set({ [key]: previous.value })
        : browser.storage.local.remove(key),
    { key: WORKER_SETTING, previous: previousWorkerSetting }
  )
})

async function runWptPage(page: Page, path: string): Promise<void> {
  await page.addInitScript(() => {
    const currentWindow = window as WptWindow
    const installCompletionCallback = () => {
      if (typeof currentWindow.add_completion_callback === 'function') {
        currentWindow.add_completion_callback((tests, status) => {
          currentWindow.__webhidWptResult = {
            harnessStatus: status.status,
            harnessMessage: status.message,
            tests: tests.map((result) => ({
              name: result.name,
              status: result.status,
              message: result.message
            }))
          }
        })
        return
      }
      window.setTimeout(installCompletionCallback, 0)
    }
    installCompletionCallback()
  })

  await page.goto(`${WPT_ORIGIN}${path}`, { waitUntil: 'load', timeout: 30000 })
  await page.waitForFunction(
    () => (window as WptWindow).__webhidWptResult !== undefined,
    null,
    { timeout: 90000 }
  )

  const result = await page.evaluate(() => (window as WptWindow).__webhidWptResult!)
  expect(result.tests.length, 'WPT page should report at least one test').toBeGreaterThan(0)
  expect(result.harnessStatus, result.harnessMessage ?? 'WPT harness failed').toBe(0)
  expect(
    result.tests.filter((wptTest) => wptTest.status !== 0),
    JSON.stringify(result.tests, null, 2)
  ).toEqual([])
}

test('WPT WebHID Permissions Policy header', async ({ page }) => {
  await runWptPage(page, '/webhid/hid-allowed-by-permissions-policy.https.sub.html')
})

test('WPT WebHID Permissions Policy allow attribute', async ({ page }) => {
  await runWptPage(page, '/webhid/hid-allowed-by-permissions-policy-attribute.https.sub.html')
})

test('WPT WebHID Permissions Policy after redirect', async ({ page }) => {
  await runWptPage(
    page,
    '/webhid/hid-allowed-by-permissions-policy-attribute-redirect-on-load.https.sub.html'
  )
})
