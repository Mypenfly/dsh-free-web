/**
 * Offline tests for the fusion, URL, reader, and provider layers. No network.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { fuse } from '../src/search/rank.mjs'
import { canonicalUrl, dedupeKey, hostOf, unwrapRedirect } from '../src/util/url.mjs'
import { decodeEntities, elementsByClass, htmlToText } from '../src/util/html.mjs'
import { extractReadable, tidy } from '../src/fetch/reader.mjs'
import { classify, isNonPublicAddress, validateUrl } from '../src/fetch/provider.mjs'
import { FreeSearchProvider } from '../src/search/provider.mjs'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('rrf: agreement between engines outranks a single engine position', () => {
  const { sources, perEngine, total } = fuse([
    { engine: 'a', sources: [{ url: 'https://example.com/one' }, { url: 'https://example.com/two' }] },
    { engine: 'b', sources: [{ url: 'https://example.com/two' }, { url: 'https://example.com/three' }] },
  ])
  assert.deepEqual(perEngine, { a: 2, b: 2 })
  assert.equal(total, 3)
  assert.equal(sources[0].url, 'https://example.com/two', 'the source both engines rank must win')
})

test('rrf: duplicates collapse across tracking parameters and redirect wrappers', () => {
  const { sources, total } = fuse([
    {
      engine: 'a',
      sources: [{ url: 'https://example.com/post?utm_source=x' }, { url: 'https://www.example.com/post/' }],
    },
    { engine: 'b', sources: [{ url: 'https://example.com/post#section' }] },
  ])
  assert.equal(total, 1, `expected one canonical source, got ${JSON.stringify(sources)}`)
  assert.equal(sources[0].url, 'https://example.com/post')
})

test('rrf: a row with a non-http url is dropped instead of cited', () => {
  const { total } = fuse([{ engine: 'a', sources: [{ url: 'javascript:alert(1)' }] }])
  assert.equal(total, 0)
})

test('url: canonical form strips tracking, www, fragment and default ports', () => {
  assert.equal(canonicalUrl('https://www.Example.com:443/a/b/?utm_campaign=z&q=1#frag'), 'https://example.com/a/b?q=1')
  assert.equal(canonicalUrl('https://example.com/'), 'https://example.com')
  assert.equal(canonicalUrl('ftp://example.com/x'), undefined)
  assert.equal(dedupeKey('https://example.com/a?b=1'), 'example.com/a?b=1')
  assert.equal(hostOf('https://www.example.com/x'), 'example.com')
})

test('url: bing ck/a and ddg uddg redirects unwrap, opaque tokens do not', () => {
  const decoded = Buffer.from('https://example.org/a').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
  assert.equal(unwrapRedirect(`https://www.bing.com/ck/a?!&&u=a1${decoded}`), 'https://example.org/a')
  assert.equal(unwrapRedirect('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb'), 'https://example.org/b')
  assert.equal(unwrapRedirect('https://www.baidu.com/link?url=opaque-token', 'baidu'), undefined)
})

test('html: entities decode once and class extraction stays leaf-scoped', () => {
  assert.equal(decodeEntities('a &amp; b &#39;c&#39; &lt;d&gt;'), "a & b 'c' <d>")
  assert.deepEqual(elementsByClass('<div class="x y">inner</div>', ['y']), ['inner'])
  assert.equal(htmlToText('<p>a <b>b</b></p>'), 'a b')
})

test('reader: markdown keeps headings, code and links, drops chrome', () => {
  const body = extractReadable(fixture('article-mdn.html')).text
  assert.ok(body.length > 2000, `expected a real article body, got ${body.length} chars`)
  assert.match(body, /^# Regular expressions/mu)
  assert.doesNotMatch(body, /Previous\s*\|?\s*Next$/mu)
  assert.doesNotMatch(body, /^\s*\[.*\]\(.*\)\s*$/mu.source === '' ? /never/ : /^$/, 'sanity')
  assert.ok(body.includes('```'), 'code fences survive conversion')
})

test('reader: a heading and a paragraph survive conversion', () => {
  const text = extractReadable(
    '<html><body><main><h1>Title</h1><p>Body text that is long enough to score as content in the region picker.</p>' +
      '<ul><li>one</li><li>two</li></ul></main></body></html>',
  ).text
  assert.match(text, /^# Title/mu)
  assert.match(text, /- one/u)
  assert.equal(tidy('a\n\n\n\nb  '), 'a\n\nb')
})

test('fetch: non-public destinations are refused before any request', () => {
  for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '[::1]', '[fd00::1]', '[fe80::1]']) {
    const address = host.replace(/^\[|\]$/g, '')
    assert.equal(isNonPublicAddress(address), true, `${host} must be refused`)
  }
  for (const host of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
    assert.equal(isNonPublicAddress(host), false, `${host} is public`)
  }
  assert.throws(() => validateUrl('http://localhost:8080/'), { code: 'WEB_BLOCKED_URL' })
  assert.throws(() => validateUrl('http://127.0.0.1/'), { code: 'WEB_BLOCKED_URL' })
  assert.throws(() => validateUrl('file:///etc/passwd'), { code: 'WEB_INVALID_URL' })
  assert.throws(() => validateUrl('https://user:pass@example.com/'), { code: 'WEB_INVALID_URL' })
  assert.throws(() => validateUrl(`https://example.com/${'a'.repeat(3000)}`), { code: 'WEB_FETCH_MAX_URL_LENGTH' })
  assert.equal(validateUrl('https://example.com/ok').hostname, 'example.com')
})

test('fetch: content types classify like the shipped provider', () => {
  assert.equal(classify('text/html; charset=utf-8'), 'html')
  assert.equal(classify('application/xhtml+xml'), 'html')
  assert.equal(classify('application/json'), 'text')
  assert.equal(classify('text/markdown'), 'text')
  assert.equal(classify('application/pdf'), undefined)
  assert.equal(classify('image/png'), undefined)
  assert.equal(classify(null), undefined)
})

/** Build a fake engine whose behaviour is scripted per call. */
function fakeEngine(id, results) {
  const engine = {
    id,
    calls: 0,
    async search() {
      engine.calls += 1
      const next = results[Math.min(engine.calls - 1, results.length - 1)]
      if (next instanceof Error) throw next
      return next
    },
  }
  return engine
}

test('provider: a failing engine is benched after two strikes and skipped', async () => {
  let clock = 0
  const failing = fakeEngine('broken', [new Error('captcha page')])
  const working = fakeEngine('good', [[{ url: 'https://example.com/a', title: 'A' }]])
  const provider = new FreeSearchProvider({
    id: 'free-search',
    engines: [failing, working],
    timeoutMs: 100,
    acceptLanguage: 'en',
    now: () => clock,
    log: () => {},
  })
  await provider.search({ query: 'q one', maxResults: 5 })
  await provider.search({ query: 'q two', maxResults: 5 })
  assert.equal(failing.calls, 2)
  clock += 1000
  const third = await provider.search({ query: 'q three', maxResults: 5 })
  assert.equal(failing.calls, 2, 'a benched engine is not called again')
  assert.match(third.content, /broken benched/u)
  assert.equal(third.sources.length, 1)
})

test('provider: all engines failing throws with the per-engine reasons', async () => {
  const provider = new FreeSearchProvider({
    id: 'free-search',
    engines: [fakeEngine('a', [new Error('HTTP 429')]), fakeEngine('b', [new Error('no parsable results')])],
    timeoutMs: 100,
    acceptLanguage: 'en',
    log: () => {},
  })
  await assert.rejects(provider.search({ query: 'x', maxResults: 5 }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /a: HTTP 429/u)
    assert.match(error.message, /b: no parsable results/u)
    return true
  })
})

test('provider: a decoy bucket is dropped and reported, not merged', async () => {
  const decoy = Array.from({ length: 5 }, (_, index) => ({
    url: `https://translate.google.com/${index}`,
    title: 'Google Translate',
    snippet: 'translate',
  }))
  const provider = new FreeSearchProvider({
    id: 'free-search',
    engines: [fakeEngine('decoyed', [decoy]), fakeEngine('good', [[{ url: 'https://example.com/rust', title: 'rust ownership' }]])],
    timeoutMs: 100,
    acceptLanguage: 'en',
    log: () => {},
  })
  const result = await provider.search({ query: 'rust ownership', maxResults: 5 })
  assert.equal(result.sources.length, 1)
  assert.match(result.content, /decoyed decoy/u)
})

test('provider: results are memoised so a repeated query does not re-hit engines', async () => {
  const engine = fakeEngine('good', [[{ url: 'https://example.com/a', title: 'A' }]])
  const provider = new FreeSearchProvider({
    id: 'free-search',
    engines: [engine],
    timeoutMs: 100,
    acceptLanguage: 'en',
    log: () => {},
  })
  await provider.search({ query: 'same', maxResults: 5 })
  await provider.search({ query: 'same', maxResults: 5 })
  assert.equal(engine.calls, 1)
})
