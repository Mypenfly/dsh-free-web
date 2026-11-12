next: u012 — 把仓库推送到 https://github.com/Mypenfly/dsh-free-web.git（SSH origin、main 分支），并验证克隆后能跑测试
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
  - 图形化引擎勾选（u009，可选，已实现）：Plugins 页里能改引擎池并写回 profile
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
  - u008 干净 profile 从零装/卸演练（dump-config 前后对比 + 活挂载两行日志）；修正 MOUNT/README 的安装步骤
  - u009 引擎勾选客户端半边（`Config` volatile + `src/client.js` + `dsh.client`）；75 测试、活体 set/reset 两条写回路径、工具面 2591/24 未变
  - u011 交付确认收口（重载指引 + carry；用户未回报即转下一目标）
  - u010 GUI 入口不可见排查：宿主组图与客户端注册都正常，入口是行标题的 Configure 按钮（视觉上只有 ›）；新增 `plugins.bundle.config` 内联卡片 + README 收敛；76 测试、真浏览器（Firefox BiDi + 复制 desktop profile）点通保存写回
pointers:
  - seam: `@deepseek-ai/dsh-web` → `ctx.web.registerSearchProvider/registerFetchProvider`
  - 传输: `src/util/transport.mjs`（`request` 单跳）+ `src/util/proxy.mjs`（env 代理/no_proxy）+ `src/util/address.mjs`；`getText` 逐跳跟随
  - 代理环境: `http_proxy=/https_proxy=/all_proxy=http://127.0.0.1:7897`，`no_proxy=localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,172.29.0.0/16,::1,[::1]`
  - 引擎解析: `src/search/engines/index.mjs` 的 `resolveEngines(ids, warn)`；row/config 的引擎名单在 `cordis.patch.yml`
  - 活网验证: `node scripts/smoke.mjs`、`node scripts/probe-live-tool.mjs web_search "…"`、`node scripts/measure-wire.mjs <label> --with-plugin`
  - 宿主热载日志: `~/.dsh/logs/desktop-next.log`（改完 src 会重新注册 `pluginId: include:free-web`）

## u012 计划（发布到 GitHub）
- 远端：`git@github.com:Mypenfly/dsh-free-web.git`（SSH 已认证为 `Mypenfly`；无 `gh` CLI、HTTPS 无 token）
  —— 仓库已存在（public、空、默认分支 `main`）
- 分支：本地 `master` → 重命名 `main`，`push -u origin main`（空仓库首次推送决定默认分支）
- 验证：
  - `git ls-remote` / GitHub API `/branches` 里出现 `main` 与 9 个提交
  - 干净目录 `git clone` 一份，`node --test "test/*.test.mjs"` 在**没有** `node_modules` 时是否可跑（读数为证）
- 发布前检查：`.gitignore` 覆盖 `.dsh-home/`/`.probe/`/`node_modules/`；tracked 文件里无 token/密钥

## 发布注意事项（做完后回填）
- `package.json` 仍标 `private: true` + 依赖 `@deepseek-ai/schemastery`（非公共 registry），外部用户直接
  `pnpm install` 可能失败 —— 克隆后测试的读数会说明到底卡不卡
- `docs/MOUNT.md` / `mount.patch.yml`（手写挂载示例）里是绝对个人路径 `/home/mypenfly/...`，公开仓库里应泛化
