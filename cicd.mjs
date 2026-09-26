// cicd.mjs — 项目级 Issue 统一执行流水线（AI 自动解决）。
// 执行体是 Claude Code Agent SDK agent（复用 server.mjs 的 claude.mjs 桥接），本模块
// 负责设置存储、周期调度、任务拆分（按 issue 逐条发消息）与运行记录。
// **所有 agent workflow 都必须结合项目代码**：项目目录里有源码时，改图/创图
// 的组件、连线、命名都要有代码证据（prompt 已强制；纯文档/空目录按文档或
// 需求文字推理并要求汇报中声明）。
// 任务 prompt 携带 CI 运行凭证（deps.ciGuard）：run 期间 agent 凭 x-archify-ci-key
// 请求头调用图集写 API；虚窗会话 agent 拿不到凭证，写请求一律 403（图集写保护）。
//
// 存储 gallery/cicd.json：
//   { settings: { maxConcurrentSessions（全局会话并发上限，1-8，默认 2——
//                  旧版按项目存储的值读入时自动迁移取最大者，之后只认全局）,
//                 projects: { <顶层目录>: { issueAuto:{enabled,threshold,intervalMinutes},
//                                           model?:"模型名"（项目专属执行模型，空=跟随全局） } } },
//     state:   { <顶层目录>: { issues:{lastRunAt,lastResult,lastStatus,lastProductive,lastOpenAfter} } },
//     history: [ {id,project,kind,trigger,startedAt,finishedAt,status,summary,error,items,counts} ] }
// 启动时整体读入内存，之后只经 API 修改——手改文件不生效（要重启）。
// 旧版的 autoReview 设置与 generateQueue 已随功能移除而忽略（读入时丢弃）。
//
// 调度规则（30s 一拍）：
// - **多项目 run 并行（全局会话名额）**：会话并发上限 maxConcurrentSessions 是**全局池**——
//   所有项目的在飞 run 共用 N 个名额（用户要求「全局的 N，不是每个项目各 N」），比如 A 项目
//   占 1 个名额时 B 项目的 run 可以同时占另外 1 个。同项目互斥（一个项目同时只有一个 run）。
//   每组任务是一次 SDK query()（cwd=项目目录），无 serve 进程，用户会话/多项目 run 天然互不掐断。
// - issueAuto（两种自动触发，满足任一即跑，按项目独立判定）：
//     到量——项目内开启 issue 数（含创建类）≥ threshold，不必等间隔；
//     到时——距上次运行 ≥ intervalMinutes 且仍有开启 issue。
//   防重跑护栏：上次失败的运行要等满间隔才自动重试；上次没成效（没关 issue
//   也没动图）时，到量触发还要求比上次运行结束时新增了 issue——卡住的流水线
//   不会每 30s 一拍地空转重跑
// - 提交「创建新图」issue（kind=new-feature，POST /api/issues）即入 pendingKick，
//   该项目空闲时立刻执行（保持原「＋」提交即执行的体验）；该项目在跑则运行结束后接续
// - 用户 agent 消息在飞（/api/agent/message）时，每组任务消息前让路等待（≤2min）
// - 单条 agent 消息上限 7200s（2 小时）：SDK 运行器 AbortController 自控超时
// - 会话模型（多会话并发，用户要求）：缺陷类按图分组——同图全部开启 issue 合并进一个
//   会话，一轮代码核实 + 一次 spec 修订 + 一次 replace 替换；创建类一条 issue 一个会话
//   （同一 run 内同目录的创建组串行——出图证据按目录判定，并发会互相误认对方的图；
//   跨项目同目录不可能，项目顶层互斥）。
//   连续 2 组失败即熔断：不再启动新会话，剩余组留待下轮。
//   自动关闭在全部会话结束后按客观证据统一判定（并发产物先归位再认账）
// - 单轮上限 10 条 issue，剩余留待下个周期

import fs from 'node:fs';
import path from 'node:path';

const TICK_MS = 30_000;
const ISSUE_BATCH_MAX = 10;
const MESSAGE_TIMEOUT_MS = 7_200_000;
const IDLE_WAIT_MS = 120_000;
const HISTORY_MAX = 60;

const DEFAULTS = {
  issueAuto: { enabled: false, threshold: 5, intervalMinutes: 60 },
  // 一次运行中同时处理的 agent 会话数上限（缺陷类按图分组一个会话、创建类一组一个会话）——全局设置
  maxConcurrentSessions: 2,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCicd(deps) {
  const {
    galleryDir, rootDir, archifyDir, port,
    readStore, listIssues, closeIssue,
    // Agent 后端（claude.mjs）：流水线会话与用户会话同一注册表（pipeline:true）。
    // createAgentSession({cwd,title,folder}) 建会话记录；sendAgentMessage(session,
    // prompt,{model,timeoutMs}) 同步等完整回复返回 {text}|{error}。缺省 stub
    // （依赖注入测试用，不会真调模型）。
    createAgentSession = async () => ({ id: 'stub-session', cwd: rootDir }),
    sendAgentMessage = async () => ({ text: '' }),
    agentSettings,
    userBusy = () => false,
    // CI 运行凭证（图集写保护）：每个 run 各持一个 key（多 run 并行），结束只吊销自己的。
    // 缺省 no-op（独立测试用：prompt 里不带凭证说明）。
    ciGuard = { headerName: null, begin: () => null, end: () => {} },
    now = Date.now,
  } = deps;

  const dbPath = path.join(galleryDir, 'cicd.json');
  const nowMs = now;
  const apiBase = () => `http://127.0.0.1:${port}`;
  const archifyBin = () => archifyDir.replace(/\\/g, '/');

  let db = loadDb();
  // 在飞 run（多项目并行，同项目也可多 run 并行——唯一硬约束是全局会话名额 +
  // issue 认领互斥：同一条 issue/同一张图的缺陷组不进两个 run，见 runClaims）
  const currentRuns = [];
  // 每个 run 认领的 issue id / 图 id（run 内分组构建后同步登记——同项目后来的 run
  // 在构建自己的分组时读它排除已认领的，防止同图双 replace 互相覆盖/同 issue 重复处理）。
  // 键 = run.id（startedMs 并行下可能同毫秒，id 带自增序号防撞）
  const runClaims = new Map(); // runId → { issues:Set, diagrams:Set }
  let runSeq = 0;
  // 同目录创建组的全局串行尾（跨 run 也互斥：出图证据按目录判定，两个 run 同时往同一
  // 目录出图会互相误认对方的图）。键 `${project ?? ''}|${folder ?? ''}` → 前一组的完成 Promise
  const createFolderTails = new Map();
  // 提交了「创建新图」issue、等待执行的项目（含 null=未分类）——有可执行（未被认领）的 issue 即跑
  const pendingKick = new Set();

  function loadDb() {
    try {
      const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      const projects = raw.settings?.projects && typeof raw.settings.projects === 'object'
        ? raw.settings.projects : {};
      // 并发上限迁到全局：旧版按项目存储，读入时取既有显式值里的最大者作为全局初值，
      // 并从项目设置里删掉——之后只认 settings.maxConcurrentSessions
      let migratedConcurrency = Number(raw.settings?.maxConcurrentSessions);
      for (const name of Object.keys(projects)) {
        const legacy = Number(projects[name].maxConcurrentSessions);
        if (Number.isFinite(legacy)) {
          migratedConcurrency = Number.isFinite(migratedConcurrency)
            ? Math.max(migratedConcurrency, legacy) : legacy;
          delete projects[name].maxConcurrentSessions;
        }
        projects[name] = {
          issueAuto: { ...DEFAULTS.issueAuto, ...(projects[name].issueAuto || {}) },
          ...(projects[name].model ? { model: String(projects[name].model).slice(0, 60) } : {}),
        };
      }
      const loaded = {
        settings: {
          maxConcurrentSessions: Number.isFinite(migratedConcurrency)
            ? Math.min(8, Math.max(1, Math.round(migratedConcurrency))) : DEFAULTS.maxConcurrentSessions,
          projects,
        },
        state: raw.state && typeof raw.state === 'object' ? raw.state : {},
        history: Array.isArray(raw.history) ? raw.history : [],
      };
      // 上个进程遗留的 running 讇为中断（executeRun 没跑到 finally）
      for (const h of loaded.history) {
        if (h.status === 'running') {
          h.status = 'error';
          h.error = '服务重启，运行中断';
          h.finishedAt = new Date().toISOString();
        }
      }
      return loaded;
    } catch {
      return { settings: { maxConcurrentSessions: DEFAULTS.maxConcurrentSessions, projects: {} }, state: {}, history: [] };
    }
  }

  function persist() {
    const tmp = `${dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, dbPath);
  }

  function ensureState(project) {
    if (!db.state[project]) db.state[project] = { issues: {} };
    db.state[project].issues ||= {};
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  // ---- 项目范围（project=null 表示未分类） ----
  function inProjectScope(folder, project) {
    if (project == null) return folder == null;
    return folder === project || (folder || '').startsWith(`${project}/`);
  }

  function projectDiagrams(project) {
    return readStore().diagrams.filter((d) => inProjectScope(d.folder ?? null, project));
  }

  function projectIssueIds(project) {
    return new Set(projectDiagrams(project).map((d) => d.id));
  }

  // 项目内开启的 issue：缺陷类（挂在项目图上）+ 创建类（kind=new-feature，folder 在项目范围内）
  function openIssuesInProject(project) {
    const ids = projectIssueIds(project);
    return listIssues().filter((i) => {
      if (i.status !== 'open') return false;
      if (i.kind === 'new-feature') return inProjectScope(i.folder ?? null, project);
      return i.diagramId && ids.has(i.diagramId);
    });
  }

  function projectCwd(project) {
    return readStore().folderMeta[project]?.localPath || rootDir;
  }

  // 会话并发上限：全局设置（1-8，默认 2）——看板顶部直接改，改动即对等待中的新会话生效
  function concurrencyLimit() {
    const n = Number(db.settings.maxConcurrentSessions);
    return Number.isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : DEFAULTS.maxConcurrentSessions;
  }

  // 全局会话名额（用户要求：所有项目的 run 共用 N 个，不是每个项目各 N 个）：
  // 名额在「一条会话消息期间」持有——发消息前 acquire（等用户让路时不占名额），
  // 消息结束（成败皆可）release 并直接移交给最早排队的等待者（可能是别的项目的 run）。
  let activeSessions = 0;
  const slotWaiters = [];
  function acquireSessionSlot() {
    if (activeSessions < concurrencyLimit()) {
      activeSessions += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => slotWaiters.push(resolve));
  }
  function releaseSessionSlot() {
    const next = slotWaiters.shift();
    if (next) next(); // 名额直接移交给等待者（activeSessions 计数不变）
    else activeSessions -= 1;
  }
  // 名额上调后立即放行排队的会话——不放的话新名额要等在飞消息逐个结束、经释放移交
  // 逐个补位才能用上（看板上改数字的预期是立即生效）
  function pumpSessionSlots() {
    while (slotWaiters.length && activeSessions < concurrencyLimit()) {
      activeSessions += 1;
      slotWaiters.shift()();
    }
  }

  const isProjectRunning = (project) => currentRuns.some((r) => (r.project ?? null) === (project ?? null));

  // 同项目在飞 run 已认领的 issue / 图（后来者构建分组时排除，防重复处理/同图双 replace）
  function claimedSetsFor(project) {
    const issues = new Set();
    const diagrams = new Set();
    for (const other of currentRuns) {
      if ((other.project ?? null) !== (project ?? null)) continue;
      const c = runClaims.get(other.id);
      if (!c) continue;
      for (const id of c.issues) issues.add(id);
      for (const d of c.diagrams) diagrams.add(d);
    }
    return { issues, diagrams };
  }

  // 该项目当前可执行的开启 issue（排除已被在飞 run 认领的；缺陷类按图认领——同图的
  // 新 issue 等图上的 run 结束再进下一轮）
  function unclaimedIssues(project) {
    const { issues, diagrams } = claimedSetsFor(project);
    return openIssuesInProject(project).filter((i) => !issues.has(i.id)
      && (i.kind === 'new-feature' || (i.diagramId && !diagrams.has(i.diagramId))));
  }

  function specPathOf(entry) {
    const dir = entry.dir || path.join(galleryDir, entry.id);
    return path.join(dir, entry.specFile || 'spec.json').replace(/\\/g, '/');
  }

  function snapshotProject(project) {
    const diagrams = projectDiagrams(project).map((d) => ({ id: d.id, importedAt: d.importedAt }));
    const ids = new Set(diagrams.map((d) => d.id));
    const issues = listIssues().filter((i) => (i.kind === 'new-feature'
      ? inProjectScope(i.folder ?? null, project)
      : i.diagramId && ids.has(i.diagramId)));
    return { diagrams, issues, byId: new Map(issues.map((i) => [i.id, i])), diagramIds: ids };
  }

  // ---- agent 消息 ----
  async function waitForIdle(maxMs = IDLE_WAIT_MS) {
    const start = nowMs();
    while (userBusy()) {
      if (nowMs() - start > maxMs) return false;
      await sleep(3000);
    }
    return true;
  }

  // 同步等完整回复：SDK 运行器内部管超时（MESSAGE_TIMEOUT_MS）与系统指南注入；
  // 返回 {text}|{error}，不抛异常（executeRun 按客观证据结算，失败留给下轮）
  async function runAgentUnit(session, text, modelValue) {
    try {
      const model = String(modelValue || '').trim();
      return await sendAgentMessage(session, text, {
        ...(model ? { model } : {}),
        timeoutMs: MESSAGE_TIMEOUT_MS,
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? `超时（>${MESSAGE_TIMEOUT_MS / 1000}s）` : error.message;
      return { error: `消息发送异常：${reason}` };
    }
  }

  // ---- 任务 prompt（自描述：agent 只靠 system 指南 + 本消息即可干活） ----
  // 写 API 调用说明：图集写保护只放行浏览器来源或本凭证（见 server.mjs guardGalleryWrite）
  const ciAuthNote = (ciKey) => (ciGuard.headerName && ciKey
    ? `该请求必须带头 ${ciGuard.headerName}: ${ciKey}（本次任务的运行凭证——图集写 API 只放行用户前端与带凭证的 CI 任务，缺它会被 403 拒绝）`
    : '');

  // 缺陷组执行 prompt：同图全部开启 issue 合并进一个会话一次处理——一轮核实、
  // 一次 spec 修订、一次 replace 替换（避免同图多次替换互相覆盖/互相迁移 issue）。
  function issueRunPrompt(project, diagram, issues, ciKey) {
    const lines = [
      `【Issue 自动执行 · 解决 Issue】范围：「${project ?? '未分类'}」`,
      '',
      `图「${diagram.title}」(id=${diagram.id}，类型=${diagram.type}) 有 ${issues.length} 个开启的 issue（本会话一次处理）：`,
    ];
    for (const issue of issues) {
      lines.push(`- issue #${issue.id}：${issue.title}`);
      if (issue.body) lines.push(`  描述：${issue.body}`);
      if (issue.nodes?.length) lines.push(`  目标标签：${issue.nodes.map((n) => `${n.label}(${n.id})`).join('、')}`);
    }
    lines.push(
      '',
      '处理流程（全部 issue 合并为一次 spec 修订）：',
      `1) 读该图 spec：${specPathOf(diagram)}，理解现状；`,
      `2) 结合项目本地代码核实：你的 cwd 就是项目根——若目录里有源码/README/文档，必须先在代码里核实各 issue 涉及的组件与关系（真实名字、调用路径、表/主题名逐字对照），issue 描述与代码事实冲突时以代码为准并在汇报中说明；纯文档型项目按文档核实；`,
      '3) 逐条分析诉求，相互冲突时以代码事实取舍并在汇报中说明取舍；',
      `4) 把全部修改合并进 spec：写临时文件，用 node ${archifyBin()}/bin/archify.mjs validate ${diagram.type} <临时spec> --json 校验，循环修复到 0 error；`,
      `5) POST ${apiBase()}/api/import，请求体 {kind:"archify", spec:<修改后的spec对象>, folder:${JSON.stringify(diagram.folder ?? null)}, replace:"${diagram.id}"}——**只替换这一次**（一次替换覆盖全部 issue 的修改；replace 会把旧图的 issue 自动迁移到新图、旧图删除）。${ciAuthNote(ciKey)}；`,
      `6) 替换成功后逐条检查：已解决的 issue 逐个 PATCH ${apiBase()}/api/issues/<id> 请求体 {status:"closed"}（已随旧图清理的就不用管）；属于提问 / 暂不采纳的建议，不要改图也不要关闭，说明原因即可；`,
      '',
      '最后用几句话汇报：改了什么 / 每个 issue 是关闭还是保留及原因。',
    );
    return lines.join('\n');
  }

  // 创建类 issue（kind=new-feature）的执行 prompt：code-diagram 六阶段的单图版。
  // 用户在目录行「＋」提的创建 issue → 流水线在此落实；**项目有代码必须结合代码**。
  function creationIssuePrompt(issue, ciKey) {
    const folder = issue.folder ?? null;
    const lines = [
      `【Issue 自动执行 · 创建新图】目标图集目录：「${folder ?? '未分类（图集根）'}」`,
      '',
      `【需求（issue #${issue.id}）】${issue.title}`,
    ];
    if (issue.body) lines.push(`【补充说明】${issue.body}`);
    lines.push(
      '',
      '按 code-diagram 六阶段执行（完整流程与验收清单：C:/Users/24483/.agents/skills/code-diagram/SKILL.md）：',
      '1) 你的 cwd 就是项目根。**先结合项目代码**：读 README / 依赖清单 / 目录骨架 / 入口与路由，需求涉及的组件、调用路径、表/主题名必须在代码里逐字核实；若项目根没有 AGENTS.md，先扫代码写出一份（≤120 行，只写可验证事实并括注来源），已存在则不重写；',
      '2) 把需求映射成图类型（architecture/workflow/sequence/dataflow/lifecycle）与范围；宽泛需求默认出 1 张系统级架构图，本轮只出 1 张；',
      '3) 代码取证：图中每个组件、每条连线都要有代码证据，凑不齐证据的不画并记录；纯文档型项目按文档取证；目录里既无代码也无文档时才按需求文字推理，且必须在汇报中声明「无代码/文档依据，图为需求推理」；',
      `4) 写 archify spec：quality_profile=showcase、locale=zh、8-15 个主节点、模块内部用 children 嵌套（示例见 ${archifyBin()}/examples/*.json）；`,
      `5) 校验循环：node ${archifyBin()}/bin/archify.mjs validate <type> <临时spec文件> --quality showcase --json，逐条修复到 0 error 0 warning；`,
      `6) 导入图集：POST ${apiBase()}/api/import，请求体 {kind:"archify", spec:<spec对象>, folder:${JSON.stringify(folder)}}——这是全新图，不要带 replace。${ciAuthNote(ciKey)}；curl 提交含中文 JSON 时先写 UTF-8 临时文件再 --data @文件；`,
      `7) 成功导入后 PATCH ${apiBase()}/api/issues/${issue.id} 请求体 {status:"closed"}（服务端也会按出图结果自动关闭，双保险）；导入失败则不要关闭，说明原因。`,
      '',
      '最后用一两句话汇报：出图清单（标题/类型）+ 证据基础 + 略去项声明。',
    );
    return lines.join('\n');
  }

  // ---- 执行（Issue 统一流水线：缺陷类改图 + 创建类出图，多会话并发） ----
  // project=null 表示未分类（无自动调度，仅提交驱动/手动触发）。
  // onlyIssueId 指定时只处理该条 issue（看板「立即执行」单条拉起）。
  // 会话模型：缺陷类按图分组（同图开启 issue 一个会话、一次 spec 修订 + 一次 replace）；
  // 创建类一条一个会话，同目录的创建组串行（出图证据按目录判定，并发会互相误认对方的图）。
  async function executeRun(project, trigger, onlyIssueId = null) {
    const startedMs = nowMs();
    const startedAt = new Date(startedMs).toISOString();
    runSeq += 1; // 并行 run 同毫秒启动也不撞 id（runClaims 拿它当键）
    const run = { id: `${startedMs.toString(36)}-${runSeq}`, project: project ?? null, kind: 'issues', trigger, startedAt, status: 'running', sessions: [] };
    if (onlyIssueId != null) {
      run.issueId = onlyIssueId;
      const target = openIssuesInProject(project).find((i) => i.id === onlyIssueId);
      if (target) run.issueTitle = target.title.slice(0, 120);
    }
    // 项目 CI 专属模型 > 全局 agent 设置 > 后端默认；记录进 history 便于排查
    const modelValue = (project != null ? db.settings.projects[project]?.model : undefined) || agentSettings().model || '';
    if (modelValue) run.model = modelValue;
    db.history.unshift(run);
    if (db.history.length > HISTORY_MAX) db.history.length = HISTORY_MAX;
    currentRuns.push(run);
    persist();
    let ciKey = null;
    try {
      if (!agentSettings().enabled) throw new Error('Agent 未启用（⚙ 设置）');

      const before = snapshotProject(project);
      const items = [];

      // 任务分组（同步原子段，结束即登记认领——两个 run 同时启动也不会认领同一条）：
      // 缺陷类按图聚合（同图 issue 一个会话合并处理），创建类一条一组；
      // 排除同项目在飞 run 已认领的 issue / 图（同 issue 重复处理、同图双 replace 都会打架）
      const { issues: claimedIssues, diagrams: claimedDiagrams } = claimedSetsFor(project);
      const open = openIssuesInProject(project)
        .filter((i) => onlyIssueId == null || i.id === onlyIssueId)
        .filter((i) => !claimedIssues.has(i.id))
        .filter((i) => i.kind === 'new-feature' || (i.diagramId && !claimedDiagrams.has(i.diagramId)))
        .slice(0, ISSUE_BATCH_MAX);
      if (!open.length) {
        throw new Error(onlyIssueId != null
          ? `issue #${onlyIssueId} 正在另一个运行中处理（或所属图正被处理）`
          : '没有开启状态的 issue（其余正在别的运行中处理）');
      }
      const bugByDiagram = new Map();
      const units = [];
      for (const issue of open) {
        if (issue.kind === 'new-feature') {
          units.push({ kind: 'create', issue });
          continue;
        }
        const diagram = readStore().diagrams.find((d) => d.id === issue.diagramId);
        if (!diagram) {
          items.push({ label: `#${issue.id} ${issue.title}`, ok: false, note: '图已不存在，跳过' });
          continue;
        }
        let unit = bugByDiagram.get(issue.diagramId);
        if (!unit) {
          unit = { kind: 'bug-group', diagram, issues: [] };
          bugByDiagram.set(issue.diagramId, unit);
          units.push(unit);
        }
        unit.issues.push(issue);
      }
      if (!units.length) throw new Error('没有可执行的 issue（所属图均已不存在）');
      // 认领登记（在任何 await 之前完成，见上）
      const claims = { issues: new Set(), diagrams: new Set() };
      for (const unit of units) {
        if (unit.kind === 'create') claims.issues.add(unit.issue.id);
        else {
          for (const i of unit.issues) claims.issues.add(i.id);
          claims.diagrams.add(unit.diagram.id);
        }
      }
      runClaims.set(run.id, claims);

      ciKey = ciGuard.begin();
      // 每组任务一次 SDK query()（cwd=项目目录）——无 serve 进程，用户会话/多项目 run 互不掐断
      const myCwd = projectCwd(project);

      const unitLabel = (unit) => (unit.kind === 'create'
        ? `✨ #${unit.issue.id} ${unit.issue.title}`
        : `#${unit.issues.map((i) => i.id).join(',#')}「${unit.diagram.title}」`);

      // 会话栏小字（看板「运行中」按会话分栏，小字 ≤15 字）：缺陷组 = 图名 + 缺陷编号
      // （图名超预算截断，保证编号在小字里可见）；创建组 = issue 标题（前端再截 15 字）
      const sessionDesc = (unit) => {
        if (unit.kind === 'create') return unit.issue.title;
        const ids = unit.issues.map((i) => `#${i.id}`).join(' ');
        const budget = Math.max(2, 15 - ids.length - 3);
        const t = unit.diagram.title;
        return `「${t.length > budget ? `${t.slice(0, budget)}…` : t}」${ids}`;
      };

      // 并发池：最多 limit 个会话同时跑。连续 2 组失败熔断（serve/模型坏了别硬跑）；
      // 等用户让路超时同样停止发起新组（已在跑的等它自然结束）
      const limit = concurrencyLimit();
      let launchIdx = 0;
      let consecutiveFails = 0;
      let stopLaunch = null; // 'idle'（让路超时）| 'circuit'（连续失败熔断）
      const settled = new Set();
      const results = []; // {unit, startMs, endMs, reply?|error?}，按完成顺序
      // 同目录创建组串行走全局 createFolderTails（跨 run 也互斥，见声明处注释）
      const runUnit = async (unit) => {
        settled.add(unit);
        if (!(await waitForIdle())) { stopLaunch ||= 'idle'; return; }
        // 会话栏条目（看板「运行中」分栏实时展示）：queued=已领任务排队（同目录创建组串行等前一组）
        const entry = { kind: unit.kind, desc: sessionDesc(unit), status: 'queued' };
        run.sessions.push(entry);
        persist();
        const exec = async () => {
          // 全局会话名额：拿到才建会话发消息（等待名额期间条目保持 queued）；
          // 消息结束（成败皆可）释放，名额可能直接移交给别的项目的 run
          await acquireSessionSlot();
          try {
            // 证据窗口按「本组消息开始」算：并发/同 run 其他组的产物不会误判为这一组的证据
            const startMs = nowMs();
            const sessionTitle = unit.kind === 'create'
              ? `Issue 执行 · 新图「${unit.issue.title.slice(0, 40)}」`
              : `Issue 执行 · 图「${unit.diagram.title.slice(0, 40)}」×${unit.issues.length}`;
            const session = await createAgentSession({ cwd: myCwd, title: sessionTitle, folder: project ?? null });
            if (!session?.id) { entry.status = 'failed'; persist(); return { unit, startMs, endMs: nowMs(), error: 'Agent 会话创建失败' }; }
            entry.status = 'running';
            entry.startedAt = new Date(nowMs()).toISOString();
            persist();
            const prompt = unit.kind === 'create'
              ? creationIssuePrompt(unit.issue, ciKey)
              : issueRunPrompt(project, unit.diagram, unit.issues, ciKey);
            const reply = await runAgentUnit(session, prompt, modelValue);
            return { unit, startMs, endMs: nowMs(), reply };
          } finally {
            releaseSessionSlot();
          }
        };
        const gateKey = unit.kind === 'create' ? `${project ?? ''}|${unit.issue.folder ?? ''}` : null;
        const tail = gateKey ? createFolderTails.get(gateKey) : undefined;
        const running = tail ? tail.then(exec) : exec();
        if (gateKey) createFolderTails.set(gateKey, running.catch(() => {}));
        const rec = await running;
        entry.status = (rec.error || rec.reply?.error) ? 'failed' : 'done';
        entry.finishedAt = new Date(nowMs()).toISOString();
        persist();
        results.push(rec);
        if (rec.error || rec.reply?.error) {
          consecutiveFails += 1;
          if (consecutiveFails >= 2) stopLaunch ||= 'circuit';
        } else {
          consecutiveFails = 0;
        }
      };
      const worker = async () => {
        while (!stopLaunch) {
          const unit = units[launchIdx];
          if (!unit) return;
          launchIdx += 1;
          await runUnit(unit);
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, units.length) }, worker));
      const skipped = units.filter((u) => !settled.has(u));
      for (const unit of skipped) {
        items.push({
          label: unitLabel(unit), ok: false,
          note: stopLaunch === 'idle' ? '等待用户操作让路超时，本组跳过' : '连续失败熔断，本组跳过（留待下轮）',
        });
      }

      // ---- 按客观证据自动关闭（全部会话结束后统一判定：并发产物先归位再认账） ----
      // 缺陷组的 replace 会把 issue 迁到新图 id——先收集本轮全部「替换产物」的新 id，
      // 创建组的出图证据要排除它们（同目录并发时区分「新图」与「改图替换」）
      const replacedIds = new Set();
      for (const rec of results) {
        if (rec.unit.kind !== 'bug-group') continue;
        for (const issue of rec.unit.issues) {
          const fresh = listIssues().find((x) => x.id === issue.id);
          const diag = fresh ? readStore().diagrams.find((d) => d.id === fresh.diagramId) : null;
          if (diag && Date.parse(diag.importedAt || 0) > rec.startMs) replacedIds.add(diag.id);
        }
      }
      for (const rec of results) {
        const unit = rec.unit;
        const failed = rec.error || rec.reply?.error;
        if (failed) {
          items.push({ label: unitLabel(unit), ok: false, note: String(failed).slice(0, 200) });
          continue;
        }
        if (unit.kind === 'create') {
          // 创建类：本组消息期间目标目录新增了图（排除缺陷组替换产物）→ 自动关闭
          const createdHere = readStore().diagrams.filter((d) => (d.folder ?? null) === (unit.issue.folder ?? null)
            && Date.parse(d.importedAt || 0) > rec.startMs && Date.parse(d.importedAt || 0) <= rec.endMs
            && !replacedIds.has(d.id));
          if (createdHere.length) {
            try { closeIssue(unit.issue.id); } catch { /* agent 已关闭或已删除 */ }
          }
          const note = `${createdHere.length
            ? `生成 ${createdHere.length} 张图并关闭 issue：${createdHere.map((d) => `「${d.title}」`).join('、')}。`
            : '未新增图（issue 保持开启待下轮）。'}${(rec.reply.text || '').slice(0, 200)}`;
          items.push({ label: unitLabel(unit), ok: true, note });
        } else {
          // 缺陷组：本组消息期间所属图被替换/更新（issue 已随 replace 迁到新图 id，按最新
          // 状态判断），该组仍开启的 issue 全部自动关闭；agent 主动关了就不再动
          let closedHere = 0;
          for (const issue of unit.issues) {
            const fresh = listIssues().find((x) => x.id === issue.id);
            if (!fresh || fresh.status !== 'open') continue;
            const diag = readStore().diagrams.find((d) => d.id === fresh.diagramId);
            if (diag && Date.parse(diag.importedAt || 0) > rec.startMs) {
              try { closeIssue(issue.id); closedHere += 1; } catch { /* 刚被并发关闭/删除 */ }
            }
          }
          const note = `${closedHere ? `图已更新、${closedHere} 个 issue 自动关闭。` : ''}${(rec.reply.text || '').slice(0, 200)}`;
          items.push({ label: unitLabel(unit), ok: true, note });
        }
      }

      // 客观成效：比对运行前后的图导入时间 / issue 状态
      const after = snapshotProject(project);
      const touched = after.diagrams.filter((d) => Date.parse(d.importedAt || 0) > startedMs);
      const generated = touched.filter((d) => !before.diagramIds.has(d.id)).length;
      const closed = before.issues.filter((b) => b.status === 'open' && after.byId.get(b.id)?.status === 'closed').length;
      const createdIssue = after.issues.filter((a) => !before.byId.has(a.id)).length;
      const processedIssues = results.reduce((n, r) => n + (r.unit.kind === 'create' ? 1 : r.unit.issues.length), 0);
      run.counts = { items: items.length, closedIssues: closed, generated, changed: touched.length, newIssues: createdIssue };
      run.summary = `处理 ${processedIssues} 个 issue（${results.length} 个会话、并发上限 ${limit}）：`
        + `关闭 ${closed}、生成图 ${generated}、更新图 ${touched.length}、新提 ${createdIssue}`
        + (skipped.length ? `；（${stopLaunch === 'idle' ? '让路超时中止' : '连续失败熔断'}，跳过 ${skipped.length} 组）` : '');
      run.items = items.slice(0, 20);
      run.status = 'ok';
      // 全部条目失败按失败运行记录（看板显示「↻ 重新拉起」）；部分失败保持 ok（摘要里可见）
      if (items.length && items.every((x) => !x.ok)) {
        run.status = 'error';
        run.error = (items.find((x) => !x.ok)?.note || '全部条目执行失败').slice(0, 400);
      } else if (stopLaunch === 'idle') {
        // 与旧版语义一致：让路超时按失败运行记录（已完成的组不回滚，issue 保持开启待下轮）
        run.status = 'error';
        run.error = '等待用户操作让路超时，中止本次运行';
      }
    } catch (error) {
      run.status = 'error';
      run.error = String(error?.message || error).slice(0, 400);
    } finally {
      run.finishedAt = new Date(nowMs()).toISOString();
      if (ciKey) ciGuard.end(ciKey); // 运行结束吊销本 run 的凭证（图集写保护，见 server.mjs guardGalleryWrite）
      const idx = currentRuns.indexOf(run);
      if (idx >= 0) currentRuns.splice(idx, 1);
      runClaims.delete(run.id);
      if (project != null) {
        ensureState(project);
        // 无论成败都从本次运行起算冷却，防止坏流水线每 30s 重试
        db.state[project].issues.lastRunAt = run.startedAt;
        db.state[project].issues.lastResult = run.status === 'ok' ? run.summary : run.error;
        // 到量触发的防重跑护栏：上次是否失败 / 是否有成效（关了 issue 或动了图）/
        // 运行结束那一刻的开启 issue 数（之后没有新增就不再立刻到量重跑，等到时）
        db.state[project].issues.lastStatus = run.status;
        db.state[project].issues.lastProductive = Boolean(
          (run.counts?.closedIssues || 0) + (run.counts?.generated || 0) + (run.counts?.changed || 0));
        db.state[project].issues.lastOpenAfter = openIssuesInProject(project).length;
      }
      persist();
      drainPendingKick(); // 有刚提交的创建 issue → 该项目空了就立即接续执行
    }
  }

  // 提交「创建新图」issue 后驱动流水线（保持原「＋」提交即执行的体验）。
  // 同项目已在跑也照样开新 run（issue 级认领互斥）；全部 issue 都被在飞 run 认领时
  // 留在 pendingKick，由 run 结束的 finally / 下一拍 tick 接续。
  function kickIssueRun(project) {
    pendingKick.add(project ?? null);
    drainPendingKick();
  }

  function drainPendingKick() {
    if (!agentSettings().enabled) return; // 留在集合里，重新启用后由 tick 消化
    for (const project of [...pendingKick]) {
      if (!openIssuesInProject(project).length) {
        pendingKick.delete(project); // issue 已被关闭/删除：无事可做
        continue;
      }
      if (!unclaimedIssues(project).length) continue; // 全被在飞 run 认领：留在集合里，run 结束再接续
      pendingKick.delete(project);
      executeRun(project, 'issue-filed').catch(() => { /* executeRun 自带 finally 收尾 */ });
    }
  }

  // ---- 对外接口 ----
  // 设置保存。两种粒度：
  // - 全局：body.maxConcurrentSessions（会话并发上限 1-8）——可单独提交，也可随项目设置一起来
  // - 项目：body.project + issueAuto / model（触发方式与项目执行模型）
  function saveSettings(body) {
    const hasGlobal = body.maxConcurrentSessions !== undefined;
    const hasProjectFields = body.issueAuto !== undefined || body.model !== undefined;
    const project = typeof body.project === 'string' ? body.project.trim() : '';
    if (!hasGlobal && !hasProjectFields) return { status: 400, body: { error: '没有要保存的设置' } };
    if (hasGlobal) {
      const prevLimit = db.settings.maxConcurrentSessions;
      db.settings.maxConcurrentSessions = clampInt(body.maxConcurrentSessions, 1, 8, DEFAULTS.maxConcurrentSessions);
      if (db.settings.maxConcurrentSessions > prevLimit) pumpSessionSlots(); // 上调立即放行排队会话
    }
    let saved = { maxConcurrentSessions: db.settings.maxConcurrentSessions };
    if (hasProjectFields || project) {
      if (!project || project.includes('/')) return { status: 400, body: { error: 'project 需为顶层目录名（不含“/”）' } };
      if (!readStore().folders.includes(project)) return { status: 404, body: { error: `项目目录不存在：${project}` } };
      const prev = db.settings.projects[project] || { issueAuto: { ...DEFAULTS.issueAuto } };
      const next = { issueAuto: { ...prev.issueAuto } };
      if (body.issueAuto) {
        next.issueAuto = {
          enabled: body.issueAuto.enabled === true,
          threshold: clampInt(body.issueAuto.threshold, 1, 100, DEFAULTS.issueAuto.threshold),
          intervalMinutes: clampInt(body.issueAuto.intervalMinutes, 1, 10080, DEFAULTS.issueAuto.intervalMinutes),
        };
      }
      // 项目专属模型（provider/model 格式，空 = 跟随全局 agent 设置）
      if (body.model !== undefined) next.model = String(body.model).trim().slice(0, 60);
      else if (prev.model) next.model = prev.model;
      if (!next.model) delete next.model;
      db.settings.projects[project] = next;
      ensureState(project);
      saved = { ...saved, project, ...next };
      // 启用瞬间（false→true）重置计时：首个周期从现在起算，想立刻跑用「立即运行」；
      // 到量护栏一并清零——存量积压已 ≥ 阈值时，下一拍的到量触发即接手
      if (next.issueAuto.enabled && !prev.issueAuto.enabled) {
        const s = db.state[project].issues;
        s.lastRunAt = new Date(nowMs()).toISOString();
        delete s.lastStatus;
        delete s.lastProductive;
        delete s.lastOpenAfter;
      }
    }
    persist();
    return { status: 200, body: { saved } };
  }

  // 手动触发（看板「立即运行」/ 待执行 issue 的「立即执行」/ 失败记录的「重新拉起」）；
  // project=null 表示未分类（无设置，仅手动）；issueId 指定时只执行该条。
  // 同项目可多 run 并行（用户要求）——唯一互斥是 issue 级认领：同一条 issue / 同一张图
  // 的缺陷组不进两个 run（同图双 replace 会互相覆盖）；全局会话名额自然协调总并发。
  function triggerRun(project, issueId = null) {
    if (!agentSettings().enabled) {
      return { status: 400, body: { error: '请先在 ⚙ 设置中启用 Agent——流水线通过 Agent 执行' } };
    }
    const scope = project == null || project === '' ? null : String(project);
    if (scope != null && (scope.includes('/') || !readStore().folders.includes(scope))) {
      return { status: 404, body: { error: `项目目录不存在：${scope}` } };
    }
    const open = openIssuesInProject(scope);
    if (issueId != null) {
      const target = open.find((i) => i.id === issueId);
      if (!target) {
        return { status: 404, body: { error: `issue #${issueId} 不在该范围内或已关闭` } };
      }
      const { issues, diagrams } = claimedSetsFor(scope);
      if (issues.has(issueId) || (target.kind !== 'new-feature' && diagrams.has(target.diagramId))) {
        return { status: 409, body: { error: `issue #${issueId} 正在另一个运行中处理——等它结束` } };
      }
    } else {
      if (!open.length) return { status: 400, body: { error: '该范围内没有开启状态的 issue' } };
      if (!unclaimedIssues(scope).length) {
        return { status: 409, body: { error: '该范围内的开启 issue 都在别的运行中处理——等它们结束' } };
      }
    }
    executeRun(scope, 'manual', issueId).catch(() => { /* executeRun 自带 finally 收尾 */ });
    return { status: 200, body: { started: true } };
  }

  async function tick() {
    drainPendingKick(); // 刚提交的创建 issue 优先（用户显式提交的比周期调度急）
    if (!agentSettings().enabled) return;
    const store = readStore();
    const now = nowMs();
    for (const project of Object.keys(db.settings.projects)) {
      if (isProjectRunning(project)) continue; // 在跑的项目不重复启动（多项目可并行）
      if (!store.folders.includes(project)) continue;
      const cfg = db.settings.projects[project];
      ensureState(project);
      if (!cfg.issueAuto?.enabled) continue;
      const open = openIssuesInProject(project);
      if (!open.length) continue;
      const s = db.state[project].issues;
      const last = Date.parse(s.lastRunAt || 0) || 0;
      const intervalMs = (cfg.issueAuto.intervalMinutes || DEFAULTS.issueAuto.intervalMinutes) * 60_000;
      // 自动触发是「或」：到量（开启 issue 达到阈值即跑，不必等间隔）或 到时
      // （距上次运行满间隔、还有开启 issue 就跑）。防重跑护栏见文件头注释。
      const toTime = now - last >= intervalMs;
      const grewSinceRun = s.lastOpenAfter == null || open.length > s.lastOpenAfter;
      const toCount = open.length >= (cfg.issueAuto.threshold || DEFAULTS.issueAuto.threshold)
        && s.lastStatus !== 'error'
        && ((s.lastProductive ?? true) || grewSinceRun);
      if (toTime || toCount) {
        // 不 await：run 后台跑（多项目并行，全局会话名额控并发），下一拍 tick 会跳过在跑项目
        executeRun(project, 'auto').catch(() => { /* executeRun 自带 finally 收尾 */ });
      }
    }
  }

  function snapshot() {
    return {
      agentEnabled: agentSettings().enabled,
      // 在飞 run（多项目并行，同项目互斥）：全局看板「正在运行」一 run 一卡
      runs: currentRuns.map((r) => ({
        project: r.project ?? null,
        kind: r.kind,
        startedAt: r.startedAt,
        ...(r.issueId != null ? { issueId: r.issueId, issueTitle: r.issueTitle } : {}),
        sessions: r.sessions || [],
      })),
      activeSessions,
      sessionLimit: concurrencyLimit(),
      // 排队中的项目（提交创建 issue 时该项目正忙 → pendingKick，run 结束即接续）
      kicked: [...pendingKick],
      maxConcurrentSessions: concurrencyLimit(),
      projects: db.settings.projects,
      state: db.state,
      history: db.history.slice(0, 30),
      serverTime: nowMs(),
      defaults: DEFAULTS,
    };
  }

  function start() {
    return setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  }

  return { saveSettings, triggerRun, kickIssueRun, snapshot, start, tick };
}
