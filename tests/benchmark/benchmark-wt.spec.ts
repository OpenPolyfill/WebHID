import { test, expect } from '../helpers/e2e.js'
import { benchmarkMode, printResults, skipOnFallback } from './benchmark-utils.js'

test('image pipeline benchmark wt', async ({
  page,
  extension,
  vendorDevice,
  httpOrigin,
  daemonMode,
  rdp
}) => {
  const result = await benchmarkMode(
    { page, extension, vendorDevice, httpOrigin, daemonMode, rdp },
    'wt'
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printResults('wt', result)
  skipOnFallback(result, 'wt')
})
