/**
 * Minimal Anthropic-Messages-compatible capture server.
 *
 * Harness measurement only: it records the first request body (system prompt +
 * tool declarations + messages) and then refuses every call, so a wired run never
 * reaches a real provider.
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 8799)
const outPath = process.argv[3] ?? '.dsh/refs/wire.json'
let captured = 0

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    if (captured === 0) {
      writeFileSync(outPath, body)
      captured += 1
      process.stdout.write(`captured ${body.length} bytes -> ${outPath}\n`)
    }
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { type: 'mock', message: 'capture only' } }))
  })
})
server.listen(port, '127.0.0.1', () => process.stdout.write(`mock listening on ${port}\n`))
