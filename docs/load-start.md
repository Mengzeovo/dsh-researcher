# Context loading, briefing and automatic advancement

`/research-load` means **load background → brief once → wait**, not permission to perform research.

## Load contract

The command accepts a target ID (Web can use the existing picker). The service requires an idle session with no pending input, uses a per-session admission gate, and rechecks conditions after asynchronous reads. It preserves the target status/revision, selected plan, notebook and run records. Only session binding and conversation logs are written. A matching armed Goal is disarmed without editing its durable fields; an unrelated unfinished Goal or different existing binding is rejected.

Loading works for active, paused, blocked, complete and exhausted-round targets. Recovery information is data, not authorization to repair or rerun anything. Results distinguish `mode: context-only | recovery-only`, `goalAction: unchanged | disarmed`, and `briefing: queued`.

The Host injects the bounded verified context, then schedules a plugin-origin (never human-authority) briefing through the existing agent driver. The briefing summarizes the goal, progress, current plan/status, direction and decisions needed, based on the records available. It does not scan sources or invent omitted information. The model has no tools for this brief, and tool dispatch is denied as a second boundary. No Goal is created or resumed. Cancellation/errors do not fall back to autonomous work; a failed brief can be retried by a new explicit load. Other human input remains available for the next ordinary turn. Unrelated background notifications retain their original IDs and sources in the durable inbox and are parked until a human request or a validated explicitly started Goal round consumes them. Parking may produce an empty rejected bookkeeping turn, but not an extra model request or Goal round. It uses the ordinary Inbox splice persistence contract, not a new cross-list atomic transaction.

## Explicit start

`/research-start` and the human-only `start_research` tool share one service path, use the current binding and cannot switch targets. Only an explicit request for **continuous** advancement authorizes the tool. Briefings, ordinary questions, single tasks, plugin messages, subagents and automatic Goal rounds are not startup authorization.

Start re-reads the authoritative target and checks unfinished runs, completion, conflicts and Goal round capacity. It rejects complete targets and unfinished recovery. Only start resumes paused/blocked project state and creates/resumes its matching Goal. Repeated start of an already active matching armed Goal does not inject another context or duplicate a round. The ordinary `create_research` creation flow remains a separate contract.

Single authorized tasks may resume project state using the existing researcher state tools without arming a Goal; loading itself never performs that transition.

## Waiting and presentation (DSH integration)

`update_goal action=wait_for_user` disarms the exact current Goal without creating a new phase or invoking the blocked-round threshold. `ask_user_question` disarms the calling root agent's own active Goal before requesting an answer when the optional Goal service exists. An answer/cancellation does not rearm it. Disarming prevents later automatic rounds; it does not interrupt the current step, so the agent must state its question and finish normally. Resume requires explicit human authorization.

Chat shows a system-prompt card on the first known nonempty prompt and actual text changes, not unchanged request-series boundaries. Automatic work has a separate `Automatic continuation round N` label from the persisted Goal message source. Request/header events and request-series/cache behavior remain intact.

## Failure and deployment boundaries

- Loading while work or another load/brief is pending is rejected, never an implicit stop of that work.
- If a late conflict/abort follows binding persistence, no context is admitted and no project-state rollback or hidden execution is attempted; retry explicitly once idle.
- Original research records and historical session logs are not migrated or rewritten.
- Rebuild this plugin, reload the actual Host plugin instance, rebuild affected DSH Web bundles and refresh the existing GUI. A source edit alone does not prove that the running process or browser has adopted it.

Focused regression coverage is in `tests/host.spec.ts`, `tests/briefing.spec.ts`, `tests/start-research.spec.ts` and the recovery/creation suites; DSH owns the Goal and Chat integration tests.
