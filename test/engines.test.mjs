/**
 * Offline engine tests. Every fixture under test/fixtures was captured from the
 * live engine (see docs/ENGINES.md) so a selector regression fails here instead of
 * silently degrading a search.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as yahoojp from '../src/search/engines/yahoojp.mjs'
import * as so360 from '../src/search/engines/so360.mjs'
import * as bing from '../src/search/engines/bing.mjs'
import * as wikipedia from '../src/search/engines/wikipedia.mjs'
import * as sogou from '../src/search/engines/sogou.mjs'
import * as baidu from '../src/search/engines/baidu.mjs'
import { coherenceScore, detectGate, isDecoy } from '../src/search/gates.mjs'
import { parseDate } from '../src/util/dates.mjs'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('yahoojp: result cards give title, absolute url and snippet', () => {
  const sources = yahoojp.extract(fixture('yahoojp-result.html'), 'https://search.yahoo.co.jp/search?p=x')
  assert.ok(sources.length >= 5, `expected at least 5 cards, got ${sources.length}`)
  const first = sources[0]
  assert.match(first.url, /^https:\/\//)
  assert.doesNotMatch(first.url, /yahoo\.co\.jp/, 'engine-host URLs must never be cited')
  // The anchor text carries `site › breadcrumb`; the title comes from the h3.
  assert.doesNotMatch(first.title, /›/)
  assert.ok(first.snippet.length > 20)
})

test('so360: data-mdurl is preferred and the date is parsed', () => {
  const sources = so360.extract(fixture('so360-result.html'), 'https://www.so.com/s?q=x')
  assert.ok(sources.length >= 5, `expected at least 5 items, got ${sources.length}`)
  for (const source of sources) {
    assert.doesNotMatch(source.url, /so\.com|360\.com|360kan\.com/, '360 chrome is not a result')
  }
  const dated = sources.find((source) => source.publishedAt !== undefined)
  assert.ok(dated !== undefined, 'at least one item carries a publication date')
  assert.match(dated.publishedAt, /^\d{4}-\d{2}-\d{2}$/)
})

test('bing: decoy page parses to rows that the coherence gate rejects', () => {
  const html = fixture('bing-decoy.html')
  const sources = bing.extract(html, 'https://www4.bing.com/search?q=rust+ownership')
  assert.ok(sources.length >= 5, 'the decoy page has perfectly shaped rows')
  assert.doesNotMatch(sources[0].url, /bing\.com/, 'ck/a redirects are decoded, not cited')
  const verdict = isDecoy('rust ownership', sources)
  assert.equal(verdict.decoy, true, 'rows must be recognised as a decoy, not as results')
})

test('bing: rss route yields structured sources', () => {
  const sources = bing.extractRss(fixture('bing.rss.xml'))
  assert.ok(sources.length >= 5, `expected rss items, got ${sources.length}`)
  for (const source of sources) assert.match(source.url, /^https?:\/\//)
  assert.ok(sources.some((source) => source.publishedAt !== undefined), 'pubDate becomes publishedAt')
})

test('bing: ck/a base64 targets decode to the real destination', () => {
  const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&u=a1${Buffer.from(
    'https://example.org/real-page',
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')}">Real title</a></h2><p class="b_lineclamp2">Snippet.</p></li>`
  const sources = bing.extract(html, 'https://www4.bing.com/search?q=x')
  assert.equal(sources.length, 1)
  assert.equal(sources[0].url, 'https://example.org/real-page')
})

test('wikipedia: json payload maps to article urls', () => {
  const sources = wikipedia.extract(JSON.parse(fixture('wikipedia.json')), 'en')
  assert.ok(sources.length >= 3)
  assert.match(sources[0].url, /^https:\/\/en\.wikipedia\.org\/wiki\//)
  assert.doesNotMatch(sources[0].snippet, /<|>/, 'searchmatch markup is stripped')
})

test('wikipedia: language follows the query script', () => {
  assert.equal(wikipedia.languageFor('rust ownership'), 'en')
  assert.equal(wikipedia.languageFor('所有权 语义'), 'zh')
})

test('sogou: data-url carries the destination and token redirects are dropped', () => {
  const html = `
    <div class="vrwrap"><h3 class="vr-title"><a href="/link?url=hedJjaC291">Rust 所有权详解</a></h3>
      <div class="r-sech ext_query" data-url="https://example.cn/rust-ownership"></div>
      <div class="fz-mid">这是摘要文本，描述所有权规则。</div>
      <div class="citeLinkClass"><a href="/link?url=x"><span>example.cn</span><span>https://example.cn/a...</span><span>2024-03-05</span></a></div>
    </div>
    <div class="vrwrap"><h3 class="vr-title"><a href="/link?url=onlyToken">No direct url</a></h3></div>`
  const sources = sogou.extract(html, 'https://www.sogou.com/web?query=x')
  assert.equal(sources.length, 1, 'the token-only block is dropped, not cited')
  assert.equal(sources[0].url, 'https://example.cn/rust-ownership')
  // The third span of the cite line is a real date; the truncated display URL is not.
  assert.equal(sources[0].publishedAt, '2024-03-05')
})

test('sogou: the anti-captcha page is a gate, not an empty result', () => {
  assert.equal(detectGate(fixture('sogou-captcha.html')), 'captcha')
})

test('baidu: mu= carries the destination, ad slots are filtered out', () => {
  const html = `
    <div class="result c-container" mu="https://example.com/rust"><h3><a>Rust 所有权</a></h3>
      <div class="c-abstract">摘要内容</div></div>
    <div class="result c-container" mu="http://nourl.ubs.baidu.com/61344"><h3><a>广告</a></h3></div>`
  const sources = baidu.extract(html, 'https://www.baidu.com/s?wd=x')
  assert.equal(sources.length, 2, 'extraction keeps both; the host filter belongs to the engine gate')
  assert.equal(sources[0].url, 'https://example.com/rust')
})

test('baidu: the verification page is a captcha gate', () => {
  assert.equal(detectGate(fixture('baidu-verify.html')), 'captcha')
})

test('dates: localized feed dates normalize to ISO, junk is rejected', () => {
  assert.equal(parseDate('2026-11-11'), '2026-11-11')
  assert.equal(parseDate('2026年1月14日 - 来源'), '2026-01-14')
  assert.equal(parseDate('周二, 10 11月 2026 09:00:00 GMT'), '2026-11-10')
  assert.equal(parseDate('Tue, 10 Nov 2026 09:00:00 GMT'), '2026-11-10')
  assert.equal(parseDate('Copyright 1998 Example Corp'), undefined)
  assert.equal(parseDate('no date here'), undefined)
})

test('coherence: too few rows is undecidable, a single-term query is still judged', () => {
  assert.equal(coherenceScore('rust ownership', [{ url: 'https://a.example' }]), null)
  // One-token queries have no residual terms, so every content term is used;
  // otherwise a decoy could never be caught for them.
  const rows = new Array(5).fill({ url: 'https://translate.google.com/x', title: 'Google Translate' })
  assert.equal(coherenceScore('ownership', rows), 0)
})

test('coherence: a topic-repeating bucket passes, junk does not', () => {
  const matching = new Array(5).fill(null).map((_, index) => ({
    url: `https://example.com/${index}`,
    title: 'Rust ownership explained',
    snippet: 'ownership and borrowing',
  }))
  assert.equal(coherenceScore('rust ownership', matching), 1)
  const junk = new Array(5).fill(null).map((_, index) => ({
    url: `https://translate.google.com/${index}`,
    title: 'Google Translate',
    snippet: 'translate words',
  }))
  assert.equal(coherenceScore('rust ownership', junk), 0)
  assert.deepEqual(isDecoy('rust ownership', junk), { decoy: true, score: 0 })
})
