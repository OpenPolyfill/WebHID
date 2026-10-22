import type { Page, Route, TestType } from '@playwright/test'
import { createFirefoxFixtures } from '@openpolyfill/firefox-addon-playwright-harness/fixtures'
import type {
  FirefoxExtension,
  FirefoxHarnessConfig,
  FirefoxHarnessProjectOptions
} from '@openpolyfill/firefox-addon-playwright-harness'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directoryPath = dirname(fileURLToPath(import.meta.url))

export const EXTENSION_PATH = process.env.EXTENSION_PATH
  ? resolve(process.env.EXTENSION_PATH)
  : resolve(directoryPath, '..', '..', 'addon')

export const defaultRouteHandler = (route: Route) => route.continue()
export type FirefoxBackgroundPage = Pick<Page, 'evaluate'>

export function getFirefoxBackgroundPage(extension: FirefoxExtension): FirefoxBackgroundPage {
  const backgroundPage = extension.background
  if (!backgroundPage) throw new Error('Firefox extension has no background context')
  const evaluate = (
    pageFunction: string | ((...args: unknown[]) => unknown),
    ...args: unknown[]
  ): Promise<unknown> => backgroundPage.evaluate(pageFunction, args)
  return { evaluate: evaluate as Page['evaluate'] }
}

function createHarnessConfig(
  contextScope: NonNullable<FirefoxHarnessConfig['contextScope']>
): FirefoxHarnessConfig {
  return {
    extensionPath: EXTENSION_PATH,
    firefoxUserPrefs: { 'network.lna.enabled': false },
    contextScope,
    resolveProjectOptions(projectUse) {
      const options: FirefoxHarnessProjectOptions = {}
      if (typeof projectUse.headless === 'boolean') options.headless = projectUse.headless
      const launchOptions = projectUse.launchOptions
      if (launchOptions !== null && typeof launchOptions === 'object') {
        options.launchOptions = launchOptions as Record<string, unknown>
      }
      return options
    }
  }
}

export function createHarnessFixtures<TTestArgs extends object, TWorkerArgs extends object>(
  test: TestType<TTestArgs, TWorkerArgs>,
  contextScope: NonNullable<FirefoxHarnessConfig['contextScope']> = 'test'
) {
  return createFirefoxFixtures(test, createHarnessConfig(contextScope))
}
