agent: sub-u009-recon

# u009 · bundle 插件的「客户端半边」+ GUI 配置写回（DSH 2.0.22-next，只读侦察）

路径别名（下文 `:123` 为行号）：
- `A` = `/nix/store/y2wmfk9l36iymkzvwzvpk57731nj4l1w-dsh-desktop-next-2.0.22-next-linux.1/lib/dsh-desktop-next/resources/app.asar`（asar 已用自写 header 解析器只读读取，无 `app.asar.unpacked` 里的 `@deepseek-ai` 源码）
- `R` = `/home/mypenfly/projects/dsh-plugins/free-web`
- `P` = `/home/mypenfly/.dsh/profiles/desktop`

## 0. 结论：最小实现方案（4 处改动，全部在 R 内）

| # | 文件 | 改什么 | 为什么 |
|---|---|---|---|
| 1 | `R/src/index.mjs` | 加 `import z from '@deepseek-ai/schemastery'` + `export const Config = z.object({ engines: z.array(z.string()).volatile(), … })`；读值改 `config.engines.get()` | 设置表单的 namespace **只暴露 `.volatile()` 字段**，`describe()` 只按 `entry.options.id` 出表单 |
| 2 | `R/src/client.js`（新，手写，**不需要构建**） | `window.__ModuleLoader__.load({id:'dsh-free-web', factory})`，模块导出 `{apply, inject}`，`apply` 里 `ctx.slots.register({name:'plugins.row.config', key:'dsh-free-web#free-web'}, EnginePicker)` | 槽 key = `<bundle 包名>#<patch row id>`；只有注册了这个 key，Plugins 页该行才出现「配置」入口 |
| 3 | `R/package.json` | `dsh.client = {platform:'web', inject:[…]}`、`exports["./client"] = "./src/client.js"`、`files` 加该文件、`dependencies` 加 `@deepseek-ai/schemastery@~3.19.0` | host 半边靠 `package.json` 的 `dsh.client` + `exports["./client"]` 发现并向浏览器供包 |
| 4 | 无（运行时） | 表单提交 `form.mutate([{op:'set', path:['engines'], value:[…]}], revision)` | 服务端把 volatile 字段写进 **profile 的 `cordis.patch.yml`**，并就地热更 |

一次性注意：`engines` 变 volatile 后 `config.engines` 是 `{get()}` 引用（不是数组），现有 `resolveEngines(config.engines)` 会当成非法值退回默认池，必须改读取方式（见 §6-1）。

## 1. Q1 客户端半边的打包/加载契约

- 声明字段在 **`package.json` 的 `dsh.client`**，不是 `dsh-plugin.json`：`A/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js:86 parseDshClient(pkgName, value)` 校验 `{platform: string(必填), inject?: string[], external?: string[], immediately?: boolean}`；`platform !== 'web'` 时 `resolveMeta` 直接返回 null（静默忽略）`:783`。
- 入口文件 = **`exports["./client"]`**，由 `clientExportOf(pkgName, exportsField)` 解析（接受字符串或 `{default: string}`）`:200`；再 `join(dirname(pkg.json), clientRel)` 得到绝对路径；缺文件抛 `MissingClientBundleError`（文案 `client-modules: client bundle not found; run pnpm run build before launch`）。
- 文件形态：**单文件、CJS-factory 注册式**，不是 ESM。执行只注册工厂，副作用延迟到 materialize：
  `window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => { var module={exports:{}}; …; return module.exports } })`
  官方实例见 `A/.../dsh-client-ui-plugin-manager/lib/client.js:1-5` 与文件尾 `exports.apply/ exports.inject`。工厂后的 module 面导出 `{apply(ctx), inject, …}`。
- 组合/加载：host 侧扫 Loader entries → 组 `window.__DSH_BOOT__` 图（`graphRow(...)`:458）→ 通过 `/plugins/??<pkg>/client.js&rev=…` combo 路由下发，注入 `<head>`（`bootInjections(graph)`:518，含 `__ModuleLoader__` 队列 facade）→ 浏览器 `ClientEntries` 按 `inject`/`external` 排序 `arrive`。
- 全局/外部约定：`resolveMeta` 只认 `dsh.client`；`dsh.client.external` 只能引用「平台基线表」之外的模块，基线表由外壳冻结（`A/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BgUyXZcc.js` 中 `staticModules: YZ()`，`function YZ(){return{react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, zod, @tanstack/react-virtual, @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit}}`）。`require('react/jsx-runtime')` 因此开箱可用，无需 external。
- 是否需要构建：官方用 tsdown 生成 `lib/client.js`（`A/.../dsh-client-modules/README.md:60` “host serves built client bundles … `pnpm run build` must have produced each `lib/client.js`”）。**对外部包不是硬要求**——`clientExportOf` 只按 exports 取任意相对路径，只要文件本身是上面的注册式即可。`lib/*.map` 可缺省（`readSourceMap` 对 ENOENT 返回 undefined，用 identity map 兜底 `:349`）。

## 2. Q2 客户端插件 API

- 入口导出：`apply(ctx)`（cordis 插件体）+ `inject`（**服务名**数组，如 `['slots','locale','configForms']`）。实例：`A/.../dsh-client-ui-settings-agent-loop/lib/client.js:233-265`。
- 能力面：`ctx.slots`（槽注册）、`ctx.locale`（字典）、`ctx.configForms`（设置表单）、`ctx.remote.*`（RPC）、`ctx.effect`。
- **`plugins.row.config` 槽**（这是本题要的那个）：
  - 声明方：`A/.../dsh-client-ui-plugin-manager/lib/client.js:7827` → `{ kind:'keyed', scope:'root' }`。
  - 契约（权威文档，含 ownerProps/example）：`A/.../dsh-cordis-client-runner/lib/client.js:5159-5190`：
    - 注册选项：`{ name:'plugins.row.config', key: string(必填) }`（keyed 槽无 `key` 直接抛 `keyed slot … requires options.key`，见 `A/.../dsh-client-ui-slots/lib/index.js:177`）；可选 `order/label/locale/inject/store/slots/priority`。
    - key 规则：``rowConfigKey(bundle, rowId) = `${bundle}#${rowId}` ``，即 **`dsh-free-web#free-web`**（`:88`）。
    - 组件 props（owner 给）：`PluginConfigViewProps = { view: 'summary' | 'page', form?: ConfigPageForm }`；`summary` 用作该行 oneliner 的回退，`page` 渲染表单本体（渲染点 `:5866` 与 `:5881`）。
    - `form` 实体：`PluginManagerPage` 的 `formFor(rowId)` → `{ state: form.getSnapshot(), mutate(ops, revision) }`（`:6933-6940`，`configForm: id => ctx.configForms.get(id)` 在 `:3186`）；`state` = `{status, value, base, user, revision, writable}`。
    - 入口何时出现：`configure.has(row) === true` 时才把行标题变成按钮（`:5426`），`has` 读的就是 `plugins.row.config` 的 key ledger（`:7015`）。点进去 = 该行的 `RowDetail` 页。
  - 同族槽（备选）：`plugins.item`（Official 组卡片 + 自有页面，官方 4 个设置页都用它）、`plugins.bundle.config`（整包级，key=包名，**不传 form**）。

## 3. Q3 配置写回路径（不在 plugin-manager，走 settings/config-editor）

链路（每一跳都有据）：
1. 浏览器：`ConfigFormController.mutate(ops, expectedRevision)` → `ctx.remote.settings.mutate(ns, ops, revision)`（`A/.../dsh-client-ui-settings/lib/client.js:1166-1171`）。`op` 只有 `{op:'set', path:[…], value}` / `{op:'unset', path:[…]}`；`set(['engines'], [...])` 是整值替换（`applyPathOp`，`A/.../dsh-settings/lib/index.js:190`）。
2. RPC：Remote namespace `settings`，方法 `describe | update | replace | mutate`；错误码 `settings/conflict`、`settings/rejected`（`A/.../dsh-api-settings-controller/lib/index.js:384, 316-349, 504`）。`ns` = **profile entry id**（即 `free-web`），`expectedRevision` 不符即 conflict，客户端会重读（`recover()`）。
3. host：`SettingsService.mutate(ns, ops, expectedRevision)` `:489` → `write(ns, change, expected, paths)` `:502`：要求 `entry` 存在、`runtime.Config` 存在（`"toJSON" in schema`）、且 `volatileForm(schema)` 非空（否则 `Plugin entry "free-web" has no volatile fields` `:507`），逐 path 校验 `isVolatilePath` `:509`，最后
4. `ctx.configEditor.edit(entry, change)`：`A/.../dsh-config-editor/lib/index.js:70`。它取 `documentPath`（= `profileContext.patchPath`，即 `P/cordis.patch.yml`，`:25`），持 `package.json` 文件锁，`reconcileProfilePatches` 后把 `config` 写进**最后一条匹配 `- id: free-web`（无 `insert`、`name` 相符）的 override**；没有就 `document.add({id, name, config})`（追加到序列尾）；若新值等于继承值则删掉 `config`、空壳行整条删除（`:95-107`）⇒ 天然支持「重置为默认即取消覆盖」。
5. 应用：Loader 判定 volatile-only 变更后**原地 commit**（`A/.../cordis-plugin-loader/lib/index.js:529-547 _commitVolatile`，`updateVolatile(ref, source)` 后 emit `loader/volatile-update`），fiber 不重启、不重挂。
6. 无 HMR 时写盘仍落 `cordis.patch.yml`，但返回 `restart-required`（`A/.../dsh-plugin-manager/README.md:41`）。本 profile 已 `"patchReload": "live"`（`P/package.json`），所以立即生效。
- 组合可用性已核对：`config-editor` / `settings` 是 `@deepseek-ai/dsh-base` bundle 的行（`A/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:106,110`，且以 `!!js "!ctx.get('profileContext')"` 门控，Desktop 有 profileContext ⇒ 开着）；`client-modules` / `client-hmr` / `client-ui-settings` / `client-ui-plugin-manager` 在 `A/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:225,215,304,316`。
- 关键可行性证据：`ui-settings`、`agent-loop`、`web`、`shell` 这些 namespace **本身就是 bundle patch 插入的行**，都能被表单编辑 ⇒ 我们的 `free-web`（同为 bundle patch 插入行）同样可编辑。`configEditor.entries()` 只保留**唯一寻址**的 profile 根 include 子条目（`:31-38`）。
- plugin-manager 本身**不写 config**：它只改 `disabled`、`dsh.profile.bundles`、装/卸（`A/.../dsh-plugin-manager/README.md:41`），没有 setConfig RPC。

## 4. Q4 现成样例（推荐抄哪一个）

1. **反面/正面对照最小骨架**：`A/.../dsh-client-ui-settings-agent-loop/`——`package.json:22-31` 是 `dsh.client` 声明样板；`lib/index.js` 是「空 `apply`，只为占一条 Loader 行」；`lib/client.js:236-265` 是 `apply` 全貌（`locale.register` → `configForms.get(ns)` → `ctx.effect(() => ctx.configForms.whileServed([ns], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({…inject: () => card.inject()}, Card))))`）；`lib/client.js:153-180` 是组件如何用 `props.view === 'summary'` 与 `SettingsForm` + 字段控件。
2. **「引擎/供应商选择」最贴近语义的样例**：`A/.../dsh-client-ui-settings-web-search/`（README「Use this package」段：开关一次性 stage `web.searchProvider`/`web.fetchProvider`，一次 Save 提交多个 ns）。它证明「把选择写回 `web` 行配置」就是这条链路。
3. 文件清单（我们的最小集）：`src/client.js`（新）、`src/index.mjs`（加 `Config`）、`package.json`（`dsh.client` / `exports["./client"]` / `files` / dep）。**不需要** `lib/types/*.d.ts`、不需要 tsconfig、不需要构建脚本。

## 5. Q5 验证手段（本会话 GUI 403，需要不点界面也能验）

已实测：`curl http://127.0.0.1:38533/` 与 `/plugins/dsh-free-web/client.js` 均 `403 Browser access is disabled` ⇒ 不能靠 HTTP 抓 boot HTML。

可行的 4 层验证：
1. **静态契约**（现在就能跑，我已对本仓库跑过一次：`dsh.client` ABSENT、`exports["./client"]` ABSENT、host 无 `Config`）：用 `node -e` 读 `package.json`，断言 `dsh.client.platform==='web'`、`exports["./client"]` 指向存在文件、文件首行含 `__ModuleLoader__.load`。
2. **Node 单测（不需要 GUI，最实用）**：`globalThis.window = {__ModuleLoader__:{load: r => reg = r}}`；`await import('./src/client.js')`；断言 `reg.id === 'dsh-free-web'`；`exports = reg.factory(spec => React)`（stub `react`/`react/jsx-runtime`，或用基线表里的同版本）；用假 ctx（`slots.register` 记录 options、`locale.register/bind`、`configForms.get` 返回带 `getSnapshot/mutate` 的桩）跑 `exports.apply(ctx)`，断言注册到 `{name:'plugins.row.config', key:'dsh-free-web#free-web'}`；再把 `{view:'page', form:{state:{value:{engines:['sogou']}, revision:3}, mutate}}` 作为 props 渲染/直调，断言 `mutate` 收到 `[{op:'set',path:['engines'],value:[…]},]` 与 revision。
3. **host 侧图**：重启后日志里 `client-modules` 组合失败会以 `ClientPackageCompositionError` 抛出（`A/.../dsh-client-modules/lib/index.js:619`），文案含 `package: <名>` + `path: <文件>`；成功则无输出。若要正面确认，写一条临时 `inject: ['clientModules']` 的探针插件打印 `ctx.clientModules.graph()`（`:636`），应看到 `{id:'dsh-free-web', url:'plugins/??dsh-free-web/client.js&rev=…', inject:[…]}`。不要长期驻留。
4. **写回生效**：GUI 保存后 `grep -n 'id: free-web' P/cordis.patch.yml` 应新增一条 `- id: free-web / name: dsh-free-web / config: {engines: […]}`；host 日志出现 `loader/volatile-update`（路径 `["engines"]`）而**没有**该插件的重挂行；清空勾选回默认值后该 override 应自动消失。
- 日志位置：`/home/mypenfly/.dsh/logs/desktop-next-*.jsonl`（已确认含我们插件自己的 `free-web: search provider …` 行）。浏览器侧审计文案：`web boot: N entries did not activate: <id>: import failed: <原因>` / `<id>: pending (waiting for services: …)`（`dsh-web-frontend/dist/assets/index-BgUyXZcc.js` 中 `qZ()`）。
- 重建后是否要重启：`client-hmr` 每 `pollIntervalMs`（默认 500ms）stat-poll 每个 graph row 的 bundle，变了就 `clientModules.rebuilt(id)` 并走 `/plugins/events` SSE 推送（`A/.../dsh-client-hmr/lib/index.js:13,50`）⇒ 改 `src/client.js` 后**刷新页面**即可；但 `package.json` 的 `dsh.client`/`exports` 变化只在 entry 重启或重连 reconcile 时生效（README 明确「A change confined to package.json is not detected」`A/.../dsh-hmr/README.md:110`）⇒ 改清单要重启 app（或 Plugins 页把 bundle 关/开一次）。

## 6. Q6 坑

1. **volatile 改变读值方式**：`.volatile()` 后 `config.engines` 是 `{get()}`（`A/.../schemastery/src/index.ts:166`；`Volatile.get(): VolatileSnapshot<T>` 只读、无 subscribe）。现在 `R/src/search/engines/index.mjs:79 resolveEngines(configured)` 收到引用会落到 `DEFAULT_ENGINES`。要么每次用前 `config.engines.get()`，要么订阅 `ctx.on('loader/volatile-update', …)` 重建 provider——否则「勾了不生效」。
2. **`dsh-plugin.json` 完全不被 host 读取**（全 asar grep `.json` 名零命中；`manifestVersion 0.15`、`facets.host` 对加载无影响）。客户端半边**不需要**在那里加 facet。`dsh.manifestVersion` 也「不强制」（`A/.../dsh-package-manifest/README.md:97`）。
3. **`platform` 必须精确 `'web'`**，拼错/写 `desktop` ⇒ 静默不供包（`resolveMeta` 返回 null），没有报错，最难查。
4. **注册 id 必须等于包名** `dsh-free-web`（graph row id = manifest 包名；id 不符则工厂无人认领，且 combo 不会重放注册）。
5. **`dsh.client` 写坏是全局事故**：`parseDshClient` 抛错会聚合进 `ClientPackageCompositionError`，在 `client-modules` 构造期抛出 ⇒ 整个 web client 不再出包（不只是我们的行）。
6. 需要 **`exports["./package.json"]`**（`locatePkgJson` 走 `createRequire.resolve('<name>/package.json')`），已有；`exports["./locale/*.json"]` 决定行的标题/描述（`readPluginMeta` 读 `locale/en.json` 的 `meta.title/meta.description`，`A/.../dsh-app-boot/lib/index.js:3007`），已有；`package.json.icon` 相对路径 <256KiB 且有 exports 兜底（`iconOf`），已有。
7. **TS 不是必需**；`files`/`exports` 只在「打包发布」时决定产物是否随包走（`link:` 依赖不看 `files`，但发到 registry 时必须加，否则浏览器侧 404/MissingClientBundle）。`exports` 子路径 `"./client"` 是**硬要求**，缺了报 `declares dsh.client but exports no "./client" bundle`。
8. bundle patch 与 client 入口的配合：patch 里 row 的 `name` 必须是包名（`dsh-free-web`，不是文件路径），否则 `resolveMeta` 的 `exactPackageSpecifier` 为 undefined ⇒ 不组包。当前 `R/cordis.patch.yml` 已正确用裸包名。
9. 槽 props 的 `form` **可能 undefined**（ns 未被 Host served，例如插件行未激活）。组件必须容忍，否则 `props.form.state` 抛错会让整行变成 render error。
10. 首次写盘是**追加**一条 `- id: free-web`：本 profile 现在的 `P/cordis.patch.yml` 里没有 `free-web` override（已 grep 确认），追加在文件尾 = 最后一层，优先级最高；这与「bundle patch 里的初始 `engines`」形成覆盖关系，回退就是删该条。

## 7. 未找到 / 已排除

- 未找到任何「plugin-manager 写行 config」的 RPC（已排除：`dsh-plugin-manager` 全部方法、`dsh-client-ui-plugin-manager/lib/client.js` 的 `pluginManager/*` 面）——写配置的唯一 seam 是 settings/config-editor。
- 未找到「按 schema 自动生成 UI」的已发货客户端（`dsh-settings/README.md` 明说 `autoGenerate` 默认 true 但 *no shipped client does so yet*）⇒ 必须自写组件。
- 未找到可用的 HTTP/SSE 旁路来在无 GUI 时读 boot 图（`403 Browser access is disabled`，`/plugins/*` 同样 403）。
- 未找到 `ConfigPageForm` 的类型定义文件（asar 里不发布 `lib/types/*.d.ts`）；其形状由 `plugin-manager` 的 `formFor()` 与消费方 `props.form.state/.mutate` 反推，见 §2。
- 本会话未运行任何 `dsh` CLI / dev server（约束禁启动服务）；结论均来自 asar 源码与 profile 文件。
