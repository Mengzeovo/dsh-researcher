# DSH Researcher Plugin

`dsh-profile-researcher` adds project-scoped, cross-session research state to the DSH research preset. It complements—rather than replaces—the native DSH Goal, Job, Subagent, Workflow, and Session facilities.

## Roles

- **Research target**: durable project truth under `.research/goal/<research-id>/`.
- **DSH Goal**: the current session's continuation driver. Its objective begins with `[researcher:<research-id>]`.
- **Research plan**: a stable numeric ID with immutable Markdown revisions, delta notes and an independent SHA-256 ledger.
- **Research run**: one actual execution, rerun, seed, or parameter instance; new runs pin an explicitly selected plan revision.
- **DSH Session**: authoritative transcript and session-to-target binding carried by the core-known durable `agent/inbox/spliced` snapshot event.

The Host service owns validation and mutation of formal research records. Editable notebook files use ordinary file tools and usage conventions, not a separate Host mutation protocol. The Web client decorates the bare `/research-load` command with the standard `popupSelect` shell. An explicitly enabled research view adds read-only plan and experiment navigation using the Native Archify renderer and Viewer.

## Implementation boundaries

- `ResearchStore` in `src/research-store.ts` coordinates research state, run publication/recovery, complete-operation locks, index policy, and context preflight.
- `RecordStore` in `src/record-store.ts` provides validated file reads, safe writes, and the original observation/version tokens. It does not run Git or decide research or Goal lifecycle.
- `src/checkpoint.ts` continues to own Git snapshots and output sealing; `src/storage.ts` only re-exports `ResearchStore` for existing imports.

Record formats are independently versioned; old state/run records remain readable and recoverable. The single-writer restriction remains unchanged.

## Project layout

```text
.research/
  evo/                              # reserved; v1 writes no evolution records
  goal/<research-id>/
    goal.md                         # # Goal / ## Metrics / ## Baseline
    state.jsonl                     # append-only full snapshots
    glossary.json                   # target terms and relevant-file descriptions
    notebook/<note-id>.json         # editable six-field discussion notes
    sources/<filename>             # original resources, any file format
    session/<base64url-session>.json
    runs/<run-id>.jsonl             # description + optional immutable result
    plan/0001/v0001.md              # complete Markdown + minimal YAML front matter
    plan/0001/versions.jsonl        # committed revisions + exact-byte SHA-256
```

Research IDs and run IDs are random UUID v4 values; plan IDs/revisions are increasing positive integers. A later DSH session explicitly loads one with:

```text
/research-load <research-id>
```

In the Web GUI, bare `/research-load` opens a target picker. Invalid target rows remain visible as diagnostics but cannot be submitted.

`/research-load` is context-only: in an idle session it binds the target, preserves project state/selection, disarms a matching armed DSH Goal, and queues one tool-free status/direction briefing. It never creates or resumes a Goal. After the briefing, ordinary discussion remains ordinary discussion. Busy sessions and concurrent loads are rejected instead of interrupting work or queueing more briefings.

Use `/research-start` (no ID) to explicitly start continuous advancement of the already-loaded target, or explicitly request continuous work so the model can call human-only `start_research`. Start validates recovery, completion, conflicts and round capacity before resuming paused/blocked state and creating/resuming the matching Goal. Use `/goal pause` to stop subsequent automatic rounds. `create_research` retains its separate creation/activation contract.

When a run is open or its prepared state is pending, load returns `mode: recovery-only` and still only briefs. `get_research.research.recovery` exposes `run_id`, `phase`, record `path`, and an optional planned `output_ref` (not proof of sealing). Complete recovery only with authorization and the original execution evidence/payload, then explicitly start if continuous work is wanted. Loading or recovery completion never starts work by itself. See [load/start behavior](docs/load-start.md).

## Model tools

- `get_research` — read the currently bound target; there is intentionally no model-facing load/switch tool.
- `research_notebook` — get notebook paths and a lightweight usage guide on demand; no parameters or file mutations. Use existing file tools for the notes themselves.
- `create_research` — create and bind a target from a direct human turn on a root agent.
- `start_research` — start continuous advancement only on an explicit direct human request; no load/switch capability.
- `update_research` — append a meaningful state snapshot, retaining the selected plan.
- `create_research_plan` / `update_research_plan` — publish a complete plan snapshot or append a revision with delta, never overwrite.
- `get_research_plan` / `list_research_plans` — verify/read a version or page through plans and latest committed revisions.
- `select_research_plan` — explicitly select an exact version with the expected state revision; latest does not mean selected.
- `start_research_run` — open the single current execution record only while the target is active; loading paused/blocked targets does not resume them; state resumption needs explicit authorization.
- `finish_research_run` — close it immutably, verify artifacts, and append the resulting state.
- `update_research_glossary` — atomically patch target-specific terminology and relevant-file descriptions.

Shared mutations require either a direct human turn or the exact current DSH Goal Round whose marker matches the loaded research target. Subagents cannot mutate shared researcher state directly.

## Notebook and resources

Target context carries only the notebook location and a pointer to `research_notebook`. Calling it returns the six-field JSON convention, current session ID and file-operation guidance as a normal tool result; it does not read notes, inject extra messages or expose CRUD tools. Notes can be edited/deleted; original resources are referenced by filename and must not be overwritten. New targets include both directories; old targets need no migration, and reading the guide creates nothing. See [notebook usage and skill deployment](docs/notebook.md).

## Research plans

Background survey is optional. Before every new run (including baselines/probes), save and explicitly select a plan, then provide `plan: {plan_id, revision}` to start. Pure reading/searching does not become a run. Host supplies IDs, revisions, timestamps and hashes; only metadata validity and nonblank title/body/delta are required, with no mandatory body headings. State v2 retains `{planId, revision, sha256}`; full bodies are read on demand, not copied into bounded context. A newer candidate never changes selection or existing runs. See [plan protocol and retry rules](docs/plans.md).

## Research view

Enable `view.enabled` on the researcher plugin and install Native Archify in the same Host/client composition. The research-only **视图 / View** tab partitions actual plan directories, displays immutable revisions and exactly associated Runs, and exposes verified experiment-to-revision reasons. Viewing cold Sessions does not activate an Agent or Goal. See [configuration, APIs, and limitations](docs/research-view.md).

## Git run checkpoints

New runs use record v3 and require an exact selected plan plus reproduction (command, cwd, descriptive environment, explicit input files). Start pins working-file input code before execution. Finish pins output code and SHA-256 artifact digests before publishing the immutable result/state. Legacy v1/v2 runs remain readable and finishable without fabricated historical snapshots or plan provenance.

The workspace must be an already committed plain local Git repository root. Checkpoints use separate immutable input/output refs under refs/dsh/research, do not modify HEAD, branches, the real index or working files, and never push. An interrupted finish reuses the exact journal stored in the output commit rather than recapturing changed files. State updates are blocked while a v2/v3 run is open; plan selection changes are blocked during any open/pending run.

Tracked working files plus explicit inputs are captured; .git/.research and likely secret files are excluded/rejected. Artifact contents and external environments/data are not archived automatically. **Captured is not reproduction-verified**: restore input into a separate directory, rebuild its recorded environment and independently compare outputs. See [checkpoint protocol and limitations](docs/checkpoints.md), including custom-ref backup and transfer requirements.

## Reliability rules

- Host revalidates project records on every load; the popup list is never authority.
- A session cannot silently switch to another target.
- A different unfinished DSH Goal causes a closed failure rather than replacement.
- `complete` is terminal in v1.
- Only one research run may remain open per target.
- JSONL records are bounded and revision-checked; only a plausibly interrupted final state fragment is ignored with a warning.
- Every create, state update, and run finish is preflighted against the fixed 32 KiB load context; warnings and other optional context are deterministically truncated.
- A closed run carries its exact prepared state transition, so an interrupted two-file finish can be retried once without replaying stale state or rechecking an artifact that was already accepted.
- Formal-record writes use create-if-absent or versioned replacement plus a process-local per-target FIFO mutex. V1 deliberately does **not** support concurrent writer processes for the same target; use one DSH writer process per workspace/target.
- Authority directories and files are canonical, workspace-contained, exact-target-contained, and must not be symlinks. V1 requires a host-local workspace filesystem for staged directory creation/commit.
- Formal records do not duplicate the transcript, complete tool logs or large run artifacts. `sources/` may hold deliberately collected original reference resources; these are not checkpointed artifacts.

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

### Session API compatibility checks

Event access supports legacy `Session.events` and modern `snapshotEvents()` / `eventAt()` / `seq`, preferring the modern API. This is an event-API compatibility boundary, not a guarantee for every DSH release. Unsupported APIs produce `RESEARCH_SESSION_API_UNSUPPORTED`, never an empty-history fallback or relaxed authority checks. Local dependencies may differ from the running DSH installation. Regular tests always cover both interfaces; before release, also explicitly test the actual host module:

```bash
DSH_RESEARCHER_SESSION_MODULE=/absolute/path/to/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js \
  pnpm exec vitest run tests/session-api-repro.spec.ts
```

Without this variable, the real-host test is explicitly skipped, not counted as host verification. Point it at the Session module used by the running DSH; do not hard-code machine paths in test source. The actual DSH process must reload the rebuilt plugin before changes take effect. These tests do not restart the service or modify existing research records.
