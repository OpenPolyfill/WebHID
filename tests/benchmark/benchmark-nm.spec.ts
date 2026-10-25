import { test, expect } from '../helpers/e2e.js'
import { benchmarkMode, printResults, skipOnFallback } from './benchmark-utils.js'

test('image pipeline benchmark nm', async ({
  page,
  extensions,
  vendorDevice,
  httpOrigin,
  rdp
}) => {
  const result = await benchmarkMode({ page, extensions, vendorDevice, httpOrigin, rdp }, 'nm')
  expect(result.runs.length).toBeGreaterThan(0)
  printResults('nm', result)
  skipOnFallback(result, 'nm')
})
