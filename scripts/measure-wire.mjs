/**
 * Capture the model request body of one headless run, with or without the plugin.
 *
 * Usage: node scripts/measure-wire.mjs <label> [--with-plugin]
 * Writes .dsh/refs/wire-<label>.json plus .dsh/refs/measure-<label>.json.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const label = process.argv[2] ?? 'baseline'
const withPlugin = process.argv.includes('--with-plugin')
const root = resolve(import.meta.dirname, '..')
const dshHome = join(root, '.dsh-home')
const port = 8799
const wirePath = join(root, `.dsh/refs/wire-${label}.json`)
const patchDir = mkdtempSync(join(tmpdir(), 'free-web-patch-'))
const patchPath = join(patchDir, 'overlay.yml')

const lines = [
  '- id: llm-deepseek',
  '  config:',
  `    baseURL: http://127.0.0.1:${port}`,
]
if (withPlugin) {
  lines.push(
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
  )
}
writeFileSync(patchPath, `${lines.join('\n')}\n`)

const mock = spawn(process.execPath, [join(root, 'scripts/mock-llm.mjs'), String(port), wirePath], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((done) => mock.stdout.once('data', done))

const run = spawn('dsh', ['--profile', 'headless', '--patch', patchPath, 'say hi'], {
  cwd: root,
  env: { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: 'sk-dummy', DEEPSEEK_SEARCH_BASE_URL: `http://127.0.0.1:${port}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
run.stdout.on('data', (chunk) => { log += chunk })
run.stderr.on('data', (chunk) => { log += chunk })
const timer = setTimeout(() => run.kill('SIGKILL'), 90_000)
await new Promise((done) => run.on('close', done))
clearTimeout(timer)
mock.kill('SIGKILL')
writeFileSync(join(root, `.dsh/refs/log-${label}.txt`), log)

if (!readFileSync ? false : true) {
  try {
    const body = JSON.parse(readFileSync(wirePath, 'utf8'))
    const system = body.system ?? ''
    const systemText = Array.isArray(system) ? system.map((part) => part.text ?? '').join('\n') : String(system)
    const tools = Array.isArray(body.tools) ? body.tools : []
    const summary = {
      label,
      withPlugin,
      systemChars: systemText.length,
      toolCount: tools.length,
      toolNames: tools.map((tool) => tool.name).sort(),
      mentionsFreeWeb: /free-web|free_search|free-search|free-fetch/i.test(systemText),
      model: body.model,
    }
    writeFileSync(join(root, `.dsh/refs/measure-${label}.json`), `${JSON.stringify(summary, null, 2)}\n`)
    writeFileSync(join(root, `.dsh/refs/system-${label}.txt`), systemText)
    console.log(JSON.stringify(summary))
  } catch (error) {
    console.log(`no wire captured (${error.message})`)
    console.log(log.slice(-1500))
  }
}
rmSync(patchDir, { recursive: true, force: true })
