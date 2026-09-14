/** Test-only App observer loaded by the ordinary profile Loader, never an application bin. */
export const name = 'research-view-acceptance-app';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionQuery', 'fs', 'sandbox', 'sandboxPolicy', 'subprocess'];

/** Expose the injected host context and count lifecycle events without replacing services. */
export function apply(ctx) {
  const activity = { agentsCreated: 0, sessionsCreated: 0, sessionEvents: 0 };
  ctx.on('agent/created', () => { activity.agentsCreated++; });
  ctx.on('session/created', () => { activity.sessionsCreated++; });
  ctx.on('session/event', () => { activity.sessionEvents++; });
  ctx.provide('researchViewFixture', { context: ctx, activity });
}
