import { test, expect } from '../../helpers/browser.js'

interface WorkerResult {
  hasNavigatorHid: boolean
  hasHID: boolean
  hasHIDDevice: boolean
  hasHIDInputReportEvent: boolean
  hasHIDConnectionEvent: boolean
  hasRequestDevice: boolean
  workerNavigatorHidGetterError: string
  illegalConstructor: { ok: boolean; name?: string; message?: string }
}

test('Dedicated Worker exposes WebHID APIs without requestDevice', async ({ workerHidPage }) => {
  const raw = await workerHidPage.evaluate(() => {
    const { promise, resolve, reject } = Promise.withResolvers<WorkerResult>()
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
    return promise
  })

  expect(raw).toMatchObject({
    hasNavigatorHid: true,
    hasHID: true,
    hasHIDDevice: true,
    hasHIDInputReportEvent: true,
    hasHIDConnectionEvent: true,
    getDevicesResult: { ok: true },
    hasRequestDevice: false,
    workerNavigatorHidGetterError: 'TypeError',
    illegalConstructor: { ok: false, name: 'TypeError' }
  })
})
