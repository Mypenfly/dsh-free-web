# TASK

next: u005 — 把 dsh-free-web 做成正式插件 bundle（`dsh.bundle` 清单 + 自带 patch + locale/icon），以 `link:` 依赖装进 desktop profile，在 GUI Plugins 列表里可见/可开关/可卸载；移除手写绝对路径行
goal: 让 DSH 内置 `web_search` / `web_fetch` 走免费的本地实现在不改系统提示词、不新增工具的前提下接管（走 `ctx.web` 官方 provider seam），并以可安装插件形式交付
acceptance:
  - `web_search` / `web_fetch` 工具名、schema、模型可见面完全不变；系统提示词字符数不变；工具数量不变
  - 搜索不消耗任何 DeepSeek/付费 API：无 key、无付费 endpoint 调用（可用抓包/日志证明）
  - 搜索返回多引擎合并结果（含 title/url/snippet），单引擎被反爬时自动降级不整体失败
  - fetch 走本地实现，带 SSRF 防护（私网/环回拒绝）与正文提取
  - 一键回滚：删 patch 两行即恢复官方 provider
  - 插件化（u005）：`dsh.bundle.patch` 被 plugin-manager 认可；profile 用 `link:` 依赖 + bundles 列表选中；GUI 插件列表出现、可关闭；关闭后回落到官方 provider
  - 自建传输（u006）：search/fetch 不再用宿主全局 `fetch`；代理来自 env（http_proxy/https_proxy/all_proxy/no_proxy），直连时 DNS 预检 + pin
constraints:
  - 不做系统提示词注入（对比 dsh-free-search 的做法）
  - 不新增工具、不改 tool-web 的 schema/描述
  - 沙箱只允许写 workspace；`~/.dsh` 写入需要单独批准
  - 不硬依赖 `@deepseek-ai/*` 包（插件目录解析不到），错误对象用带 `code` 的 Error 代替
  - bundle patch 里的行 `name` 用包名（`dsh-free-web`），不用绝对路径——否则 GUI 里不可见也不可管理
done:
  - u001 侦察（seam/注册点/引擎可达性）
  - u002 免费 search provider（6 引擎 + RRF + 熔断 + 诱饵门），28 测试全绿
  - u003 fetch provider（同安全策略 + 正文提取）
  - u004 挂载桌面 profile + 活会话验证（web_search 返回 Engines 行、web_fetch 返回正文）+ 加 DDG 引擎
pointers:
  - seam: `@deepseek-ai/dsh-web` → `ctx.web.registerSearchProvider/registerFetchProvider`，id 唯一，selection: `web.searchProvider` / `web.fetchProvider`
  - 官方注册点: `dsh-base/cordis.patch.yml` L473-500（web-search-deepseek / web-deepseek-api / web-fetch-http / tool-web）
  - bundle 参考: `/home/mypenfly/projects/one_session/dsh-unitflow`（`dsh.bundle.patch`、`dsh-plugin.json`、`locale/*.json`）
  - plugin-manager 文档: asar 内 `@deepseek-ai/dsh-plugin-manager/README.md` + `dsh-client-ui-plugin-manager/README.md`（bundle/config 页只认 `plugins.row.config` 槽，纯 host 插件没有通用表单）
  - 已实测可用引擎（本机经 127.0.0.1:7897 代理）: brave(200, 86 外链) / yahoojp(200, 58) / baidu(200, 946KB 需解 redirect) / so360(200) / sogou(200)；DDG html 需 referer
