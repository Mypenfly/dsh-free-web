/**
 * Tests for the engine-pool override: `DSH_FREE_WEB_ENGINES` wins over the row
 * config, a typo degrades to a warning, and nothing else about the mount changes.
 * Offline: the fake context records what would have been registered.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ENGINE_ENV, enginesFromEnv, parseEngineList, resolveEngines } from '../src/search/engines/index.mjs'
import { apply } from '../src/index.mjs'

/**
 * Collect registered providers and warnings from one `apply` call.
 *
 * @param {object} config row config
 * @param {string | undefined} envValue value for ENGINE_ENV
 * @returns {{ search: any[], fetch: any[], warns: string[], infos: string[] }} outcome
 */
function mount(config, envValue) {
  const search = []
  const fetch = []
  const warns = []
  const infos = []
  const previous = process.env[ENGINE_ENV]
  if (envValue === undefined) delete process.env[ENGINE_ENV]
  else process.env[ENGINE_ENV] = envValue
  const ctx = {
    logger: { info: (line) => infos.push(line), warn: (line) => warns.push(line) },
    web: {
      registerSearchProvider: (provider) => search.push(provider),
      registerFetchProvider: (provider) => fetch.push(provider),
    },
  }
  try {
    apply(ctx, { fetch: false, ...config })
  } finally {
    if (previous === undefined) delete process.env[ENGINE_ENV]
    else process.env[ENGINE_ENV] = previous
  }
  return { search, fetch, warns, infos }
}

/** Engine ids of the registered search provider. */
const idsOf = (outcome) => outcome.search[0]?.engines.map((engine) => engine.id)

test('engine list parsing: separators, case, duplicates, blank values', () => {
  assert.deepEqual(parseEngineList('sogou, wikipedia'), ['sogou', 'wikipedia'])
  assert.deepEqual(parseEngineList(' so360   SOGOU ,, sogou '), ['so360', 'sogou'])
  assert.deepEqual(parseEngineList(''), [])
  assert.deepEqual(parseEngineList('   '), [])
  assert.deepEqual(parseEngineList(undefined), [])
  assert.deepEqual(parseEngineList(['sogou']), [], 'only strings are parsed')
})

test('engine env: absent or blank means "keep the configured pool"', () => {
  assert.equal(enginesFromEnv({}), undefined)
  assert.equal(enginesFromEnv({ [ENGINE_ENV]: '  , ' }), undefined)
  assert.deepEqual(enginesFromEnv({ [ENGINE_ENV]: 'wikipedia,yahoojp' }), ['wikipedia', 'yahoojp'])
  assert.equal(enginesFromEnv({ dsh_free_web_engines: 'sogou' }), undefined, 'the variable name is exact (uppercase, as Linux exports it)')
})

test('mount: the environment overrides the row config', () => {
  const outcome = mount({ engines: ['bing'] }, 'sogou,wikipedia')
  assert.deepEqual(idsOf(outcome), ['sogou', 'wikipedia'])
  assert.ok(outcome.infos.some((line) => line.includes('engine pool overridden by DSH_FREE_WEB_ENGINES=sogou,wikipedia')))
})

test('mount: without the variable the row config is used', () => {
  assert.deepEqual(idsOf(mount({ engines: ['bing'] }, undefined)), ['bing'])
})

test('mount: a blank variable is not an override', () => {
  const outcome = mount({ engines: ['bing'] }, '   ')
  assert.deepEqual(idsOf(outcome), ['bing'])
  assert.ok(!outcome.infos.some((line) => line.includes('overridden')))
})

test('mount: an unknown id in the override is a warning, the rest still mount', () => {
  const outcome = mount({ engines: ['bing'] }, 'sogou,nope')
  assert.deepEqual(idsOf(outcome), ['sogou'])
  assert.ok(outcome.warns.some((line) => line.includes('unknown engine "nope"')))
})

test('mount: an override with nothing usable falls back to the configured pool', () => {
  const outcome = mount({ engines: ['wikipedia'] }, 'nope,also-nope')
  assert.deepEqual(idsOf(outcome), ['wikipedia'])
  assert.ok(outcome.warns.some((line) => line.includes('has no usable engine; falling back')))
})

test('mount: a pool that resolves to nothing leaves the search provider unmounted instead of throwing', () => {
  // `engines: []` means "default pool"; a list of unknown ids is what empties it.
  const outcome = mount({ engines: ['nope'] }, 'also-nope')
  assert.equal(outcome.search.length, 0)
  assert.ok(outcome.warns.some((line) => line.includes('no usable search engine')))
})

test('resolveEngines keeps configured order and skips non-strings', () => {
  const engines = resolveEngines(['wikipedia', 42, 'sogou'])
  assert.deepEqual(engines.map((engine) => engine.id), ['wikipedia', 'sogou'])
})

// --- the row form (Plugins page) projection ---------------------------------

test('Config marks only the engine pool as volatile, so that is the whole form', async () => {
  const { Config } = await import('../src/index.mjs')
  assert.ok(Config !== undefined, 'the host discovers the form through an exported Config')
  // `toJSON` is a ref graph (uid + `refs`), which is what the settings service
  // re-parses into the form schema.
  const json = Config.toJSON()
  const node = (ref) => json.refs[ref]
  const root = node(json.uid)
  assert.equal(root.type, 'object')
  assert.deepEqual(Object.keys(root.dict), ['engines'], 'the form shows the pool and nothing else')
  const engines = node(root.dict.engines)
  assert.equal(engines.meta.volatile, true)
  assert.equal(engines.type, 'array')
})

test('Config resolves the pool into a live reference, with the shipped default pool', async () => {
  const { Config } = await import('../src/index.mjs')
  const parsed = Config({ engines: ['sogou', 'yahoojp'] })
  assert.equal(typeof parsed.engines.get, 'function', 'a volatile field is read through get()')
  assert.deepEqual(parsed.engines.get(), ['sogou', 'yahoojp'])
  assert.deepEqual(Config({}).engines.get(), ['yahoojp', 'so360', 'sogou', 'wikipedia', 'duckduckgo'])
})

test('a schema-declared pool keeps undeclared row options working', async () => {
  const { Config, apply } = await import('../src/index.mjs')
  const config = Config({ engines: ['sogou'], verbose: true, acceptLanguage: 'ja' })
  assert.equal(config.verbose, true, 'unknown keys survive validation')
  assert.equal(config.acceptLanguage, 'ja')
  const search = []
  apply({
    logger: { info: () => {}, warn: () => {} },
    web: { registerSearchProvider: (provider) => search.push(provider), registerFetchProvider: () => {} },
  }, { ...config, fetch: false })
  assert.deepEqual(search[0].engines.map((engine) => engine.id), ['sogou'])
})

test('resolveEngines reads a volatile reference instead of falling back to defaults', () => {
  const ref = { get: () => ['sogou'] }
  assert.deepEqual(resolveEngines(ref).map((engine) => engine.id), ['sogou'])
})

test('the registered provider follows the pool live, without a remount', () => {
  // A volatile commit replaces the value behind the same reference: the provider
  // must pick it up on the next search, because the host does not remount the row.
  let pool = ['bing']
  const ref = { get: () => pool }
  const provider = mount({ engines: ref }, undefined).search[0]
  assert.deepEqual(provider.engines.map((engine) => engine.id), ['bing'])
  pool = ['sogou', 'wikipedia']
  assert.deepEqual(provider.engines.map((engine) => engine.id), ['sogou', 'wikipedia'])
})
