import { test, expect } from '../../helpers/e2e.js'
import { benchmarkLoss, printLossResults } from './loss-utils.js'
import { skipOnFallback } from '../benchmark-utils.js'

test('input-report loss benchmark ws @ 8000Hz', async ({
  page,
  extension,
  vendorDevice,
  httpPort,
  daemonMode,
  rdp
}) => {
  const result = await benchmarkLoss(
    { page, extension, vendorDevice, httpPort, daemonMode, rdp },
    'ws'
  )
  expect(result.runs.length).toBeGreaterThan(0)
  printLossResults('ws', result)
  skipOnFallback(result, 'ws')
})
