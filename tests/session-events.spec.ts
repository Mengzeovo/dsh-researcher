import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { sessionEventAt, sessionEvents, sessionNextSeq } from '../src/session-events.ts'

const start = { type: 'turn/start', data: {} } as SessionEvent
const human = { type: 'user/message', data: { source: { kind: 'user' } } } as SessionEvent
const asSession = (value: object) => value as Session
const unsupported = expect.objectContaining({ code: 'RESEARCH_SESSION_API_UNSUPPORTED' })

describe.each(['legacy', 'modern'] as const)('%s Session event access', api => {
  it('preserves absolute positions and stable snapshots across append', () => {
    const events = [start, human]
    const session = asSession(api === 'legacy' ? { events } : {
      snapshotEvents() { return Object.freeze(events.slice()) },
      get seq() { return events.length },
      eventAt(seq: number) { return events[seq] },
    })
    const snapshot = sessionEvents(session)
    expect(snapshot).toEqual([start, human])
    expect(sessionNextSeq(session)).toBe(2)
    expect(sessionEventAt(session, 0)).toBe(start)
    expect(sessionEventAt(session, 1)).toBe(human)
    expect(sessionEventAt(session, 2)).toBeUndefined()
    events.push(start)
    expect(snapshot).toEqual([start, human])
    expect(sessionEvents(session)).toEqual([start, human, start])
    expect(sessionNextSeq(session)).toBe(3)
    expect(sessionEventAt(session, 2)).toBe(start)
  })

  it('handles an empty session', () => {
    const session = asSession(api === 'legacy' ? { events: [] } : {
      snapshotEvents: () => [], seq: 0, eventAt: () => undefined,
    })
    expect(sessionEvents(session)).toEqual([])
    expect(sessionNextSeq(session)).toBe(0)
    expect(sessionEventAt(session, 0)).toBeUndefined()
  })
})

describe('Session API selection and errors', () => {
  it('prefers all modern capabilities, preserves method receivers, and never reads legacy events', () => {
    const snapshot = Object.freeze([start, human])
    const session = asSession({
      get events(): never { throw new Error('legacy events must not be read') },
      snapshotEvents() { expect(this).toBe(session); return snapshot },
      get seq() { expect(this).toBe(session); return 7 },
      eventAt(seq: number) { expect(this).toBe(session); return seq === 6 ? human : undefined },
    })
    expect(sessionEvents(session)).toBe(snapshot)
    expect(sessionNextSeq(session)).toBe(7)
    expect(sessionEventAt(session, 6)).toBe(human)
    expect(sessionEventAt(session, 7)).toBeUndefined()
  })

  it.each([undefined, null, {}, 'events'])(
    'rejects absent or malformed legacy arrays: %j', events => {
      const session = asSession({ events })
      expect(() => sessionEvents(session)).toThrow(unsupported)
      expect(() => sessionNextSeq(session)).toThrow(unsupported)
      expect(() => sessionEventAt(session, 0)).toThrow(unsupported)
    },
  )

  it.each([null, 1, 'snapshot'])(
    'rejects malformed snapshotEvents without legacy fallback: %j', snapshotEvents => {
      expect(() => sessionEvents(asSession({ snapshotEvents, events: [start] }))).toThrow(unsupported)
    },
  )

  it.each([undefined, null, {}, 'events'])(
    'rejects malformed snapshot results without legacy fallback: %j', result => {
      expect(() => sessionEvents(asSession({ snapshotEvents: () => result, events: [start] })))
        .toThrow(unsupported)
    },
  )

  it.each([null, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2'])(
    'rejects invalid modern seq without legacy fallback: %j', seq => {
      expect(() => sessionNextSeq(asSession({ seq, events: [start] }))).toThrow(unsupported)
    },
  )

  it.each([null, 3, 'eventAt'])(
    'rejects malformed eventAt without legacy fallback: %j', eventAt => {
      expect(() => sessionEventAt(asSession({ eventAt, events: [start] }), 0)).toThrow(unsupported)
    },
  )

  it.each([null, false, 3, {}, { type: 7 }])('rejects malformed eventAt results: %j', result => {
    expect(() => sessionEventAt(asSession({ eventAt: () => result, events: [start] }), 0))
      .toThrow(unsupported)
  })

  it.each([-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid requested positions before invoking the host: %j', seq => {
      const eventAt = vi.fn()
      expect(() => sessionEventAt(asSession({ eventAt }), seq)).toThrow(unsupported)
      expect(eventAt).not.toHaveBeenCalled()
    },
  )

  it('propagates modern method and getter exceptions unchanged, without fallback', () => {
    const failure = new Error('host API failure')
    const fail = () => { throw failure }
    expect(() => sessionEvents(asSession({ snapshotEvents: fail, events: [] }))).toThrow(failure)
    expect(() => sessionEventAt(asSession({ eventAt: fail, events: [] }), 0)).toThrow(failure)
    const session = asSession({ get seq() { throw failure }, events: [] })
    expect(() => sessionNextSeq(session)).toThrow(failure)
    for (const [member, call] of [
      ['snapshotEvents', sessionEvents],
      ['eventAt', (s: Session) => sessionEventAt(s, 0)],
    ] as const) {
      const withGetter = asSession(Object.defineProperty({ events: [] }, member, { get: fail }))
      expect(() => call(withGetter)).toThrow(failure)
    }
  })
})
