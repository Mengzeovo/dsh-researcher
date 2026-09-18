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

- By default, tracked working files plus explicitly named regular input files are captured. The opt-in scoped mode below restricts working-tree capture; it is not a complete repository snapshot. Tracked leaf symlinks are saved as Git mode `120000` and their raw link-target bytes, never target contents. Relative targets must resolve lexically inside the workspace and cannot name excluded metadata or likely secrets; dangling in-workspace targets are allowed. This does not capture transitive target dependencies or guarantee target availability on replay. Untracked/ignored files are not swept in automatically. Explicit inputs are exact regular files, not directories/globs/symlinks, including when also tracked and when finishing a run.
- The snapshot file set is frozen at start. Finish observes modifications/deletions within that set; it does not silently include files newly tracked during a run. Scoped mode additionally rejects newly introduced, non-ignored source files under the declared paths.
- .git and .research are excluded, including when tracked. This avoids self-reference and copying project authority into Git snapshots.
- Raw blobs bypass clean/smudge filters. Snapshots represent working bytes, not Git-normalized bytes. Git config, hooks, signing, network operations and the user's real index are not used for snapshot transformation.
- Initial support is POSIX host-local, already committed, plain Git repositories with workspace root equal to repository root and an ordinary .git directory. Windows, linked worktrees, submodules, symlink ancestors/cwd/explicit inputs/artifacts, unsafe tracked symlink targets, unresolved/uncommitted merges, shallow/alternate object stores and unsupported config extensions/includes are rejected. Non-UTF-8/control filenames and metadata symlinks/hardlinks are unsupported. These restrictions fail closed rather than silently making an incomplete checkpoint.
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

Journal versions are independent of run versions: all-tracked input envelope v1 is unchanged; legacy output envelope v1 contains prepared v1 and publishes run result v2; all-tracked output envelope v2 contains prepared v3 and publishes run result v3. Opt-in scoped overlays use input envelope v2 and output envelope v3/prepared v3, while run records remain v3 (see the scoped protocol below). Prepared v3 includes the exact plan reference and state-v2 selection, but no checkpoint. The journal checkpoint excludes outputCommit, derived afterward from the containing Git commit. Old request keys remain unchanged; v3 keys additionally bind the original plan reference. Historical prepared transitions are replayed verbatim, never upgraded or filled from the latest plan. See [plans.md](plans.md).

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

## Opt-in experiment-input scope for large repositories

Omit `reproduction.snapshot` to retain historical all-tracked behavior, unchanged limits and legacy journal shapes. To capture only the experiment inputs, add an explicit object:

```json
{
  "snapshot": {
    "mode": "scoped",
    "paths": ["src/model", "scripts", "CMakeLists.txt", "requirements.lock"],
    "externalInputs": [
      {"path": "inputs/example.bin", "bytes": 3, "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}
    ]
  }
}
```

This example digest is for exactly the three ASCII bytes `abc`, not for your dataset. Compute and substitute the actual size and SHA-256 of every retained input. The example scope must also be replaced with actual dependency paths that exist in your project.

### Selection and limits

- `paths` is a nonempty list of at most 128 canonical workspace-relative **exact files or component-aligned directory prefixes**, not globs. No dot root, trailing slash, duplicate/overlapping scopes, metadata or likely secrets. Include build entry points, transitive modules, dependency locks and execution/analysis scripts—not just the edited algorithm file. A scope matching no tracked or explicitly declared input is an error at start.
- Within the scope, capture the union of paths in the pinned HEAD and real index, using their **actual working bytes**. Include explicit `reproduction.inputs` even outside those prefixes. This preserves unstaged edits, staged additions and tracked deletions without changing the user's index/HEAD. Only names, not working contents, are inspected outside the scope.
- Non-ignored untracked files within scope must be explicitly declared in `inputs` or `externalInputs`; they are never silently swept into the tree. **Ignored files are not enumerated**: the caller must explicitly list every needed ignored input. This tool cannot infer runtime dependencies or prove dependency completeness. Keep generated outputs outside source prefixes or appropriately ignored; declare result artifacts normally.
- Uncaptured tracked **working-tree differences from the pinned base** are an error by default. After reviewing that they are irrelevant, declare their exact path list as `snapshot.omitChanges`. The observed list must match exactly and is stored as `checkpoint.snapshot.omittedChanges` and surfaced as `omitted_changes`. Their working bytes are **not saved**; baseline bytes will be used during replay. Index-only edits whose worktree matches the baseline do not change execution bytes and are not claimed to be captured. Never acknowledge omission of a necessary local dependency.
- `externalInputs` declares up to 128 retained **regular data files**, with exact path, byte count and lowercase SHA-256. They are excluded from code blobs even if tracked within scope; they cannot also occur in `inputs`. Both start and the first finish stream-check them (aggregate at most the existing 1 GiB artifact budget), with no-follow paths and prepublication stat checks. A missing/mismatched input rejects publication. Preserve them unchanged until initial sealing and retain their exact bytes for replay; a hash is not a data backup. Once the output journal is sealed, recovery uses that immutable journal and does not require current data/artifact files to remain available.
- Capture limits stay **2000 files, 10 MiB per code file, 50 MiB code bytes, 64 KiB per JSONL record/journal**. The retained baseline already exists as Git objects and is not reread or recaptured as working files. Names/deletion/acknowledgement lists still consume metadata space; no truncation or automatic broad-scope fallback is allowed. The complete run description is now preflighted **before publishing the input ref**, not merely the caller-supplied recipe.

### Partial-overlay identity and recovery

The input checkpoint is marked `snapshot.mode: "scoped-overlay"`, with its missing frozen paths in `snapshot.deleted`. Its `baseHead` is the input commit's parent, hence remains reachable through the retained input ref. This does not create a new full working-tree copy, but it also does not erase existing baseline/history objects—including previously committed data—from Git.

The output snapshot records the same base and the final deletion list. `codeChanged` compares only the captured overlay trees, **not the whole repository**. Scope selection is frozen; finish rejects newly introduced scoped source paths, while deletion of a frozen index-only addition remains representable. Recovery validates mode, type, sizes, link targets and tree/deletion consistency, not just filenames.

Scoped input journals use envelope version **2**; scoped output journals use envelope version **3** with prepared result version **3**. Run records remain plan-bound version **3**, state and plan versions are unchanged. Old input envelope 1 and output envelope 1/prepared 1 or envelope 2/prepared 3 remain readable and recover without schema defaults being inserted. Older plugin builds do not understand scoped journals; upgrade/load the new backend before starting scoped runs and do not downgrade while one is open.

**Do not directly check out a scoped input/output commit as a complete source tree.** In a new isolated destination only:

1. Fetch and retain the original input/output refs and their history. Materialize the exact `baseHead`, not current HEAD; for byte-exact handling use `git ls-tree` / `git cat-file`, avoiding checkout filters and export attributes.
2. Overlay the chosen input or output tree's raw blobs, preserving regular/executable mode and relative symlink bytes. Replace leaf entries without following links; reject symlink ancestors or unexpected path/type collisions. Do not copy `.git` or `.research` into the materialized source directory.
3. Apply that checkpoint's explicit deletion list to remove baseline files absent from the overlay. Validate that deletion names belong to the frozen set and do not simultaneously occur in the chosen tree.
4. Supply the separately retained external data at its recorded relative paths and recheck sizes/hashes. Recreate the stated environment, inspect the recipe, then run it under the ordinary new-run protocol and compare results independently.

No automatic restoration, execution or service restart is added. The scoped regression fixture reconstructs base plus raw overlay plus deletion in a separate directory, supplies the retained data and executes a deterministic script whose result matches the sealed artifact SHA-256. This is an engineering fixture, not a reproduced domain experiment.

## Inspecting and reproducing

Inspect code and provenance without touching the current branch:

```bash
git show --no-patch --format=%B <output-commit>
git diff <input-commit> <output-commit>
```

For the default **all-tracked** snapshot only, materialize input blobs in a new empty directory using git ls-tree and git cat-file (preserve recorded paths and executable modes). These raw reads do not apply clean/smudge filters or export attributes; the end-to-end fixture test uses this approach. Do not assume git archive is byte-exact: export-ignore/export-subst attributes can omit or change files.

For normal Git checkout-based replay of an **all-tracked** snapshot (not a scoped overlay), create a **separate plain clone**, explicitly fetch the input ref, disable/review checkout hooks and filters, and verify restored files against the captured blobs before executing:

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
