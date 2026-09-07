import { describe, expect, it } from 'vitest'
import { agentModelLabel, agentRunElapsedMs, clusterAgentRuns, deriveAgentRuns, deriveBackgroundTasks, formatTokenCount, orderAgentRuns, summarizeAgentRuns } from '../../src/core/agent-activity'
import type { EngineActivityView } from '../../src/shared/contracts'

let tick = 0
function activity(kind: string, payload: Record<string, unknown>, tone: EngineActivityView['tone'] = 'info'): EngineActivityView {
  tick += 1
  return { id: `a${tick}`, kind, payload, tone, turnId: 'turn-1', createdAt: new Date(Date.UTC(2026, 8, 6, 12, 0, tick)).toISOString(), summary: kind }
}

/** The shapes T3 0.0.38 recorded for a Claude run with two agents and a background command. */
function claudeFeed(): EngineActivityView[] {
  return [
    activity('tool.started', { itemType: 'collab_agent_tool_call', toolCallId: 'toolu_audit', status: 'inProgress' }, 'tool'),
    activity('task.started', { taskId: 'a60f', taskType: 'local_agent', agentKind: 'agent', title: 'Audit e2e spec value', role: 'general-purpose', model: 'claude-opus-5', effort: 'high', toolUseId: 'toolu_audit' }),
    activity('tool.started', { itemType: 'collab_agent_tool_call', toolCallId: 'toolu_flake', status: 'inProgress' }, 'tool'),
    activity('task.started', { taskId: 'aed1', taskType: 'local_agent', agentKind: 'agent', title: 'Analyze e2e harness flakiness', role: 'general-purpose', model: 'claude-fable-5-1', effort: 'high', toolUseId: 'toolu_flake' }),
    activity('task.started', { taskId: 'b2tj', taskType: 'local_bash', agentKind: 'background', title: 'Run experiment at six workers', model: 'claude-fable-5-1', effort: 'high', toolUseId: 'toolu_bash' }),
    activity('task.progress', { taskId: 'aed1', title: 'Analyze e2e harness flakiness', detail: 'Running Check reduced-motion coverage', lastToolName: 'Bash', usage: { total_tokens: 181_901, tool_uses: 52, duration_ms: 454_792 }, agentKind: 'agent', taskType: 'local_agent', role: 'general-purpose', model: 'claude-fable-5-1', effort: 'high', toolUseId: 'toolu_flake' }),
    activity('task.progress', { taskId: 'aed1', title: 'Analyze e2e harness flakiness', agentKind: 'agent', taskType: 'local_agent', usageSnapshot: true, typedUsage: { totalTokens: 190_000, toolUses: 55, durationMs: 470_000 } }),
    activity('task.completed', { taskId: 'a60f', status: 'completed', title: 'Audit e2e spec value', summary: 'All 76 spec files read.', usage: { total_tokens: 290_705, tool_uses: 40, duration_ms: 818_714 }, agentKind: 'agent', taskType: 'local_agent', role: 'general-purpose', model: 'claude-opus-5', effort: 'high', toolUseId: 'toolu_audit' }),
    activity('task.updated', { taskId: 'a60f', endedAt: '2026-09-07T04:36:13.710Z', agentKind: 'agent', taskType: 'local_agent', title: 'Audit e2e spec value', role: 'general-purpose', model: 'claude-opus-5', effort: 'high', toolUseId: 'toolu_audit', status: 'completed' }),
    activity('task.completed', { taskId: 'b2tj', status: 'completed', title: 'Run experiment at six workers', summary: 'Background command completed (exit code 0)', agentKind: 'background', taskType: 'local_bash', toolUseId: 'toolu_bash' }),
  ]
}

describe('agent activity', () => {
  it('derives one run per task from the recorded Claude feed, with state, usage, and the running line', () => {
    const runs = deriveAgentRuns(claudeFeed())
    expect(runs.map((run) => run.id)).toEqual(['a60f', 'aed1'])
    expect(runs[0]).toMatchObject({ title: 'Audit e2e spec value', role: 'general-purpose', modelLabel: 'Opus 5', effort: 'high', state: 'done', tokens: 290_705, toolUses: 40, durationMs: 818_714, summary: 'All 76 spec files read.', endedAt: '2026-09-07T04:36:13.710Z', depth: 1, depthKnown: true, toolUseId: 'toolu_audit' })
    expect(runs[1]).toMatchObject({ title: 'Analyze e2e harness flakiness', modelLabel: 'Fable 5.1', state: 'working', detail: 'Check reduced-motion coverage', lastToolName: 'Bash', tokens: 190_000, toolUses: 55, durationMs: 470_000, depth: 1 })
    expect(runs[1]!.activityIds).toHaveLength(3)
  })

  it('lists background commands separately and never as runs', () => {
    const tasks = deriveBackgroundTasks(claudeFeed())
    expect(tasks).toEqual([expect.objectContaining({ id: 'b2tj', title: 'Run experiment at six workers', state: 'done' })])
    expect(deriveAgentRuns(claudeFeed()).some((run) => run.id === 'b2tj')).toBe(false)
  })

  it('reads a failed completion as failed with its error text', () => {
    const runs = deriveAgentRuns([
      activity('task.started', { taskId: 'x', taskType: 'local_agent', agentKind: 'agent', title: 'Skyrim frameworks', role: 'general-purpose', model: '<synthetic>', effort: 'high', toolUseId: 't1' }),
      activity('task.completed', { taskId: 'x', status: 'failed', title: 'Skyrim frameworks', summary: 'Agent terminated early due to an API error: session limit', agentKind: 'agent', taskType: 'local_agent' }, 'error'),
    ])
    expect(runs[0]).toMatchObject({ state: 'failed', error: 'Agent terminated early due to an API error: session limit', modelLabel: null })
  })

  it('takes depth from a Codex agent path and places the run under its parent', () => {
    const runs = deriveAgentRuns([
      activity('task.started', { taskId: 'root-1', agentKind: 'agent', title: 'plan', role: 'plan', model: 'gpt-6-astra', effort: 'medium', agentPath: '/root/plan', timelineBypass: true }),
      activity('task.started', { taskId: 'leaf-1', agentKind: 'agent', title: 'diagnose_image_rendering', role: 'diagnose_image_rendering', model: 'gpt-6-astra', effort: 'medium', agentPath: '/root/plan/diagnose_image_rendering', timelineBypass: true }),
      activity('task.updated', { taskId: 'leaf-1', agentKind: 'agent', title: 'diagnose_image_rendering', agentPath: '/root/plan/diagnose_image_rendering', status: 'idle' }),
    ])
    // Codex reports `idle` for an agent that finished its turn; it is done, not a question for the owner, and its end is the row's time.
    expect(runs.map((run) => [run.id, run.depth, run.parentId, run.depthKnown, run.state])).toEqual([['root-1', 1, null, true, 'working'], ['leaf-1', 2, 'root-1', true, 'done']])
    expect(runs[1]!.endedAt).toBe(runs[1]!.activityIds.length === 2 ? new Date(Date.UTC(2026, 8, 6, 12, 0, tick)).toISOString() : null)
    expect(runs[0]!.modelLabel).toBe('Astra')
  })

  it('settles an interrupted Codex agent as done', () => {
    const runs = deriveAgentRuns([
      activity('task.started', { taskId: 'root-2', agentKind: 'agent', title: 'plan', agentPath: '/root/plan' }),
      activity('task.updated', { taskId: 'root-2', agentKind: 'agent', title: 'plan', agentPath: '/root/plan', status: 'interrupted' }),
    ])
    expect(runs.map((run) => [run.state, run.endedAt !== null])).toEqual([['done', true]])
  })

  it('places a workflow child under the parent T3 names', () => {
    const runs = deriveAgentRuns([
      activity('task.started', { taskId: 'wf', taskType: 'local_workflow', agentKind: 'agent', title: 'Review workflow', toolUseId: 'toolu_wf' }),
      activity('task.progress', { taskId: 'wf:wf:1', agentKind: 'agent', title: 'Angle A', parentAgentId: 'wf', status: 'running', phaseTitle: 'Review' }),
      activity('task.progress', { taskId: 'wf:wf:1', agentKind: 'agent', title: 'Angle A', parentAgentId: 'wf', status: 'completed', phaseTitle: 'Review' }),
    ])
    expect(runs.map((run) => [run.id, run.depth, run.parentId, run.depthKnown, run.state])).toEqual([['wf', 1, null, false, 'working'], ['wf:wf:1', 2, 'wf', true, 'done']])
  })

  it('infers nothing in a turn where T3 reported no Agent call rows', () => {
    const runs = deriveAgentRuns([
      activity('tool.started', { itemType: 'tool_call', toolCallId: 'skill-call', status: 'inProgress' }, 'tool'),
      activity('task.started', { taskId: 'first', taskType: 'local_agent', agentKind: 'agent', title: 'Angle A', toolUseId: 'toolu_1' }),
      activity('task.started', { taskId: 'second', taskType: 'local_agent', agentKind: 'agent', title: 'Angle B', toolUseId: 'toolu_2' }),
      activity('task.started', { taskId: 'third', taskType: 'local_agent', agentKind: 'agent', title: 'Angle C', toolUseId: 'toolu_3' }),
    ])
    expect(runs.map((run) => [run.id, run.depth, run.parentId, run.depthKnown])).toEqual([['first', 1, null, false], ['second', 1, null, false], ['third', 1, null, false]])
  })

  it('infers Claude children from spawns whose calls are not the main thread\'s while a run is working', () => {
    const runs = deriveAgentRuns([
      activity('tool.started', { itemType: 'collab_agent_tool_call', toolCallId: 'main-call', status: 'inProgress' }, 'tool'),
      activity('task.started', { taskId: 'parent', taskType: 'local_agent', agentKind: 'agent', title: 'Parent', toolUseId: 'main-call' }),
      activity('task.started', { taskId: 'child', taskType: 'local_agent', agentKind: 'agent', title: 'Child', toolUseId: 'inner-call' }),
      activity('task.started', { taskId: 'grandchild', taskType: 'local_agent', agentKind: 'agent', title: 'Grandchild', toolUseId: 'inner-call-2' }),
      activity('task.completed', { taskId: 'child', status: 'completed', taskType: 'local_agent', agentKind: 'agent', title: 'Child' }),
      activity('task.started', { taskId: 'sibling', taskType: 'local_agent', agentKind: 'agent', title: 'Sibling', toolUseId: 'inner-call-3' }),
    ])
    // Fan-out is the common shape, so later spawns hang under the shallowest working run rather than chaining deeper.
    expect(runs.map((run) => [run.id, run.depth, run.parentId])).toEqual([['parent', 1, null], ['child', 2, 'parent'], ['grandchild', 2, 'parent'], ['sibling', 2, 'parent']])
    expect(runs.every((run) => run.id === 'parent' ? run.depthKnown : !run.depthKnown)).toBe(true)
  })

  it('orders families together and cuts clusters at six', () => {
    const runs = deriveAgentRuns([
      activity('tool.started', { toolCallId: 'c1' }, 'tool'), activity('tool.started', { toolCallId: 'c2' }, 'tool'),
      activity('task.started', { taskId: 'one', taskType: 'local_agent', agentKind: 'agent', title: 'One', toolUseId: 'c1' }),
      activity('task.started', { taskId: 'two', taskType: 'local_agent', agentKind: 'agent', title: 'Two', toolUseId: 'c2' }),
      activity('task.started', { taskId: 'one-a', taskType: 'local_agent', agentKind: 'agent', title: 'One a', toolUseId: 'x1' }),
      ...Array.from({ length: 5 }, (_, index) => activity('task.started', { taskId: `more-${index}`, taskType: 'local_agent', agentKind: 'agent', title: `More ${index}`, toolUseId: `c-more-${index}` })),
    ])
    // Without the main-thread call ids, the later spawns hang under the newest working run; the order still keeps each family contiguous.
    const ordered = orderAgentRuns(runs).map((run) => run.id)
    expect(ordered.indexOf('one-a')).toBeGreaterThan(ordered.indexOf('one'))
    const clusters = clusterAgentRuns(runs)
    expect(clusters.map((cluster) => cluster.length)).toEqual([6, 2])
    expect(clusters.flat().map((run) => run.id)).toEqual(ordered)
  })

  it('summarizes counts, tokens, and depth', () => {
    const runs = deriveAgentRuns(claudeFeed())
    expect(summarizeAgentRuns(runs)).toEqual({ total: 2, working: 1, done: 1, failed: 0, waiting: 0, tokens: 480_705, depth: 1 })
    expect(formatTokenCount(480_705)).toBe('481k')
    expect(formatTokenCount(2_400_000)).toBe('2.4M')
    expect(formatTokenCount(950)).toBe('950')
  })

  it('reads model slugs the way the composer does', () => {
    expect(agentModelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(agentModelLabel('claude-opus-5')).toBe('Opus 5')
    expect(agentModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(agentModelLabel('gpt-6-astra')).toBe('Astra')
    expect(agentModelLabel('gpt-5.6')).toBe('5.6')
    expect(agentModelLabel(null)).toBeNull()
  })

  it('measures elapsed time from the report, the span, or the clock', () => {
    const now = Date.parse('2026-09-06T12:10:00.000Z')
    // A live run keeps counting from the clock even after T3 reported a duration snapshot on a progress row.
    expect(agentRunElapsedMs({ durationMs: 5_000, startedAt: '2026-09-06T12:00:00.000Z', endedAt: null, state: 'working' }, now)).toBe(600_000)
    expect(agentRunElapsedMs({ durationMs: 5_000, startedAt: '2026-09-06T12:00:00.000Z', endedAt: '2026-09-06T12:01:30.000Z', state: 'done' }, now)).toBe(5_000)
    expect(agentRunElapsedMs({ durationMs: null, startedAt: '2026-09-06T12:00:00.000Z', endedAt: '2026-09-06T12:01:30.000Z', state: 'done' }, now)).toBe(90_000)
    expect(agentRunElapsedMs({ durationMs: null, startedAt: '2026-09-06T12:00:00.000Z', endedAt: null, state: 'working' }, now)).toBe(600_000)
    expect(agentRunElapsedMs({ durationMs: null, startedAt: '2026-09-06T12:00:00.000Z', endedAt: null, state: 'done' }, now)).toBeNull()
  })
})
