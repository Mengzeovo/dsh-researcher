# DSH Researcher 插件

`dsh-profile-researcher` 为 DSH 研究模式增加项目级、跨会话的研究状态。它用于配合原生 Goal、Job、Subagent、Workflow 与 Session，而不是替代这些机制。

## 各层职责

- **Research target**：位于 `.research/goal/<research-id>/` 的长期项目事实。
- **DSH Goal**：当前会话的自动续跑驱动；objective 以 `[researcher:<research-id>]` 开头。
- **Research plan**：稳定递增 ID 下的不可变 Markdown 版本、delta 与独立 SHA-256 登记。
- **Research run**：一次真实执行、rerun、随机种子或参数实例；新 run 固定引用显式选中的方案版本。
- **DSH Session**：权威会话 transcript；session 与 target 的绑定承载在核心已知、可持久化的 `agent/inbox/spliced` 快照事件中。

Host service 是正式研究记录的唯一领域权威，负责校验、写入、绑定、上下文注入和 Goal 激活。可编辑笔记复用普通文件工具与操作约定，不另建 Host 写入协议。Web client 使用 DSH 标准 `popupSelect` 装饰裸 `/research-load`；显式启用研究视图后，还通过 Native Archify 渲染器和 Viewer 提供只读方案与实验导航。

## 内部实现边界

- `src/research-store.ts` 的 `ResearchStore` 协调研究状态、run 提交/恢复、完整操作锁、索引策略及上下文预检。
- `src/record-store.ts` 的 `RecordStore` 提供经过校验的文件读取、安全写入与原观察版本凭证；不运行 Git，不决定研究状态或 Goal。
- `src/checkpoint.ts` 保持负责 Git 快照和输出封存；`src/storage.ts` 只转导 `ResearchStore`，兼容旧导入路径。

记录格式独立版本化，旧 state/run 保持可读和可恢复；单写者约定不变。

## 项目目录

```text
.research/
  evo/                              # 预留；v1 不写 evolution 记录
  goal/<research-id>/
    goal.md                         # # Goal / ## Metrics / ## Baseline
    state.jsonl                     # append-only 的完整状态快照
    glossary.json                   # 目标特有术语和相关文件说明
    notebook/<note-id>.json         # 可编辑的六字段讨论笔记
    sources/<filename>             # 任意格式的原始资源
    session/<base64url-session>.json
    runs/<run-id>.jsonl             # 描述记录 + 可选的不可变结果记录
    plan/0001/v0001.md              # 完整 Markdown + 最小 YAML 元数据
    plan/0001/versions.jsonl        # 已提交版本与实际字节 SHA-256
```

Research ID 和 Run ID 均为随机 UUID v4。后续 DSH 会话必须显式加载：

```text
/research-load <research-id>
```

Web GUI 中输入裸 `/research-load` 会打开目标选择器。损坏目标仍以诊断行显示，但不能提交加载。

`/research-load` 只加载背景：要求会话空闲，绑定目标、保留研究状态和选中方案、解除同目标 Goal 的自动续跑授权，然后给出一次无工具的现状与方向说明。不创建或恢复 Goal；回复结束后等待用户。忙碌会话与并发加载会被拒绝，不中断当前工作、不排队生成多份简报。

需要持续推进时显式执行 `/research-start`（不接收 ID，只作用于已加载目标），或明确要求持续推进，由模型调用仅允许直接人类授权的 `start_research`。启动先检查未完成 run、完成状态、冲突和轮数，再恢复 paused/blocked 研究状态并创建/恢复匹配 Goal。`/goal pause` 停止后续自动轮次。普通讨论不构成持续推进授权；`create_research` 保持独立的创建/激活约定。

若存在 open run 或待发布的 state transition，加载返回 `mode: recovery-only`，仍只给交接说明。`get_research.research.recovery` 提供 `run_id`、`phase`、`path` 和预定 `output_ref`（不代表已封存）。须获授权后依原执行证据和原 payload 恢复；恢复完成或再次 load 都不会自动启动，需要继续时再显式 start。详见[加载与启动说明](docs/load-start.md)。

## 模型工具

- `get_research`：读取当前已绑定目标；刻意不提供模型侧 load/switch 工具。
- `research_notebook`：按需获取笔记路径和轻量操作说明；无参数、不写文件，笔记本身通过现有文件工具操作。
- `create_research`：在顶层 agent 的直接人类轮创建并绑定目标。
- `start_research`：只在直接人类明确要求持续推进时启动；不能加载或切换目标。
- `update_research`：在有意义的结果或方向变化后追加状态快照，保留选中方案。
- `create_research_plan` / `update_research_plan`：创建方案或追加带 delta 的完整新版本，不覆盖历史。
- `get_research_plan` / `list_research_plans`：校验读取具体版本，或分页查看方案及最新已提交版本。
- `select_research_plan`：用预期 state revision 显式选择具体版本，最新不等于选中。
- `start_research_run`：仅在目标为 active 时、真实执行前打开唯一的当前 run；加载不恢复 paused/blocked 状态，恢复须另获明确授权。
- `finish_research_run`：不可变地关闭 run、校验产物，并追加对应状态。
- `update_research_glossary`：原子更新目标术语与真正相关文件的说明。

共享状态变更必须来自直接人类轮，或来自标记与当前 research target 精确匹配的当前 DSH Goal Round。Subagent 不能直接修改共享 researcher 状态，只能把证据与结果返回给顶层 agent。

## 笔记与资源

目标上下文只放笔记位置及 `research_notebook` 入口。调用后才通过普通工具结果返回六字段 JSON 约定、当前会话 ID 和操作说明；不读取笔记、不额外注入消息、不新增 CRUD 工具。笔记允许修改和删除，原始资源按文件名引用且不得覆盖。新目标包含两个目录，旧目标无需迁移，读取说明不创建目录。详见[笔记使用与技能部署](docs/notebook.md)。

## 方案记录

现状调查可选。每个新 run（包括基线、探索）开始前先保存并显式选择方案，start 传入 `plan: {plan_id, revision}`；纯读取、检索不因此变成 run。Host 生成 ID、版本、时间和 hash；内容只强制元数据合法、标题/正文非空、delta 有说明，不规定章节。方案 ID/revision 为正安全整数，路径至少补齐四位，无 9999 上限。state v2 保存 `{planId, revision, sha256}`，正文按需读取，不全量注入上下文。发布新版不自动移动选择或已有 run 的引用。完整协议与重试规则见 [plans.md](docs/plans.md)。

## 研究视图

在同一 Host/client 组合中安装 Native Archify，并给 researcher 设置 `view: { enabled: true, presetIds: [research] }`，即可为研究模式注册“视图”页签；默认关闭，保留原有无界面与目标选择器用法。每个真实方案目录对应一个分区，同一方案的全部已验证版本在一张可平移、缩放的画布中连续展示，每行最多6列（3组版本＋实验），超出后向下换行，不再按版本分页；每个版本的 Run 分页与资源预算仍保留。版本与 Run 以精确引用连接，只有显式且摘要验证通过的实验依据生成修订因果边。冷会话查看不激活 Agent 或 Goal；主动选择加载目标仍遵循原命令规则。

新方案元数据使用 v2，可提交 `based_on_runs: [{run_id, reason}]`；Host 记录已封存 Run 的实际字节摘要，要求同目标、同方案、较早版本及已发布状态转换。初版不得带实验依据，后续版本不自动继承，旧 v1 文档不改写。

配置、分页、取消、只读接口与限制见 [research-view.md](docs/research-view.md)。当前开发依赖链接到本机 DSH 0.1.5-rc.1，并对齐其 React 18.3.1；这些链接不能直接用于可移植发布。构建成功不等于现有 GUI 已重新加载，启用与重载应走正常维护流程。

## Git run checkpoint

新 run 使用 v3 记录，start 必须提供精确选中的方案版本及 reproduction（command、cwd、environment、inputs）。在实际执行前自动保存输入代码，finish 保存输出代码和产物 SHA-256，再提交不可变结果与 state。旧 v1/v2 run 仍可读取/关闭，不补造历史代码快照或方案来源。

- workspace 必须是 POSIX 系统中已有提交的普通本地 Git 仓库根目录；不自动 git init；不支持 Windows、linked worktree、submodule 等布局；受限支持已跟踪的仓库内相对叶子符号链接，仅保存链接文本，不跟随目标。
- 默认捕获 tracked 工作文件（含未提交修改）和显式输入；大仓库可显式使用 `reproduction.snapshot: {mode: "scoped", paths: [...]}`，只捕获指定范围并固定 Git 基准，记录删除清单。范围外工作区修改必须通过 `omitChanges` 逐项确认，不静默跳过。容量上限不变；不改 HEAD、分支、真实 index 或工作文件，不自动 push。
- scoped 模式的 `externalInputs` 只记录保留数据的路径、长度及 SHA-256，并在 start/首次 finish 校验，不纳入代码树。恢复必须先恢复基准，再覆盖部分树并应用删除；不能把部分树当完整仓库直接 checkout。
- 每个 run 分别固定 input/output 两个 refs/dsh/research/... 引用。输出 commit 内保存精确 finish 日志，崩溃后同 payload 重试不会重新捕获已变化的文件。
- .git/.research、疑似密钥文件不纳入；未跟踪/ignored 文件须显式声明。产物只保存摘要，外部数据和环境须另行保留。
- v2/v3 run 打开期间不允许普通 state 更新；任何 open/pending run 期间都不允许切换选中方案。停止写入代码/产物后再 finish；源代码中途变化和外部依赖仍可能影响复现。
- **快照已保存不等于复现已验证**。不自动执行 recipe、不原地回滚；应在独立目录恢复输入代码、重建环境、重跑并比较指标/摘要。

完整协议、恢复步骤与限制见 [checkpoints.md](docs/checkpoints.md)。自定义 Git refs 不会自动随普通 clone/push 传输，跨机器需显式导出，并保留 .research 记录。

## 可靠性约束

- 每次 load 都由 Host 重新校验项目记录；弹窗列表从不构成权威。
- 一个 DSH session 不能静默切换到另一 target。
- 若存在不同的未完成 DSH Goal，则失败关闭，绝不自动替换。
- v1 中 `complete` 为终态，不可重新打开。
- 每个 target 同时最多存在一个 open run。
- JSONL 逐条限制大小并校验 revision；只有看起来确实是写入中断的最后一个 state 片段才会带警告忽略。
- create、state update 与 run finish 在提交前都会验证固定 32 KiB 加载上下文；warnings 与其他可选上下文按确定规则截断。
- 已关闭 run 携带精确的预备 state transition；两文件 finish 中断后可安全重试一次，不会把旧状态覆盖到新状态之上，也不会重新要求已验收产物仍然存在。
- 正式记录写入使用 create-if-absent 或带版本的 replace，并配合进程内每目标 FIFO mutex。v1 明确不支持多个进程并发写同一 target；同一 workspace/target 只使用一个 DSH writer 进程。
- 权威目录和文件必须规范化、位于 workspace 与精确 target 根内，且不是符号链接。v1 的 staged 目录创建/提交要求 host-local workspace 文件系统。
- 正式记录不复制 DSH transcript、完整工具日志或大型 run 产物；`sources/` 可以保存主动收集的原始参考资源，不代表 checkpoint 已归档这些资源。

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

### Session 接口兼容验证

事件访问兼容旧版 `Session.events` 与新版 `snapshotEvents()` / `eventAt()` / `seq`，优先新版接口；这是事件 API 的兼容范围，不代表所有 DSH 版本均已验证。不支持的接口返回 `RESEARCH_SESSION_API_UNSUPPORTED`，不会静默视为空历史或放宽权限。本地依赖与实际 DSH 安装可能不同，普通测试固定覆盖两种接口，发布前还应显式验证实际宿主模块：

```bash
DSH_RESEARCHER_SESSION_MODULE=/absolute/path/to/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js \
  pnpm exec vitest run tests/session-api-repro.spec.ts
```

未设置变量时，真实宿主用例明确跳过；这不等于宿主验证通过。路径指向实际运行 DSH 使用的 Session 模块，不应将机器绝对路径写进测试源码。构建产物需由实际 DSH 进程重新加载才会生效；本测试不重启服务、不修改已有研究记录。
