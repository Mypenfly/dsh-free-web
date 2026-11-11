import { resolveEngines } from './src/search/engines/index.mjs'
import { FreeSearchProvider } from './src/search/provider.mjs'
const engines = resolveEngines(undefined, (m)=>console.log('WARN',m))
const provider = new FreeSearchProvider({ id:'free-search', engines, timeoutMs:9000, acceptLanguage:'en-US,en;q=0.9,zh-CN;q=0.8,ja;q=0.7', log:(m)=>console.log('  LOG',m) })
for (const q of ['rust ownership','DeepSeek 发布 新模型','python asyncio timeout pattern']) {
  const t=Date.now()
  try { const r = await provider.search({ query:q, maxResults:10 })
    console.log(`\n[${q}] ${Date.now()-t}ms sources=${r.sources.length} truncated=${r.truncated}`)
    console.log('  ', r.content)
    for (const s of r.sources.slice(0,4)) console.log('   -', (s.title??'').slice(0,55), '|', s.url.slice(0,80))
  } catch(e){ console.log(`\n[${q}] ERROR`, e.code, e.message.slice(0,300)) }
}
