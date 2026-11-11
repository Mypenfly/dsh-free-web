# TASK

next: u004 — 挂载到 desktop profile（备份 + 两行 patch），活会话里用 web_search/web_fetch 验证走 free provider，并复核提示词/工具面不变
goal: 让 DSH 内置 `web_search` / `web_fetch` 走免费的本地实现在不改系统提示词、不新增工具的前提下接管（走 `ctx.web` 官方 provider seam）
acceptance:
  - `web_search` / `web_fetch` 工具名、schema、模型可见面完全不变；系统提示词字符数不变；工具数量不变
  - 搜索不消耗任何 DeepSeek/付费 API：无 key、无付费 endpoint 调用（可用抓包/日志证明）
  - 搜索返回多引擎合并结果（含 title/url/snippet），单引擎被反爬时自动降级不整体失败
  - fetch 走本地实现，带 SSRF 防护（私网/环回拒绝）与正文提取
  - 一键回滚：删 patch 两行即恢复官方 provider
constraints:
  - 不做系统提示词注入（对比 dsh-free-search 的做法）
  - 不新增工具、不改 tool-web 的 schema/描述
  - 沙箱只允许写 workspace；`~/.dsh` 写入需要单独批准
  - 不硬依赖 `@deepseek-ai/*` 包（插件目录解析不到），错误对象用带 `code` 的 Error 代替
done:
  - u001 侦察（seam/注册点/引擎可达性）
  - u002 免费 search provider（6 引擎 + RRF + 熔断 + 诱饵门），28 测试全绿
  - u003 fetch provider（同安全策略 + 正文提取）
pointers:
  - seam: `@deepseek-ai/dsh-web` → `ctx.web.registerSearchProvider/registerFetchProvider`，id 唯一，selection: `web.searchProvider` / `web.fetchProvider`
  - 官方注册点: `dsh-base/cordis.patch.yml` L473-500（web-search-deepseek / web-deepseek-api / web-fetch-http / tool-web）
  - 免费参考实现: github.com/sweetcornna/free-search-mcp（Python/uvx，MCP；只借鉴引擎与提取策略，不挂 MCP）
  - 已实测可用引擎（本机经 127.0.0.1:7897 代理）: brave(200, 86 外链) / yahoojp(200, 58) / baidu(200, 946KB 需解 redirect) / so360(200) / sogou(200)；DDG html 被 anomaly 拦，mojeek 连不通，searx.be/startpage 要验证
