# 跨会话恢复路径修复记录

> 后续职责拆分已将下文 `src/storage.ts` 中的研究协调实现迁至 `src/research-store.ts`，记录 I/O 迁至 `src/record-store.ts`；旧文件保留兼容转导。恢复行为不变，详见 [职责拆分](storage-split.md)。

## 结论与范围

本轮修复此前架构评审发现的 paused/blocked → start v2 run → 新会话 load 被冻结状态阻断的问题，并覆盖同类 open/pending 恢复入口。没有实施跨进程锁、单写者 lease、数据库迁移、自动实验重跑或 checkpoint 后端扩展。

基线为 HEAD `b6a3890` 加用户已有未提交 checkpoint v2 工作；保留原有实现，按增量修改。

## 行为与实现

- `src/storage.ts`：新 run 仅从 active 开始；paused/blocked 返回 `RESEARCH_TARGET_INACTIVE`，complete 保留 `RESEARCH_TARGET_COMPLETE`，拒绝在 checkpoint 发布前发生。
- `src/storage.ts`、`src/types.ts`：读取时派生 `recovery`，标识 `open` 或 `pending-state`、runId、记录路径、可选预定 outputRef；不新增持久 state/binding 字段，多恢复候选明确报错。扫描不申请非重入 FIFO 锁。
- `src/index.ts`：有 recovery 时返回 `goalAction: recovery-only`。仍检查绑定与不同未完成 Goal 冲突，但跳过状态 resume、Goal 容量检查及所有 Goal 激活调用。原来已 armed 的 Goal 保持原状，不承诺自动停止执行。
- `src/context.ts`：用比普通提示更短的 mandatory identity 标明恢复阶段/runId，避免新增提示让接近 32 KiB 的旧目标无法加载；更完整的指导优先于可选 glossary/history。
- `src/tool.ts`、`src/command.ts`：公开恢复状态及原 result/journal 的读取指引。`get_research.research.recovery` 不随上下文截断。`output_ref` 只是预定引用，不代表已经封存。
- finish 保留原不可变参数与 transition 校验；三个完成态预检快照显式清除派生 recovery。成功后再读不显示 recovery；不在 finish 中激活 Goal。由人类再次 `/research-load` 才进入正常接续或 complete 的只读查看。

## 测试与结果

测试环境：Node.js v22.23.1，pnpm 11.24.0，Vitest 4.1.11。

| 阶段 | 命令/方式 | 结果 |
| --- | --- | --- |
| 修复前红灯基线 | `pnpm exec vitest run tests/recovery.spec.ts` | 初始 14 用例中 12 失败、2 通过；失败均对应 inactive start、恢复 load 或 Goal 容量阻断 |
| 首轮定向回归 | typecheck + recovery/host/storage/checkpoint-storage/schema-jsonl | 76/76 通过 |
| 扩展边界与真实 Git | typecheck + recovery/checkpoint-e2e | 24/24 通过 |
| 最终完整检查 | `pnpm run check` | 类型检查通过，12 文件/134 测试通过，tsc 与客户端 bundle 构建成功 |
| 构建产物冒烟 | 导入 `lib/tool.js`、`lib/index.js` 并断言 recovery schema、active-only 描述 | 通过 |
| 差异检查 | `git diff --check` | 通过 |

新增 25 个测试（`tests/recovery.spec.ts` 23 个、`tests/recovery-surfaces.spec.ts` 2 个），共享测试 Host 在 `tests/recovery-helpers.ts`。还增强了原有真实 Git e2e，而不是只增加 mock 测试。

覆盖要点：

1. paused/blocked/complete start 不创建新 ref/记录、不改 state。
2. active/paused/blocked × open/output-sealed/pending-state；重复恢复性 load 后仍保留原 revision/status。
3. 新会话能绑定并 finish；已封存后产物删除仍恢复原值；更改 payload 被拒，重复 finish 不产生双 result/state。
4. 从已关闭记录而非旧 target state 恢复 active/paused/blocked/complete 四种准备好的 transition。
5. 无 Goal、匹配 armed/disarmed/耗尽 Goal 不被恢复入口改变；不同 unfinished Goal 仍拒绝；完成后再次 load 才回原生命周期。
6. 接近上下文上限并含大型 glossary 的旧目标仍能加载，mandatory identity 保留 runId；v1 无 Git 恢复；歧义候选拒绝。
7. 命令返回 recovery-only/指导，真实工具注册后的 get/finish 输出通过严格 JSON schema 校验，完成后 recovery 字段消失。
8. `tests/checkpoint-e2e.spec.ts`：真实 Git output 已封存、源代码被改变、产物删除后，新会话按发现的 output ref 读取 journal，重建原 payload 完成提交；保持 HEAD/index，独立恢复输入并复现相同摘要。

## 部署与未覆盖边界

- 已重建项目 `lib/`；未重启或热重载用户当前运行中的 DSH Host，也未进行在线 GUI 刷新验收。运行进程需要重新加载该插件的构建产物后才会采用新行为。
- Host/projection/Goal 在隔离测试中模拟；真实 Git/本地文件和 public command/tool 方法已执行，但这不等于完整线上 Session 重启测试。
- 单写者约定仍按原实现，只提供进程内每目标串行化。该机制留待下一轮讨论，未暗中实施跨进程锁。
- 没有改变原有全量历史扫描、跨文件读隔离和上下文总体预算规则。独立审阅还提示一个原有的未动态验证极限边界：已封存重试的暂拟 transition 使用新 sessionId，若新 ID 更长且结果贴预算，可能先于 frozen transition 校验被拒。本轮不因此扩展 Git 提交协议。

下一步：讨论如何把单写者约定转为可执行约束，先选清锁/持有者作用域、第二 writer 行为与崩溃接管规则，再决定实现。
