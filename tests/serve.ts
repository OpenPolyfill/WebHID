import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import type { Route } from '@playwright/test'

const directoryPath = dirname(fileURLToPath(import.meta.url))
const pagesRoot = resolve(directoryPath, 'pages')
const projectRoot = resolve(directoryPath, '..')
const wptSiteRoot = resolve(directoryPath, 'conformance/wpt/site')
const wptSupportRoot = resolve(directoryPath, 'conformance/wpt/support')

export const WPT_SUPPORT_ORIGIN = 'https://wpt-support.localhost'

export const LOCAL_MAPPINGS = {
  'wpt-support.localhost': wptSupportRoot
}

export interface ServerHandle {
  port: number
  server: http.Server
}

const policyPageFiles: Record<string, string> = {
  '/policy-check': 'policy-check.html',
  '/policy-check-blocked': 'policy-check.html',
  '/iframe-parent': 'iframe-parent.html',
  '/iframe-parent-blocked': 'iframe-parent.html',
  '/iframe-child-no-allow': 'iframe-child.html',
  '/iframe-child-with-allow': 'iframe-child.html',
  '/iframe-worker-policy': 'iframe-worker-policy.html',
  '/worker-policy.js': 'worker-policy.js',
  '/iframe-child-forge': 'iframe-child-forge.html',
  '/worker.js': 'worker.js'
}

const policyHeaders: Record<string, Record<string, string>> = {
  '/policy-check-blocked': { 'Permissions-Policy': 'hid=()' },
  '/iframe-parent-blocked': { 'Permissions-Policy': 'hid=()' }
}

const wptSupportFiles: Record<string, string> = {
  '/resources/testharness.js': 'testharness.js',
  '/permissions-policy/resources/permissions-policy-hid.html': 'permissions-policy-hid.html',
  '/permissions-policy/resources/permissions-policy-hid-worker.html':
    'permissions-policy-hid-worker.html',
  '/permissions-policy/resources/permissions-policy-hid-worker.js':
    'permissions-policy-hid-worker.js',
  '/permissions-policy/resources/redirect-on-load.html': 'redirect-on-load.html'
}

const rootMime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.bin': 'application/octet-stream'
}

const wptMime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.idl': 'text/plain'
}

function listen(server: http.Server, port: number): Promise<ServerHandle> {
  server.listen(port)
  return once(server, 'listening').then(() => {
    const address = server.address()
    if (typeof address !== 'object' || address === null) {
      throw new Error('Server is not listening on a TCP port')
    }
    return { port: address.port, server }
  })
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
      headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
    }
  }
  return headers
}

function transformWptHtml(body: string, port: number): string {
  return body
    .replaceAll(
      'https://{{domains[www]}}:{{ports[https][0]}}',
      `http://127.0.0.1:${port}`
    )
    .replaceAll(
      'src=/resources/testharness.js',
      `src=${WPT_SUPPORT_ORIGIN}/testharness.js`
    )
    .replaceAll(
      'src=/permissions-policy/resources/permissions-policy.js',
      `src=${WPT_SUPPORT_ORIGIN}/permissions-policy.js`
    )
}

async function serveFile(
  response: http.ServerResponse,
  filePath: string,
  contentType: string,
  headers: Record<string, string> = {}
): Promise<void> {
  try {
    const body = await readFile(filePath)
    response.writeHead(200, { 'Content-Type': contentType, ...headers })
    response.end(body)
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('Not found')
  }
}

async function serveWptFile(
  response: http.ServerResponse,
  filePath: string,
  port: number
): Promise<void> {
  let body: Buffer
  try {
    body = await readFile(filePath)
  } catch {
    response.writeHead(404)
    response.end('Not found')
    return
  }

  let headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'Content-Type': wptMime[extname(filePath)] ?? 'application/octet-stream'
  }
  try {
    headers = {
      ...headers,
      ...parseWptHeaders(await readFile(`${filePath}.headers`, 'utf8'))
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      response.writeHead(500)
      response.end('Unable to read response headers')
      return
    }
  }

  const bodyText = body.toString('utf8')
  response.writeHead(200, headers)
  response.end(
    extname(filePath) === '.html' ? transformWptHtml(bodyText, port) : body
  )
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  port: number
): Promise<void> {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  } catch {
    response.writeHead(400)
    response.end('Bad request')
    return
  }

  if (pathname === '/resources/testharnessreport.js') {
    response.writeHead(200, { 'Content-Type': 'application/javascript' })
    response.end()
    return
  }

  const policyFile = policyPageFiles[pathname]
  if (policyFile) {
    await serveFile(
      response,
      resolve(pagesRoot, policyFile),
      policyFile.endsWith('.js') ? 'application/javascript' : 'text/html',
      { 'Cache-Control': 'no-store', ...policyHeaders[pathname] }
    )
    return
  }

  const supportFile = wptSupportFiles[pathname]
  if (supportFile) {
    await serveWptFile(response, resolve(wptSupportRoot, supportFile), port)
    return
  }

  if (pathname.startsWith('/webhid/')) {
    const filePath = safePath(wptSiteRoot, pathname)
    if (!filePath) {
      response.writeHead(403)
      response.end('Forbidden')
      return
    }
    await serveWptFile(response, filePath, port)
    return
  }

  const staticPath = pathname === '/' ? '/index.html' : pathname
  const filePath = safePath(projectRoot, staticPath)
  if (!filePath) {
    response.writeHead(403)
    response.end('Forbidden')
    return
  }
  const headers: Record<string, string> = {}
  if (pathname === '/tests/pages/benchmark-image.html') {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
  }
  await serveFile(
    response,
    filePath,
    rootMime[extname(filePath)] ?? 'application/octet-stream',
    headers
  )
}

export async function startTestServer(port = 0): Promise<ServerHandle> {
  let serverPort = 0
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, serverPort).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end('Internal server error')
    })
  })
  const handle = await listen(server, port)
  serverPort = handle.port
  return handle
}

export async function fulfillWptReportRoute(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'application/javascript' },
    body: ''
  })
}
