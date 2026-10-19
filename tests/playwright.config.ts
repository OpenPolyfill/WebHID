import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

type PlaywrightUseOptions = Exclude<Parameters<typeof defineConfig>[0], undefined>['use']

export default defineConfig({
  timeout: 120000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  globalSetup: 'firefox-webext-playwright-harness/globalSetup',
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'firefox-conformance-browser',
      testDir: './conformance/browser',
      use: { browserName: 'firefox' }
    },
    {
      name: 'firefox-conformance-e2e',
      testDir: './conformance/e2e',
      workers: 1,
      use: {
        browserName: 'firefox',
        firefoxHarnessConfig: {
          extensionPath: resolve(__dirname, '..', 'addon')
        },
        daemonMode: 'daemon-nm'
      } as PlaywrightUseOptions & {
        firefoxHarnessConfig: { extensionPath: string }
        daemonMode: string
      }
    },
    {
      name: 'firefox-regression-browser',
      testDir: './regression/browser',
      use: { browserName: 'firefox' }
    },
    {
      name: 'firefox-regression',
      testDir: './regression',
      testIgnore: ['**/*.browser.spec.ts'],
      workers: 1,
      use: {
        browserName: 'firefox',
        firefoxHarnessConfig: {
          extensionPath: resolve(__dirname, '..', 'addon')
        },
        daemonMode: 'daemon-nm'
      } as PlaywrightUseOptions & {
        firefoxHarnessConfig: { extensionPath: string }
        daemonMode: string
      }
    },
    {
      name: 'firefox-regression-forwarder',
      testDir: './regression',
      testMatch: ['**/nm-runtime-port.spec.ts', '**/transport-revoke.spec.ts'],
      workers: 1,
      use: {
        browserName: 'firefox',
        firefoxHarnessConfig: {
          extensionPath: resolve(__dirname, '..', 'addon')
        },
        daemonMode: 'forwarder'
      } as PlaywrightUseOptions & {
        firefoxHarnessConfig: { extensionPath: string }
        daemonMode: string
      }
    }
  ]
})
