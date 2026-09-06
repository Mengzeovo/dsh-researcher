import type { Context } from '@deepseek-ai/cordis';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
/** Exact argv (including executable), binary stdin, bounded binary stdout. No shell. */
export interface GitCommand {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly policy: SandboxExecutionPolicy;
    readonly stdin?: Buffer;
    readonly signal?: AbortSignal;
    readonly maxOutputBytes: number;
}
export interface GitResult {
    readonly stdout: Buffer;
    readonly stderr: Buffer;
    readonly exitCode: number | null;
}
export type GitRunner = (command: GitCommand) => Promise<GitResult>;
/** Tombstones matter: the alpha.3 subprocess service MERGES env onto its parent. */
export declare function gitEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare const GIT_SAFETY_ARGS: readonly string[];
/** Production always uses the installed DSH subprocess + sandbox capability seams. */
export declare function createGitRunner(ctx: Context): GitRunner;
//# sourceMappingURL=git-runtime.d.ts.map