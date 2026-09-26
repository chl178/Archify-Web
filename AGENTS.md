# AGENTS.md — Archify-Web 项目指南

本文件面向在本仓库工作的 coding agent，总结项目结构、运行方式、关键设计与已知的坑。

## 项目是什么

**Archify-Web 图集**：基于改造版 archify 渲染器的本地图集应用——左侧项目目录树 + 右侧图表网格，支持快速导入（archify JSON / Mermaid / 渲染 HTML / 一键导入示例）、缩略图、悬停快速预览、整幅详情查看（滚轮缩放/右键平移）。

仓库同时包含 **改造版 archify skill**（`archify/`，新增嵌套组件能力），与图集应用配套。

## 启动

```bash
npm install             # 首次（唯一运行依赖 @anthropic-ai/claude-agent-sdk）
node server.mjs         # http://127.0.0.1:8766（PORT 环境变量可改端口；HOST=0.0.0.0 监听全部网卡）
```

**开发与验证推荐走容器**（环境一致；数据主从约定：容器卷 `archify-gallery` 是唯一数据主体——不要在本机再用仓库里的 `gallery/` 起服务双写）。改完代码一条命令重建重启：

```bash
docker compose up -d --build    # → http://127.0.0.1:8766
```

裸机直跑（`node server.mjs`，见上）同样受支持；在 Windows/Linux 双侧开发时可用 rsync 把仓库同步到 Linux 侧再 compose 构建（排除 `gallery/ node_modules/ 备份/ .git/`），**同步方向别搞反**（Linux 侧只是构建副本）。

除 agent 后端外零依赖（Node ≥ 22.5——issues.db 用内置 node:sqlite）。`claude.mjs` 动态 import SDK——node_modules 缺失时服务照常启动，仅 Agent 功能不可用（设置弹窗状态行/发消息报「SDK 未安装」）。`archify/` 内的 `node_modules` 只是跑它自己的测试用的（`ajv`、`parse5` 等 devDependencies）。

**首次启动自动播种示例图**：启动序列检测到 `gallery/manifest.json` 不存在（全新部署）时，先跑 `importExamples()`（`archify/examples/` 全量校验+渲染入集）再建热更新基线快照——全新容器开箱即有 15 张示例图；用户后来清空图集**不会**重新播种（manifest 存在即视为已初始化）。**新增启动逻辑要排在基线快照之前**，否则播种产物会被误报一轮 changed。

**Docker 一键部署（Linux 容器，已本机实测）**：`docker compose up -d --build`。要点：**多阶段最小化镜像**（deps 层 `node:22-slim` 跑 `npm ci` 并裁掉非 x64-linux 的 ripgrep；运行层 `debian:bookworm-slim` + node 二进制，约 360MB，无 npm/git/ca-certificates/tzdata——HTTPS 走 node 内置 CA（已实测连智谱网关 200）、时区走 node 内置 ICU；glibc+bash 是底线：SDK 自带 ripgrep/sharp 二进制要 glibc，agent 的 Bash 工具要 bash；容器以 root 运行 + bypassPermissions 依赖 claude.mjs 注入的 `IS_SANDBOX=1`（见 Agent 桥接「已知坑」）；**仅支持 x64-linux 宿主**）；Dockerfile 设 `HOST=0.0.0.0`（server.mjs 的 HOST 环境变量，本地默认仍 127.0.0.1）；图集数据在具名卷 `archify-gallery`（`/app/gallery`）；主机项目代码挂 `/data`（compose `PROJECTS_DIR`，默认 `./projects`），网页目录浏览器选 `/data/...` 作存放路径——「远端部署=远端服务器磁盘」的既有设计天然覆盖容器场景；archify（符号链接到 /app/archify）+ code-diagram 技能构建时装进 `/root/.agents/skills`（**改技能后须重新 build 镜像才进容器**）；`.dockerignore` 排除 gallery/备份/测试/遗留数据/.zcode——镜像不含仓库当前图集数据，全新起步或 `docker cp gallery/. archify-web:/app/gallery/` 迁移。**多用户数据**（users.json / auth-sessions.json）在具名卷 `archify-gallery` 里随图集数据持久化；admin 账户（admin / adminadmin）首次启动自动种子，改过密码不会被重置。**新增后端源文件要同步改 Dockerfile 的 `COPY server.mjs claude.mjs …` 行**（显式列举，不是整仓拷贝——auth.mjs 已在其中）。

## 目录结构

```
server.mjs            HTTP 服务（除 agent 后端外零依赖）：静态文件 + 图集 API + archify 校验/渲染管线
auth.mjs              多用户登录（零依赖）：用户表 + 登录态令牌（gallery/users.json + auth-sessions.json）
claude.mjs            Agent 后端桥接（Claude Code Agent SDK）：运行器 + 会话注册表 + SSE 事件总线
cicd.mjs              项目级 Issue 统一执行流水线（缺陷改图 + 创建出图，经 agent 执行，强制结合项目代码）
mermaid-import.mjs    Mermaid flowchart → workflow v2 转换器（纯函数）
Dockerfile            Linux 容器镜像（多阶段最小化：运行层 debian-slim+node 二进制约 360MB，仅 x64-linux；HOST=0.0.0.0）
docker-compose.yml    一键部署：具名卷 archify-gallery 持久化数据，主机项目挂 /data
.dockerignore         构建上下文排除 gallery/备份/测试/日志/遗留数据
public/               前端（index.html / style.css / app.js，vanilla JS，无构建）
gallery/              图集数据：manifest.json + 每图一目录（spec/diagram/thumb.html/thumb.svg）
archify/              改造版 archify skill（详见其 SKILL.md / README）
.agents/skills/       项目级技能（code-diagram：空项目 init + 代码取证出图；同步装到 ~/.agents/skills/）
sample-电商订单系统.json   嵌套容器示例规范（演示/测试用）
docs/images/          README 效果截图（.dockerignore 已排除，不进镜像）
README.md / LICENSE   项目说明（功能/部署/开发/致谢）与 MIT 许可
```

## 图集数据模型（manifest.json，v2）

```json
{ "version": 2,
  "folders": ["电商项目", "电商项目/订单模块"],
  "folderMeta": { "电商项目": { "localPath": "C:\\abs\\path" } },
  "diagrams": [ { "id": "d-<hash>", "title": "...", "type": "architecture", "folder": "电商项目",
                  "dir": "C:\\abs\\path\\d-xxx", "specFile": "spec.json", "htmlFile": "diagram.html",
                  "thumbFile": "thumb.html", "source": "import|mermaid|html|example", ... } ] }
```

- **图 ID = 内容哈希**（`d-` 规范 / `h-` HTML），重复导入原地刷新，不产生重复卡片
- **folder**：图的目录归属（null = 未分类）；目录树 = 显式 `folders` ∪ 图的 folder 路径隐含目录
- **folderMeta.localPath**：顶层项目目录可关联本地**存放路径**——该目录下的图直接写入 `<localPath>\graph\<id>\`（清单 entry 记 `dir` 字段）；`GET /gallery/<id>/<file>` 路由按 `entry.dir` 解析实际位置。删除图会连本地目录一起删；旧布局（无 `graph\` 层）的存量 entry 靠 `dir` 字段继续可用，同 id 重新导入时自动迁到新位置并清旧目录
- 旧版清单（纯数组）读取时自动迁移为 v2

## 导入管线

所有导入先过 **archify 官方校验器**（`archify/bin/archify.mjs validate <type> <file> --json`），**校验不过不入集**，诊断（code/message/receipt）原样返回给前端展示。通过后调对应渲染器（`archify/renderers/<type>/render-<type>.mjs`）出 HTML，提取内联 SVG 生成缩略图页（thumb.html）+ **自包含 thumb.svg**（样式内嵌进 `<svg>` 的 CDATA——卡片用 `<img>` 引用，替代每卡一个 iframe 文档；存量数据启动时由 `ensureThumbSvgFile` 补生成）。

**性能设计**（2026-09-26 全面优化）：缩略图走 `<img src=thumb.svg>`（18 卡 = 18 个图像资源而非 18 个 iframe 文档上下文）；**静态资源内存缓存 + brotli/gzip 预压缩**（server.mjs `staticEntryFor`：size+mtime 失效、64MB/512 条 LRU、压缩异步不阻塞——thumb.svg ~323KB→~102KB、diagram.html ~832KB→~188KB、app.js ~171KB→~49KB 线上传输）；**URL 带 `?v=<数字>` 一律 `immutable` 长缓存**（前端 mediaRev 版本戳 URL 内容永不变，重复加载零请求），无 v 的维持 **ETag + no-cache**（304 再验证）；**大 JSON 读 API（/api/diagrams、/api/issues、/api/agent/sessions）带 ETag**（轮询未变化 304 零传输，fetch 走 HTTP 缓存透明回缓存体）+ `/api/diagrams` 响应体按 manifest 版本缓存序列化；**issues.db 开 WAL**（`synchronous=NORMAL` + busy_timeout）+ **预编译语句缓存**（`stmt()`，别再用裸 `issuesDb.prepare`）；**导入管线与图集扫描全异步 IO**（stat/read 均走 fs/promises，扫描 8 并发批扫不阻塞事件循环——改 `diagramSignature`/`scanGalleryChanges` 时保持 async）；`readStore()` 有 **mtime+size 内存缓存**（每个 API 请求都读它，别每次读盘+parse——改 manifest 必须走 `writeStore` 或改文件内容使 stat 变化）；HTTP `keepAliveTimeout=65s`（前端 3s/3.5s 轮询连接复用，别改回默认 5s）。前端（app.js）：**网格增量渲染**（卡片按 id+签名键控复用，未变化卡片 DOM/已解码缩略图原地保留，签名含 mediaRev——changed 的卡自动重建换 ?v= URL）、**目录树/卡片事件委托**（`setupTreeEvents` + #grid 委托，一次绑定，renderTree/renderGrid 重建 DOM 零重绑——别恢复每行/每按钮挂监听）、卡片 `content-visibility:auto`。

**写保护**：`POST /api/import` 等图集写 API 有来源校验（`guardGalleryWrite`，见「Agent 桥接」节）——浏览器（用户前端）与 CI 运行凭证放行，其余程序化调用 403 `agent-direct-blocked`；校验/渲染管线本身不变。

## 图集热更新（SSE）

各项目的图被外部更新（agent / CI / 直接替换 `<localPath>\graph\<id>\` 或 `gallery\<id>\` 下的文件）时，**网页自动刷新，无需 F5，多标签页天然同步**：

- **服务端检测**（server.mjs，2026-09-26 起双通道）：**fs.watch 快路径**（`refreshGalleryWatchers` 监听 gallery/ + 各项目 `<localPath>/graph/`，150ms 去抖——能监听的目录外部改图毫秒级感知；drvfs/网络盘 watcher 可能不报事件，且目录不可监听时静默降级）+ **2.5s 轮询兜底**（指纹 = manifest（folders/folderMeta/每图 entry JSON）+ 每图目录下 spec/diagram/thumb/thumb.svg 的 size+mtime（按 `entry.dir` 找，用户项目路径下的图同样覆盖），stat 全异步 8 并发批扫，与基线快照 diff 出 `added/removed/changed/foldersChanged`；扫描中再触发会排队补扫一轮保证最终一致）；**`writeStore()` 后即时广播**（API 变更不等下一拍，实测 ~18ms）；启动时在 `ensureThumbSvgFile` 迁移**之后**建基线（silent），否则补生成的 thumb.svg 会误报一轮 changed
- **`GET /api/events`**（SSE）：推送 `{type:'gallery-update', rev, added[], removed[], changed[], foldersChanged}`；30s 心跳注释行防中间层断连；连接断开由前端 EventSource 自动重连
- **前端**（app.js）：EventSource 常开（onerror 3s 重连）；**200ms 合并窗口**去抖（批量导入/CI 一轮连发多事件只刷一次）；变化的图记入 `mediaRev` map → `/gallery/` URL 加 `?v=rev` **破缓存**（img 靠换 URL 重新协商 ETag；iframe 同 src 赋值不触发导航，必须换 URL 才重载）；打开的详情在 changed 里 → iframe 自动重载 + 标题同步；在 removed 里 → 关闭详情
- changed 里的图会清 `specLabelCache`（外部直改 spec.json 时 id 不变内容变，issue 标签翻译不留旧组件名）

## 多用户登录与权限（auth.mjs，零依赖）

**多用户登录（约定）**：首次使用可创建账户（开放注册，role 恒为 user，**注册必填个人 GLM LLM API Key**——用户会话各用各的 Key 计费）；admin 账户启动时自动种子（`admin` / `adminadmin`，**已存在则不重置**——改过密码不会被覆盖）；密码修改必须核对**上次密码**（成功后吊销该用户其他设备的登录态）；支持登出。多用户并发使用天然成立（单进程异步、每条消息独立 SDK query）。

- **个人 GLM API Key（每用户）**：存 `gallery/users.json` 的 `apiKey` 字段（服务端文件，明文存储、API 永不回传本体，`me/login` 只回 `hasApiKey`）。claude.mjs `sendUserMessage` 发消息时 `userApiKey(发送者用户名)` 作为 `ANTHROPIC_AUTH_TOKEN/API_KEY` 下发（**按发送者算**：admin 代发也用 admin 的 Key）；**任何账户都不回退兜底（明确约定）**——未设置 Key 的账户发消息直接 403（提示去 🔑 账户设置填写）。**流水线会话统一用 admin 账户的 Key**（claude.mjs `adminApiKey` dep → auth.mjs `adminApiKey()`，role=admin 优先、兜底用户名 admin）；admin 未设置 Key 时流水线消息落错误 turn、按组失败计。Base URL/模型列表/默认模型仍是全局共享（⚙，弹窗已无任何 Key 字段）；Key 配合全局 Base URL 使用（默认智谱网关，别改回去）。**全局 apiKey 已废除（约定）**：`agent-settings.json` 存量的全局 Key 启动时一次性迁给 admin 账户（admin 已有个人 Key 时不覆盖，auth.mjs `adoptApiKeyForAdmin`）并从设置文件清除；换 Key 唯一入口 = **侧栏 🔑「账户设置」弹窗**（修改密码 + GLM API Key 两段，各自独立保存），后端 `PUT /api/auth/apikey`
- **存储**：`gallery/users.json`（`{v:1, users:[{id, username, salt, hash, apiKey?, role, ...}]}`，密码 scrypt 哈希、常量时间比较，绝不落明文）+ `gallery/auth-sessions.json`（token → `{userId, createdAt, expiresAt}`）。**两张表都在内存、启动时读入**——手改文件不生效（要重启），与 cicd.json 同款行为；登录态 = HttpOnly Cookie `archify_auth`（30 天有效、剩余不足一半滑动续期），令牌 256 位随机、服务端可撤销
- **用户名**大小写不敏感唯一（登录也不分大小写），1-30 字符不含空白/冒号；密码 6-128 字符
- **数据分离范围（约定：每个用户只能看到自己的历史会话，admin 看全部）**：会话注册表（claude.mjs）每条会话带 `owner`（用户名；流水线会话 owner 为空）——`GET /api/agent/sessions`、`session/:id/messages|export|abort`、`POST /api/agent/message`、批量导出、`/api/agent/events` SSE 全部按 `canSeeSession` 过滤：**admin 全见（含流水线与他人会话，会话栏条目带 @owner 徽标）；普通用户只见自己的用户会话**（流水线会话与升级前的无主存量会话都不可见）。SSE 只推该用户自己会话的工具细流/完成事件（admin 收全部）
- **全局任务面板 admin 专属（约定）**：`GET /api/cicd` 要求登录——admin 拿全量；普通用户**剥离 `runs/kicked/maxConcurrentSessions/activeSessions/sessionLimit`**（项目级看板的队列/历史/状态仍可见）；`PUT /api/cicd`（全局并发、项目触发设置、执行模型）与 `POST /api/cicd/run`（手动触发/立即执行/重新拉起）一律 **403 `admin-only`**。前端同步：⏳ 全局看板按钮对普通用户隐藏；项目看板的触发设置 sheet 与「▶ 立即执行 / ✕ 拒绝 / ↩ 重开 / ↻ 重新拉起」按钮对普通用户隐藏（`#board-view.not-admin` CSS + 服务端双保险）
- **登录门**：前端启动先 `GET /api/auth/me`，401 → 整屏登录/注册页（`#auth-gate`），登录通过 `enterApp` 才拉数据/开 SSE；**注册模式多一个必填「GLM API Key」字段**；侧栏底部用户栏（用户名 + 角色徽标 + 🔑 账户设置 + ⏻ 登出——账户设置弹窗 = 修改密码 + 个人 GLM API Key 两段）；`window.fetch` 包了一层——登录态失效（改密码吊销/过期）任何 API 401 → 自动 reload 回登录门
- **保持开放的通道（不能被登录态拦——虚窗/流水线 agent 走 curl 无 Cookie）**：图集读 API（diagrams/issues/fs）、issue CRUD、`POST /api/folders`、`GET /api/events`、`/gallery/` 静态文件与前端本身。图集（目录/图/issue）是共享工作区，不按用户隔离；agent 设置（⚙）对所有登录用户开放（共享的模型/网关配置）
- API：`POST /api/auth/login|register`（成功 Set-Cookie + `{user:{username,role,hasApiKey}}`；register 收 `{apiKey}` 必填）、`POST /api/auth/logout`、`GET /api/auth/me`、`POST /api/auth/password {oldPassword,newPassword}`、`PUT /api/auth/apikey {apiKey}`（换个人 GLM Key，显式提交才覆盖）

## Agent 桥接（Claude Code Agent SDK）

- **能力边界 + 图集写保护（明确约定：会话 agent 不能直接创图/改图，图的产生与修改只有「提 issue」一条通道——缺陷类改图 + 创建类出图都由 Issue 流水线落实）**：图集写 API（`/api/import`、`/api/import-examples`、`/api/cicd/run`、`PUT /api/cicd`、`DELETE /api/diagrams/:id`）由 `guardGalleryWrite`（server.mjs）默认拒绝程序化调用，只认两种凭证：① **浏览器来源**——same-origin fetch 的 Origin/Referer 匹配本服务（用户前端按钮）；② **运行凭证**——`x-archify-ci-key` 头，服务器在流水线 run 期间随机生成（`beginCiRun`）、只拼进该任务 prompt（cicd.mjs `ciAuthNote`），run 结束 `endCiRun` 即失效。虚窗会话的 agent 只能 curl（无浏览器头、无凭证）→ 403 `{error:"agent-direct-blocked"}`，响应文案引导它提缺陷 issue（改图）/ 创建 issue（`POST /api/issues` kind=new-feature，新图）。AGENT_SYSTEM_GUIDE 已据此改写：agent 可查析、读 spec、建子目录、issue CRUD（含创建类）；不可创/改/删图、改流水线设置，也不得绕过 API 直改 `<localPath>/graph/` 图文件。**逃生口**：启动设 `ARCHIFY_WRITE_KEY` 环境变量，请求带 `x-archify-write-key` 同值头放行（手工 curl 调试用，默认关闭）。注意 **code-diagram 技能从 ZCode 直接跑会被同一守卫 403**（ZCode 的 curl 同样无凭证）——要么带逃生口头，要么提 issue 交给流水线；流水线任务读同一技能文件，其 prompt 已随消息下发凭证

图集内置了 agent **虚窗**（待机时底部半透明提示「⏎ Enter 唤醒 Agent」呼吸闪烁；Enter 唤醒全屏虚化蒙版；ESC 退出回到提示态；**输入框（聚焦）为空时按 Enter = 切换 ⛶ 独占模式**，与按钮同一开关可来回切；焦点在按钮上时 Enter 被拦截回输入框，见「Enter 只归输入框」条）：

- **布局**：顶部 30% 是**回复长廊**（`#veil-corridor`，turn 卡片按新旧距离赋 transform/opacity/filter：最新 scale1/op1，旧的 0.88/0.5/blur1 → 0.63/0.1/blur4，向远处退去；`agentTurns` 数组 + `renderCorridor()`）；中间是**工具状态细流** `#veil-ticker`（🛠 工具名呼吸闪烁、✓ 完成）；底部上下文芯片 + 大输入框（`#veil-input`，输入行最左是 **`#veil-new` ＋ 新建会话按钮**（约定放在模型下拉左边，不再放会话栏头部）、其后 **`#veil-model` 模型实时切换下拉**：change 即 PUT /api/agent/settings 保存，下一条消息生效，与 ⚙ 弹窗经 `syncVeilModel()` 双向同步）。每张卡片右上角常显 `⧉ 复制` 按钮；**点幽灵卡片露出的顶部窄条 = 把它调到最前**再复制（长廊扇形叠放，靠后的卡片只有顶部条不被遮挡；被调到身后的卡片加 `passed` 类沿过渡飞过头顶淡出——`pointer-events:none` 防隐形拦截聚焦卡片同位置的复制按钮导致复制错内容，且不再采样背景模糊；卡片两侧 mask 羽化带内不响应点击，按钮需避开羽化区）
- **左上角常显「ESC 退出 Agent」框（`#veil-esc`，约定）**：独占/非独占都有，点击等同按 ESC（z 低于会话栏 60——独占模式会话栏滑出时暂时盖住它）；**非独占模式上半区长廊背后有羽化模糊层**（`.agent-veil::before`，backdrop-filter blur(16px) + 上下 mask 羽化 + 微暗，与卡片两侧羽化同一手法；独占模式关掉——整页已由 `body.agent-exclusive #layout` 模糊，避免双重采样）
- **回复只显示最终结果**（消息完成后从 `GET /api/agent/session/:id/messages` 回读的 assistant text parts），推理/流式 delta 一律不进长廊（明确约定过）；回复用 `renderMarkdown()`（app.js）渲染——**先整体 `escapeHtml` 再按行解析**（标题降两级 #→h3、围栏代码块、有序/无序列表、引用、分割线、**GFM 表格**（`|` 开头表头行 + 紧随 `|---|` 分隔行触发，`:---/---:/:-:` 列对齐，列数以表头为准、正文行多列截断少列补空；样式 `.turn-a .md-table`——细青边框 + 表头淡青底 + 偶数行斑马纹，宽表包裹层横向滚动）、行内代码/加粗/斜体/链接），块间距紧凑；⧉ 复制按钮拷贝的是**原始 markdown 文本**（`turn.a`）
- **滚轮交互（物理滑动，定稿设计）**：虚窗开启时滚轮**先滚动当前（最前）回复的内容**（`.turn-a` 可滚但隐藏滚动条），内容到边界后滚轮转为**走廊动力**——连续位置 + 速度积分器（`corridorPos`/`corridorVel`，`corridorPhysics` rAF 循环）：滚轮冲量→速度（上限 `CORRIDOR_VMAX`，一次瞬时快滑物理上切不过两张）、减速=基础摩擦+速度正比阻尼（有限时间停稳不拖尾）、栈两端弹簧限位（越界拉回不振荡）、停稳后 **0.18s 定时长 cubic ease-out 快速归位最近整格**（`CORRIDOR_SNAP_T`，起点一次算定目标；停在两卡中间也干脆弹回最近卡的显示正中，替代旧指数逼近的拖尾；↑/↓ 键与点卡调前的 `corridorGoto` 长滑行仍走速率 16 的 eased 指数），落回静止布局（`corridorRest`→`renderCorridor`）。滑行期间**逐帧直接驱动卡片姿态**（`corridorPoseFrame`：不测量、无过渡，`#veil-corridor.corridor-physics` 类禁掉卡片 CSS transition，纯合成器属性；blur 按 1px 量化只在跨格时变）。↑/↓ 键与点击幽灵卡调前走 `corridorGoto` eased 滑行；跨整格时做阅读连续性（`corridorFrontCheck`：切旧卡从底部读、切新卡从顶部读）。数据变化（新回复/切会话/回读历史）走 `corridorReset` 硬复位无动画
- **长廊阶梯布局（防重叠，曾报告：用户输入行会与 agent 回复上沿/ESC 退出框重叠，独占与非独占都有）**：卡片底部锚定 + 高度不一，固定 -40px/级挡不住高度差——短卡整张叠进长卡正文、提问行压在上一条回复文字上。修复三层：① **卡顶安全线 ≥50px**（非独占 `max-height: min(24vh, calc(30vh - 60px))`、独占 `calc(100% - 62px)`），满高卡的提问行永远在左上角 ESC 框（底缘 ~42px）之下，veil-top 顶部渐隐 mask 同收窄到 46px（最新卡提问行不被洗淡，深卡从雾里探头）；② **阶梯布局 `layoutCorridorSteps`**（renderCorridor 末尾）：FLIP 手法（冻结过渡→摆基础终态→同步测量各卡视觉顶边→钉回过渡起点批量 flush→恢复过渡写终态）按实际高度链式上推，保证每张卡「提问行条带」（卡顶 padding+turn-q ≈25px）落在前一张卡顶边之上（`CORRIDOR_STRIP_STEP=24px` 视觉间距，`corridorPose(d, lift)` 里 lift 除以该深度透视缩放 k 还原成 CSS 像素）；**测量前必须 `ensureTurnContent` 渲染完内容**（renderCorridor 主循环里新旧卡都先渲染再测量，否则量的是空壳高度、lift 偏小照样叠字）；物理帧滑行中读 `dataset.lift` 沿用静止布局的阶梯值；模式切换（`toggleExclusive`→`corridorReset`）与窗口 resize（180ms 去抖）重算；③ **`turn-q` 加 `flex: 0 0 auto`、`turn-a` 加 `min-height: 0`**——满高卡不许把提问行压扁（曾测到被 flex 挤成 2.4px 高），高度紧张时正文区自己去滚
- **Enter 只归输入框**：虚窗内焦点落在按钮上时按 Enter，浏览器默认行为 = 再次点击该按钮（点过 ⛶ 后按 Enter 又切独占的误触来源）——全局 keydown 里对 `#agent-veil` 内 BUTTON 目标的 Enter `preventDefault` 并把焦点送回 `#veil-input`；空输入框聚焦时 Enter = 切 ⛶ 的设计保留（只在输入框本身上生效）
- **滑翔丝滑性关键约束**：静止布局的姿态写入与滑行的姿态驱动必须分工——**滑行中卡片不得有 CSS transition**（`corridor-physics` 类整体禁掉，物理帧逐帧设 transform）；静止落位（`layoutCorridorSteps`/`styleTurnItem`）才用 0.5s 过渡，且 FLIP 测量后必须先把「上次 computed transform」钉回过渡起点再写终态（`getBoundingClientRect` 会强制样式重算，不钉回的话滑翔从测量姿态起步、过渡被跳掉）；`ensureTurnContent` 的内容按数值键（`el.__ckUid/__ckLen`=uid+文本长度，未完成为 -1）**增量渲染**且**先于阶梯测量**（空壳高度算出的 lift 偏小照样叠字）；`.turn-item` 带 `will-change: transform, opacity, filter`，`data-depth≥3` 的深处幽灵与 `passed` 卡不做 `backdrop-filter`（3D 移动中逐帧重采样背景是最大渲染开销）。**物理帧热路径（2026-09-26 优化，滑行帧耗时 -50%）**：卡片取用/清场一律走 `corridorElMap` 注册表（turnUid→元素，`createTurnEl` 登记、renderCorridor/物理帧除名）——**别在 `corridorPoseFrame` 里用 querySelector 或 `[...box.children]` 全量扫描**；style 写入先比元素属性缓存（`__tf/__op/__blur/__zi/__isErr/__passed/__lift`）再赋值，未变化的量化档位（blur/zIndex/error 类）不碰样式；`#veil-corridor` 用 `corridorBox()` 缓存取（静态节点），`ensureTurnContent` 的键也直存元素属性不走 dataset。
- **翻卡卡顿根因与防护（2026-09-26 三轮排查定案，别走回头路）**：①「来回切换每次 ~70-110ms 主线程阻塞」的**主因是混合显卡功耗门控**——页面静止时独显休眠、第一次动画触发驱动唤醒（与页面内容/CSS/JS 完全无关：空走廊照样卡、持续有帧需求时不卡、关全部 backdrop/mask/过渡都不缓解）；防护 = 虚窗内常驻 `.veil-keepalive` 1px 离屏元素跑无限 transform 动画（index.html+style.css，虚窗 display:none 自动停，入场动画吸收首次唤醒）——**别删**。② `corridorFrontCheck`/`veilWheel` 读 `scrollHeight/clientHeight` 会强制 reflow（滑行帧刚写过样式、布局脏）：走 `turnScrollInfo` 缓存（键=内容版本+`corridorMetricsGen` 几何代，resize/独占切换递增；`ensureTurnContent` 写入后预热）。③ backdrop/filter 不进 `.turn-item` 过渡表（filter 落位跳量化档；backdrop 淡回是主线程动画，实测每次翻卡多 ~50ms 长块）；滑行（corridor-physics）与落位过渡期（corridor-settling，corridorRest/Reset 经 `corridorBeginSettle` 加、520ms 后摘）backdrop 全关，静止后瞬时恢复霜面——「运动=无霜，静止=有霜」。④**切换/翻卡预渲染（约定的「前中后三张预渲染」落法）**：`renderCorridor` 只同步渲染「当前要看的卡」（distance 最小），其余挂 `__defer` 进 `turnRenderQueue` 逐帧每帧补渲染一张并重摆阶梯——**别恢复切会话时 ≤5 张卡 Markdown 同步全量解析**（实测一次 50-150ms 主线程阻塞）；物理帧窗口 `hi = ceil(frontIdx) + 1`（向后多含一张）：**刚翻过头的卡留在 DOM/注册表里不销毁**，翻回程复用同一元素与已光栅图层（新建元素=冷图层，飞入瞬间强制光栅）；`.turn-a` 的 text-shadow 固定 **2 层**（原 4 层含 38px 大光晕——多层大半径 text-shadow 是缩放重光栅的大头，翻卡随透视缩放会整卡重栅），加层前先想光栅成本。优化后实测：8 次快速来回翻卡 0 长任务、0 帧 >25ms、最大帧间隔 8.4ms；会话来回切换 0 阻塞（原 ~100ms+）。
- **⛶ 独占模式布局**：隐形 `veil-ticker` 收成 `flex: 0 0 34px`（否则与 `flex:1` 的 veil-top 平分屏幕，一半高度被看不见的占位吃掉）；卡片 `min-height = max-height = calc(100% - 62px)` **满高撑满**（顶部安全线 50px 让开 ESC 框）——**单卡从头部（屏幕顶端）开始显示**，不再底锚悬在中下部；veil-top 顶部渐隐 mask 固定 46px（安全线下，最新卡提问行全清晰）。**独占↔非独占丝滑变形**（约定）：`.turn-item` 的过渡表含 `min-height/max-height/width/padding 0.42s`、`.veil-top` 透视 850↔1100 也走 0.42s 过渡；`toggleExclusive` 只翻类，几何交给 CSS 过渡，**阶梯布局（依赖实测高度）延时 460ms 落定后重算**（`corridorExclusiveTimer`）——立即重算会按中间态测量且 FLIP 冻结过渡，变成瞬跳
- **多会话 + 后台执行（明确约定：会话没执行完就一直在后端跑）**：消息走 `POST /api/agent/message` → 服务端起一次 **SDK `query()`**（不 await 的后台 Promise）立即 202 返回，**执行留在服务进程内**——切会话、ESC 收起虚窗、关标签页都不中断；claude.mjs 的 `runs` map 跟踪在飞会话（`AbortController` 在手，15 分钟硬超时兜底；同一会话上条消息未完再发 409）。**独占模式左侧召唤式会话栏**（`#veil-sessions`，仅独占模式存在，无按钮——输入行已按约定移除 🗂）：平时整体滑在屏幕左缘外，**鼠标贴近屏幕左缘（≤36px）滑出、移开（>300px 迟滞阈值）自动滑回**（window mousemove 判定而非实体热区——不挡长廊卡片/复制按钮点击，鼠标在正文上离左缘远天然不误触；正文卡片恒定居中不为栏让位，栏只在悬停期间暂时盖住卡片左缘；左缘另有常显竖排提条 `veil-sessions-tab`「历史会话」提醒入口，悬停/点击呼出，栏滑入后盖住它；**光标在栏上时滚轮上下都作用于会话列表 `.vs-list`**——到边界也不切回复/不滚背景页）：列出当前归属区的会话（标签 = 最近用户消息摘要，注册表 `firstQ` 字段）、执行中会话显 `● 执行中` + `⏹ 停止`（POST abort）——**新建会话按钮不在此栏**（在输入行最左，见「布局」条）；**栏内工具区（`#vs-search` + `#vs-chips`）：标题搜索（匹配 title/firstQ，**含已归档会话**）+ 类型过滤 chips（全部/普通/执行中/流水线/已归档，`agentState.sessionFilter` 前端过滤）**；**每条会话右侧有导出按钮**（`.vs-export`，通用向上导出图标，`GET /api/agent/session/:id/export` 一键下载 markdown），栏头部「批量导出」按钮把**当前过滤结果**整体 `POST /api/agent/sessions/export` 打成一个 markdown zip（前端 `downloadFromResponse` 拿 blob + Content-Disposition 文件名下载）；**归档会话条目降调 + 灰色「已归档」徽标，点击不打开**（ticker 提示仅供搜索/导出），导出按钮照常可用；焦点在栏内（搜索框输入中）时 mousemove 召唤不滑回；点条目切换（长廊整体换 `agentTurns` 引用，历史从 `GET /api/agent/session/:id/messages` 回读，`turnsBySession` 缓存）。完成检测 = 前端 3.5s 轮询 `GET /api/agent/sessions` 看 busy→idle 迁移（SSE `session.idle` 是加速路径）→ 回读历史刷新走廊；SSE `sessions.archived` = 服务端刚归档了一批会话，刷新列表；**虚窗重开/进入新归属区不挂接最近会话**（明确约定：再次进入项目不要停留在上一次会话，尤其流水线任务会话前端只读不可交互）——`syncAgentArea` 只在本页已有「在用会话且属于本区」时保持它（后台执行中的随之可见），否则空走廊起步、首条消息自动新建，历史从会话栏点开回看；**流水线会话只读**：cicd 建的任务会话与用户会话同住注册表 `gallery/agent-sessions.json`（`pipeline:true` 持久，重启不丢），sessions 列表带 🤖 流水线徽标，前端切入时输入框换只读提示、`agentSend` 拦截，服务端 `POST /api/agent/message` 对其 403；同区并发多会话可同时后台跑（每条消息独立 query + 独立 cwd，互不干扰）

- **后端架构（claude.mjs，取代旧 opencode serve 桥接）**：**无常驻 serve 进程/端口池**——每条消息 = 一次进程内 `@anthropic-ai/claude-agent-sdk` `query()`，关键 options：`cwd`=会话归属目录、`resume`=claude 会话 id（续会话）、`permissionMode:'bypassPermissions'` + `allowDangerouslySkipPermissions:true`（无人值守全放行，等价旧 opencode `permission "*"="allow"`）、`systemPrompt:{type:'preset',preset:'claude_code',append:系统指南}`（**注意这版 SDK 没有 `{type:'append'}` 独立形状，必须用 preset+append**）、`settingSources:['project']`（项目 CLAUDE.md/AGENTS.md 生效、用户级 ~/.claude 不加载）、`additionalDirectories`（图集工作区 + ~/.agents/skills，指南指定 agent 要读的）、`env`（**整体替换 process.env，必须自己展开再叠加** ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN + 关遥测）。超时/停止统一走 `AbortController`（虚窗消息 15 分钟、CI 消息 7200s）。**会话注册表 `gallery/agent-sessions.json`**（用户+流水线统一）：我们的 id `s-<hex>`（前端只见它）+ `claudeId`（SDK init 消息拿到，`resume` 用）；**turns 由后端在消息完成时落盘**（q=用户原话不含上下文块、a=最终回复/错误文案，pending 态先入后改）——历史回放、会话列表标签、流水线只读回放全走这一个文件，不依赖任何外部会话存储；上限 200 会话（按 updatedAt 淘汰）/单会话 80 turns。**启动善后僵尸 pending（2026-09-26 修）**：上次进程退出时仍在执行的轮次（容器重建/崩溃）启动时统一由 `finalizeZombieTurns` 落成「（服务重启，运行中断——这轮没有作答，请重发一次）」错误轮（与归档路径共用同一函数）——不清的话该轮永远 a:''，前端把「已完结无文本」渲染成「（本轮无文本回复——见工具执行记录）」占位符，用户以为 agent 没吭声；`messages` API 的 turns 带 `pending` 字段，前端 `apiTurnToCorridor`/`finalizeStalledTurn`（app.js）据此显示「思考与执行中」，会话不在执行却仍挂 pending 轮 → 落成「本轮执行中断」错误卡。**CLI 会话存储（/root/.claude）不在持久卷**：容器重建后 resume 旧 claudeId 报「No conversation found with session ID」exit 1——sendUserMessage/sendPipelineMessage 检测到该错误即丢 claudeId **免重发一次**（丢上下文好过该会话从此每条消息都失败）；用户消息 timer 超时（15 分钟）如实标「超时（>900s）」，不再误标「已手动停止」。**会话自动归档**：7 天不活跃（且不在 `runs` 在飞）的会话由 claude.mjs `archiveInactiveSessions` 归档——完整快照（元数据+turns）以 **gzip level 9** 压缩存到 `gallery/agent-archive/<id>.json.gz`（注册表瘦身：条目置 `archived:true`+`archivedAt` 并**剥掉 turns**；僵尸 pending 轮先落成「服务重启，运行中断」错误轮），启动 30s 后首跑 + 每小时巡一轮（unref 定时器）；归档**单向**：会话栏仍列出（可搜索/过滤/导出）但 `messages` 回空 turns、`POST /api/agent/message` 403「已归档」、前端点击不打开；注册表淘汰归档条目时连归档文件一起删；归档不触图集热更新 SSE（指纹只扫 manifest 的 entry.dir，agent-archive 天然不在内）。**导出**（claude.mjs，`sessionDoc` 生成 markdown：元数据表 + `### 👤 用户/🤖 Agent` 分轮正文，错误轮带 ⚠ 标记；文件名=标签去非法字符+id 短缀）：单会话 `exportSessionMarkdown` / 批量 `exportSessionsZip`（**零依赖最小 zip writer**：CRC32 表 + deflateRaw level 9 + UTF-8 文件名 flag bit11 + DOS 时间戳，条目名 `NN-<slug>.md` 序号防重，超过 65535 条/4GB 无 ZIP64——会话场景用不到）
- **SDK 事件 → 前端工具细流**：SDK 消息流里 assistant 的 `tool_use` block → `{type:'message.part.updated',partType:'tool',toolStatus:'running'}`，紧随 user 消息里的 `tool_result`（按 tool_use_id 配对）→ `completed/error`；run 结束 → `session.idle`（失败 `session.error`）。**事件形状沿用旧 opencode 摘要格式，前端 SSE 处理零改动**
- **模型接入**：`gallery/agent-settings.json` 只剩连接与模型配置——`baseUrl` 随子进程下发为 `ANTHROPIC_BASE_URL`（+ `API_TIMEOUT_MS=3000000`，抄官方 claude_code_env.sh；计费 Key 由 claude.mjs 按消息下发，见下）——默认 `https://open.bigmodel.cn/api/anthropic`（**智谱官方 Claude Code 适配网关**；`api.z.ai/api/anthropic` 裸请求能用但扛不住 Claude Code 富请求——大系统提示+工具定义+beta 头会间歇 400 → CLI `exit 1`，**别改回去**），留空 = 官方 Anthropic。**Key 不在设置里（全局 apiKey 已废除，约定）**：用户会话 = 发送者自己的 GLM Key（auth.mjs 用户表，**无 Key 直接 403、任何账户都不回退兜底**），流水线 = admin 账户的 Key（见「多用户登录与权限」节）。**存量迁移**：agent-settings.json 里旧的全局 apiKey 启动时一次性迁给 admin 账户后从文件清除（claude.mjs 读出 `legacyApiKey` → `adoptLegacyKey` dep）；GET settings 不含任何 Key 字段。模型值为**裸模型名**（旧 opencode 的 `zai/glm-4.5-flash` 前缀格式读取时自动剥掉）；模型下拉列表 = 设置里的 `models` 数组（⚙ 弹窗可编辑，逗号分隔）
- **设置**（⚙ 弹窗，存 `gallery/agent-settings.json`）：启用开关、API Base URL、模型（下拉=模型列表）、模型列表（逗号分隔自定义）——**无任何 Key 字段**（Key 全在 🔑 账户设置，按用户）
- **会话归属区**：`POST /api/agent/session {folder}` → cwd = **目录自身或最近带 `folderMeta.localPath` 的祖先**的存放路径（子目录随所属项目走），无则图集根；注册表按 `areaKey`（norm(cwd)）过滤。前端 `agentAreaKey(folder)` 用同一规则算归属，归属变了才新建 session（同项目内切子目录不换会话）
- **API**：`GET/PUT /api/agent/settings`、`GET /api/agent/models`（设置里的模型列表，同旧 providers 形状）、`POST /api/agent/session`、`GET /api/agent/sessions?folder=`（当前归属区会话列表 + running/pipeline/archived 标记；serveUp 恒 true，保留字段兼容前端）、`GET /api/agent/session/:id/messages`（注册表 turns 回放；**归档会话回 `{turns:[],archived:true}`**）、`GET /api/agent/session/:id/export`（单会话 markdown 附件下载，归档会话也可导出）、`POST /api/agent/sessions/export {ids}`（批量 markdown zip 附件下载，**路由必须放在 session/:id 正则之前**——`/api/agent/sessions/export` 会被该正则误吞成 id="sessions"）、`POST /api/agent/session/:id/abort`（abortController.abort + 标记，turn 落「已手动停止」）、`POST /api/agent/message {sessionId,text,context}`（**异步**：起后台 query 即返 202 `{accepted}`；系统指南经 systemPrompt append 注入、context 块拼进 prompt；**流水线会话 403、归档会话 403、发送者未设置个人 Key 403**）、`GET /api/agent/events`（SSE，claude.mjs 事件总线直推，工具细流 + session.idle 完成加速 + sessions.archived 归档通知）。**模型调用失败**：SDK 的 assistant 消息带 `error` 字段（billing_error/rate_limit/authentication_failed…）或 result 消息 subtype 非 success——统一翻成「模型调用失败/执行中断：…」错误 turn
- **实时上下文芯片**：当前目录/打开的图/右键目标 → 每条消息的 context 前缀；agent 完成后自动 `loadDiagrams+loadIssues` 刷新
- **@ 引用随项目走**：虚窗空白区可穿透点击目录树/卡片，用户切换归属区域（顶层项目 ↔ 未分类互为不同区域）时，`pruneAgentRefs()`（在 `renderAgentContext()` 开头调用）自动摘掉归属不符的 `@标签(id)`（refs 登记与输入框文本一起清）；同项目子目录切换、以及「全部图」纯浏览视图不清
- 已知坑：SDK 0.1.77 的 `systemPrompt` 只认 `string | {type:'preset',preset:'claude_code',append}`——没有 `{type:'append',prompt}`；`interrupt()` 只在 streaming input 模式可用（我们用 abortController，别改用 interrupt）；`env` 选项会**整体替换**子进程环境（必须 `{...process.env, ...}` 展开）；SDK 动态 import，node_modules 缺失时服务可启动但 agent 全挂（报「SDK 未安装——npm install」）；**baseUrl 必须是 `open.bigmodel.cn/api/anthropic`**（api.z.ai 的 anthropic 端点对 Claude Code 富请求间歇 400 → CLI exit 1，症状「Agent 运行失败：Claude Code process exited with code 1」，stderr 还是空的）；SDK 只读 cwd 的 **CLAUDE.md 不读 AGENTS.md**（`@AGENTS.md` 引用语法实测可用——code-diagram init 若要 Claude 后端受益需补写一行 `@AGENTS.md` 的 CLAUDE.md，尚未改）
- 已知坑（2026-09-26 实测排查，**容器内 agent 全挂的根因**）：① **CLI 以 root 拒跑 bypassPermissions**——容器 root 下 CLI 报「`--dangerously-skip-permissions cannot be used with root/sudo privileges`」直接 exit 1（症状同样是「Claude Code process exited with code 1」）；claude.mjs `childEnv` 已固定注入 **`IS_SANDBOX='1'`**（CLI 官方的容器出口标志），**别删**。② **CLI 异常退出时其清理链会向进程组广播 SIGTERM**——服务与 CLI 同组且原本无 SIGTERM handler，表现为「发一条消息服务就静默死亡 → docker 重启」（RestartCount 涨、日志无异常）；server.mjs 有 SIGTERM 防护（`agent.anyBusy()` 在飞时忽略该信号），claude.mjs 暴露 `anyBusy`，别拆。③ **模型名必须裸名**：前端下拉值/历史设置带 `model/` 前缀会让网关 400「模型不存在」→ CLI exit 1——`readSettingsFile`/`updateSettings`/`executeConversation`（bareModel）三处统一剥前缀 + 前端 `populateModelSelect` 的 option 值用裸名，四处一致别只改一处。排查工具：容器里 `/app` 下写探针脚本直接 `import('@anthropic-ai/claude-agent-sdk')` 跑 `query()`（须从 /app 跑否则解析不到 node_modules；options 里 `stderr` 回调抓 CLI 真实报错；装 SIGTERM handler 才能活着看到清理信号）

## 代码出图（code-diagram skill）

**空项目首次出图**的完整流程封装成技能 `.agents/skills/code-diagram/`（SKILL.md + references/，供 ZCode 直接触发；agent 后端侧经 systemPrompt 指南内联的精简版执行）。六阶段：

1. **定向**：确认 cwd 是代码项目；判断项目根有无 `AGENTS.md`；`GET /api/diagrams` 看目标目录现状
2. **init（等价 /init）**：缺 `AGENTS.md` 时按 `references/init-agents-md.md` 扫代码写出（只含可验证事实，≤120 行）；已有则不重写
3. **需求解析**：prompt → 图类型（architecture/workflow/sequence/dataflow/lifecycle）× 范围；宽泛请求默认先出 1 张系统级架构图；每轮消息 ≤2-3 张（CI/生成消息上限 7200s，虚窗消息后台跟踪上限 15 分钟）
4. **代码取证**（准确性核心）：按 `references/code-evidence.md` 先建证据台账（每个组件/连线 + 代码证据），凑不齐证据的不画
5. **写 spec + 校验**：archify 规范（showcase、locale 随用户语言、8-15 主节点、模块用 children 嵌套）→ `validate --quality showcase --json` 到 0 error 0 warning → `POST /api/import`（folder=当前目录，重生成带 replace；流水线任务带 `x-archify-ci-key` 凭证头，无凭证上下文不导入——改为提 issue：缺陷类改图 / 创建类 `POST /api/issues` kind=new-feature）
6. **验收汇报**：按 `references/quality-gates.md` 双清单（准确性/质量），汇报出图清单 + 证据基础 + **略去项声明**

**同步安装**：改技能后把 `.agents/skills/code-diagram/` 覆盖到 `~/.agents/skills/code-diagram/`（agent 后端的 additionalDirectories 覆盖那里，指南引导 agent 去读；systemPrompt 指南里的流程精简版与技能内容保持一致，改流程要两处同步）。

## Issue 机制（缺陷/改进 + 创建新图统一走 issue）

- 存储：`gallery/issues.db`（**node:sqlite**，Node ≥22.5 内置，零依赖）。表 `issues(id, diagram_id, node_id?, title, body, status open|closed, created_at, updated_at, nodes, kind, folder, refused)`；删除图时级联删 issue
  - **v3 列 `kind`/`folder`**：`kind='bug'`（缺陷/改进，挂在某张图上）| `'new-feature'`（创建新图，目录级）；创建类 `diagram_id=''`（建表 NOT NULL，空串哨兵，`issueToObject` 映射为 null）、`folder`=目标目录（null=未分类）。**新建图统一 = 提创建类 issue**（打 new feature 标签，由 Issue 流水线执行——原 `/api/generate` 通道已删除）
  - **v4 列 `refused`**：拒绝标记（看板任务队列直接拒绝）。不变式 **refused ⇒ closed**：`refused:true` 强制关闭；显式 `status:'open'` 或 `refused:false` 自动清标；只改标题等不动状态时保留标记。拒绝的 issue 不进流水线（流水线只取 open）
- API：`GET /api/issues[?diagram=]`、`POST /api/diagrams/<id>/issues {title, body?, nodes?}`（缺陷类）、**`POST /api/issues {kind:"new-feature", folder?, title, body?}`**（创建类；成功即 `cicd.kickIssueRun(目录首段)` 驱动流水线——空闲立即跑、忙则 pendingKick 接续）、`PATCH /api/issues/<id> {title?, body?, status?, nodes?, refused?}`（nodes 为多标签数组 [{id,label}]，最多 12 个；显式提交 nodes 时以它为准；refused:true=拒绝——关闭+打 refused 标）、`DELETE /api/issues/<id>`
- 注意：图 ID 是 base64url（含 `_`），路由正则必须 `[a-z0-9_-]+`
- 入口与模式（**右键提 issue 已废弃**，与 agent 虚窗互斥）：
  - **🐞 提 issue 按钮**（详情头）→ 提交模式：面板只显示输入框（列表隐藏），**点击图中组件/连线/区域**插入 `@标签(id)` 标记到标题框（Backspace 整块删除），提交时取第一个标记为 node_id
  - **🐛 按钮**（卡片或详情头）→ 整屏 Issue 列表视图（`#issue-full-list` 替代图表显示）；点条目 → **加图编辑模式**：编辑表单 + 点击图中组件直接 PATCH 该 issue 的 node_id；编辑模式下新建表单（`.di-composer`）隐藏（面板加 `edit-mode` 类，新旧表单不同屏），加标签触发的重渲染会保留表单里未保存的草稿
  - **＋ 框（目录行第一行最右）→ Issue 中心**：复用 `#issue-full-list` 的目录级视图（标题 `Issue · <目录>`，无图上下文：新标签页/🐛/🐞 按钮隐藏、iframe 隐藏），列出该目录及子目录的全部 issue（创建类显示 ✨ + new feature 标签 + 目标目录，缺陷类挂图）；底部 composer 类型**锁定「创建新图」**（bug 选项 disabled，标签行隐藏）；点条目同样进编辑（标题/描述/关闭）。**看板内不放任何新建表单**（明确约定：新建统一走 issue）
  - **composer 类型选择（`#di-kind`）**：🐞 缺陷/改进（挂当前图，可点图加标签）| ✨ 创建新图（new feature；issue 中心=中心目录，图详情切类型=图所属目录）。`setComposerKind` 切换 placeholder/标签行可见性
  - ESC 链：虚窗 → 整屏列表（图 issue / issue 中心）→ Issue 执行看板 → issue 模式 → 面板收起
- 点击路由：`__archifyModeClick(info)` 按当前模式分发（agent 索引 / issue 提交标记 / 编辑换目标 / 默认不拦截走 viewer 卡片），blocked 时注入脚本拦截事件
- **标签可读化**：`issueTargetInfo`（前端）与 `readableNodeLabel`（服务端读 issue 时）都会把 id 翻成组件名——节点=data-node-label；连线=`甲 → 乙「文本」`（两端名从图 DOM / spec 实时查）；区域=`名称（容器/区域/安全组/泳道/分组/异常泳道）`。创建类 issue 无图无 nodes、跳过翻译。注意：workflow 渲染器的 lane/group/exception-lane rect 已补 `data-composition-frame-label`（本仓改动），改渲染器时勿删；agent 索引、issue 标签、历史数据三处格式一致

## CI/CD → Issue 统一执行流水线（cicd.mjs）

**一条流水线执行所有 issue**（缺陷类改图 + 创建类出图），**定时检视（autoReview）与 AI 生成队列（/api/generate、generateQueue）已按约定删除**（旧 cicd.json 里的 autoReview 设置/generateQueue 读入即丢弃；history 里 kind=generate/review 的存量记录仍展示，标「旧任务」）。执行体是 Claude Code Agent SDK agent（claude.mjs `sendPipelineMessage`，需 ⚙ 启用 Agent，否则调度静默跳过、手动触发 400）。任务 prompt 由服务器拼装并**随消息下发运行凭证**（`x-archify-ci-key`，run 期间有效——agent 凭它调 `/api/import` 等写 API；虚窗会话拿不到凭证，写请求被 `guardGalleryWrite` 拦下）：

- **触发**：① 周期调度——**两种条件满足任一即跑（或关系，UI 设置区已用 ①② 标注说明）**：**到量**＝项目内开启 issue 数（**含创建类**）≥ `threshold`（默认 5，不必等间隔）；**到时**＝距上次运行 ≥ `intervalMinutes`（默认 60 分钟）且仍有开启 issue。防重跑护栏（`tick`）：上次失败的 run 要等满间隔才自动重试；上次没成效（没关 issue 也没动图，`lastProductive`）时，到量触发还要求比上次运行结束时的开启数（`lastOpenAfter`）新增了 issue——卡住的流水线不会每 30s 空转重跑；② **提交创建类 issue 即驱动**（`POST /api/issues` 成功后 `kickIssueRun`：有未被认领的 issue 立即开跑——同项目在跑也照样开新 run（约定）；全部被在飞 run 认领则留在 `pendingKick`，由 run 结束的 finally / 下一拍 tick 接续）；③ 看板「立即运行」手动触发（可忽略阈值/间隔，**project 可为 null=未分类**，未分类无周期调度只有手动；issue 级认领互斥见「执行」条）。**自动调度不叠 run**：tick 对已有在飞 run 的项目跳过（手动/踢入不受此限）
- **执行（executeRun）· 多会话并发**：开启 issue 先**分组**——缺陷类按图聚合（同图全部开启 issue 合并进**一个会话**：一轮代码核实 + 一次 spec 修订 + 一次 `POST /api/import` 带 replace，`issueRunPrompt` 列出该图全部 issue、要求一次替换覆盖全部修改）；创建类（kind=new-feature）**一条 issue 一个会话**（`creationIssuePrompt`，code-diagram 六阶段单图版：init AGENTS.md → 需求解析 → **代码取证** → showcase spec → 校验 0 错 → `POST /api/import` 不带 replace → 关 issue）。**多项目 run 并行 + 全局会话名额（明确约定：名额是全局的 N，不是每个项目各 N）**：所有项目的在飞 run 共用 `maxConcurrentSessions`（默认 2，1-8，全局看板顶部直接改、change 即保存；旧版按项目存的值启动时自动迁移取最大者）个名额——名额在「一条会话消息期间」持有（`acquireSessionSlot`/`releaseSessionSlot`，等用户让路时不占），释放后直接移交最早排队的等待者（可能是别的项目的 run），所以 A 占 1 个名额时 B 的 run 可同时占另外的名额；**任何触发方式（自动/踢入/手动）都不看名额占满与否——run 一定启动，会话在全局 FIFO 队列排队**（名额上调时 `pumpSessionSlots` 立即放行排队者，看板改数字即时生效）；**同项目也可多 run 并行（明确约定）**，唯一互斥是 **issue 级认领**（`runClaims`：run 在构建分组的同步原子段里认领自己的 issue id + 缺陷组图 id，后来者经 `claimedSetsFor`/`unclaimedIssues` 排除——同一条 issue 重复处理、同一张图两个缺陷组双 replace 会互相覆盖；两个 run 同毫秒启动也不会认领同一条）；每组任务 = claude.mjs `createAgentSession`（pipeline 会话入统一注册表，前端只读可见）+ `sendAgentMessage`（一次 SDK query，cwd=项目目录）——无 serve 进程，用户会话/多项目 run/同项目多 run 天然互不掐断；**同目录创建组跨 run 串行**（全局 `createFolderTails`，键 `project|folder`——出图证据按目录判定，两个 run 同时往同一目录出图会互相误认）；单轮 issue 上限 10 条，剩余下轮继续；**连续 2 组失败即熔断**（不再启动新组，剩余留待下轮；并发下结算有竞态，至多多跑 limit-1 组）、等用户让路超时同样停止发起新组。**成功完成即关 issue（按客观证据，agent 忘关的双保险）**——全部会话结束后**统一判定**（并发产物先归位再认账；证据窗口按每组消息各自开始的时间算）：缺陷组=该组消息期间所属图被替换/更新（replace 会把 issue 迁到新图 id，须按最新状态判断）→ 该组仍开启的 issue 全部 `closeIssue`；创建类=该组消息期间目标目录新增了图（**排除缺陷组替换产物**，`replacedIds`）→ `closeIssue`；未出证据则保持开启待下轮。**所有 prompt 都强制：项目有代码必须结合代码**（组件/连线/命名逐字来自代码；纯文档按文档；两者皆无才按需求文字推理并要求汇报声明）。全部条目失败 → run 记 error（看板出「重新拉起」）；部分失败保持 ok（摘要可见）
- **手动触发的三个入口**（都走 `POST /api/cicd/run`；同项目可多 run 并行，按钮**不按「在跑」禁用**，服务端按认领判定——单条 issue 在别的 run 处理中 → 409「正在另一个运行中处理」；整范围全被认领 → 409「都在别的运行中处理」）：项目看板触发设置 sheet 的「立即运行」=整范围；**待执行 issue 卡的「▶ 立即执行」= 带 `issueId` 只跑该条**（不在范围/已关闭 404；单条 run 的 history 记 `issueId`+`issueTitle`）；**历史 sheet 失败记录的「↻ 重新拉起」= 整范围重跑**（失败时 issue 都保持开启，重跑即重试）
- **存储 `gallery/cicd.json`**（启动时读入内存，手改文件不生效）：`{settings.maxConcurrentSessions（全局并发上限，1-8 默认 2；旧版项目级值读入时迁移取最大者）, settings.projects[项目].{issueAuto:{enabled,threshold,intervalMinutes}, model?}, state[项目].issues.{lastRunAt,lastResult,lastStatus,lastProductive,lastOpenAfter}, history[]}`；启动时把遗留 `running` 标为「服务重启，运行中断」。**启用瞬间（false→true）重置计时并清到量护栏**——到时从现在起算（想立刻跑用「立即运行」），存量积压 ≥ 阈值时下一拍到量触发即接手
- **调度**：30s 一拍（`tick()`，先 `drainPendingKick()` 再查周期任务），**多项目 run 并行**（在跑项目不重复启动）；失败也从运行起点算冷却（防坏流水线每 30s 重试）
- **与用户互让**：`/api/agent/message` 有在飞计数（claude.mjs `userInFlight`，覆盖整段后台执行期），流水线每条消息前等用户消息结束（≤2 分钟，超时中止本运行）；前端 `agentSend` 出错时也丢弃 session 防僵尸会话
- **单条消息 ≤7200s**（`MESSAGE_TIMEOUT_MS`，SDK 运行器 AbortController 自控超时）；每组一条消息（缺陷组同图合并改一次、控制爆炸半径）；连续 2 组失败即熔断本运行（见「执行」条）
- **运行成效客观统计**：运行前后快照比对——生成图数（新增 id）/ 更新图数（importedAt 变新）/ 关闭 issue / 新提 issue，汇总进 `history[].summary`（`处理 N 个 issue（M 个会话、并发上限 L）：关闭 X、生成图 G、更新图 Z、新提 Y`，熔断/中止时附跳过组数）
- **前端 · Issue 执行看板两级化（`#board-view`，占满图表区的整页视图，无弹窗；约定：执行队列是全局的，从各项目看板拿掉）**——两级入口，板内都是 **sheet 切换**（顶部 tabs：`board.tab`，`setBoardTab`；ESC 在非队列 sheet 先回队列、再按才关板）：
  - **全局执行看板**（入口 = **侧栏头部常显 ⏳ 按钮** `#btn-board-global`，`openGlobalBoard`）——只看执行、不管 issue：**队列 sheet** = 顶部**全局最大并发数**（`#board-concurrency`，1-8，change 即 PUT 保存）+ **正在运行**（**一 run 一卡**（`runs[]`，同项目可多卡）带并发会话分栏——queued 会话 = 等全局名额 / 同目录前一组 / 同图前一组；空态「当前没有流水线在运行」）+ **等待运行**（有开启 issue、当前没在运行的项目一行一卡：kicked 待接续的 ◇ 排最前（其 issue 全被在飞 run 认领，run 结束即接续），其余 ○ 显「等待触发（到量/到时/手动）」）；计数 = `N 个运行[ · M 个项目] · 会话 X/上限`；**历史 sheet** = 全部项目最近 10 次（每卡带项目名 chip，失败的「↻ 重新拉起」）。**全局看板不显示 issue 明细、没有任何立即执行按钮**（那些在项目级）
  - **项目级看板**（入口 = 目录行悬停 ⚡，**顶层项目与未分类行都有**，`data-fact="cicd"`，`openBoard(project)`）——**队列 sheet** = 本范围待执行 issue 队列（✨/🐞 + new feature 标签 + 标题 + 目标 + 提交时间 + **「▶ 立即执行」**（`data-board-run`，只跑该条）+ **「✕ 拒绝」**（`data-board-refuse`，关闭+refused 标；「已拒绝」分组最近 5 条，`data-board-reopen` 重开））+ **`#board-busy` 提示条**（本项目有 run 在跑时显示——**提示性**，不禁用按钮：未在处理的 issue 仍可「立即执行」，同项目多 run 并行，认领冲突由服务端 409 提示）；**历史 sheet** = 本项目最近 10 次（失败可重新拉起）；**触发设置 sheet**（仅命名项目，未分类隐藏该 tab、队列标题行放「▶ 立即执行」）= 执行模型+保存 + Issue AI 自动解决（启用/阈值/间隔/立即运行/状态行）。**项目看板不显示运行中**——执行进度与排队统一在全局看板
  - 运行中卡按并发会话分栏（约定）：run 对象带 `sessions` 数组实时更新（executeRun 里每会话 queued 排队（同目录创建组串行等前一组）→ running → done/failed，逐态 persist；`/api/cicd` 的 `running.sessions` 与 history 条目同引用），卡下每会话一栏（`.bd-sessions`，主行 = ○/▶/✓/✕ + 🐞 缺陷改图/✨ 创建新图 + 会话 N，栏下小字 ≤15 字 = 任务内容：缺陷组 `「图名」#3 #5`（服务端 `sessionDesc` 给图名留编号预算保证编号可见）、创建组 issue 标题（前端 `trunc15` 截断，title 悬停看全文））。`/api/cicd` snapshot 另带 `kicked`（pendingKick 数组——提交创建 issue 时正忙待接续的项目）与 `maxConcurrentSessions` 供全局看板渲染。issue 面板/整屏列表/issue 中心里 refused 的 issue 也带「已拒绝」标（`refusedTag`）。**数值输入框样式约定（约定）**：并发上限与触发数量/触发间隔同款配色（`var(--bg)` 背景 + focus accent 光晕——`.board-set-row input[type=number]` 规则，**别给并发框套 `.set-input`**，那是设置弹窗的 bg-soft 款）；且所有 number 输入一律**隐藏浏览器步进按钮**（style.css 全局 spinner 规则，滚轮/方向键调整保留）。**看板内没有任何新建表单**——新建图走目录行「＋」提创建 issue（见 Issue 机制节）。开板 3s 轮询（loadCicd+loadIssues，issue 被成功关闭即从待执行里消失）；点目录/图自动关板回网格。启用后目录行常显**轮廓泛红光、两眼放红光**的机器人徽标（`.ci-badge`，**悬在文件夹图标左侧的空隙里**——绝对定位 `right:100%` 不占布局空间，开启/关闭切换其他图标零位移，定稿；SVG 见 app.js `CICD_ROBOT_BADGE`：机身 currentColor、svg 级 `rb-glow` 轮廓红光 + 双眼 `.rb-eye` 强脉冲，同周期呼吸——别改回 ⚡、别改回占位/行内布局）；「下次最早」按表单当前值即时估算（未保存的修改也反映）。**已删**：✨ 徽标与 `syncGenBadges`/`pollGenLoop` 轮询（无生成队列了）、autoReview 设置区、旧版看板/设置二视图切换键（`board-mode-toggle`）

### 更新图必带 replace（重要）

spec 内容变了 → 内容哈希 id 变 → 普通导入会**新旧两张卡并存**。所以更新已有图必须 `POST /api/import` 带 `replace:"旧图id"`：新图入库 + **旧图的 issue 自动迁移到新图**（UPDATE diagram_id）+ 旧图目录删除；旧 id 不存在时静默忽略，响应带 `replaced` 字段。AGENT_SYSTEM_GUIDE 已写明此约定，CI prompt 也依赖它。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` 登录 → 200 `{user}` + Set-Cookie（HttpOnly `archify_auth`，30 天）；错 401；用户名不分大小写 |
| POST | `/api/auth/register` | `{username, password, apiKey}` 创建账户（开放注册，role=user；1-30 字符不含空白/冒号；密码 6-128；**apiKey 必填**——个人 GLM Key，8-200 字符；重名 409）→ 同登录返回 |
| POST | `/api/auth/logout` | 吊销当前令牌 + 清 Cookie |
| GET | `/api/auth/me` | 登录态 → `{user:{username, role, hasApiKey}}`；未登录 401（前端启动用它决定登录门/直接进应用） |
| POST | `/api/auth/password` | `{oldPassword, newPassword}` 改密码（**必须核对上次密码**，错 403）→ 成功吊销其他设备登录态、当前保持 |
| PUT | `/api/auth/apikey` 🔑 | `{apiKey}` 换个人 GLM API Key（claude.mjs 用户会话用它计费；admin 的 Key 同时供流水线用；显式提交才覆盖；8-200 字符） |
| GET | `/api/diagrams` | `{folders, folderMeta, diagrams}` |
| GET | `/api/events` | **图集热更新 SSE**：`{type:'gallery-update', rev, added[], removed[], changed[], foldersChanged}`（见「图集热更新」节） |
| GET | `/api/fs/list?path=` | **服务器侧目录浏览**（网页内选择项目路径用）：空 path=根视图（Windows=盘符列表 / POSIX=`/`），返回 `{os,path,parent,entries:[{name,full}]}` 只列目录——本地部署=本机磁盘，远端部署=远端服务器，不弹任何原生对话框 |
| POST | `/api/folders` | `{name, parent?, localPath?}` 建目录（自动补中间层级；**localPath 必须是已存在的文件夹**，服务端不 mkdir、也不允许 agent 代填——新建项目是用户在前端完成的；重名 409；相对路径 400；该目录下的图落盘 `<localPath>\graph\<id>\`） |
| DELETE | `/api/folders?path=` | 删空目录（含图 409），连带清 folderMeta |
| POST | `/api/import` 🔒 | `{kind: archify\|mermaid\|html, spec/code/html, name?, folder?, replace?}`；replace=旧图id 时换图（issue 迁移+删旧图） |
| POST | `/api/import-examples` 🔒 | 批量导入 `archify/examples/`（进未分类，按内容去重跳过） |
| DELETE | `/api/diagrams/:id` 🔒 | 删图（含其存储目录） |
| GET | `/api/agent/sessions?folder=` 🔑 | 当前归属区的会话列表（claude.mjs 注册表 `gallery/agent-sessions.json`）：`{serveUp(恒true), cwd, sessions:[{id,title,updatedAt,createdAt,running,pipeline,archived,firstQ,owner}]}`（running=服务端在飞 query；pipeline=true 流水线任务会话，前端只读；archived=true 已归档——只显示标题、可搜索/导出、不可打开）——**按登录态过滤：普通用户=自己的会话，admin=全部** |
| GET | `/api/agent/session/:id/messages` 🔑 | 会话历史折叠成 `{turns:[{q,a,error,pending,time}]}` 回放（pending=执行中；用户消息剥【上下文】前缀；assistant 连续消息并轮；info.error 翻成可读错误，中止=「已手动停止」、超时=「超时（>900s）」；归档会话回 `{turns:[],archived:true}`）——他人会话 403 |
| GET | `/api/agent/session/:id/export` 🔑 | 单会话导出为 markdown 附件（`attachment` + RFC5987 中文文件名；归档会话从 `agent-archive/<id>.json.gz` 解压读回，一样可导出） |
| POST | `/api/agent/sessions/export` 🔑 | `{ids:[...]}` 批量导出 markdown **zip** 附件（零依赖 zip writer，条目 `NN-<slug>.md`；归档/普通会话混装；不可见的 id 静默跳过；全无效 404） |
| POST | `/api/agent/session/:id/abort` 🔑 | 停止该会话的后台执行（abortController.abort + 清服务端运行跟踪，turn 落「已手动停止」） |
| GET | `/api/cicd` 🔑 | 流水线总览：`{agentEnabled, runs[]{project,kind,startedAt,issueId?,issueTitle?,sessions[]}, activeSessions, sessionLimit, kicked[], maxConcurrentSessions, projects, state, history, serverTime}`（runs=在飞 run 多项目并行；kicked=提交创建 issue 且该项目在跑、待接续的项目队列）——**普通用户的响应剥离 runs/kicked/maxConcurrentSessions/activeSessions/sessionLimit**（全局看板 admin 专属） |
| PUT | `/api/cicd` 🔒👑 | 两种粒度可单独或一起提交：`{maxConcurrentSessions?}`（**全局**会话并发上限 1-8 默认 2，全局看板顶部改动即保存）｜`{project, issueAuto?{enabled,threshold,intervalMinutes}, model?}`（项目须为已存在的顶层目录；数字越界自动钳制；autoReview 已删除）——**仅 admin** |
| POST | `/api/cicd/run` 🔒👑 | `{project, issueId?}` 手动触发 Issue 流水线（忽略阈值/间隔；**project 可为 null=未分类**；**issueId 只执行该条**——不在范围/已关闭 404；同项目可多 run 并行，只有目标 issue/图已被在飞 run 认领才 409；整范围无开启 issue 400）——**仅 admin** |

🔒 = **图集写保护**路由：只放行浏览器来源（用户前端）或带 `x-archify-ci-key` 运行凭证的 CI 任务，其余程序化调用 403 `agent-direct-blocked`（见「Agent 桥接」节）；`ARCHIFY_WRITE_KEY` 环境变量 + `x-archify-write-key` 同值头为手工调试逃生口（默认关闭）。👑 = **仅 admin**（非管理员登录用户 403 `admin-only`）。🔑 = 需登录（401 `unauthorized`）且按会话归属过滤。issue CRUD、`POST /api/folders`、读 API 不设防（agent curl 依赖，见「多用户登录与权限」节）。

## Mermaid 转换要点（mermaid-import.mjs）

- subgraph → 泳道；最长路径分层 → 列 0..5；**同泳道同列会碰撞**，按层序贪心错列，第 5 列溢出用 yOffset 堆叠并警告
- **回环边（重试/返回）必须先 DFS 摘除**再分层，否则层级无限抬升全部堆到第 5 列；回环边标 `role: return`
- 形状映射：`{}`→security、`[()]`→database、`(())`/`()`→frontend、`[/ /]`→external
- 裸引用节点（如后续 `A --> B` 里的 A）不得覆盖先前声明的形状/标签
- 只支持 flowchart；sequenceDiagram/stateDiagram 需人工转换

## archify 改造（嵌套组件）——改动都在 `archify/`，改完要同步安装

架构图组件支持递归 `children`：子组件 `pos` 相对父容器内容区，父容器按子包围盒自动算尺寸（30/50 规则）；碰撞检测豁免祖先-后代对；连线可垂直穿越祖先容器框（border-run 门禁管贴边跑）；拒绝父↔子直连；渲染顺序 boundaries → 容器帧(外→内) → 连线 → 叶子组件 → 标签/容器标题。

**嵌套使用指引（写 spec 的 agent 与改渲染器的维护者都适用）**：**不要怕 component 嵌套**——它是受支持的正规用法（父子几何自动解算、豁免互相碰撞），表达「模块内再分层」就放心用 children；**真正要小心的是同一嵌套层级内的兄弟碰撞**（同父 children、以及顶层组件之间）：同层卡片共享同一内容区，仍受 8px 间距契约约束，兄弟放歪就是校验 422。碰撞检测（render-architecture.mjs `rectsOverlap` 主循环）对**扁平化后的全部组件做 O(n²) 两两配对**，每对再走 `relatedByContainment`→`ancestorIds` 链做祖先-后代豁免（O(depth)），总成本 **O(n²·depth)**。当前规模（showcase 单图 8-15 主节点、嵌套后数十组件、深度 ≤3-4）为 ~万次原语操作，校验又是子进程执行——**无需优化**；若未来单图组件数涨到数百（先问该不该拆图，那已超可读性预算），优化路径按序：① 一次 DFS 预计算全部祖先-后代对存 Set（key `a|b`），配对查询降 O(1)，消掉 depth 因子；② 按 x 排序做扫描线，只测 x 区间相交的配对（O(n log n + k)，k=候选对数）。注意语义：配对是全局的、不按父分组——跨子树的容器/组件相撞也靠它抓（容器先与别人家的孩子相撞），按「同父分组」收窄候选集会漏报，别走那条路。

**关键契约**：渲染 SVG 里的注释锚点 `<!-- Components -->`、`<!-- Boundaries (behind everything) -->`、`<!-- Connection paths (before components for correct z-order) -->` 被 `delta/architecture-delta.mjs` 的幻影注入和测试用字符串匹配依赖，**不能改字**；无容器时输出与原版逐字节一致（golden 级要求）。

同步安装：把 `archify/` 覆盖到 `~/.agents/skills/archify`（排除 node_modules）。与上游原版对照/回退：另 clone 一份 [tt-a1i/archify](https://github.com/tt-a1i/archify)。

## 测试

- archify 测试：`cd archify && node --test test/*.test.mjs`；嵌套专项 `test/nested-components.test.mjs`（10 用例）
- golden（`test/golden.mjs`）与部分 cli/offline/xml 测试**要求 monorepo 布局**（引用 `../examples`、`.git`），独立安装下失败是**环境问题不是回归**——判定回归用基线对比法：同一命令在上游原版 archify 的检出里跑一遍对比失败集合；再抽查新旧渲染器对现有示例是否逐字节一致（CRLF 归一后 diff）
- CI/CD 调度逻辑测试：`createCicd(deps)` 是依赖注入工厂——写 `.tmp.mjs` 传伪造时钟/假 agent（stub `createAgentSession`/`sendAgentMessage`，记录消息文本）就能测触发/冷却/批量/409，**不要为测试真调模型**（会烧 token 改数据）
- 图集服务本身无自动化测试，手动 E2E 脚本模板：node 写 `.tmp.mjs` 用 `fetch` 调 API

## 已知的坑（Windows 本机）

1. **Git Bash 的 curl 内联中文按 GBK 发送** → 服务端 `readBody` 已做兜底（严格 UTF-8 解码失败自动按 GBK 重解码，见 `decodeBodyText`），GBK 请求体能正确入库；但自己测中文 API 仍优先用 node `fetch` 或 `--data @文件`（最确定）
2. **server.mjs 改动必须重启**（ESM 启动时加载）；`public/` 静态文件改完刷新浏览器即生效
3. Git Bash `/tmp` ≠ node 的 `/tmp`（后者解析为 `C:\tmp`）→ 临时文件放工作区或用绝对路径
4. 内置浏览器（IAB）的 playwright `locator.click()` 偶发超时 → 用 `tab.playwright.evaluate(() => el.click())` 兜底；截图偶发失败重试即可
5. `npx skills` / GitHub 克隆走本地代理（git 全局 `http.proxy` 已配置；若 git HTTPS 推送经代理断连，可改走 SSH 443 隧道）

## UI 现状（改样式前先读这段，别走回头路）

明确约定过：**无顶栏、无统计文字**（页面只有目录栏 + 图表区）；刷新/收起按钮是目录栏顶部的小图标（收起后 » 悬浮在左上角，半透明不占位）；**点图 = 整幅详情**（不是分栏、不是弹窗）；**点目录只筛选列表**（不要恢复"目录概览"面板，被明确否决过）；悬停目录的半透明浮层（~0.8 透明度）保留（浮层里显示项目的服务器存放路径）；新建目录用自定义弹窗（顶层带存放路径字段），不要用 `prompt()`。**目录树没有展开三角，也没有 ⏎ 之类的徽标**（两者先后已被否决，都别加回来）——**展开/收起状态只由文件夹图标本身区分**：收起 📁（无存放路径）/🗂️（有存放路径）/📦（未分类），展开统一换 📂（app.js `folderRowHtml` 的 `baseIcon`/`open` 逻辑，别改成只有一种图标）；点击目录行本身切换展开/收起，行为不变；行左内边距已补偿对齐：目录行 `30+depth*18`、全部图行 32px。**每个目录行第一行最右有常显「＋」框**（提创建 issue 入口，accent 蓝低透明度、悬停亮起——约定常驻可见，别挪进悬停 row-actions；点它**打开 Issue 中心**（目录级整屏视图，复用 `#issue-full-list`，composer 锁定「创建新图」类型），**不要在看板里放新建表单、也不要恢复弹窗**——新建图统一走 issue 是明确约定；新建子目录是悬停 row-actions 里的「⋯」三点点缀，与「＋」区分开，别把两个按钮合并或改回一样的图标）。**⚡（悬停 row-actions）打开项目级 Issue 看板**（顶层项目 + 未分类行都有；定时检视 autoReview 已按约定删除，别加回来；项目看板 = 本项目 issue 队列 + 历史 + 触发设置三 sheet，**不显示运行中**——执行进度统一在**全局执行看板**（侧栏头部常显 ⏳ `#btn-board-global`，队列=正在运行+等待运行+全局最大并发数，历史=全部项目最近 10 次，无 issue 明细、无立即执行；两级看板详见流水线节），两处都无任何新建表单）。**详情图连线悬停 = 流光持续周期循环**（明确约定；archify 模板自带的 relationship 流光悬停只播一次是上游设计、不是回归——持续循环由 app.js `attachZoomPan` 注入实现：`.archify-hover-flow` 类 + `archify-hover-edge-flow` 无限关键帧，54=3×(10+8) 恰好整数个虚线周期故无缝，移开恢复原线型，prefers-reduced-motion 时不启用；别把这逻辑搬进 archify 模板——模板改动牵连 golden 测试与已渲染存量图）。**多用户登录门与用户栏（见「多用户登录与权限」节）**：未登录整屏 `#auth-gate`（登录/创建账户同一张卡切换，不是弹窗），登录后侧栏**底部**用户栏（👤 用户名 + 角色徽标 + 🔑 改密码 + ⏻ 登出）——不是顶栏，别把用户信息挪到页面顶部；**⏳ 全局看板按钮与项目看板的执行/设置动作对普通用户隐藏**（admin 专属，明确约定），普通用户的项目看板只读队列+历史。存放路径的「选择路径…」是**选择图集服务器上的项目路径**：网页内置服务器目录浏览器（`GET /api/fs/list`）+ 悬停浮层显示服务器本地路径——**这是选择路径，不是 upload**：不要用 webkitdirectory 文件输入（「上传文件夹」语义）、不要弹原生对话框（服务进程常无桌面访问权，远端部署时用户也看不见）、不要预填/猜测任何盘符路径；路径校验须同时兼容 Windows（盘符/UNC）与 Linux（POSIX）。
