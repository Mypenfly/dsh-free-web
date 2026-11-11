# PLAYBOOK

- 当要给 DSH 换掉内置 `web_search`/`web_fetch` 的实现 → 找 `ctx.web` provider seam，改 `web.searchProvider`/`fetchProvider`，别动 tool-web、别注入提示词。
- 当 plugin patch 里要新增插件行 → 用 `- insert: [...]`；直接写 `- id: <新id>` 只会得到 `patch: entry "<id>" not found`。
- 当验证「插件没侵入提示词」→ `dsh --profile headless --patch overlay.yml` 配 mock Messages endpoint，比对 system 字符数 + tools 名称（`scripts/measure-wire.mjs`）。
- 当沙箱只允许写 workspace 而 `dsh` 需要 `~/.dsh` → `DSH_HOME=$PWD/.dsh-home`，nix 包装器会把 profile 同步进去。
- 当免费搜索某个引擎返回 200 却给出无关结果 → 先算 coherence（查询词命中率），<0.3 判诱饵页丢弃，别按行数判成功。
- 当引擎类名/结构疑似改版 → 抓一份真页面进 `test/fixtures/`，先让测试红，再改选择器。
- 当要判断一次 web_fetch 是否走了自家 provider → 看返回体形状：自家 provider 返回正文 Markdown（标题/代码围栏），官方 http 返回整页 turndown。
- 当要把一个本地插件挂进 DSH 且要它在 Plugins 页可见/可开关 → 做成 bundle（package.json `dsh.bundle.patch` + `locale/*.json` + icon），profile 里 `link:` 依赖 + `dsh.profile.bundles` 选中；`name:` 用包名，不用绝对路径。
- 当改的是 desktop profile 又想验证组合 → 复制 profile 成新名字（`--from-default-profile headless`）再 `--dump-config`；`--profile desktop` 永远被 Electron 独占。
- 当 profile patch 又 insert 了一个 bundle 已提供的 id → 不会重复挂载，只会覆盖该行 `name`，看起来「插件还在但走的是旧路径」。
- 当自建 HTTP 传输要做「DNS 预检 + pin」→ 给 `http.request` 传 `lookup`，并同时实现 `(err,address,family)` 与 `all:true` 的数组回调；只实现一种会让 Node 的 autoSelectFamily 拿到 undefined。
- 当要自己走 https 代理 → `CONNECT` 拿裸 socket，`tls.connect({socket, servername})`，再让 `https.Agent` 子类的 `createConnection()` 直接返回该 TLS socket；http 目标用 absolute-form 请求行。
- 当解析 `no_proxy` 的 CIDR → 先判 `a.b.c.d/n` 再去 URL path，否则 `/16` 会被当路径吃掉；`socks*://` 要么实现要么明确退回直连，别假装代理。
- 当要在宿主内核里证明内置工具真的调到自家 provider（不花 API 费）→ `scripts/probe-live-tool.mjs`：mock Messages endpoint 流一段 `tool_use`，再从后续请求的 `tool_result` 取结果。
- 当判断「一次改动有没有动模型可见面」→ 改完再跑 `scripts/measure-wire.mjs`，比 `systemChars`/`toolCount` 与 baseline 完全相等，别只靠读代码。
