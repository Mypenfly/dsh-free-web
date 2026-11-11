/**
 * Drive the real host kernel through a scripted tool call, without a paid model.
 *
 * `measure-wire.mjs` answers the first request with an error and only proves what
 * was *declared*. This probe goes further: the mock LLM streams a `tool_use` block,
 * the host executes the tool through its own `ctx.web` seam, and the follow-up
 * request carries the tool result — so a green run is evidence that the tool, the
 * seam, and the provider's transport all met, in the host's process.
 *
 * Usage: node scripts/probe-live-tool.mjs <web_search|web_fetch> <argument>
 *   node scripts/probe-live-tool.mjs web_search "rust ownership"
 *   node scripts/probe-live-tool.mjs web_fetch https://example.com/
 *
 * Writes .dsh/refs/probe-<tool>.json (both requests + the tool result) and
 * .dsh/refs/probe-<tool>.log (the CLI output), then prints the result's head.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const tool = process.argv[2] ?? 'web_search'
const argument = process.argv[3] ?? 'rust ownership'
if (tool !== 'web_search' && tool !== 'web_fetch') {
  process.stderr.write('usage: node scripts/probe-live-tool.mjs <web_search|web_fetch> <argument>\n')
  process.exit(2)
}

const root = resolve(import.meta.dirname, '..')
const dshHome = join(root, '.dsh-home')
const refs = join(root, '.dsh/refs')
mkdirSync(refs, { recursive: true })
const port = 8798
const patchDir = mkdtempSync(join(tmpdir(), 'free-web-probe-'))
const patchPath = join(patchDir, 'overlay.yml')
writeFileSync(
  patchPath,
  [
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: http://127.0.0.1:${port}`,
    '- insert:',
    '    - id: free-web',
    `      name: ${join(root, 'src/index.mjs')}`,
    '      config:',
    '        engines: [yahoojp, so360, sogou, wikipedia]',
    '        verbose: true',
    '- id: web',
    '  config:',
    '    searchProvider: free-search',
    '    fetchProvider: free-fetch',
    '',
  ].join('\n'),
)

// The host tool schemas are not ours to change: web_search takes `queries`, web_fetch `url`.
const toolInput = tool === 'web_search' ? { queries: [argument] } : { url: argument }
const requests = []
let turn = 0

/** Emit one Anthropic-Messages SSE event. */
function event(response, name, data) {
  response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Stream a complete assistant turn made of one block. */
function streamTurn(response, block, stopReason) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  event(response, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${turn}`,
      type: 'message',
      role: 'assistant',
      model: 'mock',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 16, output_tokens: 1 },
    },
  })
  if (block.type === 'tool_use') {
    event(response, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { ...block, input: {} } })
    event(response, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
    })
  } else {
    event(response, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    event(response, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } })
  }
  event(response, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  event(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 8 },
  })
  event(response, 'message_stop', { type: 'message_stop' })
  response.end()
}

const mock = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push(body)
    turn += 1
    if (turn === 1) {
      streamTurn(response, { type: 'tool_use', id: 'toolu_probe', name: tool }, 'tool_use')
      return
    }
    streamTurn(response, { type: 'text', text: 'probe complete' }, 'end_turn')
  })
})

await new Promise((done) => mock.listen(port, '127.0.0.1', done))

const run = spawn('dsh', ['--profile', 'headless', '--patch', patchPath, `please ${tool}`], {
  cwd: root,
  env: { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: 'sk-dummy', DEEPSEEK_SEARCH_BASE_URL: `http://127.0.0.1:${port}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
run.stdout.on('data', (chunk) => { log += chunk })
run.stderr.on('data', (chunk) => { log += chunk })
const timer = setTimeout(() => run.kill('SIGKILL'), 120_000)
await new Promise((done) => run.on('close', done))
clearTimeout(timer)
mock.close()

/**
 * Pull the tool result text out of whichever follow-up request carries it.
 *
 * The kernel also fires side requests (session title generation), so the library
 * call is not at a fixed index: scan the bodies in order and keep the last
 * `tool_result` block, which is the one produced by the tool this probe asked for.
 */
function toolResultText(bodies) {
  let found
  for (const body of bodies) {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      continue
    }
    for (const message of parsed.messages ?? []) {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part.type !== 'tool_result') continue
        found = typeof part.content === 'string'
          ? part.content
          : (part.content ?? []).map((piece) => piece.text ?? '').join('\n')
      }
    }
  }
  return found
}

const result = requests.length > 1 ? toolResultText(requests) : undefined
writeFileSync(join(refs, `probe-${tool}.json`), JSON.stringify({ tool, argument, requests, result }, null, 2))
writeFileSync(join(refs, `probe-${tool}.log`), log)

if (result === undefined) {
  process.stderr.write(`no tool result: the kernel never called ${tool}\n--- log ---\n${log.slice(-4000)}\n`)
  process.exit(1)
}
process.stdout.write(`tool: ${tool}(${JSON.stringify(toolInput)})\n`)
process.stdout.write(`result: ${result.length} chars\n${result.slice(0, 900)}\n`)
