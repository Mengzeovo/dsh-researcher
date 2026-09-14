/** Owner props and framework-derived seats for the research Conversation View. */
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client';
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client';
import type { ArchifyViewerProps } from 'dsh-archify-native/types';
import type { ResearchViewSelection } from '../view-types.ts';
import type { ResearchViewClientState, ViewAppearance } from './view-controller.ts';
import type { createResearchViewStore } from './view-store.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        'research.view.diagram': {
            kind: 'single';
            scope: 'session';
            owner: ArchifyViewerProps;
        };
    }
}
export interface ResearchViewInjected {
    hooks: {
        researchView: HostObservable<ResearchViewClientState>;
        researchTheme: HostObservable<ThemeSnapshot>;
        researchLocale: HostObservable<LocaleSnapshot>;
    };
    enter(selection: ResearchViewSelection, appearance: ViewAppearance): Promise<void>;
    leave(): void;
    load(selection: ResearchViewSelection, appearance: ViewAppearance, force?: boolean): Promise<void>;
    inspectNode(id: string | null): Promise<void>;
    listTargets(): Promise<void>;
    loadTarget(id: string): Promise<void>;
}
export type ResearchViewProps = PropsRuntime<'conversation.view'> & PropsRenderSlots<'research.view.diagram'> & PropsStore<ReturnType<typeof createResearchViewStore>> & PropsLocale<'research.view'> & InjectFace<ResearchViewInjected>;
//# sourceMappingURL=view-contract.d.ts.map