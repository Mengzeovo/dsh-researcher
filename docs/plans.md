# Immutable research plans

Research plans are first-class, project-scoped records. They do not replace the DSH Goal driver, plan mode, or run checkpoints. A background survey is optional. Every **new run**, including a baseline or probe, must reference a saved, explicitly selected plan revision. Pure reading/searching is not converted into a run by this rule.

## Records and identities

```text
.research/goal/<research-id>/plan/
  0001/
    v0001.md
    v0002.md
    versions.jsonl
  0002/
    v0001.md
    versions.jsonl
```

Plan IDs increase within a target; revisions increase within a plan. API IDs are positive safe integers. Paths use at least four digits, not a four-digit limit (`9999` → `10000`). Allocation uses the largest canonical numeric final directory, including invalid/empty directories, under the existing target FIFO. There is no deletion API or reuse of published IDs. Abandoned staging directories are not published identities. Old targets without `plan/` remain readable.

Each Markdown file is a complete snapshot, not a patch:

```markdown
---
schema_version: 2
plan_id: 1
revision: 2
title: "A minimal evaluation route"
created_at: "2026-01-01T00:00:00.000Z"
delta:
  - "Validate the main risk before building the full implementation"
based_on_runs: []
---

The complete proposal goes here, in any useful Markdown structure.
```

`schema_version` versions the record format; `revision` versions the proposal. Editing a proposal does not change `schema_version`. Host supplies format version, ID, revision, and timestamp. The caller supplies a nonblank title, complete nonblank body, and a nonempty array of nonblank delta notes (the initial delta may simply say “Initial proposal”). No particular headings, survey, hypothesis, or experiment template are required. Explaining what, why, and how to judge outcomes is guidance, not schema validation. Each complete snapshot is limited to 64 KiB UTF-8.

The independent `versions.jsonl` ledger contains one row per committed revision:

```json
{"schema_version":1,"plan_id":1,"revision":2,"file":"v0002.md","sha256":"<64 lowercase hex characters>"}
```

Rows have consecutive revisions beginning at 1. Identity, filename, metadata, and exact SHA-256 must agree. The hash covers **the stored UTF-8 bytes**, including front matter, whitespace, and line endings—not normalized Markdown/YAML. Host rejects invalid UTF-8. Each ledger row retains the existing 64 KiB record bound; history is streamed/read using the existing log convention, without a new total-size cap. The ledger is strict: a complete final JSON record without newline is valid; truncated JSON, duplicate/gapped revisions, and malformed rows are errors, not silently repaired state tails.

Hash verification detects accidental inconsistency; it does not prevent someone from editing both files. This feature intentionally has no signatures, hash chain, external attestation, or multi-process writer guarantee.

## Tools and selection

All tools operate on the currently bound target. There is no model-side target switching.

| Tool | Input | Effect |
|---|---|---|
| `create_research_plan` | `title`, `body`, `delta` | Publish a new plan's first revision; does not select it |
| `update_research_plan` | `plan_id`, `expected_revision`, `title`, `body`, `delta` | Append a complete next revision; does not select it |
| `get_research_plan` | `plan_id`, optional `revision` | Verify/read the exact revision, or latest committed revision |
| `list_research_plans` | optional `after_id`, `limit` | Numeric-ID pagination, latest metadata, separate invalid diagnostics; default 50, maximum 100 |
| `select_research_plan` | `plan_id`, `revision`, `expected_state_revision` | Append a full state snapshot selecting an exact committed version |

A state-v2 `selectedPlanRef` contains `{planId, revision, sha256}`; absence means no selection yet. Selection preserves status, summary, direction, next, and last run. Ordinary state updates, resume, and finish preserve selection. Publishing a candidate—even a newer version of the same plan—does not move selection. Selecting an old committed revision is valid. Selection changes are forbidden during any open or pending-state run, including legacy runs.

Creating/updating candidates is allowed for active/paused/blocked targets, but not complete targets. Reads remain available. Existing researcher mutation authority applies: a direct human root-agent turn or exact matching Goal Round; subagents return proposals/evidence rather than write shared records.

Typical flow:

1. Create/load the research target. Survey existing work if useful, not as a compulsory gate.
2. `create_research_plan` (or get/revise an existing plan).
3. `get_research` and `select_research_plan` using its exact state revision.
4. `start_research_run` with `plan: {plan_id, revision}`, purpose, parameters, and reproduction recipe.
5. Execute once and `finish_research_run` with its actual results.
6. Revise/select a plan when warranted, or continue using the same exact revision for additional runs.

No plan bodies or whole histories are automatically injected into the existing 32K-character research context. The selected identity/hash/path is retained with bounded title guidance; use `get_research_plan` for the complete verified snapshot. A valid reference proves a record association, not that implementation actually follows the proposal.

DSH plan mode remains read-only. Obtain its approval before creating/updating persisted research plans and implementing the approved task. Do not edit authoritative Markdown or ledgers directly through general filesystem tools.

## Explicit experiment evidence

New plan documents use metadata v2. Optional tool input `based_on_runs: [{run_id, reason}]` records why a sealed experiment supports the new revision. Host adds the exact Run-file `sha256`; the input cannot supply or replace it. Evidence must belong to the same target and plan, reference an earlier revision, and have both a sealed result and its exact published state transition. An execution failure can inform a revision; open or pending-state Runs cannot. Initial revisions require empty evidence, and later revisions do not inherit it automatically.

Legacy metadata-v1 documents and ledger-v1 rows remain readable and byte-preserved. No evidence is inferred from timestamps, Session order, or proximity. Rewriting even identical-value Run JSON changes the recorded digest and invalidates that evidence. New v2 metadata and exact evidence bytes participate in normal ledger verification and interrupted-publication retries.

## Publication, integrity, and retries

The Host keeps the existing split: `ResearchStore` owns full-operation locking and decisions; `RecordStore` owns safe filesystem observations, create-if-absent and original-version CAS. There is no second lock or transaction service.

**New plan:** prepare Markdown and its first ledger row in a staging directory, then publish the whole directory. The pair becomes visible together. Reads ignore uncommitted staging and never publish it. Creation is not globally exactly-once: after an uncertain response, list/get before intentionally creating again. There is no content deduplication or request-ID protocol.

**Revision:** `expected_revision` refers to latest *committed* revision, not the selected revision. Under the same target FIFO, validate the original ledger and existing snapshots, create only the next Markdown with create-if-absent, then CAS-append the ledger using the original observation. The ledger is the commit point. Never derive latest from glob order or mtime, and never automatically reread/rebase on a stale write.

If Markdown was written but registration failed:
- The old registered revision remains latest. Get returns an uncommitted-file warning.
- An explicit retry of the identical payload may reuse the single expected-next orphan, after validating identity, saved Host metadata, exact content, and canonical serialization. Preserve its original timestamp and bytes.
- A retry of an already committed identical update may return the verified revision without another write.
- A changed payload, later committed history, malformed/conflicting orphan, or multiple future files is an error. Preserve the files and inspect them; there is no automatic overwrite, skip, cleanup, or repair tool.

Any committed hash mismatch, including a whitespace-only edit, fails verification. Never recompute a ledger hash to “repair” it. Lists isolate invalid plans diagnostically; explicit operations fail on relevant corrupt versions, never silently fall back to an older latest.

## Runs, compatibility, and recovery

New starts write run v3 with required `planRef`. The explicit start selector must match the state selection, and its file/ledger digest must verify **before input checkpoint/ref/run publication**. New starts do not offer an unplanned escape route. Run description, result, and prepared transition must agree on the fixed reference.

State readers accept v1/v2; ordinary new states use v2. Existing run v1/v2 records remain readable/finishable without fabricated plan provenance. Historical files are not migrated or default-filled on read. New binary versions can read old data; old binaries need not accept new formats.

Checkpoint journals are independently versioned:
- Input journal: unchanged envelope v1.
- Legacy run-v2 output: envelope v1 / prepared v1, published as a run-v2 result.
- New run-v3 output: envelope v2 / prepared v3, published as a run-v3 result.

Prepared v3 has its own strict schema, including the fixed plan reference and exact state-v2 transition, but **no checkpoint**. The envelope's checkpoint excludes `outputCommit`; derive that ID from the containing Git commit after sealing. This avoids commit-hash self-reference. Legacy request-key construction stays unchanged; new request keys additionally bind the immutable plan reference.

First v3 output capture verifies the pinned plan through a before-capture callback. Already sealed recovery skips fresh capture and reuses its original prepared result/transition. Plan-integrity diagnostics must not hide run recovery identity. A sealed result is not changed to match a subsequently edited plan, newly selected revision, new timestamp, or changed artifact.

Recovery retains the existing three boundaries: before sealing, after output ref but before run result, and after result but before state append. Retry the exact original finish payload, never rerun merely to repair publication. In particular, the new-start plan gate must not block closing a legacy run. Already prepared transitions retain their original version, missing fields, timestamp, session, and revision.

See [checkpoints.md](checkpoints.md) for Git scope, artifact retention, recovery-only loading, and the distinction between snapshot capture and independently verified reproduction.

## Validation

Coverage must include format/Unicode/byte bounds; numeric IDs; staged publication; CAS and identical/conflicting retries; corruption and orphan handling; explicit selection and mandatory new-run gating; authority and read-only/path safety; old-target reads; old/new run and real Git journal recovery; strict public tool output; and near-limit cross-session context.

Run `pnpm run typecheck`, `pnpm test`, and `pnpm run build`. A successful build does not imply the running DSH process or current session has reloaded new Host tools. No replacement Web server or automatic DSH restart is part of this change.
