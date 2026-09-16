import { test, expect } from '../helpers/e2e.js'

test.describe.serial('Same-origin iframe mux transport', () => {
  test('child frame adopts the mux port and its HID calls complete', async ({
    sharedPage,
    backgroundPage,
    httpPort
  }) => {
    test.setTimeout(60000)
    const origin = `http://localhost:${httpPort}`
    const logKey = `settings :: ${origin} :: logLevel`
    const previous = await backgroundPage.evaluate(
      (key) => browser.storage.local.get(key),
      logKey
    )
    const consoleLines: string[] = []
    const onConsole = (message: { text(): string }) => {
      const text = message.text()
      if (text.includes('webhid')) consoleLines.push(text)
    }
    sharedPage.on('console', onConsole)
    try {
      await backgroundPage.evaluate(
        ({ key }) => browser.storage.local.set({ [key]: 3 }),
        { key: logKey }
      )
      await sharedPage.goto(`${origin}/tests/pages/mux-transport.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      const child = sharedPage.frames().find((frame) => frame !== sharedPage.mainFrame())
      expect(child).toBeTruthy()
      await child!.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
        timeout: 15000
      })
      const result = await child!.evaluate(async () => {
        try {
          const devices = await navigator.hid.getDevices()
          return { getDevicesResolved: true, deviceCount: devices.length, error: null }
        } catch (e) {
          return { getDevicesResolved: false, deviceCount: 0, error: String(e) }
        }
      })
      expect(result.getDevicesResolved, `child getDevices must resolve through the mux: ${result.error}`).toBe(true)
      expect(result.error).toBe(null)
      await expect
        .poll(
          () => consoleLines.some((line) => line.includes('fanout context adopted')),
          { timeout: 10000 }
        )
        .toBe(true)
    } finally {
      sharedPage.removeListener('console', onConsole)
      await backgroundPage.evaluate(
        ({ key, stored }) => {
          const missing = [key].filter((name) => !(name in stored))
          return browser.storage.local.remove(missing).then(() => browser.storage.local.set(stored))
        },
        { key: logKey, stored: previous }
      )
      await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
    }
  })
})
