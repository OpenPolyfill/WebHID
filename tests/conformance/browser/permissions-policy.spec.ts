import { test, expect } from '../../helpers/browser.js'
import {
  frameWithId,
  waitForFrame,
  waitForPermResult,
  type PermResult
} from '../../helpers/browser-utils.js'
import type { Page, Frame } from '@playwright/test'
function expectHidAllowed(result: PermResult | null | undefined): void {
  expect(result).not.toBeNull()
  expect(result!.hidUndefined).toBe(false)
  expect(result!.getDevices).toEqual(expect.objectContaining({ ok: true }))
}

function expectHidBlocked(result: PermResult | null | undefined): void {
  expect(result).not.toBeNull()
  expect(result!.hidUndefined).toBe(false)
  expect(result!.getDevices).toEqual(expect.objectContaining({ ok: false, name: 'SecurityError' }))
}

async function readHidState(page: Page): Promise<PermResult> {
  return page.evaluate(async () => {
    const hidUndefined = typeof navigator.hid === 'undefined'
    try {
      const devices = await navigator.hid.getDevices()
      return { hidUndefined, getDevices: { ok: true, count: devices.length } }
    } catch (error) {
      return {
        hidUndefined,
        getDevices: {
          ok: false,
          name: error instanceof Error ? error.name : String(error)
        }
      }
    }
  })
}

test.describe('Permissions Policy', () => {
  test.describe.configure({ mode: 'parallel' })

  test('B33: no header allows same-origin', async ({ page }) => {
    const r = await waitForPermResult(page)
    expect(r).not.toBeNull()
    expect(r!.isTop).toBe(true)
    expect(r!.isCrossOrigin).toBe(false)
    expectHidAllowed(r)
  })

  test('B1/B3: hid=() blocks hid', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check-blocked'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    const r = await waitForPermResult(page)
    expect(r).not.toBeNull()
    expectHidBlocked(r)
  })
})

test('same-origin top-level documents have independent policies', async ({ page, pageUrl }) => {
  const sibling = await page.context().newPage()
  try {
    await sibling.goto(pageUrl('/policy-check-blocked'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    const top = await waitForPermResult(page)
    const blocked = await waitForPermResult(sibling)
    expectHidAllowed(top)
    expectHidBlocked(blocked)
  } finally {
    await sibling.close()
  }
})

test.describe('Cross-origin iframe', () => {
  async function readIframeResult(p: Page, urlSubstring: string) {
    const childFrame = await waitForFrame(p, urlSubstring)
    await childFrame.waitForFunction(
      () => {
        const r = (window as unknown as { tests?: { results?: Record<string, unknown> } }).tests
          ?.results?.perm
        return r !== null && typeof r === 'object'
      },
      undefined,
      { timeout: 10000 }
    )
    const raw = await childFrame.evaluate<PermResult | null>(() => {
      const r = (window as unknown as { tests?: { results?: Record<string, unknown> } }).tests
        ?.results?.perm
      return r && typeof r === 'object' ? r : null
    })
    return raw
  }
  async function readFrameResult(frame: Frame) {
    await expect
      .poll(
        () =>
          frame
            .evaluate(() => {
              const pageState = window as unknown as {
                tests?: { results?: Record<string, unknown> }
              }
              const result = pageState.tests?.results?.perm
              return result && typeof result === 'object' ? result : null
            })
            .catch(() => null),
        { timeout: 10000 }
      )
      .not.toBeNull()
    return frame.evaluate<PermResult | null>(() => {
      const pageState = window as unknown as {
        tests?: { results?: Record<string, unknown> }
      }
      const result = pageState.tests?.results?.perm
      return result && typeof result === 'object' ? result : null
    })
  }

  async function setupIframePair(
    page: Page,
    pageUrl: (path: string) => string,
    crossUrl: (path: string) => string
  ) {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((crossUrl) => {
      const noAllow = document.createElement('iframe')
      noAllow.id = 'no-allow'
      noAllow.src = crossUrl + '/iframe-child-no-allow'
      document.body.appendChild(noAllow)
      const withAllow = document.createElement('iframe')
      withAllow.id = 'with-allow'
      withAllow.src = crossUrl + '/iframe-child-with-allow'
      withAllow.allow = 'hid'
      document.body.appendChild(withAllow)
    }, crossUrl(''))
  }

  test('cross-origin delegation allows only the explicitly allowed iframe', async ({
    page,
    pageUrl,
    crossUrl
  }) => {
    await setupIframePair(page, pageUrl, crossUrl)
    const denied = await readIframeResult(page, '/iframe-child-no-allow')
    const allowed = await readIframeResult(page, '/iframe-child-with-allow')

    expect(denied).not.toBeNull()
    expect(denied!.isCrossOrigin).toBe(true)
    expectHidBlocked(denied)
    expect(allowed).not.toBeNull()
    expect(allowed!.isCrossOrigin).toBe(true)
    expectHidAllowed(allowed)
  })

  test('iframe hid allowlists are origin and document exact', async ({
    page,
    pageUrl,
    crossUrl
  }) => {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    expectHidAllowed(await readHidState(page))
    const checkFrame = async (id: string, src: string, allow: string, allowed: boolean) => {
      await page.evaluate(
        ({ id, src, allow }) => {
          const frame = document.createElement('iframe')
          frame.id = id
          frame.src = src
          frame.allow = allow
          document.body.appendChild(frame)
        },
        { id, src, allow }
      )
      const frame = await frameWithId(page, id, 'iframe-child')
      const result = await readFrameResult(frame)
      if (allowed) expectHidAllowed(result)
      else expectHidBlocked(result)
      return frame
    }
    await checkFrame('allow-none', crossUrl('/iframe-child-no-allow'), "hid 'none'", false)
    await checkFrame('allow-other', crossUrl('/iframe-child-no-allow'), `hid ${pageUrl('')}`, false)
    await checkFrame('allow-self', pageUrl('/iframe-child-no-allow'), "hid 'self'", true)
    const bare = await checkFrame('allow-bare', crossUrl('/iframe-child-no-allow'), 'hid', true)
    const sameOriginUrl = pageUrl('/iframe-child-no-allow')
    await bare.evaluate((url) => {
      window.location.href = url
    }, sameOriginUrl)
    const frameElement = page.locator('#allow-bare')
    await expect
      .poll(() =>
        frameElement.evaluate((element) => {
          try {
            return (element as HTMLIFrameElement).contentWindow?.location.href ?? null
          } catch {
            return null
          }
        })
      )
      .toBe(sameOriginUrl)
    const readResult = () =>
      frameElement.evaluate((element) => {
        const childWindow = (element as HTMLIFrameElement).contentWindow as Window & {
          tests?: { results?: Record<string, unknown> }
        }
        const result = childWindow.tests?.results?.perm
        return result && typeof result === 'object' ? result : null
      })
    await expect.poll(readResult).not.toBeNull()
    expectHidBlocked(await readResult())
  })

  test('sandboxed iframe keeps an opaque security origin', async ({ page, pageUrl, crossUrl }) => {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate(() => {
      document.documentElement.dataset.opaqueOrigin = ''
      window.addEventListener('message', (event) => {
        if (event.data === 'opaque-origin-probe')
          document.documentElement.dataset.opaqueOrigin = event.origin
      })
    })
    await page.evaluate((src) => {
      const frame = document.createElement('iframe')
      frame.id = 'opaque-sandbox'
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.src = src + '/iframe-child-no-allow'
      document.body.appendChild(frame)
    }, crossUrl(''))
    const frame = await frameWithId(page, 'opaque-sandbox', '/iframe-child-no-allow')
    await frame.evaluate(() => window.parent.postMessage('opaque-origin-probe', '*'))
    await expect.poll(() => page.locator('html').getAttribute('data-opaque-origin')).toBe('null')
    expectHidBlocked(await readFrameResult(frame))
  })

  test('B2: top-level hid=() denies a delegated cross-origin child', async ({
    page,
    pageUrl,
    crossUrl
  }) => {
    // Deny dominates: an allow="hid" attribute on the iframe cannot grant
    // what an ancestor's Permissions-Policy: hid=() already denied.
    await page.goto(pageUrl('/iframe-parent-blocked'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((crossUrl) => {
      const withAllow = document.createElement('iframe')
      withAllow.id = 'with-allow'
      withAllow.src = crossUrl + '/iframe-child-with-allow'
      withAllow.allow = 'hid'
      document.body.appendChild(withAllow)
    }, crossUrl(''))
    const raw = await readIframeResult(page, '/iframe-child-with-allow')
    expect(raw).not.toBeNull()
    expect(raw!.isCrossOrigin).toBe(true)
    expectHidBlocked(raw)
  })

  test('ancestor container denial cannot be re-enabled by descendants', async ({
    page,
    pageUrl,
    crossUrl
  }) => {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((src) => {
      for (const id of ['nested-denied-same', 'nested-denied-cross']) {
        const frame = document.createElement('iframe')
        frame.id = id
        frame.src = src
        document.body.appendChild(frame)
      }
    }, crossUrl('/iframe-child-no-allow'))
    const deniedSameParent = await frameWithId(page, 'nested-denied-same', 'iframe-child')
    const deniedCrossParent = await frameWithId(page, 'nested-denied-cross', 'iframe-child')
    await deniedSameParent.evaluate((src) => {
      const child = document.createElement('iframe')
      child.id = 'nested-denied-same-child'
      child.src = src
      child.allow = 'hid'
      document.body.appendChild(child)
    }, crossUrl('/iframe-child-no-allow'))
    await deniedCrossParent.evaluate((src) => {
      const child = document.createElement('iframe')
      child.id = 'nested-denied-cross-child'
      child.src = src
      child.allow = 'hid'
      document.body.appendChild(child)
    }, pageUrl('/iframe-child-no-allow'))
    expectHidBlocked(
      await readFrameResult(await frameWithId(page, 'nested-denied-same-child', 'iframe-child'))
    )
    expectHidBlocked(
      await readFrameResult(await frameWithId(page, 'nested-denied-cross-child', 'iframe-child'))
    )
  })

  test('delegation remains available through an allowed nested topology', async ({
    page,
    pageUrl,
    crossUrl
  }) => {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((src) => {
      const parent = document.createElement('iframe')
      parent.id = 'nested-allowed-parent'
      parent.src = src
      parent.allow = 'hid'
      document.body.appendChild(parent)
    }, crossUrl('/iframe-child-no-allow'))
    const parent = await frameWithId(page, 'nested-allowed-parent', 'iframe-child')
    await parent.evaluate((src) => {
      const child = document.createElement('iframe')
      child.id = 'nested-allowed-child'
      child.src = src
      child.allow = 'hid'
      document.body.appendChild(child)
    }, crossUrl('/iframe-child-no-allow'))
    expectHidAllowed(
      await readFrameResult(await frameWithId(page, 'nested-allowed-child', 'iframe-child'))
    )
  })

  test('same URL siblings keep independent iframe delegation', async ({
    page,
    pageUrl,
    crossUrl
  }) => {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((src) => {
      const allowed = document.createElement('iframe')
      allowed.id = 'same-url-allowed'
      allowed.src = src
      allowed.allow = 'hid'
      document.body.appendChild(allowed)
      const denied = document.createElement('iframe')
      denied.id = 'same-url-denied'
      denied.src = src
      document.body.appendChild(denied)
    }, crossUrl('/iframe-child-no-allow'))
    await expect
      .poll(() => page.frames().filter((f) => f.url().includes('/iframe-child-no-allow')).length)
      .toBe(2)
    const allowedFrame = await frameWithId(page, 'same-url-allowed', '/iframe-child-no-allow')
    const deniedFrame = await frameWithId(page, 'same-url-denied', '/iframe-child-no-allow')
    expectHidAllowed(await readFrameResult(allowedFrame))
    expectHidBlocked(await readFrameResult(deniedFrame))
  })

  test('recreated and navigated frames do not inherit delegation', async ({
    page,
    pageUrl,
    crossUrl
  }) => {
    await page.goto(pageUrl('/iframe-parent'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.evaluate((src) => {
      const frame = document.createElement('iframe')
      frame.id = 'recreated'
      frame.src = src
      frame.allow = 'hid'
      document.body.appendChild(frame)
    }, crossUrl('/iframe-child-no-allow'))
    await expect
      .poll(() => page.frames().filter((f) => f.url().includes('/iframe-child-no-allow')).length)
      .toBe(1)
    const initial = await frameWithId(page, 'recreated', '/iframe-child-no-allow')
    expectHidAllowed(await readFrameResult(initial))
    await page.evaluate((src) => {
      const frame = document.querySelector('#recreated')
      if (!(frame instanceof HTMLIFrameElement)) throw new Error('recreated frame missing')
      frame.allow = ''
      frame.src = src
    }, crossUrl('/iframe-child-no-allow?navigation=1'))
    await expect
      .poll(() => page.frames().filter((f) => f.url().includes('/iframe-child-no-allow')).length)
      .toBe(1)
    const navigated = await frameWithId(page, 'recreated', '/iframe-child-no-allow')
    await navigated.waitForURL(crossUrl('/iframe-child-no-allow?navigation=1'))
    expectHidBlocked(await readFrameResult(navigated))
    await page.evaluate((src) => {
      document.querySelector('#recreated')?.remove()
      const frame = document.createElement('iframe')
      frame.id = 'recreated'
      frame.src = src
      document.body.appendChild(frame)
    }, crossUrl('/iframe-child-no-allow?recreated=1'))
    await expect
      .poll(() => page.frames().filter((f) => f.url().includes('/iframe-child-no-allow')).length)
      .toBe(1)
    const recreated = await frameWithId(page, 'recreated', '/iframe-child-no-allow')
    await recreated.waitForURL(crossUrl('/iframe-child-no-allow?recreated=1'))
    expectHidBlocked(await readFrameResult(recreated))
  })
})
