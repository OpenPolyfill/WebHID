import { test, expect } from '../helpers/browser.js'
import type { Frame, Page } from '@playwright/test'

async function frameWithId(page: Page, id: string, urlSubstring: string): Promise<Frame> {
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          if (!frame.url().includes(urlSubstring)) continue
          const element = await frame.frameElement().catch(() => null)
          if (element && (await element.getAttribute('id')) === id) return true
        }
        return false
      },
      { timeout: 10000 }
    )
    .toBe(true)

  for (const frame of page.frames()) {
    if (!frame.url().includes(urlSubstring)) continue
    const element = await frame.frameElement().catch(() => null)
    if (element && (await element.getAttribute('id')) === id) return frame
  }
  throw new Error(`Frame #${id} not found`)
}

test.describe('OpenPolyfill permissions policy internals', () => {
  test('background preserves distinct opaque settings targets', async ({
    page,
    pageUrl,
    crossUrl,
    backgroundPage
  }) => {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate(
      ({ mainSrc, crossSrc }) => {
        for (const [id, src] of [
          ['opaque-a', mainSrc + '/iframe-child-no-allow?path=a'],
          ['opaque-b', crossSrc + '/iframe-child-no-allow?path=b'],
          ['opaque-c', mainSrc + '/iframe-child-no-allow?path=c']
        ]) {
          const frame = document.createElement('iframe')
          frame.id = id
          frame.setAttribute('sandbox', 'allow-scripts')
          frame.src = src
          document.body.appendChild(frame)
        }
      },
      { mainSrc: pageUrl(''), crossSrc: crossUrl('') }
    )
    await frameWithId(page, 'opaque-a', '/iframe-child-no-allow')
    await frameWithId(page, 'opaque-b', '/iframe-child-no-allow')
    await frameWithId(page, 'opaque-c', '/iframe-child-no-allow')
    const targets = (await backgroundPage.evaluate(async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true })
      const tab = tabs[0]
      if (!tab || tab.id == null) return []
      const raw: unknown = await browser.tabs.sendMessage(tab.id, { action: 'getFrameOrigins' })
      const response = raw as {
        targets?: Array<{ kind: string; persistentOrigin: string | null }>
      }
      return response.targets || []
    })) as Array<{ kind: string; persistentOrigin: string | null }>
    const opaqueTargets = targets.filter((target) => target.kind === 'opaque')
    expect(opaqueTargets).toHaveLength(2)
    expect(opaqueTargets[0].persistentOrigin).not.toBe(opaqueTargets[1].persistentOrigin)
    const scopeA = opaqueTargets[0].persistentOrigin
    const scopeB = opaqueTargets[1].persistentOrigin
    if (typeof scopeA !== 'string' || typeof scopeB !== 'string')
      throw new Error('opaque target has no persistent scope')
    const delivered = await backgroundPage.evaluate(
      ({ scopeA, scopeB }) => {
        const fanout = (
          globalThis as unknown as {
            webhid: {
              import(name: string): {
                postToPersistentOriginEndpoints(scope: string, message: object): number
              }
            }
          }
        ).webhid.import('backgroundEventFanout')
        const send = (scope: string) =>
          fanout.postToPersistentOriginEndpoints(scope, {
            action: 'allowedDevicesChanged',
            origin: 'null',
            persistentOrigin: scope,
            deviceIds: []
          })
        return { scopeA: send(scopeA), scopeB: send(scopeB) }
      },
      { scopeA, scopeB }
    )
    expect(delivered).toEqual({ scopeA: 2, scopeB: 1 })
  })

  test('top navigation retires old opaque persistence authorities', async ({
    page,
    pageUrl,
    crossUrl,
    backgroundPage
  }) => {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((src) => {
      const frame = document.createElement('iframe')
      frame.id = 'old-opaque'
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.src = src
      document.body.appendChild(frame)
    }, pageUrl('/iframe-child-no-allow'))
    await frameWithId(page, 'old-opaque', '/iframe-child-no-allow')
    await page.goto(crossUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((src) => {
      const frame = document.createElement('iframe')
      frame.id = 'new-opaque'
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.src = src
      document.body.appendChild(frame)
    }, pageUrl('/iframe-child-no-allow'))
    await frameWithId(page, 'new-opaque', '/iframe-child-no-allow')
    const targets = (await backgroundPage.evaluate(async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true })
      const tab = tabs[0]
      if (!tab || tab.id == null) return []
      const raw: unknown = await browser.tabs.sendMessage(tab.id, { action: 'getFrameOrigins' })
      return (
        (raw as { targets?: Array<{ kind: string; persistentOrigin: string | null }> }).targets ||
        []
      )
    })) as Array<{ kind: string; persistentOrigin: string | null }>
    const opaque = targets.filter((target) => target.kind === 'opaque')
    expect(opaque).toHaveLength(1)
    expect(opaque[0].persistentOrigin).toBe(
      `opaque|${new URL(crossUrl('')).origin}|${new URL(pageUrl('')).origin}`
    )
  })

  test('cross-origin iframe worker cannot bypass policy without delegation', async ({
    page,
    pageUrl,
    crossUrl,
    backgroundPage
  }) => {
    const settingKey = `settings :: ${new URL(crossUrl('')).origin} :: workerPolyfillEnabled`
    const previous = await backgroundPage.evaluate(async (key) => {
      const values = (await browser.storage.local.get(key)) as Record<string, unknown>
      return {
        exists: Object.prototype.hasOwnProperty.call(values, key),
        value: values[key] as boolean | undefined
      }
    }, settingKey)

    try {
      await backgroundPage.evaluate(
        ({ key, value }) => browser.storage.local.set({ [key]: value }),
        { key: settingKey, value: true }
      )
      await page.goto(pageUrl('/iframe-parent'), {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      })
      await page.evaluate((src) => {
        const iframe = document.createElement('iframe')
        iframe.id = 'policy-worker'
        iframe.src = src + '/iframe-worker-policy'
        document.body.appendChild(iframe)
      }, crossUrl(''))
      const childFrame = await frameWithId(page, 'policy-worker', '/iframe-worker-policy')
      await childFrame.waitForFunction(
        () => {
          const result = (window as unknown as { tests?: { results?: Record<string, unknown> } })
            .tests?.results?.workerPolicy
          return result !== null && typeof result === 'object'
        },
        { timeout: 15000 }
      )
      const result = await childFrame.evaluate<{
        queryHid?: string
        getDevices?: { ok: boolean; name?: string }
        error?: string
      } | null>(() => {
        const result = (window as unknown as { tests?: { results?: Record<string, unknown> } })
          .tests?.results?.workerPolicy
        return result && typeof result === 'object' ? result : null
      })
      expect(result).not.toBeNull()
      expect(result!.error).toBeUndefined()
      expect(result!.queryHid).toBe('denied')
      expect(result!.getDevices).toEqual(
        expect.objectContaining({ ok: false, name: 'SecurityError' })
      )
    } finally {
      await backgroundPage.evaluate(
        ({ key, previous }) => {
          if (previous.exists) return browser.storage.local.set({ [key]: previous.value })
          return browser.storage.local.remove(key)
        },
        { key: settingKey, previous }
      )
    }
  })

  test('hostile frame cannot forge sibling delegation through Error.stack', async ({
    page,
    pageUrl,
    crossUrl
  }) => {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((origin) => {
      const frame = document.createElement('iframe')
      frame.id = 'forge'
      frame.src = origin + '/iframe-child-forge'
      document.body.appendChild(frame)
    }, crossUrl(''))
    const frame = await frameWithId(page, 'forge', '/iframe-child-forge')
    const result = await frame.evaluate<{
      isCrossOrigin: boolean
      hidUndefined: boolean
      getDevices?: { ok: boolean; name?: string }
    } | null>(() => {
      const value = (window as unknown as { tests?: { results?: Record<string, unknown> } }).tests
        ?.results?.perm
      return value && typeof value === 'object'
        ? (value as {
            isCrossOrigin: boolean
            hidUndefined: boolean
            getDevices?: { ok: boolean; name?: string }
          })
        : null
    })

    expect(result).not.toBeNull()
    expect(result!.isCrossOrigin).toBe(true)
    expect(result!.hidUndefined).toBe(false)
    expect(result!.getDevices).toEqual(
      expect.objectContaining({ ok: false, name: 'SecurityError' })
    )
  })
})
