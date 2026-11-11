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
