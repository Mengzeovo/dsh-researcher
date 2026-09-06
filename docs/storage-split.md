# 记录存取与研究协调职责拆分

## 1. 完成结果与边界

按已批准计划完成行为保持的模块拆分。原 `src/storage.ts` 的实现分为：

```text
Host（src/index.ts）
  └─ ResearchStore（src/research-store.ts）
       ├─ RecordStore（src/record-store.ts）→ DSH fs / schema / JSONL / directories
       ├─ checkpoint → Git 输入/输出封存
       └─ context → 上下文预检

旧 src/storage.ts → 转导同一个 ResearchStore 类
```

- **ResearchStore：一次研究操作怎么完成。** 保留全部原公开方法与构造方式、完整操作 FIFO、状态规则、run 提交/精确恢复、recovery 判定、目标快照组装、glossary 更新、session 索引策略及 context 预检。Host 改用新文件名，旧导入路径继续兼容。
- **RecordStore：记录怎么安全读写。** 提供各类已解析记录及原观察凭证、路径/目录/文件验证、目录枚举、只读预检、create-if-absent/replace-if-version 写入和原错误映射；包装已有暂存目录操作。它不持有操作锁，不运行 Git，也不决定研究状态或 Goal。
- **已有模块继续复用。** checkpoint、Git runner、schema、JSONL、context、directories 的实现和契约没有因本次拆分改变。上层对待发布 result/state 调用 schema/JSONL/context 预检属于事务决策，不为追求“零解析”强行下沉。

磁盘布局、v1/v2 记录版本、序列化规则、run/target ID、Git refs 约定、公开工具/命令返回格式保持不变。没有数据迁移，没有新的记录后端或策略选择，也未实施跨进程单写者约束。

## 2. 关键接口与不变量

### 记录读取不丢失观察信息

`readGoal/readStateLog/readGlossary/readRun/readSessionIndex` 返回 `ObservedRecord<T>`：

- `relativePath`、原 `FsTarget` 和 `FsVersion`；
- 原始 `text`，以及解析后的 `value`；
- state log 的 `value` 保留有效原文 `validText` 与尾片 warning。

`replaceText` 仍使用原观察的 target/version，绝不自动重读或重试覆盖；CAS 冲突仍映射为 `RESEARCH_STALE_WRITE`。session 索引文件缺失可返回 undefined，上层保留原 loadedAt 与创建/替换策略。

### 事务边界不随文件拆分改变

FIFO 仍由 `ResearchStore` 持有，键仍是 `realpath(workspace) + targetId`，覆盖完整 start/finish/状态/glossary/索引操作。RecordStore 只提供规范工作区标识，不持锁、也不回调上层，因此不会引入第二套非重入锁。

- 创建目标：构造记录 → schema/context 预检 → 暂存目录及文件 → rename；失败仍清理暂存并保留原错误。`.creating-*` 使用 workspace containment，不误套最终 target 根。
- start：active/open/pending 检查 → 原写权限与元数据预检 → input checkpoint → open run 文件 → 可重建索引。
- finish：原观察读取/写权限/上下文与精确参数校验 → output seal → run CAS → prepared state CAS → 可重建索引。
- recovery：仍由上层依据当前 revision 和 run 结果判定，不持久化新 flag，不在读取时自动恢复；完成态的三个预检快照仍清除 recovery。

### 不混同不同文件规则

`projectPathInspector` 先检查一次 workspace，再逐项提供 canonical containment 和 stat 结果；即使列表为空仍保留原 workspace 预检。上层决定 glossary 缺失只告警、v1 artifact 缺失报错；不把 authority 文件的 non-symlink/regular-file 规则强加到旧 project 引用。v2 封存重试不重新读取已删除产物的语义不变。

### 故障注入迁到稳定边界

`tests/helpers.ts` 增加 `failNextWrite`，通过真实临时文件系统的 `ctx.fs.writeText`，按 canonical 路径与写入模式只失败一次，其余调用保留原 signal/policy 并委托执行。五个既有 spec 共七处故障注入不再强转/访问 `ResearchStore.private replaceText`。仍精确模拟 output 已封存→run 写失败，以及 run 已关闭→state 写失败，没有把存储层替换成内存 Map。

## 3. 验证、交付与限制

基线：HEAD `b6a3890` 加用户已有未提交 checkpoint/恢复工作，而不是把 HEAD 当成完整当前实现。实现前已重新验证 12 文件/134 个测试通过。环境沿用 Node.js v22.23.1、pnpm 11.24.0、Vitest 4.1.11。

| 检查 | 结果 |
| --- | --- |
| 原有行为基线：`pnpm run typecheck && pnpm test` | 134/134 通过 |
| 新记录层定向检查 | 类型检查通过；13/13 新测试通过 |
| 最终 `pnpm run check` | 类型检查、13 文件/147 测试及 tsc/客户端 bundle 构建全部通过 |
| 构建产物导入与契约冒烟 | 新/旧 ResearchStore 是同一个类；公开方法、6 个工具及 recovery schema 均通过断言 |
| 独立只读复核 | 未发现本次拆分引入的提交顺序、路径检查或职责边界问题 |
| `git diff --check` | 通过 |

新增 `tests/record-store.spec.ts` 覆盖观察凭证、有效 JSONL 原文与尾片、CAS 不重试、创建冲突、只读拒绝、超限/格式错误、authority symlink、project 引用兼容与越界、run 所属 target 校验、session index 身份、暂存发布与创建失败不公开半成品。原有恢复矩阵、操作锁别名、真实 Git 跨会话 journal 恢复和独立复现断言继续保留并通过。

主要产物：`src/record-store.ts`、`src/research-store.ts`、兼容 `src/storage.ts`、记录层测试和迁移后的故障测试、双语 README、对应 `lib/` 编译产物。

当前 DSH Host 没有被重启或热重载，也没有进行在线 GUI 刷新验收；构建产物可用不等于已运行的进程采用了新代码。尚存的单写者部署限制、历史扫描成本、上下文总体预算等沿用原规则，不因结构拆分自动获得新保证。
