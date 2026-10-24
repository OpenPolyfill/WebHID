import { test, expect } from '../helpers/e2e.js'
import { benchmarkMode, printResults, skipOnFallback } from './benchmark-utils.js'

test('image pipeline benchmark ws', async ({
  page,
  extension,
  vendorDevice,
  httpOrigin,
  daemonMode,
  rdp
}) => {
  const result = await benchmarkMode(
    { page, extension, vendorDevice, httpOrigin, daemonMode, rdp },
    'ws'
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printResults('ws', result)
  skipOnFallback(result, 'ws')
})
