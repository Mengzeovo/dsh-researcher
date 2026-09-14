/** Cordis-only composition: rules, entry-owned store, and a Native-owned child viewer. */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from 'dsh-archify-native/types'
import type {} from '../view-remote-client.ts'
import { ResearchViewController } from './view-controller.ts'
import { createResearchViewStore } from './view-store.ts'
import { ResearchView } from './ResearchView.tsx'
import type { ResearchViewInjected } from './view-contract.ts'
import { en, zh } from './view-locales.ts'

/** Every value read by this composition has an explicit Cordis injection edge. */
export const VIEW_INJECT = ['slots', 'uiConversation', 'archifyViewer', 'sessions', 'locale', 'theme',
  'remote', 'remote.researchView', 'remote.researcher']

export function installResearchView(ctx: Context, presetIds: readonly string[]): () => void {
  // The existing compiler program combines Host and Client Context service names.
  const sessions = ctx.get('sessions') as unknown as ISessions
  const theme: HostObservable<ThemeSnapshot> = {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: listener => ctx.on('theme/change', listener),
  }
  const store = createResearchViewStore()
  const controllers = new Map<SessionBinding, { controller: ResearchViewController; dispose(): void }>()
  ctx.effect(() => ctx.locale.register('research.view', { en, zh }), 'research.view: dictionaries')
  const t = ctx.locale.bind('research.view')
  const controllerFor = (sessionId: SessionId, actions: BoundActions<typeof store>): ResearchViewController => {
    const binding = sessions.binding(sessionId)
    if (binding === undefined) throw new Error('research-view/session-binding-missing')
    const previous = controllers.get(binding)
    if (previous !== undefined) return previous.controller
    const controller = new ResearchViewController(String(sessionId), {
      async *watchView(signal) {
        for await (const result of ctx.remote.researchView.watchView({ sessionId: String(sessionId) }, signal)) {
          if (!result.ok) throw new Error(result.error.message)
          yield result.value
        }
      },
      getView: async (request, signal) => {
        const result = await ctx.remote.researchView.getView(request, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      getViewNode: async (request, signal) => {
        const result = await ctx.remote.researchView.getViewNode(request, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      renderView: async (request, signal) => {
        const result = await ctx.remote.researchView.renderView(request, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      listTargets: async signal => {
        const result = await ctx.remote.researcher.list({ sessionId: String(sessionId) }, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      loadTarget: async id => {
        const result = await binding.session.command('/research-load ' + id)
        if (!result.ok) throw new Error(result.error.message)
        if (!result.value.matched) throw new Error('research-view/research-load-unavailable')
      },
    }, snapshot => actions.accept(snapshot.targetToken, snapshot.selection, snapshot.nodes.map(node => node.id)))
    const dispose = binding.ctx.effect(() => () => {
      controller.dispose()
      controllers.delete(binding)
    }, 'research.view: binding controller')
    controllers.set(binding, { controller, dispose: () => { void dispose() } })
    return controller
  }
  ctx.effect(() => {
    const reset = ctx.on('connection/reset', () => {
      for (const entry of controllers.values()) entry.controller.invalidate(true)
    })
    return () => {
      reset()
      for (const entry of controllers.values()) entry.dispose()
    }
  }, 'research.view: notifications')
  return ctx.slots.inject('conversation.view', function* () {
    yield ctx.uiConversation.viewLayouts.register({ viewId: 'research-view', layout: 'page' })
    yield ctx.uiConversation.viewVisibility.register({ viewId: 'research-view',
      isVisible: summary => typeof summary.projectionValues?.agentPreset === 'string'
        && presetIds.includes(summary.projectionValues.agentPreset),
    })
    yield ctx.slots.register({
      name: 'conversation.view', id: 'research-view', order: 20, label: () => t('title'),
      children: { 'research.view.diagram': { kind: 'single', scope: 'session' } },
      locale: 'research.view', store,
      inject: (sessionId, actions): ResearchViewInjected => {
        const controller = controllerFor(sessionId, actions)
        return {
          hooks: { researchView: controller.source, researchTheme: theme, researchLocale: ctx.locale },
          enter: (selection, appearance) => controller.enter(selection, appearance),
          leave: () => controller.leave(),
          load: (selection, appearance, force) => controller.load(selection, appearance, force),
          inspectNode: id => controller.selectNode(id),
          listTargets: () => controller.listTargets(),
          loadTarget: id => controller.loadTarget(id),
        }
      },
    }, ResearchView)
    yield ctx.archifyViewer.registerViewer('research.view.diagram')
  })
}
