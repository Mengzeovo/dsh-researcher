# Researcher 插件架构评审

> 后续更新：恢复路径 P1 已完成增量修复与回归，见 [修复记录](recovery-fix.md)；记录存取与研究协调的第一阶段拆分也已完成，见 [职责拆分](storage-split.md)。下文保留评审时的事实与行号；跨进程单写者约束、记录策略与规模优化尚未实施。

## 核心结论

**总体方向正确：它是 DSH 上的“项目研究状态与证据层”，不是第二套 agent 调度器。应保留 Host 权威、薄 Web、不可变 run 和可恢复提交；先补生命周期闭环，再做小范围解耦，不建议重写或立即换数据库。**

当前实现适合单机、单写者、普通 Git 代码研究项目。通用研究任务、长历史、多进程使用的适配仍有明确边界。最优先的问题不是抽象层数，而是已经复现的“paused/blocked 目标开启 v2 run 后，新会话无法完成加载”的恢复路径缺口。

## 1. 范围、方法与验证基线

- 对象：`dsh-profile-researcher` 0.1.0 当前工作树，HEAD 为 `b6a3890`，包含已有未提交的 checkpoint v2 扩展；不是 DSH 全部插件框架的评审。
- 方法：沿入口、权限、领域服务、持久化和恢复路径阅读源码；一位独立审阅者复核存储与 checkpoint；运行既有测试及两个针对性生命周期探针。无网络调研，无生产代码改动。
- 判断标准：关键评价有文件与行号支撑；可达性问题用最小用例验证；把明确限制与实现缺陷分开，不把测试通过当成全系统可靠性证明。
- 预算：一次有界代码评审、一次既有测试基线、一次两用例定向验证；不进入实施/调优循环，不创建跨会话研究目标。
- 环境：Node.js `v22.23.1`、pnpm `11.24.0`、Vitest `4.1.11`。
- `pnpm run typecheck && pnpm test`：通过，10 个测试文件、109 个测试。
- 临时恢复探针：paused、blocked 两用例均验证到预期的当前错误路径。**探针通过表示问题被复现，不表示该行为正确。** 探针使用真实 ResearchStore 与 ResearcherService 方法、临时本地文件系统，以及模拟 checkpoint/Host 依赖；运行后已删除临时测试文件。
- 未做：在线 GUI 验收、真实 DSH 完整重启/加载集成测试、多进程竞争实验、规模性能基准、构建与发布检查。没有重建 `lib/`、重启服务或改变用户原有工作。

## 2. 当前架构

```text
Web popupSelect ── list RPC（只读） ──────────┐
       └── /research-load ── command.ts ────┤
模型工具 ── tool.ts ── authority.ts ────────┤
                                          ▼
                               ResearcherService（index.ts）
                                  │                 │
                       ResearchStore          Session 绑定投影
                                  │           /上下文注入/DSH Goal
                    ┌─────────────┴─────────────┐
              项目记录/JSONL              GitCheckpointProvider
                    │                           │
              DSH fs + 本地目录操作       GitRunner → DSH subprocess/sandbox
```

| 边界 | 实际职责 | 证据 |
| --- | --- | --- |
| 插件装配 | package exports 分离 host、command、tool、client、typert；Cordis patch 安装 Host 服务 | `package.json` 12–69；`cordis.patch.yml` 1–4 |
| Web/传输 | 远端仅提供目标列表；选择后把完整命令送回 Host；独立挂载和释放 UI/Remote | `src/client/index.ts` 29–76；`src/typert.host.ts` 4–28 |
| 模型权限 | 校验真实 live initiator、当前 turn；直接人类创建，精确匹配的 Goal Round 才能自动写 | `src/authority.ts` 22–85；`src/tool.ts` 167–176、260–268 |
| 应用协调 | 创建/加载、绑定兼容性、原生 Goal 冲突检查、上下文注入与 Goal 激活 | `src/index.ts` 189–285、288–368 |
| 项目持久化 | goal/state/glossary/run/session index；校验、版本写、每目标串行化、finish 恢复 | `src/storage.ts` 161–301、553–770、854–965 |
| checkpoint | 输入工作文件快照、输出快照、产物摘要、Git ref 与恢复日志 | `src/checkpoint.ts` 426–525；`src/git-runtime.ts` 48–90 |

权威来源并不是“一切都以文件为准”：研究事实在 `.research`，会话绑定从 DSH 持久事件投影恢复，当前会话执行状态由 DSH Goal 管。`session/*.json` 是可重建索引，不是会话 transcript，也不是绑定的唯一权威。证据：`src/index.ts` 73–111、149–153；`src/storage.ts` 604–606、854–965。

两条主流程：

- **load**：重新读取目标 → 检查绑定/Goal → 必要时把 paused/blocked 改为 active → 写 session index → 注入含 binding 的持久快照事件 → 创建/恢复 Goal。
- **v2 run**：start 固定输入 Git ref 和 baseStateRevision → 外部执行由 agent/Job 完成 → finish 固定输出 ref 与精确提交日志 → 写不可变 result → 发布对应 state。它是可恢复的分步提交，不是跨 Git/文件/Session 的原子事务。

## 3. 值得保留的设计

1. **没有重复造调度器。** Research target、Goal、run、Session 分工清晰；前端没有绕过 Host 的状态写入口。保持这一点比增加更通用的插件框架更有价值。证据：`src/client/index.ts` 40–57；`src/index.ts` 341–368；`src/tool.ts` 189–225、335–337。
2. **可靠性工作有实际实现和测试支撑。** 严格 schema、revision 连续性、路径约束、只读拒绝、不可变 result、精确 payload 重试、发布前上下文预检，不只是文档承诺。真实 Git 测试还覆盖输出 seal 后失败、工作文件变化、产物删除后的恢复。证据：`src/jsonl.ts` 68–134；`src/storage.ts` 619–770；`tests/checkpoint-e2e.spec.ts` 23–71。
3. **checkpoint 的承诺克制且正确。** 捕获工作文件而非只记 HEAD；不污染真实 index/分支；明确“快照不等于复现验证”，不自动执行记录中的 command。证据：`src/checkpoint.ts` 284–348、426–450；`src/git-runtime.ts` 24–46；`docs/checkpoints.md` 5–9、31–40。

## 4. 问题与优先建议

### P1：修复生命周期组合造成的跨会话恢复缺口

**已通过两例隔离探针确认。**

触发路径：

```text
目标已绑定原会话 → update state 为 paused 或 blocked
→ 直接人类轮 start v2 run 成功
→ 新会话 /research-load
→ activate 先 resumeState
→ open v2 run 禁止任何普通 state 更新
→ RESEARCH_RUN_OPEN，未完成绑定/注入
→ 新会话 finish 又因未绑定返回 RESEARCH_NOT_FOUND
```

原因不是单个函数缺少校验，而是三个各自合理的规则组合后不闭合：start 只禁止 complete；load 自动 resume；open run 冻结 state。证据：`src/storage.ts` 561–580、493–495、537–548；`src/index.ts` 255–269、233–235、371–376；`src/authority.ts` 73–80。

原会话仍可关闭 run，数据仍在，因此**不是不可恢复的数据丢失**。现有重启测试保留了原 runId/finish payload，没有验证“新会话仅凭持久记录发现并进入恢复路径”：`tests/checkpoint-storage.spec.ts` 298–330。

首选修法：新 run 仅允许从 active 开始；另为已有 open/pending 记录提供明确的 recovery-only 加载路径，允许读取/绑定以恢复提交，但不先修改冻结 state、不自动启动新的 Goal 执行。修复时补 paused/blocked × open/pending × 新会话的状态矩阵测试。

### P1（多进程使用前）：把单写者限制变成可执行约束

目前 mutex 是 ResearchStore 实例里的内存 Map；不同进程甚至不同 store 实例不共享它。版本写保护单文件冲突，不提供 start 的“检查没有 open run → 创建新 run 文件”这一跨文件不变量。两个独立写者可能检查通过后分别创建不同 UUID 的 run。证据：`src/storage.ts` 163–178、565–597。

README 已明确不支持多进程，这是**已声明的使用边界，不是声称支持却未实现**。建议先落实 target 级跨进程 writer ownership/锁和清晰冲突诊断，第二写者失败关闭；不要一开始就做分布式协作。验收用两个真实独立进程竞争 start，必须只有一个成功。

注意：target 锁只保护研究记录，不保护实验期间的源码；不同 target、人工编辑仍可能共用工作区。执行隔离必须另行设计，不能把加锁描述为“实验已可复现”。证据：`docs/checkpoints.md` 62–66。

### P2：让恢复状态成为一等读取结果，并诊断双生命周期差异

`readTarget` 只装配 state.lastRunId 对应的已关闭 run，未暴露 openRun、pendingTransition、sealed-but-unpublished 等恢复状态。写接口才扫描并在报错中给出 runId。重新加载通常能读到旧 summary，但不知道当前还欠哪一步提交。证据：`src/storage.ts` 374–410、897–938；`src/context.ts` 47–77、125–129。

建议由一个 recovery/status 查询给出阶段、runId、base revision、可执行下一步和 checkpoint 可用性；上下文优先放阻塞恢复信息，不应被 glossary/历史描述挤掉。必要时提供显式的人类恢复命令，复用冻结 journal，绝不要求模型“猜回”旧 payload。

Research status 与原生 Goal 状态目前依赖工具输出提醒分别更新，这是有意分层，但会留下“项目已暂停，Goal 仍 armed”等组合。应显示一致性诊断，并在明确授权下协调操作；不要把所有差异当错误或无条件自动同步。证据：`src/tool.ts` 189–225、335–337；`src/index.ts` 341–368。

### P2：按事务职责解耦，保留 Git 作为明确能力而不是扩散实现依赖

`src/storage.ts` 已有 1019 行，集合了路径安全、JSONL 读写、run 提交协议、索引重建、产物检查和上下文预算。新增后端/恢复能力继续集中到这里，会把一次变化扩散到多个不变量。代码行数不是缺陷；**职责与变化原因集中**才是建议拆分的依据。

首选小步边界：`TargetRepository`（文件与序列化）/ `RunCoordinator`（生命周期与恢复提交）/ `CheckpointProvider`（代码与产物证据）。已有构造器注入 `Pick<GitCheckpointProvider, start | finish>` 是可沿用的起点，而非另起框架。证据：`src/storage.ts` 166；`src/types.ts` 4–5、55–80、156–160。

当前所有新 run 强制 Git + reproduction，且限定普通 POSIX 本地仓库根、2000 文件、50 MiB 快照等；这对代码实验是合理保守选择，却使非 Git 文献/数据分析、worktree/远程环境无法使用新 run。证据：`src/tool.ts` 231–247；`src/checkpoint.ts` 46–50、206–225；`docs/checkpoints.md` 9、37–40。

若定位继续是通用研究插件，建议先抽象 capability 和 preflight，后续由人类明确选择 strict Git 或 metadata-only 等记录策略；不支持的 Git 情形仍须明确报错，不能自动静默降级。若定位只服务当前本地代码项目，先保留 strict Git 默认即可。

## 5. 后续规模与契约注意项

- **全量扫描/全量重写是下一阶段瓶颈候选，不是已测得的慢。** state 文件虽经 streamText 读取，仍全部拼接为字符串；JSONL 按整串分割和校验，再整文件版本替换。pending/open/session index 又反复扫描所有 run。单次随历史线性增长，累计写入成本可能趋向平方级。证据：`src/storage.ts` 229–257、475–533、897–965；`src/jsonl.ts` 32–94。建议先以 100/1000/10000 run 测耗时、内存、文件读取次数，再做有版本且可重建的 current/open/pending 索引与日志分段。不要以盲目追加替换现有恢复语义。
- **有上下文上限不代表底层读取受限。** state/run 的 readVersioned 传入 undefined 后会先整体读入再验证单条大小；损坏巨型文件也会先消耗内存。应采用读取过程中的行级限额和明确的总资源预算，保留合法长历史的分段读取能力。证据：`src/storage.ts` 244–257、385、839；`src/jsonl.ts` 36–56。
- **契约收口。** `typert.host.ts` 与 `typert.remote-client.ts` 4–28 的 descriptor 重复；`context.ts` 80–132 实际按 JavaScript 字符串 length 限制，而文档称 32 KiB，中文/emoji 情况不等价。建议共享 browser-safe descriptor，并明确预算单位或改用字节/token预算，增加非 ASCII 测试。
- **把 Host 集成测试补在重构前。** 现有 Host/Web 测试主要模拟依赖；checkpoint e2e 使用真实 Git，但不是完整已安装 DSH 的装载链。下一步应覆盖真实 session 持久化重启、插件装配、工具 schema 升级及加载恢复，尤其新 start 参数增加 required reproduction 的兼容性。证据：`tests/host.spec.ts` 104–171；`tests/client.spec.ts` 49–102；`tests/checkpoint-e2e.spec.ts` 13–26。

## 6. 推荐推进顺序与接续点

**先补恢复闭环 → 再强制单写者 → 再提取小型职责边界 → 有规模数据后优化索引。**

第一步的验收不以“代码更漂亮”为准：paused/blocked 不得开启不可跨会话接续的新 run；已有 open/pending 记录能被新会话发现并按原 payload 恢复；恢复不能重新捕获变更后的源码/产物，不能产生双 result/state，也不能错误 rearm Goal。

本次停在分析交付，没有修复实现。首个后续任务应是生命周期矩阵回归测试及对应最小修复，而不是新增 UI 面板、通用事件总线或数据库迁移。
