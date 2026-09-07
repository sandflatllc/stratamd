import { describe, expect, it } from 'vitest'
import { chooseAutoInstance, deriveAccountState } from '../../src/core/accountState'

const provider = (instanceId: string, usedPercent: number) => ({ instanceId, driver: 'codex', enabled: true, status: 'ready', auth: { status: 'authenticated', type: 'chatgpt', label: 'Plus' }, usage: { applicable: true, session: { usedPercent, resetsAt: '2026-09-04T00:00:00Z', measuredAt: '2026-09-03T12:00:00Z' }, weekly: null } })
describe('account verdicts ported from the T3 fork', () => {
  it('shows the same ready, limited, parked, and Auto ordering', () => {
    const nowMs = Date.parse('2026-09-03T12:00:00Z')
    const ready = deriveAccountState({ provider: provider('low', 20), parked: false, nowMs })
    const limited = deriveAccountState({ provider: provider('full', 100), parked: false, nowMs })
    const parked = deriveAccountState({ provider: provider('parked', 1), parked: true, nowMs })
    expect([ready.state, limited.state, parked.state]).toEqual(['ready', 'limited', 'parked'])
    expect(chooseAutoInstance([{ instanceId: 'full', derived: limited }, { instanceId: 'low', derived: ready }], null)?.instanceId).toBe('low')
  })
})

it('marks old and expired sub-100 readings stale without pretending they reset to zero', () => {
  const nowMs = Date.parse('2026-09-03T12:00:00Z')
  const p = provider('old', 6)
  p.usage.session.measuredAt = '2026-09-03T11:00:00Z'
  expect(deriveAccountState({ provider: p, parked: false, nowMs })).toMatchObject({ state: 'stale', pressure: 6, usable: true })
  p.usage.session.measuredAt = '2026-09-03T11:55:00Z'
  p.usage.session.resetsAt = '2026-09-03T11:59:00Z'
  expect(deriveAccountState({ provider: p, parked: false, nowMs })).toMatchObject({ state: 'stale', pressure: 6 })
})

it('applies the Fable cap only to Fable while shared limits block every model', () => {
  const nowMs = Date.parse('2026-09-03T12:00:00Z')
  const p = { ...provider('claude', 10), driver: 'claudeAgent', usage: { ...provider('claude', 10).usage, modelWindows: [{ model: 'Fable', usedPercent: 100, resetsAt: '2026-09-04T00:00:00Z', measuredAt: '2026-09-03T12:00:00Z' }] } }
  expect(deriveAccountState({ provider: p, parked: false, nowMs, model: 'claude-fable-5-1' })).toMatchObject({ state: 'limited', pressure: 100, usable: false })
  expect(deriveAccountState({ provider: p, parked: false, nowMs, model: 'claude-sonnet-5' })).toMatchObject({ state: 'ready', pressure: 10, usable: true })
  p.usage.session.usedPercent = 100
  expect(deriveAccountState({ provider: p, parked: false, nowMs, model: 'claude-sonnet-5' })).toMatchObject({ state: 'limited', usable: false })
  const afterReset = Date.parse('2026-09-04T00:01:00Z')
  expect(deriveAccountState({ provider: p, parked: false, nowMs: afterReset, model: 'claude-fable-5-1' })).toMatchObject({ state: 'stale', usable: true })
})
