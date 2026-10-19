import { test, expect } from '../../helpers/browser.js'

interface WorkerResult {
  hasNavigatorHid: boolean
  hasHID: boolean
  hasHIDDevice: boolean
  hasHIDInputReportEvent: boolean
  hasHIDConnectionEvent: boolean
  getDevicesResult: { ok: boolean }
  requestDeviceError: { ok: boolean; name?: string; message?: string }
  illegalConstructor: { ok: boolean; name?: string; message?: string }
}

test('Dedicated Workers expose the supported WebHID API', async ({
  backgroundPage,
  sharedPage,
  pageUrl,
  servers
}) => {
  const origin = `http://localhost:${servers.main.port}`
  await backgroundPage.evaluate(
    (origin) =>
      browser.storage.local.set({
        [`settings :: ${origin} :: workerPolyfillEnabled`]: true
      }),
    origin
  )
  await sharedPage.goto(pageUrl('/policy-check'), {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })

  const raw = await sharedPage.evaluate(
    () =>
      new Promise<WorkerResult>((resolve, reject) => {
        const worker = new Worker(`/worker.js?_=${Date.now()}`)
        const timer = setTimeout(() => {
          worker.terminate()
          reject(new Error('worker WebHID response timed out'))
        }, 10000)
        worker.onmessage = (event: MessageEvent<WorkerResult>) => {
          clearTimeout(timer)
          worker.terminate()
          resolve(event.data)
        }
        worker.onerror = (event: ErrorEvent) => {
          clearTimeout(timer)
          worker.terminate()
          reject(new Error(event.message))
        }
      })
  )

  expect(raw).toMatchObject({
    hasNavigatorHid: true,
    hasHID: true,
    hasHIDDevice: true,
    hasHIDInputReportEvent: true,
    hasHIDConnectionEvent: true,
    getDevicesResult: { ok: true },
    requestDeviceError: { ok: false, name: 'NotSupportedError' },
    illegalConstructor: { ok: false, name: 'TypeError' }
  })
})
