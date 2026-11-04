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

test('Terminating an unrelated dedicated Worker cleans up without a timeout warning', async ({
  workerHidPage
}) => {
  const warnings: string[] = []
  const onConsole = (message: { type: () => string; text: () => string }) => {
    if (
      message.type() === 'warning' &&
      message.text().includes('sendRequest timeout: workerClientDestroyed')
    ) {
      warnings.push(message.text())
    }
  }
  workerHidPage.on('console', onConsole)
  try {
    const result = await workerHidPage.evaluate(async () => {
      const worker = new Worker(`/plain-worker.js?_=${Date.now()}`)
      try {
        const { promise, resolve, reject } = Promise.withResolvers<{
          ready: boolean
          hasNavigatorHid: boolean
        }>()
        const timer = setTimeout(() => reject(new Error('plain worker did not respond')), 5000)
        worker.onmessage = (event: MessageEvent<{ ready: boolean; hasNavigatorHid: boolean }>) => {
          clearTimeout(timer)
          resolve(event.data)
        }
        worker.onerror = (event) => {
          clearTimeout(timer)
          reject(new Error(event.message))
        }
        return await promise
      } finally {
        worker.terminate()
      }
    })
    expect(result).toEqual({ ready: true, hasNavigatorHid: true })
    await workerHidPage.waitForTimeout(750)
    expect(warnings).toEqual([])
  } finally {
    workerHidPage.off('console', onConsole)
  }
})
