import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { type GitRunner } from './git-runtime.ts';
export interface ReproductionSpec {
    command: string;
    cwd: string;
    /** Descriptive lossless JSON only; NEVER passed to a subprocess. */
    environment: Readonly<Record<string, JsonValue>>;
    inputs: readonly string[];
    /** Opt-in partial working-tree overlay. Omitted means historical all-tracked capture. */
    snapshot?: {
        mode: 'scoped';
        paths: readonly string[];
        externalInputs?: readonly ArtifactDigest[] | undefined;
        omitChanges?: readonly string[] | undefined;
    } | undefined;
}
export interface InputCheckpoint {
    backend: 'git';
    inputRef: string;
    outputRef: string;
    inputCommit: string;
    inputTree: string;
    baseHead: string;
    objectFormat: 'sha1' | 'sha256';
    files: readonly string[];
    reproduction: ReproductionSpec;
    snapshot?: {
        mode: 'scoped-overlay';
        deleted: readonly string[];
        omittedChanges: readonly string[];
    } | undefined;
}
export interface ArtifactDigest {
    path: string;
    sha256: string;
    bytes: number;
}
export interface OutputCheckpoint {
    backend: 'git';
    inputCommit: string;
    outputCommit: string;
    inputTree: string;
    outputTree: string;
    inputRef: string;
    outputRef: string;
    objectFormat: 'sha1' | 'sha256';
    artifacts: readonly ArtifactDigest[];
    codeChanged: boolean;
    snapshot?: {
        mode: 'scoped-overlay';
        baseHead: string;
        deleted: readonly string[];
    } | undefined;
}
export declare const CHECKPOINT_MAX_FILE_BYTES: number;
export declare const CHECKPOINT_MAX_SNAPSHOT_BYTES: number;
export declare const CHECKPOINT_MAX_FILES = 2000;
/** Artifacts are streamed, with a hard 1 GiB aggregate cap (also bounds each file). */
export declare const CHECKPOINT_MAX_ARTIFACT_BYTES: number;
export declare const CHECKPOINT_MAX_MESSAGE_BYTES: number;
type FinishResult = {
    checkpoint: OutputCheckpoint;
    prepared: Record<string, JsonValue>;
};
/**
 * Conservative host-local MVP. Node fs is used only for raw, bounded reads and a
 * private temporary index directory after policy/host-boundary checks. Every Git
 * process uses the DSH runtime. No reproduction command is ever executed.
 * Concurrent hostile filesystem mutation is not an OS transaction: no-follow
 * opens, component checks and prepublication stat verification fail closed on
 * observed races; callers must not deliberately swap repository metadata mid-call.
 */
export declare class GitCheckpointProvider {
    private readonly ctx;
    private readonly runner;
    constructor(ctx: Context, runner?: GitRunner);
    private git;
    private ok;
    /** Reject all metadata symlinks/special files, hardlinks and external object stores. */
    private guardMetadata;
    private repo;
    private readRegular;
    /** Ancestors, cwd and explicit inputs/artifacts remain no-follow; only tracked leaf links may be captured. */
    private fileStat;
    private verify;
    private noMerge;
    private tracked;
    /** Capture link text, never target contents. Only relative targets lexically inside the workspace are accepted. */
    private readTrackedSymlink;
    private validateLinkTarget;
    private capture;
    private inScope;
    /** Enumerate names only outside the opt-in scope, never working-file contents. */
    private scopedInventory;
    /** Retained data are checked by streaming, not stored in the code tree. */
    private externalInputs;
    private tree;
    private commit;
    private ref;
    private publish;
    private readCommit;
    private inputBody;
    private validateOverlayTree;
    private validateInput;
    private recover;
    private validatePrepared;
    start(session: Session, researchId: string, runId: string, createdAt: string, reproduction: ReproductionSpec, signal?: AbortSignal, validate?: (checkpoint: InputCheckpoint) => void): Promise<InputCheckpoint>;
    private artifacts;
    finish(session: Session, input: InputCheckpoint, requestKey: string, prepared: Record<string, JsonValue>, signal?: AbortSignal, validate?: (value: FinishResult) => void, beforeCapture?: () => Promise<void>): Promise<FinishResult>;
}
export {};
//# sourceMappingURL=checkpoint.d.ts.map