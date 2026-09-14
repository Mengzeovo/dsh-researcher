# Git run checkpoints

## Contract

New runs use record version 3 and require both an explicitly selected immutable plan revision and a reproduction recipe. A run is an execution instance, not a chat turn. Prepare code before starting the run. Start captures the **working-file bytes**, including unstaged edits, rather than merely recording HEAD or committing the user's index. It does not launch the command. Finish captures the final state of the same file set, hashes declared artifacts, and publishes the immutable result and its state transition.

A checkpoint proves that particular bytes and metadata were saved. It does **not** prove that a process read those bytes, that all dependencies were declared, or that replay yields the same result. In particular, start/end equality does not detect a file changed and reverted during execution. Do not edit source while an execution is running. For stronger isolation, execute from a separate materialized input snapshot; this first version does not launch or sandbox the research execution for you.

Existing version 1 runs remain readable and finishable without Git. They are explicitly labeled as lacking a code checkpoint; no historical snapshot is fabricated. Existing version 2 checkpoint runs also remain readable/finishable without fabricated plan provenance. All newly started runs require Git, the recipe, and `plan: {plan_id, revision}` matching the verified state selection (including baseline/probe executions). Upgrade tool clients that call start_research_run.

## Starting and finishing

Example additional start field:

```json
{
  "plan": {"plan_id": 1, "revision": 1},
  "reproduction": {
    "command": "python scripts/evaluate.py --seed 7 --output results/seed-7.json",
    "cwd": ".",
    "environment": {
      "python": "3.12.4",
      "dependencies": "requirements.lock",
      "data": "inputs/sample.json; included in input snapshot",
      "determinism": "CPU evaluation, fixed seed"
    },
    "inputs": ["inputs/sample.json"]
  }
}
```

The environment object is descriptive lossless JSON, **not** an environment override and never forwarded to Git. Record dependency lockfiles, container image digests, data versions/checksums and hardware/determinism constraints as appropriate. Do not include credentials in commands, metadata, parameters or files. Put actual reproduction logic in tracked scripts; a transcript is not a runnable recipe.

- Tracked working files plus explicitly named regular input files are captured. Untracked/ignored files are not swept in automatically. Explicit inputs are exact files, not directories/globs.
- The snapshot file set is frozen at start. Finish observes modifications/deletions within that set; it does not silently include files newly tracked during a run.
- .git and .research are excluded, including when tracked. This avoids self-reference and copying project authority into Git snapshots.
- Raw blobs bypass clean/smudge filters. Snapshots represent working bytes, not Git-normalized bytes. Git config, hooks, signing, network operations and the user's real index are not used for snapshot transformation.
- Initial support is POSIX host-local, already committed, plain Git repositories with workspace root equal to repository root and an ordinary .git directory. Windows, linked worktrees, submodules, source symlinks, unresolved/uncommitted merges, shallow/alternate object stores and unsupported config extensions/includes are rejected. Non-UTF-8/control filenames and metadata symlinks/hardlinks are unsupported. These restrictions fail closed rather than silently making an incomplete checkpoint.
- Hard limits: 2,000 captured files, 10 MiB per captured file, 50 MiB total snapshot bytes, 1 GiB total streamed artifact bytes, and 64 KiB per record/journal. Oversized captures are errors, not truncation. Likely secret filenames/private-key content are rejected, but this heuristic is not a comprehensive secret scanner; review what you track and explicitly include.
- A checkout with LFS filters is not a complete LFS archive: raw working bytes are captured subject to the same limits, and external payload availability must be managed separately. No filter is executed by checkpoint capture.
- Large data, external environments and artifact contents are not archived automatically. Artifacts are regular files identified by SHA-256 and byte count; retain originals or an immutable external store when exact bytes must remain available.

Finish is mandatory even for a valid negative result. Scientific negatives remain completed, execution failures remain failed. Checkpoint failures are tool/record-publication failures, not scientific failures. Retry with the same finish payload; do not rerun the experiment just because publication failed.

## Git representation and recovery

Each run has two create-only refs:

```text
refs/dsh/research/<research-id>/runs/<run-id>/input
refs/dsh/research/<research-id>/runs/<run-id>/output
```

The output commit has the input commit as its parent. Both object IDs are pinned in the run records. HEAD, the current branch, the real index, and working files remain unchanged. No commit, stash, checkout, reset or push is performed on the user's branch.

Journal versions are independent of run versions: input envelope v1 is unchanged; legacy output envelope v1 contains prepared v1 and publishes run result v2; new output envelope v2 contains prepared v3 and publishes run result v3. Prepared v3 includes the exact plan reference and state-v2 selection, but no checkpoint. The journal checkpoint excludes outputCommit, derived afterward from the containing Git commit. Old request keys remain unchanged; v3 keys additionally bind the original plan reference. Historical prepared transitions are replayed verbatim, never upgraded or filled from the latest plan. See [plans.md](plans.md).

The output commit message is a recovery journal: it carries the exact prepared result/state and a canonical hash of the caller's finish payload. Publishing follows this order:

1. Validate caller result/state, freeze output and artifact digests, preflight the complete supported checkpoint record (v2/v3) and load context.
2. Create and pin the output commit/ref with compare-and-swap.
3. Publish the closed run record.
4. Append its exact prepared state transition.

A retry after step 2 reads the existing journal and reuses the original hashes, timestamps and files rather than recapturing the current workspace. A changed finish payload is rejected. A retry after step 3 uses the existing immutable run result. No new run may start while the previous run is open or its state transition is pending. Ordinary state updates are refused while a v2/v3 run is open, keeping its base revision stable. This is recoverable multi-resource publication, not an atomic Git/filesystem transaction.

A start that pinned its input but failed to publish its run reports the retained ref. No experiment was launched; the orphan ref may be inspected/removed explicitly by the operator. Do not automatically delete refs on an ambiguous interruption.

The existing single-writer restriction still applies. Per-target locking does not prevent a human, another target or another process from editing source. Finish detects endpoint changes through codeChanged, not arbitrary mid-run edits. Do not run concurrent writers against one execution workspace.

## Loading an interrupted run in another session

Only active targets may start new runs. Paused/blocked starts are rejected before any input checkpoint or run record is created. Existing records from older versions that allowed these starts remain recoverable.

Human `/research-load <research-id>` detects open records and pending prepared transitions. It binds an idle session and returns `mode: recovery-only`, preserving research revision/status and durable Goal fields while disarming a matching armed Goal. Like every load, it queues only one tool-free briefing. Loading skips activation-capacity checks but still rejects conflicting bindings, different unfinished Goals and busy sessions. It never launches an experiment or retries a finish.

`get_research` returns optional `research.recovery` with `run_id`, `phase`, `path`, and a planned `output_ref` for v2/v3; v3 additionally exposes its immutable `plan_ref`:

- `open`: the JSONL has no result. This alone does not prove that execution happened or that the output ref exists. Check original execution evidence; if the output ref exists, read its commit-message journal and reuse `journal.prepared`. Do not rerun an experiment merely because publication failed.
- `pending-state`: the run is closed but its exact prepared transition still needs publication. Read `result` from the run record.

For an interrupted finish, reconstruct only the original caller fields: `status/result/metrics/decision/artifacts` from the stored result, and `research_status/summary/direction/next` from its `transition`. Preserve omitted optional fields. Do not substitute the current old target state or invent new result text. Existing immutable-payload checks remain the authority. For an open run with no sealed result, finish only after establishing the actual execution outcome.

Recovery metadata is derived from authoritative run records, not a new persisted flag. Structured tool metadata is not context-truncated; a short recovery identity remains mandatory, with longer guidance ahead of optional glossary/history. Finishing removes recovery on the next read without activating a Goal. A later `/research-load` still only briefs. Use `/research-start` after explicit human authorization for continuous advancement; completed targets cannot be restarted. Legacy v1 recovery does not require Git.

## Inspecting and reproducing

Inspect code and provenance without touching the current branch:

```bash
git show --no-patch --format=%B <output-commit>
git diff <input-commit> <output-commit>
```

Materialize input blobs in a new empty directory using git ls-tree and git cat-file (preserve recorded paths and executable modes). These raw reads do not apply clean/smudge filters or export attributes; the end-to-end fixture test uses this approach. Do not assume git archive is byte-exact: export-ignore/export-subst attributes can omit or change files.

For normal Git checkout-based replay, create a **separate plain clone**, explicitly fetch the input ref, disable/review checkout hooks and filters, and verify restored files against the captured blobs before executing:

```bash
git clone --no-local <source-repository> <new-directory>
git -C <new-directory> fetch <source-repository> <input-ref>:<input-ref>
git -C <new-directory> checkout --detach <input-commit>
```

The no-local clone avoids hardlinked Git objects, which the current metadata guards reject. A detached linked worktree is useful for inspection/manual replay, but it cannot start a new Researcher run in this MVP because its .git is a link file rather than an ordinary repository directory. For a recorded reproduction run, use the separate plain repository and a new research target; retain provenance to the original run/commit in its parameters.

Review the stored recipe before executing it. Recreate the documented environment/data, run from its relative cwd, and compare metric tolerances and artifact SHA-256 values. Nondeterministic workloads may require statistical comparison rather than byte equality. A reproduction is a **new run**, not a rewrite of the original. This release does not automatically execute a stored command or provide destructive in-place restoration.

Custom refs are not transferred by ordinary clone/push defaults. Back up Git objects **and** the run records. For cross-machine transfer, explicitly export both refs (or a Git bundle with its prerequisite history) and the corresponding .research records. Git LFS payloads, external datasets and environments need separate retention. Do not assume that copying .research alone preserves the checkpoint.

## Validation and limits

The test suite covers working/index isolation, explicit input handling, raw snapshots, immutable ref retries, artifact digests, failed publication recovery, legacy v1 reading/finishing, and preflight rejection. Git-backed fixture replay compares an actual script result from a restored input snapshot with the captured digest. Environment packaging, automatic replay orchestration, cross-process source isolation, submodule/LFS retention and automatic ref export are outside this initial scope.
