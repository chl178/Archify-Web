// Archify-Web 图集服务器 — 零依赖 Node HTTP 服务。
// 功能：图集展示（gallery/）、快速导入（archify JSON / Mermaid / 已渲染 HTML /
// 一键导入 archify 示例）。渲染与校验直接调用工作区内 archify 渲染器。
//
//   node server.mjs          # 默认 http://127.0.0.1:8766
//   PORT=9000 node server.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as fsp from 'node:fs/promises';
import { mermaidToWorkflow } from './mermaid-import.mjs';
import { createCicd } from './cicd.mjs';
import { createAgentBackend } from './claude.mjs';
import { createAuth } from './auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const ARCHIFY = path.join(ROOT, 'archify');
const GALLERY = path.join(ROOT, 'gallery');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8766);
// 本地默认只绑回环；Docker 等容器部署设 HOST=0.0.0.0（见 Dockerfile）
const HOST = process.env.HOST || '127.0.0.1';
const RENDER_TIMEOUT_MS = 60_000;
const BODY_LIMIT = 12 * 1024 * 1024;

const RENDERERS = {
  architecture: 'renderers/architecture/render-architecture.mjs',
  workflow: 'renderers/workflow/render-workflow.mjs',
  sequence: 'renderers/sequence/render-sequence.mjs',
  dataflow: 'renderers/dataflow/render-dataflow.mjs',
  lifecycle: 'renderers/lifecycle/render-lifecycle.mjs',
};

fs.mkdirSync(GALLERY, { recursive: true });

// ---- Agent 后端（Claude Code Agent SDK，见 claude.mjs）----------------------------
// 每条消息 = 一次进程内 SDK query()（cwd=项目目录、resume=续会话、AbortController
// 控超时/停止），无常驻 serve 进程。用户会话与流水线会话统一存
// gallery/agent-sessions.json（turns 随消息完成落盘，历史回放不依赖外部存储）。
// ---- 多用户登录（auth.mjs）：用户表 + HttpOnly Cookie 登录态 ---------------------
// 数据分离范围（用户要求）：**历史会话按用户隔离**——普通用户只见自己的会话，
// admin 见全部（含流水线会话）；**全局执行看板与流水线设置/触发仅 admin**。
// 图集本身（目录/图/issue）是共享工作区：读 API 与 issue CRUD 保持开放——虚窗与
// 流水线里的 agent 走 curl（无 Cookie/登录态），这些通道不能被登录态拦掉。
// **每用户自己的 GLM LLM API Key**：注册必填（用户要求），agent 消息按发送者的
// Key 计费（下方 userApiKey 接线 → claude.mjs childEnv）；**任何账户都不回退兜底**
// （用户明确要求）——未设置的账户发消息直接 403；流水线会话统一用 admin 账户的
// Key（adminApiKey）；agent-settings.json 里存量的全局 apiKey 启动时一次性迁给
// admin（adoptLegacyKey），全局 Key 字段已废除。
const auth = createAuth({ galleryDir: GALLERY });

const agent = createAgentBackend({
  galleryDir: GALLERY, archifyDir: ARCHIFY, port: PORT,
  // 用户会话：发送者自己的 GLM Key（auth.mjs 用户表），无 Key 由 claude.mjs 直接 403
  userApiKey: (username) => auth.apiKeyFor(username),
  // 流水线会话：admin 账户的个人 Key（用户要求）
  adminApiKey: () => auth.adminApiKey(),
  // 存量全局 Key（agent-settings.json）一次性收编给 admin 账户
  adoptLegacyKey: (key) => auth.adoptApiKeyForAdmin(key),
});
const AUTH_COOKIE = 'archify_auth';
const AUTH_MAX_AGE = 30 * 24 * 3600; // 秒，与 auth.mjs 的 TOKEN_TTL_MS 一致

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (typeof raw === 'string') {
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

// 登录用户（含内部 id/token）| null。请求级调用一次，随路由此后传递。
function authUser(req) {
  const token = parseCookies(req)[AUTH_COOKIE];
  const user = token && auth.userForToken(token);
  return user ? { ...auth.publicUser(user), id: user.id, token } : null;
}

function authCookieHeader(token) {
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_MAX_AGE}`;
}
const CLEAR_AUTH_COOKIE = `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const UNAUTHORIZED = { status: 401, body: { error: 'unauthorized', message: '请先登录' } };
const ADMIN_ONLY = { status: 403, body: { error: 'admin-only', message: '该操作仅管理员可用' } };

// ---- 图集写保护（会话 agent 不得直接创图/改图）--------------------------------
// 虚窗会话与 CI/生成任务的 agent 都从本机 curl 图集 API，网络层无法区分调用者，
// 因此图集写操作默认拒绝程序化调用，只认两种凭证：
//   ① 浏览器来源——前端页面的 same-origin fetch 自带 Origin（POST/DELETE）/Referer 头；
//   ② CI 运行凭证——服务器在 issue/生成/检视流水线运行期间随机生成、只拼进该任务的
//      prompt（x-archify-ci-key 头），run 结束即失效；虚窗会话永远拿不到。
// 生图入口由此收敛为唯一一条：issue（缺陷类改图 + 创建类出图）→ Issue 统一执行流水线。
const CI_KEY_HEADER = 'x-archify-ci-key';
// 多 run 并发（全局会话名额）：每个 run 各持一个运行凭证，结束只吊销自己的
const ciRunKeys = new Set();

function beginCiRun() {
  const key = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  ciRunKeys.add(key);
  return key;
}

function endCiRun(key) {
  ciRunKeys.delete(key);
}

// same-origin 浏览器请求：两头都查兜底（Chrome 对 same-origin POST 带 Origin，GET 带 Referer）
function isBrowserRequest(req) {
  const host = req.headers.host;
  if (!host) return false;
  const self = (scheme) => `${scheme}://${host}`;
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin === self('http') || origin === self('https')) return true;
  const referer = typeof req.headers.referer === 'string' ? req.headers.referer : '';
  return referer.startsWith(`${self('http')}/`) || referer.startsWith(`${self('https')}/`);
}

// 返回 null = 放行；否则为 403 响应（error 码供 agent 程序化识别，文案引导其提 issue）
function guardGalleryWrite(req) {
  if (isBrowserRequest(req)) return null;
  if (ciRunKeys.size && ciRunKeys.has(req.headers[CI_KEY_HEADER])) return null;
  const writeKey = process.env.ARCHIFY_WRITE_KEY; // 可选逃生口：手工 curl 调试场景，默认关闭
  if (writeKey && req.headers['x-archify-write-key'] === writeKey) return null;
  return {
    status: 403,
    body: {
      error: 'agent-direct-blocked',
      message: '图集写操作被拒绝：会话 agent 不能直接创建/修改/删除图（重试无效）。'
        + '改图请 POST /api/diagrams/<图id>/issues 提交 issue；新建图请 POST /api/issues {kind:"new-feature", folder, title, body} 提交创建 issue——两种都由 Issue 流水线解决。',
    },
  };
}

// 会话归属目录：目录自身或最近带 localPath 的祖先的存放路径（子目录随项目走），无则图集根。
// /api/agent/session 的建会话与 /api/agent/sessions 的列表共用这条规则（与前端 agentAreaKey 一致）。
function folderCwdOf(folder) {
  if (!folder) return ROOT;
  const parts = String(folder).split('/');
  for (let i = parts.length; i >= 1; i -= 1) {
    const local = readStore().folderMeta[parts.slice(0, i).join('/')]?.localPath;
    if (local) return local;
  }
  return ROOT;
}

// ---- Issue 存储（node:sqlite 轻量 DB） ----------------------------------------
const issuesDb = new DatabaseSync(path.join(GALLERY, 'issues.db'));
// WAL + NORMAL：写提交不再每次 fsync 全库（issue 创建/更新显著提速，读并发不阻塞写）；
// busy_timeout 兜底偶发的锁竞争。HTTP 路由均为短查询，同步 API 在 WAL 下停留极短。
issuesDb.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;');
issuesDb.exec(`
  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    diagram_id TEXT NOT NULL,
    node_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
issuesDb.exec('CREATE INDEX IF NOT EXISTS idx_issues_diagram ON issues(diagram_id, status);');
// v2：多目标标签（nodes = JSON 数组 [{id,label}]）；旧单 node_id 读取时自动换算
try {
  issuesDb.exec('ALTER TABLE issues ADD COLUMN nodes TEXT NOT NULL DEFAULT \'[]\'');
} catch {
  // 列已存在
}
// v3：创建类 issue（新建图统一走 issue）——kind='new-feature' 时 diagram_id 为空串
// （建表时 NOT NULL，用 '' 哨兵表示无图），folder = 目标图集目录（null=未分类）
try {
  issuesDb.exec('ALTER TABLE issues ADD COLUMN kind TEXT NOT NULL DEFAULT \'bug\'');
} catch {
  // 列已存在
}
try {
  issuesDb.exec('ALTER TABLE issues ADD COLUMN folder TEXT');
} catch {
  // 列已存在
}
// v4：拒绝标记——看板任务队列可直接拒绝 issue（closed + refused，不再进流水线）；
// 重开（status 回 open）时自动清除，维持不变式：refused ⇒ closed
try {
  issuesDb.exec('ALTER TABLE issues ADD COLUMN refused INTEGER NOT NULL DEFAULT 0');
} catch {
  // 列已存在
}

// 预编译语句缓存：issue 列表/创建/更新等高频路由不再每次 prepare 重新解析 SQL
const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) stmtCache.set(sql, (s = issuesDb.prepare(sql)));
  return s;
}

function issueToObject(row) {
  let nodes = [];
  try {
    const parsed = JSON.parse(row.nodes || '[]');
    if (Array.isArray(parsed)) {
      const seen = new Set();
      for (const n of parsed) {
        if (!n || typeof n.id !== 'string') continue;
        const id = n.id.slice(0, 100);
        if (seen.has(id)) continue; // 存量脏数据兜底：读取时也按 id 去重
        seen.add(id);
        nodes.push({ id, label: String(n.label || n.id).slice(0, 80) });
        if (nodes.length >= 12) break;
      }
    }
  } catch {
    nodes = [];
  }
  if (!nodes.length && row.node_id) nodes = [{ id: row.node_id, label: row.node_id }];
  // 标签可读化：用图的 spec 把 id 翻译成组件名（连线 → 甲 → 乙）；创建类 issue 无图可翻
  if (row.diagram_id) {
    for (const node of nodes) node.label = readableNodeLabel(row.diagram_id, node);
  }
  return {
    id: Number(row.id),
    diagramId: row.diagram_id || null, // '' 哨兵（创建类 issue）→ null
    nodeId: row.node_id ?? null,
    nodes,
    kind: row.kind === 'new-feature' ? 'new-feature' : 'bug',
    folder: row.folder ?? null,
    title: row.title,
    body: row.body,
    status: row.status,
    refused: Boolean(row.refused),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// diagramId → Map(元素id → 组件名)。spec 内容变化会生成新图 id，缓存天然稳定。
const specLabelCache = new Map();

function specLabelMapFor(diagramId) {
  if (specLabelCache.has(diagramId)) return specLabelCache.get(diagramId);
  // 容量上限：被删图的旧映射不清会一直占内存，超限时按插入序淘汰最老的
  if (specLabelCache.size >= 300) {
    const oldest = specLabelCache.keys().next().value;
    specLabelCache.delete(oldest);
  }
  const map = new Map();
  try {
    const store = readStore();
    const entry = store.diagrams.find((d) => d.id === diagramId);
    if (entry) {
      const dir = entry.dir || path.join(GALLERY, diagramId);
      const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
      const walk = (obj) => {
        if (Array.isArray(obj)) {
          obj.forEach(walk);
          return;
        }
        if (obj && typeof obj === 'object') {
          if (typeof obj.id === 'string' && typeof obj.label === 'string' && obj.label) {
            map.set(obj.id, obj.label);
          }
          for (const value of Object.values(obj)) walk(value);
        }
      };
      walk(spec);
    }
  } catch {
    // spec 缺失/损坏：回退裸 id
  }
  specLabelCache.set(diagramId, map);
  return map;
}

// 把目标 id 翻译成可读组件名：
// - 节点：spec 里的 label（如 u → 用户）
// - 连线 edge:a→b：甲 → 乙（保留原连线文本时附「文本」）
// - 区域 kind:label：冒号后的名称
function readableNodeLabel(diagramId, node) {
  const id = node.id;
  const existing = node.label && node.label !== id ? node.label : null;
  if (id.startsWith('edge:')) {
    const [from, to] = id.slice(5).split('→');
    const map = specLabelMapFor(diagramId);
    const text = existing?.match(/「([^」]*)」/)?.[1] || '';
    const fl = map.get(from) || from;
    const tl = map.get(to) || to;
    return `${fl} → ${tl}${text ? `「${text}」` : ''}`;
  }
  const colon = id.indexOf(':');
  if (colon > 0 && !id.startsWith('edge')) {
    const kind = id.slice(0, colon);
    const kindName = {
      container: '容器', region: '区域', 'security-group': '安全组',
      lane: '泳道', group: '分组', 'exception-lane': '异常泳道',
    }[kind];
    // 形如 lane:lane / group:group 的旧渲染帧（无 label）：按索引回查 spec 名称
    const rawLabel = id.slice(colon + 1);
    if ((kind === 'lane' || kind === 'group' || kind === 'exception-lane') && /^(lane|group)-\d+/.test(rawLabel)) {
      try {
        const store = readStore();
        const entry = store.diagrams.find((d) => d.id === diagramId);
        const dir = entry.dir || path.join(GALLERY, diagramId);
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
        const list = kind === 'group' ? parsed.groups : parsed.lanes;
        const index = Number(rawLabel.match(/(\d+)/)?.[1] ?? -1);
        const found = Array.isArray(list) ? list[index] : null;
        const laneLabel = found?.label || rawLabel;
        return `${laneLabel}（${kindName || kind}）`;
      } catch {
        return `${rawLabel}（${kindName || kind}）`;
      }
    }
    return `${rawLabel || existing || id}${kindName ? `（${kindName}）` : ''}`;
  }
  if (existing) return existing; // 已可读（前端/agent 提交时带的名字）
  const map = specLabelMapFor(diagramId);
  return map.get(id) || id;
}

function sanitizeNodes(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const nodes = [];
  for (const n of input) {
    if (!n || typeof n.id !== 'string' || !n.id.trim()) continue;
    const id = n.id.trim().slice(0, 100);
    if (seen.has(id)) continue; // 同 id 标签去重，只留第一个
    seen.add(id);
    nodes.push({ id, label: String(n.label || n.id).trim().slice(0, 80) || n.id });
    if (nodes.length >= 12) break;
  }
  return nodes;
}

function listIssues({ diagramId } = {}) {
  const rows = diagramId
    ? stmt('SELECT * FROM issues WHERE diagram_id = ? ORDER BY status = \'closed\', id DESC').all(diagramId)
    : stmt('SELECT * FROM issues ORDER BY status = \'closed\', id DESC').all();
  return rows.map(issueToObject);
}

// ---- Manifest (v2: project folders + folder-stamped diagrams) -----------------
const MANIFEST_PATH = path.join(GALLERY, 'manifest.json');

// manifest 只在 mtime/size 变化时重读（每个 API 请求都要 readStore，别每次都读盘+parse）
let storeCache = { stamp: '', store: null };
function readStore() {
  let stamp = '';
  try {
    const st = fs.statSync(MANIFEST_PATH);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch { /* 文件不存在时走解析兜底 */ }
  if (storeCache.store && storeCache.stamp === stamp) return storeCache.store;
  const parsed = (() => {
    try {
      const data = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
      if (Array.isArray(data)) {
        // v1 migration: bare diagram array becomes folder-less v2.
        return { version: 2, folders: [], folderMeta: {}, diagrams: data.map((d) => ({ ...d, folder: d.folder ?? null })) };
      }
      return {
        version: 2,
        folders: Array.isArray(data.folders) ? data.folders : [],
        folderMeta: data.folderMeta && typeof data.folderMeta === 'object' ? data.folderMeta : {},
        diagrams: Array.isArray(data.diagrams) ? data.diagrams : [],
      };
    } catch {
      return { version: 2, folders: [], folderMeta: {}, diagrams: [] };
    }
  })();
  storeCache = { stamp, store: parsed };
  return parsed;
}

function writeStore(store) {
  const tmp = `${MANIFEST_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    version: 2,
    folders: store.folders,
    folderMeta: store.folderMeta || {},
    diagrams: store.diagrams,
  }, null, 2));
  fs.renameSync(tmp, MANIFEST_PATH);
  broadcastGalleryUpdate().catch(() => {}); // API 变更立即广播给所有打开的页面（外部文件变化由轮询兜底）
}

// /api/diagrams 响应体缓存：JSON.stringify 大清单只在 manifest 变化时做一次
// （前端每次加载/SSE 更新都会拉它），同一版本内反复命中。
let diagramsPayloadCache = { stamp: '', json: null };
function diagramsPayloadJson() {
  const store = readStore();
  if (storeCache.stamp !== diagramsPayloadCache.stamp || !diagramsPayloadCache.json) {
    diagramsPayloadCache = {
      stamp: storeCache.stamp,
      json: JSON.stringify({ folders: store.folders, folderMeta: store.folderMeta, diagrams: store.diagrams }),
    };
  }
  return diagramsPayloadCache.json;
}

// ---- 图集热更新（变化检测 + SSE 广播） ------------------------------------------
// 各项目的图可能被外部更新（agent / CI / 用户直接替换 <localPath>/graph/<id>/ 下的文件）。
// 服务端周期扫描 manifest + 每图文件的 stat 指纹，diff 出 added/removed/changed，
// 经 GET /api/events（SSE）推给浏览器，前端自动刷新——无需手动 F5，多标签页天然同步。
const galleryEvents = new Set(); // 打开的 SSE 连接
let galleryRev = 0;
let gallerySnapshot = null; // { foldersKey, sigs: Map(id → 指纹) }

function galleryEventSend(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of galleryEvents) {
    try { res.write(data); } catch { /* 断开的连接由 close 事件清理 */ }
  }
}

// 单图指纹 = entry 元数据 + 目录内关键文件的 size+mtime（spec/diagram/thumb/thumb.svg）。
// 目录可能在用户选择的项目存放路径下（entry.dir），stat 天然覆盖本地/任一项目位置。
// stat 全部走异步（fs/promises）：大图集一轮扫描几十上百次 stat 不再阻塞事件循环，
// 并发请求（SSE/静态/agent 消息）在扫描期间照常响应。
async function diagramSignature(entry) {
  const dir = entry.dir || path.join(GALLERY, entry.id);
  const parts = [JSON.stringify(entry)];
  for (const key of ['specFile', 'htmlFile', 'thumbFile']) {
    if (!entry[key]) continue;
    try {
      const st = await fsp.stat(path.join(dir, entry[key]));
      parts.push(`${key}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${key}:-`);
    }
  }
  try {
    const st = await fsp.stat(path.join(dir, 'thumb.svg'));
    parts.push(`thumbSvg:${st.size}:${st.mtimeMs}`);
  } catch {
    parts.push('thumbSvg:-');
  }
  return parts.join('|');
}

let galleryScanning = false;
let galleryRescanQueued = false;

// 扫描并对比快照，返回 diff（无变化返回 null）；silent=true 只重建基线（启动时用）。
// 与同步时代的语义一致，只是 stat 异步化 + 小并发批扫（8 张一批，不一次打满 IO）。
async function scanGalleryChanges({ silent = false } = {}) {
  if (galleryScanning) {
    // 正在扫时又来了触发（如 writeStore 广播与轮询撞车）：这轮丢弃，扫完自动补一轮，
    // 保证写库后的最终一致状态一定会被 diff 到并广播出去
    galleryRescanQueued = true;
    return null;
  }
  galleryScanning = true;
  try {
    const store = readStore();
    const foldersKey = JSON.stringify([store.folders, store.folderMeta]);
    const sigs = new Map();
    const CONC = 8;
    for (let i = 0; i < store.diagrams.length; i += CONC) {
      const slice = store.diagrams.slice(i, i + CONC);
      const sigList = await Promise.all(slice.map(diagramSignature));
      slice.forEach((entry, k) => sigs.set(entry.id, sigList[k]));
    }
    const prev = gallerySnapshot;
    gallerySnapshot = { foldersKey, sigs };
    if (silent || !prev) return null;
    const added = [];
    const changed = [];
    for (const [id, sig] of sigs) {
      if (!prev.sigs.has(id)) added.push(id);
      else if (prev.sigs.get(id) !== sig) changed.push(id);
    }
    const removed = [...prev.sigs.keys()].filter((id) => !sigs.has(id));
    const foldersChanged = prev.foldersKey !== foldersKey;
    if (!added.length && !removed.length && !changed.length && !foldersChanged) return null;
    return { added, removed, changed, foldersChanged };
  } finally {
    galleryScanning = false;
    if (galleryRescanQueued) {
      galleryRescanQueued = false;
      setImmediate(() => { broadcastGalleryUpdate().catch(() => {}); });
    }
  }
}

async function broadcastGalleryUpdate() {
  const diff = await scanGalleryChanges();
  if (!diff) return;
  galleryRev += 1;
  // 外部直接改 spec.json（id 不变内容变）时清标签缓存，issue 标签翻译不留旧组件名
  for (const id of diff.changed) specLabelCache.delete(id);
  galleryEventSend({ type: 'gallery-update', rev: galleryRev, ...diff });
  if (diff.foldersChanged) refreshGalleryWatchers(); // 目录结构/存放路径变了，重挂监听
}

// ---- 变更检测快路径：fs.watch（gallery/ + 各项目存放路径的 graph/）----------------
// 轮询（兜底）有秒级延迟；监听器命中时外部改图（agent/CI/直接替换文件）毫秒级感知。
// 任意目录监听失败（网络盘/权限/内核限制）都静默降级为纯轮询，不影响正确性。
const galleryWatchers = new Map(); // dir → FSWatcher
let galleryWatchDebounce = null;

function refreshGalleryWatchers() {
  const dirs = new Set([GALLERY]);
  for (const meta of Object.values(readStore().folderMeta || {})) {
    if (meta?.localPath) dirs.add(path.join(meta.localPath, 'graph'));
  }
  for (const [dir, watcher] of [...galleryWatchers]) {
    if (dirs.has(dir)) { dirs.delete(dir); continue; }
    try { watcher.close(); } catch { /* 已关 */ }
    galleryWatchers.delete(dir);
  }
  for (const dir of dirs) {
    if (galleryWatchers.has(dir)) continue;
    try {
      const watcher = fs.watch(dir, { recursive: true, persistent: false }, () => {
        clearTimeout(galleryWatchDebounce);
        galleryWatchDebounce = setTimeout(() => {
          galleryWatchDebounce = null;
          broadcastGalleryUpdate().catch(() => {});
        }, 150); // 短去抖：一次导入连写多个文件只触发一轮扫描
      });
      // FSWatcher 的 error 事件（目录被删/权限收回）若无人监听会直接抛崩进程
      watcher.on('error', () => {
        try { watcher.close(); } catch { /* 已关 */ }
        galleryWatchers.delete(dir);
      });
      galleryWatchers.set(dir, watcher);
    } catch { /* 不可监听 → 轮询兜底 */ }
  }
}

const FOLDER_NAME_MAX = 40;

function validFolderPath(value) {
  return typeof value === 'string' && value.length > 0
    && value.split('/').every((part) => part.trim().length > 0 && part.trim().length <= FOLDER_NAME_MAX && part !== '未分类');
}

function folderAndDescendants(folders, folderPath) {
  const prefix = `${folderPath}/`;
  return folders.filter((f) => f === folderPath || f.startsWith(prefix));
}

// 目录关联了存放路径时，该目录下的图写入本地路径的 graph/ 子目录（与项目代码同盘共处）；否则写入默认 gallery/。
function storageDirFor(folder, id) {
  const meta = folder ? readStore().folderMeta[folder] : null;
  const base = meta?.localPath;
  return base ? path.join(base, 'graph', id) : path.join(GALLERY, id);
}

// ---- Helpers ------------------------------------------------------------------
function runNode(args, { cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd, timeout: RENDER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, killed: Boolean(error?.killed), stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function hashId(content) {
  return crypto.createHash('sha256').update(content).digest('base64url').slice(0, 10).toLowerCase();
}

// <img> 加载独立 SVG 时根元素必须显式声明 SVG 命名空间——HTML 内联 <svg> 由解析器
// 自动归入 SVG 命名空间，但独立文件缺 xmlns 会被浏览器判为非 SVG 文档，整图拒绝渲染
function ensureSvgNamespace(svg) {
  const open = svg.match(/<svg\b[^>]*>/)?.[0];
  if (!open) return svg;
  let tag = open;
  if (!/\sxmlns=/.test(tag)) tag = tag.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (/\bxlink:/.test(svg.slice(open.length)) && !/\sxmlns:xlink=/.test(tag)) {
    tag = tag.replace(/^<svg\b/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  return tag === open ? svg : svg.replace(open, tag);
}

function extractThumb(html) {
  const svg = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
  if (!svg) return null;
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  return {
    svg,
    styles,
    // 自包含 SVG（样式内嵌进 <svg>，img 引用时独立渲染，不依赖外部 CSS；
    // 渲染器样式里的 body/全局规则被隔离在 SVG 文档内，不会污染图集页面）
    svgStandalone: ensureSvgNamespace(styles
      ? svg.replace(/<svg\b[^>]*>/, (open) => `${open}<style><![CDATA[${styles}]]></style>`)
      : svg),
    viewBox: viewBox ? [Number(viewBox[1]), Number(viewBox[2])] : null,
    html: `<!DOCTYPE html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><style>${styles}</style><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}svg{display:block;width:100%;height:100%}</style></head><body>${svg}</body></html>`,
  };
}

// 存量数据迁移：从已有 thumb.html 提取自包含 thumb.svg（过滤掉 thumb 布局注入块）
function ensureThumbSvgFile(entry) {
  const dir = entry.dir || path.join(GALLERY, entry.id);
  const thumbPath = path.join(dir, 'thumb.html');
  const svgPath = path.join(dir, 'thumb.svg');
  let thumbHtml;
  try {
    thumbHtml = fs.readFileSync(thumbPath, 'utf8');
  } catch {
    return; // 无缩略图
  }
  try {
    const stSvg = fs.statSync(svgPath);
    if (stSvg.mtimeMs >= fs.statSync(thumbPath).mtimeMs) {
      const existing = fs.readFileSync(svgPath, 'utf8');
      if (/<svg\b[^>]*\sxmlns=/.test(existing)) return; // 已是最新且命名空间齐全
    }
  } catch { /* 不存在 → 生成 */ }
  const svg = thumbHtml.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
  if (!svg) return;
  const styles = [...thumbHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .filter((block) => !block.includes('html,body{margin:0')) // 排除 thumb.html 的布局注入块
    .join('\n');
  fs.writeFileSync(svgPath, ensureSvgNamespace(styles
    ? svg.replace(/<svg\b[^>]*>/, (open) => `${open}<style><![CDATA[${styles}]]></style>`)
    : svg));
}

async function validateSpec(type, specPath) {
  const result = await runNode([
    path.join(ARCHIFY, 'bin/archify.mjs'), 'validate', type, specPath, '--json',
  ], { cwd: ARCHIFY });
  let receipt = null;
  try {
    receipt = JSON.parse(result.stdout);
  } catch {
    receipt = null;
  }
  if (!receipt) {
    return { ok: false, error: `校验器输出异常（exit ${result.code}）：${result.stderr.slice(0, 400) || result.stdout.slice(0, 400)}` };
  }
  return { ok: receipt.ok === true, receipt };
}

async function renderSpec(type, specPath, htmlPath) {
  const result = await runNode([
    path.join(ARCHIFY, RENDERERS[type]), specPath, htmlPath,
  ], { cwd: ARCHIFY });
  return { ok: result.code === 0 && fs.existsSync(htmlPath), stderr: result.stderr };
}

async function importArchifySpec(spec, { source, sourceFile, name, warnings = [], folder = null, replace = null }) {
  const type = spec?.diagram_type;
  if (!RENDERERS[type]) {
    return { status: 400, body: { error: `不支持的 diagram_type：${type}（支持 ${Object.keys(RENDERERS).join(' / ')}）` } };
  }
  if (folder !== null && !validFolderPath(folder)) {
    return { status: 400, body: { error: `非法目录路径：${folder}（每级 1-40 字符，不能包含未分类保留名）` } };
  }
  const specJson = JSON.stringify(spec, null, 2) + '\n';
  const id = `d-${hashId(specJson)}`;
  const dir = storageDirFor(folder, id);
  const specPath = path.join(dir, 'spec.json');
  const htmlPath = path.join(dir, 'diagram.html');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(specPath, specJson);

  const validation = await validateSpec(type, specPath);
  if (!validation.ok) {
    await fsp.rm(dir, { recursive: true, force: true });
    return {
      status: 422,
      body: {
        error: '校验未通过，未导入图集',
        title: spec?.meta?.title || name || id,
        warnings,
        receipt: validation.receipt || { error: validation.error },
      },
    };
  }

  const rendered = await renderSpec(type, specPath, htmlPath);
  if (!rendered.ok) {
    await fsp.rm(dir, { recursive: true, force: true });
    return { status: 422, body: { error: `渲染失败：${rendered.stderr.slice(0, 400)}` } };
  }

  const html = await fsp.readFile(htmlPath, 'utf8');
  const thumb = extractThumb(html);
  const thumbPath = path.join(dir, 'thumb.html');
  if (thumb) {
    await fsp.writeFile(thumbPath, thumb.html);
    await fsp.writeFile(path.join(dir, 'thumb.svg'), thumb.svgStandalone);
  }

  const entry = {
    id,
    title: spec.meta?.title || name || '未命名图',
    type,
    locale: spec.meta?.locale || 'en',
    source,
    ...(folder ? { folder } : {}),
    ...(dir !== path.join(GALLERY, id) ? { dir } : {}),
    ...(sourceFile ? { sourceFile } : {}),
    importedAt: new Date().toISOString(),
    ...(thumb?.viewBox ? { viewBox: thumb.viewBox } : {}),
    specFile: 'spec.json',
    htmlFile: 'diagram.html',
    ...(thumb ? { thumbFile: 'thumb.html' } : {}),
    specBytes: Buffer.byteLength(specJson),
    htmlBytes: html.length,
    ...(warnings.length ? { warnings } : {}),
  };
  const store = readStore();
  // 落盘位置变化（如旧布局 <localPath>/<id> → <localPath>/graph/<id>）时清掉旧目录，防孤儿
  const prevEntry = store.diagrams.find((item) => item.id === id);
  if (prevEntry?.dir && prevEntry.dir !== dir) await fsp.rm(prevEntry.dir, { recursive: true, force: true });
  store.diagrams = store.diagrams.filter((item) => item.id !== id);
  // replace：更新已有图。spec 内容变了哈希 id 就变——把旧图替换掉（issue 迁移到
  // 新图、删旧目录），防止「优化后新旧两张卡并存」。旧 id 不存在时静默忽略。
  let replaced = null;
  if (replace && replace !== id) {
    const old = store.diagrams.find((item) => item.id === replace);
    if (old) {
      stmt('UPDATE issues SET diagram_id = ? WHERE diagram_id = ?').run(id, replace);
      await fsp.rm(old.dir || path.join(GALLERY, old.id), { recursive: true, force: true });
      store.diagrams = store.diagrams.filter((item) => item.id !== replace);
      replaced = replace;
    }
  }
  store.diagrams.unshift(entry);
  writeStore(store);
  return { status: 200, body: { imported: entry, ...(replaced ? { replaced } : {}) } };
}

async function importRenderedHtml(html, { name, folder = null }) {
  const svg = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
  const isArchify = /generator" content="archify/i.test(html) || /data-composition-points=/.test(html);
  if (!svg || !isArchify) {
    return { status: 422, body: { error: '该 HTML 不是 archify 渲染产物（缺少 archify SVG 标记）' } };
  }
  if (folder !== null && !validFolderPath(folder)) {
    return { status: 400, body: { error: `非法目录路径：${folder}` } };
  }
  const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/ Diagram$/i, '').trim() || name || '导入的图';
  const id = `h-${hashId(html)}`;
  const dir = storageDirFor(folder, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'diagram.html'), html);
  const thumb = extractThumb(html);
  if (thumb) {
    await fsp.writeFile(path.join(dir, 'thumb.html'), thumb.html);
    await fsp.writeFile(path.join(dir, 'thumb.svg'), thumb.svgStandalone);
  }
  const entry = {
    id,
    title,
    type: 'html',
    locale: 'en',
    source: 'html',
    ...(folder ? { folder } : {}),
    ...(dir !== path.join(GALLERY, id) ? { dir } : {}),
    importedAt: new Date().toISOString(),
    ...(thumb?.viewBox ? { viewBox: thumb.viewBox } : {}),
    htmlFile: 'diagram.html',
    ...(thumb ? { thumbFile: 'thumb.html' } : {}),
    htmlBytes: html.length,
  };
  const store = readStore();
  // 同上：同 id 刷新但落盘位置变化时清旧目录，防孤儿
  const prevHtmlEntry = store.diagrams.find((item) => item.id === id);
  if (prevHtmlEntry?.dir && prevHtmlEntry.dir !== dir) await fsp.rm(prevHtmlEntry.dir, { recursive: true, force: true });
  store.diagrams = store.diagrams.filter((item) => item.id !== id);
  store.diagrams.unshift(entry);
  writeStore(store);
  return { status: 200, body: { imported: entry } };
}

async function importExamples() {
  const examplesDir = path.join(ARCHIFY, 'examples');
  const files = (await fsp.readdir(examplesDir)).filter((f) => f.endsWith('.json')).sort();
  const imported = [];
  const failed = [];
  const skipped = [];
  const store = readStore();
  for (const file of files) {
    const sourceFile = `examples/${file}`;
    try {
      const spec = JSON.parse(await fsp.readFile(path.join(examplesDir, file), 'utf8'));
      const specJson = JSON.stringify(spec, null, 2) + '\n';
      const existing = store.diagrams.find((item) => item.sourceFile === sourceFile);
      if (existing && existing.specBytes === Buffer.byteLength(specJson) && !existing.folder) {
        skipped.push(file);
        continue;
      }
      const result = await importArchifySpec(spec, { source: 'example', sourceFile, name: file, folder: existing?.folder ?? null });
      if (result.status === 200) imported.push(result.body.imported.title);
      else failed.push({ file, error: result.body.error, receipt: result.body.receipt });
    } catch (error) {
      failed.push({ file, error: `读取失败：${error.message}` });
    }
  }
  return { status: 200, body: { imported: imported.length, importedTitles: imported, skipped: skipped.length, failed } };
}

// ---- HTTP plumbing ------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body, headers = null) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) });
  res.end(payload);
}

// ---- 响应压缩与静态资源内存缓存 --------------------------------------------------
// 性能主路径：缩略图（~300KB SVG）/整图 HTML（~800KB）/前端资产原本每次请求同步读盘
// 且零压缩裸传。现在：① 文件进内存缓存（size+mtime 失效，LRU 淘汰）；② 文本资源
// 在缓存填充时一次性 brotli/gzip 预压缩（异步，不阻塞事件循环），命中后零 CPU 反复发；
// ③ URL 带 ?v=<rev>（前端图文件版本戳）视为内容永不变 → immutable 一年，浏览器
// 连再验证请求都不发；无 v 的维持 no-cache + ETag 304 语义（与旧行为兼容）。
const brotliCompress = (buf, opts) => new Promise((resolve, reject) => {
  zlib.brotliCompress(buf, opts, (err, out) => (err ? reject(err) : resolve(out)));
});
const gzipCompress = (buf, opts) => new Promise((resolve, reject) => {
  zlib.gzip(buf, opts, (err, out) => (err ? reject(err) : resolve(out)));
});

const COMPRESSIBLE_EXT = new Set(['.html', '.css', '.js', '.json', '.svg']);
const STATIC_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const STATIC_CACHE_MAX_ENTRIES = 512;
const staticCache = new Map(); // abs path → {size,mtimeMs,etag,mime,raw,br,gz}
const staticInflight = new Map(); // abs path → Promise（并发同文件只读/压一次）

function encPreference(req) {
  const ae = String(req?.headers?.['accept-encoding'] || '');
  if (ae.includes('br')) return 'br';
  if (ae.includes('gzip')) return 'gzip';
  return null;
}

function staticCacheStore(abs, entry) {
  staticCache.delete(abs);
  staticCache.set(abs, entry);
  let bytes = 0;
  for (const e of staticCache.values()) bytes += e.raw.length;
  while (staticCache.size > 1 && (staticCache.size > STATIC_CACHE_MAX_ENTRIES || bytes > STATIC_CACHE_MAX_BYTES)) {
    const oldest = staticCache.keys().next().value; // Map 插入序 + 命中重插 ≈ LRU
    bytes -= staticCache.get(oldest).raw.length;
    staticCache.delete(oldest);
  }
}

async function staticEntryFill(resolved, st) {
  const raw = await fsp.readFile(resolved);
  const mime = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
  const entry = {
    size: st.size, mtimeMs: st.mtimeMs, raw, mime,
    etag: `"${raw.length.toString(36)}-${st.mtimeMs.toString(36)}"`,
    br: null, gz: null,
  };
  if (COMPRESSIBLE_EXT.has(path.extname(resolved).toLowerCase()) && raw.length >= 512) {
    // 大文本压缩走异步（diagram.html 接近 1MB，同步压会卡住并发请求）
    const [br, gz] = await Promise.all([
      brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }).catch(() => null),
      gzipCompress(raw, { level: 6 }).catch(() => null),
    ]);
    if (br && br.length < raw.length) entry.br = br;
    if (gz && gz.length < raw.length) entry.gz = gz;
  }
  staticCacheStore(resolved, entry);
  return entry;
}

async function staticEntryFor(resolved) {
  let st;
  try { st = await fsp.stat(resolved); } catch { return null; }
  const hit = staticCache.get(resolved);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    staticCache.delete(resolved); staticCache.set(resolved, hit); // 刷新 LRU 位
    return hit;
  }
  let filling = staticInflight.get(resolved);
  if (!filling) {
    // stat 成功但读取失败（文件被并发删除等）按 404 回落，不让异常冒泡成 500
    filling = staticEntryFill(resolved, st)
      .catch(() => null)
      .finally(() => staticInflight.delete(resolved));
    staticInflight.set(resolved, filling);
  }
  return filling;
}

// 图集文件可能存放在用户选择的本地存放路径（entry.dir），不受 ROOT 限制；
// 调用方需保证路径由受控的 id + 文件名拼接而来。
async function sendFileAbsolute(res, resolved, req) {
  const entry = await staticEntryFor(resolved);
  if (!entry) { res.writeHead(404); res.end('Not Found'); return; }
  // ?v=<rev> 版本戳 URL 内容永不变化（前端变更时换 v 破缓存）→ immutable 长缓存，
  // 重复加载零请求；无 v 的仍走 ETag 304 再验证（index/app.js/style.css 这类）。
  const immutable = /[?&]v=\d/.test(String(req?.url || ''));
  const headers = {
    'Content-Type': entry.mime,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: entry.etag,
  };
  if (!immutable && req?.headers?.['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const pref = encPreference(req);
  const body = (pref === 'br' && entry.br) ? entry.br : (pref === 'gzip' && entry.gz) ? entry.gz : entry.raw;
  if (body !== entry.raw) {
    headers['Content-Encoding'] = pref;
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}

// 大 JSON 读响应（列表/轮询类）：≥1KB 且客户端支持时压缩；附 ETag——轮询未变化时
// 直接 304，fetch 走 HTTP 缓存透明复用（browser 对 304 自动回缓存体），字节不再重传。
// Cache-Control: no-cache 保证永不启发式缓存旧数据（每次都带 If-None-Match 再验证）。
async function sendJsonCached(res, req, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const etag = `"${crypto.createHash('sha1').update(payload).digest('base64url').slice(0, 16)}"`;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ETag: etag, 'Cache-Control': 'no-cache' };
  if (req?.headers?.['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const pref = encPreference(req);
  if (pref && payload.length >= 1024) {
    const buf = Buffer.from(payload, 'utf8');
    const encoded = pref === 'br'
      ? await brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }).catch(() => null)
      : await gzipCompress(buf, { level: 4 }).catch(() => null);
    if (encoded && encoded.length < buf.length) {
      headers['Content-Encoding'] = pref;
      headers.Vary = 'Accept-Encoding';
      headers['Content-Length'] = encoded.length;
      res.writeHead(status, headers);
      res.end(encoded);
      return;
    }
  }
  headers['Content-Length'] = Buffer.byteLength(payload);
  res.writeHead(status, headers);
  res.end(payload);
}

// 附件下载头：中文文件名走 RFC 5987 filename*，filename 兜底 ASCII（老下载器用）
function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function sendFile(res, filePath, req) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(ROOT) + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  return sendFileAbsolute(res, resolved, req);
}

// 图集文件可能存放在用户选择的本地存放路径（entry.dir），不受 ROOT 限制；
// 调用方需保证路径由受控的 id + 文件名拼接而来。
// （实现见上方 sendFileAbsolute：内存缓存 + 压缩 + ETag/immutable）

// Git Bash 的 curl 会把内联中文按 GBK 发送：严格 UTF-8 解码失败时按 GBK 兜底，避免 agent 提交乱码
function decodeBodyText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大（>12MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(decodeBodyText(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname}`;
  const user = authUser(req); // 登录态（agent/cicd 路由鉴权与会话归属过滤用）

  try {
    // ---- 登录 API（唯一不要求登录的 /api/auth/* 组） ----
    if (route === 'POST /api/auth/login' || route === 'POST /api/auth/register') {
      const body = JSON.parse(await readBody(req));
      const outcome = route.startsWith('POST /api/auth/login')
        ? auth.login(body.username, body.password)
        : auth.register(body.username, body.password, body.apiKey);
      if (outcome.status) return sendJson(res, outcome.status, { error: outcome.error });
      return sendJson(res, 200, { user: auth.publicUser(outcome.user) }, { 'Set-Cookie': authCookieHeader(outcome.token) });
    }

    if (route === 'POST /api/auth/logout') {
      if (user) auth.revokeToken(user.token);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': CLEAR_AUTH_COOKIE });
    }

    if (route === 'GET /api/auth/me') {
      if (!user) return sendJson(res, 401, UNAUTHORIZED.body);
      return sendJson(res, 200, { user: { username: user.username, role: user.role, hasApiKey: Boolean(user.hasApiKey) } });
    }

    // 换个人 GLM API Key（账户设置；「留空保持不变」由前端控制，这里只收显式提交）
    if (route === 'PUT /api/auth/apikey') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      const body = JSON.parse(await readBody(req));
      const outcome = auth.updateUserApiKey(user, body.apiKey);
      if (outcome.status) return sendJson(res, outcome.status, { error: outcome.error });
      return sendJson(res, 200, { ok: true, hasApiKey: true });
    }

    // 改密码：核对原密码（「通过上次历史密码修改」），成功吊销其他设备的登录态
    if (route === 'POST /api/auth/password') {
      if (!user) return sendJson(res, 401, UNAUTHORIZED.body);
      const body = JSON.parse(await readBody(req));
      const outcome = auth.changePassword(user, body.oldPassword, body.newPassword, { keepToken: user.token });
      if (outcome.status) return sendJson(res, outcome.status, { error: outcome.error });
      return sendJson(res, 200, { ok: true, revoked: outcome.revoked });
    }

    // ---- Issue API ----
    if (route === 'GET /api/issues') {
      const diagramId = url.searchParams.get('diagram') || undefined;
      return sendJsonCached(res, req, 200, { issues: listIssues({ diagramId }) });
    }

    // 项目级 issue（目前用于「创建新图」：新建图统一走 issue，由流水线执行）。
    // 提交成功即驱动该范围的 Issue 流水线（kickIssueRun：空闲立即跑、忙则接续）。
    if (route === 'POST /api/issues') {
      const body = JSON.parse(await readBody(req));
      const kind = String(body.kind || '') === 'new-feature' ? 'new-feature' : '';
      if (kind !== 'new-feature') {
        return sendJson(res, 400, { error: '项目级 issue 目前仅支持 kind="new-feature"（创建新图）；缺陷类请走 POST /api/diagrams/<id>/issues' });
      }
      const title = String(body.title || '').trim();
      const bodyText = String(body.body || '').trim();
      if (!title || title.length > 200) {
        return sendJson(res, 400, { error: '标题必填且不超过 200 字符' });
      }
      let folder = null;
      if (body.folder != null && String(body.folder).trim() !== '') {
        folder = String(body.folder).trim();
        const store = readStore();
        if (!(store.folders.includes(folder) || store.diagrams.some((d) => d.folder === folder))) {
          return sendJson(res, 404, { error: `目录不存在：${folder}` });
        }
      }
      const now = new Date().toISOString();
      const result = stmt(
        'INSERT INTO issues (diagram_id, node_id, nodes, title, body, status, created_at, updated_at, kind, folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('', null, '[]', title, bodyText.slice(0, 4000), 'open', now, now, 'new-feature', folder);
      const created = stmt('SELECT * FROM issues WHERE id = ?').get(Number(result.lastInsertRowid));
      cicd.kickIssueRun(folder ? folder.split('/')[0] : null); // 提交即执行（Agent 未启用时留在 pendingKick）
      return sendJson(res, 200, { issue: issueToObject(created) });
    }

    const issueCreateMatch = url.pathname.match(/^\/api\/diagrams\/([a-z0-9_-]+)\/issues$/);
    if (issueCreateMatch && req.method === 'POST') {
      const diagramId = issueCreateMatch[1];
      if (!readStore().diagrams.some((d) => d.id === diagramId)) {
        return sendJson(res, 404, { error: '图不存在' });
      }
      const body = JSON.parse(await readBody(req));
      const title = String(body.title || '').trim();
      const bodyText = String(body.body || '').trim();
      const nodes = sanitizeNodes(body.nodes);
      const nodeId = nodes.length ? nodes[0].id : (body.node_id == null ? null : String(body.node_id).trim().slice(0, 100));
      if (!title || title.length > 200) {
        return sendJson(res, 400, { error: '标题必填且不超过 200 字符' });
      }
      const now = new Date().toISOString();
      const result = stmt(
        'INSERT INTO issues (diagram_id, node_id, nodes, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(diagramId, nodeId, JSON.stringify(nodes), title, bodyText.slice(0, 4000), 'open', now, now);
      const created = stmt('SELECT * FROM issues WHERE id = ?').get(Number(result.lastInsertRowid));
      return sendJson(res, 200, { issue: issueToObject(created) });
    }

    const issuePatchMatch = url.pathname.match(/^\/api\/issues\/(\d+)$/);
    if (issuePatchMatch && req.method === 'PATCH') {
      const issueId = Number(issuePatchMatch[1]);
      const body = JSON.parse(await readBody(req));
      const existing = stmt('SELECT * FROM issues WHERE id = ?').get(issueId);
      if (!existing) return sendJson(res, 404, { error: 'issue 不存在' });
      const nextTitle = body.title !== undefined ? String(body.title).trim() : existing.title;
      const nextBody = body.body !== undefined ? String(body.body).trim() : existing.body;
      const nextStatus = body.status !== undefined ? String(body.status) : existing.status;
      const nextNode = body.node_id !== undefined
        ? (body.node_id == null || String(body.node_id).trim() === '' ? null : String(body.node_id).trim().slice(0, 100))
        : existing.node_id;
      let nextNodes = existing.nodes;
      let nextNodeFinal = nextNode;
      if (body.nodes !== undefined) {
        nextNodes = JSON.stringify(sanitizeNodes(body.nodes));
        // 显式提交 nodes 时以它为准（含清空），不再回退旧 node_id
        nextNodeFinal = JSON.parse(nextNodes)[0]?.id ?? null;
      }
      if (!nextTitle || nextTitle.length > 200) {
        return sendJson(res, 400, { error: '标题必填且不超过 200 字符' });
      }
      if (nextStatus !== 'open' && nextStatus !== 'closed') {
        return sendJson(res, 400, { error: 'status 仅支持 open / closed' });
      }
      // 拒绝标记：refused:true = 拒绝（强制关闭，不看 body.status）；显式重开或 refused:false
      // 才清除——只改标题等不动状态时保留标记（refused ⇒ closed）
      let nextRefused = body.refused === true || existing.refused ? 1 : 0;
      if (body.refused === true) {
        nextStatus = 'closed';
      } else if (body.status === 'open' || body.refused === false) {
        nextRefused = 0;
      }
      stmt('UPDATE issues SET title = ?, body = ?, status = ?, node_id = ?, nodes = ?, refused = ?, updated_at = ? WHERE id = ?')
        .run(nextTitle, nextBody.slice(0, 4000), nextStatus, nextNodeFinal, nextNodes, nextRefused,
          new Date().toISOString(), issueId);
      const updated = stmt('SELECT * FROM issues WHERE id = ?').get(issueId);
      return sendJson(res, 200, { issue: issueToObject(updated) });
    }

    if (issuePatchMatch && req.method === 'DELETE') {
      const issueId = Number(issuePatchMatch[1]);
      const result = stmt('DELETE FROM issues WHERE id = ?').run(issueId);
      if (result.changes === 0) return sendJson(res, 404, { error: 'issue 不存在' });
      return sendJson(res, 200, { deleted: issueId });
    }

    // ---- Agent（Claude Code Agent SDK）API ----
    // 整组要求登录（前端专用通道，agent 的 curl 不走这里）；会话数据按归属过滤：
    // 普通用户只见自己的会话，admin 全见（claude.mjs canSeeSession）。
    if (route === 'GET /api/agent/settings') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      return sendJson(res, 200, agent.settingsView());
    }

    if (route === 'PUT /api/agent/settings') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      const body = JSON.parse(await readBody(req));
      if (body.baseUrl !== undefined) {
        const url = String(body.baseUrl).trim();
        if (url && !/^https?:\/\/.+/.test(url)) return sendJson(res, 400, { error: '地址需为 http(s)://host[:port]，或留空走官方 Anthropic' });
      }
      agent.updateSettings(body);
      return sendJson(res, 200, agent.settingsView());
    }

    if (route === 'GET /api/agent/models') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      // 模型列表来自 agent 设置（baseUrl 决定哪些模型真实可用——Z.ai 端点跑 GLM、
      // 官方端点跑 claude-*；列表用户可在 ⚙ 设置里改）
      return sendJson(res, 200, agent.modelsPayload());
    }

    if (route === 'POST /api/agent/session') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      const body = JSON.parse(await readBody(req));
      const folder = body.folder ? String(body.folder) : null;
      const cwd = folderCwdOf(folder);
      // SDK 无常驻进程：预热线无事可做，直接就绪（保留接口兼容前端唤醒虚窗的调用）
      if (body.ensureOnly === true) return sendJson(res, 200, { ensured: true, cwd });
      const record = agent.registerSession({
        cwd,
        title: `Archify 图集 · ${folder ?? '未分类'}`,
        pipeline: false,
        folder,
        owner: user.username,
      });
      return sendJson(res, 200, { sessionId: record.id, cwd });
    }

    // 历史会话列表（独占模式会话栏）：当前归属目录的会话 + 是否在后台执行。
    // serveUp 恒 true（SDK 后端无 serve 概念，保留字段兼容前端空态分支）。
    // 归档会话（7 天不活跃，turns 已压缩存档）也在列——archived 标记，只显示标题、可搜索/导出。
    // 多用户：按登录态过滤（普通用户 = 自己的会话；admin = 全部，条目带 owner 字段）。
    if (route === 'GET /api/agent/sessions') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      const folder = url.searchParams.get('folder') || null;
      const cwd = folderCwdOf(folder);
      // 虚窗开着每 3.5s 轮询一次：ETag 304 让空闲期零字节重传（running 状态一变 ETag 即失效）
      return sendJsonCached(res, req, 200, { serveUp: true, cwd, sessions: agent.listSessions({ cwd, user }) });
    }

    // 批量导出：一组会话（含归档）→ markdown zip 下载。放单会话正则路由之前——
    // /api/agent/sessions/export 会被 session/:id 正则误吞（id="sessions"）。
    // 两种形式：POST {ids}（fetch 预检用）/ GET ?ids=a,b,c（前端 location.href 原生下载——
    // webview 对 blob+<a download> 支持不稳，attachment 响应走浏览器原生下载管线最可靠）。
    if (url.pathname === '/api/agent/sessions/export' && (req.method === 'GET' || req.method === 'POST')) {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      let ids = null;
      if (req.method === 'GET') {
        ids = (url.searchParams.get('ids') || '').split(',').map((x) => x.trim()).filter(Boolean);
      } else {
        const body = JSON.parse(await readBody(req).catch(() => '{}'));
        ids = body?.ids;
      }
      const out = agent.exportSessionsZip(ids, user);
      if (!out || out.status) return sendJson(res, out?.status || 404, { error: out?.error || '没有可导出的会话' });
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(out.filename),
        'Cache-Control': 'no-store',
      });
      res.end(out.body);
      return;
    }

    // 单个会话：GET …/messages 回放历史；GET …/export 导出 markdown；POST …/abort 停止后台执行。
    const agentSessionMatch = url.pathname.match(/^\/api\/agent\/session\/([a-zA-Z0-9_-]+)\/(messages|abort|export)$/);
    if (agentSessionMatch && req.method === 'GET' && agentSessionMatch[2] === 'messages') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      const data = agent.sessionTurns(agentSessionMatch[1], user);
      if (data?.status) return sendJson(res, data.status, { error: data.error });
      if (!data) return sendJson(res, 404, { error: '会话不存在' });
      return sendJson(res, 200, data);
    }
    if (agentSessionMatch && req.method === 'GET' && agentSessionMatch[2] === 'export') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      const out = agent.exportSessionMarkdown(agentSessionMatch[1], user);
      if (!out || out.status) return sendJson(res, out?.status || 404, { error: out?.error || '会话不存在' });
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': contentDisposition(out.filename),
        'Cache-Control': 'no-store',
      });
      res.end(out.body);
      return;
    }
    if (agentSessionMatch && req.method === 'POST' && agentSessionMatch[2] === 'abort') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      const out = agent.abortSession(agentSessionMatch[1], user);
      if (out?.status) return sendJson(res, out.status, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === 'POST /api/agent/message') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      const body = JSON.parse(await readBody(req));
      const sessionId = String(body.sessionId || '');
      const text = String(body.text || '').trim();
      if (!sessionId || !text) return sendJson(res, 400, { error: '缺少 sessionId 或 text' });
      const outcome = agent.sendUserMessage({ sessionId, text, context: String(body.context || ''), user });
      return sendJson(res, outcome.status, outcome.body);
    }

    if (route === 'GET /api/agent/events') {
      // Agent 活动事件流（工具细流 + 会话完成）——claude.mjs 事件总线直推浏览器。
      // 登录用户的流按会话归属过滤（admin 收全部；普通用户只收自己的，见 claude.mjs）。
      if (!user) {
        // SSE 不能回 JSON body 就完事——写头后直接断，EventSource 会走 onerror 重连
        res.writeHead(401, { 'Content-Type': 'text/event-stream' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* close 清理 */ }
      }, 30_000);
      agent.attachEventStream(res, () => clearInterval(ping), user);
      return;
    }

    if (route === 'GET /api/events') {
      // 图集热更新事件流：manifest / 图文件变化 → gallery-update 事件（见 broadcastGalleryUpdate）。
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      galleryEvents.add(res);
      // 心跳注释行：防中间层空闲断连（EventSource 客户端会自动重连兜底）
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 同上，close 清理 */ }
      }, 30_000);
      req.on('close', () => {
        clearInterval(ping);
        galleryEvents.delete(res);
      });
      return;
    }

    // ---- CI/CD（项目级自动化）API ----
    // 要求登录。全局执行看板（运行中/排队/全局并发数）与设置/触发是**管理员专属**
    // （用户要求）：普通用户的 snapshot 剥掉全局执行字段（项目级看板的队列/历史/状态
    // 仍可见）；PUT 设置与手动触发一律 admin-only。
    if (route === 'GET /api/cicd') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      const snap = cicd.snapshot();
      if (user.role !== 'admin') {
        delete snap.runs;
        delete snap.kicked;
        delete snap.maxConcurrentSessions;
        delete snap.activeSessions;
        delete snap.sessionLimit;
      }
      return sendJson(res, 200, snap);
    }

    if (route === 'PUT /api/cicd') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      if (user.role !== 'admin') return sendJson(res, ADMIN_ONLY.status, ADMIN_ONLY.body);
      const blocked = guardGalleryWrite(req);
      if (blocked) return sendJson(res, blocked.status, blocked.body);
      const body = JSON.parse(await readBody(req));
      const result = cicd.saveSettings(body);
      return sendJson(res, result.status, result.body);
    }

    if (route === 'POST /api/cicd/run') {
      if (!user) return sendJson(res, UNAUTHORIZED.status, UNAUTHORIZED.body);
      if (user.role !== 'admin') return sendJson(res, ADMIN_ONLY.status, ADMIN_ONLY.body);
      const blocked = guardGalleryWrite(req);
      if (blocked) return sendJson(res, blocked.status, blocked.body);
      const body = JSON.parse(await readBody(req));
      const project = body.project == null || body.project === '' ? null : String(body.project);
      // issueId 可选：只执行该条 issue（看板待执行队列的「立即执行」）
      const issueId = body.issueId == null ? null : Number(body.issueId);
      const result = cicd.triggerRun(project, Number.isFinite(issueId) ? issueId : null);
      return sendJson(res, result.status, result.body);
    }

    // Static routes
    if (route === 'GET /') return sendFile(res, path.join(PUBLIC, 'index.html'), req);
    if (url.pathname.startsWith('/public/')) return sendFile(res, path.join(ROOT, decodeURIComponent(url.pathname.slice(1))), req);
    if (url.pathname.startsWith('/gallery/')) {
      // /gallery/<id>/<file> — 目录关联了本地存放路径时从那里读取。
      const segments = decodeURIComponent(url.pathname.slice(1)).split('/');
      const id = segments[1];
      const file = segments.slice(2).join('/');
      if (!id || !file || file.includes('..')) {
        res.writeHead(404); res.end('Not Found'); return;
      }
      const entry = readStore().diagrams.find((d) => d.id === id);
      const dir = entry?.dir || path.join(GALLERY, id);
      return sendFileAbsolute(res, path.join(dir, file), req);
    }

    // API routes
    if (route === 'GET /api/diagrams') {
      // 响应体按 manifest 版本缓存（序列化只做一次）+ ETag 304 + 压缩：
      // 前端每次加载/SSE 更新都拉这个接口，未变化时浏览器再验证直接 304 零传输。
      return sendJsonCached(res, req, 200, diagramsPayloadJson());
    }

    if (route === 'GET /api/fs/list') {
      // 服务器端目录浏览：网页里选择「图集服务器」上的项目路径。本地部署时就是本机路径，
      // 远端部署时是远端服务器的本地路径——浏览器本机盘符无关，也不弹任何原生对话框（远端看不见）。
      // 兼容 Windows（盘符/UNC）与 Linux（POSIX 绝对路径）；只列目录不列文件。
      const raw = (url.searchParams.get('path') || '').trim();
      try {
        const listDirs = (dir) => fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.')
            && e.name !== '$RECYCLE.BIN' && e.name !== 'System Volume Information')
          .map((e) => ({ name: e.name, full: path.join(dir, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        if (!raw) {
          if (path.sep === '\\') {
            const drives = [];
            for (let code = 65; code <= 90; code += 1) {
              const letter = String.fromCharCode(code);
              const drive = `${letter}:\\`;
              try {
                if (fs.statSync(drive).isDirectory()) drives.push({ name: `${letter}:`, full: drive });
              } catch { /* 无此盘符 */ }
            }
            return sendJson(res, 200, { os: process.platform, path: '', parent: null, label: '服务器的磁盘', entries: drives });
          }
          return sendJson(res, 200, { os: process.platform, path: '/', parent: null, label: '服务器根目录', entries: listDirs('/') });
        }
        const abs = path.resolve(raw);
        if (!fs.statSync(abs).isDirectory()) return sendJson(res, 400, { error: `不是目录：${abs}` });
        const parentDir = path.dirname(abs);
        let entries = [];
        let readable = true;
        try { entries = listDirs(abs); } catch { readable = false; }
        return sendJson(res, 200, {
          os: process.platform,
          path: abs,
          parent: parentDir === abs ? null : parentDir,
          entries,
          ...(readable ? {} : { readable }),
        });
      } catch (error) {
        return sendJson(res, 400, { error: `无法读取路径（按服务器文件系统理解）：${error.message}` });
      }
    }

    if (route === 'POST /api/folders') {
      const body = JSON.parse(await readBody(req));
      const parent = body.parent ? String(body.parent) : '';
      const name = String(body.name || '').trim();
      const localPath = typeof body.localPath === 'string' ? body.localPath.trim().replace(/[\\/]+$/, '') : '';
      if (!name || name.includes('/') || name.length > FOLDER_NAME_MAX || name === '未分类') {
        return sendJson(res, 400, { error: `目录名需为 1-${FOLDER_NAME_MAX} 个字符，且不含“/”，不能用保留名“未分类”` });
      }
      if (parent && !validFolderPath(parent)) {
        return sendJson(res, 400, { error: `非法父目录：${parent}` });
      }
      if (localPath) {
        if (localPath.length > 400 || !/^[a-zA-Z]:[\\/]|^\\\\|^\//.test(localPath)) {
          return sendJson(res, 400, { error: '存放路径需为绝对路径，例如 D:\\code\\my-project' });
        }
        // 存放路径必须指向服务器上实际存在的文件夹——服务端不 mkdir、不发明位置。
        // 路径按「图集服务器」的文件系统理解（本地部署=本机；远端部署=远端服务器），
        // Windows（盘符/UNC）与 Linux（POSIX 绝对路径）均可。
        try {
          const st = fs.statSync(localPath);
          if (!st.isDirectory()) throw new Error('not a directory');
        } catch {
          return sendJson(res, 400, { error: `存放路径在服务器上不存在或不是文件夹：${localPath}——请在「选择路径…」浏览器里选取，或输入服务器侧的完整绝对路径（服务端不会自动创建）` });
        }
      }
      const target = parent ? `${parent}/${name}` : name;
      const store = readStore();
      if (folderAndDescendants(store.folders, target).includes(target)) {
        return sendJson(res, 409, { error: `目录已存在：${target}` });
      }
      // mkdir -p 语义：自动补齐缺失的中间层级。
      const parts = target.split('/');
      for (let i = 1; i <= parts.length; i += 1) {
        const prefix = parts.slice(0, i).join('/');
        if (!store.folders.includes(prefix)) store.folders.push(prefix);
      }
      if (localPath) {
        store.folderMeta[target] = { ...(store.folderMeta[target] || {}), localPath };
      }
      writeStore(store);
      return sendJson(res, 200, { created: target, folders: store.folders, localPath: localPath || undefined });
    }

    if (route === 'DELETE /api/folders') {
      const target = url.searchParams.get('path') || '';
      if (!validFolderPath(target)) return sendJson(res, 400, { error: `非法目录路径：${target}` });
      const store = readStore();
      if (!store.folders.includes(target)) return sendJson(res, 404, { error: `目录不存在：${target}` });
      const subtree = folderAndDescendants(store.folders, target);
      const inside = (d) => d.folder && subtree.some((f) => d.folder === f || d.folder.startsWith(`${f}/`));
      const holding = store.diagrams.filter(inside);
      if (holding.length) {
        return sendJson(res, 409, { error: `目录“${target}”及其子目录中还有 ${holding.length} 张图，先移出或删除它们` });
      }
      store.folders = store.folders.filter((f) => !subtree.includes(f));
      for (const f of subtree) delete store.folderMeta[f];
      writeStore(store);
      return sendJson(res, 200, { deleted: target });
    }

    if (route === 'POST /api/import' && req.method === 'POST') {
      const blocked = guardGalleryWrite(req);
      if (blocked) return sendJson(res, blocked.status, blocked.body);
      const body = JSON.parse(await readBody(req));
      const folder = body.folder ? String(body.folder) : null;
      // replace：更新已有图（旧图删除、issue 迁移到新图），见 importArchifySpec
      const replace = typeof body.replace === 'string' ? body.replace.replace(/[^a-z0-9_-]/g, '') : null;
      if (body.kind === 'archify') {
        let spec = body.spec;
        if (typeof spec === 'string') {
          try { spec = JSON.parse(spec); } catch (error) {
            return sendJson(res, 400, { error: `JSON 解析失败：${error.message}` });
          }
        }
        const result = await importArchifySpec(spec, { source: 'import', name: body.name, folder, replace });
        return sendJson(res, result.status, result.body);
      }
      if (body.kind === 'mermaid') {
        const converted = mermaidToWorkflow(body.code || '', { title: body.name });
        if (!converted.ok) return sendJson(res, 422, { error: converted.error });
        const result = await importArchifySpec(converted.spec, { source: 'mermaid', name: body.name, warnings: converted.warnings, folder, replace });
        return sendJson(res, result.status, result.body);
      }
      if (body.kind === 'html') {
        const result = await importRenderedHtml(body.html || '', { name: body.name, folder });
        return sendJson(res, result.status, result.body);
      }
      return sendJson(res, 400, { error: `未知的导入类型：${body.kind}` });
    }

    if (route === 'POST /api/import-examples') {
      const blocked = guardGalleryWrite(req);
      if (blocked) return sendJson(res, blocked.status, blocked.body);
      const result = await importExamples();
      return sendJson(res, result.status, result.body);
    }

    const deleteMatch = url.pathname.match(/^\/api\/diagrams\/([a-z0-9_-]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      const blocked = guardGalleryWrite(req);
      if (blocked) return sendJson(res, blocked.status, blocked.body);
      const id = deleteMatch[1];
      const store = readStore();
      const entry = store.diagrams.find((item) => item.id === id);
      if (!entry) return sendJson(res, 404, { error: '图不存在' });
      await fsp.rm(entry.dir || path.join(GALLERY, id), { recursive: true, force: true });
      store.diagrams = store.diagrams.filter((item) => item.id !== id);
      writeStore(store);
      stmt('DELETE FROM issues WHERE diagram_id = ?').run(id);
      return sendJson(res, 200, { deleted: id });
    }

    res.writeHead(404); res.end('Not Found');
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

// ---- SIGTERM 防护 ----------------------------------------------------------------
// 实测（2026-09-26 排查）：SDK 的 CLI 子进程异常退出（如 root 拒跑/坏 Key/网关 4xx）时，
// 其清理链会向进程组连发 SIGTERM——本服务与 CLI 同组，无 handler 就静默死亡 → docker
// 重启（表现为发一条消息服务就断）。有 SDK 运行在飞时忽略该信号；平时保留正常退出
// 语义（docker stop 仍可优雅停止；停机恰逢在飞则等 docker 的 SIGKILL 兜底）。
process.on('SIGTERM', () => {
  if (agent.anyBusy()) {
    console.log('忽略 SIGTERM（检测到 agent 运行在飞——疑似 CLI 清理误伤进程组）');
    return;
  }
  console.log('收到 SIGTERM，退出');
  process.exit(0);
});

// ---- 首次启动示例图播种 ------------------------------------------------------------
// 全新部署（gallery/manifest.json 尚不存在）时自动把 archify/examples/ 批量校验+渲染
// 入集，开箱即有示例图可看；用户后来清空图集不会重新播种（manifest 存在 = 已初始化）。
// 必须放在存量迁移与热更新基线快照之前：播种产生的文件不触发 SSE 误报。
if (!fs.existsSync(MANIFEST_PATH)) {
  try {
    const seeded = await importExamples();
    console.log(`首次启动：导入示例图 ${seeded.body.imported} 张` +
      (seeded.body.failed.length ? `，失败 ${seeded.body.failed.length} 张` : ''));
  } catch (error) {
    console.log(`示例图播种失败（不影响服务启动）：${error.message}`);
  }
}

// 存量数据迁移：为已有缩略图补生成自包含 thumb.svg（前端 <img> 用，替代 iframe）
for (const entry of readStore().diagrams) {
  if (entry.thumbFile) ensureThumbSvgFile(entry);
}

// 热更新基线快照（迁移写文件之后建立，避免把补生成的 thumb.svg 误判为变化）。
// 检测双通道：fs.watch 快路径（gallery/ + 各项目 graph/，能监听的目录毫秒级感知）
// + 2.5s 轮询兜底——项目路径可能挂在 drvfs/网络盘上（watcher 挂着但不报事件），
// 轮询间隔维持与旧版相同的 2.5s，stat 已全异步不再阻塞事件循环。
await scanGalleryChanges({ silent: true });
refreshGalleryWatchers();
function scheduleGalleryPoll() {
  const timer = setTimeout(() => {
    // 轮询链上任何意外异常都不能断链（unhandled rejection 在 Node ≥15 是致命错误）
    broadcastGalleryUpdate().catch(() => {}).finally(scheduleGalleryPoll);
  }, 2500);
  timer.unref();
}
scheduleGalleryPoll();

// ---- CI/CD 调度器（项目级 issue 自动解决 + 全图自动检视） ----
const cicd = createCicd({
  galleryDir: GALLERY,
  rootDir: ROOT,
  archifyDir: ARCHIFY,
  port: PORT,
  readStore,
  listIssues: () => listIssues(),
  // 流水线自动关闭创建类 issue（出图成功证据确认后；agent 忘关时的双保险）
  closeIssue: (id) => stmt('UPDATE issues SET status = \'closed\', updated_at = ? WHERE id = ? AND status = \'open\'')
    .run(new Date().toISOString(), id),
  // Agent 后端（claude.mjs）：流水线会话与用户会话进同一注册表（pipeline:true，
  // 前端只读回放）；消息由 SDK 运行器同步执行完返回（凭证/并发由 cicd 管）
  createAgentSession: agent.createPipelineSession,
  sendAgentMessage: agent.sendPipelineMessage,
  agentSettings: () => agent.settingsView(),
  userBusy: agent.userBusy,
  ciGuard: { headerName: CI_KEY_HEADER, begin: beginCiRun, end: endCiRun },
});
cicd.start();

// HTTP keep-alive 调优：默认 5s 空闲即断连，前端 3s/3.5s 的看板与会话轮询每拍都在
// 重开 TCP；拉长到 65s（浏览器默认也持久）后连接稳定复用，每次轮询省一次握手往返。
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

server.listen(PORT, HOST, () => {
  console.log(`Archify 图集已启动：http://${HOST}:${PORT}`);
  console.log(`archify 渲染器：${ARCHIFY}`);
});
