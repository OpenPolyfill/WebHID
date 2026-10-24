import { expect, type Frame, type Page } from '@playwright/test'

export interface PermResult {
  isTop?: boolean
  isCrossOrigin?: boolean
  hidUndefined?: boolean
  getDevices?: { ok: boolean; count?: number; name?: string; message?: string }
}

async function getPermResult(page: Page): Promise<PermResult | null> {
  return page.evaluate((): PermResult | null => {
    const r = window.tests?.results.perm
    if (r && typeof r === 'object') return r
    return null
  })
}

export async function waitForPermResult(page: Page, timeout = 10000): Promise<PermResult | null> {
  await page.waitForFunction(
    (): boolean => {
      const r = window.tests?.results.perm
      return r !== null && typeof r === 'object'
    },
    undefined,
    { timeout }
  )
  return getPermResult(page)
}

async function findFrame(
  page: Page,
  urlSubstring: string,
  id: string | undefined,
  timeout: number
): Promise<Frame> {
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          if (!frame.url().includes(urlSubstring)) continue
          if (id === undefined) return true
          const element = await frame.frameElement().catch(() => null)
          if (element && (await element.getAttribute('id')) === id) return true
        }
        return false
      },
      { timeout }
    )
    .toBe(true)

  for (const frame of page.frames()) {
    if (!frame.url().includes(urlSubstring)) continue
    if (id === undefined) return frame
    const element = await frame.frameElement().catch(() => null)
    if (element && (await element.getAttribute('id')) === id) return frame
  }
  throw new Error(
    id ? `Frame #${id} not found` : `Frame with URL containing "${urlSubstring}" not found`
  )
}

export function waitForFrame(page: Page, urlSubstring: string, timeout = 10000): Promise<Frame> {
  return findFrame(page, urlSubstring, undefined, timeout)
}

export function frameWithId(
  page: Page,
  id: string,
  urlSubstring: string,
  timeout = 10000
): Promise<Frame> {
  return findFrame(page, urlSubstring, id, timeout)
}
