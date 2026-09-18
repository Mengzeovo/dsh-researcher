/** Register-owned interaction state; authoritative research records stay in the controller. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { ArchifyCamera } from 'dsh-archify-native/types'
import type { ResearchViewNodeId, ResearchViewSelection, ResearchViewTargetToken } from '../view-types.ts'
import { viewPageKey } from './view-controller.ts'

export interface ResearchViewUiState {
  targetToken: ResearchViewTargetToken | null
  selection: ResearchViewSelection
  selectedNodeId: ResearchViewNodeId | null
  pagesByPlan: Record<string, ResearchViewSelection>
  cameras: Record<string, ArchifyCamera>
}
const firstPage = (planId: number | null): ResearchViewSelection => ({ planId, runPages: {} })
function choose(draft: ResearchViewUiState, selection: ResearchViewSelection, nodeId: ResearchViewNodeId | null): void {
  draft.pagesByPlan[String(draft.selection.planId)] = draft.selection
  draft.selection = { planId: selection.planId, runPages: selection.runPages }
  draft.selectedNodeId = nodeId
}
/** Each session-scoped slot instance retains navigation independently of React mounts. */
export function createResearchViewStore() {
  return defineStore({
    init: (): ResearchViewUiState => ({ targetToken: null, selection: firstPage(null),
      selectedNodeId: null, pagesByPlan: {}, cameras: {} }),
    actions: {
      selectPlan: (draft: ResearchViewUiState, planId: number) => {
        choose(draft, draft.pagesByPlan[String(planId)] ?? firstPage(planId), null)
      },
      selectPage: (draft: ResearchViewUiState, selection: ResearchViewSelection, nodeId: ResearchViewNodeId | null = null) => {
        choose(draft, selection, nodeId)
      },
      selectNode: (draft: ResearchViewUiState, nodeId: ResearchViewNodeId | null) => { draft.selectedNodeId = nodeId },
      accept: (draft: ResearchViewUiState, token: ResearchViewTargetToken,
        selection: ResearchViewSelection, nodeIds: readonly ResearchViewNodeId[]) => {
        if (draft.targetToken !== token) {
          draft.targetToken = token
          draft.pagesByPlan = {}
          draft.cameras = {}
          draft.selectedNodeId = null
        }
        // Normalize retained pre-upgrade state without reintroducing revision paging.
        if ('versionPage' in draft.selection || viewPageKey(draft.selection) !== viewPageKey(selection)) {
          draft.selection = { planId: selection.planId, runPages: selection.runPages }
        }
        if (draft.selectedNodeId !== null && !nodeIds.includes(draft.selectedNodeId)) draft.selectedNodeId = null
      },
      setCamera: (draft: ResearchViewUiState, key: string, camera: ArchifyCamera) => {
        const before = draft.cameras[key]
        if (before?.x !== camera.x || before.y !== camera.y || before.scale !== camera.scale || before.mode !== camera.mode) {
          draft.cameras[key] = camera
        }
      },
    },
  })
}
