import type { WorkerFixture } from '@playwright/test'
import { test as base, expect } from '@playwright/test'
import { withSharedPage } from '@openpolyfill/firefox-addon-playwright-harness/fixtures'
import type { FirefoxExtension } from '@openpolyfill/firefox-addon-playwright-harness'
import { rm } from 'node:fs/promises'
import { startStaticServer } from '../serve.js'
import {
  startDaemon,
  stopDaemon,
  startWebhidMock,
  stopWebhidMock,
  workerSocketPath,
  type DaemonProcess,
  type WebhidMockProcess
} from './e2e-process.js'
import { DEVICES, type DeviceKey } from './e2e-devices.js'
import { createHarnessFixtures } from './harness.js'

interface E2eTestFixtures {
  e2eSetup: void
}

interface E2eWorkerFixtures {
  daemon: DaemonProcess | null
  vendorDevice: MockDeviceFixture
  httpPort: number
  daemonMode: string
}

interface MockDeviceFixture {
  process: WebhidMockProcess['process']
  ready: Promise<void>
  vid: number
  pid: number
}

/** Configures the addon to spawn the daemon as its NM host when running in
 * daemon-nm mode (no-op in forwarder mode). */
export async function configureDaemonMode(
  extension: FirefoxExtension,
  daemonMode: string
): Promise<void> {
  if (daemonMode !== 'daemon-nm') return
  await extension.background!.evaluate(() =>
    browser.storage.local.set({ 'settings :: daemonAsNmHost': true })
  )
}

function deviceFixture(
  key: DeviceKey
): Record<string, [WorkerFixture<MockDeviceFixture, object>, { scope: 'worker' }]> {
  const def = DEVICES[key]
  return {
    [`${key}Device`]: [
      async ({}, use) => {
        const mock = startWebhidMock(def.descriptor, def.vid, def.pid, def.name)
        await mock.ready
        const live: MockDeviceFixture = {
          process: mock.process,
          ready: mock.ready,
          vid: def.vid,
          pid: def.pid
        }
        await use(live)
        stopWebhidMock({ process: live.process, ready: live.ready })
      },
      { scope: 'worker' as const }
    ]
  }
}

const deviceFixtures = {
  ...deviceFixture('vendor')
}

const defaultHarnessTest = createHarnessFixtures(base)

function extendE2eFixtures(testBase: typeof defaultHarnessTest) {
  const e2eTest = testBase.extend<E2eTestFixtures, E2eWorkerFixtures>({
    e2eSetup: [
      async ({ page, extension, httpPort, daemonMode }, use) => {
        await configureDaemonMode(extension, daemonMode)
        const url = `http://localhost:${httpPort}/tests/test-page.html`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
        await page.waitForFunction(() => typeof navigator.hid !== 'undefined', {
          timeout: 15000
        })
        await use()
      },
      { auto: true }
    ],
    daemonMode: [
      async ({}, use, workerInfo) => {
        const projectUse = workerInfo.project.use as { daemonMode?: string } | undefined
        const mode = projectUse?.daemonMode || 'forwarder'
        await use(mode)
      },
      { scope: 'worker', option: true }
    ],
    daemon: [
      async ({ daemonMode }, use, workerInfo) => {
        if (daemonMode === 'daemon-nm') {
          await use(null)
          return
        }
        const socketPath = workerSocketPath(workerInfo.workerIndex)
        process.env.WEBHID_SOCKET = socketPath
        const daemon = await startDaemon(socketPath)
        await use(daemon)
        stopDaemon(daemon)
        await rm(socketPath, { force: true })
      },
      { scope: 'worker', auto: true }
    ],
    ...deviceFixtures,
    httpPort: [
      async ({}, use) => {
        const { port, server } = await startStaticServer()
        await use(port)
        server.close()
      },
      { scope: 'worker', auto: true }
    ],
  })

  return e2eTest
}

export const test = extendE2eFixtures(defaultHarnessTest)
export const workerBase = extendE2eFixtures(createHarnessFixtures(base, 'worker'))
export { expect, withSharedPage }
