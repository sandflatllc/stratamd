import { describe, expect, it } from 'vitest'
import { chooseAutoInstance, deriveAccountState } from '../../src/core/accountState'

const provider = (instanceId: string, usedPercent: number) => ({ instanceId, driver: 'codex', enabled: true, status: 'ready', auth: { status: 'authenticated', type: 'chatgpt', label: 'Plus' }, usage: { applicable: true, session: { usedPercent, resetsAt: '2026-09-04T00:00:00Z', measuredAt: '2026-09-03T00:00:00Z' }, weekly: null } })
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
