# 代码取证清单（按图类型）

原则：**先台账、后 spec**。动手写 spec 前，把打算画的每个组件、每条连线连同证据列成台账（临时文件或回复草稿均可）。台账里没有证据的条目删除，而不是「先画上再说」。

台账格式：

| 图元素 | kind | 证据（路径 或 路径:行） | 备注 |
|---|---|---|---|
| 订单服务 | node/backend | src/services/order/（独立进程：package.json scripts.order:dev） | |
| 订单服务 → 订单库 | edge | src/services/order/repo/schema.prisma（model Order） | 表 orders |

## 通用取证手法

- **入口追踪**：从启动文件（`server.mjs`/`main.go`/`app.py`/`index.ts`）顺藤摸瓜，比横扫全仓库快且准
- **路由表 = 天然组件清单**：HTTP 路由注册、gRPC service 定义、事件订阅声明
- **依赖清单 = 外部系统清单**：manifests 里的 DB driver、消息 SDK、云 SDK、HTTP 客户端 → external/database/messagebus/cloud 节点
- **配置 = 真实资源名**：`.env.example`、`config/*.yaml` 里的连接串变量、表名、主题名、第三方域名
- **grep 找跨进程边**：`fetch(`、`axios`、`http.Client`、`createPool`、`publish`、`subscribe`

## architecture（最常用）

节点证据源与类型映射：

| 真实物 | 类型 | 证据 |
|---|---|---|
| 目录/模块 | backend | 真实路径（组件名可用目录名） |
| Web 前端目录 | frontend | 目录构成（框架清单、页面组件） |
| 独立服务/进程 | backend | 启动入口 + 清单 script |
| 数据库/缓存 | database | schema/模型定义、连接配置 |
| 网关/鉴权中间件 | security | 中间件注册处 |
| 消息/事件总线 | messagebus | 主题/队列声明 |
| 云资源 | cloud | IaC/SDK 调用处 |
| 第三方 API | external | HTTP 客户端调用处 |

边证据（标签怎么写）：

- 同进程 import/调用 → 不标或标具体动作名
- 跨进程 HTTP/gRPC → `POST /orders`、`OrderService/Create`
- DB 访问 → 标表名或用途
- 消息收发 → 标主题名

粒度：一张图 8-15 个主节点；模块内部结构用嵌套 `children`（每层 ≤6，真实归属才用）；正交关注点（安全域/部署域）用 boundary。

## sequence

- 参与者 = 真实进程/服务/客户端/网关；从路由 handler 顺调用链读（controller → service → repository → DB）
- `await`/队列/重试结构是异步、重试、超时消息的唯一证据，不凭「常识」补

## workflow

- 步骤 = 代码里真实存在的阶段：管道定义、作业编排、审批流引擎的状态定义
- CI/CD：编排文件（`.github/workflows`、`.gitlab-ci.yml`、`Makefile`）本身就是证据
- 分支/门禁对应代码里的条件判断与校验点

## dataflow

- source/pipeline/sink 全部对应真实产物：表、桶、主题、导出文件、报表
- 血缘从 SQL/ETL 脚本/调度定义里读，不从目录名猜

## lifecycle

- 状态集合 = enum/常量/状态机定义，逐个列出，不增不减
- 转移 = 状态写入/判断处；终止态、失败态、可恢复态都要有出处

## 反模式（出现即返工）

- 组件叫「缓存」「消息队列」但代码里找不到对应客户端/配置——泛化脑补
- 边标签是「调用」「使用」这种无信息量的词，而代码里明明有路径/方法名
- 为了让图「看起来完整」补的链路（网关→鉴权→…），其中一半没有证据
- 把框架内部机制（如 ORM 连接池）画成业务组件
