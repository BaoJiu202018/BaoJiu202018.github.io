import http from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, sep, extname } from 'node:path'
import worker from '../worker/src/index.ts'
import { createFixture, fixturePassword } from '../tests/support.mjs'

const fixture = process.argv.includes('--fixture')
const port = Number(process.env.PORT || 5190)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port')
const origin = `http://127.0.0.1:${port}`
const root = await realpath(fileURLToPath(new URL('../public/', import.meta.url)))
const platform = fixture ? await createFixture(origin) : null
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = http.createServer(async (req, res) => {
  const respond = (status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" })
    res.end(req.method === 'HEAD' ? '' : body)
  }
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) return respond(403, 'Forbidden host')
    const url = new URL(req.url, origin)
    if (url.pathname.startsWith('/api/')) {
      if (!platform) return respond(503, 'Backend not configured')
      const chunks = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 2048) return respond(413, 'Body too large')
        chunks.push(chunk)
      }
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value)
      headers.set('CF-Connecting-IP', req.socket.remoteAddress || '127.0.0.1')
      const body = Buffer.concat(chunks)
      const response = await worker.fetch(new Request(`${origin}${url.pathname.slice(4)}${url.search}`, {
        method: req.method, headers, ...(!['GET', 'HEAD'].includes(req.method) && body.length ? { body } : {}),
      }), platform.env)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      return res.end(Buffer.from(await response.arrayBuffer()))
    }
    if (!['GET', 'HEAD'].includes(req.method)) return respond(405, 'Method not allowed')
    if (url.pathname === '/assets/config.js' && fixture) return respond(200, "export const API_BASE = '/api'; export const PREVIEW = true;", mime['.js'])
    const path = decodeURIComponent(url.pathname)
    if (path.includes('\\') || path.includes('\0')) return respond(404, 'Not found')
    const filename = resolve(root, path === '/' ? 'index.html' : `.${path}`)
    const actual = await realpath(filename)
    if (!actual.startsWith(`${root}${sep}`) || !mime[extname(actual)] || path.split('/').some(p => p.startsWith('.'))) return respond(404, 'Not found')
    respond(200, await readFile(actual), mime[extname(actual)])
  } catch { respond(404, 'Not found') }
})
server.listen(port, '127.0.0.1', () => {
  console.log(`Local ${fixture ? 'fictional-data preview' : 'public preview'}: ${origin}`)
  if (fixture) console.log(`Fictional fixture password (not for production): ${fixturePassword}`)
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await platform?.dispose(); process.exit(0) }))
