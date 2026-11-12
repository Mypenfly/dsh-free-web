import { enginesFromEnv, resolveEngines } from '../src/search/engines/index.mjs'
import { FreeSearchProvider } from '../src/search/provider.mjs'
import { FreeFetchProvider } from '../src/fetch/provider.mjs'

// Same precedence the plugin uses: the environment may shrink the pool for a run.
const engines = resolveEngines(enginesFromEnv() ?? ['yahoojp','so360','sogou','wikipedia','bing'], (m)=>console.log('WARN',m))
const provider = new FreeSearchProvider({ id:'free-search', engines, timeoutMs:9000, acceptLanguage:'en-US,en;q=0.9,zh-CN;q=0.8,ja;q=0.7', log:(m)=>console.log('LOG',m) })
const t=Date.now()
try {
  const r = await provider.search({ query: process.argv[2] ?? 'rust ownership', maxResults: 10 })
  console.log('elapsed', Date.now()-t, 'ms; sources:', r.sources.length, 'truncated:', r.truncated)
  console.log('content:', r.content)
  for (const s of r.sources.slice(0,8)) console.log('-', s.title?.slice(0,60), '|', s.url.slice(0,90), '|', (s.snippet??'').slice(0,60))
} catch (e) { console.log('SEARCH ERROR', e.code, e.message) }

const fetchProvider = new FreeFetchProvider({ id:'free-fetch' })
for (const url of (process.argv[3] ? [process.argv[3]] : ['https://example.com/','https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html'])) {
  const t2=Date.now()
  try { const r = await fetchProvider.fetch({ url })
    console.log(`FETCH ${url} -> ${r.statusCode} ${r.body.content.length} chars truncated=${r.truncated} in ${Date.now()-t2}ms`)
    console.log('   ', r.body.content.slice(0,220).replace(/\n/g,' ⏎ '))
  } catch (e) { console.log('FETCH ERROR', url, e.code, e.message.slice(0,160)) }
}
