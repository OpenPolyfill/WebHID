import { test, expect } from '../../helpers/e2e.js'
import { benchmarkLoss, printLossResults } from './loss-utils.js'
import { skipOnFallback } from '../benchmark-utils.js'

test('input-report loss benchmark wt @ 8000Hz', async ({
  page,
  extensions,
  vendorDevice,
  httpOrigin,
  rdp
}) => {
  const result = await benchmarkLoss({ page, extensions, vendorDevice, httpOrigin, rdp }, 'wt')
  expect(result.runs.length).toBeGreaterThan(0)
  printLossResults('wt', result)
  skipOnFallback(result, 'wt')
})
