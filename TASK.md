# TASK

next: u006 — 自建 HTTP 传输：search/fetch 不再用宿主全局 `fetch`；用 `node:http(s)` 直连（DNS 预检 + pin）或经 env 代理（CONNECT 隧道），自己解 gzip/br、自己跟重定向
goal: 让 DSH 内置 `web_search` / `web_fetch` 走免费的本地实现在不改系统提示词、不新增工具的前提下接管（走 `ctx.web` 官方 provider seam），并以可安装插件形式交付
acceptance:
  - `web_search` / `web_fetch` 工具名、schema、模型可见面完全不变；系统提示词字符数不变；工具数量不变
  - 搜索不消耗任何 DeepSeek/付费 API：无 key、无付费 endpoint 调用（可用抓包/日志证明）
  - 搜索返回多引擎合并结果（含 title/url/snippet），单引擎被反爬时自动降级不整体失败
  - fetch 走本地实现，带 SSRF 防护（私网/环回拒绝）与正文提取
  - 一键回滚：删 patch 两行即恢复官方 provider
  - 插件化（u005）：bundle patch + `link:` 依赖 + bundles 选中；GUI 列表可见、可关闭
  - 自建传输（u006）：`grep -r "await fetch(\|=\s*fetch(" src` 为空（除非显式 fallback）；代理取 env（`http_proxy`/`https_proxy`/`all_proxy` + `no_proxy`）；直连时 DNS 预检拒绝私网并把验证过的地址 pin 进连接；gzip/deflate/br 解码；重定向仍逐跳校验
constraints:
  - 不做系统提示词注入（对比 dsh-free-search 的做法）
  - 不新增工具、不改 tool-web 的 schema/描述
  - 沙箱只允许写 workspace；`~/.dsh` 写入需要单独批准
  - 不硬依赖 `@deepseek-ai/*` 包（插件目录解析不到），错误对象用带 `code` 的 Error 代替
  - bundle patch 里的行 `name` 用包名（`dsh-free-web`），不用绝对路径
  - 传输只用 Node core（`node:http`/`node:https`/`node:net`/`node:tls`/`node:dns`/`node:zlib`），不引第三方包
done:
  - u001 侦察（seam/注册点/引擎可达性）
  - u002 免费 search provider（6 引擎 + RRF + 熔断 + 诱饵门），28 测试全绿
  - u003 fetch provider（同安全策略 + 正文提取）
  - u004 挂载桌面 profile + 活会话验证 + DDG 引擎
  - u005 打包成 bundle（manifest/locale/icon/patch）+ 装进 desktop profile + 移除手写路径行；活会话 `web_search` 仍返回 Engines 行
pointers:
  - seam: `@deepseek-ai/dsh-web` → `ctx.web.registerSearchProvider/registerFetchProvider`
  - 当前传输: `src/util/http.mjs` 用宿主全局 `fetch`（靠 `NODE_USE_ENV_PROXY=1` 走 7897）；`src/fetch/provider.mjs` 也直接调 `fetch(..., {redirect:'manual'})`
  - 代理环境: `http_proxy=/https_proxy=/all_proxy=http://127.0.0.1:7897`，`no_proxy=localhost,127.0.0.1,...`（本会话 env）
  - 本机 Node 22.23.4 已内置 `EnvHttpProxyAgent`（undici），自带 fetch 会走 env 代理——自建传输必须自己实现同一套
  - 抓取侧逐跳校验逻辑在 `fetch/provider.mjs`（同源重定向 + `isNonPublicAddress` 预检），传输层只需暴露 manual 跳转的 status/location

## 进度 / 明天从这里接（u006 未开工）
- 已定方案（未写代码）：
  - `src/util/proxy.mjs`：从 env 解析代理（scheme 对应 → all_proxy 兜底）+ `no_proxy` 后缀/精确/`*` 匹配
  - `src/util/transport.mjs`：`request(url, {method,headers,signal,timeoutMs,proxy,publicOnly})` 单跳返回 `{status, headers:{get,getSetCookie}, url, stream}`
    - 直连：`dns.lookup(all)` 预检 + 把地址 pin 进 `lookup` 选项（`agent:false`）
    - https 代理：CONNECT + `tls.connect({socket, servername})` + `createConnection:()=>tlsSocket`
    - http 代理：absolute-form 请求行
    - 解 gzip/deflate(`createUnzip`)/br；重定向仍由 `fetch/provider.mjs` 逐跳处理
  - `readCappedText(stream, maxBytes, contentType)` 改为吃流；`getText`/`fetch` 两处调用点同步改
- 验证计划：新增 `test/transport.test.mjs`（本地 http server 测直连/gzip/manual 302/`publicOnly` 拒 127.0.0.1；本地假代理测 CONNECT 与 absolute-form；`proxyFor` 单测），再跑 29 个旧测试 + `scripts/smoke.mjs` + 活会话 `web_search`/`web_fetch`
- 现状：desktop profile 已是 bundle 形态并生效（`web_search` 实测返回 `Engines: yahoojp 10 · sogou 10 …`），u006 只动传输层，不影响挂载
