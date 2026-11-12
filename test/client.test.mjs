/**
 * Browser half contract, without a browser.
 *
 * `src/client.js` is a classic-script bundle: it calls
 * `window.__ModuleLoader__.load({ id, factory })` and only registers a factory.
 * This test stands in for the shell — it installs that facade, materializes the
 * factory with stub modules, and drives the registered component through the
 * same props the Plugins page passes (`{ view, form }`).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

/** The row key the Plugins page dispatches: `<package name>#<row id>`. */
const ROW_KEY = 'dsh-free-web#free-web'

/**
 * Minimal React stand-in: state cells, dependency-checked effects, and a
 * `createElement` that returns plain nodes. Enough to re-render one function
 * component and to reach the controls it returns.
 *
 * @returns {{React: object, mount: Function}}
 */
function createStubReact() {
  let active = null

  const draw = (record) => {
    active = record
    record.cursor = 0
    const effects = record.pending
    record.pending = []
    const tree = record.Component(record.props)
    for (const effect of effects) effect()
    return tree
  }

  const redraw = (record) => {
    record.holder.tree = draw(record)
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const record = active
      const index = record.cursor++
      if (!(index in record.cells)) record.cells[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(record.cells[index]) : next
        if (Object.is(value, record.cells[index])) return
        record.cells[index] = value
        redraw(record)
      }
      return [record.cells[index], set]
    },
    useEffect(effect, list) {
      const record = active
      const index = record.cursor++
      const previous = record.deps[index]
      const changed = previous === undefined
        || list === undefined
        || list.length !== previous.length
        || list.some((value, at) => !Object.is(value, previous[at]))
      record.deps[index] = list
      if (changed) record.pending.push(effect)
    },
  }

  /**
   * Mount a function component and keep its latest tree available.
   *
   * @param {Function} Component component to render
   * @param {object} props its props
   * @returns {{tree: object}} holder whose `tree` follows every state change
   */
  const mount = (Component, props) => {
    const record = { Component, props, cells: [], deps: [], pending: [], cursor: 0, holder: { tree: null } }
    record.holder.tree = draw(record)
    return record.holder
  }

  return { React, mount }
}

/** Walk a stub element tree, collecting nodes whose `type` matches. */
function collect(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  collect(node.children, predicate, found)
  return found
}

/** Flatten the text of a rendered node. */
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node === null || node === undefined) return ''
  if (typeof node !== 'object') return String(node)
  return text(node.children)
}

/** Load the bundle once: register the facade, then materialize the factory. */
let bundle
async function loadBundle() {
  if (bundle !== undefined) return bundle
  let registration
  globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
  await import('../src/client.js')
  assert.ok(registration !== undefined, 'bundle must register through window.__ModuleLoader__.load')
  const { React, mount } = createStubReact()
  const primitives = {
    Button: function Button(props) { return props },
    Checkbox: function Checkbox(props) { return props },
  }
  const modules = { react: React, 'react/jsx-runtime': {}, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  const materialized = registration.factory((id) => {
    if (id in modules) return modules[id]
    throw new Error(`require("${id}") missed the module table`)
  })
  bundle = {
    registration,
    materialized,
    mount,
    primitives,
    dictionaries: materialized.__test.dictionaries,
    translate: (key) => materialized.__test.dictionaries.en[key] ?? key,
  }
  return bundle
}

/** A plugin context stub that records what the browser half registers. */
function contextStub() {
  const record = { dictionaries: [], served: [], slots: [], effects: [] }
  const ctx = {
    locale: {
      bind: (ns) => (key) => key,
      register: (ns, dictionaries) => { record.dictionaries.push({ ns, dictionaries }); return () => {} },
    },
    configForms: {
      whileServed: (namespaces, run) => { record.served.push(namespaces); return run() },
    },
    slots: {
      inject: (name, run) => run(),
      register: (options, component) => { record.slots.push({ options, component }); return () => {} },
    },
    effect: (run, label) => { record.effects.push(label); return run() },
  }
  return { ctx, record }
}

/** Run `apply` against a fresh context and hand back what it registered. */
function registrationOf(materialized) {
  const { ctx, record } = contextStub()
  materialized.apply(ctx)
  return record
}

/** The component the browser half registered into `plugins.row.config`. */
function registeredComponent(materialized) {
  const record = registrationOf(materialized)
  assert.equal(record.slots.length, 1)
  return record.slots[0].component
}

/** A form stub shaped like the page's `formFor()` result. */
function formStub(overrides = {}) {
  const calls = []
  const state = {
    status: 'ready',
    value: { engines: ['yahoojp', 'sogou'] },
    base: { engines: ['yahoojp', 'sogou'] },
    user: {},
    revision: 7,
    writable: true,
    ...overrides.state,
  }
  const form = {
    state,
    mutate(ops, revision) {
      calls.push({ ops, revision })
      return Promise.resolve({ revision: revision + 1 })
    },
  }
  return { form, calls }
}

/** Render the row page and keep the live tree. */
async function renderPage(formOverrides = {}) {
  const loaded = await loadBundle()
  const { form, calls } = formStub(formOverrides)
  const Component = registeredComponent(loaded.materialized)
  const holder = loaded.mount(Component, { view: 'page', form, t: loaded.translate })
  return { ...loaded, form, calls, holder, page: () => holder.tree }
}

/** Find the checkbox a given engine renders. */
function checkbox(page, loaded, label) {
  return collect(page, (node) => node.type === loaded.primitives.Checkbox && node.props.label === label)[0]
}

/** Find a button by its label. */
function button(page, loaded, label) {
  return collect(page, (node) => node.type === loaded.primitives.Button && text(node.children) === label)[0]
}

// --- contract --------------------------------------------------------------

test('the bundle registers a factory under the package name', async () => {
  const { registration, materialized } = await loadBundle()
  assert.equal(registration.id, 'dsh-free-web')
  assert.equal(typeof registration.factory, 'function')
  assert.equal(typeof materialized.apply, 'function')
  assert.deepEqual(materialized.inject, ['slots', 'locale', 'configForms'])
})

test('apply registers the row configuration under <pkg>#<row id> while the namespace is served', async () => {
  const { materialized } = await loadBundle()
  const record = registrationOf(materialized)
  assert.deepEqual(record.served, [['free-web']], 'the entry must wait on the row namespace')
  const [{ options }] = record.slots
  assert.equal(options.name, 'plugins.row.config')
  assert.equal(options.key, ROW_KEY)
  assert.equal(options.locale, 'freeWeb')
  assert.equal(record.dictionaries.length, 1)
  assert.equal(record.dictionaries[0].ns, 'freeWeb')
  for (const language of ['en', 'zh']) {
    assert.ok(record.dictionaries[0].dictionaries[language].title, `${language} dictionary renders a title`)
  }
})

// --- rendering -------------------------------------------------------------

test('the page renders one checkbox per shipped engine with the stored pool checked', async () => {
  const { page, holder, primitives } = await renderPage()
  const boxes = collect(holder.tree, (node) => node.type === primitives.Checkbox)
  assert.equal(boxes.length, 8, 'every shipped engine has a checkbox')
  const checked = boxes.filter((node) => node.props.checked).map((node) => node.props.label)
  assert.deepEqual(checked.sort(), ['Sogou', 'Yahoo! Japan'])
  assert.equal(page().props['data-free-web-status'], 'idle')
})

test('a row without a served form renders a pointer instead of crashing', async () => {
  const { materialized, translate } = await loadBundle()
  const Component = registeredComponent(materialized)
  const page = Component({ view: 'page', form: undefined, t: translate })
  assert.match(text(page), /no configuration surface/)
})

test('the summary view is one line naming the pool', async () => {
  const { materialized, translate } = await loadBundle()
  const Component = registeredComponent(materialized)
  const { form } = formStub()
  const summary = Component({ view: 'summary', form, t: translate })
  assert.match(text(summary), /yahoojp, sogou/)
})

// --- writing back ----------------------------------------------------------

test('toggling an engine stages the pool and Save writes it with the current revision', async () => {
  const { holder, calls, primitives, page } = await renderPage()
  assert.equal(button(holder.tree, bundle, 'Save').props.disabled, true, 'nothing to save before an edit')

  checkbox(holder.tree, bundle, 'Sogou').props.onChange(false)
  const save = button(page(), bundle, 'Save')
  assert.equal(save.props.disabled, false, 'an edit enables Save')
  save.props.onClick()
  assert.deepEqual(calls, [{ ops: [{ op: 'set', path: ['engines'], value: ['yahoojp'] }], revision: 7 }])

  await Promise.resolve()
  await Promise.resolve()
  assert.equal(page().props['data-free-web-status'], 'saved')
  void primitives
})

test('Restore defaults drops the override instead of writing a value', async () => {
  const { holder, calls, page } = await renderPage({ state: { user: { engines: ['sogou'] } } })
  const reset = button(holder.tree, bundle, 'Restore defaults')
  assert.equal(reset.props.disabled, false)
  reset.props.onClick()
  assert.deepEqual(calls, [{ ops: [{ op: 'unset', path: ['engines'] }], revision: 7 }])
  assert.ok(page() !== null)
})

test('Restore defaults is disabled when this profile holds no override', async () => {
  const { holder } = await renderPage()
  assert.equal(button(holder.tree, bundle, 'Restore defaults').props.disabled, true)
})

test('an empty pool cannot be saved and says why', async () => {
  const { holder, page } = await renderPage({ state: { value: { engines: ['sogou'] } } })
  checkbox(holder.tree, bundle, 'Sogou').props.onChange(false)
  assert.equal(button(page(), bundle, 'Save').props.disabled, true)
  assert.match(text(page()), /Keep at least one engine/)
})

test('an engine id this build does not ship survives a save', async () => {
  const { translate, materialized } = await loadBundle()
  const Component = registeredComponent(materialized)
  const { form, calls } = formStub({ state: { value: { engines: ['yahoojp', 'google'] } } })
  const holder = bundle.mount(Component, { view: 'page', form, t: translate })
  assert.match(text(holder.tree), /unknown engine kept: google/)
  checkbox(holder.tree, bundle, 'Sogou').props.onChange(true)
  button(holder.tree, bundle, 'Save').props.onClick()
  assert.deepEqual(
    calls,
    [{ ops: [{ op: 'set', path: ['engines'], value: ['yahoojp', 'sogou', 'google'] }], revision: 7 }],
  )
})

test('the pool helpers keep catalog order and unknown ids', async () => {
  const { materialized } = await loadBundle()
  const { orderEngines, toggleEngine, unknownEngines, samePool } = materialized.__test
  assert.deepEqual(orderEngines(['sogou', 'google', 'yahoojp']), ['yahoojp', 'sogou', 'google'])
  assert.deepEqual(toggleEngine(['yahoojp', 'sogou'], 'sogou'), ['yahoojp'])
  assert.deepEqual(toggleEngine(['yahoojp'], 'sogou'), ['yahoojp', 'sogou'])
  assert.deepEqual(unknownEngines(['yahoojp', 'google']), ['google'])
  assert.equal(samePool(['a', 'b'], ['a', 'b']), true)
  assert.equal(samePool(['a'], ['a', 'b']), false)
})

// --- packaging contract -----------------------------------------------------

test('package.json declares a web client bundle the shell can serve', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web', 'only platform "web" packages get a boot row')
  assert.deepEqual(pkg.dsh.client.inject, ['slots', 'locale', 'configForms'])
  const entry = pkg.exports['./client']
  assert.equal(typeof entry, 'string', 'clientExportOf accepts a string export')
  const path = new URL(`../${entry.replace(/^\.\//, '')}`, import.meta.url)
  assert.ok(existsSync(path), `client bundle missing at ${entry}`)
  assert.ok(pkg.files.some((dir) => entry.startsWith(`./${dir}/`)), 'the bundle ships with the package')
})

test('the bundle is a classic script: it compiles as one and registers under the package name', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  // `dsh-client-modules` loads this through a plain <script src>: an import
  // statement would be a parse error, so compiling as a classic script is the gate.
  const script = new vm.Script(source, { filename: 'dsh-free-web/client.js' })
  let registration
  const sandbox = { window: { __ModuleLoader__: { load: (entry) => { registration = entry } } } }
  script.runInNewContext(sandbox)
  assert.equal(registration.id, 'dsh-free-web', 'the registration id is the package name')
  assert.equal(typeof registration.factory, 'function')
})
