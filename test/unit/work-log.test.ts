import { describe, expect, it } from 'vitest'
import { deriveTurnFold, deriveWorkEntries, formatWorkDuration, groupWorkRows, type WorkGroupRow } from '../../src/core/work-log'
import type { EngineActivityView } from '../../src/shared/contracts'

const at = '2026-09-04T12:00:00.000Z'

function activity(id: string, kind: string, payload: unknown, tone: EngineActivityView['tone'] = 'tool', turnId = 'turn-1'): EngineActivityView {
  return { id, kind, payload, tone, turnId, createdAt: at, summary: kind === 'runtime.error' ? 'Command failed' : 'Ran command' }
}

describe('work log', () => {
  it('turns the observed 287-activity feed shape into one row per tool call', () => {
    const activities: EngineActivityView[] = []
    for (let index = 0; index < 80; index += 1) {
      const toolCallId = `call-${index}`
      const command = index === 0 ? 'pnpm test' : `printf ${index}`
      activities.push(
        activity(`start-${index}`, 'tool.started', { itemType: 'command_execution', detail: command, toolCallId, status: 'inProgress' }),
        activity(`update-${index}`, 'tool.updated', { itemType: 'command_execution', detail: command, data: { toolCallId, command }, status: 'inProgress' }),
        activity(`complete-${index}`, 'tool.completed', { itemType: 'command_execution', detail: command, data: { toolCallId, command }, status: index === 79 ? 'failed' : 'completed' }, index === 79 ? 'error' : 'tool'),
      )
    }
    for (let index = 0; index < 40; index += 1) activities.push(activity(`context-${index}`, 'context-window.updated', { tokens: index }, 'info'))
    for (let index = 0; index < 7; index += 1) activities.push(activity(`task-${index}`, 'task.started', { taskId: `task-${index}`, taskType: 'background', agentKind: 'background' }, 'info'))
    expect(activities).toHaveLength(287)

    const entries = deriveWorkEntries(activities)
    expect(entries).toHaveLength(80)
    expect(entries.some((entry) => entry.sourceActivityKind === 'tool.started')).toBe(false)
    expect(entries.some((entry) => entry.sourceActivityKind === 'context-window.updated')).toBe(false)
    expect(entries[0]).toMatchObject({ heading: 'Ran pnpm', preview: 'pnpm test', command: 'pnpm test', active: false })
    expect(entries.at(-1)).toMatchObject({ failed: true, tone: 'error' })
  })

  it('collapses an update and completion without a repeated call id when their normalized labels match', () => {
    const entries = deriveWorkEntries([
      activity('one', 'tool.updated', { itemType: 'web_search', detail: 'Looking up the API', toolCallId: 'search-1', toolTitle: 'web-search', status: 'inProgress' }),
      activity('two', 'tool.completed', { itemType: 'web_search', detail: 'Found the API', toolTitle: 'Web search', status: 'completed' }),
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'one', detail: 'Found the API', icon: 'search', active: false })
  })

  it('drops an id-less, status-less update once the same call reports completion, so one command counts once', () => {
    const entries = deriveWorkEntries([
      activity('marker', 'tool.updated', { itemType: 'command_execution', detail: 'node build.mjs' }),
      activity('other', 'tool.completed', { itemType: 'command_execution', detail: 'ls', toolCallId: 'c0', status: 'completed' }),
      activity('done', 'tool.completed', { itemType: 'command_execution', detail: 'node build.mjs', toolCallId: 'c1', status: 'completed' }),
      activity('late-marker', 'tool.updated', { itemType: 'command_execution', detail: 'node build.mjs' }),
    ])
    expect(entries.map((entry) => entry.id)).toEqual(['other', 'done', 'late-marker'])
    expect(groupWorkRows(entries, [{ id: 'turn-1', finished: true }])[0]?.summary).toBe('Ran 3 commands')
  })

  it('groups finished work behind a toggle and leaves the running turn live', () => {
    const entries = deriveWorkEntries([
      activity('old', 'tool.completed', { itemType: 'mcp_tool_call', detail: 'Read issue', status: 'completed' }, 'tool', 'turn-1'),
      activity('live', 'tool.updated', { itemType: 'command_execution', detail: 'vitest run', status: 'inProgress' }, 'tool', 'turn-2'),
    ])
    expect(groupWorkRows(entries, [{ id: 'turn-1', finished: true }, { id: 'turn-2', running: true }])).toEqual([
      expect.objectContaining({ turnId: 'turn-1', hiddenCount: 1, foldedByDefault: true, live: false, summary: 'Used 1 tool', summaryIcon: 'wrench' }),
      expect.objectContaining({ turnId: 'turn-2', hiddenCount: 1, foldedByDefault: true, live: true, showWorking: true, showThinking: false }),
    ])
  })

  it('keeps the newest finished work folded and splits work around prose chronologically', () => {
    const entries = deriveWorkEntries([
      { ...activity('before', 'tool.completed', { itemType: 'command_execution', data: { command: ['/usr/bin/bash', '-lc', 'rg -n cockpit src'] }, status: 'completed' }), createdAt: '2026-09-04T12:00:01.000Z' },
      { ...activity('after', 'tool.completed', { itemType: 'file_change', detail: 'src/core/work-log.ts', status: 'completed' }), createdAt: '2026-09-04T12:00:03.000Z' },
    ])
    expect(entries[0]).toMatchObject({ heading: 'Ran rg', command: 'rg -n cockpit src', preview: 'rg -n cockpit src' })
    const groups = groupWorkRows(entries, [{ id: 'turn-1', finished: true }], [
      { id: 'message', turnId: 'turn-1', createdAt: '2026-09-04T12:00:02.000Z' },
    ])
    expect(groups).toHaveLength(2)
    expect(groups.every((group) => group.foldedByDefault && !group.live)).toBe(true)
    expect(groups.map((group) => group.summary)).toEqual(['Ran 1 command', 'Changed 1 file'])
  })

  it('unwraps a string shell launcher before choosing the command heading', () => {
    const [entry] = deriveWorkEntries([
      activity('wrapped', 'tool.completed', { itemType: 'command_execution', data: { command: '/usr/bin/bash -lc "sed -n \\"1,20p\\" src/main/index.ts"' }, status: 'completed' }),
    ])
    expect(entry).toMatchObject({ heading: 'Ran sed', command: 'sed -n "1,20p" src/main/index.ts' })
  })
})

describe('turn folds', () => {
  const user = { id: 'user', role: 'user' as const, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', streaming: false }
  const progress = { id: 'progress', role: 'assistant' as const, createdAt: '2026-01-01T00:00:05.000Z', updatedAt: '2026-01-01T00:00:06.000Z', streaming: false }
  const answer = { id: 'answer', role: 'assistant' as const, createdAt: '2026-01-01T00:00:20.000Z', updatedAt: '2026-01-01T00:00:22.000Z', streaming: false }
  const group = (id: string, createdAt: string, extra: Partial<WorkGroupRow> = {}): WorkGroupRow => ({ id, turnId: 'turn-1', createdAt, entries: [], hiddenCount: 1, summary: 'Ran 1 command', summaryIcon: 'terminal', hasFailure: false, live: false, foldedByDefault: true, showWorking: false, showThinking: false, ...extra })
  const work = group('work', '2026-01-01T00:00:08.000Z')

  it('folds a completed turn to the owner message, one disclosure at the first hidden row, and the final answer', () => {
    const fold = deriveTurnFold({ id: 'turn-1', messages: [user, progress, answer], groups: [work], running: false, latestTurn: null })
    expect(fold).toMatchObject({ turnId: 'turn-1', anchorId: 'progress', hiddenIds: ['progress', 'work'], interrupted: false, hasFailure: false })
    // Owner message (00:00) to the answer's last update (00:22), the later of the answer and the last trace.
    expect(fold?.label).toBe('Worked for 22s')
    expect(deriveTurnFold({ id: 'turn-1', messages: [user, answer], groups: [], running: false, latestTurn: null })).toBeNull()
  })

  it('prefers the latest turn stamps and marks a failed trace', () => {
    const fold = deriveTurnFold({ id: 'turn-1', messages: [user, progress, answer], groups: [group('work', '2026-01-01T00:00:08.000Z', { hasFailure: true })], running: false, latestTurn: { id: 'turn-1', state: 'completed', startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:48.000Z' } })
    expect(fold).toMatchObject({ label: 'Worked for 47s', hasFailure: true })
    const other = deriveTurnFold({ id: 'turn-1', messages: [user, progress, answer], groups: [work], running: false, latestTurn: { id: 'turn-2', state: 'completed', startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:48.000Z' } })
    expect(other?.label).toBe('Worked for 22s')
  })

  it('keeps running, streaming, and not-yet-completed turns open', () => {
    expect(deriveTurnFold({ id: 'turn-1', messages: [user, progress, answer], groups: [work], running: true, latestTurn: null })).toBeNull()
    expect(deriveTurnFold({ id: 'turn-1', messages: [user, progress, { ...answer, streaming: true }], groups: [work], running: false, latestTurn: null })).toBeNull()
    expect(deriveTurnFold({ id: 'turn-1', messages: [user, progress, answer], groups: [work], running: false, latestTurn: { id: 'turn-1', state: 'running', startedAt: '2026-01-01T00:00:01.000Z', completedAt: null } })).toBeNull()
    expect(deriveTurnFold({ id: 'turn-1', messages: [user, progress, answer], groups: [work], running: false, latestTurn: { id: 'turn-1', state: 'interrupted', startedAt: '2026-01-01T00:00:01.000Z', completedAt: null } })).toBeNull()
    // Right after Send the previous turn is still the latest one and stays folded.
    expect(deriveTurnFold({ id: 'turn-1', messages: [user, progress, answer], groups: [work], running: false, latestTurn: { id: 'turn-1', state: 'completed', startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:48.000Z' } })).not.toBeNull()
  })

  it('labels an interrupted latest turn with how long it ran before the stop', () => {
    const stopped = deriveTurnFold({ id: 'turn-1', messages: [user, progress], groups: [work], running: false, latestTurn: { id: 'turn-1', state: 'interrupted', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:47.000Z' } })
    expect(stopped).toMatchObject({ label: 'You stopped after 47s', interrupted: true, anchorId: 'work', hiddenIds: ['work'] })
    const unstamped = deriveTurnFold({ id: 'turn-1', messages: [], groups: [group('work', 'not a date')], running: false, latestTurn: { id: 'turn-1', state: 'interrupted', startedAt: null, completedAt: '2026-01-01T00:00:47.000Z' } })
    expect(unstamped).toMatchObject({ label: 'You stopped this response', duration: null })
  })

  it('names every hidden row so a navigation target inside the turn can open it', () => {
    const fold = deriveTurnFold({ id: 'turn-1', messages: [user, progress, { ...progress, id: 'second', createdAt: '2026-01-01T00:00:09.000Z' }, answer], groups: [work], running: false, latestTurn: null })
    expect(fold?.hiddenIds).toEqual(['progress', 'work', 'second'])
    expect(fold?.hiddenIds).not.toContain('answer')
    expect(fold?.hiddenIds).not.toContain('user')
  })

  it('formats durations the way T3 does', () => {
    expect([500, 4_000, 9_960, 47_000, 180_000, 1_036_000].map(formatWorkDuration)).toEqual(['500ms', '4.0s', '10s', '47s', '3m', '17m 16s'])
  })

  it('settles a call that never reported completion once its turn has finished', () => {
    const entries = deriveWorkEntries([activity('live', 'tool.updated', { itemType: 'command_execution', detail: 'electron-vite build', status: 'inProgress' })])
    expect(entries[0]).toMatchObject({ active: true, heading: 'Running electron-vite' })
    expect(groupWorkRows(entries, [{ id: 'turn-1', running: true }])[0]?.entries[0]).toMatchObject({ active: true, heading: 'Running electron-vite' })
    expect(groupWorkRows(entries, [{ id: 'turn-1', finished: true }])[0]?.entries[0]).toMatchObject({ active: false, heading: 'Ran electron-vite' })
  })
})
