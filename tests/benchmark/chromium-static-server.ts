import http from 'node:http'
import { readFile } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

const directoryPath = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(directoryPath, '..', '..')

interface ServerHandle {
  port: number
  server: http.Server
}

const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.bin': 'application/octet-stream'
}

export async function startChromiumStaticServer(port = 0): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    const filePath = join(projectRoot, req.url === '/' ? '/index.html' : (req.url ?? '/'))
    const resolved = resolve(filePath)
    if (!resolved.startsWith(projectRoot + '/')) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    readFile(resolved, (error, data) => {
      if (error) {
        res.end('Not found')
        return
      }

      const headers: Record<string, string> = {
        'Content-Type': mime[extname(resolved)] ?? 'application/octet-stream'
      }
      if (req.url === '/tests/pages/benchmark-image.html') {
        headers['Cross-Origin-Opener-Policy'] = 'same-origin'
        headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
      }
      res.writeHead(200, headers)
      res.end(data)
    })
  })

  server.listen(port)
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('Server is not listening on a TCP port')
  }
  return { port: address.port, server }
}
