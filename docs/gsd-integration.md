# OpenMausBot / GSD Core 本机桥接

此桥接用于单机个人试用。OpenMaus 主控通过 `openmaus-gsd-bridge` 技能准备工作区，并通过已有协调机制交给带 `openmaus-gsd-worker` 技能的代码助手；GSD 在对应工作区执行研发工作。普通对话和现有目标数据不需要迁移。

## 用户如何使用

在主控对话中说明要使用 GSD、具体 Git 仓库、要实现的目标及验收方式。例子：

> 请用 GSD 处理 `C:\path\to\repository`：实现……；先规划并在隔离工作区执行，运行……测试。完成后告诉我变更、测试和提交情况。

主控准备工作区后会创建关联的目标记录，再找到代码助手并交办；准备或派工不是完成。用户明确指定已有目标 ID 时可关联已有目标。用户没有给清楚目标仓库或既有目标身份时不得猜测。

## 工作区与状态

`scripts/gsd-bridge.mjs prepare --repository <绝对 Git 根目录> --task <稳定 ID>` 在本机试用数据下创建独立的脱离分支工作树，固定来源仓库的当前 HEAD，使用固定版本的本机 npm 包安装 GSD Core v1.21.0。源仓库有未提交改动、已有受跟踪的 `.codex` 或任务 ID 冲突时拒绝准备；相同任务 ID 的重复请求返回原记录。

`node scripts/gsd-bridge.mjs status --task <ID>` 返回工作区、HEAD、受跟踪改动、未跟踪文件计数和 GSD 进度摘要。它是只读状态投影，不验证代码正确性、真实测试或提交。准备出错会保留 `needs_inspection` 状态和工作区，避免自动重复创建。数据在 `.persistent-work-trial/gsd-integration`，该目录不加入 Git。

默认安装包位于项目父目录的 `intake/gsd-core-package-v1.21.0/package`。安装器通过隔离的 `GSD_HOME` 执行，不应再改写用户级 GSD 默认值。该本机目录不是随 Git 代码一起分发的依赖，换机器须重新准备官方固定版本。

OpenMaus 试用进程的 PATH 可能不包含 Git。安装时运行 `node scripts/configure-gsd-bridge.mjs` 记录本机 Git 可执行文件路径；若已有配置不可用，脚本会停止而不覆盖。随后 `node scripts/install-gsd-bridge.mjs` 向当前唯一主控和软件开发助手安装技能并读回验证；发现同名不同内容的技能时保留原技能并停止。

## 阶段同步

服务运行时定期从绑定工作树的 GSD `ROADMAP.md` 和阶段目录读取阶段信息，写入 `goals.db` 的 `goal_gsd_links`；聊天界面的任务栏显示阶段列表。尚未生成路线图时显示“尚未建立计划”；读取失败时保留上一次结果并显示同步失败。进度来自 GSD，不会自动更改目标或任务的验收状态，也不会自动启动第二份执行。

准备成功后可用 `node --experimental-strip-types scripts/gsd-create-goal.ts --task <任务ID> --title <标题> --request <完整要求>` 创建关联；同一任务重复请求返回同一个目标。要关联明确指定的已有目标，使用 `--task <任务ID> --goal <目标ID>`。当前一个 GSD 任务只能关联一个目标，一个目标也只关联一个 GSD 任务；关联冲突会被拒绝。只有本机个人试用模式使用此命令。

## 当前边界

- GSD 阶段单向同步到目标数据库；从 OpenMaus 更改目标不会反写 GSD 路线图。主控应核对实际输出、测试和 Git 状态。
- 隔离工作区从干净源仓库的 HEAD 创建，原仓库的未提交工作不会带入。工作区默认 detached，不自动提交、推送、合并或部署。
- 宿主是否支持 GSD 指定的子 Agent、审批和连续执行，需要在实际环境逐项验证；不能因为 `gsd-fast` 完成而声称完整多阶段自动开发通过。
- GSD 可执行代码，受实际 Codex 会话权限约束；桥接脚本不是安全沙箱，也不构成项目、工作树或费用的系统级访问隔离。
