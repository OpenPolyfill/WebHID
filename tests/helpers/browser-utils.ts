import type { Page } from '@playwright/test'

export async function navigateToPolicyCheck(
  page: Page,
  pageUrl: (path: string) => string
): Promise<void> {
  await page.goto(pageUrl('/policy-check'), {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
}

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
    { timeout }
  )
  return getPermResult(page)
}
