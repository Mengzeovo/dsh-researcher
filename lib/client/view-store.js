/** Register-owned interaction state; authoritative research records stay in the controller. */
import { defineStore } from '@deepseek-ai/dsh-client-store';
import { viewPageKey } from "./view-controller.js";
const firstPage = (planId) => ({ planId, versionPage: 0, runPages: {} });
function choose(draft, selection, nodeId) {
    draft.pagesByPlan[String(draft.selection.planId)] = draft.selection;
    draft.selection = selection;
    draft.selectedNodeId = nodeId;
}
/** Each session-scoped slot instance retains navigation independently of React mounts. */
export function createResearchViewStore() {
    return defineStore({
        init: () => ({ targetToken: null, selection: firstPage(null),
            selectedNodeId: null, pagesByPlan: {}, cameras: {} }),
        actions: {
            selectPlan: (draft, planId) => {
                choose(draft, draft.pagesByPlan[String(planId)] ?? firstPage(planId), null);
            },
            selectPage: (draft, selection, nodeId = null) => {
                choose(draft, selection, nodeId);
            },
            selectNode: (draft, nodeId) => { draft.selectedNodeId = nodeId; },
            accept: (draft, token, selection, nodeIds) => {
                if (draft.targetToken !== token) {
                    draft.targetToken = token;
                    draft.pagesByPlan = {};
                    draft.cameras = {};
                    draft.selectedNodeId = null;
                }
                if (viewPageKey(draft.selection) !== viewPageKey(selection))
                    draft.selection = selection;
                if (draft.selectedNodeId !== null && !nodeIds.includes(draft.selectedNodeId))
                    draft.selectedNodeId = null;
            },
            setCamera: (draft, key, camera) => {
                const before = draft.cameras[key];
                if (before?.x !== camera.x || before.y !== camera.y || before.scale !== camera.scale || before.mode !== camera.mode) {
                    draft.cameras[key] = camera;
                }
            },
        },
    });
}
//# sourceMappingURL=view-store.js.map