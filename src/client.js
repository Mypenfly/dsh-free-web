/**
 * dsh-free-web — browser half: the engine picker on this row's Plugins page.
 *
 * The host half registers the providers; this half only edits the pool. It is a
 * pre-registered classic-script bundle, not an ES module: `dsh-client-modules`
 * serves `exports["./client"]` through a plain `<script src>`, so a top-level
 * `import` would not parse. The script registers a factory under the package
 * name and the body runs when the shell materializes it.
 *
 * What it registers: one `plugins.row.config` entry, keyed
 * `<package name>#<row id>` = `dsh-free-web#free-web`. That key is what turns the
 * row's title into a **Configure** control in the Plugins page; without it the
 * page has no configuration surface for the row at all.
 *
 * Where an edit lands: `form.mutate()` → settings → the profile's
 * `cordis.patch.yml`, as a `- id: free-web` overlay carrying `config.engines`.
 * The bundle patch keeps its own default list, so dropping the overlay (the
 * Restore defaults button, or deleting the entry) returns to it.
 */

window.__ModuleLoader__.load({
  id: 'dsh-free-web',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { Button, Checkbox } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Profile row id this entry configures; the slot key is `<pkg>#<row id>`. */
    const ROW_ID = 'free-web'
    /** Package name, which is also the Loader module id the shell dispatches. */
    const PKG = 'dsh-free-web'
    /** Key the Plugins page dispatches for this row's page. */
    const ROW_KEY = `${PKG}#${ROW_ID}`
    /** Settings namespace == the profile entry id the host serves. */
    const NS = ROW_ID
    /** Dictionary namespace owned by this browser half. */
    const LOCALE_NS = 'freeWeb'

    /**
     * Engine ids this build ships, in catalog order, with the copy the picker
     * shows. The host half is the authority on what actually runs: an id here
     * that the host no longer ships costs one warning there, and an id there
     * that is unknown here is still preserved by the picker.
     */
    const CATALOG = [
      { id: 'yahoojp', label: 'Yahoo! Japan', hint: 'Japanese index; steady from most egress IPs.' },
      { id: 'so360', label: '360 Search', hint: 'Chinese index; plain HTML result page.' },
      { id: 'sogou', label: 'Sogou', hint: 'Chinese index; plain HTML result page.' },
      { id: 'wikipedia', label: 'Wikipedia', hint: 'Full-text article search; no destination snippets.' },
      { id: 'duckduckgo', label: 'DuckDuckGo', hint: 'HTML endpoint; only answers with a referer.' },
      { id: 'bing', label: 'Bing', hint: 'Frequently a decoy page or a 429 from datacenter IPs.' },
      { id: 'brave', label: 'Brave Search', hint: 'Proof-of-work challenge on some networks.' },
      { id: 'baidu', label: 'Baidu', hint: 'CAPTCHA-prone; direct URLs exist only some days.' },
    ]

    const en = {
      title: 'Search engines',
      hint: 'web_search asks these engines in parallel and fuses the results by rank. Remove one to drop it from the pool; one engine failing down is expected and not an error.',
      empty: 'Keep at least one engine — with none selected the search provider stays unmounted.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The new pool is live.',
      reset: 'Restore defaults',
      resetHint: 'Removes this profile’s override; the bundle’s own pool applies again.',
      restarted: 'Saved. Restart the app to apply it.',
      conflict: 'Someone else changed this row; the form reloaded. Check the list and save again.',
      failed: 'Could not save.',
      loading: 'Loading configuration…',
      unavailable: 'This row has no configuration surface right now. Open Plugins → dsh-free-web → free-web again, or edit the profile patch directly.',
      unknownOne: 'unknown engine kept: ',
      unknownMany: 'unknown engines kept: ',
      selected: 'selected',
    }

    const zh = {
      title: '搜索引擎',
      hint: 'web_search 会并行请求这些引擎，并按排名融合结果。取消勾选即从引擎池移除；单个引擎失败是预期内的降级，不算错误。',
      empty: '至少保留一个引擎——全部取消后搜索提供方不会挂载。',
      save: '保存',
      saving: '正在保存…',
      saved: '已保存，新的引擎池已生效。',
      reset: '恢复默认',
      resetHint: '删除本 profile 的覆盖项，回到组合包自带的引擎池。',
      restarted: '已保存。重启应用后生效。',
      conflict: '该行已被他人修改，表单已重新载入。请确认列表后再次保存。',
      failed: '保存失败。',
      loading: '正在读取配置…',
      unavailable: '该行当前没有可用的配置界面。请重新打开 插件 → dsh-free-web → free-web，或直接编辑 profile patch。',
      unknownOne: '保留了未知引擎：',
      unknownMany: '保留了未知引擎：',
      selected: '已选',
    }

    /** Catalog ids, in the order the picker renders them. */
    const KNOWN_IDS = CATALOG.map((engine) => engine.id)

    /**
     * Order a pool the way the picker shows it, keeping ids this build does not
     * know about (a newer host, or a hand-edited patch) instead of silently
     * dropping them on the next save.
     *
     * @param {string[]} ids engine ids in any order
     * @returns {string[]} catalog order first, then the unknown ids as given
     */
    function orderEngines(ids) {
      const wanted = new Set(ids)
      const ordered = KNOWN_IDS.filter((id) => wanted.has(id))
      for (const id of ids) if (!KNOWN_IDS.includes(id) && !ordered.includes(id)) ordered.push(id)
      return ordered
    }

    /**
     * Add or remove one engine, preserving `orderEngines` order.
     *
     * @param {string[]} current pool before the click
     * @param {string} id engine to toggle
     * @returns {string[]} pool after the click
     */
    function toggleEngine(current, id) {
      const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
      return orderEngines(next)
    }

    /** Ids in `current` this build has no catalog entry for. */
    function unknownEngines(current) {
      return current.filter((id) => !KNOWN_IDS.includes(id))
    }

    /** Whether two pools hold the same ids. */
    function samePool(left, right) {
      return left.length === right.length && left.every((id, index) => id === right[index])
    }

    /**
     * Render the row's configuration: a checkbox per engine, Save, and Restore
     * defaults. The page owns the title, icon, and crumb; this draws the body.
     *
     * @param {object} props slot props — `view`, `form` (owner-supplied), `t`
     */
    function EnginePicker(props) {
      const { view, form, t } = props
      const state = form === undefined ? undefined : form.state
      const value = state !== undefined && Array.isArray(state.value?.engines) ? state.value.engines : undefined
      const revision = state === undefined ? 0 : state.revision
      const [draft, setDraft] = React.useState(null)
      const [status, setStatus] = React.useState('idle')

      // A new revision means the host answered (our save, someone else's write,
      // or a reload): drop the staged pool so the checkboxes show what is stored.
      React.useEffect(() => {
        setDraft(null)
        setStatus('idle')
      }, [revision])

      if (view === 'summary') {
        const count = value === undefined ? 0 : value.length
        return count === 0 ? t('unavailable') : `${t('title')}: ${value.join(', ')}`
      }
      if (form === undefined || state === undefined) return React.createElement('p', null, t('unavailable'))
      if (state.status !== 'ready') {
        return React.createElement('p', null, t('loading'))
      }

      const stored = value ?? []
      const current = draft ?? stored
      const dirty = draft !== null && !samePool(draft, stored)
      const unknown = unknownEngines(current)
      const busy = status === 'saving'

      const write = (ops) => {
        setStatus('saving')
        Promise.resolve(form.mutate(ops, revision)).then(
          () => setStatus('saved'),
          (error) => setStatus(error?.code === 'settings/conflict' ? 'conflict' : 'failed'),
        )
      }

      const rows = CATALOG.map((engine) => React.createElement(
        'div',
        { key: engine.id, 'data-engine': engine.id, style: { display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '10px' } },
        React.createElement(Checkbox, {
          checked: current.includes(engine.id),
          disabled: busy || state.writable === false,
          label: engine.label,
          onChange: () => setDraft(toggleEngine(current, engine.id)),
        }),
        React.createElement('span', { style: { opacity: 0.7, fontSize: '12px' } }, engine.hint),
      ))

      const footer = [
        React.createElement(Button, {
          key: 'save',
          variant: 'primary',
          disabled: busy || !dirty || current.length === 0 || state.writable === false,
          onClick: () => write([{ op: 'set', path: ['engines'], value: current }]),
        }, busy ? t('saving') : t('save')),
        React.createElement(Button, {
          key: 'reset',
          variant: 'outline',
          disabled: busy || state.user?.engines === undefined || state.writable === false,
          title: t('resetHint'),
          onClick: () => write([{ op: 'unset', path: ['engines'] }]),
        }, t('reset')),
      ]

      const notices = []
      if (current.length === 0) notices.push(t('empty'))
      if (unknown.length > 0) notices.push(`${unknown.length === 1 ? t('unknownOne') : t('unknownMany')}${unknown.join(', ')}`)
      if (status === 'saved' || status === 'restarted') notices.push(t(status))
      if (status === 'conflict') notices.push(t('conflict'))
      if (status === 'failed') notices.push(t('failed'))

      return React.createElement(
        'div',
        { 'data-free-web': ROW_ID, 'data-free-web-status': status, style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        React.createElement('div', null,
          React.createElement('h4', { style: { margin: '0 0 6px' } }, t('title')),
          React.createElement('p', { style: { margin: '0', opacity: 0.75, fontSize: '12px' } }, t('hint')),
        ),
        React.createElement('div', null, rows),
        ...notices.map((notice, index) => React.createElement(
          'p',
          { key: `notice-${index}`, style: { margin: '0', fontSize: '12px' } },
          notice,
        )),
        React.createElement('div', { style: { display: 'flex', gap: '8px' } }, footer),
      )
    }

    /** Required client services: the slot registry, dictionaries, and the form store. */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Mount the row configuration while the host serves this row's namespace.
     *
     * `whileServed` is what keeps the Configure control honest: the entry exists
     * only while the host still has a form for `free-web`, so a row that failed
     * to mount shows no control instead of an empty page.
     *
     * @param {object} ctx browser plugin context
     */
    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { en, zh }),
        'free-web: dictionaries',
      )
      ctx.effect(
        () => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: LOCALE_NS,
        }, EnginePicker))),
        'free-web: row configuration',
      )
    }

    exports.apply = apply
    exports.inject = inject
    /** Test seam: pure helpers the picker is built from. */
    exports.__test = { CATALOG, ROW_KEY, NS, LOCALE_NS, orderEngines, toggleEngine, unknownEngines, samePool, dictionaries: { en, zh } }
    return module.exports
  },
})
