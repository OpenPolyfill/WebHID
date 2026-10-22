import http from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve, dirname, join, extname, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { readFile } from 'node:fs'

const directoryPath = dirname(fileURLToPath(import.meta.url))

interface ServerHandle {
  port: number
  server: http.Server
}

function getPort(server: http.Server): number {
  const addr = server.address()
  if (typeof addr === 'object' && addr !== null) {
    return addr.port
  }
  throw new Error('Server is not listening on a TCP port')
}

async function listen(server: http.Server, port = 0): Promise<ServerHandle> {
  server.listen(port)
  await once(server, 'listening')
  return { port: getPort(server), server }
}

function loadPage(name: string): string {
  const pagePath = resolve(directoryPath, 'pages', name)
  return readFileSync(pagePath, 'utf-8')
}

const PAGES: Record<string, string> = {
  '/policy-check': loadPage('policy-check.html'),
  '/policy-check-blocked': loadPage('policy-check.html'),
  '/iframe-parent': loadPage('iframe-parent.html'),
  '/iframe-parent-blocked': loadPage('iframe-parent.html'),
  '/iframe-child-no-allow': loadPage('iframe-child.html'),
  '/iframe-child-with-allow': loadPage('iframe-child.html'),
  '/iframe-worker-policy': loadPage('iframe-worker-policy.html'),
  '/worker-policy.js': loadPage('worker-policy.js'),
  '/iframe-child-forge': loadPage('iframe-child-forge.html'),
  '/worker.js': loadPage('worker.js')
}

const HEADERS: Record<string, Record<string, string | string[]>> = {
  '/policy-check': {},
  '/policy-check-blocked': {
    'Permissions-Policy': 'hid=()'
  },
  '/iframe-parent-blocked': {
    'Permissions-Policy': 'hid=()'
  }
}

function servePage(res: http.ServerResponse, pathname: string): void {
  const body = PAGES[pathname]
  if (!body) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }
  const headers = HEADERS[pathname] || {}
  res.writeHead(200, {
    'Content-Type': pathname.endsWith('.js') ? 'application/javascript' : 'text/html',
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(body)
}

export async function startPolicyServer(port = 0): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0]
    servePage(res, pathname)
  })
  return listen(server, port)
}

const projectRoot = resolve(directoryPath, '..')

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.bin': 'application/octet-stream'
}

export async function startStaticServer(port = 0): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    const filePath = join(projectRoot, req.url === '/' ? '/index.html' : (req.url ?? '/'))
    const resolved = resolve(filePath)
    if (!resolved.startsWith(projectRoot + '/')) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    const ext = extname(resolved)
    readFile(resolved, (err, data) => {
      if (err) {
        res.end('Not found')
        return
      }
      const headers: Record<string, string> = {
        'Content-Type': MIME[ext] || 'application/octet-stream'
      }

      if (req.url === '/tests/pages/benchmark-image.html') {
        headers['Cross-Origin-Opener-Policy'] = 'same-origin'
        headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
      }
      res.writeHead(200, headers)
      res.end(data)
    })
  })
  return listen(server, port)
}
const wptSiteRoot = resolve(directoryPath, 'conformance/wpt/site')
const wptSupportRoot = resolve(directoryPath, 'conformance/wpt/support')

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

const wptMime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.idl': 'text/plain'
}

export async function startWptServer(port = 0): Promise<ServerHandle> {
  let serverPort = 0
  const server = http.createServer((req, res) => {
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      res.writeHead(400)
      res.end('Bad request')
      return
    }

    if (pathname === '/resources/testharnessreport.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
      res.end()
      return
    }

    const supportFile = wptSupportFiles[pathname]
    const root = supportFile ? wptSupportRoot : wptSiteRoot
    const filePath = resolve(root, supportFile ?? pathname.slice(1))
    const relativePath = relative(root, filePath)
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      readFile(`${filePath}.headers`, 'utf8', (headerError, headerText) => {
        if (headerError && headerError.code !== 'ENOENT') {
          res.writeHead(500)
          res.end('Unable to read response headers')
          return
        }

        const headers: Record<string, string> = {
          'Cache-Control': 'no-store',
          'Content-Type': wptMime[extname(filePath)] ?? 'application/octet-stream'
        }
        if (!headerError) {
          for (const line of headerText.split(/\r?\n/)) {
            const separator = line.indexOf(':')
            if (separator > 0) {
              headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
            }
          }
        }

        let body = data
        if (pathname.endsWith('.sub.html')) {
          body = Buffer.from(
            data
              .toString('utf8')
              .replaceAll(
                'https://{{domains[www]}}:{{ports[https][0]}}',
                `http://127.0.0.1:${serverPort}`
              )
          )
        }
        res.writeHead(200, headers)
        res.end(body)
      })
    })
  })

  const handle = await listen(server, port)
  serverPort = handle.port
  return handle
}
