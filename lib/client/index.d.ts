/** Web decoration for bare /research-load using the DSH-owned popupSelect shell. */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client';
import type { ResearchTargetList } from '../types.ts';
export declare const inject: string[];
export declare function researchOptions(list: ResearchTargetList): SelectOption[];
/** Fetch the Host's public settings before installing optional view services. */
export declare function apply(ctx: ClientContext): Promise<() => Promise<void>>;
//# sourceMappingURL=index.d.ts.map