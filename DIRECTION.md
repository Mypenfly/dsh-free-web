# DIRECTION

active:
- d001 (2026-11-11) 接管 ctx.web 的 provider，而不是替换工具、更不注入提示词
- d002 (2026-11-11) 免费搜索 = 多引擎公开结果页 + RRF 融合 + 熔断 + 诱饵页门；不挂 MCP
- d003 (2026-11-11) fetch 保持与官方 http provider 相同的安全策略（同源重定向/SSRF 拒绝），只加正文提取
- d004 (2026-11-11) 传输层自建（node core + env 代理 + DNS pin），不依赖宿主全局 fetch
- d005 (2026-11-12) 引擎池的图形化编辑 = volatile Config + 客户端半边注册 `plugins.row.config`，写回 profile patch
superseded: (none)
