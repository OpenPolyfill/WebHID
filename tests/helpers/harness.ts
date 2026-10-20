import {
  type BrowserContext,
  type Page,
  type TestFixture,
  type WorkerFixture
} from '@playwright/test'
import { launchFirefoxExtension } from '@openpolyfill/firefox-addon-playwright-harness'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

export interface FirefoxBgPage {
  evaluate: Page['evaluate']
}

export interface HarnessContext extends BrowserContext {
  _firefoxBgPage: FirefoxBgPage
  _rdpPort: number
}

export type RouteHandler = (route: { continue(): void }) => void

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const defaultRouteHandler: RouteHandler = (route) => {
  route.continue()
}

export const EXTENSION_PATH = process.env.EXTENSION_PATH
  ? resolve(process.env.EXTENSION_PATH)
  : resolve(__dirname, '..', '..', 'addon')

export interface HarnessCtxOptions {
  catchAllRoute?: boolean
  launchOptions?: object
}

/** Creates a Firefox context using the OpenPolyfill harness and exposes its background evaluator. */
export async function harnessCtxBody(
  args: { headless?: boolean },
  use: (ctx: HarnessContext) => Promise<void>,
  opts: HarnessCtxOptions = {}
): Promise<void> {
  const running = await launchFirefoxExtension({
    extensionPath: EXTENSION_PATH,
    headless: args.headless,
    firefoxUserPrefs: { 'network.lna.enabled': false },
    launchOptions: opts.launchOptions as Record<string, unknown> | undefined
  })

  try {
    const backgroundPage = running.extension.background
    if (!backgroundPage) throw new Error('Firefox extension has no background context')

    const context = running.context as HarnessContext
    context._firefoxBgPage = {
      evaluate: ((pageFunction: unknown, arg?: unknown) =>
        backgroundPage.evaluate(
          pageFunction as string | ((...args: unknown[]) => unknown),
          arg === undefined ? [] : [arg]
        )) as Page['evaluate']
    }
    context._rdpPort = running.rdpPort

    if (opts.catchAllRoute) await context.route('**/*', defaultRouteHandler)
    await use(context)
  } finally {
    await running.close()
  }
}

/** Returns the initial page or creates one in the harness context. */
export async function baseSharedPage(harnessCtx: HarnessContext): Promise<Page> {
  const blankPage = harnessCtx.pages().find((candidate) => candidate.url() === 'about:blank')
  return blankPage ?? (await harnessCtx.newPage())
}

export function rdpPortFixture(): [
  WorkerFixture<number, { harnessCtx: HarnessContext }>,
  { scope: 'worker' }
] {
  return [
    async ({ harnessCtx }, use) => {
      await use(harnessCtx._rdpPort)
    },
    { scope: 'worker' }
  ]
}

export function backgroundPageFixture(): [
  WorkerFixture<FirefoxBgPage, { harnessCtx: HarnessContext }>,
  { scope: 'worker' }
] {
  return [
    async ({ harnessCtx }, use) => {
      await use(harnessCtx._firefoxBgPage)
    },
    { scope: 'worker' }
  ]
}

export function pageFixture(): [
  TestFixture<Page, { harnessCtx: HarnessContext }>,
  { scope: 'test' }
] {
  return [
    async ({ harnessCtx }, use) => {
      const page = await harnessCtx.newPage()
      try {
        await use(page)
      } finally {
        await page.close().catch(() => {})
      }
    },
    { scope: 'test' }
  ]
}
