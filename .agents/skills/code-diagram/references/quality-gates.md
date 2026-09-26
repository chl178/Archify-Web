# 双清单验收 + 导入细节

## 清单 A：准确性（基于代码，导入前逐项核对）

- [ ] 每个组件在证据台账里有出处，名字与代码一致（或可读化但一一对应）
- [ ] 每条连线有代码依据；标签里的协议/路径/表名/主题名逐字来自代码
- [ ] 无臆测节点、边、技术栈；框架内部机制没有被画成业务组件
- [ ] 图类型与范围对应用户 prompt（偏离处已向用户说明）
- [ ] 因证据不足略去的条目已汇总（汇报用）

## 清单 B：质量（archify showcase，导入前）

- [ ] `validate <type> <spec> --quality showcase --json`：0 error、0 warning，9 项 artifact checks 全过
- [ ] `meta.quality_profile: "showcase"` 已显式设置；`meta.locale` 匹配用户语言（中文 → `zh-CN`）
- [ ] 一条清晰主路径；主节点 ≤12；边标签语义化且不碰撞（碰撞先挪标签/调路由，语义标签不许删）
- [ ] 容器（children）只用于真实归属，boundary 只用于正交范围
- [ ] 修复纪律：一次只改诊断点名的 subject；连续两轮错误数不降 → 停下如实报告

## 导入（图集 API）

请求体写入项目根的 `.tmp-import.json`（含中文禁止内联——Git Bash 会按 GBK 发送），然后（图集写保护：CI/生成任务必须带任务消息下发的运行凭证；无凭证的交互会话不能导入，改提 issue / 引导用户用「＋」）：

```bash
curl -s -X POST http://127.0.0.1:8766/api/import -H "Content-Type: application/json" -H "x-archify-ci-key: <任务消息下发的凭证>" --data @.tmp-import.json
```

body 结构：

```json
{ "kind": "archify", "spec": { }, "folder": "<当前图集目录>", "replace": "<旧图id，仅重生成时>" }
```

- 服务端会**再独立校验一次**：本地过了仍 422 → 读返回的 receipt，按诊断修，重走校验循环
- 重新生成同一主题的图必须带 `replace`，否则新旧两张卡并存
- 多图逐张「校验→导入」，一张失败不阻塞其余
- 全部完成后删除临时文件（`.tmp-diagram-*.json`、`.tmp-import.json`）

## 汇报模板

```
已出图：
- 「<标题>」· <类型> —— <证据基础 1-2 句>
略去项：<因证据不足未画的组件/关系；无则写「无」>
下一步（可选）：<更细粒度的模块图 / 时序图建议>
```
