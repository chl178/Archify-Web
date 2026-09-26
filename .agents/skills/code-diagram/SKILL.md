---
name: code-diagram
description: Turn a codebase into accurate, validated Archify diagrams in the Archify-Web gallery, driven by the user's prompt. Writes the project's AGENTS.md first (equivalent to opencode /init) when none exists. Use whenever the user asks to generate diagrams from source code — "根据代码生成图", "给这个项目画架构图", "梳理一下这个系统", "把流程画出来" — especially for a new or empty gallery project folder, or any request for 架构图/流程图/时序图/数据流图/状态图 based on real code.
license: MIT
---

# code-diagram — 代码 → 图集出图

把一个代码项目（尤其是图集里刚建好、还没有图的空项目）变成一组**基于代码、可验证**的图。
执行环境：工作目录 = 项目根（图集目录的 localPath），图集服务在 http://127.0.0.1:8766。

一句话流程：**没有 AGENTS.md 先 init → 解析 prompt → 代码取证 → 写 spec → 校验 0 error → 导入 → 双清单验收**。
准确性的核心在阶段 3：图上每个节点、每条连线都必须有代码证据，宁缺毋滥。

## 环境事实

| 项 | 值 |
|---|---|
| 工作目录 | 项目根（opencode serve 的启动目录） |
| 图集 API | `GET /api/diagrams`（清单）；`POST /api/import {kind:"archify", spec, folder, replace?}`（**写保护**：只放行浏览器来源或带 `x-archify-ci-key` 运行凭证的 CI 任务，见阶段 5） |
| 图落盘位置 | `<localPath>/graph/<图id>/`（服务端 API 代写；纯本地系统，无 upload 概念，不手工往里复制文件） |
| archify 工具链 | `C:/Users/24483/Documents/Archify-Web/archify`（规范示例 `examples/*.json`） |
| 出图规范 | 以 archify skill 的 authoring invariants 为准——本 skill 只在其上叠加「基于代码」的约束 |

## 阶段 0 · 定向

1. 列出项目根目录，确认这是代码项目（有源码/清单文件）；纯文档或空仓库则停下，向用户说明没有可出图的代码。
2. 项目根有 `AGENTS.md`？没有 → 阶段 1；有 → 直接阶段 2。
3. 从消息的【上下文】读当前图集目录，`GET /api/diagrams` 确认目录存在、看现有图（重生成要用 replace）。

## 阶段 1 · 项目初始化（等价 /init）

按 [references/init-agents-md.md](references/init-agents-md.md) 扫描代码，在项目根写出 `AGENTS.md`。
不得跳过：它既是给后续人与 agent 的说明书，也是阶段 3 取证的索引。
已存在 `AGENTS.md` 时绝不重写（除非用户明确要求更新）。

## 阶段 2 · 需求解析

把用户 prompt 映射成图清单（类型 × 范围）：

| 用户话语 | diagram_type |
|---|---|
| 架构 / 系统组成 / 模块划分 / 技术栈 | `architecture` |
| 流程 / 步骤 / 审批 / CI/CD | `workflow` |
| 调用链 / 时序 / 请求生命周期 | `sequence` |
| 数据流 / ETL / 管道 / 血缘 | `dataflow` |
| 状态机 / 生命周期 / 订单状态流转 | `lifecycle` |

- prompt 宽泛（「梳理一下这个项目」）→ 默认先出 **1 张系统级架构图**（模块粒度），其余列为下一步建议。
- 范围明确就按 prompt 出；每轮消息最多 2-3 张（图集桥接单条消息有 ~280s 上限），多出的明说下轮继续。

## 阶段 3 · 代码取证（准确性的核心）

按 [references/code-evidence.md](references/code-evidence.md) 的分类型清单取证。**先台账、后 spec**：
把打算画的每个组件/连线连同证据路径列成台账，凑不齐证据的条目直接删，不进 spec。

- 组件名 = 代码里的真实名字（目录名/服务名/表名/主题名），可读化但必须一一对应
- 连线标签里的协议、路径、表名、主题名逐字来自代码
- 禁止臆测：「看起来应该有」的关系要么去代码里验证，要么略去并记录

## 阶段 4 · 写 spec

- 走 archify 的 fast authoring path：读一个匹配的 schema + example，artifact first（先写候选再讨论几何）
- 本 skill 叠加的约束：
  - `meta.quality_profile: "showcase"`；`meta.locale` 跟随用户语言（中文 → `"zh-CN"`）
  - 系统级架构图 8-15 个主节点；模块内部结构用嵌套 `children`（真实归属才用），跨系统边界用 boundary
  - 边标签写真实语义：HTTP 方法+路径 / gRPC 方法 / 表名 / 消息主题 / 具体动作
- 临时文件放项目根（`.tmp-diagram-<type>.json`），导入完成后删除

## 阶段 5 · 校验 → 导入

```bash
node "C:/Users/24483/Documents/Archify-Web/archify/bin/archify.mjs" validate <type> .tmp-diagram-<type>.json --quality showcase --json
```

- 诊断按 code/evidence/supportedFixes 逐条修，重校验到 **0 error 0 warning**（receipt 只有 4 项 artifact checks 是 basic，9 项全过才是 showcase）
- 连续两轮错误数不降 → 停下，如实报告未解决的诊断
- 导入（服务端还会独立再校验一次；本地过了仍 422 就读返回的 receipt 修）。图集写 API 有**写保护**，只放行浏览器（用户前端）或带运行凭证的 CI/生成任务——无凭证直接导入会得到 403 `agent-direct-blocked`：

```bash
curl -s -X POST http://127.0.0.1:8766/api/import \
  -H "Content-Type: application/json" \
  -H "x-archify-ci-key: <任务消息下发的运行凭证，仅 CI/生成任务消息里有>" \
  --data @.tmp-import.json
```

  body：`{"kind":"archify","spec":<spec对象>,"folder":"<当前图集目录>"}`；**重生成同一主题必须加 `"replace":"<旧图id>"`**（内容变 id 变，不带会新旧两张卡并存）。
  含中文的请求体必须走 `--data @文件`（Git Bash 内联中文按 GBK 发送）。
- **无凭证上下文（交互会话）不能导入**：把成品方案落成 issue（改图），或请用户在目录行「＋」提交 AI 创建图（新图，需求里附方案要点）；收到 403 按此改道，不要重试
- 多图逐张「校验→导入」，一张失败不阻塞其余

## 阶段 6 · 验收与汇报

按 [references/quality-gates.md](references/quality-gates.md) 过双清单（准确性 A / 质量 B），然后汇报：

- 出了哪几张图（标题 · 类型）
- 每张图的证据基础 1-2 句（从哪些入口/文件取证）
- **主动声明略去了什么**（证据不足的组件/关系，无则写「无」）——这是可信度的来源，不是弱点

## 硬规则（违反任何一条即失败）

1. 项目根没有 `AGENTS.md` → 必须先走阶段 1 再出图；有 → 不得重写
2. spec 里每个节点、每条连线都要能追溯到代码证据；臆测 = 失败
3. 校验不过不入集；导入必带正确 folder；重生成必带 replace；CI/生成任务导入必带 `x-archify-ci-key` 凭证，无凭证上下文只提 issue / 引导「＋」
4. 名称真实性：代码里的名字原样（或可读化但一一对应）；协议/路径/表名/主题名逐字保留
5. 汇报必须包含「略去项」声明
