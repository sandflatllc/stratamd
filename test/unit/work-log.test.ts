import { describe, expect, it } from 'vitest'
import { deriveWorkEntries, groupWorkRows } from '../../src/core/work-log'
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

  it('groups finished work behind a toggle and leaves the running turn live', () => {
    const entries = deriveWorkEntries([
      activity('old', 'tool.completed', { itemType: 'mcp_tool_call', detail: 'Read issue', status: 'completed' }, 'tool', 'turn-1'),
      activity('live', 'tool.updated', { itemType: 'command_execution', detail: 'vitest run', status: 'inProgress' }, 'tool', 'turn-2'),
    ])
    expect(groupWorkRows(entries, [{ id: 'turn-1', finished: true }, { id: 'turn-2', running: true }])).toEqual([
      expect.objectContaining({ turnId: 'turn-1', hiddenCount: 1, foldedByDefault: true, live: false, summary: 'Used 1 tool', summaryIcon: 'wrench' }),
      expect.objectContaining({ turnId: 'turn-2', hiddenCount: 1, foldedByDefault: false, live: true, showWorking: true, showThinking: false }),
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
