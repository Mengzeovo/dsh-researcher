# Context-only research load and explicit advancement

## Decision

`/research-load` is a background handoff, not an execution grant. Loading an idle session preserves authoritative research state/selection and Goal durable fields, disarms its matching automatic continuation, injects bounded verified context and schedules one plugin-origin tool-free briefing. `/research-start` and direct-human-only `start_research` share the separate startup path; ordinary discussion and plugin/Goal messages do not authorize it. Creation retains its existing independent contract.

## Implementation

- `src/index.ts`: per-session admission, load/start separation, late idle/conflict checks, durable context-injection validation, explicit recovery/completion/capacity startup checks and partial-briefing failure reporting. Startup idempotence requires both active project state and an armed active Goal; a separately rearmed Goal must not mask paused project state or an exhausted round budget.
- `src/briefing.ts`: exact live-agent/message reservation, no-tool assembly and execution veto, one model step with ordinary provider retries, cancellation/restore handling and unrelated input preservation. No new Session event type or research-file migration.
- `src/command.ts`, `src/tool.ts`, `src/types.ts`: explicit human start surfaces and separate load/activation results.
- `src/context.ts`, `src/research-store.ts`: remove old guidance equating repeated load with resume.
- DSH integration lives in its owning checkout: structured Goal waiting, optional question disarm, first/changed-only prompt cards, positive source-derived automatic round markers.

## Evidence and boundaries

The initial researcher scope baseline passed 92 tests. `tests/host.spec.ts` covers state preservation, conflicts/races, exhausted Goals, disarm and explicit startup. `tests/start-research.spec.ts` covers direct-human authority and command errors. `tests/briefing.spec.ts` uses actual AgentLoop/GoalDriver with a fake model and real service-load composition; storage/recovery suites independently exercise real filesystem/checkpoint authority. The optional external Session-module test remains explicitly conditional, not counted as verification when its environment variable is absent.

`generated/research-load-ui-check.ts` is a read-only browser replay against the existing GUI. It neither submits commands nor requests a model, and never logs credentials. Build/restart status and final test receipts belong in the implementation verification report; a passing source test does not prove the live Host has reloaded the new plugin. The original research target and session log are not rewritten.

## Failure policy

Busy/duplicate loads fail rather than queue a second briefing. A late failure after session binding reports the partial outcome; it never rolls back unrelated work, starts research as a fallback or retries a run. Recovery stays frozen until separately authorized. Waiting for a user choice must actually disarm later rounds; an answer is not a continuous-work grant.
