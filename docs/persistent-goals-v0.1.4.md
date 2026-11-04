# v0.1.4 任务续跑与交付检查

本次在 `codex/persistent-goals-chat-trial` 上增量开发，保留原有试用开关。任务状态和成果快照继续复用现有 Goal/Task/Attempt、权限、预算与复核服务。

## 已实现

- 新增工作角色工具 `save_goal_checkpoint`，保存有界的摘要、剩余工作、阻塞和下一步。记录绑定实际执行身份，并明确标为未验证的执行者笔记；它不能让任务完成。`goal_context` 返回当前事项的续跑记录。
- 任务续跑保持原 Task 和工作范围，在已有执行额度内创建新尝试。每轮的命令、执行根和工作会话使用任务续跑版本，避免与第一次执行冲突。
- 聊天任务列表对受阻事项提供“继续处理”，对已完成事项提供“补充要求”。提交前读取最新版本；网络重试使用同一命令 ID。用户核对现有文件和已发生的外部操作后，可按原要求续跑或追加要求。
- 用户追加要求保留原始要求，在当前任务中追加说明和必需的负责人复核条件。受影响任务及其传递下游恢复为待执行，旧复核失效；无关任务的通过状态和交付保留。
- 状态更新只允许在受影响的全部执行及复核确认停止后进行；活跃、重启待对账或停止不明的执行被拒绝。运行时提供只读停止证明，不借续跑清除重启 hold 或停止标记。
- 负责人复核现在取得原始要求和完整当前任务，用于反查遗漏和用户追加条件；原有确定性检查、逐项复核、产物哈希及最终重新读取继续生效。
- 旧记录与产物历史保留；失效任务的旧快照不再通过当前成果下载入口返回。重做完成后，报告抽屉选择每个逻辑成果的最新版本。

## 持久化与接口

数据库迁移至 schema 10，增加 `goal_task_checkpoints` 和 `goal_task_changes`；旧记录无需重写。目标存储与预算存储共用版本常量。任务续跑版本与全局原始需求版本分开，避免一次局部追加使所有无关任务失效。

在现有已配对 owner 和试用运行时下新增：

- `GET /api/persistent-work/{goals|items}/:id/tasks/:taskId/continuation`
- `POST /api/persistent-work/{goals|items}/:id/tasks/:taskId/resume`
- `POST /api/persistent-work/{goals|items}/:id/tasks/:taskId/amend`

POST 包含 `commandId`、`expectedVersion`、`instruction`、`externalStateChecked: true`。owner、事项归属和执行身份由宿主确定，不接受客户端或模型指定 owner。补充要求为追加式；替换或撤销旧要求、执行中自动合并补充消息仍需后续设计。

检查点只作为恢复线索。可信交付仍来自原检查结果、负责人复核及不可变产物快照。续跑必须重新查看当前文件和必要的外部操作回执；本次未实现各外部服务的通用去重或回滚。

## 验证

- 定向回归：22 个测试文件，146 项通过，覆盖目标、预算、权限、恢复、依赖失效、原生工具、路由、协调器与聊天组件。
- 新增文件流程测试：执行中保存进度并模拟中断，重开目标数据库，续跑生成实际文件，读取复核字节并批准；追加要求后重新交付，累计执行次数为 5，额度未重置。使用确定性假执行器，不代表真实模型效果。
- 新增 `scripts/verify-persistent-continuity.ts`，启动并自动清理密封假引擎服务，通过 doctor、owner 配对、创建事项、缺少结构化成果被阻塞、追加要求、原事项第二轮执行与累计预算验证。检查点与实际产物交付由上述文件流程测试覆盖。
- 隔离服务证据：同一事项版本从 1 到 2；缺少实际成果的两轮均受阻，累计用量 2，未被错误标为完成。
- 前后端 TypeScript 检查、变更代码 lint 和服务端构建通过。大型项目类型检查使用 `NODE_OPTIONS=--max-old-space-size=6144`。

复现定向检查：

```sh
pnpm exec vitest run server/goals server/drivers/agents-goal-tools.test.ts server/routes/persistent-work.test.ts src/components/PersistentWorkChat.dom.test.ts src/components/PersistentTaskContinuation.dom.test.ts server/runtime-coordinator.test.ts
node --experimental-strip-types scripts/verify-persistent-continuity.ts
NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck
NODE_OPTIONS=--max-old-space-size=6144 pnpm build:server
```

## 交付边界

本次为可审查开发增量，未部署或修改用户真实数据。沿用 v0.1.3 的本机试用与密封运行时限制，不宣称正式产品发布。

未进行真实模型、原生 Windows/Electron 安装包及新入口的真实浏览器视觉验收。目标级汇总交付、复杂事项自动返工策略、无人工介入的重启执行恢复、各服务外部动作去重、全量要求替换和持续事务自动触发不在本次新增实现内。已有无法确认停止的重启任务继续阻塞，不能以点击续跑绕过。
