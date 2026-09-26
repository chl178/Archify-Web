// claude.mjs — Agent 后端桥接（Claude Code Agent SDK）。
// 取代旧 opencode serve 桥接：没有常驻 serve 进程/端口池，每条消息就是一次
// 进程内 SDK query()（cwd=项目目录、resume=续会话、AbortController 控超时/停止）。
// 后台执行 = 不 await 的 Promise（浏览器断开/切会话都不影响），完成态经
// /api/agent/sessions 轮询与 SSE session.idle 观察。
//
// 会话注册表 gallery/agent-sessions.json（用户会话 + 流水线会话统一存储，
// 取代旧 ci-sessions.json）：turns 由本模块在消息完成时落盘——虚窗历史回放
// 不再依赖外部 serve 的会话存储，重启服务也不丢。
//
// SSE 事件形状沿用旧 opencode 摘要格式（message.part.updated/session.idle/
// session.error），前端工具细流零改动。
//
// 模型接入：ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN 环境变量随子进程下发
// （默认智谱官方 Claude Code 适配网关 open.bigmodel.cn——api.z.ai/api/anthropic 裸
// 请求可用但扛不住 Claude Code 富请求，会间歇 400 → CLI exit 1；baseUrl 留空 = 官方
// Anthropic），凭据存 gallery/agent-settings.json（首次启动自动从
// ~/.local/share/opencode/auth.json 迁移 zai key）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

// 虚窗用户消息硬上限：模型极慢/工具死循环时别把在飞计数吊死（CI/CD 靠它让路）
export const USER_MESSAGE_TIMEOUT_MS = 15 * 60_000;

const DEFAULT_MODELS = [
  'glm-5.3', 'glm-5.3-flash', 'glm-4.6', 'glm-4.5-air', 'glm-4.5-flash',
  'claude-sonnet-4-5', 'claude-opus-4-1',
];
const SESSIONS_MAX = 200; // 注册表上限（按 updatedAt 淘汰；turns 随会话一起走）
const TURNS_MAX = 80; // 单会话 turns 上限（旧的从前面裁，走廊回放够用）
// 会话自动归档：7 天不活跃（且不在后台执行）→ turns 以 gzip level 9 单独压缩存档，
// 注册表只留元数据。归档会话可在会话栏搜索/导出，但不可打开交互、不可发消息（单向）。
const ARCHIVE_AFTER_MS = 7 * 24 * 3600_000;

export function createAgentBackend(deps) {
  const {
    galleryDir, archifyDir, port,
    userApiKey = () => '', // 用户会话：发送者自己的 GLM Key（任何账户都不回退兜底）
    adminApiKey = () => '', // 流水线会话的计费 Key（admin 账户）
    adoptLegacyKey = null, // 存量全局 Key 一次性迁给 admin（server.mjs 接 auth.mjs）
  } = deps;
  const settingsPath = path.join(galleryDir, 'agent-settings.json');
  const sessionsPath = path.join(galleryDir, 'agent-sessions.json');
  const archifyBin = archifyDir.replace(/\\/g, '/');
  const skillsDir = path.join(os.homedir(), '.agents', 'skills').replace(/\\/g, '/');

  // ---- 设置 ----
  // 只剩连接与模型配置；API Key 按账户走（用户=发送者的个人 Key，流水线=admin 的），
  // 全局 apiKey 字段已废除（存量的启动时一次性迁给 admin，见下方迁移块）。
  const DEFAULT_SETTINGS = {
    enabled: false,
    // 智谱官方 Claude Code 适配网关（claude_code_env.sh 同款）——api.z.ai 的 anthropic
    // 端点对 Claude Code 富请求会间歇 400（CLI exit 1），别改回去
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-4.5-flash',
    models: [...DEFAULT_MODELS],
  };

  function readSettingsFile() {
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      // 旧 opencode 时代的模型值带 provider 前缀（zai/glm-4.5-flash）——SDK 只要裸模型名
      const legacyModel = typeof data.model === 'string' ? data.model.replace(/^[A-Za-z][\w-]*\//, '').trim() : '';
      return {
        ...DEFAULT_SETTINGS,
        enabled: data.enabled === true,
        baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl.trim() : DEFAULT_SETTINGS.baseUrl,
        model: legacyModel || DEFAULT_SETTINGS.model,
        models: Array.isArray(data.models) && data.models.length
          ? data.models.map((m) => String(m).trim().replace(/^[A-Za-z][\w-]*\//, '')).filter(Boolean)
          : [...DEFAULT_MODELS],
        // 已废除的全局 Key：仅取出供迁移，不再进入运行时设置
        legacyApiKey: typeof data.apiKey === 'string' ? data.apiKey : '',
      };
    } catch {
      return { ...DEFAULT_SETTINGS, models: [...DEFAULT_MODELS], legacyApiKey: '' };
    }
  }

  const loadedSettings = readSettingsFile();
  let settings = loadedSettings;

  // 一次性迁移：存量的全局 apiKey（agent-settings.json）收编给 admin 账户（admin 已有
  // 个人 Key 时不覆盖），随后从设置文件里清掉该字段——全局 Key 概念就此废除。
  if (loadedSettings.legacyApiKey) {
    try { adoptLegacyKey?.(loadedSettings.legacyApiKey); } catch { /* 迁移失败不阻塞启动 */ }
    delete settings.legacyApiKey;
    writeSettings();
  } else {
    delete settings.legacyApiKey;
  }

  function writeSettings() {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  // 裸模型名归一：前端模型下拉的选项值带 provider 前缀（model/glm-5.3-flash），
  // 网关只认裸名——读取（readSettingsFile）、写入（updateSettings）、下发
  // （executeConversation）三处统一剥掉，任一路径漏掉都会 400「模型不存在」→ CLI exit 1
  const bareModel = (value) => String(value || '').trim().replace(/^[A-Za-z][\w-]*\//, '').trim();

  function updateSettings(body) {
    if (body.enabled !== undefined) settings.enabled = body.enabled === true;
    if (body.baseUrl !== undefined) settings.baseUrl = String(body.baseUrl).trim().slice(0, 300);
    if (body.model !== undefined) settings.model = bareModel(body.model) || DEFAULT_SETTINGS.model;
    if (body.models !== undefined) {
      const arr = Array.isArray(body.models) ? body.models : String(body.models).split(',');
      const models = arr.map((m) => bareModel(m)).filter(Boolean).slice(0, 30);
      if (models.length) settings.models = models;
    }
    writeSettings();
    return settings;
  }

  // 给前端的设置视图（连接与模型配置；API Key 不在此——按账户走 🔑 账户设置）
  function settingsView() {
    return {
      enabled: settings.enabled,
      baseUrl: settings.baseUrl,
      model: settings.model,
      models: settings.models,
      defaultModel: settings.model,
      sdkReady: sdkLoaded !== false,
    };
  }

  function modelsPayload() {
    return {
      providers: [{
        id: 'model', name: '模型',
        models: settings.models.map((m) => ({ id: m, name: m })),
      }],
    };
  }

  // ---- SDK 动态加载（node_modules 缺失时服务仍可启动，仅 agent 功能不可用）----
  let sdkCache = null;
  let sdkLoaded = null; // null=未尝试, true=就绪, false=缺失
  async function loadSdk() {
    if (sdkCache) return sdkCache;
    if (sdkLoaded === false) throw new Error('Claude Code Agent SDK 未安装——请在仓库根目录执行 npm install');
    try {
      sdkCache = await import('@anthropic-ai/claude-agent-sdk');
      sdkLoaded = true;
      return sdkCache;
    } catch {
      sdkLoaded = false;
      throw new Error('Claude Code Agent SDK 未安装——请在仓库根目录执行 npm install');
    }
  }
  loadSdk().then(() => {}, () => {}); // 启动即探测一次，settingsView 的 sdkReady 用

  // ---- 系统指南（随每条消息 append 进 system prompt，不依赖 cwd 里的 AGENTS.md）----
  const systemGuide = [
    '你是 Archify-Web 图集项目的后端 agent。工作目录是某个项目图的本地存放路径。',
    '【能力边界】你负责：查询与分析、读 spec 与代码、建子目录、增删改查 issue（含多目标标签、关闭/重开，含创建类 issue）。**你不能直接创建/修改/删除图**——POST /api/import、POST /api/import-examples、POST /api/cicd/run、PUT /api/cicd、DELETE /api/diagrams/<id> 对你一律 403 {error:"agent-direct-blocked"}（服务端硬性封锁，重试无用）。改图诉求 → 缺陷类 issue；新图诉求 → 创建类 issue（POST /api/issues kind=new-feature，会打 new feature 标签）。唯一例外：流水线任务的消息里随消息下发了运行凭证（x-archify-ci-key）时，严格按该消息的指示调用（含 POST /api/import）。也不要绕过 API 直接改 <localPath>/graph/ 下的图文件——图的产生与修改只有 Issue 流水线一条通道。',
    `图集服务跑在 http://127.0.0.1:${port}，REST API：`,
    '- GET /api/diagrams（清单：folders/folderMeta/diagrams）',
    '- POST /api/folders {name,parent?}；DELETE /api/folders?path=',
    '【项目与存放路径】新建项目（顶层目录带 localPath）只能由用户在前端完成——localPath 必须是用户实际选择的已存在文件夹，你调用 POST /api/folders 时**不要带 localPath**（不得发明/猜测存放路径，尤其不要往盘符根下建）；你只可在既有项目下建子目录。图由服务端落盘到 <localPath>/graph/<图id>/，纯本地、无 upload 概念，不需要也不应该手工往项目路径里复制文件。',
    '- 【写保护】图的产生与修改只有一条通道：issue → Issue 统一执行流水线。你直接调写接口（/api/import 等）会得到 403 agent-direct-blocked——收到它时改为提 issue（缺陷类写清改法、nodes 带目标标签；创建类用 kind=new-feature），不要重试',
    '- issue：GET /api/issues?diagram=<id>；POST /api/diagrams/<id>/issues {title,body?,nodes?}（缺陷类，挂在某张图上）；POST /api/issues {kind:"new-feature",folder,title,body?}（创建类新图，folder=目标目录、null=未分类，看板上显示 new feature 标签）；PATCH /api/issues/<id> {title?,body?,status?,nodes?,refused?}（refused:true=拒绝——关闭并打 refused 标，不再进流水线；重开自动清除）；DELETE /api/issues/<id>',
    '- curl 提交含中文的 JSON：先把请求体写入 UTF-8 临时文件再 curl --data @文件（Git Bash 内联中文会按 GBK 发送；服务端有 GBK 兜底转换，但文件方式最稳）',
    '- nodes 是目标标签数组 [{id,label}]（最多 12 个，id 不得重复——重复的会被服务端去重丢弃）：id 规则——组件=data-node-id 原值；连线=edge:from→to；区域=kind:label。label 一律用可读组件名（如「下单 API」「用户 → 订单服务「下单」」「认证栈（容器）」）。多个标签一次带上，别只提一个。',
    `archify 工具链在 ${archifyBin}：`,
    '- 校验：node archify/bin/archify.mjs validate <type> <spec.json> --quality showcase --json（诊断按 code/evidence/supportedFixes 消费，逐条修复后重校验）',
    '- 规范示例见 archify/examples/*.json；嵌套组件用 children（子 pos 相对父内容区）',
    '【流程约定】改图/建图诉求 → 落成 issue（缺陷类：标题写改法、正文写背景与证据、nodes 标目标元素；创建类：kind=new-feature、标题写要什么图、正文写范围与关注点），由流水线落实；你负责查证、写方案、代提 issue。回答用中文，简洁说明你做了什么。',
    `【新项目首次出图 · 代码→图】用户要求「根据代码 / 给本项目生成图 / 梳理这个系统」（尤其当前目录还没有图）时，你无权直接出图：① 要新图 → 代提创建类 issue（POST /api/issues {kind:"new-feature", folder:<当前目录>, title:<需求>, body:<范围/关注点>}，可帮用户把需求打磨具体），流水线会按六阶段落实（init AGENTS.md → 解析 → 代码取证 → showcase spec → 校验 0 错 → 导入 → 自动关闭）；② 有明确改法/发现的问题 → 缺陷类 issue；③ 也可先做代码梳理给出文字结论。唯一例外：消息里带 x-archify-ci-key 运行凭证的流水线任务，按其指示完整执行六阶段并导入。完整流程与验收清单：${skillsDir}/code-diagram/SKILL.md。`,
    '【回答用户问题 · 代码+图结合】涉及项目内容的问题，答案必须同时立足两边：① 代码——你的 cwd 就是项目根，先读源码/README/文档拿事实；② 图——GET /api/diagrams 找相关图，读其 spec（entry.dir 下的 spec.json）看当前视图长什么样。回答时说明依据（来自哪个文件/哪张图）；发现图与代码不一致要如实指出，并主动代提 issue（改图由流水线落实，你不要试图直接改图）。',
    '【改进意图检测】当用户的话语表达对现状的不满或改进期望（如「这里应该…」「最好能…」「这个不好看」「要是…就好了」「改成…」），而你尚未收到明确指令时：先简要回应，然后主动询问「需要我把这一点记录为 issue 吗？」。用户确认后立即调用 issue API 代为提交（带 nodes 标签，能用 bash+curl 完成就别让用户手动操作），并告知前端刷新即可看到。用户明确拒绝则不再追问。',
    '用户消息中的 @标签(id) 是他在图上点选的元素引用，上下文【用户点选的引用】里给出了所属图；这些元素也应作为 issue 的 nodes 标签。',
  ].join('\n');

  // ---- 会话注册表 ----
  let store = { v: 1, sessions: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    if (Array.isArray(raw?.sessions)) store = raw;
  } catch { /* 无文件 = 首次启动 */ }

  // 僵尸 pending 善后：上次进程退出时仍在执行的轮次（容器重建/崩溃后没有任何完成
  // 分支接手）落成中断错误轮——不清的话这轮永远 a:''，前端回读把它当「已完结但无
  // 文本」，虚窗显示「（本轮无文本回复——见工具执行记录）」，用户以为 agent 没吭声
  let zombieRevived = 0;
  for (const rec of store.sessions) zombieRevived += finalizeZombieTurns(rec.turns);
  if (zombieRevived) persistSessions();

  function persistSessions() {
    const tmp = `${sessionsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, sessionsPath);
  }

  const normCwd = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const findSession = (id) => store.sessions.find((s) => s.id === id);

  function registerSession({ cwd, title, pipeline, folder, owner }) {
    const now = Date.now();
    const record = {
      id: `s-${crypto.randomUUID().replaceAll('-', '')}`,
      claudeId: null, // SDK 首条消息的 init 才有会话 id；resume 用它
      title: String(title || '').slice(0, 120),
      firstQ: '',
      cwd,
      areaKey: normCwd(cwd),
      folder: folder ?? null,
      pipeline: Boolean(pipeline),
      owner: String(owner || ''), // 归属用户名（多用户隔离）；流水线会话为空（仅 admin 可见）
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    store.sessions.unshift(record);
    if (store.sessions.length > SESSIONS_MAX) {
      store.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      const dropped = store.sessions.splice(SESSIONS_MAX);
      // 淘汰的归档会话连归档文件一起清（归档数据不孤儿化）
      for (const rec of dropped) {
        if (rec.archived) fs.rmSync(archivePathOf(rec.id), { force: true });
      }
    }
    persistSessions();
    return record;
  }

  function touchSession(record) {
    record.updatedAt = Date.now();
    record.turns ||= [];
    if (record.turns.length > TURNS_MAX) record.turns.splice(0, record.turns.length - TURNS_MAX);
    persistSessions();
  }

  // ---- 会话归档 + 导出（markdown / zip） ----
  const archiveDir = path.join(galleryDir, 'agent-archive');
  const archivePathOf = (id) => path.join(archiveDir, `${id}.json.gz`);

  // 僵尸 pending 轮 → 中断错误轮（启动善后与归档共用；服务重启时在飞的消息没有
  // 任何完成分支接手，a 永远停在 ''）
  function finalizeZombieTurns(turns) {
    let n = 0;
    for (const t of turns || []) {
      if (!t.pending) continue;
      delete t.pending;
      t.error = true;
      t.a = t.a || '（服务重启，运行中断——这轮没有作答，请重发一次）';
      n += 1;
    }
    return n;
  }

  // 7 天不活跃且不在执行的会话 → turns 压缩存档、注册表剥掉 turns。
  // 归档是同步块（gzip+写盘+persist 一气呵成），与消息完成的 touchSession 单线程互斥。
  function archiveInactiveSessions() {
    const cutoff = Date.now() - ARCHIVE_AFTER_MS;
    let archived = 0;
    for (const rec of store.sessions) {
      if (rec.archived || runs.has(rec.id) || (rec.updatedAt || 0) >= cutoff) continue;
      // 僵尸 pending（服务重启时在飞的轮次）：落成中断错误轮，别把「思考中」冻进档案
      finalizeZombieTurns(rec.turns);
      fs.mkdirSync(archiveDir, { recursive: true });
      const snap = { ...rec, turns: rec.turns || [] };
      snap.archivedAt = Date.now();
      fs.writeFileSync(archivePathOf(rec.id), zlib.gzipSync(JSON.stringify(snap), { level: 9 }));
      rec.archived = true;
      rec.archivedAt = snap.archivedAt;
      delete rec.turns; // 注册表瘦身——归档会话不再有内联 turns
      archived += 1;
    }
    if (archived) persistSessions();
    if (archived) emitEvent({ type: 'sessions.archived', count: archived });
    return { archived };
  }

  // 读回归档会话的完整快照（含 turns）；归档文件丢失返回 null
  function archivedSnapshot(rec) {
    try {
      return JSON.parse(zlib.gunzipSync(fs.readFileSync(archivePathOf(rec.id))));
    } catch {
      return null;
    }
  }

  const fmtTs = (ms) => {
    const d = new Date(Number(ms) || 0);
    if (!d.getTime()) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // 导出文件名：可读标签去掉文件系统非法字符 + 会话 id 短缀防撞
  function fileSlug(rec) {
    const label = rec.pipeline ? (rec.title || '流水线会话') : (rec.firstQ || rec.title || '会话');
    const safe = String(label)
      .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
      .trim();
    return `${safe || '会话'}-${String(rec.id).slice(2, 8)}`;
  }

  // 会话 → 单个 markdown 文档
  function sessionDoc(rec) {
    const turns = rec.archived ? (archivedSnapshot(rec)?.turns || null) : (rec.turns || []);
    if (turns === null) return { error: '归档数据缺失（归档文件可能被删除）' };
    const label = rec.pipeline ? (rec.title || '流水线会话') : (rec.firstQ || rec.title || '新会话');
    const meta = [
      `- **类型**：${rec.pipeline ? '流水线会话（Issue 流水线自动执行，只读）' : '用户会话'}`,
      `- **状态**：${rec.archived ? `已归档（7 天未活跃，归档于 ${fmtTs(rec.archivedAt)}）` : '正常'}`,
      rec.cwd ? `- **工作目录**：\`${rec.cwd}\`` : '',
      `- **创建**：${fmtTs(rec.createdAt)}`,
      `- **最后活跃**：${fmtTs(rec.updatedAt)}`,
      `- **轮次**：${turns.length}`,
      `- **会话 ID**：${rec.id}`,
    ].filter(Boolean).join('\n');
    const dialog = turns.map((t) => {
      const q = `### 👤 用户${t.time ? ` · ${fmtTs(t.time)}` : ''}\n\n${t.q || ''}`;
      const a = t.error
        ? `### 🤖 Agent\n\n> ⚠ 此轮执行失败\n\n${t.a || ''}`
        : `### 🤖 Agent\n\n${t.a || '（无输出）'}`;
      return `${q}\n\n${a}`;
    });
    return {
      markdown: [
        `# 会话 · ${label}`,
        '',
        `> Archify-Web Agent 会话导出 · 生成于 ${fmtTs(Date.now())}`,
        '',
        meta,
        '',
        '---',
        '',
        dialog.join('\n\n---\n\n') || '（无对话记录）',
        '',
      ].join('\n'),
    };
  }

  function exportSessionMarkdown(id, user) {
    const rec = findSession(id);
    if (!rec) return { status: 404, error: '会话不存在' };
    if (!canSeeSession(rec, user)) return { status: 403, error: '无权导出该会话（属于其他用户）' };
    const doc = sessionDoc(rec);
    if (doc.error) return { status: 404, error: doc.error };
    return { filename: `${fileSlug(rec)}.md`, body: doc.markdown };
  }

  // ---- 最小 ZIP 打包器（零依赖）：deflateRaw 压缩 + UTF-8 文件名标志位 ----
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  function dosDateTime(d) {
    return {
      time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
      date: ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate())) & 0xffff,
    };
  }
  function buildZip(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
      const crc = crc32(data);
      const packed = zlib.deflateRawSync(data, { level: 9 });
      const useDeflate = packed.length < data.length;
      const body = useDeflate ? packed : data;
      const { time, date } = dosDateTime(e.date instanceof Date ? e.date : new Date());
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4); // version needed
      lh.writeUInt16LE(0x0800, 6); // flags: 文件名 UTF-8
      lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
      lh.writeUInt16LE(time, 10);
      lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(body.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      chunks.push(lh, nameBuf, body);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4); // version made by
      cd.writeUInt16LE(20, 6); // version needed
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
      cd.writeUInt16LE(time, 12);
      cd.writeUInt16LE(date, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(body.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt32LE(offset, 42);
      central.push(cd, nameBuf);
      offset += 30 + nameBuf.length + body.length;
    }
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, centralBuf, eocd]);
  }

  // 批量导出：一组会话 → 一个 markdown zip（序号前缀保持列表顺序 + 防重名）。
  // user 过滤可见性：不可见的 id 静默跳过（对调用者而言它们不存在）。
  function exportSessionsZip(rawIds, user) {
    const ids = [...new Set((Array.isArray(rawIds) ? rawIds : []).map((x) => String(x)))];
    const recs = ids.map((id) => findSession(id)).filter((rec) => rec && canSeeSession(rec, user));
    if (!recs.length) return { status: 404, error: '没有可导出的会话（可能都已被清理）' };
    const entries = recs.map((rec, i) => {
      const doc = sessionDoc(rec);
      const markdown = doc.error
        ? `# 会话 · ${fileSlug(rec)}\n\n> ⚠ ${doc.error}\n`
        : doc.markdown;
      return {
        name: `${String(i + 1).padStart(2, '0')}-${fileSlug(rec)}.md`,
        data: Buffer.from(markdown, 'utf8'),
        date: new Date(rec.updatedAt || Date.now()),
      };
    });
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return { filename: `agent-sessions-${stamp}.zip`, body: buildZip(entries) };
  }

  // 自动归档：启动 30s 后首跑 + 每小时巡一轮（unref 不拖住进程退出）
  const archiveTick = () => {
    try { archiveInactiveSessions(); } catch { /* 磁盘异常下一轮再试 */ }
  };
  setTimeout(archiveTick, 30_000).unref();
  setInterval(archiveTick, 60 * 60_000).unref();

  // ---- 在飞运行跟踪 + SSE 事件总线 ----
  const runs = new Map(); // sessionID(我们的) → { record, controller, kind:'user'|'pipeline', startedAt, aborted }
  let userInFlight = 0; // 用户消息在飞数（CI/CD 据此让路）
  // SSE 连接：{ res, allow }——allow 为 null 时全推（admin）；否则按会话归属过滤
  // （普通用户只收自己会话的工具细流/完成事件，他人与流水线的活动不串台）。
  const eventStreams = new Set();
  function emitEvent(obj) {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const stream of eventStreams) {
      if (stream.allow && !stream.allow(obj)) continue;
      try { stream.res.write(line); } catch { /* 断开的连接由 close 清理 */ }
    }
  }

  // ---- SDK 运行核心 ----
  // apiKeyOverride = 该消息的计费 Key（用户会话=发送者的个人 Key；流水线=admin 的），
  // **不回退任何全局 Key**——调用方负责先校验有 Key（无 Key 快速报错），这里只下发。
  function childEnv(apiKeyOverride) {
    const env = { ...process.env };
    // 容器内以 root 运行时 CLI 拒绝 bypassPermissions（getuid()===0 且无 IS_SANDBOX
    // → 「cannot be used with root/sudo privileges」exit 1——图集容器本就是封闭沙箱，
    // 这是 CLI 官方提供的出口标志，实测有效）
    env.IS_SANDBOX = '1';
    if (settings.baseUrl) env.ANTHROPIC_BASE_URL = settings.baseUrl;
    if (apiKeyOverride) {
      env.ANTHROPIC_AUTH_TOKEN = apiKeyOverride;
      env.ANTHROPIC_API_KEY = apiKeyOverride;
    }
    // 无人值守运行：关掉遥测/自动更新/上报等非必要外联；API_TIMEOUT_MS 抄官方
    // claude_code_env.sh（50 分钟）——默认 60s 对 GLM 长回复太紧
    env.API_TIMEOUT_MS = '3000000';
    env.DISABLE_TELEMETRY = '1';
    env.DISABLE_ERROR_REPORTING = '1';
    env.DISABLE_AUTOUPDATER = '1';
    env.DISABLE_BUG_COMMAND = '1';
    env.DISABLE_COST_WARNINGS = '1';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.NO_COLOR = '1';
    return env;
  }

  // 跑一次 query：消费全部 SDK 消息（init 拿会话 id、tool_use/tool_result 喂事件流、
  // result 拿最终回复）；超时由 timer abort 兜底。返回 {claudeId, text, error, aborted}。
  async function executeConversation({ cwd, prompt, resumeId, model, timeoutMs, controller, onEvent, apiKeyOverride }) {
    const sdk = await loadSdk();
    const stderrTail = [];
    const timer = setTimeout(() => {
      try { controller.abort(); } catch { /* 已结束 */ }
    }, timeoutMs);
    timer.unref();
    let claudeId = resumeId || null;
    let resultMsg = null;
    let assistantError = null;
    const pendingTools = new Map();
    const q = sdk.query({
      prompt,
      options: {
        cwd,
        // 网关只认裸模型名：model/glm-5.3-flash 这类带前缀的历史值在最后一道口剥掉
        ...(model ? { model: bareModel(model) } : {}),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemGuide },
        ...(resumeId ? { resume: resumeId } : {}),
        settingSources: ['project'],
        additionalDirectories: [path.dirname(archifyDir), path.dirname(skillsDir)],
        includePartialMessages: false,
        abortController: controller,
        env: childEnv(apiKeyOverride),
        stderr: (data) => {
          stderrTail.push(String(data).trim());
          if (stderrTail.length > 20) stderrTail.shift();
        },
      },
    });
    try {
      for await (const message of q) {
        if (!message) continue;
        if (message.type === 'result') { resultMsg = message; continue; }
        if (message.type === 'system' && message.subtype === 'init') { claudeId = message.session_id || claudeId; continue; }
        if (message.type === 'assistant') {
          if (message.error) assistantError = message.error;
          for (const block of message.message?.content || []) {
            if (block?.type === 'tool_use') {
              pendingTools.set(block.id, block.name);
              onEvent?.({ kind: 'tool-start', name: block.name });
            }
          }
          continue;
        }
        if (message.type === 'user') {
          for (const block of message.message?.content || []) {
            if (block?.type === 'tool_result') {
              const name = pendingTools.get(block.tool_use_id) || 'tool';
              pendingTools.delete(block.tool_use_id);
              onEvent?.({ kind: 'tool-end', name, ok: !block.is_error });
            }
          }
        }
      }
    } catch (error) {
      // 消息流异常（典型：CLI 进程直接 exit 1）。SDK 的报错只有退出码，把收集到的
      // CLI stderr 尾部拼进去——根因（如 root 拒跑/网络/鉴权）才能到达用户眼前。
      // AbortError（超时/手动停止）原样抛出，别污染「已手动停止」的判定。
      const tail = stderrTail.join('\n').trim().slice(-300);
      if (tail && error instanceof Error && error.name !== 'AbortError') {
        error.message = `${error.message}（CLI 输出：${tail}）`;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (assistantError) {
      const hint = /billing|rate_limit|authentication/i.test(String(assistantError))
        ? '（检查计费 Key 是否有效、有余额——发送者的个人 Key / 流水线为 admin 的 Key）' : '';
      return { claudeId, text: '', error: `模型调用失败（${assistantError}）${hint}` };
    }
    if (resultMsg && resultMsg.subtype === 'success') {
      return { claudeId, text: String(resultMsg.result || '').trim(), error: '' };
    }
    if (resultMsg) {
      const errs = (resultMsg.errors || []).join('; ');
      const label = resultMsg.subtype === 'error_max_turns' ? '轮次上限' : '执行中断';
      return { claudeId, text: '', error: `${label}：${errs || resultMsg.subtype}` };
    }
    // 没拿到 result 消息：进程异常退出/中断
    const tail = stderrTail.join('\n').slice(-400);
    return { claudeId, text: '', error: `Agent 运行异常结束${tail ? `：${tail}` : ''}` };
  }

  // ---- 对外：会话与消息 ----
  // 多用户可见性（auth.mjs 登录态）：admin 看全部（含流水线与他人会话）；
  // 普通用户只看 owner === 自己的用户会话——流水线会话与无主存量（升级前建的）都不可见。
  const isAdminUser = (user) => user?.role === 'admin';
  function canSeeSession(rec, user) {
    if (!user) return false;
    if (isAdminUser(user)) return true;
    return !rec.pipeline && rec.owner === user.username;
  }

  function listSessions({ cwd, user }) {
    const key = normCwd(cwd);
    return store.sessions
      .filter((s) => s.areaKey === key)
      .filter((s) => canSeeSession(s, user))
      .map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        running: runs.has(s.id),
        pipeline: s.pipeline,
        archived: Boolean(s.archived),
        firstQ: s.pipeline ? null : s.firstQ || null,
        owner: s.owner || null, // admin 视角显示归属徽标用
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function sessionTurns(id, user) {
    const rec = findSession(id);
    if (!rec) return { status: 404, error: '会话不存在' };
    if (!canSeeSession(rec, user)) return { status: 403, error: '无权访问该会话（属于其他用户）' };
    // 归档会话不回放内容（会话栏只显示标题、可搜索/导出）——打开交互被前端与服务端双重拦下
    if (rec.archived) return { turns: [], archived: true };
    return {
      turns: rec.turns.map((t) => ({ q: t.q, a: t.a, error: Boolean(t.error), pending: Boolean(t.pending), time: t.time ?? null })),
    };
  }

  function isPipelineSession(id) {
    return Boolean(findSession(id)?.pipeline);
  }

  // 一次性把事件转成前端认识的旧 opencode 摘要形状
  const toolEvent = (sessionID, ev) => {
    if (ev.kind === 'tool-start') {
      return { type: 'message.part.updated', sessionID, partType: 'tool', tool: ev.name, toolStatus: 'running' };
    }
    return {
      type: 'message.part.updated', sessionID, partType: 'tool', tool: ev.name,
      toolStatus: ev.ok ? 'completed' : 'error',
    };
  };

  // 用户消息（虚窗）：202 立即返回，执行留在本进程后台（不随 HTTP 断开终止）。
  // user = 登录态（auth.mjs）：仅会话归属者与 admin 可发。
  function sendUserMessage({ sessionId, text, context, user }) {
    const rec = findSession(sessionId);
    if (!rec) return { status: 404, body: { error: '会话不存在（可能已被清理）——请新建会话' } };
    if (!canSeeSession(rec, user)) return { status: 403, body: { error: '无权在该会话中发送消息（属于其他用户）' } };
    if (rec.pipeline) return { status: 403, body: { error: '流水线会话由 Issue 执行流水线专用，不可发送消息——请点输入行左侧 ＋ 新建会话' } };
    if (rec.archived) return { status: 403, body: { error: '该会话已归档（7 天未活跃自动归档）——归档会话仅供搜索与导出，请新建会话继续话题' } };
    if (runs.has(sessionId)) return { status: 409, body: { error: '该会话还在执行上一条消息——等它完成或先停止' } };
    // 计费 Key = 发送者自己的个人 GLM Key，任何账户都不回退兜底（用户明确要求）——
    // 未设置直接拒发，把填写入口指清楚
    const apiKeyOverride = userApiKey(user?.username);
    if (!apiKeyOverride) {
      return { status: 403, body: { error: '你的账户未设置 GLM API Key——点侧栏底部 🔑 账户设置填写后再发送（会话按各自的 Key 计费，无回退兜底）' } };
    }
    const cleanQ = String(text || '').slice(0, 8000);
    const prompt = String(context || '') + cleanQ;
    const controller = new AbortController();
    const run = { record: rec, controller, kind: 'user', startedAt: Date.now(), aborted: false };
    runs.set(sessionId, run);
    userInFlight += 1;
    rec.turns.push({ q: cleanQ, a: '', error: false, pending: true, time: Date.now() });
    if (!rec.firstQ) rec.firstQ = cleanQ.slice(0, 80);
    touchSession(rec);
    (async () => {
      const attempt = (resumeId) => executeConversation({
        cwd: rec.cwd,
        prompt,
        resumeId,
        model: settings.model,
        timeoutMs: USER_MESSAGE_TIMEOUT_MS,
        controller,
        // 发送者的个人 GLM Key（多用户各自计费，不回退）；admin 代发也按发送者算
        apiKeyOverride,
        onEvent: (ev) => emitEvent(toolEvent(sessionId, ev)),
      }).catch((error) => ({
        // 手动停止维持「已手动停止」文案；timer 超时如实标超时（旧版超时也误标成手动停止）
        claudeId: resumeId || null,
        text: '',
        error: run.aborted ? ''
          : error?.name === 'AbortError' ? `超时（>${Math.round(USER_MESSAGE_TIMEOUT_MS / 1000)}s）——本轮中断，请重发这个问题`
          : `Agent 运行失败：${String(error?.message || error).slice(0, 300)}`,
        aborted: run.aborted || error?.name === 'AbortError',
      }));
      let outcome = await attempt(rec.claudeId);
      // CLI 会话存储（/root/.claude）不在持久卷里，容器重建即丢：resume 旧 claudeId 报
      // 「No conversation found with session ID」exit 1。丢弃 claudeId 免重发一次——
      // 丢上下文好过这个会话从此每条消息都失败
      if (rec.claudeId && /No conversation found with session ID/i.test(outcome.error || '')) {
        rec.claudeId = null;
        outcome = await attempt(null);
      }
      if (outcome.claudeId && !rec.claudeId) rec.claudeId = outcome.claudeId;
      const turn = rec.turns[rec.turns.length - 1];
      if (turn?.pending) {
        delete turn.pending;
        if (outcome.error) { turn.error = true; turn.a = outcome.error; }
        else if (outcome.aborted) { turn.a = turn.a || '（本轮已手动停止）'; }
        else turn.a = outcome.text || '（无输出）';
      }
      touchSession(rec);
      runs.delete(sessionId);
      userInFlight = Math.max(0, userInFlight - 1);
      emitEvent(outcome.error
        ? { type: 'session.error', sessionID: sessionId, error: outcome.error }
        : { type: 'session.idle', sessionID: sessionId });
    })();
    return { status: 202, body: { accepted: true, sessionId } };
  }

  function abortSession(id, user) {
    const rec = findSession(id);
    if (rec && !canSeeSession(rec, user)) return { status: 403, error: '无权停止该会话（属于其他用户）' };
    const run = runs.get(id);
    if (run) {
      run.aborted = true; // executeConversation 的 AbortError 分支据此翻成「已手动停止」
      try { run.controller.abort(); } catch { /* 已结束 */ }
    }
    return { aborted: id };
  }

  // ---- 流水线（cicd.mjs）接口：同步等完整回复，凭证/并发由 cicd 管 ----
  async function createPipelineSession({ cwd, title, folder }) {
    return registerSession({ cwd, title, pipeline: true, folder });
  }

  async function sendPipelineMessage(record, prompt, { model, timeoutMs } = {}) {
    const controller = new AbortController();
    const run = { record, controller, kind: 'pipeline', startedAt: Date.now(), aborted: false };
    runs.set(record.id, run);
    record.turns.push({ q: prompt.slice(0, 400), a: '', error: false, pending: true, time: Date.now() });
    // 流水线统一用 admin 账户的个人 GLM Key（用户要求；不回退任何全局 Key）
    const apiKeyOverride = adminApiKey();
    if (!apiKeyOverride) {
      const turn = record.turns[record.turns.length - 1];
      if (turn?.pending) {
        delete turn.pending;
        turn.error = true;
        turn.a = 'admin 账户未设置 GLM API Key——请用 admin 登录，在侧栏 🔑 账户设置里填写（流水线消息按 admin 的 Key 计费）';
      }
      touchSession(record);
      runs.delete(record.id);
      return { error: turn.a };
    }
    try {
      const runOnce = (resumeId) => executeConversation({
        cwd: record.cwd,
        prompt,
        resumeId,
        model: model || settings.model,
        timeoutMs: timeoutMs || 7_200_000,
        controller,
        apiKeyOverride,
        onEvent: (ev) => emitEvent(toolEvent(record.id, ev)),
      });
      let outcome = await runOnce(record.claudeId);
      // 容器重建丢 CLI 会话存储：resume 报 No conversation found → 丢 claudeId 重发一次（同用户会话的处理）
      if (record.claudeId && /No conversation found with session ID/i.test(outcome.error || '')) {
        record.claudeId = null;
        outcome = await runOnce(null);
      }
      if (outcome.claudeId && !record.claudeId) record.claudeId = outcome.claudeId;
      const turn = record.turns[record.turns.length - 1];
      if (turn?.pending) {
        delete turn.pending;
        turn.a = outcome.error || outcome.text || '（无输出）';
        turn.error = Boolean(outcome.error);
      }
      touchSession(record);
      return outcome.error ? { error: outcome.error } : { text: outcome.text };
    } catch (error) {
      const turn = record.turns[record.turns.length - 1];
      if (turn?.pending) {
        delete turn.pending;
        turn.a = run.aborted || error?.name === 'AbortError' ? `超时（>${Math.round((timeoutMs || 7_200_000) / 1000)}s）` : `Agent 运行失败：${String(error?.message || error).slice(0, 200)}`;
        turn.error = true;
      }
      touchSession(record);
      return { error: turn?.a || 'Agent 运行失败' };
    } finally {
      runs.delete(record.id);
    }
  }

  return {
    settingsView,
    updateSettings,
    modelsPayload,
    systemGuide: () => systemGuide,
    listSessions,
    sessionTurns,
    isPipelineSession,
    registerSession,
    sendUserMessage,
    abortSession,
    createPipelineSession,
    sendPipelineMessage,
    // 归档与导出（server.mjs 路由 / 测试用）：归档幂等可重入
    archiveInactiveSessions,
    exportSessionMarkdown,
    exportSessionsZip,
    userBusy: () => userInFlight > 0,
    // 任意 SDK 运行在飞（用户 + 流水线）——server.mjs 的 SIGTERM 防护用：
    // CLI 子进程异常退出时其清理链会向进程组广播 SIGTERM，在飞期间须忽略，防误杀
    anyBusy: () => runs.size > 0,
    // SSE：server.mjs 的 GET /api/agent/events 注册 Response、close 注销。
    // user = 登录态：admin 收全部事件；普通用户只收自己会话的（无 sessionID 的
    // 广播事件如 sessions.archived 对所有人可见）。
    attachEventStream(res, cleanup, user) {
      const allow = isAdminUser(user)
        ? null
        : (ev) => {
          if (!ev.sessionID) return true;
          const rec = findSession(ev.sessionID);
          return rec ? (!rec.pipeline && rec.owner === user.username) : false;
        };
      const entry = { res, allow };
      eventStreams.add(entry);
      res.on('close', () => { eventStreams.delete(entry); cleanup?.(); });
    },
    emitEvent,
  };
}
