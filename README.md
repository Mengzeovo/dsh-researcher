# DSH Researcher Plugin

`dsh-profile-researcher` adds project-scoped, cross-session research state to the DSH research preset. It complements—rather than replaces—the native DSH Goal, Job, Subagent, Workflow, and Session facilities.

## Roles

- **Research target**: durable project truth under `.research/goal/<research-id>/`.
- **DSH Goal**: the current session's continuation driver. Its objective begins with `[researcher:<research-id>]`.
- **Research run**: one actual execution, rerun, seed, or parameter instance.
- **DSH Session**: authoritative transcript and session-to-target binding carried by the core-known durable `agent/inbox/spliced` snapshot event.

The Host service owns validation and mutation. The Web client only decorates the bare `/research-load` command with the standard `popupSelect` shell and resubmits the selected ID to the Host command.

## Project layout

```text
.research/
  evo/                              # reserved; v1 writes no evolution records
  goal/<research-id>/
    goal.md                         # # Goal / ## Metrics / ## Baseline
    state.jsonl                     # append-only full snapshots
    glossary.json                   # target terms and relevant-file descriptions
    session/<base64url-session>.json
    runs/<run-id>.jsonl             # description + optional immutable result
```

IDs are random UUID v4 values. A later DSH session explicitly loads one with:

```text
/research-load <research-id>
```

In the Web GUI, bare `/research-load` opens a target picker. Invalid target rows remain visible as diagnostics but cannot be submitted.

## Model tools

- `get_research` — read the currently bound target; there is intentionally no model-facing load/switch tool.
- `create_research` — create and bind a target from a direct human turn on a root agent.
- `update_research` — append a meaningful state snapshot.
- `start_research_run` — open the single current execution record.
- `finish_research_run` — close it immutably, verify artifacts, and append the resulting state.
- `update_research_glossary` — atomically patch target-specific terminology and relevant-file descriptions.

Shared mutations require either a direct human turn or the exact current DSH Goal Round whose marker matches the loaded research target. Subagents cannot mutate shared researcher state directly.

## Reliability rules

- Host revalidates project records on every load; the popup list is never authority.
- A session cannot silently switch to another target.
- A different unfinished DSH Goal causes a closed failure rather than replacement.
- `complete` is terminal in v1.
- Only one research run may remain open per target.
- JSONL records are bounded and revision-checked; only a plausibly interrupted final state fragment is ignored with a warning.
- Every create, state update, and run finish is preflighted against the fixed 32 KiB load context; warnings and other optional context are deterministically truncated.
- A closed run carries its exact prepared state transition, so an interrupted two-file finish can be retried once without replaying stale state or rechecking an artifact that was already accepted.
- Writes use create-if-absent or versioned replacement plus a process-local per-target FIFO mutex. V1 deliberately does **not** support concurrent writer processes for the same target; use one DSH writer process per workspace/target.
- Authority directories and files are canonical, workspace-contained, exact-target-contained, and must not be symlinks. V1 requires a host-local workspace filesystem for staged directory creation/commit.
- The transcript, complete tool logs, and large artifacts are not duplicated into `.research`.

If creation commits a target but Goal activation fails, recover with the returned `/research-load <research-id>` command.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
# all checks
pnpm run check
```

Tests create and remove temporary workspaces; they never write `.research` into the repository under development.
