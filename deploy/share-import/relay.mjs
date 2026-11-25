import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

// Only accept a share identifier. Never forward the browser's headers or a caller-supplied URL.
export async function shareRelay(req, res, next) {
  if (!req.url?.startsWith('/api/deepseek-share/')) return next()
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    res.writeHead(405).end()
    return
  }
  const match = /^\/api\/deepseek-share\/([A-Za-z0-9_-]{1,128})$/.exec(req.url)
  if (!match) {
    res.writeHead(400).end()
    return
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  res.once('close', () => controller.abort())
  try {
    const response = await fetch(
      'https://chat.deepseek.com/api/v0/share/content?share_id=' + match[1],
      {
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      }
    )
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      res.writeHead(response.status === 404 || response.status === 410 ? 410 : 502).end()
      return
    }
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) {
        res.writeHead(413).end()
        return
      }
      chunks.push(chunk)
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' })
    res.end(Buffer.concat(chunks))
  } catch {
    if (!res.destroyed) res.writeHead(controller.signal.aborted ? 504 : 502).end()
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8091)
  createServer((req, res) => shareRelay(req, res, () => res.writeHead(404).end())).listen(
    port,
    '127.0.0.1',
    () => console.log('Share relay listening on port', port)
  )
}
