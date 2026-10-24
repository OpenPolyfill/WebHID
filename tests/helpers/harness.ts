import type { Route, TestType } from '@playwright/test'
import { createFirefoxFixtures } from '@openpolyfill/firefox-addon-playwright-harness/fixtures'
import type {
  FirefoxHarnessConfig,
  FirefoxHarnessProjectOptions
} from '@openpolyfill/firefox-addon-playwright-harness'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCAL_MAPPINGS } from '../serve.js'

const directoryPath = dirname(fileURLToPath(import.meta.url))

export const EXTENSION_PATH = process.env.EXTENSION_PATH
  ? resolve(process.env.EXTENSION_PATH)
  : resolve(directoryPath, '..', '..', 'addon')
const EXTENSION_ID = 'webhid@k4zoku.dev'

export const defaultRouteHandler = (route: Route) => route.continue()

function createHarnessConfig(
  contextScope: NonNullable<FirefoxHarnessConfig['contextScope']>
): FirefoxHarnessConfig {
  return {
    extensionPath: EXTENSION_PATH,
    localMappings: LOCAL_MAPPINGS,
    nativeMessagingHosts: {
      'webhid.daemon_nm_host': {
        description: 'WebHID daemon-as-NM-host (e2e: debug daemon direct)',
        executable: resolve(directoryPath, '..', '..', 'crates', 'target', 'debug', 'webhid-daemon'),
        allowedExtensions: [EXTENSION_ID]
      },
      'webhid.forwarder_nm_host': {
        description: 'WebHID daemon native messaging host (e2e: debug forwarder)',
        executable: resolve(
          directoryPath,
          '..',
          '..',
          'crates',
          'target',
          'debug',
          'webhid-native-messaging'
        ),
        allowedExtensions: [EXTENSION_ID]
      }
    },
    firefoxUserPrefs: {
      'network.lna.enabled': false,
      'extensions.experiments.enabled': true
    },
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
