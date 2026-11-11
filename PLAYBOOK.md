# PLAYBOOK

- 当要给 DSH 换掉内置 `web_search`/`web_fetch` 的实现 → 找 `ctx.web` provider seam，改 `web.searchProvider`/`fetchProvider`，别动 tool-web、别注入提示词。
- 当 plugin patch 里要新增插件行 → 用 `- insert: [...]`；直接写 `- id: <新id>` 只会得到 `patch: entry "<id>" not found`。
- 当验证「插件没侵入提示词」→ `dsh --profile headless --patch overlay.yml` 配 mock Messages endpoint，比对 system 字符数 + tools 名称（`scripts/measure-wire.mjs`）。
- 当沙箱只允许写 workspace 而 `dsh` 需要 `~/.dsh` → `DSH_HOME=$PWD/.dsh-home`，nix 包装器会把 profile 同步进去。
- 当免费搜索某个引擎返回 200 却给出无关结果 → 先算 coherence（查询词命中率），<0.3 判诱饵页丢弃，别按行数判成功。
- 当引擎类名/结构疑似改版 → 抓一份真页面进 `test/fixtures/`，先让测试红，再改选择器。
- 当要判断一次 web_fetch 是否走了自家 provider → 看返回体形状：自家 provider 返回正文 Markdown（标题/代码围栏），官方 http 返回整页 turndown。
