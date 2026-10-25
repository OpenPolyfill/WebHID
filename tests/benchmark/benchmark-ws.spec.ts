import { test, expect } from '../helpers/e2e.js'
import { benchmarkMode, printResults, skipOnFallback } from './benchmark-utils.js'

test('image pipeline benchmark ws', async ({
  page,
  extensions,
  vendorDevice,
  httpOrigin,
  rdp
}) => {
  const result = await benchmarkMode({ page, extensions, vendorDevice, httpOrigin, rdp }, 'ws')
  expect(result.runs.length).toBeGreaterThan(0)
  printResults('ws', result)
  skipOnFallback(result, 'ws')
})
