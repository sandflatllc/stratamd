import { describe, expect, it } from 'vitest'
import { buildProjectsRail, previewProjectFolderThreads, resolveShelfThreads, sortProjectFolderThreads } from '../../src/core/projects-rail'
import type { EngineProjectView, EngineThreadView } from '../../src/shared/contracts'

const now = Date.parse('2026-09-04T12:00:00.000Z')

function thread(id: string, overrides: Partial<EngineThreadView> = {}): EngineThreadView {
  return {
    id, projectId: 'p1', title: id, model: 'gpt-5.6', providerInstanceId: 'codex', effort: null, access: 'full-access', status: 'idle',
    updatedAt: '2026-09-04T10:00:00.000Z', unread: false, pendingApprovals: false, pendingUserInput: false, activeTurnId: null, turnStartedAt: null,
    messages: [], activities: [], items: [], documents: [], pinnedAt: null, snoozedUntil: null, lifecycle: 'active', archived: false, attention: 0, pendingWork: 0,
    ...overrides,
  }
}

function project(threads: EngineThreadView[]): EngineProjectView {
  return { id: 'p1', title: 'StrataMD', workspaceRoot: '/work/strata', threads }
}

describe('projects rail', () => {
  it('puts a snoozed settled thread on Snoozed and removes archived threads', () => {
    const view = buildProjectsRail([project([
      thread('both', { lifecycle: 'settled', snoozedUntil: '2026-09-04T13:00:00.000Z' }),
      thread('settled', { lifecycle: 'settled' }),
      thread('archived', { archived: true }),
    ])], { nowMs: now })
    expect(view.snoozed.map((entry) => entry.thread.id)).toEqual(['both'])
    expect(view.settled.map((entry) => entry.thread.id)).toEqual(['settled'])
    expect([...view.folders.flatMap((folder) => folder.threads), ...view.snoozed.map((entry) => entry.thread), ...view.settled.map((entry) => entry.thread)].some((entry) => entry.id === 'archived')).toBe(false)
  })

  it('sorts favorites first and exempts all of them from the non-favorite preview cap', () => {
    const threads = sortProjectFolderThreads([
      thread('ordinary-new', { updatedAt: '2026-09-04T11:00:00.000Z' }),
      thread('favorite-old', { pinnedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }),
      thread('favorite-new', { pinnedAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' }),
      thread('ordinary-old', { updatedAt: '2026-09-02T00:00:00.000Z' }),
    ])
    expect(threads.map((entry) => entry.id)).toEqual(['favorite-new', 'favorite-old', 'ordinary-new', 'ordinary-old'])
    expect(previewProjectFolderThreads(threads, 1).threads.map((entry) => entry.id)).toEqual(['favorite-new', 'favorite-old', 'ordinary-new'])
  })

  it('renders only the open shelf thread while collapsed', () => {
    const entries = [{ thread: thread('one'), projectName: 'First' }, { thread: thread('two'), projectName: 'Second' }]
    expect(resolveShelfThreads(entries, false, 5, 'two')).toEqual([entries[1]])
    expect(resolveShelfThreads(entries, false, 5, null)).toEqual([])
  })
})
