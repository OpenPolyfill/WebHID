import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Route } from '@playwright/test'

const directoryPath = dirname(fileURLToPath(import.meta.url))
const pagesRoot = resolve(directoryPath, 'pages')
const projectRoot = resolve(directoryPath, '..')
const wptSiteRoot = resolve(directoryPath, 'conformance/wpt/site')
const wptSupportRoot = resolve(directoryPath, 'conformance/wpt/support')

export const WEBHID_ORIGIN = 'https://webhid.localhost'
export const POLICY_ORIGIN = 'https://same-origin.localhost'
export const CROSS_POLICY_ORIGIN = 'https://cross-origin.localhost'
export const WPT_ORIGIN = 'https://wpt.localhost'
export const WPT_CROSS_ORIGIN = 'https://www.wpt.localhost'

export const LOCAL_MAPPINGS = {
  'webhid.localhost': projectRoot,
  'same-origin.localhost': pagesRoot,
  'cross-origin.localhost': pagesRoot,
  'wpt.localhost': wptSiteRoot,
  'www.wpt.localhost': wptSiteRoot
}
export const PROJECT_ROUTE_PATHS = [
  '/tests/test-page.html',
  '/tests/pages/benchmark-image.html',
  '/tests/pages/nm-report-reqid.html',
  '/tests/pages/input-report-fanout.html',
  '/tests/pages/policy-check.html',
  '/tests/pages/iframe-child-forge.html',
  '/tests/pages/iframe-child.html',
  '/tests/pages/nm-report-reqid-frame.html',
  '/tests/pages/input-report-fanout-frame.html',
  '/tests/pages/iframe-worker-policy.html',
  '/tests/pages/iframe-parent.html'
]


const policyPageFiles: Record<string, string> = {
  '/policy-check': 'policy-check.html',
  '/policy-check-blocked': 'policy-check.html',
  '/iframe-parent': 'iframe-parent.html',
  '/iframe-parent-blocked': 'iframe-parent.html',
  '/iframe-child-no-allow': 'iframe-child.html',
  '/iframe-child-with-allow': 'iframe-child.html',
  '/iframe-worker-policy': 'iframe-worker-policy.html',
  '/iframe-child-forge': 'iframe-child-forge.html',
}
export const POLICY_ROUTE_PATHS = Object.keys(policyPageFiles)

const policyHeaders: Record<string, Record<string, string>> = {
  '/policy-check-blocked': { 'permissions-policy': 'hid=()' },
  '/iframe-parent-blocked': { 'permissions-policy': 'hid=()' }
}

const wptSupportFiles: Record<string, string> = {
  '/resources/testharness.js': 'testharness.js',
  '/permissions-policy/resources/permissions-policy.js': 'permissions-policy.js',
  '/permissions-policy/resources/permissions-policy-hid.html': 'permissions-policy-hid.html',
  '/permissions-policy/resources/permissions-policy-hid-worker.html':
    'permissions-policy-hid-worker.html',
  '/permissions-policy/resources/permissions-policy-hid-worker.js':
    'permissions-policy-hid-worker.js',
  '/permissions-policy/resources/redirect-on-load.html': 'redirect-on-load.html'
}
const wptTestFiles: Record<string, true> = {
  '/webhid/hid-allowed-by-permissions-policy.https.sub.html': true,
  '/webhid/hid-allowed-by-permissions-policy-attribute.https.sub.html': true,
  '/webhid/hid-allowed-by-permissions-policy-attribute-redirect-on-load.https.sub.html': true
}

export const WPT_ROUTE_PATHS = [
  '/resources/testharnessreport.js',
  ...Object.keys(wptSupportFiles),
  ...Object.keys(wptTestFiles)
]


const wptMime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.idl': 'text/plain'
}

function safePath(root: string, pathname: string): string | undefined {
  const filePath = resolve(root, pathname.slice(1))
  const relativePath = relative(root, filePath)
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined
  }
  return filePath
}

function parseWptHeaders(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of headerText.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator > 0) {
      headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
    }
  }
  return headers
}

function transformWptHtml(body: string, pathname: string): string {
  if (!pathname.endsWith('.sub.html')) return body
  return body.replaceAll(
    'https://{{domains[www]}}:{{ports[https][0]}}',
    WPT_CROSS_ORIGIN
  )
}

async function fulfillFile(
  route: Route,
  filePath: string,
  contentType: string,
  headers: Record<string, string> = {}
): Promise<void> {
  let body: Buffer
  try {
    body = await readFile(filePath)
  } catch {
    await route.continue()
    return
  }
  await route.fulfill({
    status: 200,
    headers: { 'content-type': contentType, ...headers },
    body
  })
}

export async function fulfillProjectRoute(route: Route): Promise<void> {
  if (route.request().resourceType() !== 'document') {
    await route.continue()
    return
  }
  const url = new URL(route.request().url())
  const headers: Record<string, string> = { 'cache-control': 'no-store' }
  if (url.pathname === '/tests/pages/benchmark-image.html') {
    headers['cross-origin-opener-policy'] = 'same-origin'
    headers['cross-origin-embedder-policy'] = 'require-corp'
  }
  const filePath = safePath(projectRoot, url.pathname)
  if (!filePath) {
    await route.continue()
    return
  }
  await fulfillFile(route, filePath, 'text/html', headers)
}

export async function fulfillPolicyRoute(route: Route): Promise<void> {
  if (route.request().resourceType() !== 'document') {
    await route.continue()
    return
  }
  const url = new URL(route.request().url())
  const fileName = policyPageFiles[url.pathname]
  if (!fileName) {
    await route.continue()
    return
  }
  await fulfillFile(route, resolve(pagesRoot, fileName), 'text/html', {
    'cache-control': 'no-store',
    ...policyHeaders[url.pathname]
  })
}

export async function fulfillWptRoute(route: Route): Promise<void> {
  const url = new URL(route.request().url())
  const pathname = decodeURIComponent(url.pathname)
  if (pathname === '/resources/testharnessreport.js') {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/javascript' },
      body: ''
    })
    return
  }
  if (!['document', 'script', 'worker'].includes(route.request().resourceType())) {
    await route.continue()
    return
  }

  const supportFile = wptSupportFiles[pathname]
  const filePath = supportFile
    ? resolve(wptSupportRoot, supportFile)
    : wptTestFiles[pathname]
      ? safePath(wptSiteRoot, pathname)
      : undefined
  if (!filePath) {
    await route.continue()
    return
  }

  let body: Buffer
  try {
    body = await readFile(filePath)
  } catch {
    await route.continue()
    return
  }

  let headers: Record<string, string> = {
    'cache-control': 'no-store',
    'content-type': wptMime[extname(filePath)] ?? 'application/octet-stream'
  }
  if (!supportFile) {
    try {
      headers = {
        ...headers,
        ...parseWptHeaders(await readFile(`${filePath}.headers`, 'utf8'))
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        await route.fulfill({ status: 500, body: 'Unable to read response headers' })
        return
      }
    }
  }

  const responseBody =
    extname(filePath) === '.html'
      ? transformWptHtml(body.toString('utf8'), pathname)
      : body
  await route.fulfill({ status: 200, headers, body: responseBody })
}
