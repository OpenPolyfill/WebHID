import { test, expect } from '../../helpers/e2e.js'
import { benchmarkLoss, printLossResults } from './loss-utils.js'
import { skipOnFallback } from '../benchmark-utils.js'

test('input-report loss benchmark nm @ 8000Hz', async ({
  page,
  extension,
  vendorDevice,
  httpOrigin,
  daemonMode,
  rdp
}) => {
  const result = await benchmarkLoss(
    { page, extension, vendorDevice, httpOrigin, daemonMode, rdp },
    'nm'
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printLossResults('nm', result)
  skipOnFallback(result, 'nm')
})
