/** Cordis-only composition: rules, entry-owned store, and a Native-owned child viewer. */
import type { Context } from '@deepseek-ai/cordis';
/** Every value read by this composition has an explicit Cordis injection edge. */
export declare const VIEW_INJECT: string[];
export declare function installResearchView(ctx: Context, presetIds: readonly string[]): () => void;
//# sourceMappingURL=view-apply.d.ts.map