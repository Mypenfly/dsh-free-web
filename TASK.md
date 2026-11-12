# TASK

next: u008 — 交付验收演练：在干净 profile 里从零装 bundle（`dsh plugin --profile X add link:…` + `dsh.profile.bundles`），dump-config 证明 patch 生效，再演练回滚（去掉 bundles 条目 → seam 回到 official），全程不碰 desktop profile
goal: 让 DSH 内置 `web_search` / `web_fetch` 走免费的本地实现在不改系统提示词、不新增工具的前提下接管（走 `ctx.web` 官方 provider seam），并以可安装插件形式交付
acceptance:
  - `web_search` / `web_fetch` 工具名、schema、模型可见面完全不变；系统提示词字符数不变；工具数量不变
  - 搜索不消耗任何 DeepSeek/付费 API：无 key、无付费 endpoint 调用（可用抓包/日志证明）
  - 搜索返回多引擎合并结果（含 title/url/snippet），单引擎被反爬时自动降级不整体失败
  - fetch 走本地实现，带 SSRF 防护（私网/环回拒绝）与正文提取
  - 一键回滚：删 patch 两行即恢复官方 provider
  - 插件化（u005）：bundle patch + `link:` 依赖 + bundles 选中；GUI 列表可见、可关闭
  - 自建传输（u006）：`grep -r "await fetch(\|=\s*fetch(" src` 为空；代理取 env（`http_proxy`/`https_proxy`/`all_proxy` + `no_proxy`）；直连 DNS 预检 + pin；gzip/deflate/br 解码；重定向逐跳校验
  - 引擎池可配（u007）：`DSH_FREE_WEB_ENGINES` 优先于 row config；未知 id 只 warn 不崩；不改代码即可缩池
  - 交付可复现（u008）：干净 profile 从零装/卸 bundle 均有读数为证；desktop profile 不动
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
  - u005 打包成 bundle（manifest/locale/icon/patch）+ 装进 desktop profile + 移除手写路径行
  - u006 自建传输（node core + env 代理 CONNECT/absolute-form + DNS 预检/pin + gzip/deflate/br + 单跳）；48 离线测试、活网 smoke、宿主内核探针全绿
  - u007 引擎池 env 覆盖（`DSH_FREE_WEB_ENGINES`，优先级/回落/warn）+ 9 个测试 + 文档；工具面 2591/24 未变
pointers:
  - seam: `@deepseek-ai/dsh-web` → `ctx.web.registerSearchProvider/registerFetchProvider`
  - 传输: `src/util/transport.mjs`（`request` 单跳）+ `src/util/proxy.mjs`（env 代理/no_proxy）+ `src/util/address.mjs`；`getText` 逐跳跟随
  - 代理环境: `http_proxy=/https_proxy=/all_proxy=http://127.0.0.1:7897`，`no_proxy=localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,172.29.0.0/16,::1,[::1]`
  - 引擎解析: `src/search/engines/index.mjs` 的 `resolveEngines(ids, warn)`；row/config 的引擎名单在 `cordis.patch.yml`
  - 活网验证: `node scripts/smoke.mjs`、`node scripts/probe-live-tool.mjs web_search "…"`、`node scripts/measure-wire.mjs <label> --with-plugin`
  - 宿主热载日志: `~/.dsh/logs/desktop-next.log`（改完 src 会重新注册 `pluginId: include:free-web`）

## u008 计划（未开工）
- 新建隔离 profile（`DSH_HOME=$PWD/.dsh-home`，`dsh --profile fwclean --from-default-profile headless --dump-config` 先落盘），**不碰 desktop**（Electron 独占）
- 装：`dsh plugin --profile fwclean add link:$PWD`（或按 MOUNT.md §1 手工加 `dependencies` + `dsh.profile.bundles`），`pnpm install` 建符号链接
- 证明：`dsh --profile fwclean --dump-config` 里出现 `# == dsh-free-web` 且 `web.config.searchProvider: free-search`/`fetchProvider: free-fetch`
- 回滚：从 `dsh.profile.bundles` 去掉 `dsh-free-web`（模拟 Plugins 页关闭），再 dump-config 证明 `web` 行回到 `deepseek-official`/`http` 且没有 free-web 行；记录前后两份 dump 到 `.dsh/refs/`
- 文档：把演练命令补进 `docs/MOUNT.md` §6（回滚）或独立小节；README 的 Install 段若与实际命令不符则修正
- 之后（u009，可选，需用户确认）：Plugins 页里勾选引擎 —— 纯 host 插件拿不到 `plugins.row.config` 槽，必须加客户端半边；成本远高于 env 覆盖
