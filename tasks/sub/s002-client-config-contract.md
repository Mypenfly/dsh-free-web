# s002 — interim: client module format / host config declaration / form+save contract

- agent: sub-s002 · date 2026-11-12 · target: running desktop DSH 2.0.22-next (dshVersion 0.2.2-rc.1)
- source of truth: `resources/app.asar` (read-only store path); packages extracted to `.dsh/refs/pkg/node_modules/@deepseek-ai/`
- extraction helper: `/tmp/asarx.py` (asar header parse + per-prefix extract); file list at `.dsh/refs/asar/list.txt`

## 1. client entry format — factory-form CJS only (no ESM)

- scan gate: only `dsh.client.platform === "web"` packages get a boot row.
  `dsh-client-modules/lib/index.js:790` `if (decl === void 0 || decl.platform !== "web") return null;`
- `exports["./client"]` accepts string or one-level `{ default }`:
  `dsh-client-modules/lib/index.js:200-210 clientExportOf()`
- transport is a **classic script**, so `import` statements are a parse error:
  `dsh-client-modules/lib/client.js:580-594 defaultLoadBundle()` creates `<script>`, sets `.src`, no `type=module`
- execution contract: the script only registers; body runs at materialization.
  `client.js:703-720 register()` → `factories.set(registration.id, {factory})` (id = package name, trailing `/client` stripped)
  `client.js:805-824 materialize()` → `registered.factory(this.makeRequire(ownerId, edges))`
  `client.js:756-762 arrive()` fails the row with `loaded without registering "<id>" via __ModuleLoader__.load`
- boot facade: `dsh-client-modules/lib/index.js:521-568` installs `window.__ModuleLoader__ = {mode:'queue', load, create}`; `create(options)` → `createClientModuleSystem(...,{id,exports},options)`
- `require` resolution (no import map, fixed table):
  `client.js:836-843`: seed → memoized record → registered factory → throw `require("<spec>") missed the module table`
  seed whitelist injected by the shell: `.dsh/refs/pkg/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BgUyXZcc.js` (`YZ()`)
  ```js
  {react, "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis", zod,
   "@tanstack/react-virtual", "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots",
   "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit"}
  ```
  plus `require.asset(ref)` and `require.async("./client.<chunk>.js")` for package-local chunks (`client.js:846-856`).
- second, different format: dynamic packages via cordis runner ship a **source-string closure**, not a module:
  `dsh-cordis-client-runner/lib/client.js:308-343 evaluateClientHalf()` → `new Function("React","console","styles","host","harness",…, "return (async()=>{…})()")`
  then `:714-720 sink.load({id: moduleId, factory: () => surface})`.
- consequence for us: a normal (profile-row) plugin's `exports["./client"]` must be a pre-bundled factory bundle; ESM output from tsdown/esbuild would be served as a classic script and fail to register.

## 2. host declares editable config — cordis `Config` schema, auto-exported

- no `ctx.settings.register`: `SettingsForms.describe()` walks **every active loader entry** and reads its plugin runtime's `Config`:
  `dsh-settings/lib/index.js:409-450` `this.ownerContext.configEditor.configuration().flatMap(...)`; ns = `entry.options.id`
  `dsh-settings/lib/index.js:538-541` `schema(entry) = entry.fiber?.runtime?.Config`
- only `.volatile()` nodes are projected into the form (the "editable" marker):
  `dsh-settings/lib/index.js:122-134 volatileForm()`, `:153-160 isVolatilePath()`; secrets keep `role('secret')`
- canonical host example (also the page our plan imitates):
  `dsh-web-search-deepseek/lib/index.js:277-285`
  ```js
  const Config = z.object({ apiKey: z.string().role("secret").volatile(),
    baseURL: z.string().volatile(), maxUses: z.number().step(1).min(1).default(5).volatile() })
  ```
- `ctx.settings.configure({auto})` (`dsh-settings/lib/index.js:370-385`) only controls automatic-page policy, not the namespace.
- client side is a *consumer* service provided by `dsh-client-ui-settings`:
  `dsh-client-ui-settings/lib/client.js:1252-1310 ConfigForms` (`describe/get/whileServed`), `super(ctx,"configForms")`
- how a page gets attached: companion client package registers `plugins.item` gated by served namespaces —
  `dsh-client-ui-settings-web-search/lib/client.js:710-721`
  `ctx.configForms.whileServed([WEB_SEARCH_NS], () => ctx.slots.register({name:"plugins.item", id:"web-search", order:20, …}, WebSearchCard))`
- four official pages = the four `plugins.item` occupants, one host namespace each:
  shell → `bash-sandbox`/`pwsh-sandbox`; agent-loop → `agent-loop`; subagent → `subagent`; web-search → `web-search-deepseek` (+`web`,`web-deepseek-api`).
- host row on disk = profile patch row: `~/.dsh/profiles/desktop/cordis.patch.yml` `- id: <entry id>` + `config: {…}`; ns seen by the client is exactly that `id`.

## 3. form contract + save target

- snapshot (`getSnapshot()`), `dsh-client-ui-settings/lib/client.js:1080-1130, 1210-1245`:
  `{ status: 'loading'|'ready'|'unavailable', value, base, user, revision, writable }`
  `value` = effective (user over base over schema default), `base` = composition/inherited layer, `user` = this profile's override section.
- `mutate(ops, expectedRevision)` `client.js:1165-1200`:
  serialized queue; revision = `expectedRevision ?? pendingRevision ?? snapshot.revision`; answer folds into the shared mirror, refusal → re-read and keep the user's drafts.
- ops are path edits over the stored section, `dsh-settings/lib/index.js:488-501`:
  `{op:'set', path:['a','b'], value}` / `{op:'unset', path:[…]}`; unset on object = restore inherited value (delete when no base); unset on array index = splice element; `path` non-empty, ordered.
- write chain: client → `ctx.remote.settings.mutate` (`dsh-api-settings-controller/lib/index.js:433-475`) → `SettingsForms.mutate` → `configEditor.edit` → YAML rewrite of the profile patch
  `dsh-config-editor/lib/index.js:24-26` `documentPath = profileContext.patchPath`; `:69-110` find/insert row by `id`+`name`, set `config`, atomic write, then `reconcileProfilePatches` hot-applies (volatile field, no remount).
  `patchPath` = `<profile dir>/cordis.patch.yml`, `dsh-app-boot/lib/index.js:1327 PROFILE_PATCH_FILENAME`, `:1822`.
- render stack for a custom page (what the four official ones use):
  - page prop from plugin-manager: `form = { state: form.getSnapshot(), mutate(ops, rev) }` — `dsh-client-ui-plugin-manager/lib/client.js:6930-6936`
  - controller + staged form: `new SettingsFormModel(ctx.configForms.get(ns), [settingsNumberField('x'), settingsTextField('y')])`, `.bind(projection)`, `.shell()`, `.field(name)`, `.actions()` — `dsh-client-ui-primitives/lib/index.js:6181-6400`
  - components: `SettingsForm`, `SettingsValueField`, `SettingsSecretField` (`:5948`, `:6003`), fields `settingsNumberField` / `settingsTextField` (`:6140`, `:6165`)
  - only save writes: `save()` builds ops from staged drafts and calls `scope.mutate(ops, baseline.revision)` (`:6300-6320`, `:6345-6385`); empty draft → `unset`; unchanged vs effective → no op.

## open items (next pass)

- exact build recipe for the client bundle (tsdown client preset, externals list) and how the repo's own `free-web` plugin would declare `dsh.client`/`exports`.
- whether a bundle with multiple rows gives each row its own ns (row id) — implied by `entry.options.id`, verify with a real 2-row bundle.
- presentation `{auto:false}` behavior in the Plugins page (what disappears) for a plugin that ships only a custom page.
