# DECISIONS

## d001 (2026-11-11) — 用 ctx.web provider seam 接管，而不是替换/新增工具
- decision: 插件实现 WebSearchProvider / WebFetchProvider 注册进 `ctx.web`，把 `web.searchProvider` 指到自己的 id。
- why: 宿主把 web 能力拆成 tool 层与 provider 层；工具名、schema、`tool:web_search` 提示词段都由 provider 无关的 tool-web 拥有。占 provider 位即可零提示词、零工具增量地换实现。
- cost: 必须改一行配置（patch 或 `DSH_WEB_SEARCH_PROVIDER`）；`web` 行的 settings scope 可覆盖 patch。
- rollback: 删 patch 两行。
- supersedes: none

## d002 (2026-11-11) — 免费搜索走多引擎抓取，不挂 free-search-mcp 的 MCP
- decision: 自己实现 yahoojp/so360/sogou/wikipedia（+可选 bing/brave/baidu）引擎，RRF 融合。
- why: MCP 客户端会把工具注册进 `ctx.tools`，就是「新增工具」，与需求冲突；而 Python/uvx 依赖在本机不是必然存在。引擎协议本身很薄（URL + 正则）。
- cost: 选择器随引擎改版会坏；已用 fixture 测试 + 熔断 + 诱饵页门兜底。
- rollback: 换掉 `engines` 配置即可回退到单引擎。
- supersedes: none

## d003 (2026-11-11) — fetch 沿用官方安全策略，只增强正文提取
- decision: 同源重定向（跨源 `WEB_REDIRECT_BLOCKED`）、5 跳上限、私网/环回/CGNAT 拒绝、同类错误码；差异仅在 HTML→正文 Markdown 提取。
- why: 重定向跨源与 SSRF 是安全契约，插件无权单方面放宽；用户要的是「完善的 fetch 体验」，噪音是主要痛点。
- cost: 无法做 DNS pinning（需要 undici dispatcher 的 lookup），改用请求前 DNS 预检；已知残余 DNS rebinding 风险在 README 里写明。
- rollback: 把 `web.fetchProvider` 改回 `http`。
- supersedes: none

## d004 (2026-11-11) — 传输层自建（Node core），不再借宿主全局 fetch
- decision: 新增 `src/util/transport.mjs` + `proxy.mjs` + `address.mjs`，用 `node:http`/`node:https`/`node:tls`/`node:zlib` 直连或经 env 代理；直连做 DNS 预检并把验证过的地址 pin 进 socket；每次调用只走一跳，重定向留给调用方逐跳校验。
- why: 宿主 `fetch` 背后的 undici dispatcher 不是可导入的 seam（插件只能拿模块，拿不到 dispatcher），既拿不到 `lookup` 也就无法闭合 rebinding 窗口；而本机必须经 `127.0.0.1:7897` 才能出网，自建传输必须自己实现 env 代理（CONNECT + TLS、absolute-form）与 gzip/deflate/br 解码。
- cost: 多维护一套 HTTP 客户端（约 500 行 + 18 个离线用例）；`socks*://` 不实现，配了也走直连；TLS-over-tunnel 无本地证书可测，靠活网 smoke 覆盖。
- rollback: 把 `fetch/provider.mjs` 与 `util/http.mjs` 的 `request` 调用换回全局 `fetch`，删三个 util 文件（工具/schema/提示词都不变）。
- supersedes: d003 的 cost 段（“无法 DNS pinning”）——d003 的安全策略本身仍 active

## d005 (2026-11-12) — 引擎池的图形化编辑走「volatile Config + 客户端半边 + profile patch」
- decision: host 侧把 `engines` 声明成 schemastery `.volatile()` 字段（插件现在依赖 `@deepseek-ai/schemastery@~3.19.0`）；客户端半边作为经典脚本 bundle（`dsh.client.platform='web'` + `exports['./client']`）注册 `plugins.row.config`，key=`dsh-free-web#free-web`；保存经 `settings.mutate` 写进 profile 的 `cordis.patch.yml`，消费方（provider）用 getter 每次读取。
- why: 这是宿主唯一支持的「行配置可编辑」通道：非 volatile 字段不会进表单，非 profile-patch 的写回会被 config-editor 拒绝；用 getter 是因为 volatile 提交是原地 `updateVolatile`，插件不会被重挂。
- cost: 多一个 npm 依赖 + 一份手写浏览器半边（约 250 行 + 13 个 stub 测试）；`platform`/`exports` 拼错会静默不出包，写坏会 `ClientPackageCompositionError` 拖垮整个 web client；`engines` 从「数组」变成「引用」，所有读点都要拆。
- rollback: 删 `src/client.js` + `package.json` 的 `dsh.client`/`exports["./client"]`（GUI 面消失，`DSH_FREE_WEB_ENGINES` 与 profile patch 仍然可用）；或整体回滚到 u008。
- supersedes: none
