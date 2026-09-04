import type { Context } from '@deepseek-ai/cordis';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { Session } from '@deepseek-ai/dsh-session';
export declare function ensureResearchDirectories(ctx: Context, session: Session, relatives: readonly string[]): Promise<SandboxExecutionPolicy>;
export declare function commitResearchDirectory(ctx: Context, session: Session, stagingRelative: string, finalRelative: string): Promise<void>;
export declare function discardResearchStaging(ctx: Context, session: Session, stagingRelative: string): Promise<void>;
//# sourceMappingURL=directories.d.ts.map