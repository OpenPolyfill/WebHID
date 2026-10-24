import { test, expect } from '../helpers/e2e.js'
import { benchmarkMode, printResults, skipOnFallback } from './benchmark-utils.js'

test('image pipeline benchmark nm', async ({
  page,
  extension,
  vendorDevice,
  httpOrigin,
  daemonMode,
  rdp
}) => {
  const result = await benchmarkMode(
    { page, extension, vendorDevice, httpOrigin, daemonMode, rdp },
    'nm'
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printResults('nm', result)
  skipOnFallback(result, 'nm')
})
