import { test, expect } from '../../helpers/browser.js'
import type { Page } from '@playwright/test'
import { getWebHidExtension } from '../../helpers/harness.js'

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
}

async function runWptPage(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  await page.waitForFunction(() => window.tests?.results.wpt !== undefined, null, {
    timeout: 90000
  })

  const result = await page.evaluate(() => window.tests!.results.wpt as WptRunResult)
  expect(result.tests.length, 'WPT page should report at least one test').toBeGreaterThan(0)
  expect(result.harnessStatus, result.harnessMessage ?? 'WPT harness failed').toBe(0)
  expect(
    result.tests.filter((wptTest) => wptTest.status !== 0),
    JSON.stringify(result.tests, null, 2)
  ).toEqual([])
}

const wptCases = [
  {
    name: 'WPT WebHID Permissions Policy header',
    path: '/webhid/hid-allowed-by-permissions-policy.https.sub.html'
  },
  {
    name: 'WPT WebHID Permissions Policy allow attribute',
    path: '/webhid/hid-allowed-by-permissions-policy-attribute.https.sub.html'
  },
  {
    name: 'WPT WebHID Permissions Policy after redirect',
    path: '/webhid/hid-allowed-by-permissions-policy-attribute-redirect-on-load.https.sub.html'
  }
] as const

test('WPT WebHID Permissions Policy cases', async ({ extensions, page, wptUrl }) => {
  const extension = getWebHidExtension(extensions)
  const previousWorkerSetting = await extension.background!.evaluate<{
    exists: boolean
    value: boolean | undefined
  }>(
    async (key: string) => {
      const values = (await browser.storage.local.get(key)) as Record<string, boolean | undefined>
      return {
        exists: Object.prototype.hasOwnProperty.call(values, key),
        value: values[key]
      }
    },
    [WORKER_SETTING]
  )

  try {
    await extension.background!.evaluate((key) => browser.storage.local.set({ [key]: true }), [WORKER_SETTING])
    await page.context().addInitScript(() => {
      if (window !== window.top) return
      const currentWindow = window as WptWindow
      currentWindow.tests = currentWindow.tests || { helper: {}, results: {} }
      const installCompletionCallback = () => {
        if (typeof currentWindow.add_completion_callback === 'function') {
          currentWindow.add_completion_callback((tests, status) => {
            currentWindow.tests!.results.wpt = {
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

    const context = page.context()
    const failures: string[] = []
    for (const { name, path } of wptCases) {
      try {
        await test.step(name, async () => {
          const wptPage = await context.newPage()
          try {
            await runWptPage(wptPage, wptUrl(path))
          } finally {
            await wptPage.close()
          }
        })
      } catch (error) {
        failures.push(`${name}: ${String(error)}`)
      }
    }
    expect(failures).toEqual([])
  } finally {
    await extension.background!.evaluate(
      ({ key, previous }: {
        key: string
        previous: { exists: boolean; value: boolean | undefined }
      }) =>
        previous.exists
          ? browser.storage.local.set({ [key]: previous.value })
          : browser.storage.local.remove(key),
      [{ key: WORKER_SETTING, previous: previousWorkerSetting }]
    )
  }
})
