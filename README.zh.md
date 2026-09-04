# DSH Researcher 插件

`dsh-profile-researcher` 为 DSH 研究模式增加项目级、跨会话的研究状态。它用于配合原生 Goal、Job、Subagent、Workflow 与 Session，而不是替代这些机制。

## 各层职责

- **Research target**：位于 `.research/goal/<research-id>/` 的长期项目事实。
- **DSH Goal**：当前会话的自动续跑驱动；objective 以 `[researcher:<research-id>]` 开头。
- **Research run**：一次真实执行、rerun、随机种子或参数实例。
- **DSH Session**：权威会话 transcript；session 与 target 的绑定承载在核心已知、可持久化的 `agent/inbox/spliced` 快照事件中。

Host service 是唯一领域权威，负责校验、写入、绑定、上下文注入和 Goal 激活。Web client 只用 DSH 标准 `popupSelect` 装饰裸 `/research-load`，选择后仍把完整命令提交回 Host。

## 项目目录

```text
.research/
  evo/                              # 预留；v1 不写 evolution 记录
  goal/<research-id>/
    goal.md                         # # Goal / ## Metrics / ## Baseline
    state.jsonl                     # append-only 的完整状态快照
    glossary.json                   # 目标特有术语和相关文件说明
    session/<base64url-session>.json
    runs/<run-id>.jsonl             # 描述记录 + 可选的不可变结果记录
```

Research ID 和 Run ID 均为随机 UUID v4。后续 DSH 会话必须显式加载：

```text
/research-load <research-id>
```

Web GUI 中输入裸 `/research-load` 会打开目标选择器。损坏目标仍以诊断行显示，但不能提交加载。

## 模型工具

- `get_research`：读取当前已绑定目标；刻意不提供模型侧 load/switch 工具。
- `create_research`：在顶层 agent 的直接人类轮创建并绑定目标。
- `update_research`：在有意义的结果或方向变化后追加状态快照。
- `start_research_run`：真实执行前打开唯一的当前 run。
- `finish_research_run`：不可变地关闭 run、校验产物，并追加对应状态。
- `update_research_glossary`：原子更新目标术语与真正相关文件的说明。

共享状态变更必须来自直接人类轮，或来自标记与当前 research target 精确匹配的当前 DSH Goal Round。Subagent 不能直接修改共享 researcher 状态，只能把证据与结果返回给顶层 agent。

## 可靠性约束

- 每次 load 都由 Host 重新校验项目记录；弹窗列表从不构成权威。
- 一个 DSH session 不能静默切换到另一 target。
- 若存在不同的未完成 DSH Goal，则失败关闭，绝不自动替换。
- v1 中 `complete` 为终态，不可重新打开。
- 每个 target 同时最多存在一个 open run。
- JSONL 逐条限制大小并校验 revision；只有看起来确实是写入中断的最后一个 state 片段才会带警告忽略。
- create、state update 与 run finish 在提交前都会验证固定 32 KiB 加载上下文；warnings 与其他可选上下文按确定规则截断。
- 已关闭 run 携带精确的预备 state transition；两文件 finish 中断后可安全重试一次，不会把旧状态覆盖到新状态之上，也不会重新要求已验收产物仍然存在。
- 写入使用 create-if-absent 或带版本的 replace，并配合进程内每目标 FIFO mutex。v1 明确不支持多个进程并发写同一 target；同一 workspace/target 只使用一个 DSH writer 进程。
- 权威目录和文件必须规范化、位于 workspace 与精确 target 根内，且不是符号链接。v1 的 staged 目录创建/提交要求 host-local workspace 文件系统。
- 不把 DSH transcript、完整工具日志或大产物复制到 `.research`。

若 target 已成功提交、但 Goal 激活失败，使用返回的 `/research-load <research-id>` 恢复。

## 开发检查

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
# 完整检查
pnpm run check
```

测试只使用并清理临时 workspace，不会在开发仓库中创建 `.research`。
