// Archify 图集前端逻辑（零依赖 vanilla JS）。
// 左侧项目目录树（可多层，每行右侧导入按钮）+ 搜索。
const $ = (sel) => document.querySelector(sel);
const state = {
  diagrams: [],
  folders: [],
  folderMeta: {},
  issues: [],
  selection: { scope: 'all', path: null, id: null }, // all | folder(path|null=未分类) | id
  search: '',
  expanded: new Set(),
  importTarget: null, // 打开导入弹窗时锁定的目标目录（null=未分类）
  cicd: { agentEnabled: false, projects: {}, state: {}, history: [], generate: { running: null, queued: [] } }, // CI/CD + AI 生成图任务（/api/cicd）
};

// ---- 多用户登录（/api/auth/*）：登录门 → enterApp ----
// 普通用户只见自己的 Agent 会话（服务端按 owner 过滤）；admin 见全部 + 全局执行看板。
const auth = { user: null };
const isAdmin = () => auth.user?.role === 'admin';

// 登录态失效兜底：会话/看板 API 返回 401（改密码吊销了本设备、令牌过期等）→ 回登录页。
// 登录门自身未登录时的 401（密码错）不算——auth.user 为 null 时跳过。
const rawFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await rawFetch(input, init);
  if (res.status === 401 && auth.user) location.reload();
  return res;
};

// 登录/注册表单（同一张卡切换模式；首次使用可直接创建账户——注册必填个人 GLM API Key）
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  const register = mode === 'register';
  $('#auth-pass2-row').classList.toggle('hidden', !register);
  $('#auth-key-row').classList.toggle('hidden', !register);
  $('#auth-submit').textContent = register ? '创建账户' : '登 录';
  $('#auth-switch').textContent = register ? '← 返回登录' : '首次使用？创建新账户 →';
  $('#auth-sub').textContent = register
    ? '创建账户需填你自己的 GLM API Key（Agent 会话用它计费）'
    : '登录后进入图集 · 多用户各见各的 Agent 会话';
  $('#auth-error').textContent = '';
  $('#auth-pass').autocomplete = register ? 'new-password' : 'current-password';
}
$('#auth-switch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errEl = $('#auth-error');
  errEl.textContent = '';
  const username = $('#auth-user').value.trim();
  const password = $('#auth-pass').value;
  if (!username || !password) {
    errEl.textContent = '请输入用户名和密码';
    return;
  }
  const apiKey = $('#auth-key').value.trim();
  if (authMode === 'register') {
    if (password !== $('#auth-pass2').value) {
      errEl.textContent = '两次输入的密码不一致';
      return;
    }
    if (!apiKey) {
      errEl.textContent = '请填写 GLM API Key（你的 Agent 会话用它计费，open.bigmodel.cn 获取）';
      return;
    }
  }
  const btn = $('#auth-submit');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/auth/${authMode === 'register' ? 'register' : 'login'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authMode === 'register'
        ? { username, password, apiKey }
        : { username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errEl.textContent = data.error || data.message || `请求失败（HTTP ${res.status}）`;
      return;
    }
    enterApp(data.user);
  } catch {
    errEl.textContent = '服务不可达——请确认图集服务已启动';
  } finally {
    btn.disabled = false;
  }
});

function showAuthGate() {
  $('#auth-gate').classList.remove('hidden');
  $('#auth-user').focus();
}

// 登录通过（或刷新时登录态仍有效）：填用户栏、按角色显隐入口，再拉图集数据
function enterApp(user) {
  auth.user = user;
  $('#auth-gate').classList.add('hidden');
  $('#user-bar').classList.remove('hidden');
  const nameEl = $('#user-name');
  nameEl.textContent = user.username;
  nameEl.title = user.username;
  const roleEl = $('#user-role');
  roleEl.textContent = user.role === 'admin' ? '管理员' : '成员';
  roleEl.classList.toggle('admin', user.role === 'admin');
  // 全局执行看板（⏳）仅管理员可见/可开（openGlobalBoard 里再兜底拦一次）
  $('#btn-board-global').style.display = user.role === 'admin' ? '' : 'none';
  $('#board-view').classList.toggle('not-admin', user.role !== 'admin');
  startAppData();
}

// 原页面启动流程（登录通过后才拉数据/开 SSE）
function startAppData() {
  loadDiagrams();
  loadIssues();
  connectGalleryEvents(); // 图集热更新：外部/API 变更 → SSE 推送 → 自动刷新
  loadAgentSettings();
  loadCicd().then(() => renderTree()); // 拿到触发设置后树上才有 ⚡ 常显徽标
}

// 退出登录：吊销令牌 + 清 Cookie，整页回到登录门
$('#btn-logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

// —— 账户设置：修改密码（核对原密码）+ 个人 GLM API Key ——
function passStatus(kind, text) {
  const box = $('#pass-status');
  box.className = `status ${kind}`;
  box.textContent = text;
}
function refreshAcctKeyState() {
  const state = $('#acct-key-state');
  state.textContent = auth.user?.hasApiKey
    ? '已设置 ✓——你的 Agent 会话用这个 Key 计费（输入新 Key 覆盖保存）'
    : '未设置——你的 Agent 会话将使用全局 Key（可在此填入自己的 GLM Key 隔离计费）';
}
$('#btn-pass').addEventListener('click', () => {
  ['#pass-old', '#pass-new', '#pass-new2', '#acct-key'].forEach((sel) => { $(sel).value = ''; });
  passStatus('ok', '');
  $('#pass-status').classList.add('hidden');
  refreshAcctKeyState();
  $('#pass-modal').classList.remove('hidden');
  setTimeout(() => $('#pass-old').focus(), 60);
});
$('#pass-modal').addEventListener('click', (event) => {
  if (event.target === $('#pass-modal')) $('#pass-modal').classList.add('hidden');
});
$('#pass-modal').querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => $('#pass-modal').classList.add('hidden'));
});
$('#btn-pass-save').addEventListener('click', async () => {
  const oldPassword = $('#pass-old').value;
  const newPassword = $('#pass-new').value;
  if (!oldPassword || !newPassword) {
    passStatus('err', '请填写原密码与新密码');
    $('#pass-status').classList.remove('hidden');
    return;
  }
  if (newPassword !== $('#pass-new2').value) {
    passStatus('err', '两次输入的新密码不一致');
    $('#pass-status').classList.remove('hidden');
    return;
  }
  const res = await fetch('/api/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword, newPassword }),
  });
  if (res.ok) {
    $('#pass-modal').classList.add('hidden');
    alert('密码已修改（其他已登录设备已强制下线）');
  } else {
    const data = await res.json().catch(() => ({}));
    passStatus('err', data.error || '修改失败');
    $('#pass-status').classList.remove('hidden');
  }
});
// 个人 GLM API Key：显式输入才提交（留空不动已存的 Key）
$('#btn-key-save').addEventListener('click', async () => {
  const apiKey = $('#acct-key').value.trim();
  if (!apiKey) {
    passStatus('err', '请输入要保存的新 API Key（留空 = 保持现状）');
    $('#pass-status').classList.remove('hidden');
    return;
  }
  const res = await fetch('/api/auth/apikey', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  if (res.ok) {
    auth.user = { ...auth.user, hasApiKey: true };
    $('#acct-key').value = '';
    refreshAcctKeyState();
    passStatus('ok', 'GLM API Key 已保存——下一条 Agent 消息起生效');
    $('#pass-status').classList.remove('hidden');
  } else {
    const data = await res.json().catch(() => ({}));
    passStatus('err', data.error || '保存失败');
    $('#pass-status').classList.remove('hidden');
  }
});

async function loadIssues() {
  try {
    const res = await fetch('/api/issues');
    const data = await res.json();
    state.issues = data.issues || [];
  } catch {
    state.issues = [];
  }
  renderGrid();
  renderIssuePanel();
  if (issueMode.listMode) renderIssueFullList();
}

const TYPE_LABEL = {
  architecture: '架构图', workflow: '工作流', sequence: '时序图',
  dataflow: '数据流', lifecycle: '生命周期', html: 'HTML 图',
};
const SOURCE_LABEL = { example: '示例', import: '导入', mermaid: 'Mermaid', html: 'HTML' };
const TYPE_ICON = {
  architecture: '🏛️', workflow: '🔀', sequence: '💬',
  dataflow: '🌊', lifecycle: '♻️', html: '📄',
};

// 「Issue 自动解决已开启」徽标：两眼放红光的机器人（红眼脉冲 + 轮廓泛红光见 style.css 的 rb-*-glow）。
// 悬在文件夹图标左侧的空隙里（.ci-badge 绝对定位 right:100%，不占布局空间）——开启/关闭切换其他图标零位移。
const CICD_ROBOT_BADGE = `
  <span class="ci-badge" title="Issue 自动解决已开启">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="2.2" r="1" fill="currentColor"/>
      <line x1="8" y1="3.2" x2="8" y2="4.9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
      <rect x="0.6" y="7.6" width="1.6" height="3.4" rx="0.8" fill="currentColor" opacity=".75"/>
      <rect x="13.8" y="7.6" width="1.6" height="3.4" rx="0.8" fill="currentColor" opacity=".75"/>
      <rect x="2.1" y="4.9" width="11.8" height="9.7" rx="2.8" fill="none" stroke="currentColor" stroke-width="1.1"/>
      <circle class="rb-eye" cx="5.6" cy="9.6" r="1.55"/>
      <circle class="rb-eye" cx="10.4" cy="9.6" r="1.55"/>
      <line x1="6.3" y1="12.6" x2="9.7" y2="12.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity=".7"/>
    </svg>
  </span>`;

// ---- 数据加载 ----
async function loadDiagrams() {
  try {
    const res = await fetch('/api/diagrams');
    const data = await res.json();
    state.diagrams = data.diagrams || [];
    state.folders = data.folders || [];
    state.folderMeta = data.folderMeta || {};
  } catch {
    // 静默失败：列表为空即表现为空图集，刷新按钮可重试。
  }
  render();
}

// ---- 图集热更新（SSE：服务器检测到图集/图文件变化 → 自动刷新，无需手动 F5） ----
// mediaRev：图 id → 版本戳。文件被外部更新（agent / CI / 直接替换）后，服务器推送
// gallery-update，此处给该图的 /gallery/ URL 加 ?v= 破缓存——img 会重新协商（ETag
// 已变），iframe 同 src 赋值不触发导航则必须换 URL 才会重载。
const mediaRev = new Map();
function mediaUrl(id, file) {
  const rev = mediaRev.get(id);
  return `/gallery/${id}/${file}${rev ? `?v=${rev}` : ''}`;
}

let galleryEs = null;

function connectGalleryEvents() {
  if (galleryEs) return;
  const es = new EventSource('/api/events');
  galleryEs = es;
  es.onmessage = (event) => {
    let ev;
    try { ev = JSON.parse(event.data); } catch { return; }
    if (ev?.type === 'gallery-update') queueGalleryUpdate(ev);
  };
  es.onerror = () => {
    es.close();
    galleryEs = null;
    setTimeout(connectGalleryEvents, 3000);
  };
}

// 批量导入/CI 一轮会连发多个事件：200ms 合并窗口内只刷一次。
let galleryUpdateTimer = null;
let pendingGalleryEvents = [];

function queueGalleryUpdate(ev) {
  pendingGalleryEvents.push(ev);
  if (galleryUpdateTimer) return;
  galleryUpdateTimer = setTimeout(() => {
    galleryUpdateTimer = null;
    const merged = pendingGalleryEvents;
    pendingGalleryEvents = [];
    applyGalleryUpdate(merged);
  }, 200);
}

async function applyGalleryUpdate(events) {
  const added = new Set();
  const removed = new Set();
  const changed = new Set();
  let rev = 0;
  for (const ev of events) {
    (ev.added || []).forEach((id) => added.add(id));
    (ev.removed || []).forEach((id) => removed.add(id));
    (ev.changed || []).forEach((id) => changed.add(id));
    rev = Math.max(rev, ev.rev || 0);
  }
  for (const id of [...added, ...changed]) mediaRev.set(id, rev);
  // 打开的详情被删除/替换掉 → 关闭（replace 时旧 id 在 removed 里，新卡片已出现在网格）
  if (detailLoadedId != null && removed.has(detailLoadedId)) {
    closeDetail();
  }
  await loadDiagrams();
  if (added.size || removed.size) loadIssues(); // 删除/替换会级联动 issue
  // 打开的详情内容变了（外部替换文件 / API 原地刷新）→ 重载 iframe 并同步标题
  if (detailLoadedId != null && changed.has(detailLoadedId)) {
    const d = state.diagrams.find((item) => item.id === detailLoadedId);
    if (d) {
      $('#detail-title').textContent = d.title;
      $('#detail-open').href = mediaUrl(d.id, d.htmlFile);
      detailFrame.src = mediaUrl(d.id, d.htmlFile);
      renderIssuePanel();
    }
  }
}

// ---- 目录树构建 ----
const UNCATEGORIZED = null; // “未分类”伪目录

function folderOf(diagram) {
  return diagram.folder ?? null;
}

// 显式目录 ∪ 图所在路径隐含的目录，统一成 path 树。
function buildFolderTree() {
  const nodes = new Map(); // path -> { path, children: Set<path>, diagrams: [] }
  const ensure = (path) => {
    if (!nodes.has(path)) nodes.set(path, { path, children: new Set(), diagrams: [] });
    return nodes.get(path);
  };
  for (const folder of state.folders) {
    const parts = folder.split('/');
    ensure(folder);
    for (let i = 1; i < parts.length; i += 1) {
      ensure(parts.slice(0, i).join('/')).children.add(parts.slice(0, i + 1).join('/'));
    }
    if (parts.length > 1) ensure(parts.slice(0, -1).join('/')).children.add(folder);
  }
  for (const d of state.diagrams) {
    const folder = folderOf(d);
    if (!folder) continue;
    const parts = folder.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      ensure(parts.slice(0, i).join('/')).children.add(parts.slice(0, i + 1).join('/'));
    }
    ensure(folder).diagrams.push(d);
  }
  return nodes;
}

function subtreeCount(nodes, folderPath) {
  const node = nodes.get(folderPath);
  if (!node) return 0;
  let count = node.diagrams.length;
  for (const child of node.children) count += subtreeCount(nodes, child);
  return count;
}

function subtreeEmpty(nodes, folderPath) {
  const node = nodes.get(folderPath);
  if (!node) return true;
  if (node.diagrams.length) return false;
  for (const child of node.children) {
    if (!subtreeEmpty(nodes, child)) return false;
  }
  return true;
}

// ---- 过滤 ----
function matchesSearch(d) {
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return d.title.toLowerCase().includes(q)
    || (TYPE_LABEL[d.type] || d.type).toLowerCase().includes(q)
    || (SOURCE_LABEL[d.source] || d.source).toLowerCase().includes(q);
}

function inFolderScope(d, folderPath) {
  if (folderPath === UNCATEGORIZED) return folderOf(d) === null;
  const folder = folderOf(d);
  return folder != null && (folder === folderPath || folder.startsWith(`${folderPath}/`));
}

function visibleDiagrams() {
  const q = state.search.trim();
  if (q && state.selection.scope !== 'id') {
    return state.diagrams.filter(matchesSearch);
  }
  if (state.selection.scope === 'id') {
    const d = state.diagrams.find((item) => item.id === state.selection.id);
    return d && matchesSearch(d) ? [d] : [];
  }
  if (state.selection.scope === 'folder') {
    return state.diagrams.filter((d) => inFolderScope(d, state.selection.path) && matchesSearch(d));
  }
  return state.diagrams.filter(matchesSearch);
}

// ---- 渲染 ----
function render() {
  renderTree();
  renderGrid();
  if (veilOpen()) renderAgentContext();
}

function folderRowHtml({ path, label, nodes, depth, isUncategorized = false }) {
  const count = isUncategorized
    ? state.diagrams.filter((d) => folderOf(d) === null).length
    : subtreeCount(nodes, path);
  const active = state.selection.scope === 'folder' && state.selection.path === (isUncategorized ? null : path);
  const open = state.expanded.has(isUncategorized ? '' : path);
  const key = isUncategorized ? '' : path;
  const canDelete = !isUncategorized && subtreeEmpty(nodes, path);
  const storage = isUncategorized ? null : state.folderMeta[path]?.localPath || null;
  // 关闭时按目录类型区分（📁/🗂️/📦），展开时统一换成打开的文件夹 📂（用户要求区分开/关图标）
  const baseIcon = isUncategorized ? '📦' : (storage ? '🗂️' : '📁');
  const icon = open ? '📂' : baseIcon;
  const tooltip = storage ? `${label}（存放于 ${storage}）` : label;
  // 触发设置只在顶层项目目录配置（子目录随项目走）；未分类也有看板（手动执行）
  const isRoot = !isUncategorized && !path.includes('/');
  const cicdCfg = isRoot ? state.cicd.projects?.[path] : null;
  const cicdOn = Boolean(cicdCfg?.issueAuto?.enabled);
  const actions = `
    <span class="row-actions">
      <button class="icon-btn" title="导入到此目录" data-fact="import" data-path="${isUncategorized ? '' : escapeHtml(path)}">⇪</button>
      ${isUncategorized ? '' : `<button class="icon-btn" title="新建子目录" data-fact="sub" data-path="${escapeHtml(path)}">⋯</button>`}
      ${(isRoot || isUncategorized) ? `<button class="icon-btn" title="Issue 执行看板：待执行队列 + 运行记录 + 触发设置" data-fact="cicd" data-path="${isUncategorized ? '' : escapeHtml(path)}">⚡</button>` : ''}
      ${canDelete ? `<button class="icon-btn danger" title="删除空目录" data-fact="del" data-path="${escapeHtml(path)}">✕</button>` : ''}
    </span>`;
  return `
    <div class="tree-section ${open ? 'open' : ''}">
      <div class="tree-row folder-row ${active ? 'active' : ''}" style="padding-left:${30 + depth * 18}px"
           data-select="folder" data-path="${isUncategorized ? '' : escapeHtml(path)}">
        <span class="folder-icon">${icon}${cicdOn ? CICD_ROBOT_BADGE : ''}</span>
        <span class="folder-name" title="${escapeHtml(tooltip)}">${escapeHtml(label)}</span>
        ${actions}
        <span class="count">${count}</span>
        <button class="icon-btn gen-add" title="提创建 issue（AI 创建图 · new feature）：填写需求，流水线读项目代码生成图到本目录" data-fact="gen" data-path="${isUncategorized ? '' : escapeHtml(path)}">＋</button>
      </div>
      <div class="tree-children">
        ${isUncategorized ? '' : [...nodes.get(path).children]
          .map((child) => folderRowHtml({ path: child, label: child.split('/').at(-1), nodes, depth: depth + 1 }))
          .join('')}
        ${state.diagrams
          .filter((d) => (isUncategorized ? folderOf(d) === null : folderOf(d) === path) && matchesSearch(d))
          .map((d) => `
            <div class="tree-row ${state.selection.scope === 'id' && state.selection.id === d.id ? 'active' : ''}"
                 style="padding-left:${28 + depth * 18}px" data-select="id" data-id="${d.id}">
              <span class="leaf-icon">${TYPE_ICON[d.type] || '📊'}</span>
              <span class="leaf-name" title="${escapeHtml(`${TYPE_LABEL[d.type] || d.type} · ${d.title}`)}">${escapeHtml(d.title)}</span>
            </div>`).join('')}
      </div>
    </div>`;
}

function renderTree() {
  const tree = $('#tree');
  tree.innerHTML = '';
  const nodes = buildFolderTree();
  const q = state.search.trim();

  tree.insertAdjacentHTML('beforeend', `
    <div class="tree-section">
      <div class="tree-row ${state.selection.scope === 'all' ? 'active' : ''}" style="padding-left:32px" data-select="all">
        <span class="folder-icon">🗄️</span>
        <span class="folder-name">全部图</span>
        <span class="count">${state.diagrams.length}</span>
      </div>
    </div>`);

  const roots = [...nodes.keys()].filter((p) => !p.includes('/')).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  for (const root of roots) {
    if (q && subtreeCount(nodes, root) === 0) continue;
    tree.insertAdjacentHTML('beforeend', folderRowHtml({ path: root, label: root, nodes, depth: 0 }));
  }
  const uncategorized = state.diagrams.filter((d) => folderOf(d) === null);
  if (uncategorized.length || !q || q) {
    if (!q || uncategorized.some(matchesSearch)) {
      tree.insertAdjacentHTML('beforeend', folderRowHtml({ path: '', label: '未分类', nodes, depth: 0, isUncategorized: true }));
    }
  }
}

// —— 目录树事件委托（一次性绑定）——
// 原实现每次 renderTree 后给每行重新挂 click / mouseenter / mouseleave（树整树
// innerHTML 重建一轮就重绑一轮监听）；委托到 #tree 容器后，重建 DOM 零重绑。
function setupTreeEvents() {
  const tree = $('#tree');
  tree.addEventListener('click', (event) => {
    const factBtn = event.target.closest('[data-fact]');
    if (factBtn) {
      event.stopPropagation();
      const path = factBtn.dataset.path || null;
      if (factBtn.dataset.fact === 'import') openImport(path);
      if (factBtn.dataset.fact === 'sub') openFolderModal(path);
      if (factBtn.dataset.fact === 'del') deleteFolder(path);
      // ⚡ → Issue 执行看板；＋ → 提创建 issue（新建图统一走 issue，无弹窗）
      if (factBtn.dataset.fact === 'cicd') openBoard(path);
      if (factBtn.dataset.fact === 'gen') openIssueCenter(path);
      return;
    }
    const row = event.target.closest('[data-select]');
    if (!row) return;
    const kind = row.dataset.select;
    // 点「全部图」/目录 = 回到缩略图列表；详情/看板/issue 中心还开着就一并关掉
    if (kind !== 'id') {
      if (detailLoadedId != null) closeDetail();
      if (board.open) closeBoard();
      if (issueCenter.active) closeIssueCenter();
    } else {
      if (board.open) closeBoard(); // 看板占据图表区，打开图详情前先回到网格
      if (issueCenter.active) closeIssueCenter(); // issue 中心占详情位，先让位
    }
    if (kind === 'all') {
      state.selection = { scope: 'all', path: null, id: null };
      hideFlyout();
    } else if (kind === 'folder') {
      const key = row.dataset.path || null;
      state.selection = { scope: 'folder', path: key, id: null };
      if (state.expanded.has(key ?? '')) state.expanded.delete(key ?? '');
      else state.expanded.add(key ?? '');
      hideFlyout();
    } else {
      // 点图 = 右侧详情切换；列表上下文保持不变。
      showDetail(row.dataset.id);
    }
    render();
  });
  // 悬停目录行 → 目录栏右侧半透明快速预览（350ms 延迟显示 / 250ms 延迟隐藏，
  // 与原每行 mouseenter/mouseleave 相同时序；mouseover 在行内子元素间移动被去重）。
  let hoverRow = null;
  tree.addEventListener('mouseover', (event) => {
    const row = event.target.closest ? event.target.closest('[data-select="folder"]') : null;
    if (row === hoverRow) return;
    if (hoverRow) {
      clearTimeout(flyoutTimer);
      flyoutHideTimer = setTimeout(hideFlyout, 250);
    }
    hoverRow = row;
    if (row) {
      clearTimeout(flyoutHideTimer);
      clearTimeout(flyoutTimer);
      const folderPath = row.dataset.path || null;
      flyoutTimer = setTimeout(() => showFlyout(folderPath, row), 350);
    }
  });
  tree.addEventListener('mouseleave', () => {
    if (!hoverRow) return;
    hoverRow = null;
    clearTimeout(flyoutTimer);
    flyoutHideTimer = setTimeout(hideFlyout, 250);
  });
}
setupTreeEvents();

// ---- 目录悬停快速预览浮层 ----
const flyoutEl = $('#folder-flyout');
let flyoutTimer = null;
let flyoutHideTimer = null;

function hideFlyout() {
  clearTimeout(flyoutTimer);
  clearTimeout(flyoutHideTimer);
  flyoutEl.classList.add('hidden');
}

function showFlyout(folderPath, row) {
  const items = state.diagrams.filter((d) => inFolderScope(d, folderPath));
  $('#flyout-title').textContent = `${folderPath ?? '未分类'} · 共 ${items.length} 张`;
  // 服务器存放路径：目录自身或最近带 localPath 的祖先（本地/远端部署显示的都是图集服务器侧路径）
  let serverPath = null;
  if (folderPath) {
    const parts = folderPath.split('/');
    for (let i = parts.length; i >= 1 && !serverPath; i -= 1) {
      serverPath = state.folderMeta[parts.slice(0, i).join('/')]?.localPath || null;
    }
  }
  $('#flyout-path').textContent = serverPath ? `服务器路径：${serverPath}` : '';
  const shown = items.slice(0, 6);
  $('#flyout-grid').innerHTML = shown.length
    ? shown.map((d) => `
        <div class="flyout-item" data-flyout-id="${d.id}" title="${escapeHtml(d.title)}">
          <div class="flyout-thumb">${d.thumbFile
            ? `<img loading="lazy" decoding="async" src="${mediaUrl(d.id, 'thumb.svg')}" alt="">`
            : ''}</div>
          <div class="flyout-name">${escapeHtml(d.title)}</div>
        </div>`).join('') + (items.length > 6 ? `<div class="flyout-more">…还有 ${items.length - 6} 张</div>` : '')
    : '<div class="flyout-more">（此目录暂无图）</div>';
  const sidebarRect = $('#sidebar').getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  flyoutEl.style.left = `${Math.max(8, Math.min(sidebarRect.right + 12, window.innerWidth - flyoutEl.offsetWidth - 12))}px`;
  flyoutEl.style.top = `${Math.max(8, Math.min(rowRect.top - 6, window.innerHeight - flyoutEl.offsetHeight - 12))}px`;
  flyoutEl.classList.remove('hidden');
  flyoutEl.querySelectorAll('[data-flyout-id]').forEach((item) => {
    item.addEventListener('click', () => {
      hideFlyout();
      showDetail(item.dataset.flyoutId);
    });
  });
}

flyoutEl.addEventListener('mouseenter', () => clearTimeout(flyoutHideTimer));
flyoutEl.addEventListener('mouseleave', () => {
  flyoutHideTimer = setTimeout(hideFlyout, 200);
});

// —— 网格增量渲染：卡片按 id 键控复用 ——
// 数据刷新（SSE 热更新 / 导入 / issue 变化）只增删改发生变化的卡片：未变化卡片的
// DOM 与已解码缩略图原地保留（不重新 parse/decode、无闪动、滚动位置天然保持）。
// 卡片签名含 mediaRev 版本戳：SSE 标记 changed 的图版本戳变化 → 对应卡片自动重建
// 并换上 ?v= 破缓存 URL（服务端对该 URL 回 immutable 长缓存，重复加载零请求）。
function openIssueCountByDiagram() {
  const map = new Map();
  for (const i of state.issues) {
    if (i.status === 'open' && i.diagramId != null) map.set(i.diagramId, (map.get(i.diagramId) || 0) + 1);
  }
  return map;
}

function cardSig(d, openIssues) {
  return `${d.id}|${d.title}|${d.type}|${d.folder ?? ''}|${d.importedAt}|${openIssues}|${mediaRev.get(d.id) || 0}`;
}

function renderGrid() {
  const visible = visibleDiagrams();
  const grid = $('#grid');
  const openCount = openIssueCountByDiagram();
  const existing = new Map();
  for (const el of grid.children) {
    if (el.classList.contains('card')) existing.set(el.dataset.id, el);
  }
  const seen = new Set();
  for (const d of visible) {
    seen.add(d.id);
    const sig = cardSig(d, openCount.get(d.id) || 0);
    const el = existing.get(d.id);
    if (el && el.dataset.sig === sig) continue; // 卡片无变化：原地保留
    const wrap = document.createElement('div');
    wrap.innerHTML = cardHtml(d, openCount);
    const fresh = wrap.firstElementChild;
    fresh.dataset.sig = sig;
    if (el) el.replaceWith(fresh); // 原位替换，不打乱相邻卡片
    else grid.appendChild(fresh);
  }
  for (const [id, el] of existing) if (!seen.has(id)) el.remove();
  // 顺序对齐（新导入的卡 append 在了末尾）：顺序不一致时才整批移动既有节点
  const cardsById = new Map();
  for (const el of grid.children) if (el.classList.contains('card')) cardsById.set(el.dataset.id, el);
  const desired = visible.map((d) => cardsById.get(d.id)).filter(Boolean);
  const current = [...grid.children].filter((el) => el.classList.contains('card'));
  if (current.length === desired.length && current.some((el, i) => el !== desired[i])) {
    for (const el of desired) grid.appendChild(el);
  }
  $('#empty').classList.toggle('hidden', visible.length > 0);
  $('#empty-hint').textContent = state.diagrams.length === 0
    ? '把鼠标移到左侧目录上点 ⇪ 导入，或先建一个项目目录。'
    : (state.search ? '换个关键词试试。' : '这个目录还没有图，把鼠标移到目录行上点 ⇪ 导入。');
}

function cardHtml(d, openCount) {
  const thumb = d.thumbFile
    ? `<img loading="lazy" decoding="async" src="${mediaUrl(d.id, 'thumb.svg')}" alt="${escapeHtml(d.title)}">`
    : `<div class="thumb-missing">无缩略图</div>`;
  const openIssues = openCount.get(d.id) || 0;
  const issueBtn = `
    <button class="issue-btn" data-act="issue" data-id="${d.id}" title="Issue：查看列表 / 新建">
      🐛<span class="issue-count ${openIssues ? '' : 'zero'}">${openIssues}</span>
    </button>`;
  const date = new Date(d.importedAt).toLocaleString('zh-CN', { hour12: false });
  const actions = [
    `<button class="btn small" data-act="open" data-id="${d.id}">预览</button>`,
    d.specFile ? `<a class="btn small" href="/gallery/${d.id}/${d.specFile}" download="${d.id}.json">下载规范</a>` : '',
    `<a class="btn small" href="/gallery/${d.id}/${d.htmlFile}" download="${d.id}.html">下载 HTML</a>`,
    `<button class="btn small danger" data-act="delete" data-id="${d.id}">删除</button>`,
  ].join('');
  return `
    <div class="card" data-id="${d.id}">
      <div class="thumb-box" data-act="open" data-id="${d.id}">${issueBtn}${thumb}</div>
      <div class="card-body">
        <div class="card-title" title="${escapeHtml(d.title)}">${escapeHtml(d.title)}</div>
        <div class="card-meta">
          <span class="badge ${d.type}">${TYPE_LABEL[d.type] || d.type}</span>
          <span class="badge src">${SOURCE_LABEL[d.source] || d.source}</span>
          ${d.folder ? `<span class="badge folder">${escapeHtml(d.folder)}</span>` : '<span class="badge folder">未分类</span>'}
          <span class="card-date">${date}</span>
        </div>
        <div class="card-actions">${actions}</div>
      </div>
    </div>`;
}

// 卡片操作事件委托（一次绑定，增量渲染下长期有效）：原实现每次渲染后
// document.querySelectorAll('[data-act]') 全文档查询 + 逐按钮挂监听，一轮渲染重绑一次。
$('#grid').addEventListener('click', (event) => {
  const el = event.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  if (act !== 'issue' && act !== 'open' && act !== 'delete') return;
  event.preventDefault();
  if (act === 'issue') {
    event.stopPropagation(); // 不能冒泡到缩略图（打开详情）
    showDetail(id); // 打开详情
    openIssueListView(); // 🐛 的意图是看全部 issue：切整屏列表视图
    return;
  }
  if (act === 'open') showDetail(id);
  if (act === 'delete') deleteDiagram(id);
});

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 右侧详情面板（整幅展示 + 滚轮缩放 + 左/右键拖动平移） ----
const detailFrame = $('#detail-frame');
let detailLoadedId = null;

function showDetail(id) {
  const d = state.diagrams.find((item) => item.id === id);
  if (!d) return;
  detailLoadedId = id;
  $('#detail-title').textContent = d.title;
  $('#detail-open').href = mediaUrl(d.id, d.htmlFile);
  $('#detail-pane').classList.remove('hidden');
  $('#split').classList.add('with-detail');
  detailFrame.src = mediaUrl(d.id, d.htmlFile);
  // 左侧目录栏自动切换到该图所属目录（含展开祖先链），搜索态随之让位。
  const folderPath = d.folder ?? null;
  if (state.selection.scope !== 'folder' || state.selection.path !== folderPath) {
    state.selection = { scope: 'folder', path: folderPath, id: null };
    state.search = '';
    $('#search').value = '';
    if (folderPath) {
      const parts = folderPath.split('/');
      for (let i = 1; i <= parts.length; i += 1) state.expanded.add(parts.slice(0, i).join('/'));
    } else {
      state.expanded.add('');
    }
    renderTree();
  }
  // 实时上下文芯片联动。
  if (veilOpen()) renderAgentContext();
  // 重置 issue 相关模式（提交/编辑态退出、整屏列表退出、面板收起）。
  exitIssueFileMode();
  closeIssueListView();
  setComposerTarget(null);
  issueTags.length = 0;
  renderIssueTags();
  $('#di-title').value = '';
  $('#di-body').value = '';
  $('#detail-issues').classList.add('collapsed');
  renderIssuePanel();
}

function closeDetail() {
  detailLoadedId = null;
  $('#detail-pane').classList.add('hidden');
  $('#split').classList.remove('with-detail');
  detailFrame.src = 'about:blank';
}

$('#detail-close').addEventListener('click', () => {
  if (issueCenter.active) { closeIssueCenter(); return; } // 中心模式占详情位：关闭回到图表
  closeDetail();
});
detailFrame.addEventListener('load', () => {
  attachZoomPan(detailFrame, detailLoadedId);
});

// 同源 iframe：注入滚轮缩放（以光标为中心）+ 左/右键拖动平移 + 双击复位，
// 以及「长按组件 3 秒 → 提组件 issue」。
function attachZoomPan(iframe, diagramId) {
  const doc = iframe.contentDocument;
  if (!doc || detailLoadedId == null) return;
  const svg = doc.querySelector('svg');
  if (!svg || svg.dataset.zoomPan) return;
  svg.dataset.zoomPan = '1';
  // 连线命中扩展：连线只有 ~1.5px 描边可点，真实点击几乎不可能命中。
  // 优先增强模板自带的 relationship-hit-rail（它在最上层拦截点击）：
  // 把对应原线的 data-edge-* 复制上去并加宽命中描边；无 rail 时克隆原线兜底。
  const disableEdgeHelpers = () => {
    const originals = new Map();
    for (const p of doc.querySelectorAll('path[data-edge-from]:not(.relationship-hit-rail):not([data-hit-helper])')) {
      originals.set(p.getAttribute('d'), p);
    }
    for (const rail of doc.querySelectorAll('.relationship-hit-rail')) {
      if (rail.dataset.hitDone) continue;
      const orig = originals.get(rail.getAttribute('d'));
      if (!orig) continue;
      rail.dataset.hitDone = '1';
      rail.setAttribute('data-edge-from', orig.getAttribute('data-edge-from'));
      rail.setAttribute('data-edge-to', orig.getAttribute('data-edge-to'));
      const label = orig.getAttribute('data-edge-label');
      if (label) rail.setAttribute('data-edge-label', label);
      rail.setAttribute('stroke-width', '16');
      rail.setAttribute('pointer-events', 'stroke');
    }
    for (const edge of doc.querySelectorAll('path[data-edge-from]:not(.relationship-hit-rail)')) {
      if (edge.dataset.hitDone) continue;
      edge.dataset.hitDone = '1';
      const hit = edge.cloneNode(false);
      hit.removeAttribute('id');
      hit.removeAttribute('class');
      hit.removeAttribute('style');
      hit.removeAttribute('marker-end');
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '16');
      hit.setAttribute('fill', 'none');
      hit.setAttribute('pointer-events', 'stroke');
      hit.dataset.hitHelper = '1';
      edge.parentNode.insertBefore(hit, edge.nextSibling);
    }
  };
  disableEdgeHelpers();
  setTimeout(disableEdgeHelpers, 800); // 模板脚本可能异步生成 rail，再补一次
  const style = doc.createElement('style');
  style.textContent = 'svg{cursor:grab}svg.panning{cursor:grabbing}'
    + '*{scrollbar-width:thin;scrollbar-color:#2a3f63 rgba(255,255,255,.03)}'
    + '*::-webkit-scrollbar{width:10px;height:10px}'
    + '*::-webkit-scrollbar-track{background:rgba(255,255,255,.02);border-radius:8px}'
    + '*::-webkit-scrollbar-thumb{background:#2a3f63;border-radius:8px;border:2px solid rgba(11,18,32,.4)}'
    + '*::-webkit-scrollbar-thumb:hover{background:#38bdf8}'
    // 连线悬停流光：54 = 3 × (10+8)，dashoffset 动画恰好整数个虚线周期，infinite 循环无跳变
    + '@keyframes archify-hover-edge-flow{from{stroke-dashoffset:54}to{stroke-dashoffset:0}}'
    + '.archify-hover-flow{stroke-dasharray:10 8!important;animation:archify-hover-edge-flow 1.2s linear infinite!important}';
  doc.head.appendChild(style);
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const apply = () => {
    svg.style.transformOrigin = '0 0';
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  doc.addEventListener('wheel', (event) => {
    // 虚窗开启时滚轮属于 agent 对话走廊，不缩放图表
    if (window.parent.__archifyVeilWheel?.(event.deltaY)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(10, Math.max(0.15, scale * factor));
    const applied = next / scale;
    scale = next;
    tx = event.clientX - applied * (event.clientX - tx);
    ty = event.clientY - applied * (event.clientY - ty);
    apply();
  }, { capture: true, passive: false });
  // ---- 左键 / 右键：按住拖动 = 平移。右键按下即平移；左键移动超过 4px 才算
  // 拖动（纯点击仍走组件选中路由：agent 索引 / issue 提交标记），拖动后的
  // click 一律吞掉防误选。 ----
  let panning = false;
  let pressed = false;
  let dragged = false;
  let lastX = 0;
  let lastY = 0;
  doc.addEventListener('contextmenu', (event) => event.preventDefault(), true);
  doc.addEventListener('mousedown', (event) => {
    if (event.button !== 0 && event.button !== 2) return;
    pressed = true;
    dragged = false;
    lastX = event.clientX;
    lastY = event.clientY;
    if (event.button === 2) { // 右键无点击语义，按下即平移
      panning = true;
      svg.classList.add('panning');
      event.preventDefault();
    }
  }, true);
  doc.addEventListener('mousemove', (event) => {
    if (!pressed) return;
    if (!panning) {
      // 左键：超过拖动阈值才进平移，轻点选中不受影响
      if (Math.hypot(event.clientX - lastX, event.clientY - lastY) < 4) return;
      panning = true;
      dragged = true;
      svg.classList.add('panning');
    }
    tx += event.clientX - lastX;
    ty += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    apply();
  });
  doc.addEventListener('mouseup', () => {
    pressed = false;
    panning = false;
    svg.classList.remove('panning');
  }, true);
  doc.addEventListener('mouseleave', () => {
    pressed = false;
    panning = false;
    rightTarget = null;
    svg.classList.remove('panning');
  });
  // 平移刚结束的那次 click 吞掉，防止拖完图误触发组件选中
  doc.addEventListener('click', (event) => {
    if (!dragged) return;
    dragged = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  doc.addEventListener('dblclick', () => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  });
  // 焦点在图内时把 ESC / Enter 转发给父页面（虚窗退出与唤醒）。
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' || event.key === 'Enter') {
      window.parent.__archifyVeilKey?.(event.key);
      event.preventDefault();
    }
  });
  // 点击组件 / 连线 / 区域 → 父页面按当前模式分发（agent 索引 / issue 提交
  // 或编辑定位 / 默认不拦截走 viewer 卡片）。capture 阶段监听防模板截停冒泡。
  doc.addEventListener('click', (event) => {
    const el = event.target?.closest?.('[data-node-id], [data-edge-from], [data-graph-role="structural-frame"]');
    if (!el) return;
    const routed = window.parent.__archifyModeClick?.(issueTargetInfo(el));
    if (routed?.blocked) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  // ---- 连线悬停流光：模板自带的 relationship 流光悬停只播一次（animationend
  // 即撤 overlay），这里让悬停中的连线持续周期流动，移开恢复原线型。悬停目标
  // 可能是模板热轨 / 命中克隆 / 连线本体，统一按 from/to/label 找可见线：path
  // 直接用，g（sequence）取其内部描边元素；热轨层与 data-detail 分组不算。 ----
  if (!doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    let flowKey = null;
    let flowShapes = [];
    const stopEdgeFlow = () => {
      for (const s of flowShapes) s.classList.remove('archify-hover-flow');
      flowShapes = [];
      flowKey = null;
    };
    const isHitLayer = (el) => !!el.closest('[data-relationship-hit-overlay], [data-hit-helper]');
    const edgeShapesFor = (el) => {
      const from = el.getAttribute('data-edge-from');
      const to = el.getAttribute('data-edge-to');
      if (!from || !to) return [];
      const esc = (v) => window.CSS?.escape?.(v) ?? v;
      const label = el.getAttribute('data-edge-label');
      let sel = `[data-edge-from="${esc(from)}"][data-edge-to="${esc(to)}"]`;
      if (label) sel += `[data-edge-label="${esc(label)}"]`;
      return [...doc.querySelectorAll(sel)]
        .filter((node) => !isHitLayer(node) && !node.hasAttribute('data-detail'))
        .flatMap((node) => (node.matches('path, line, polyline') ? [node]
          : [...node.querySelectorAll('path, line, polyline')].filter((s) => !isHitLayer(s) && !s.closest('[data-detail]'))));
    };
    doc.addEventListener('mouseover', (event) => {
      const el = event.target?.closest?.('[data-edge-from]');
      if (!el || (event.relatedTarget && el.contains(event.relatedTarget))) return;
      const key = `${el.getAttribute('data-edge-from')}\u0000${el.getAttribute('data-edge-to')}\u0000${el.getAttribute('data-edge-label') || ''}`;
      if (key === flowKey) return; // 同一连线的多条热轨间移动不重启动画
      stopEdgeFlow();
      flowShapes = edgeShapesFor(el);
      for (const s of flowShapes) s.classList.add('archify-hover-flow');
      flowKey = key;
    }, true);
    doc.addEventListener('mouseout', (event) => {
      const el = event.target?.closest?.('[data-edge-from]');
      if (!el || (event.relatedTarget && el.contains(event.relatedTarget))) return;
      stopEdgeFlow();
    }, true);
    doc.addEventListener('mouseleave', stopEdgeFlow);
  }
}

// 长按/右键/点击命中的元素 → 目标（节点 / 连线 / 边界或容器区域）。
// 连线标签用两端组件名（甲 → 乙「文本」），从图 DOM 实时查名保证可读。
function issueTargetInfo(element) {
  if (element.hasAttribute('data-node-id')) {
    return {
      id: element.getAttribute('data-node-id'),
      label: element.getAttribute('data-node-label') || element.getAttribute('data-node-id'),
    };
  }
  if (element.hasAttribute('data-edge-from')) {
    const from = element.getAttribute('data-edge-from');
    const to = element.getAttribute('data-edge-to');
    const text = element.getAttribute('data-edge-label') || '';
    const doc = element.ownerDocument;
    const fromName = doc.querySelector(`[data-node-id="${from}"]`)?.getAttribute('data-node-label') || from;
    const toName = doc.querySelector(`[data-node-id="${to}"]`)?.getAttribute('data-node-label') || to;
    return {
      id: `edge:${from}→${to}`,
      label: `${fromName} → ${toName}${text ? `「${text}」` : ''}`,
    };
  }
  const kind = element.getAttribute('data-composition-frame-kind') || 'boundary';
  const frameLabel = element.getAttribute('data-composition-frame-label') || kind;
  const kindName = {
    container: '容器', region: '区域', 'security-group': '安全组',
    lane: '泳道', group: '分组', 'exception-lane': '异常泳道',
  }[kind] || kind;
  return {
    id: `${kind}:${frameLabel}`,
    label: `${frameLabel}（${kindName}）`,
  };
}

// ---- 侧栏展开/收起 ----
function applySidebarCollapsed(collapsed) {
  $('#layout').classList.toggle('collapsed', collapsed);
  $('#btn-expand').classList.toggle('hidden', !collapsed);
  try { localStorage.setItem('archify-sidebar-collapsed', collapsed ? '1' : '0'); } catch { /* 忽略 */ }
}
$('#btn-collapse').addEventListener('click', () => applySidebarCollapsed(true));
$('#btn-expand').addEventListener('click', () => applySidebarCollapsed(false));
try { applySidebarCollapsed(localStorage.getItem('archify-sidebar-collapsed') === '1'); } catch { /* 忽略 */ }

// ---- 导入弹窗（目标目录） ----
function openImport(folderPath) {
  state.importTarget = folderPath;
  $('#import-target').textContent = `导入到：${folderPath ?? '未分类'}`;
  $('#import-modal').classList.remove('hidden');
}
function closeImport() {
  $('#import-modal').classList.add('hidden');
  hideStatus();
}
$('#import-modal').addEventListener('click', (event) => {
  if (event.target === $('#import-modal')) closeImport();
});
$('#import-modal').querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', closeImport);
});

// ---- 目录管理 ----
const state_folderModal = { parent: null };

async function createFolder(name, parent, localPath) {
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parent: parent ?? '', localPath: localPath || '' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { folderStatus('err', data.error || `创建目录失败（HTTP ${res.status}）`); return false; }
  state.expanded.add(parent ?? '');
  return true;
}

function folderStatus(kind, html) {
  const box = $('#folder-status');
  box.className = `status ${kind}`;
  box.innerHTML = html;
  box.classList.remove('hidden');
}

function openFolderModal(parent) {
  state_folderModal.parent = parent ?? null;
  $('#folder-parent').textContent = parent ? parent : '顶层（项目根）';
  // 存放路径仅对顶层项目目录开放。
  $('#folder-local-row').style.display = parent ? 'none' : '';
  $('#folder-name').value = '';
  $('#folder-local').value = '';
  folderStatus('', ''); $('#folder-status').classList.add('hidden');
  $('#folder-modal').classList.remove('hidden');
  setTimeout(() => $('#folder-name').focus(), 50);
}

function closeFolderModal() {
  $('#folder-modal').classList.add('hidden');
}

$('#btn-new-folder').addEventListener('click', () => openFolderModal(null));
$('#folder-modal').addEventListener('click', (event) => {
  if (event.target === $('#folder-modal')) closeFolderModal();
});
$('#folder-modal').querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', closeFolderModal);
});
// 「选择路径…」= 在网页里浏览图集服务器（本地部署=本机；远端部署=远端服务器）的目录，
// 选中的是服务器侧的本地路径——浏览器本机盘符无关、不弹任何原生对话框（远端看不见对话框），
// Windows / Linux 路径天然兼容。
const pathModalEl = $('#path-modal');
const pathEntriesEl = $('#path-entries');
let pathState = { path: '', parent: null, entries: [] };

function pathPickStatus(kind, text) {
  const box = $('#path-status');
  box.className = `status ${kind}`;
  box.textContent = text;
  box.classList.toggle('hidden', !kind);
}

async function loadServerPath(p) {
  pathEntriesEl.innerHTML = '<div class="path-entry empty">读取中…</div>';
  try {
    const res = await fetch(`/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ''}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      pathPickStatus('err', data.error || `读取失败（HTTP ${res.status}）`);
      pathEntriesEl.innerHTML = '';
      return;
    }
    pathState = data;
    $('#path-current').value = data.path || '';
    $('#btn-path-up').disabled = !data.path || data.path === '/';
    pathEntriesEl.innerHTML = data.entries.length
      ? data.entries.map((e) => `<div class="path-entry" data-full="${escapeHtml(e.full)}" title="${escapeHtml(e.full)}">📁 ${escapeHtml(e.name)}</div>`).join('')
      : `<div class="path-entry empty">${data.readable === false ? '（无权限列出此目录）' : '（无子目录）'}</div>`;
    pathPickStatus('', '');
  } catch {
    pathPickStatus('err', '目录读取失败，可尝试直接粘贴路径跳转');
    pathEntriesEl.innerHTML = '';
  }
}

function closePathModal() {
  pathModalEl.classList.add('hidden');
}

$('#btn-browse').addEventListener('click', () => {
  pathModalEl.classList.remove('hidden');
  loadServerPath($('#folder-local').value.trim() || '');
});
pathModalEl.addEventListener('click', (event) => { if (event.target === pathModalEl) closePathModal(); });
pathModalEl.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closePathModal));
$('#btn-path-up').addEventListener('click', () => loadServerPath(pathState.parent ?? ''));
$('#btn-path-go').addEventListener('click', () => loadServerPath($('#path-current').value.trim()));
$('#path-current').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadServerPath(event.currentTarget.value.trim()); });
pathEntriesEl.addEventListener('click', (event) => {
  const entry = event.target.closest('.path-entry[data-full]');
  if (entry) loadServerPath(entry.dataset.full);
});
$('#btn-path-pick').addEventListener('click', () => {
  if (!pathState.path || pathState.path === '/') { pathPickStatus('err', '请先进入要作为项目的文件夹'); return; }
  $('#folder-local').value = pathState.path;
  if (!$('#folder-name').value) $('#folder-name').value = pathState.path.split(/[\\/]/).filter(Boolean).pop() || '';
  closePathModal();
  folderStatus('ok', `已选择项目路径（图集服务器）：${pathState.path}`);
});
$('#btn-folder-create').addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  const name = $('#folder-name').value.trim();
  if (!name) { folderStatus('err', '请输入目录名'); $('#folder-name').focus(); return; }
  btn.disabled = true;
  const ok = await createFolder(name, state_folderModal.parent, $('#folder-local').value.trim());
  btn.disabled = false;
  if (ok) {
    closeFolderModal();
    await loadDiagrams();
  }
});
$('#folder-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('#btn-folder-create').click();
});

async function deleteFolder(folderPath) {
  if (!confirm(`确定删除空目录“${folderPath}”（及其空子目录）吗？`)) return;
  const res = await fetch(`/api/folders?path=${encodeURIComponent(folderPath)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || `删除失败（HTTP ${res.status}）`); return; }
  if (state.selection.path === folderPath) state.selection = { scope: 'all', path: null, id: null };
  await loadDiagrams();
}

// ---- 状态与诊断展示 ----
function showStatus(kind, html) {
  const box = $('#import-status');
  box.className = `status ${kind}`;
  box.innerHTML = html;
  box.classList.remove('hidden');
}
function hideStatus() { $('#import-status').classList.add('hidden'); }

function receiptHtml(receipt) {
  if (!receipt) return '';
  const diags = (receipt.diagnostics || []).map((d) =>
    `<div class="diag">[${escapeHtml(d.code || 'error')}] ${escapeHtml(d.message || '')}</div>`);
  const checks = (receipt.checks || []).filter((c) => !c.ok)
    .map((c) => `<div class="diag">检查项 ${escapeHtml(c.name)} 未通过</div>`);
  const lines = [...diags, ...checks];
  return lines.length ? lines.slice(0, 12).join('') : '<div class="diag">未知校验错误</div>';
}

// ---- 导入 ----
async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function importArchifyText(text, name, fileLabel) {
  let spec;
  try { spec = JSON.parse(text); } catch (error) {
    showStatus('err', `<b>${escapeHtml(fileLabel)}</b>：JSON 解析失败 — ${escapeHtml(error.message)}`);
    return false;
  }
  const { status, data } = await postJson('/api/import', { kind: 'archify', spec, name, folder: state.importTarget });
  if (status === 200) return { ok: true, title: data.imported.title, warnings: data.imported.warnings };
  showStatus('err', `<b>${escapeHtml(data.title || fileLabel || spec?.meta?.title || '')}</b> 校验未通过：${receiptHtml(data.receipt)}${data.error ? `<div class="diag">${escapeHtml(data.error)}</div>` : ''}`);
  return false;
}

async function importFile(file) {
  const text = await file.text();
  if (file.name.toLowerCase().endsWith('.html')) {
    const { status, data } = await postJson('/api/import', { kind: 'html', html: text, name: file.name.replace(/\.html?$/i, ''), folder: state.importTarget });
    if (status === 200) return { ok: true, title: data.imported.title };
    showStatus('err', `<b>${escapeHtml(file.name)}</b>：${escapeHtml(data.error || '导入失败')}`);
    return false;
  }
  return importArchifyText(text, undefined, file.name);
}

async function importFiles(files) {
  const results = [];
  for (const file of files) results.push(await importFile(file));
  const ok = results.filter((r) => r && r.ok);
  if (ok.length) {
    if (state.importTarget != null) state.expanded.add(state.importTarget);
    await loadDiagrams();
    closeImport();
  }
  return ok.length;
}

// ---- 导入界面事件 ----
$('#btn-refresh').addEventListener('click', () => loadDiagrams());

$('#btn-examples').addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true; btn.textContent = '导入中…';
  const { status, data } = await postJson('/api/import-examples', {});
  btn.disabled = false; btn.textContent = '⚡ 一键导入 archify 示例图';
  if (status !== 200) { showStatus('err', `示例导入失败：${escapeHtml(data.error || '')}`); return; }
  const failHtml = (data.failed || []).map((f) =>
    `<div class="diag">${escapeHtml(f.file)}：${escapeHtml(f.error || '')}${f.receipt ? receiptHtml(f.receipt) : ''}</div>`).join('');
  if (data.imported > 0 || data.skipped > 0) {
    await loadDiagrams();
    closeImport();
  } else {
    showStatus('err', `示例导入完成但没有新增。${failHtml}`);
  }
});

// tabs
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-body').forEach((b) => b.classList.add('hidden'));
    tab.classList.add('active');
    document.querySelector(`.tab-body[data-body="${tab.dataset.tab}"]`)?.classList.remove('hidden');
  });
});

// dropzone
const dz = $('#dropzone');
const fileInput = $('#file-input');
$('#btn-pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { importFiles([...fileInput.files]); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((name) => dz.addEventListener(name, (event) => {
  event.preventDefault(); dz.classList.add('drag');
}));
['dragleave', 'drop'].forEach((name) => dz.addEventListener(name, (event) => {
  event.preventDefault(); dz.classList.remove('drag');
}));
dz.addEventListener('drop', (event) => {
  const files = [...(event.dataTransfer?.files || [])];
  if (files.length) importFiles(files);
});

// paste JSON
$('#btn-json').addEventListener('click', async () => {
  const text = $('#json-text').value.trim();
  if (!text) { showStatus('err', '请先粘贴 archify JSON'); return; }
  const result = await importArchifyText(text, $('#json-name').value.trim() || undefined, '粘贴的 JSON');
  if (result) {
    if (state.importTarget != null) state.expanded.add(state.importTarget);
    await loadDiagrams();
    closeImport();
  }
});

// paste Mermaid
$('#btn-mermaid').addEventListener('click', async () => {
  const code = $('#mermaid-text').value.trim();
  if (!code) { showStatus('err', '请先粘贴 Mermaid 代码'); return; }
  const { status, data } = await postJson('/api/import', {
    kind: 'mermaid', code, name: $('#mermaid-name').value.trim() || undefined, folder: state.importTarget,
  });
  if (status === 200) {
    if (state.importTarget != null) state.expanded.add(state.importTarget);
    await loadDiagrams();
    closeImport();
  } else {
    showStatus('err', `<b>Mermaid 转换未通过校验</b>${data.error ? `：${escapeHtml(data.error)}` : ''}${receiptHtml(data.receipt)}`);
  }
});

// ---- Issue 机制（详情底部面板 + 右键定位提 issue） ----
const issuePanel = { target: null, editing: null }; // target: {id, label} | null

function issuesFor(diagramId) {
  return state.issues.filter((i) => i.diagramId === diagramId);
}

function setComposerTarget(target) {
  issuePanel.target = target;
  const box = $('#di-target');
  if (target) {
    box.innerHTML = `目标：📌 <b>${escapeHtml(target.label)}</b> <span style="opacity:.7">(${escapeHtml(target.id)})</span><button class="clear-target" title="清除目标（改为整图）">✕</button>`;
    box.classList.remove('hidden');
    box.querySelector('.clear-target').addEventListener('click', () => setComposerTarget(null));
  } else {
    box.classList.add('hidden');
    box.innerHTML = '';
  }
}

// 面板列表的数据源：issue 中心模式=目录范围；否则=当前打开的图
function issuePanelListItems() {
  if (issueCenter.active) return issueCenterScopeIssues(issueCenter.folder);
  return detailLoadedId == null ? [] : issuesFor(detailLoadedId);
}

function renderIssuePanel() {
  const items = issuePanelListItems();
  const open = items.filter((i) => i.status === 'open').length;
  $('#di-count').textContent = items.length ? `${open} 开启 · ${items.length - open} 关闭` : '';
  $('#detail-issue-count').textContent = open;
  const list = $('#di-list');
  // 加图编辑模式：只显示正在编辑的表单
  const editing = issuePanel.editing != null ? items.find((i) => i.id === issuePanel.editing) : null;
  const shown = editing ? [editing] : items;
  // 点组件加标签会触发重渲染：先留住编辑表单里未保存的输入
  const draftTitle = list.querySelector('.edit-title')?.value;
  const draftBody = list.querySelector('.edit-body')?.value;
  list.innerHTML = shown.length ? shown.map((i) => issueItemHtml(i)).join('')
    : '<div class="issue-empty">还没有 issue — 点右上 🐛 查看全部 / 🐞 进入提交模式</div>';
  if (draftTitle != null) {
    const title = list.querySelector('.edit-title');
    if (title) {
      title.value = draftTitle;
      list.querySelector('.edit-body').value = draftBody ?? '';
    }
  }
  wireIssueItems(list);
}

// issue 的标签芯片（可读标签 + × 删除，点击 × 直接 PATCH 移除）
function issueTagChips(i, { withRemove = true } = {}) {
  const nodes = i.nodes?.length ? i.nodes : (i.nodeId ? [{ id: i.nodeId, label: i.nodeId }] : []);
  if (!nodes.length) return '';
  return `<span class="tag-row" style="display:inline-flex">${nodes.map((n) => `
    <span class="tag-chip" title="${escapeHtml(n.id)}">
      <span class="tag-label">${escapeHtml(n.label)}</span>
      ${withRemove ? `<button class="tag-x" data-node-del="${escapeHtml(n.id)}" data-issue-id="${i.id}" title="删除此标签">✕</button>` : ''}
    </span>`).join('')}</span>`;
}

// 拒绝标（closed + refused）：看板拒绝后，面板 / 整屏列表 / issue 中心的卡片共用
const refusedTag = (i) => (i.refused ? '<span class="bd-tag refuse">已拒绝</span>' : '');

function issueItemHtml(i) {
  if (issuePanel.editing === i.id) {
    const isNew = i.kind === 'new-feature'; // 创建类无图可标目标，编辑表单不渲染标签行
    return `
      <div class="issue-item editing" data-issue="${i.id}">
        <div class="issue-edit">
          ${isNew ? '' : `<div class="edit-target-row">
            <span>目标标签：</span>
            ${issueTagChips(i)}
            <span style="margin-left:auto">点击图中组件 / 连线 / 区域追加</span>
          </div>`}
          <input class="edit-title" value="${escapeHtml(i.title)}" maxlength="200">
          <textarea class="edit-body">${escapeHtml(i.body || '')}</textarea>
          <div class="edit-actions">
            <button class="btn small" data-issue-act="cancel-edit">取消</button>
            <button class="btn small primary" data-issue-act="save-edit">保存</button>
          </div>
        </div>
      </div>`;
  }
  return `
    <div class="issue-item ${i.status}" data-issue="${i.id}">
      <div class="row-1">
        <span class="issue-dot" title="${i.refused ? '已拒绝' : (i.status === 'open' ? '开启' : '已关闭')}"></span>
        ${refusedTag(i)}
        <span class="issue-title-text" title="${escapeHtml(i.title)}">#${i.id} ${escapeHtml(i.title)}</span>
      </div>
      <div class="row-2">${issueTagChips(i)}</div>
      ${i.body ? `<div class="issue-body-text">${escapeHtml(i.body)}</div>` : ''}
      <div class="row-2">
        <span class="issue-meta">${new Date(i.createdAt).toLocaleString('zh-CN', { hour12: false })}${i.updatedAt !== i.createdAt ? ' · 已编辑' : ''}</span>
        <button class="btn small" data-issue-act="edit">编辑</button>
        <button class="btn small" data-issue-act="toggle">${i.status === 'open' ? '关闭' : '重开'}</button>
        <button class="btn small danger" data-issue-act="delete">删除</button>
      </div>
    </div>`;
}

// 标签 × 删除：直接 PATCH 移除该标签（面板与整屏列表共用）
function bindNodeDelButtons(scope) {
  scope.querySelectorAll('[data-node-del]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const issueId = Number(btn.dataset.issueId);
      const delId = btn.dataset.nodeDel;
      const current = state.issues.find((i) => i.id === issueId);
      if (!current) return;
      const nodes = (current.nodes || []).filter((n) => n.id !== delId);
      const res = await fetch(`/api/issues/${issueId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes }),
      });
      if (res.ok) await loadIssues();
    });
  });
}

function wireIssueItems(list) {
  bindNodeDelButtons(list);
  list.querySelectorAll('[data-issue-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = btn.closest('[data-issue]');
      const id = Number(item.dataset.issue);
      const act = btn.dataset.issueAct;
      if (act === 'edit') {
        enterIssueEditMode(id);
        $('#di-list').querySelector('.edit-title')?.focus();
      } else if (act === 'cancel-edit') {
        exitIssueFileMode();
      } else if (act === 'save-edit') {
        const title = item.querySelector('.edit-title').value.trim();
        const body = item.querySelector('.edit-body').value.trim();
        if (!title) { item.querySelector('.edit-title').focus(); return; }
        const res = await fetch(`/api/issues/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body }),
        });
        if (res.ok) {
          exitIssueFileMode();
          await loadIssues();
        } else {
          const data = await res.json().catch(() => ({}));
          alert(data.error || `保存失败（HTTP ${res.status}）`);
        }
      } else if (act === 'toggle') {
        const current = state.issues.find((x) => x.id === id);
        const res = await fetch(`/api/issues/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: current?.status === 'open' ? 'closed' : 'open' }),
        });
        if (res.ok) await loadIssues();
      } else if (act === 'delete') {
        if (!confirm('确定删除这条 issue 吗？')) return;
        const res = await fetch(`/api/issues/${id}`, { method: 'DELETE' });
        if (res.ok) await loadIssues();
      }
    });
  });
}

// —— composer 类型（缺陷/改进 vs 创建新图）：创建类是目录级 issue（new feature 标签），
// 由流水线读项目代码生成新图；缺陷类挂在当前图上、可点图加标签 ——
let composerKind = 'bug';

function setComposerKind(kind) {
  composerKind = kind === 'new-feature' ? 'new-feature' : 'bug';
  const isNew = composerKind === 'new-feature';
  $('#di-kind').value = composerKind;
  $('#di-kind-hint').textContent = isNew
    ? '打 new feature 标签 · 提交即执行——流水线读项目代码生成新图并自动关闭'
    : '';
  $('#di-tags').classList.toggle('hidden', isNew); // 创建类无图可标
  if (isNew) {
    issueTags.length = 0;
    renderIssueTags();
    setComposerTarget(null);
  }
  $('#di-title').placeholder = isNew
    ? '想创建什么图？例如：画出本项目的系统架构图（服务、存储、外部依赖）'
    : '新 issue 标题（提交模式下点击图中组件/连线/区域添加标签）';
  $('#di-body').placeholder = isNew
    ? '范围 / 关注点（可选）：要覆盖的模块、图类型偏好、重点链路…'
    : '描述（可选）：复现步骤、期望效果…';
}

$('#di-kind').addEventListener('change', (event) => setComposerKind(event.target.value));

// 面板底部新建输入框：缺陷类挂图（提交模式下点击组件添加标签）；创建类走目录级 POST /api/issues
$('#di-submit').addEventListener('click', async () => {
  const title = $('#di-title').value.trim();
  if (!title) { $('#di-title').focus(); return; }
  if (composerKind === 'new-feature') {
    // 目标目录：issue 中心用其目录；从图详情切类型时用图所属目录
    const diagram = detailLoadedId != null ? state.diagrams.find((d) => d.id === detailLoadedId) : null;
    const folder = issueCenter.active ? issueCenter.folder : (diagram?.folder ?? null);
    const res = await fetch('/api/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'new-feature', folder, title, body: $('#di-body').value.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.error || `提交失败（HTTP ${res.status}）`);
      return;
    }
    $('#di-title').value = '';
    $('#di-body').value = '';
    await loadIssues();
    if (issueCenter.active) renderIssueFullList();
    $('#di-kind-hint').textContent = `已提交 #${data.issue?.id ?? '?'}——提交即执行，进度见目录行 ⚡ 看板`;
    return;
  }
  if (detailLoadedId == null) return;
  const res = await fetch(`/api/diagrams/${detailLoadedId}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      body: $('#di-body').value.trim(),
      nodes: issueTags,
    }),
  });
  if (res.ok) {
    $('#di-title').value = '';
    $('#di-body').value = '';
    issueTags.length = 0;
    renderIssueTags();
    setComposerTarget(null);
    exitIssueFileMode();
    await loadIssues();
  }
});
$('#di-title').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('#di-submit').click();
});

// 面板收起 / 展开
$('#di-toggle').addEventListener('click', () => {
  $('#detail-issues').classList.toggle('collapsed');
});

// ---- Agent（Claude Code Agent SDK）交互窗 ----
const agentState = {
  settings: null, sessionId: null, sessionArea: undefined, es: null,
  // 多会话：消息在服务端后台执行（SDK query 不随浏览器断开终止），切走/关掉都不中断
  sessions: [], serveUp: false, pollTimer: null,
  turnsBySession: new Map(), // sessionId → turns 数组（agentTurns 持其中之一的引用）
  sessionAreaChecked: undefined, // 已按此归属区做过「进入区域」检查
  sessionPipeline: false, // 当前会话是否流水线会话（Issue 流水线自动执行，前端只读不可交互）
  // 历史会话栏的搜索 + 过滤（归档会话也在列表里，可搜索/导出、不可打开）
  sessionFilter: { q: '', kind: 'all' },
};

// 会话归属：目录自身或最近带 localPath 的祖先（= 会话的 cwd），无则图集根区。
// 同一项目（含其子目录）复用一个会话；切换项目 / 进出图集根区才新建会话。
function agentAreaKey(folder) {
  if (!folder) return null;
  const parts = folder.split('/');
  for (let i = parts.length; i >= 1; i -= 1) {
    const local = state.folderMeta[parts.slice(0, i).join('/')]?.localPath;
    if (local) return local;
  }
  return null;
}
let agentTurns = []; // 当前会话的 turns {q, a, done, error}（切换会话时整体换引用）

function sessionIsRunning(id) {
  return Boolean(id && agentState.sessions.find((s) => s.id === id)?.running);
}

function sessionLabel(s) {
  if (s.pipeline) return s.title || '流水线会话';
  return s.firstQ || s.title || '新会话';
}

function fmtSessionTime(epochMs) {
  const ms = Number(epochMs) || 0;
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function loadAgentSettings() {
  try {
    const s = await fetch('/api/agent/settings').then((r) => r.json());
    agentState.settings = s;
    $('#btn-agent').style.display = s.enabled ? '' : 'none';
  } catch {
    agentState.settings = null;
    $('#btn-agent').style.display = 'none';
  }
  syncVeilModel();
  updateAgentHint();
  loadAgentModels();
}

// —— 模型列表：来自 ⚙ 设置里编辑的模型列表（baseUrl 决定哪些真实可用） ——
async function fetchAgentModels() {
  try {
    const data = await fetch('/api/agent/models').then((r) => r.json());
    return Array.isArray(data.providers) ? data.providers : [];
  } catch { return []; }
}

// 把 provider 列表填进 <select>（按 provider 分组）；allowEmpty 时首位保留空选项（如「跟随全局」）。
// current 不在列表里（或历史裸模型名）：allowEmpty 退到空选项，否则退到第一个模型。
function populateModelSelect(sel, providers, current, { allowEmpty = false, emptyLabel = '' } = {}) {
  sel.innerHTML = '';
  if (allowEmpty) {
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = emptyLabel;
    sel.appendChild(ph);
  }
  for (const p of providers) {
    const group = document.createElement('optgroup');
    group.label = p.name;
    for (const m of p.models) {
      const opt = document.createElement('option');
      // 值必须是裸模型名（glm-5.3-flash）：网关不认 provider 前缀（model/xxx 会 400
      // 「模型不存在」→ Claude Code exit 1），服务端 updateSettings 也会兜底再剥一次
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
  if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
  else if (allowEmpty) sel.value = '';
  else if (sel.options.length) sel.value = sel.options[0].value;
}

async function loadAgentModels() {
  const providers = await fetchAgentModels();
  if (!providers.length) {
    // 服务不可达：不动已填好的列表；仍是纯占位时把「…」换成可读原因，别看着像卡死
    for (const sel of [$('#set-model'), $('#veil-model')]) {
      if (sel.options.length === 1 && !sel.options[0].value) sel.options[0].textContent = '⚠ 列表不可用（服务未启动）';
    }
    return;
  }
  // 空值 = 不指定模型（跟随全局默认），与服务端的空值语义一致
  const current = agentState.settings?.model || '';
  populateModelSelect($('#set-model'), providers, current, { allowEmpty: true, emptyLabel: '跟随全局默认' });
  populateModelSelect($('#veil-model'), providers, current, { allowEmpty: true, emptyLabel: '跟随全局默认' });
}

// —— 唤醒虚窗即刷新模型列表（设置里改了列表/首次加载未完成时补上） ——
async function agentPrewarmServe() {
  try {
    await fetch('/api/agent/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: state.selection.path ?? null, ensureOnly: true }),
    });
  } catch { /* 静默：预热失败不打扰用户，发消息时还会再走一遍 */ }
  loadAgentModels();
}

// —— 虚窗输入框左侧：模型实时切换（切换即保存，下一条消息生效） ——
function syncVeilModel() {
  $('#veil-model').value = agentState.settings?.model || ''; // 空值选中「跟随全局默认」
}
$('#veil-model').addEventListener('change', async () => {
  const model = $('#veil-model').value;
  const res = await fetch('/api/agent/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
  });
  if (res.ok) {
    agentState.settings = { ...agentState.settings, ...(await res.json()) };
    setTicker(`模型已切换 → ${escapeHtml(model || '跟随全局默认')}（下一条消息生效）`);
  } else {
    syncVeilModel(); // 保存失败：回滚显示
    setTicker('⚠ 模型切换失败');
  }
});

// —— 设置弹窗 ——
function openSettingsModal() {
  const s = agentState.settings || { enabled: false, baseUrl: '', defaultModel: '' };
  $('#set-enabled').checked = Boolean(s.enabled);
  $('#set-baseurl').value = s.baseUrl || '';
  $('#set-model').value = s.defaultModel || s.model || '';
  $('#set-models').value = Array.isArray(s.models) ? s.models.join(', ') : '';
  const modelLabel = s.defaultModel || s.model || '跟随全局默认';
  const sdkLabel = s.sdkReady === false ? '⚠ SDK 未安装（仓库根目录执行 npm install）' : 'Claude Code Agent SDK 就绪';
  $('#set-status').textContent = `后端：${sdkLabel} · 模型：${modelLabel}`;
  $('#settings-modal').classList.remove('hidden');
}
$('#btn-settings').addEventListener('click', async () => {
  await loadAgentSettings();
  openSettingsModal();
});
$('#settings-modal').addEventListener('click', (event) => {
  if (event.target === $('#settings-modal')) $('#settings-modal').classList.add('hidden');
});
$('#settings-modal').querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => $('#settings-modal').classList.add('hidden'));
});
$('#btn-settings-save').addEventListener('click', async () => {
  const body = {
    enabled: $('#set-enabled').checked,
    baseUrl: $('#set-baseurl').value.trim(),
    model: $('#set-model').value,
    models: $('#set-models').value.split(',').map((x) => x.trim()).filter(Boolean),
  };
  const res = await fetch('/api/agent/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.ok) {
    $('#settings-modal').classList.add('hidden');
    await loadAgentSettings();
  } else {
    const data = await res.json().catch(() => ({}));
    alert(data.error || '保存失败');
  }
});

// —— Issue 执行看板（两级，占据图表区的整页视图，sheet 切换：队列 / 历史 / 触发设置）——
// 全局看板（侧栏 ⏳）：队列 sheet = 正在运行（哪个项目的会话在执行、哪些在排队）+ 等待运行的项目
//   + 顶部全局最大并发数（改动即保存）；历史 sheet = 全部项目最近 10 次（失败可重新拉起）。
//   不显示 issue 明细、没有立即执行——那些在项目级看板。
// 项目级看板（目录行 ⚡）：队列 sheet = 本项目开启 issue（可单条立即执行，全局执行中禁用）+ 已拒绝；
//   历史 sheet = 本项目最近 10 次（失败可重新拉起）；触发设置 sheet = 触发方式/执行模型。
//   不显示运行中——执行进度只看全局看板。
async function loadCicd() {
  try {
    state.cicd = await fetch('/api/cicd').then((r) => r.json());
  } catch {
    // 静默失败：保留上次数据（树上的 ⚡ 指示不至于闪没）
  }
}

const board = {
  open: false, global: false, project: null, timer: null, tab: 'queue',
  countQueue: '', countHistory: '', // 队列/历史两个 sheet 各自的计数文本，按活动 sheet 应用
};

function fmtCicdTime(value) {
  const t = Date.parse(value);
  if (!value || !Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// issue 是否属于项目看板范围（project=null 表示未分类）：
// 缺陷类看所属图的目录归属，创建类（kind=new-feature）看目标目录归属
function issueInBoardScope(i, project) {
  const scopeMatch = (f) => (project == null ? f == null : (f === project || (f || '').startsWith(`${project}/`)));
  if (i.kind === 'new-feature') return scopeMatch(i.folder ?? null);
  if (!i.diagramId) return false;
  const d = state.diagrams.find((x) => x.id === i.diagramId);
  return d ? scopeMatch(d.folder ?? null) : false;
}

function countProjectOpenIssues(project) {
  return state.issues.filter((i) => i.status === 'open' && issueInBoardScope(i, project)).length;
}

// 打开项目级看板（project=顶层项目名；null=未分类——无触发设置 sheet，只有队列+历史）。入口 = 目录行 ⚡。
async function openBoard(project) {
  await openBoardView({ global: false, project: project ?? null });
}

// 打开全局执行看板。入口 = 侧栏头部 ⏳（仅管理员；按钮对普通用户已隐藏，这里兜底）。
async function openGlobalBoard() {
  if (!isAdmin()) return;
  await openBoardView({ global: true, project: null });
}

async function openBoardView({ global, project }) {
  clearInterval(board.timer); // 看板已开再点入口：先清旧轮询，防 await 期间重入泄漏定时器
  board.timer = null;
  board.open = true;
  board.global = global;
  board.project = project ?? null;
  hideFlyout();
  if (detailLoadedId != null) closeDetail();
  if (issueMode.listMode) closeIssueListView();
  $('#grid-pane').classList.add('hidden');
  $('#board-view').classList.remove('hidden');
  $('#board-tab-settings').classList.toggle('hidden', board.global || board.project == null || !isAdmin());
  setBoardTab('queue'); // 开板默认落在队列 sheet
  await Promise.all([loadDiagrams(), loadIssues(), loadCicd()]);
  // 模型下拉异步填（不阻塞看板渲染，到了再填）
  if (!board.global && board.project != null) {
    fillModelSelectFor($('#board-model'), state.cicd.projects?.[board.project]?.model || '', '跟随全局设置').catch(() => {});
  }
  fillBoardForm(); // 设置表单只在开板时填一次；轮询不覆盖用户正在编辑的输入
  renderBoardAll();
  board.timer = setInterval(() => Promise.all([loadCicd(), loadIssues()]).then(renderBoardAll), 3000);
}

function boardTitle() {
  if (board.global) return board.tab === 'history' ? '全局执行看板 · 历史' : '全局执行看板';
  const name = board.project ?? '未分类';
  return board.tab === 'history' ? `Issue 看板 · ${name} · 历史` : `Issue 看板 · ${name}`;
}

// sheet 切换：队列（默认）/ 历史 / 触发设置。设置 sheet 只在项目级且有触发配置的范围存在
// （未分类没有周期触发），开板时已把该 tab 按钮隐藏，这里再兜底拦一次；
// 触发设置（流水线配置）与全局看板一样仅管理员
function setBoardTab(tab) {
  if (!board.open) return;
  board.tab = ['queue', 'history', 'settings'].includes(tab) ? tab : 'queue';
  if (board.tab === 'settings' && (board.global || board.project == null || !isAdmin())) board.tab = 'queue';
  $('#board-queue').classList.toggle('hidden', board.tab !== 'queue');
  $('#board-history').classList.toggle('hidden', board.tab !== 'history');
  $('#board-settings').classList.toggle('hidden', board.tab !== 'settings');
  document.querySelectorAll('#board-tabs .board-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.boardTab === board.tab);
  });
  $('#board-live').textContent = board.tab === 'settings' ? '改动需保存才生效' : '每 3 秒自动刷新';
  $('#board-title').textContent = boardTitle();
  applyBoardCount();
}

document.querySelectorAll('#board-tabs .board-tab').forEach((btn) => {
  btn.addEventListener('click', () => setBoardTab(btn.dataset.boardTab));
});

function closeBoard() {
  if (!board.open) return;
  board.open = false;
  clearInterval(board.timer);
  board.timer = null;
  $('#board-view').classList.add('hidden');
  $('#grid-pane').classList.remove('hidden');
  loadCicd().then(() => renderTree()); // 刷新目录行 ⚡ 常显徽标
}

$('#board-back').addEventListener('click', closeBoard);

function fillBoardForm() {
  // 全局最大并发数（全局看板顶部直接改，改动即保存）
  $('#board-concurrency').value = state.cicd.maxConcurrentSessions ?? 2;
  if (board.global || board.project == null) return;
  const cfg = state.cicd.projects?.[board.project];
  $('#board-issue-enabled').checked = Boolean(cfg?.issueAuto?.enabled);
  $('#board-issue-threshold').value = cfg?.issueAuto?.threshold ?? 5;
  $('#board-issue-interval').value = cfg?.issueAuto?.intervalMinutes ?? 60;
}

// 模型下拉：跟随全局 + 设置里的模型列表；服务不可达时保留已存设置为临时选项，避免保存时误清空
async function fillModelSelectFor(sel, saved, emptyLabel) {
  const providers = await fetchAgentModels();
  if (!providers.length) {
    sel.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>`;
    if (saved) sel.innerHTML += `<option value="${escapeHtml(saved)}" selected>${escapeHtml(saved)}（当前设置）</option>`;
    return;
  }
  populateModelSelect(sel, providers, saved, { allowEmpty: true, emptyLabel });
  if (saved && sel.value !== saved) {
    const opt = document.createElement('option');
    opt.value = saved;
    opt.textContent = `${saved}（当前设置，模型列表中已不存在）`;
    sel.appendChild(opt);
    sel.value = saved;
  }
}

// 整板渲染（开板/轮询/保存后）：Agent 警示 + 队列 sheet（全局/项目两套）+ 历史 sheet + 状态行
function renderBoardAll() {
  $('#board-agent-warn').classList.toggle('hidden', state.cicd.agentEnabled !== false);
  $('#board-global-queue').classList.toggle('hidden', !board.global);
  $('#board-project-queue').classList.toggle('hidden', board.global);
  // 未分类没有触发设置 sheet，「▶ 立即执行」放在队列标题行；命名项目在设置 sheet 里也有一个
  $('#board-uncat-run').classList.toggle('hidden', board.global || board.project != null);
  if (board.global) renderGlobalQueue();
  else renderBoardQueue();
  renderBoardHistory();
  refreshBoardStatus();
}

// 计数文本按 sheet 分开记，切 tab 时应用对应那份（活动 sheet 上看到的总是新鲜的）
function applyBoardCount() {
  $('#board-count').textContent = board.tab === 'history' ? board.countHistory : board.countQueue;
}

// ---- 全局看板 · 队列 sheet：正在运行（多项目并行，一 run 一卡 + 会话分栏）+ 等待运行的项目 ----
function renderGlobalQueue() {
  const c = state.cicd;
  const runs = c.runs || [];
  // 正在运行：一 run 一卡（含并发会话分栏，queued 会话 = 等全局名额或等同目录前一组）
  $('#board-global-running').innerHTML = runs.length
    ? runs.map((r) => boardTaskHtml({ ...r, kind: r.kind || 'issues', status: 'running' })).join('')
    : '<div class="bd-empty">当前没有流水线在运行</div>';
  // 等待运行：有开启 issue、当前没在运行的项目。
  // 顺序：刚提交创建 issue 被记入待执行（kicked）的排最前，其余按项目名。
  const scopes = [...state.folders.filter((f) => !f.includes('/')), null];
  const runningProjects = new Set(runs.map((r) => r.project ?? null));
  const waiting = scopes
    .filter((p) => !runningProjects.has(p) && countProjectOpenIssues(p) > 0)
    .sort((a, b) => Number(!c.kicked?.includes(b)) - Number(!c.kicked?.includes(a)) || String(a).localeCompare(String(b), 'zh-CN'));
  $('#board-global-waiting').innerHTML = waiting.length
    ? waiting.map((p) => {
      const n = countProjectOpenIssues(p);
      const kicked = c.kicked?.includes(p);
      return `
        <div class="bd-task pending">
          <span class="bd-state">${kicked ? '◇' : '○'}</span>
          <span class="bd-kind">📦</span>
          <div class="bd-main">
            <div class="bd-line1">
              <span class="bd-title">${escapeHtml(p ?? '未分类')}</span>
              <span class="bd-folder">${n} 个开启 issue</span>
              <span class="bd-time">${kicked ? '已提交，该项目当前在跑——结束即接续执行' : '等待触发（到量 / 到时 / 手动）'}</span>
            </div>
          </div>
        </div>`;
    }).join('')
    : '<div class="bd-empty">没有等待执行的项目</div>';
  // 全局名额占用：所有 run 的 running 会话合计 / 上限（同项目可多 run，运行数与项目数分开报）
  const live = runs.reduce((n, r) => n + (r.sessions || []).filter((s) => s.status === 'running').length, 0);
  const limit = c.maxConcurrentSessions ?? c.sessionLimit ?? 2;
  const distinct = new Set(runs.map((r) => r.project ?? null)).size;
  board.countQueue = runs.length
    ? `${runs.length} 个运行${distinct > 1 ? ` · ${distinct} 个项目` : ''} · 会话 ${live}/${limit}`
    : '空闲';
  applyBoardCount();
}

// 运行记录里历史任务的类型图标（generate/review 为已下线功能的存量记录）
const BOARD_KIND_META = {
  issues: ['⚙', 'Issue 执行流水线'],
  generate: ['✨', '创建图（旧任务）'],
  review: ['🖼', '全图检视（旧任务）'],
};

function boardDuration(h) {
  const a = Date.parse(h.startedAt);
  const b = Date.parse(h.finishedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return '';
  const mins = Math.max(1, Math.round((b - a) / 60000));
  return mins >= 60 ? `${Math.floor(mins / 60)} 时 ${mins % 60} 分` : `${mins} 分钟`;
}

// 运行中卡的并发会话细流：每会话一栏（queued 排队 / running 执行 / done / failed），
// 栏下小字 = 任务内容（缺陷组：图名+缺陷编号；创建组：issue 标题），≤15 字，title 悬停看全文
const BD_SESSION_ICON = { queued: '○', running: '▶', done: '✓', failed: '✕' };
const trunc15 = (s) => (s.length > 15 ? `${s.slice(0, 14)}…` : s);
function boardSessionsHtml(sessions) {
  return `<div class="bd-sessions">${sessions.map((s, i) => {
    const st = BD_SESSION_ICON[s.status] ? s.status : 'queued';
    const kind = s.kind === 'create' ? '✨ 创建新图' : '🐞 缺陷改图';
    const desc = trunc15(String(s.desc || ''));
    return `
      <div class="bd-session ${st}" title="${escapeHtml(String(s.desc || ''))}">
        <div class="bd-s-top"><span class="bd-s-ico">${BD_SESSION_ICON[st]}</span><span class="bd-s-kind">${kind}</span><span class="bd-s-idx">会话 ${i + 1}</span></div>
        <div class="bd-s-desc">${escapeHtml(desc)}</div>
      </div>`;
  }).join('')}</div>`;
}

// 一条运行记录 = 一个卡片：状态图标 + 类型 + 项目名 + 标题（单条执行显示 issue）+ 摘要 + 耗时；
// 失败的带「↻ 重新拉起」（失败时 issue 都保持开启，重跑即重试——全局执行中时禁用）；
// 运行中的卡下方按并发会话分栏（run.sessions 实时状态，3s 轮询刷新）
function boardTaskHtml(h) {
  const meta = BOARD_KIND_META[h.kind] || ['⚙', h.kind];
  const dur = boardDuration(h);
  const summary = h.status === 'running' ? '执行中…'
    : h.status === 'error' ? (h.error || '失败') : (h.summary || '完成');
  const stateIcon = h.status === 'running' ? '▶' : (h.status === 'error' ? '✕' : '✓');
  const projTag = `<span class="bd-folder">${escapeHtml(h.project ?? '未分类')}</span>`;
  const title = h.issueId != null
    ? `${h.issueId ? `#${h.issueId} ` : ''}${h.issueTitle || (h.kind === 'issues' ? '单条执行' : '')}`
    : meta[1];
  const retry = h.status === 'error'
    ? `<button class="btn small" data-board-retry title="重新执行该范围内所有开启的 issue（失败时 issue 均保持开启）">↻ 重新拉起</button>`
    : '';
  const sess = h.status === 'running' && Array.isArray(h.sessions) && h.sessions.length
    ? boardSessionsHtml(h.sessions) : '';
  return `
    <div class="bd-taskwrap">
      <div class="bd-task ${h.status}">
        <span class="bd-state">${stateIcon}</span>
        <span class="bd-kind">${meta[0]}</span>
        ${projTag}
        ${h.tag ? `<span class="bd-tag">${escapeHtml(h.tag)}</span>` : ''}
        <div class="bd-main">
          <div class="bd-line1">
            <span class="bd-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
            <span class="bd-time">${fmtCicdTime(h.startedAt)}${h.model ? ` · ${escapeHtml(h.model)}` : ''}${dur ? ` · ${dur}` : ''}${h.trigger === 'manual' || h.trigger === 'issue-filed' ? ' · 手动' : ''}</span>
          </div>
          <div class="bd-summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</div>
        </div>
        ${retry ? `<div class="bd-side">${retry}</div>` : ''}
      </div>
      ${sess}
    </div>`;
}

// 一条待执行 issue = 一张任务卡（创建类带 new feature 标签 + 目标目录；缺陷类挂图）；
// 右侧「立即执行」= 只跑这一条（忽略阈值/间隔，其余排队不动）；「拒绝」= 直接关闭 + refused 标
function boardIssueHtml(i) {
  const isNew = i.kind === 'new-feature';
  const diagram = isNew ? null : state.diagrams.find((d) => d.id === i.diagramId);
  const target = isNew
    ? `<span class="bd-folder">${escapeHtml(i.folder ?? '未分类')}</span>`
    : (diagram ? `<span class="bd-folder" title="${escapeHtml(diagram.title)}">图 · ${escapeHtml(diagram.title)}</span>` : '');
  return `
    <div class="bd-task pending">
      <span class="bd-state">○</span>
      <span class="bd-kind">${isNew ? '✨' : '🐞'}</span>
      ${isNew ? '<span class="bd-tag">new feature</span>' : ''}
      <div class="bd-main">
        <div class="bd-line1">
          <span class="bd-title" title="${escapeHtml(i.title)}">#${i.id} ${escapeHtml(i.title)}</span>
          ${target}
          <span class="bd-time">${new Date(i.createdAt).toLocaleString('zh-CN', { hour12: false })} 提交${(!isNew && i.nodes?.length) ? ` · ${i.nodes.length} 个标签` : ''}</span>
        </div>
        <div class="bd-summary muted">${isNew
          ? '创建类——流水线将读项目代码生成新图，成功出图即自动关闭'
          : '缺陷/改进——流水线将结合项目代码修改对应图，图更新即自动关闭'}</div>
      </div>
      <div class="bd-side">
        <button class="btn small" data-board-run="${i.id}" title="立即执行这一条（忽略阈值与间隔，其余排队不动）">▶ 立即执行</button>
        <button class="btn small danger" data-board-refuse="${i.id}" title="拒绝这条 issue：关闭并打 refused 标，不再进入流水线（可重开恢复）">✕ 拒绝</button>
      </div>
    </div>`;
}

// 一条已拒绝 issue = 一张 refused 卡（closed + refused）。「重开」= 清标回待执行队列
function boardRefusedHtml(i) {
  const isNew = i.kind === 'new-feature';
  const diagram = isNew ? null : state.diagrams.find((d) => d.id === i.diagramId);
  const target = isNew
    ? `<span class="bd-folder">${escapeHtml(i.folder ?? '未分类')}</span>`
    : (diagram ? `<span class="bd-folder" title="${escapeHtml(diagram.title)}">图 · ${escapeHtml(diagram.title)}</span>` : '');
  return `
    <div class="bd-task refused">
      <span class="bd-state">✕</span>
      <span class="bd-kind">${isNew ? '✨' : '🐞'}</span>
      ${isNew ? '<span class="bd-tag">new feature</span>' : ''}
      <span class="bd-tag refuse">refused</span>
      <div class="bd-main">
        <div class="bd-line1">
          <span class="bd-title" title="${escapeHtml(i.title)}">#${i.id} ${escapeHtml(i.title)}</span>
          ${target}
          <span class="bd-time">${new Date(i.updatedAt).toLocaleString('zh-CN', { hour12: false })} 拒绝</span>
        </div>
        <div class="bd-summary muted">已拒绝——不再进入流水线；重开可恢复排队</div>
      </div>
      <div class="bd-side">
        <button class="btn small" data-board-reopen="${i.id}" title="重开这条 issue：清除 refused 标，回到待执行队列">↩ 重开</button>
      </div>
    </div>`;
}

// 项目级队列 sheet：待执行（开启的 issue）→ 已拒绝（closed+refused），按看板范围过滤。
// 不显示运行中——执行进度与排队统一在全局看板（侧栏 ⏳）看
function renderBoardQueue() {
  const proj = board.project;
  const pending = state.issues
    .filter((i) => i.status === 'open' && issueInBoardScope(i, proj))
    .sort((a, b) => a.id - b.id)
    .slice(0, 20);
  const refused = state.issues
    .filter((i) => i.status === 'closed' && i.refused && issueInBoardScope(i, proj))
    .sort((a, b) => b.id - a.id)
    .slice(0, 5);
  const group = (label, html) => `<div class="bd-group"><div class="bd-group-head">${label}</div>${html}</div>`;
  const parts = [];
  parts.push(group(`待执行 · ${pending.length}`, pending.length
    ? pending.map(boardIssueHtml).join('')
    : '<div class="bd-empty">还没有开启的 issue——点目录行「＋」提创建 issue（AI 出图），或在图详情里提缺陷/改进</div>'));
  if (refused.length) parts.push(group(`已拒绝 · ${refused.length}`, refused.map(boardRefusedHtml).join('')));
  $('#board-tasks').innerHTML = parts.join('');
  board.countQueue = `${pending.length} 待执行`;
  applyBoardCount();
}

// 历史 sheet：全局看板 = 全部项目最近 10 次；项目看板 = 本项目（或未分类）最近 10 次。
// 失败记录带「↻ 重新拉起」（重跑该范围；全局执行中禁用）
function renderBoardHistory() {
  if (!board.open) return;
  const scoped = board.global
    ? (state.cicd.history || [])
    : (state.cicd.history || []).filter((h) => (h.project ?? null) === board.project);
  const items = scoped.slice(0, 10);
  $('#board-history-scope').textContent = board.global ? '全部项目，失败的可重新拉起' : '仅本项目，失败的可重新拉起';
  $('#board-history-tasks').innerHTML = items.length
    ? items.map(boardTaskHtml).join('')
    : '<div class="bd-empty">还没有执行记录</div>';
  const okN = items.filter((h) => h.status === 'ok').length;
  board.countHistory = `最近 10 次 · ${okN} 成功 / ${items.length - okN} 失败`;
  wireBoardActions();
}

// 待执行卡的「立即执行」（单条）与历史记录的「重新拉起」（整范围）
function wireBoardActions() {
  const wire = (root) => {
    root.querySelectorAll('[data-board-run]').forEach((btn) => {
      btn.addEventListener('click', () => triggerCicdRun(Number(btn.dataset.boardRun)));
    });
    root.querySelectorAll('[data-board-retry]').forEach((btn) => {
      btn.addEventListener('click', () => triggerCicdRun(null));
    });
    root.querySelectorAll('[data-board-refuse]').forEach((btn) => {
      btn.addEventListener('click', () => refuseBoardIssue(Number(btn.dataset.boardRefuse), true));
    });
    root.querySelectorAll('[data-board-reopen]').forEach((btn) => {
      btn.addEventListener('click', () => refuseBoardIssue(Number(btn.dataset.boardReopen), false));
    });
  };
  wire($('#board-tasks'));
  wire($('#board-history-tasks'));
}

// 执行状态行 + 本项目执行提示：同项目可多 run 并行（用户要求），按钮不按「在跑」禁用——
// 服务端按 issue 认领判定（同一条 issue/同一张图在处理中才 409，提示语说明原因）
function refreshBoardStatus() {
  const c = state.cicd;
  const ownRuns = (c.runs || []).filter((r) => (r.project ?? null) === board.project);
  const own = ownRuns[0] || null;
  const ownCount = ownRuns.length;
  $('#board-busy').classList.toggle('hidden', !ownCount);
  if (board.global || board.project == null) return;
  const st = c.state?.[board.project] || {};
  const openIssues = countProjectOpenIssues(board.project);
  const issueThreshold = Number($('#board-issue-threshold').value) || 5;
  const issueInterval = Number($('#board-issue-interval').value) || 60;
  const lastIso = st.issues?.lastRunAt || null;
  const lastErr = st.issues?.lastStatus === 'error';
  const intervalNext = lastIso ? Date.parse(lastIso) + issueInterval * 60000 : null;
  // 下次最早 = ① 到量 / ② 到时 两条路里先到的一条（或关系，任一满足即触发）
  let dueText;
  if (!openIssues) {
    dueText = '暂无开启 issue，两条路都不会触发';
  } else if (lastErr) {
    dueText = intervalNext != null && intervalNext > c.serverTime
      ? `上次失败，等满间隔到 ${fmtCicdTime(new Date(intervalNext).toISOString())} 自动重试`
      : '上次失败，已等满间隔（等待调度重试）';
  } else if (openIssues >= issueThreshold) {
    dueText = '已到量 ①（等待调度）';
  } else if (intervalNext == null || intervalNext <= c.serverTime) {
    dueText = '已到时 ②（等待调度）';
  } else {
    dueText = `到量 ① 还差 ${issueThreshold - openIssues} 个，或到时 ② ${fmtCicdTime(new Date(intervalNext).toISOString())} —— 先到先触发`;
  }
  $('#board-issue-status').innerHTML =
    `范围内开启 issue：<b>${openIssues}</b>（含创建类）—— ① 到量满 ${issueThreshold} 个 <b>或</b> ② 到时距上次运行满 ${issueInterval} 分钟，满足任一即自动执行<br>` +
    `上次执行：${fmtCicdTime(st.issues?.lastRunAt)}${st.issues?.lastResult ? ` — ${escapeHtml(st.issues.lastResult)}` : ''}<br>` +
    `下次最早：${dueText}` +
    (own ? (() => {
      const sess = ownRuns.reduce((arr, r) => arr.concat(r.sessions || []), []);
      const live = sess.filter((s) => s.status === 'running').length;
      const sessTxt = sess.length ? ` · 会话 ${live}/${sess.length}` : '';
      return `<br><span class="cicd-running">▶ 本项目执行中（${ownCount} 个运行${sessTxt}）——未在处理的 issue 仍可立即执行，进度看侧栏 ⏳ 全局看板</span>`;
    })() : '');
}

// 项目触发设置保存（触发方式 + 执行模型；并发上限是全局设置，在全局看板顶部改）
$('#board-save').addEventListener('click', async () => {
  if (board.project == null) return;
  const body = {
    project: board.project,
    model: $('#board-model').value,
    issueAuto: {
      enabled: $('#board-issue-enabled').checked,
      threshold: Number($('#board-issue-threshold').value) || 5,
      intervalMinutes: Number($('#board-issue-interval').value) || 60,
    },
  };
  const res = await fetch('/api/cicd', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.ok) {
    await loadCicd();
    renderTree();
    refreshBoardStatus();
  } else {
    const data = await res.json().catch(() => ({}));
    alert(data.error || '保存失败');
  }
});

// 全局最大并发数：改动即保存（change 事件——输入框失焦/回车时触发；范围外值由服务端钳制）
$('#board-concurrency').addEventListener('change', async () => {
  const res = await fetch('/api/cicd', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxConcurrentSessions: Number($('#board-concurrency').value) || 2 }),
  });
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    $('#board-concurrency').value = data.saved?.maxConcurrentSessions ?? Number($('#board-concurrency').value);
  } else {
    const data = await res.json().catch(() => ({}));
    alert(data.error || '保存失败');
  }
});

// 手动触发（仅项目看板）：issueId=null 跑整个范围（立即运行/重新拉起）；传 id 只跑该条（立即执行）
async function triggerCicdRun(issueId = null) {
  const body = { project: board.project };
  if (issueId != null) body.issueId = issueId;
  const res = await fetch('/api/cicd/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || `启动失败（HTTP ${res.status}）`);
    return;
  }
  await Promise.all([loadCicd(), loadIssues()]);
  renderBoardAll();
}
$('#board-issue-run').addEventListener('click', triggerCicdRun);
$('#board-uncat-run').addEventListener('click', triggerCicdRun);

// 看板队列直接拒绝 / 重开：拒绝 = PATCH {refused:true}（服务器保证关闭 + 打标）；
// 重开 = PATCH {status:'open'}（服务器自动清 refused 标，回到待执行队列）
async function refuseBoardIssue(id, refuse) {
  const res = await fetch(`/api/issues/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(refuse ? { refused: true } : { status: 'open' }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || '操作失败');
    return;
  }
  await loadIssues();
  renderBoardQueue();
  refreshBoardStatus();
}

// 侧栏头部 ⏳ → 全局执行看板
$('#btn-board-global').addEventListener('click', openGlobalBoard);

// —— 生成任务全局轮询已随「创建图统一走 issue」移除（执行状态看 Issue 看板） ——


// —— 实时上下文（当前目录 / 打开的图 / 目标组件）——
function agentContextInfo() {
  const folder = state.selection.path ?? null;
  const diagram = detailLoadedId != null ? state.diagrams.find((d) => d.id === detailLoadedId) : null;
  const target = issuePanel.target;
  return { folder, diagram, target };
}

function agentContextText(messageText) {
  const { folder, diagram } = agentContextInfo();
  const lines = [`【上下文】当前目录: ${folder ?? '未分类（图集根）'}`];
  if (diagram) lines.push(`当前打开的图: 「${diagram.title}」(id=${diagram.id}, 类型=${diagram.type})`);
  // 消息里点选的组件引用：把 id 翻译成图+标签，让 agent 确切知道指哪个。
  const usedRefs = [...agentState.refs.entries()].filter(([id]) => messageText.includes(`(${id})`));
  if (usedRefs.length) {
    lines.push('【用户点选的引用】消息中形如 @标签(id) 的标记指：');
    for (const [id, ref] of usedRefs) {
      const refDiagram = state.diagrams.find((d) => d.id === ref.diagramId);
      lines.push(`- @${ref.label}(${id})${refDiagram ? ` —— 图「${refDiagram.title}」(id=${refDiagram.id}) 中的元素` : ''}`);
    }
  }
  return `${lines.join('\n')}\n\n`;
}

// 跨项目清引用：agent 会话按当前目录创建（cwd=项目存放路径），其他归属区域的 @ 对
// 新会话无意义。当前选中是「folder」上下文时（命名项目或未分类——两者互为不同区域），
// 摘掉归属不符的 refs 登记和输入框里的 @标签(id) 文本标记；仅「全部图」这种纯全局
// 浏览视图不清草稿。
function pruneAgentRefs() {
  if (!agentState.refs.size) return;
  if (state.selection.scope !== 'folder') return;
  const current = state.selection.path ? state.selection.path.split('/')[0] : null;
  const input = $('#veil-input');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [id, ref] of [...agentState.refs]) {
    const refDiagram = state.diagrams.find((d) => d.id === ref.diagramId);
    const refProject = refDiagram?.folder ? refDiagram.folder.split('/')[0] : null;
    if (refProject === current) continue;
    agentState.refs.delete(id);
    input.value = input.value.replace(new RegExp(`@${esc(ref.label)}\\(${esc(id)}\\) ?`), '');
  }
}

function renderAgentContext() {
  pruneAgentRefs();
  const { folder, diagram } = agentContextInfo();
  const chips = [
    `<span class="ctx-chip dim">📂 ${escapeHtml(folder ?? '未分类')}</span>`,
    diagram ? `<span class="ctx-chip">🖼 ${escapeHtml(diagram.title)}</span>` : '',
  ];
  $('#veil-context').innerHTML = chips.filter(Boolean).join('');
  // 虚窗开着时切目录（穿透点击目录树）：归属区变了就做区域检查（不挂接新区历史会话，见 syncAgentArea）
  syncAgentArea();
}

// —— 回复长廊：真 3D 透视，最新在最前，旧的沿 Z 轴退入屏幕深处 ——
const CORRIDOR_KEEP = 5;
const DEPTH_STEP = 380; // 每一级退入的 Z 深度（px），透视下自动缩小
const CORRIDOR_FADE = [1, 0.55, 0.3, 0.15, 0.07];
let corridorShift = 0; // 派生整格位置（物理帧里由 round(corridorPos) 实时同步；renderCorridor 等静止布局消费）

let turnUid = 0;

// 轻量 Markdown 渲染（agent 回复）：先整体转义防注入，再按行解析常见语法子集——
// 围栏代码块 / 标题 / 有序无序列表 / 引用 / 分割线 / 表格 / 行内代码加粗斜体链接。
// 标题降两级（#→h3）避免在 13px 正文里突然撑大。
function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\s][^*]*)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
// GFM 表格行拆列：只认以 | 开头的行（模型输出的通行写法），去首尾管道后按 | 拆
function mdTableRow(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
// 分隔行 → 每列对齐方式（:--- 左 / ---: 右 / :--: 中）；任一列不是该形状则整行不算分隔行
function mdTableAlign(line) {
  const cells = mdTableRow(line);
  if (!cells || !cells.length) return null;
  const aligns = [];
  for (const c of cells) {
    const m = c.match(/^(:?)(-+)(:?)$/);
    if (!m) return null;
    aligns.push(m[1] && m[3] ? 'center' : m[3] ? 'right' : 'left');
  }
  return aligns;
}
function renderMarkdown(src) {
  const esc = escapeHtml;
  const lines = String(src || '').split(/\r?\n/);
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let listTag = null;
  let listBuf = [];
  let paraBuf = [];
  const flushPara = () => {
    if (paraBuf.length) out.push(`<p>${mdInline(esc(paraBuf.join('\n')))}</p>`);
    paraBuf = [];
  };
  const flushList = () => {
    if (listBuf.length) out.push(`<${listTag}>${listBuf.map((li) => `<li>${mdInline(esc(li))}</li>`).join('')}</${listTag}>`);
    listBuf = [];
    listTag = null;
  };
  const flushAll = () => { flushPara(); flushList(); };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushAll();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    // 表格 = 表头行 + 紧随的分隔行 + 任意多正文行（空行/非 | 行终止）；
    // 列数以表头为准，正文行多列截断、少列补空，避免模型输出参差时错位
    const tHead = mdTableRow(line);
    if (tHead && i + 1 < lines.length) {
      const tAlign = mdTableAlign(lines[i + 1].replace(/\s+$/, ''));
      if (tAlign) {
        flushAll();
        const rows = [];
        let j = i + 2;
        while (j < lines.length && mdTableRow(lines[j])) { rows.push(mdTableRow(lines[j])); j++; }
        const cell = (txt, tag, align) =>
          `<${tag}${align === 'left' ? '' : ` style="text-align:${align}"`}>${mdInline(esc(txt))}</${tag}>`;
        const rowHtml = (cells, tag) =>
          `<tr>${tHead.map((_, k) => cell(cells[k] ?? '', tag, tAlign[k] || 'left')).join('')}</tr>`;
        out.push(
          `<div class="md-table"><table><thead>${rowHtml(tHead, 'th')}</thead>` +
          (rows.length ? `<tbody>${rows.map((r) => rowHtml(r, 'td')).join('')}</tbody>` : '') +
          `</table></div>`
        );
        i = j - 1;
        continue;
      }
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.、)]\s+(.+)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (h) {
      flushAll();
      const level = Math.min(h[1].length + 2, 5);
      out.push(`<h${level}>${mdInline(esc(h[2]))}</h${level}>`);
    } else if (ul) {
      flushPara();
      if (listTag && listTag !== 'ul') flushList();
      listTag = 'ul';
      listBuf.push(ul[1]);
    } else if (ol) {
      flushPara();
      if (listTag && listTag !== 'ol') flushList();
      listTag = 'ol';
      listBuf.push(ol[1]);
    } else if (quote) {
      flushAll();
      out.push(`<blockquote>${mdInline(esc(quote[1]))}</blockquote>`);
    } else if (/^(---+|\*\*\*+|___+)$/.test(line)) {
      flushAll();
      out.push('<hr>');
    } else if (!line.trim()) {
      flushAll();
    } else {
      flushList();
      paraBuf.push(line);
    }
  }
  if (inCode && codeBuf.length) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('') || '<p></p>';
}

// 长廊姿态：固定层距（-40/级）+ 透视退深；lift = 阶梯布局追加的视觉上推量（px），
// translateY 发生在退深之前会被透视缩放 k 吃掉一截，故除以 k 还原成 CSS 像素
function corridorPerspective() {
  return document.body.classList.contains('agent-exclusive') ? 1100 : 850;
}
function corridorPose(distance, lift = 0) {
  const p = corridorPerspective();
  const k = p / (p + distance * DEPTH_STEP);
  return `translateX(-50%) translateY(${(distance * -40 - lift / k).toFixed(1)}px) translateZ(${distance * -DEPTH_STEP}px)`;
}

// 内容按 key 增量渲染：滑行只改姿态不重写 innerHTML——
// 每次把 ≤5 张卡的 Markdown 全部重新解析+排版是掉帧主因。
// 键直存元素属性（uid + 文本长度，未完成为 -1）：物理帧每卡每帧都做这个检查，
// 原 dataset 字符串反射（属性 getter + 字符串拼接比较）是纯开销。
function ensureTurnContent(el, turn) {
  const lenKey = turn.done ? turn.a.length : -1;
  if (el.__ckUid === turn.uid && el.__ckLen === lenKey) return;
  el.__ckUid = turn.uid;
  el.__ckLen = lenKey;
  el.querySelector('.turn-q').textContent = turn.q;
  const answerEl = el.querySelector('.turn-a');
  answerEl.innerHTML = turn.done
    ? renderMarkdown(turn.a || '（本轮无文本回复——见工具执行记录）')
    : '<span class="busy-dots">思考与执行中</span>';
  // 内容刚写入、布局反正要重算：顺手预热滚动尺寸缓存，把唯一的强制布局
  // 挪出滑行帧（之后 corridorFrontCheck/veilWheel 读缓存即可）
  turnScrollInfo(el);
}

// —— 正文滚动尺寸缓存 ——
// scrollHeight/clientHeight 的读取会强制同步布局；corridorFrontCheck 跨格（每次翻卡
// 必经）与 veilWheel 静止滚正文（每个滚轮事件）都要读，而滑行帧刚写过样式、布局是
// 脏的——原实现每跨一格就全走廊强制 reflow 一次（翻卡顿挫的主因之一）。
// 缓存键 = 内容版本（__ckUid/__ckLen，ensureTurnContent 写入后立刻预热）+ 几何代
// （corridorMetricsGen：窗口 resize / 独占切换改变卡高时递增）。
let corridorMetricsGen = 0;
function turnScrollInfo(el) {
  let s = el.__scrollInfo;
  if (!s || s.uid !== el.__ckUid || s.len !== el.__ckLen
    || s.gen !== corridorMetricsGen || !s.scroller.isConnected) {
    const scroller = el.querySelector('.turn-a');
    s = {
      uid: el.__ckUid, len: el.__ckLen, gen: corridorMetricsGen, scroller,
      scrollH: scroller.scrollHeight, clientH: scroller.clientHeight,
    };
    el.__scrollInfo = s;
  }
  return s;
}

function styleTurnItem(el, turn, distance, lift = 0) {
  el.dataset.depth = String(distance);
  el.dataset.lift = String(lift);
  el.__lift = lift;
  const tf = corridorPose(distance, lift);
  el.style.transform = tf;
  el.__tf = tf; // 姿态写缓存（物理帧按缓存跳过未变化的 style 写）
  const op = String(CORRIDOR_FADE[Math.min(distance, CORRIDOR_FADE.length - 1)]);
  el.style.opacity = op;
  el.__op = op;
  el.style.visibility = '';
  el.style.filter = distance ? `blur(${distance * 1.9}px)` : 'none';
  el.__blur = -1; // 静止布局的模糊未按 1px 量化，置 -1 强制下一物理帧按需重写
  el.style.zIndex = String(30 - distance);
  el.__zi = 30 - distance;
  el.classList.remove('passed'); // 从身后调回：恢复指针与背景采样
  el.__passed = false;
  el.classList.toggle('error', Boolean(turn.error));
  el.__isErr = Boolean(turn.error);
  if (!el.__defer) ensureTurnContent(el, turn); // 占位卡的内容由分帧渲染队列供帧
}
// —— 长廊元素注册表：turnUid → 卡片元素 ——
// 物理帧（60fps）每帧要按 uid 取卡、清理离场卡；原先每帧 querySelector × 卡数 +
// [...box.children] 全量扫描是滑行掉帧主源之一。注册表让取卡/清场全部变 O(1) Map
// 读写；与 DOM 同步的口径只有一个——createTurnEl 登记、renderCorridor/物理帧移除除名。
// #veil-corridor 是 index.html 里的静态节点，缓存一次不再每帧 $() 查询。
let corridorBoxEl = null;
const corridorBox = () => corridorBoxEl ?? (corridorBoxEl = document.querySelector('#veil-corridor'));
const corridorElMap = new Map();

function createTurnEl(turn, box, { entry = false } = {}) {
  const el = document.createElement('div');
  el.dataset.turnId = String(turn.uid);
  el.dataset.depth = '0';
  el.dataset.lift = '0';
  el.__lift = 0;
  el.className = 'turn-item';
  el.innerHTML = '<div class="turn-q"></div><div class="turn-a"></div><button class="turn-copy" title="复制此回复">⧉ 复制</button>';
  el.style.opacity = '0';
  el.__op = '0';
  if (entry) { // renderCorridor 的新卡进场起点（物理帧内补建的卡无进场动画，下一帧直接落位）
    el.style.transform = 'translateX(-50%) translateY(30px) translateZ(120px)';
    el.style.filter = 'blur(6px)';
    el.__blur = -1;
  }
  box.appendChild(el);
  corridorElMap.set(turn.uid, el);
  return el;
}

// —— 分帧预渲染队列：切会话/回读历史时 ≤5 张卡的长 Markdown 同步全量解析会阻塞
// 主线程 50~150ms（「切换卡」的主源之一）。renderCorridor 只同步渲染「当前要看的
// 卡」，其余挂 __defer 占位排队，每帧补渲染一张并静默重摆阶梯（<2ms）——物理帧与
// 静止布局遇到 __defer 卡都跳过内容渲染，由这里统一供帧。
let turnRenderQueue = [];
let turnRenderRaf = 0;
function turnContentStale(el, turn) {
  const lenKey = turn.done ? turn.a.length : -1;
  return el.__ckUid !== turn.uid || el.__ckLen !== lenKey;
}
function scheduleTurnRenderPump() {
  if (turnRenderRaf || !turnRenderQueue.length) return;
  turnRenderRaf = requestAnimationFrame(() => {
    turnRenderRaf = 0;
    pumpTurnRenderQueue();
  });
}
function pumpTurnRenderQueue() {
  while (turnRenderQueue.length) {
    const item = turnRenderQueue.shift();
    if (corridorElMap.get(item.turn.uid) !== item.el) continue; // 卡片已被替换：丢弃
    item.el.__defer = false;
    ensureTurnContent(item.el, item.turn);
    layoutCorridorSteps(); // 内容高度定型：静默重摆阶梯（FLIP 从当前姿态滑到新姿态）
    break; // 每帧只渲染一张，把大块解析摊开
  }
  scheduleTurnRenderPump();
}

function renderCorridor() {
  const box = corridorBox();
  const visible = agentTurns.slice(-CORRIDOR_KEEP);
  const freshEls = [];
  const seen = new Set();
  const pending = []; // 本轮可见卡 (el, turn)，循环后统一决定渲染顺序
  let frontIndex = -1; // 「当前要看的卡」在 pending 里的下标（distance 最小）
  let frontDist = Infinity;
  for (let index = 0; index < visible.length; index += 1) {
    const turn = visible[index];
    const realDistance = visible.length - 1 - index; // 0 = 最新
    const distance = realDistance - corridorShift; // 导航偏移后的有效深度
    seen.add(turn.uid);
    let el = corridorElMap.get(turn.uid);
    if (el && !el.isConnected) { el.remove(); corridorElMap.delete(turn.uid); el = undefined; }
    if (distance < 0) {
      // 已被调到「身后」的回复：静止布局直接隐藏（飞行过程由物理帧连续驱动，
      // 卡片是划过头顶淡出的，不再需要这里的离场摆位）。passed 摘掉指针与
      // 背景采样——隐形卡片若仍拦截指针，会盖住聚焦卡片同位置的复制按钮
      if (el) {
        el.classList.add('passed');
        el.__passed = true;
        el.style.opacity = '0';
        el.__op = '0';
        el.style.visibility = 'hidden';
      }
      continue;
    }
    if (!el) {
      const fresh = createTurnEl(turn, box, { entry: true });
      fresh.dataset.depth = String(distance);
      freshEls.push(fresh);
      el = fresh;
    }
    el.dataset.depth = String(distance); // 终态由 layoutCorridorSteps 统一落位
    if (distance < frontDist) { frontDist = distance; frontIndex = pending.length; }
    pending.push({ el, turn });
  }
  // 离场清理：注册表即真实 DOM 卡片集——已不在 visible 里的旧卡整卡移除
  //（翻过头的 passed 残影仍在 visible 内，保留给物理帧继续驱动淡出）
  for (const [uid, el] of corridorElMap) {
    if (!seen.has(uid)) { el.remove(); corridorElMap.delete(uid); }
  }
  // 前卡立即渲染（用户要看的就是它），其余未渲染的排队逐帧补——先渲染再测量，
  // 阶梯布局量的是内容定型后的真实高度（占位壳的卡渲染完会重摆）
  for (let i = 0; i < pending.length; i += 1) {
    const { el, turn } = pending[i];
    if (i === frontIndex) {
      el.__defer = false;
      ensureTurnContent(el, turn);
    } else if (turnContentStale(el, turn) && !el.__defer) {
      el.__defer = true;
      turnRenderQueue.push({ el, turn });
    } else {
      el.__defer = false;
      ensureTurnContent(el, turn); // 已渲染过的幂等调用（流式完成等内容变化在此重排）
    }
  }
  layoutCorridorSteps(freshEls);
  scheduleTurnRenderPump();
}

// 阶梯布局：卡片底部锚定 + 高度不一，固定的 -40px/级挡不住高度差——短卡整张叠进
// 长卡正文，后一张卡的提问行（turn-q）就压在上一条回复的文字上。这里按各卡的实际
// 视觉顶边链式上推：每张卡的「提问行条带」（卡顶 padding+turn-q ≈25px）必须落在
// 前一张卡顶边之上，互不压字。测量走 FLIP 手法（冻结过渡→摆基础终态→同步测量→
// 回到过渡起点）：同步块内不发生绘制不会闪，随后从起点平滑滑向含阶梯的终态——
// 切换滑翔/新卡进场动画路径都保持原样。
const CORRIDOR_STRIP_STEP = 24; // 相邻两卡顶边的最小视觉间距（≥ 提问行帽高+余量）
let corridorApplyGen = 0;
function layoutCorridorSteps(freshEls = []) {
  const box = corridorBox();
  const cards = [...box.children]
    .filter((el) => el.classList.contains('turn-item') && !el.classList.contains('passed'))
    .sort((a, b) => Number(a.dataset.depth) - Number(b.dataset.depth));
  const gen = ++corridorApplyGen;
  if (!cards.length) return;
  const starts = new Map();
  for (const el of cards) {
    starts.set(el, el.style.transform);
    el.style.transition = 'none';
    el.style.transform = corridorPose(Number(el.dataset.depth));
  }
  const tops = new Map(cards.map((el) => [el, el.getBoundingClientRect().top]));
  const lifts = new Map();
  let prevTop = Infinity;
  for (const el of cards) {
    const ceiling = prevTop - CORRIDOR_STRIP_STEP;
    const natural = tops.get(el);
    lifts.set(el, natural > ceiling ? natural - ceiling : 0);
    prevTop = Math.min(natural, ceiling);
  }
  const freshSet = new Set(freshEls);
  const turnOf = (el) => agentTurns.find((t) => String(t.uid) === el.dataset.turnId);
  // 测量（getBoundingClientRect）会强制同步样式重算，把「上次 computed transform」钉在
  // 冻结时的基础终态上——不摆回来的话，随后的滑翔会从基础位置起步，0.5s 过渡被跳掉。
  // 这里全部先钉回过渡起点、一次批量 flush，再恢复过渡写终态：起点→终态走完整滑翔
  for (const el of cards) {
    el.style.transition = 'none';
    el.style.transform = starts.get(el);
  }
  void box.offsetHeight; // 一次批量样式重算，把 computed 钉回各卡起点
  for (const el of cards) el.style.transition = '';
  for (const el of cards) {
    if (freshSet.has(el)) continue; // 新卡保持进场起点，下一帧再滑向终态
    const turn = turnOf(el);
    if (turn) styleTurnItem(el, turn, Number(el.dataset.depth), lifts.get(el) || 0);
  }
  if (!freshSet.size) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (gen !== corridorApplyGen) return; // 期间又切了卡，按最新一轮为准
    for (const el of freshEls) {
      if (!el.isConnected || el.classList.contains('passed')) continue;
      const turn = turnOf(el);
      if (turn) styleTurnItem(el, turn, Number(el.dataset.depth), lifts.get(el) || 0);
    }
  }));
}

// 长廊点击（事件委托）：复制按钮拷贝该回复；点历史幽灵卡片把它调到最前。
$('#veil-corridor').addEventListener('click', async (event) => {
  const card = event.target.closest('.turn-item');
  if (!card) return;
  const uid = Number(card.dataset.turnId);
  if (event.target.closest('.turn-copy')) {
    const turn = agentTurns.find((t) => t.uid === uid);
    if (!turn?.a) return;
    try {
      await navigator.clipboard.writeText(turn.a);
    } catch {
      const box = document.createElement('textarea');
      box.value = turn.a;
      document.body.appendChild(box);
      box.select();
      document.execCommand('copy');
      box.remove();
    }
    setTicker('<span class="tick-done">⧉ 已复制该回复</span>');
    return;
  }
  // 幽灵卡片可能被前面的卡片部分遮挡，点其露出部分 = 调到最前（复制按钮随之完全可见）
  const index = agentTurns.findIndex((t) => t.uid === uid);
  const target = index >= 0 ? agentTurns.length - 1 - index : 0;
  if (target > corridorShift) corridorGoto(target);
});

// —— 长廊物理滑动（用户定稿设计）：连续位置 + 速度积分器，无离散判断 ——
// · 滚轮冲量→速度；减速 = 基础摩擦（有初减速度，v→0 附近也有制动力，有限时间停稳不拖尾）
//   + 速度正比阻尼；速度上限 CORRIDOR_VMAX——一次瞬时快滑最多滑约一格，物理上切不过两张；
// · 栈两端弹簧限位：越界被拉回（弹簧自带阻尼，回弹不振荡）——到头不再震；
// · 停稳后 0.18s 固定时长 cubic ease-out 快速归位到最近整格（停在两卡中间也干脆弹回
//   最近卡的显示正中，无指数拖尾），落回阶梯静止布局（layoutCorridorSteps）；
// · 滑行期间逐帧直接驱动卡片姿态（transition 关掉，纯合成器属性），
//   卡片连续划过、跨多格无虚空；↑/↓ 键与点击调前走 corridorGoto 的 eased 滑行。
let corridorPos = 0; // 连续位置（0=最新在前，向历史深处递增；单位=格）
let corridorVel = 0; // 速度（格/s）
let corridorRaf = 0; // 物理帧句柄（0=静止，静止时不占 rAF）
let corridorLastTs = 0;
let corridorSnap = false; // 停稳后的吸附阶段
let corridorArriveDir = 0; // 停稳时的到达方向（吸附偏置：0.4 格即换挡，强甩仍封一格）
let corridorSnapTarget = null; // goto 指定的吸附目标（null=最近整格）
let corridorSnapFrom = 0; // 最近格吸附的起点位置（停稳瞬间一次记定）
let corridorSnapT0 = 0; // 最近格吸附的起始时间戳（ms）
let corridorSnapAuto = 0; // 最近格吸附的目标格（起点一次算定，归位途中不重算）
const CORRIDOR_SNAP_T = 0.18; // 停稳后归位时长（s）——固定节奏 cubic ease-out，两卡中间也干脆弹回
const CORRIDOR_VMAX = 1.8; // 速度上限（格/s）——瞬时甩满打满算滑不过一格
const CORRIDOR_DAMP = 1.0; // 速度正比阻尼（1/s）——曲线斜率，调 FRICTION 时保持不动
const CORRIDOR_FRICTION = 4.68; // 基础减速度（格/s²，v=0 处初制动）——1.8→3.6→4.68 两轮加大：低速尾段果断刹停不拖蹭，有限时间停稳；单次甩满滑行 ~0.28 格
const CORRIDOR_EDGE_K = 30; // 栈端弹簧刚度（1/s²）
const CORRIDOR_EDGE_C = 10; // 栈端弹簧阻尼（1/s）
const CORRIDOR_INPUT_GAIN = 1 / 70; // 滚轮 px → 速度冲量（格/s）

function corridorMaxPos() {
  return Math.max(0, agentTurns.length - 1);
}

function corridorFade(d) {
  const i = Math.max(0, Math.min(CORRIDOR_FADE.length - 1.001, d));
  const a = Math.floor(i);
  return CORRIDOR_FADE[a] + (CORRIDOR_FADE[a + 1] - CORRIDOR_FADE[a]) * (i - a);
}

// 物理帧姿态：按连续深度直接驱动窗口内卡片（不测量、无过渡，纯合成器友好属性）。
// 性能要点（滑行 60fps 热路径）：卡片一律走 corridorElMap 注册表 O(1) 取用（原每帧
// 每卡 querySelector）；style 写入先比缓存再赋值——transform/opacity 滑行中本就逐帧
// 变，但 blur/zIndex/error 类是量化档位，不变就不碰样式（避免白白触发样式重算/重光栅）。
function corridorPoseFrame() {
  const box = corridorBox();
  if (!box) return;
  const n = agentTurns.length;
  if (!n) return;
  const frontIdx = n - 1 - corridorPos;
  // 窗口向后多含一张（+1）：把「刚翻过头的卡」留在 DOM/注册表里——翻回程时复用
  // 同一元素与已光栅图层，不再中途重建（新建元素=冷图层，飞入瞬间强制光栅是切换
  // 顿挫源之一；前中后三张卡常驻即此意）
  const hi = Math.min(n - 1, Math.ceil(frontIdx) + 1);
  const lo = Math.max(0, Math.floor(frontIdx) - 4);
  const keep = new Set();
  for (let i = hi; i >= lo; i -= 1) {
    const turn = agentTurns[i];
    const d = (n - 1 - i) - corridorPos;
    let el = corridorElMap.get(turn.uid);
    if (el && !el.isConnected) { el.remove(); corridorElMap.delete(turn.uid); el = undefined; }
    if (!el) {
      el = createTurnEl(turn, box);
    }
    if (!el.__defer) ensureTurnContent(el, turn); // 占位卡交给分帧渲染队列，滑行帧不强制渲染
    keep.add(turn.uid);
    if (turn.error !== el.__isErr) {
      el.classList.toggle('error', turn.error);
      el.__isErr = turn.error;
    }
    if (d < -0.35) { // 划过头顶的卡：隐形不拦指针
      if (!el.__passed) {
        el.__passed = true;
        el.classList.add('passed');
        el.style.opacity = '0';
        el.__op = '0';
        el.style.visibility = 'hidden';
      }
      continue;
    }
    if (el.__passed) {
      el.__passed = false;
      el.classList.remove('passed');
      el.style.visibility = '';
    }
    const tf = corridorPose(d, el.__lift || 0);
    if (el.__tf !== tf) {
      el.style.transform = tf;
      el.__tf = tf;
    }
    const op = corridorFade(d).toFixed(3);
    if (el.__op !== op) {
      el.style.opacity = op;
      el.__op = op;
    }
    const blurPx = d > 0.05 ? Math.round(d * 1.9) : 0; // 1px 量化：模糊档位只在跨格时变，滑行不逐帧重光栅
    if (el.__blur !== blurPx) {
      el.style.filter = blurPx ? `blur(${blurPx}px)` : 'none';
      el.__blur = blurPx;
    }
    const zi = 30 - Math.round(d);
    if (el.__zi !== zi) {
      el.style.zIndex = String(zi);
      el.__zi = zi;
    }
  }
  // 离场清理：注册表即真实卡片集，窗口外的卡整卡移除（Map 迭代中 delete 安全）
  for (const [uid, el] of corridorElMap) {
    if (!keep.has(uid)) { el.remove(); corridorElMap.delete(uid); }
  }
}

// 前卡跨越整格：同步派生位置 + 阅读连续性（切旧卡从底部读、切新卡从顶部读）。
// scrollHeight 走缓存——滑行中读它等于强制 reflow（见 turnScrollInfo）
function corridorFrontCheck() {
  const idx = Math.max(0, Math.min(corridorMaxPos(), Math.round(corridorPos)));
  if (idx === corridorShift) return;
  const going = idx > corridorShift ? 1 : -1;
  corridorShift = idx;
  const turn = agentTurns[agentTurns.length - 1 - idx];
  const el = turn && corridorElMap.get(turn.uid);
  const info = el && turnScrollInfo(el);
  if (info) info.scroller.scrollTop = going > 0 ? info.scrollH : 0;
}

function corridorPhysics(ts) {
  const dt = Math.min(0.05, corridorLastTs ? (ts - corridorLastTs) / 1000 : 0.016);
  corridorLastTs = ts;
  const maxPos = corridorMaxPos();
  if (corridorSnap) {
    if (corridorSnapTarget != null) {
      // goto（↑/↓ 键/点卡调前）：长距离 eased 滑行，节奏不变
      const target = corridorSnapTarget;
      corridorPos += (target - corridorPos) * (1 - Math.exp(-dt * 16));
      corridorFrontCheck();
      if (Math.abs(target - corridorPos) < 0.004) {
        corridorPos = target;
        corridorVel = 0;
        corridorFrontCheck();
        corridorRest();
        return;
      }
    } else {
      // 停稳后归位：固定时长 cubic ease-out 直落最近整格——指数逼近的尾巴会让停在
      // 两卡中间的卡片拖着慢慢蹭，固定节奏无论停在哪都快速弹回最近卡的显示正中位
      const p = Math.min(1, (ts - corridorSnapT0) / (CORRIDOR_SNAP_T * 1000));
      corridorPos = corridorSnapFrom + (corridorSnapAuto - corridorSnapFrom) * (1 - (1 - p) ** 3);
      corridorFrontCheck();
      if (p >= 1) {
        corridorPos = corridorSnapAuto;
        corridorVel = 0;
        corridorFrontCheck();
        corridorRest();
        return;
      }
    }
  } else {
    if (corridorPos < 0 || corridorPos > maxPos) {
      // 栈端弹簧：越界拉回（自带阻尼）；越界段不叠加常规摩擦，防小越位卡死
      const pull = corridorPos < 0 ? -corridorPos : maxPos - corridorPos;
      corridorVel += pull * CORRIDOR_EDGE_K * dt - corridorVel * CORRIDOR_EDGE_C * dt;
    } else {
      // 摩擦：基础 + 速度正比，夹住不反向（基础项保证 v→0 也有初减速度）
      const slow = (CORRIDOR_FRICTION + CORRIDOR_DAMP * Math.abs(corridorVel)) * dt;
      if (Math.abs(corridorVel) <= slow) {
        if (corridorVel) corridorArriveDir = corridorVel > 0 ? 1 : -1; // 归零前记下到达方向（吸附偏置用）
        corridorVel = 0;
      } else {
        corridorVel -= Math.sign(corridorVel) * slow;
      }
    }
    corridorPos += corridorVel * dt;
    if (corridorVel === 0) {
      corridorSnap = true;
      corridorSnapFrom = corridorPos;
      corridorSnapT0 = ts;
      corridorSnapAuto = Math.max(0, Math.min(maxPos, Math.round(corridorPos + corridorArriveDir * 0.1))); // 到达方向偏置：0.4 格即换挡，强甩仍封一格
    }
    corridorFrontCheck();
  }
  corridorPoseFrame();
  corridorRaf = requestAnimationFrame(corridorPhysics);
}

function corridorEnsureLoop() {
  if (corridorRaf) return;
  corridorBox()?.classList.add('corridor-physics');
  corridorLastTs = 0;
  corridorRaf = requestAnimationFrame(corridorPhysics);
}

// 停稳落位：摘物理类恢复卡片过渡，按静止布局重摆（阶梯 lift）；数据不变时只是姿态复写。
// 落位过渡（0.5s）期间加 corridor-settling：卡片还在动，backdrop 采样先不恢复（见
// style.css），过渡结束后再淡回霜面——「运动=无霜，静止=有霜」
let corridorSettleTimer = 0;
function corridorBeginSettle() {
  const box = corridorBox();
  if (!box) return;
  box.classList.add('corridor-settling');
  clearTimeout(corridorSettleTimer);
  corridorSettleTimer = setTimeout(() => {
    corridorSettleTimer = 0;
    corridorBox()?.classList.remove('corridor-settling');
  }, 520);
}
function corridorRest() {
  corridorRaf = 0;
  corridorLastTs = 0;
  corridorSnap = false;
  corridorSnapTarget = null;
  corridorBox()?.classList.remove('corridor-physics');
  corridorBeginSettle();
  renderCorridor();
}

// 数据变化硬复位（新回复进场/切会话/回读历史）：位置直接设定，无动画
function corridorReset(posInt = 0) {
  if (corridorRaf) cancelAnimationFrame(corridorRaf);
  corridorRaf = 0;
  corridorSnap = false;
  corridorSnapTarget = null;
  corridorVel = 0;
  corridorPos = Math.max(0, Math.min(corridorMaxPos(), posInt));
  corridorShift = Math.round(corridorPos);
  corridorBox()?.classList.remove('corridor-physics');
  corridorBeginSettle();
  renderCorridor();
}

// ↑/↓ 键与点击调前：eased 滑到目标格（中途卡片连续划过，无虚空）
function corridorGoto(target) {
  const t = Math.max(0, Math.min(corridorMaxPos(), Math.round(target)));
  if (corridorRaf && corridorSnapTarget === t) return;
  corridorSnapTarget = t;
  corridorSnap = true;
  corridorEnsureLoop();
}

// 虚窗开启时，滚轮/上下键一律作用于 agent 对话（全页面，含图表 iframe）。
window.__archifyVeilActive = () => veilOpen();
function veilWheel(deltaY) {
  if (!veilOpen()) return false;
  if (!agentTurns.length) return true;
  // 静止时先滚当前回复的正文，到边界后滚轮才转为走廊动力；
  // 滑行中（速度仍显著/正在 goto）一律喂速度——用户在翻卡，别中途改滚文字
  const moving = Math.abs(corridorVel) > 0.25 || corridorSnapTarget != null;
  if (!moving) {
    const turn = agentTurns[agentTurns.length - 1 - corridorShift];
    const el = turn && corridorElMap.get(turn.uid);
    const info = el && turnScrollInfo(el);
    const scroller = info && info.scroller;
    if (scroller) {
      const atTop = scroller.scrollTop <= 0;
      const atBottom = scroller.scrollTop + info.clientH >= info.scrollH - 1;
      const scrollable = info.scrollH > info.clientH + 1;
      if (scrollable && !(deltaY < 0 ? atTop : atBottom)) {
        scroller.scrollTop += deltaY;
        return true;
      }
    }
  }
  // 冲量 → 速度（上限封顶）；基础摩擦+正比阻尼负责刹停，瞬时快滑跨不过一格
  corridorSnap = false;
  corridorSnapTarget = null;
  corridorVel = Math.max(-CORRIDOR_VMAX, Math.min(CORRIDOR_VMAX, corridorVel - deltaY * CORRIDOR_INPUT_GAIN));
  corridorEnsureLoop();
  return true;
}
window.__archifyVeilWheel = veilWheel;

document.addEventListener('wheel', (event) => {
  if (!veilOpen()) return;
  event.preventDefault();
  event.stopPropagation();
  // 光标在历史会话栏上：滚轮上下一律归会话列表（到边界也不切回复、不滚背景页）
  if (event.target.closest?.('#veil-sessions')) {
    const list = document.querySelector('#vs-list');
    if (list) list.scrollTop += event.deltaY;
    return;
  }
  veilWheel(event.deltaY);
}, { capture: true, passive: false });

// —— 工具状态细流 ——
function setTicker(html, pulsing = false) {
  const ticker = $('#veil-ticker');
  ticker.innerHTML = html;
  ticker.classList.toggle('pulse', pulsing);
}

// —— 多会话管理（独占模式会话栏；消息在服务端后台执行，切走/关窗都不中断） ——
let agentSessionsRefreshing = false;

async function refreshAgentSessions() {
  if (agentSessionsRefreshing) return;
  agentSessionsRefreshing = true;
  try {
    const areaAtCall = agentAreaKey(state.selection.path ?? null);
    let data = null;
    try {
      data = await fetch(`/api/agent/sessions?folder=${encodeURIComponent(state.selection.path ?? '')}`).then((r) => r.json());
    } catch { return; }
    // 快速切目录时丢弃过期响应；归属区变了也让下一次按新区重拉
    if (agentAreaKey(state.selection.path ?? null) !== areaAtCall) return;
    const prevRunning = new Map(agentState.sessions.map((s) => [s.id, s.running]));
    agentState.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    agentState.serveUp = Boolean(data?.serveUp);
    renderSessionsPanel();
    // busy→idle 迁移 = 一轮后台执行结束：回读历史拿最终回复
    for (const s of agentState.sessions) {
      if (prevRunning.get(s.id) && !s.running) await onAgentRunDone(s);
    }
    // 兜底：当前会话已不在执行、但走廊末尾还挂着「思考中」的轮次（完成瞬间列表被
    // serveUp:false 清空过、迁移检测错过）——直接回读历史补齐
    const cur = agentState.sessions.find((s) => s.id === agentState.sessionId);
    if (cur && !cur.running && agentTurns.length && !agentTurns[agentTurns.length - 1].done) {
      await onAgentRunDone(cur);
    }
  } finally {
    agentSessionsRefreshing = false;
  }
}

// 服务端 turn → 长廊 turn：pending（执行中）保持 done:false 显示「思考与执行中」；
// 后端各完成分支都有兜底文案，done:true 而 a 空不再是常态，占位符只是终极兜底
const apiTurnToCorridor = (t) => ({ uid: ++turnUid, q: t.q, a: t.a, done: !t.pending, error: Boolean(t.error) });
// 会话已不在执行却仍挂着 pending 轮（服务重启窗口、执行跟踪丢失等）：
// 落成中断错误卡——别让走廊显示永远的「思考与执行中」或「（本轮无文本回复）」占位符
function finalizeStalledTurn(turns, sessionId) {
  if (sessionIsRunning(sessionId)) return;
  const last = turns[turns.length - 1];
  if (last && !last.done) {
    last.done = true;
    last.error = true;
    last.a = last.a || '（本轮执行中断——服务可能重启过，请重发这个问题）';
  }
}

async function onAgentRunDone(session) {
  const data = await fetch(`/api/agent/session/${session.id}/messages`).then((r) => r.json()).catch(() => null);
  if (!data || !Array.isArray(data.turns)) return;
  const turns = data.turns.map(apiTurnToCorridor);
  finalizeStalledTurn(turns, session.id);
  agentState.turnsBySession.set(session.id, turns);
  if (session.id === agentState.sessionId) {
    agentTurns = turns;
    corridorReset(0);

    setTicker('<span class="tick-done">✓ 完成</span>');
    // agent 可能动了图集 / issue，刷新数据
    await Promise.all([loadDiagrams(), loadIssues()]);
  } else {
    setTicker(`<span class="tick-done">✓ 后台会话「${escapeHtml(sessionLabel(session).slice(0, 24))}」已完成</span>`);
  }
  renderSessionsPanel();
}

async function switchAgentSession(id, { silent = false } = {}) {
  if (!id || id === agentState.sessionId) return;
  agentState.sessionId = id;
  // 流水线会话（Issue 流水线自动执行）只读回放：输入框换提示文案，agentSend 拦截发送
  agentState.sessionPipeline = Boolean(agentState.sessions.find((s) => s.id === id)?.pipeline);
  updateVeilComposer();
  agentTurns = agentState.turnsBySession.get(id) || [];
  corridorReset(0);
  renderSessionsPanel();
  if (!silent) {
    const target = agentState.sessions.find((s) => s.id === id);
    setTicker(`已切换会话 · ${escapeHtml(sessionLabel(target || {}).slice(0, 40))}`);
  }
  // 回放历史（服务端折叠成 turns；pending 轮 = 执行中，保持「思考与执行中」）
  const data = await fetch(`/api/agent/session/${id}/messages`).then((r) => r.json()).catch(() => null);
  if (!data || !Array.isArray(data.turns) || agentState.sessionId !== id) return;
  const turns = data.turns.map(apiTurnToCorridor);
  finalizeStalledTurn(turns, id);
  agentTurns = turns;
  agentState.turnsBySession.set(id, turns);
  corridorReset(0);
}

async function newAgentSession() {
  const folder = state.selection.path ?? null;
  setTicker('新建会话…', true);
  const started = await fetch('/api/agent/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder }),
  }).then((r) => r.json()).catch(() => ({}));
  if (!started.sessionId) {
    setTicker(`<span class="tick-tool">⚠ ${escapeHtml(started.error || '会话创建失败')}</span>`);
    return;
  }
  agentState.sessionArea = agentAreaKey(folder);
  agentState.sessionAreaChecked = agentState.sessionArea;
  const now = Date.now();
  agentState.turnsBySession.set(started.sessionId, []);
  agentState.sessions = agentState.sessions.filter((s) => s.id !== started.sessionId);
  agentState.sessions.unshift({ id: started.sessionId, title: '', updatedAt: now, createdAt: now, running: false, firstQ: null });
  await switchAgentSession(started.sessionId, { silent: true });
  setTicker(`新会话已就绪 @ ${escapeHtml(started.cwd || '')}`);
  $('#veil-input').focus();
}

async function abortAgentSession(id) {
  await fetch(`/api/agent/session/${id}/abort`, { method: 'POST' }).catch(() => { /* 已不在执行也算停止成功 */ });
  const s = agentState.sessions.find((item) => item.id === id);
  if (s) s.running = false;
  renderSessionsPanel();
  refreshAgentSessions(); // 回读「已手动停止」的最终态
}

// 输入框可用性随会话类型变化：流水线会话只读回放（Issue 流水线自动执行，不可交互），
// 提示文案换成指引；普通会话恢复默认提示（默认文案首次调用时从 index.html 捕获）。
let veilInputDefaultPh = null;
function updateVeilComposer() {
  const input = $('#veil-input');
  if (!input) return;
  veilInputDefaultPh ??= input.placeholder;
  input.placeholder = agentState.sessionPipeline
    ? '🤖 流水线会话（Issue 流水线自动执行）——只读回放，不可发送；点输入行左侧 ＋ 新建会话'
    : veilInputDefaultPh;
}

// 历史会话过滤：搜索词（标题/首问，含已归档）+ 类型 chips（普通/执行中/流水线/已归档）
function filteredAgentSessions() {
  const { q, kind } = agentState.sessionFilter;
  const needle = q.trim().toLowerCase();
  return agentState.sessions.filter((s) => {
    if (kind === 'running' && !s.running) return false;
    if (kind === 'pipeline' && !s.pipeline) return false;
    if (kind === 'archived' && !s.archived) return false;
    if (kind === 'active' && (s.archived || s.pipeline)) return false;
    if (needle && !`${s.title || ''}\n${s.firstQ || ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

// 通用向上导出图标（条目内联使用，与栏头部批量导出按钮同款）
const VS_EXPORT_ICON = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4"/><path d="m7.5 8 4.5-4.5L16.5 8"/><path d="M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4"/></svg>';

function renderSessionsPanel() {
  const list = $('#vs-list');
  if (!list) return;
  if (!agentState.sessions.length) {
    list.innerHTML = '<div class="vs-empty">这个区域还没有会话<br>发送消息或点输入行左侧 ＋ 新建</div>';
    return;
  }
  const sessions = filteredAgentSessions();
  if (!sessions.length) {
    list.innerHTML = '<div class="vs-empty">没有符合当前搜索/筛选的会话<br>试试调整关键词或切回「全部」</div>';
    return;
  }
  list.innerHTML = sessions.map((s) => `
    <div class="vs-item${s.id === agentState.sessionId ? ' active' : ''}${s.pipeline ? ' vs-item-ci' : ''}${s.archived ? ' vs-item-arch' : ''}" data-vs-id="${escapeHtml(s.id)}" title="${escapeHtml(sessionLabel(s))}${s.pipeline ? ' · 流水线会话，点击只读查看' : ''}${s.archived ? ' · 已归档：仅供搜索与导出，不可打开' : ''}">
      <div class="vs-label">${escapeHtml(sessionLabel(s).slice(0, 60))}</div>
      <div class="vs-meta">
        ${s.pipeline ? '<span class="vs-ci">🤖 流水线</span>' : ''}
        ${isAdmin() && s.owner && s.owner !== auth.user?.username ? `<span class="vs-owner" title="归属用户">@${escapeHtml(s.owner)}</span>` : ''}
        ${s.archived ? '<span class="vs-arch">已归档</span>' : ''}
        <span>${escapeHtml(fmtSessionTime(s.updatedAt))}</span>
        ${s.running ? '<span class="vs-run">● 执行中</span><button class="vs-stop" data-vs-stop="' + escapeHtml(s.id) + '" title="停止该会话的后台执行">⏹ 停止</button>' : ''}
        <button class="vs-export" data-vs-export="${escapeHtml(s.id)}" title="导出该会话为 Markdown${s.archived ? '（归档会话）' : ''}">${VS_EXPORT_ICON}</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-vs-id]').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (event.target.closest('[data-vs-stop]')) return;
      if (event.target.closest('[data-vs-export]')) return;
      const target = agentState.sessions.find((item) => item.id === el.dataset.vsId);
      if (target?.archived) {
        setTicker('已归档会话（7 天未活跃）仅供搜索与导出，不能打开——点输入行左侧 ＋ 新建会话继续话题');
        return;
      }
      switchAgentSession(el.dataset.vsId);
    });
  });
  list.querySelectorAll('[data-vs-stop]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      abortAgentSession(btn.dataset.vsStop);
    });
  });
  list.querySelectorAll('[data-vs-export]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      exportAgentSession(btn.dataset.vsExport);
    });
  });
}

// —— 会话导出（Markdown 单个 / zip 批量）——
// 下载走浏览器原生附件管线：fetch 只做预检（错误文案进工具细流），真正下载用
// location.href + 服务端 attachment 响应——webview/内置浏览器对 blob+<a download>
// 支持不稳（点了没反应），原生导航下载在所有环境可靠，且页面不会跳转。
async function exportAgentSession(id) {
  const s = agentState.sessions.find((item) => item.id === id);
  const url = `/api/agent/session/${encodeURIComponent(id)}/export`;
  setTicker(`导出会话「${escapeHtml(sessionLabel(s || {}).slice(0, 24))}」…`, true);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `导出失败（${res.status}）`);
    window.location.href = url; // attachment 响应 → 浏览器直接下载，当前页不动
    setTicker('<span class="tick-done">✓ 会话已导出为 Markdown</span>');
  } catch (error) {
    setTicker(`<span class="tick-tool">⚠ ${escapeHtml(String(error.message || error))}</span>`);
  }
}

async function exportAgentSessionsBatch() {
  const sessions = filteredAgentSessions();
  if (!sessions.length) {
    setTicker('当前列表没有可导出的会话——先调整搜索/筛选');
    return;
  }
  const ids = sessions.map((s) => s.id);
  setTicker(`打包导出 ${sessions.length} 个会话…`, true);
  try {
    // 预检（POST）：失败在这里拦下；成功后走 GET + attachment 原生下载同一批会话
    const res = await fetch('/api/agent/sessions/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `导出失败（${res.status}）`);
    window.location.href = `/api/agent/sessions/export?ids=${ids.join(',')}`;
    setTicker(`<span class="tick-done">✓ 已导出 ${sessions.length} 个会话（Markdown zip）</span>`);
  } catch (error) {
    setTicker(`<span class="tick-tool">⚠ ${escapeHtml(String(error.message || error))}</span>`);
  }
}

// 搜索框 / 过滤 chips / 批量导出：一次性绑定（vs-list 每次 innerHTML 重建，工具区不动）
$('#vs-search').addEventListener('input', (event) => {
  agentState.sessionFilter.q = event.target.value;
  renderSessionsPanel();
});
$('#vs-chips').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-vs-filter]');
  if (!chip) return;
  agentState.sessionFilter.kind = chip.dataset.vsFilter;
  $('#vs-chips').querySelectorAll('.vs-chip').forEach((c) => c.classList.toggle('on', c === chip));
  renderSessionsPanel();
});
$('#vs-batch-export').addEventListener('click', exportAgentSessionsBatch);

// 虚窗开着就轮询会话状态（3.5s）：后台执行的完成态兜底（SSE session.idle 是加速路径）；
// 顺带补归属区检查——开窗瞬间 serve 还在预热（serveUp:false）时 syncAgentArea 没完成，就绪后这里补
function ensureAgentPoll() {
  if (agentState.pollTimer) return;
  agentState.pollTimer = setInterval(() => {
    if (!veilOpen()) { stopAgentPoll(); return; }
    refreshAgentSessions();
    syncAgentArea();
  }, 3500);
}
function stopAgentPoll() {
  clearInterval(agentState.pollTimer);
  agentState.pollTimer = null;
}

// 归属区检查：进入/切换区域（含虚窗重开）**不再挂接该区最近会话**——用户明确要求
// 再次进入项目不要停留在上一次会话（流水线跑完后最近的往往是它的任务会话，前端只读
// 不可交互）。本页内在用的会话（自己建的/手动切的）属于当前区则保持——后台执行中的
// 会话也继续在它里面可见；否则空走廊起步，首条消息按当前目录自动新建（历史会话仍可
// 从独占模式会话栏点开回看）。同区域只检查一次（sessionAreaChecked），避免每次渲染
// 都拉列表；force 供虚窗重开时使用（同样不挂接历史）。
let agentAreaSyncing = false;
async function syncAgentArea({ force = false } = {}) {
  const area = agentAreaKey(state.selection.path ?? null);
  if (!force && agentState.sessionAreaChecked === area) return;
  if (agentAreaSyncing) return;
  agentAreaSyncing = true;
  try {
    await refreshAgentSessions();
    // serve 未起（预热中）或被 CI 占用别的目录：不标记已检查，就绪后由轮询/下次触发重试
    if (!agentState.serveUp) return;
    agentState.sessionAreaChecked = area;
    if (agentState.sessionId && agentState.sessionArea === area && !agentState.sessionPipeline) {
      agentState.sessionArea = area; // 在用会话就属于本区：保持不动（含后台执行中）
      return;
    }
    // 本区没有在用会话：不挂接最近会话——空走廊，首条消息自动新建
    agentState.sessionId = null;
    agentState.sessionPipeline = false;
    agentState.sessionArea = area;
    agentTurns = [];
    updateVeilComposer();
    corridorReset(0);
    renderSessionsPanel();
  } finally {
    agentAreaSyncing = false;
  }
}

// —— SSE 事件流（Agent 工具动作 → 阶梯）——
function connectAgentEvents() {
  if (agentState.es) return;
  const es = new EventSource('/api/agent/events');
  agentState.es = es;
  es.onmessage = (event) => {
    let ev;
    try { ev = JSON.parse(event.data); } catch { return; }
    if (ev.type === 'session.idle' || ev.type === 'session.error') {
      // 任何会话结束（含后台执行的、CI 的）都刷新会话列表——完成态由 running 迁移统一判定
      refreshAgentSessions();
      if (ev.type === 'session.error' && ev.sessionID === agentState.sessionId) {
        setTicker(`<span class="tick-tool">⚠ ${escapeHtml(String(ev.error || '会话错误').slice(0, 120))}</span>`);
      }
      return;
    }
    if (ev.type === 'sessions.archived') {
      // 服务端自动归档了一批 7 天未活跃会话：刷新列表（归档条目降调、仍可搜索/导出）
      refreshAgentSessions();
      return;
    }
    if (agentState.sessionId && ev.sessionID && ev.sessionID !== agentState.sessionId) return; // 其他会话的工具细流不刷屏
    if (ev.type === 'delta') return; // 思考/流式文本不展示，只取最终回复
    if (ev.type === 'message.updated' || ev.type === 'message.part.updated') {
      if (ev.partType === 'tool' && ev.tool) {
        const statusCn = { pending: '等待中', running: '执行中', completed: '完成', error: '失败' }[ev.toolStatus] || ev.toolStatus || '';
        setTicker(`<span class="tick-tool${ev.toolStatus === 'error' ? '' : ''}">🛠 ${escapeHtml(ev.tool)}${statusCn ? ` · ${statusCn}` : ''}</span>`, ev.toolStatus !== 'error');
      }
    }
  };
  es.onerror = () => {
    es.close();
    agentState.es = null;
    setTimeout(() => {
      if (veilOpen()) connectAgentEvents();
    }, 3000);
  };
}

// —— 发送（异步）：服务端起 SDK query 后立即返回，执行留在后台 ——
async function agentSend() {
  const input = $('#veil-input');
  const text = input.value.trim();
  if (!text) return;
  if (!agentState.settings?.enabled) {
    setTicker('请先在 ⚙ 设置中启用 Agent 并保存');
    return;
  }
  if (agentState.sessionPipeline) {
    setTicker('🤖 流水线会话只读回放，不可发送——点输入行左侧 ＋ 新建会话');
    return;
  }
  if (sessionIsRunning(agentState.sessionId)) {
    setTicker('该会话还在执行上一条消息——可切换/新建会话，或到独占模式会话栏停止');
    return;
  }
  input.value = '';
  setTicker('连接 agent…', true);
  try {
    const folder = state.selection.path ?? null;
    const area = agentAreaKey(folder);
    if (!agentState.sessionId || agentState.sessionArea !== area) {
      const started = await fetch('/api/agent/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder }),
      }).then((r) => r.json());
      if (!started.sessionId) {
        throw new Error(`${started.error || '会话创建失败'}${started.log ? `\n${started.log}` : ''}`);
      }
      agentState.sessionId = started.sessionId;
      agentState.sessionArea = area;
      agentState.sessionAreaChecked = area;
      agentState.sessionPipeline = false; // 新建的必然是用户会话（之前可能停在只读的流水线会话上）
      updateVeilComposer();
      agentTurns = []; // 新会话从空白走廊开始（旧区 turns 已在它的缓存里）
      const now = Date.now();
      agentState.turnsBySession.set(started.sessionId, agentTurns);
      agentState.sessions = agentState.sessions.filter((s) => s.id !== started.sessionId);
      agentState.sessions.unshift({ id: started.sessionId, title: '', updatedAt: now, createdAt: now, running: false, firstQ: text.slice(0, 80) });
      renderSessionsPanel();
      setTicker(`会话就绪 @ ${escapeHtml(started.cwd)}`, true);
    }
    const turn = { uid: ++turnUid, q: text, a: '', done: false, error: false };
    agentTurns.push(turn);
    corridorReset(0); // 新回复进场，视角回到最前

    const reply = await fetch('/api/agent/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: agentState.sessionId, text, context: agentContextText(text) }),
    }).then((r) => r.json());
    if (reply.error) throw new Error(reply.error);
    agentState.refs.clear(); // 引用随消息一次性消费
    const s = agentState.sessions.find((item) => item.id === agentState.sessionId);
    if (s) { s.running = true; s.firstQ = s.firstQ || text.slice(0, 80); }
    renderSessionsPanel();
    ensureAgentPoll();
    setTicker('已发送 · 后台执行中（切换/新建会话、ESC 收起都不中断）', true);
  } catch (error) {
    // 会话可能已失效（注册表清理/服务重启）——丢弃会话，下一条消息自动按当前目录重建。
    // 本轮失败以错误卡片留在走廊里。
    const turn = agentTurns[agentTurns.length - 1];
    if (turn && !turn.done) {
      turn.a = error.message;
      turn.error = true;
      turn.done = true;
    } else {
      agentTurns.push({ uid: ++turnUid, q: text, a: error.message, done: true, error: true });
    }
    agentState.sessionId = null;
    setTicker('<span class="tick-tool">⚠ 出错</span>');
    corridorReset(corridorShift);
  }
}

$('#veil-send').addEventListener('click', agentSend);
attachMarkerBackspace($('#veil-input'));
$('#veil-input').addEventListener('keydown', (event) => {
  // 只拦截 Enter；ESC 等要继续冒泡给全局处理（否则退不出虚窗）。
  if (event.key === 'Enter') {
    event.preventDefault();
    // 空输入时 Enter 无可发送，改为切独占（与 ⛶ 按钮同一开关，可来回切）。
    if ($('#veil-input').value.trim()) agentSend();
    else toggleExclusive();
  }
});

// —— 虚窗开关：待机底部提示 / Enter 唤醒 / ESC 退出 ——
function veilOpen() {
  return !$('#agent-veil').classList.contains('hidden');
}

function updateAgentHint() {
  const show = Boolean(agentState.settings?.enabled) && !veilOpen();
  $('#agent-hint').classList.toggle('hidden', !show);
}

function openAgentVeil() {
  closeIssueListView(); // agent 与 issue 模式互斥
  exitIssueFileMode();
  $('#agent-hint').classList.add('hidden');
  $('#agent-veil').classList.remove('hidden');
  renderAgentContext();
  corridorReset(corridorShift);
  renderSessionsPanel();
  connectAgentEvents();
  agentPrewarmServe(); // serve 可能未跑（重启/被回收）——预热并刷新模型下拉
  syncAgentArea({ force: true }); // 归属区同步：在用会话保持（后台执行中的随之可见），否则空走廊——不挂接历史会话
  ensureAgentPoll();
  setTimeout(() => $('#veil-input').focus(), 60);
}

function closeAgentVeil() {
  $('#agent-veil').classList.add('hidden');
  if (document.body.classList.contains('agent-exclusive')) {
    document.body.classList.remove('agent-exclusive');
    $('#agent-veil').classList.remove('agent-exclusive-layout');
    $('#veil-exclusive').textContent = '⛶ 独占';
    $('#veil-sessions').classList.add('hidden');
    $('#veil-sessions').classList.remove('revealed');
  }
  if (agentState.es) {
    agentState.es.close();
    agentState.es = null;
  }
  stopAgentPoll(); // 页面上的观察停了，后台执行继续（服务端 watcher 跟踪）
  updateAgentHint();
}

$('#btn-agent').addEventListener('click', openAgentVeil);
// 左上角常显「ESC 退出 Agent」框：点击等同按 ESC（独占/非独占都有）
$('#veil-esc').addEventListener('click', closeAgentVeil);

// —— 全局按键链 ——
// ESC：虚窗 → 整屏 issue 列表 → 任务看板 → issue 模式 → issue 面板 → 其余不动。
function globalEscapeChain() {
  if (veilOpen()) {
    closeAgentVeil();
    return;
  }
  if (issueMode.listMode) {
    closeIssueListView();
    return;
  }
  if (board.open) {
    if (board.tab === 'settings' || board.tab === 'history') { setBoardTab('queue'); return; } // 非队列 sheet 先回队列，再按 ESC 才关
    closeBoard();
    return;
  }
  if (issueMode.active) {
    exitIssueFileMode();
    return;
  }
  const issues = $('#detail-issues');
  if (detailLoadedId != null && !issues.classList.contains('collapsed')) {
    issues.classList.add('collapsed');
    return;
  }
  hideFlyout();
}

function globalEnterWake(event) {
  if (!agentState.settings?.enabled
    || veilOpen()
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event?.target?.tagName)
    || event?.target?.isContentEditable
    || document.querySelector('.modal:not(.hidden)') != null) return false;
  event?.preventDefault?.();
  openAgentVeil();
  return true;
}

// 图表 iframe 内的按键转发（焦点在图里时 ESC/Enter 依然生效）。
window.__archifyVeilKey = (key) => {
  if (key === 'Escape') globalEscapeChain();
  else if (key === 'Enter') globalEnterWake(null);
};

// ---- Issue 模式（与 agent 模式互斥） ----
const issueMode = { active: false, editingId: null, listMode: false };

// 点击路由：agent 虚窗 / issue 提交 / issue 加图编辑 / 默认（viewer 卡片）。
window.__archifyModeClick = (info) => {
  if (veilOpen()) {
    window.__archifyInsertComponentRef(info);
    return { blocked: true };
  }
  if (issueMode.active) {
    if (issueMode.editingId != null) {
      updateIssueNode(issueMode.editingId, info);
    } else {
      insertIssueMarker(info);
    }
    return { blocked: true };
  }
  return { blocked: false };
};

// agent 输入的 @索引 插入 + 引用登记（随消息一次性消费）
agentState.refs = new Map(); // id → { label, diagramId }
window.__archifyInsertComponentRef = (info) => {
  if (document.body.classList.contains('agent-exclusive')) return;
  const input = $('#veil-input');
  // 去重：输入框里已有该元素的 @标记(id) 就不再插入（refs 是 Map，登记本身按 id 去重）
  if (input.value.includes(`(${info.id})`)) {
    setTicker(`<span class="tick-tool">⚠ @${escapeHtml(info.label)} 已在输入中引用</span>`);
    input.focus();
    return;
  }
  const marker = `@${info.label}(${info.id}) `;
  agentState.refs.set(info.id, { label: info.label, diagramId: detailLoadedId });
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + marker + input.value.slice(end);
  input.focus();
  input.setSelectionRange(start + marker.length, start + marker.length);
};

// 提交模式：点击组件 → 添加可读标签芯片（可多个，各带 × 删除）
const issueTags = []; // {id, label}

function renderIssueTags() {
  const row = $('#di-tags');
  row.innerHTML = issueTags.map((tag, index) => `
    <span class="tag-chip" title="${escapeHtml(tag.id)}">
      <span class="tag-label">${escapeHtml(tag.label)}</span>
      <button class="tag-x" data-tag-del="${index}" title="删除此标签">✕</button>
    </span>`).join('');
  row.querySelectorAll('[data-tag-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      issueTags.splice(Number(btn.dataset.tagDel), 1);
      renderIssueTags();
    });
  });
}

function insertIssueMarker(info) {
  if (issueTags.some((t) => t.id === info.id)) return; // 去重
  if (issueTags.length >= 12) return;
  issueTags.push({ id: info.id, label: info.label });
  renderIssueTags();
  $('#di-title').focus();
}

// 加图编辑模式：点击组件 → 为该 issue 追加一个目标标签
async function updateIssueNode(issueId, info) {
  const current = state.issues.find((i) => i.id === issueId);
  const nodes = [...(current?.nodes || [])];
  if (!nodes.some((n) => n.id === info.id) && nodes.length < 12) {
    nodes.push({ id: info.id, label: info.label });
  }
  const res = await fetch(`/api/issues/${issueId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes }),
  });
  if (res.ok) await loadIssues();
}

// @标记 整块删除（agent 输入与 issue 标题输入共用）
function attachMarkerBackspace(input) {
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Backspace') return;
    const pos = input.selectionStart;
    if (pos !== input.selectionEnd) return;
    const before = input.value.slice(0, pos);
    let end = pos;
    if (end > 0 && (before[end - 1] === ' ' || before[end - 1] === '\t')) end -= 1;
    if (end === 0 || before[end - 1] !== ')') return;
    const open = before.lastIndexOf('(', end - 2);
    if (open <= 0) return;
    // 标签本身可含空格（连线「甲 → 乙「文本」」、多词英文名），跳词计数会漏——
    // 从 '(' 向左直接扫 '@'，只有 '(' ')' '@' 能终止扫描，词数不受限
    let s = -1;
    for (let i = open - 1; i >= 0; i -= 1) {
      const ch = before[i];
      if (ch === '@') { s = i; break; }
      if (ch === '(' || ch === ')') break;
    }
    // '@' 必须在词首（排除 user@host 之类被误吞）
    if (s < 0 || (s > 0 && !/\s/.test(before[s - 1]))) return;
    event.preventDefault();
    input.value = input.value.slice(0, s) + input.value.slice(pos);
    input.setSelectionRange(s, s);
  });
}

// 提交模式开关（与 agent 虚窗互斥）
function enterIssueFileMode() {
  closeAgentVeil();
  issueMode.active = true;
  issueMode.editingId = null;
  closeIssueListView();
  setComposerKind('bug'); // 🐞 提交模式定位当前图，类型回到缺陷/改进
  $('#issue-file-btn').classList.add('active');
  $('#issue-file-btn').textContent = '🐞 定位中…点击组件';
  $('#detail-issues').classList.remove('collapsed');
  $('#detail-issues').classList.add('file-mode');
  setTimeout(() => $('#di-title').focus(), 50);
}

function exitIssueFileMode() {
  issueMode.active = false;
  issueMode.editingId = null;
  issuePanel.editing = null;
  $('#issue-file-btn').classList.remove('active');
  $('#issue-file-btn').textContent = '🐞 提 issue';
  $('#detail-issues').classList.remove('file-mode');
  $('#detail-issues').classList.remove('edit-mode');
  if (issueCenter.active) {
    $('#detail-issues').classList.add('file-mode'); // 中心模式回到「只显示输入区」形态
  } else {
    setComposerKind('bug');
  }
  renderIssuePanel();
}

$('#issue-file-btn').addEventListener('click', () => {
  if (issueMode.active) exitIssueFileMode();
  else enterIssueFileMode();
});

// —— Issue 中心（目录行「＋」入口）：提「创建新图」issue + 查看该目录范围的全部 issue ——
// 复用整屏列表视图（#issue-full-list）与底部 composer；无图上下文，类型锁定创建新图。
const issueCenter = { active: false, folder: null }; // folder: string|null（null=未分类）

// 目录范围（本目录及子目录）内的全部 issue：创建类看目标目录，缺陷类看所属图
function issueCenterScopeIssues(folder) {
  const inScope = (f) => (folder == null ? f == null : (f === folder || (f || '').startsWith(`${folder}/`)));
  return state.issues.filter((i) => {
    if (i.kind === 'new-feature') return inScope(i.folder ?? null);
    if (!i.diagramId) return false;
    const d = state.diagrams.find((x) => x.id === i.diagramId);
    return d ? inScope(d.folder ?? null) : false;
  });
}

function openIssueCenter(folder) {
  if (board.open) closeBoard();
  hideFlyout();
  if (detailLoadedId != null) closeDetail();
  closeAgentVeil();
  issueCenter.active = true;
  issueCenter.folder = folder ?? null;
  issueMode.listMode = true; // 复用 ESC 链与列表渲染入口
  $('#detail-pane').classList.remove('hidden');
  $('#split').classList.add('with-detail');
  $('#detail-frame').classList.add('hidden');
  $('#issue-full-list').classList.remove('hidden');
  $('#detail-title').textContent = `Issue · ${folder ?? '未分类'}`;
  $('#detail-hint').textContent = '创建新图与缺陷改进统一为 issue，由流水线执行';
  // 图上下文的按钮在中心模式下无意义
  $('#detail-open').classList.add('hidden');
  $('#detail-issue').classList.add('hidden');
  $('#issue-file-btn').classList.add('hidden');
  // 面板只留输入区，类型锁定「创建新图」（缺陷类依赖当前图）
  const panel = $('#detail-issues');
  panel.classList.remove('collapsed', 'edit-mode');
  panel.classList.add('file-mode', 'center-mode');
  $('#di-kind').querySelector('option[value="bug"]').disabled = true;
  setComposerKind('new-feature');
  renderIssueFullList();
  setTimeout(() => $('#di-title').focus(), 50);
}

function closeIssueCenter() {
  if (!issueCenter.active) return;
  issueCenter.active = false;
  issueMode.listMode = false;
  issueMode.active = false;
  issueMode.editingId = null;
  issuePanel.editing = null;
  $('#detail-issues').classList.remove('file-mode', 'center-mode', 'edit-mode');
  $('#di-kind').querySelector('option[value="bug"]').disabled = false;
  setComposerKind('bug');
  $('#issue-full-list').classList.add('hidden');
  $('#detail-frame').classList.remove('hidden');
  $('#detail-open').classList.remove('hidden');
  $('#detail-issue').classList.remove('hidden');
  $('#issue-file-btn').classList.remove('hidden');
  $('#issue-file-btn').textContent = '🐞 提 issue';
  $('#detail-title').textContent = '';
  $('#detail-hint').textContent = '滚轮缩放 · 右键拖动平移 · 双击复位';
  $('#detail-pane').classList.add('hidden');
  $('#split').classList.remove('with-detail');
}

// 中心视图的 issue 卡片：创建类带 ✨ + new feature 标签 + 目标目录；缺陷类挂图
function issueCenterItemHtml(i) {
  const isNew = i.kind === 'new-feature';
  const diagram = isNew ? null : state.diagrams.find((d) => d.id === i.diagramId);
  return `
    <div class="ifl-item ${i.status}" data-ifl-id="${i.id}">
      <div class="row-1">
        <span class="issue-dot" title="${i.refused ? '已拒绝' : (i.status === 'open' ? '开启' : '已关闭')}"></span>
        <span class="ifl-kind">${isNew ? '✨' : '🐞'}</span>
        ${isNew ? '<span class="bd-tag">new feature</span>' : ''}
        ${refusedTag(i)}
        <span class="issue-title-text" title="${escapeHtml(i.title)}">#${i.id} ${escapeHtml(i.title)}</span>
        <span class="issue-meta">${isNew ? `目标：${escapeHtml(i.folder ?? '未分类')}` : `图：${escapeHtml(diagram?.title || '（已删除）')}`} · ${new Date(i.createdAt).toLocaleString('zh-CN', { hour12: false })}${i.updatedAt !== i.createdAt ? ' · 已编辑' : ''}</span>
      </div>
      ${!isNew && i.nodes?.length ? `<div class="row-2">${issueTagChips(i)}</div>` : ''}
      ${i.body ? `<div class="ifl-body">${escapeHtml(i.body)}</div>` : ''}
      <div class="ifl-hint">点击进入编辑（标题 / 描述 / 关闭）</div>
    </div>`;
}

// —— 🐛 整屏 Issue 列表视图（图详情的 🐛 按钮 = 本图 issue；目录行 ＋ = issue 中心） ——
function openIssueListView() {
  closeAgentVeil();
  exitIssueFileMode();
  issueMode.listMode = true;
  $('#issue-full-list').classList.remove('hidden');
  $('#detail-frame').classList.add('hidden');
  $('#detail-issues').classList.add('collapsed');
  renderIssueFullList();
}

function closeIssueListView() {
  if (issueCenter.active) { closeIssueCenter(); return; }
  if (!issueMode.listMode) return;
  issueMode.listMode = false;
  $('#issue-full-list').classList.add('hidden');
  $('#detail-frame').classList.remove('hidden');
}

function renderIssueFullList() {
  if (issueCenter.active) {
    const items = issueCenterScopeIssues(issueCenter.folder);
    const open = items.filter((i) => i.status === 'open').length;
    $('#ifl-title').textContent = `Issue · ${issueCenter.folder ?? '未分类'}`;
    $('#ifl-count').textContent = items.length ? `${open} 开启 · ${items.length - open} 关闭` : '';
    $('#ifl-list').innerHTML = items.length ? items.map(issueCenterItemHtml).join('')
      : '<div class="issue-empty">还没有 issue — 在下方提交「创建新图」，图打开后也可在详情里提缺陷/改进</div>';
  } else {
    const items = detailLoadedId == null ? [] : issuesFor(detailLoadedId);
    const open = items.filter((i) => i.status === 'open').length;
    const diagram = detailLoadedId != null ? state.diagrams.find((d) => d.id === detailLoadedId) : null;
    $('#ifl-title').textContent = `Issue · ${diagram?.title || ''}`;
    $('#ifl-count').textContent = items.length ? `${open} 开启 · ${items.length - open} 关闭` : '';
    $('#ifl-list').innerHTML = items.length ? items.map((i) => `
      <div class="ifl-item ${i.status}" data-ifl-id="${i.id}">
        <div class="row-1">
          <span class="issue-dot" title="${i.refused ? '已拒绝' : (i.status === 'open' ? '开启' : '已关闭')}"></span>
          ${refusedTag(i)}
          <span class="issue-title-text" title="${escapeHtml(i.title)}">#${i.id} ${escapeHtml(i.title)}</span>
          <span class="issue-meta">${new Date(i.createdAt).toLocaleString('zh-CN', { hour12: false })}${i.updatedAt !== i.createdAt ? ' · 已编辑' : ''}</span>
        </div>
        <div class="row-2">${issueTagChips(i)}</div>
        ${i.body ? `<div class="ifl-body">${escapeHtml(i.body)}</div>` : ''}
        <div class="ifl-hint">点击进入加图编辑模式（图中点击可追加标签）</div>
      </div>`).join('') : '<div class="issue-empty">还没有 issue — 点右上「＋ 新建」</div>';
  }
  $('#ifl-list').querySelectorAll('[data-ifl-id]').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (event.target.closest('[data-node-del]')) return; // × 删除不进入编辑
      enterIssueEditMode(Number(el.dataset.iflId));
    });
  });
  bindNodeDelButtons($('#ifl-list'));
}

// 加图编辑模式：编辑表单 + 点击图中组件更新该 issue 的目标
function enterIssueEditMode(id) {
  if (!issueCenter.active) closeIssueListView();
  exitIssueFileMode();
  issueMode.active = true;
  issueMode.editingId = id;
  issuePanel.editing = id;
  $('#issue-file-btn').classList.add('active');
  $('#issue-file-btn').textContent = '🐞 编辑定位中…点击组件换目标';
  // 编辑时隐藏底部新建表单并清掉草稿，避免新旧 issue 表单同屏混淆
  const panel = $('#detail-issues');
  panel.classList.remove('collapsed');
  panel.classList.remove('file-mode'); // issue 中心模式：编辑表单在列表区渲染，列表得可见
  panel.classList.add('edit-mode');
  $('#di-title').value = '';
  $('#di-body').value = '';
  issueTags.length = 0;
  renderIssueTags();
  setComposerTarget(null);
  renderIssuePanel();
}

$('#ifl-back').addEventListener('click', closeIssueListView);
$('#ifl-new').addEventListener('click', () => {
  if (issueCenter.active) { $('#di-title').focus(); return; } // 中心模式输入区就在下方
  closeIssueListView();
  enterIssueFileMode();
});
$('#detail-issue').addEventListener('click', () => {
  if (issueMode.listMode) closeIssueListView();
  else openIssueListView();
});

// 非独占模式：点击图中组件 → 在输入框光标处插入组件索引

// ⛶ 独占模式：Agent 回复占满全屏，背后整页模糊（发送键左侧按钮切换）；
// 历史会话栏是召唤式浮层——进 DOM 但滑在屏幕左缘外，鼠标贴近左缘才滑出（见下方 mousemove）
function toggleExclusive() {
  const on = document.body.classList.toggle('agent-exclusive');
  corridorMetricsGen += 1; // 独占/非独占卡高与字号不同：滚动尺寸缓存全部失效
  $('#agent-veil').classList.toggle('agent-exclusive-layout', on);
  $('#veil-exclusive').textContent = on ? '⤡ 退出独占' : '⛶ 独占';
  const panel = $('#veil-sessions');
  panel.classList.toggle('hidden', !on);
  panel.classList.remove('revealed');
  if (on) refreshAgentSessions();
  // 几何变化交给 CSS 过渡（卡片 min/max-height、width、padding 与 veil-top 透视都
  // 在过渡表里，0.42s 平滑变形：独占=满高从头部显示，非独占=紧凑底锚卡）。
  // 阶梯布局依赖实测高度，等变形落定再重算——立即重算会按中间态测量且冻结过渡，变成瞬跳
  clearTimeout(corridorExclusiveTimer);
  corridorExclusiveTimer = setTimeout(() => corridorReset(corridorShift), 460);
}
let corridorExclusiveTimer = 0;
$('#veil-exclusive').addEventListener('click', toggleExclusive);

// 窗口尺寸变化：长廊卡片的阶梯间距依赖实测几何，重摆姿态（内容键未变不重排内容）
let corridorResizeTimer = 0;
window.addEventListener('resize', () => {
  if (!veilOpen()) return;
  corridorMetricsGen += 1; // 窗口尺寸变化改变卡片正文高度：滚动尺寸缓存失效
  clearTimeout(corridorResizeTimer);
  corridorResizeTimer = setTimeout(renderCorridor, 180);
});

// 独占模式 · 会话栏召唤：鼠标贴近屏幕左缘滑出，移开（越过栏右缘一段距离）滑回。
// 用 window mousemove + 迟滞双阈值判定而非实体热区——不拦截长廊卡片/复制按钮的点击，
// 鼠标在正文上（离左缘远）天然不会误触；两阈值之间的地带（含会话栏自身）维持现状防抖动
const SESSIONS_EDGE_X = 36;  // 距左缘 ≤ 此值 → 滑出
const SESSIONS_AWAY_X = 300; // 超过会话栏右缘(250)+余量 → 滑回
document.addEventListener('mousemove', (event) => {
  if (!document.body.classList.contains('agent-exclusive')) return;
  const panel = $('#veil-sessions');
  if (event.clientX <= SESSIONS_EDGE_X) panel.classList.add('revealed');
  // 焦点在栏内（搜索框输入中等）时不滑回——鼠标短暂移开别把正在用的工具栏抽走
  else if (event.clientX > SESSIONS_AWAY_X && !panel.contains(document.activeElement)) panel.classList.remove('revealed');
});
// 左缘竖排提条：点击也能呼出（悬停本身已在左缘阈值内，点击是显式兜底）
$('#veil-sessions-tab').addEventListener('click', () => {
  if (document.body.classList.contains('agent-exclusive')) $('#veil-sessions').classList.add('revealed');
});
$('#veil-new').addEventListener('click', newAgentSession);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    globalEscapeChain();
    return;
  }
  if (veilOpen() && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    // 虚窗开启时上下键始终作用于对话走廊（单行输入框的上下键本就无光标用途）
    event.preventDefault();
    corridorGoto(corridorShift + (event.key === 'ArrowUp' ? 1 : -1));
    return;
  }
  // Enter 唤醒虚窗（焦点不在输入框、无弹窗时）
  if (event.key === 'Enter') {
    // 虚窗内焦点落在按钮上时，Enter 的浏览器默认行为 = 再次点击该按钮
    // （点过 ⛶/⧉ 等按钮后按 Enter 会误触它们——用户反馈过没光标也切独占）。
    // 拦掉默认激活，把焦点送回输入框；Enter 的正经出口只有输入框自身。
    if (veilOpen()
      && event.target?.tagName === 'BUTTON'
      && event.target?.closest?.('#agent-veil')) {
      event.preventDefault();
      $('#veil-input').focus();
      return;
    }
    globalEnterWake(event);
  }
});

// ---- 搜索 ----
let searchTimer = null;
$('#search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = event.target.value;
    if (state.selection.scope === 'id') state.selection = { scope: 'all', path: null, id: null };
    render();
  }, 120);
});

// ---- Chrome 自动填充防线（搜索框被预填 test 的最终解法，三层） ----
// ① 初始 disabled：Chrome 的自动填充候选扫描跳过 disabled 字段，点一下才启用聚焦
//    （index.html 里 #search 带 disabled，聚焦期填充也找不到候选）；
// ② 即时守卫：只认「真人事件」（keydown / 输入法 compositionstart / paste），
//    此外的任何 input（Chrome 填充也会发可信 input 事件，无法用 isTrusted 区分）
//    只要值非空就当场清空并复位过滤；
// ③ 加载后数拍清扫：兜住不发 input 事件的静默填充（老版 Chrome 行为）。
let searchUserTyped = false;
// 注意挂在包装层 .search-box 上：disabled 输入框自身不接收指针事件（点击会落到父层），
// 监听在 #search 上永远等不到 pointerdown
document.querySelector('.search-box').addEventListener('pointerdown', () => {
  const el = $('#search');
  if (el.disabled) {
    el.disabled = false;
    el.focus();
  }
}, { capture: true });
['keydown', 'compositionstart', 'paste'].forEach((evName) => {
  $('#search').addEventListener(evName, () => { searchUserTyped = true; }, { capture: true });
});
$('#search').addEventListener('input', () => {
  if (searchUserTyped) return;
  const el = $('#search');
  if (!el.value) return;
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
[300, 900, 1800, 3200].forEach((ms) => setTimeout(() => {
  const el = $('#search');
  if (el.value && !searchUserTyped && document.activeElement !== el) {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}, ms));

// ---- 删除图 ----
async function deleteDiagram(id) {
  const d = state.diagrams.find((item) => item.id === id);
  if (!confirm(`确定从图集删除「${d?.title || id}」吗？`)) return;
  const res = await fetch(`/api/diagrams/${id}`, { method: 'DELETE' });
  if (res.ok) {
    if (detailLoadedId === id) {
      detailLoadedId = null;
      $('#detail-pane').classList.add('hidden');
      $('#split').classList.remove('with-detail');
      detailFrame.src = 'about:blank';
    }
    if (state.selection.id === id) state.selection = { scope: 'all', path: null, id: null };
    loadDiagrams();
    loadIssues();
  }
}

// 回到顶部按钮：主滚动区（目录树 / 卡片区）滚过阈值时出现，点击平滑回顶。
const toTopBtn = $('#to-top');
const toTopScrollers = () => [$('#grid-pane'), $('#tree'), document.scrollingElement];
function updateToTop() {
  const scrolled = toTopScrollers().some((el) => el && el.scrollTop > 180);
  toTopBtn.classList.toggle('hidden', !scrolled);
}
['#grid-pane', '#tree'].forEach((sel) => {
  document.querySelector(sel)?.addEventListener('scroll', updateToTop, { passive: true });
});
window.addEventListener('scroll', updateToTop, { passive: true });
toTopBtn.addEventListener('click', () => {
  for (const el of toTopScrollers()) {
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

// ---- 启动：先验登录态（/api/auth/me），未登录 → 登录门；已登录 → 直接进入 ----
(async function bootAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      if (data?.user) {
        enterApp(data.user);
        return;
      }
    }
  } catch { /* 服务未起：也进登录门，提交时再报「服务不可达」 */ }
  showAuthGate();
})();
