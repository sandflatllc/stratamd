import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { fakeEngineServer } from './support/fake-engine-socket'
const at = '2026-09-03T12:00:00.000Z'
it('requires opt-in for running maintenance, preserves held work and reuses the explicit continuation identity after an uncertain receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-continuation-'))
  let enabled = false, status = 'running', activeTurnId: string | null = 'old-turn', reject = true
  const commands: Array<Record<string, any>> = []
  const messages: Array<Record<string, unknown>> = [{ id: 'm1', role: 'assistant', text: 'Keep this prior answer.', attachments: [], turnId: 'old-turn', streaming: false, createdAt: at, updatedAt: at }]
  const thread = () => ({ id: 't1', projectId: 'p1', title: 'Interrupted work', modelSelection: { instanceId: 'fixture', model: 'fixture', options: [] }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null, latestTurn: null, createdAt: at, updatedAt: at, session: { threadId: 't1', status, activeTurnId, providerName: 'fixture', providerInstanceId: 'fixture', runtimeMode: 'full-access', lastError: status === 'error' ? 'Provider session did not survive a server restart.' : null, updatedAt: at }, latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: true, hasActionableProposedPlan: false })
  const activity = { id: 'native-question', tone: 'info', kind: 'user-input.requested', summary: 'Question', payload: { requestId: 'request-stable', questions: [{ id: 'choice', question: 'Which choice?' }] }, turnId: 'old-turn', createdAt: at }
  const server = fakeEngineServer(tag => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : tag === 'server.getSettings' ? { continueThreadsAfterServerUpdate: enabled, providerInstances: {} } : null)
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'fixture', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'fixture', expiresAt: at })
    if (url.endsWith('/api/orchestration/shell')) return Response.json({ snapshotSequence: 10, projects: [{ id: 'p1', title: 'Fixture', workspaceRoot: root, defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }], threads: [thread()], updatedAt: at })
    if (url.endsWith('/api/orchestration/threads/t1')) return Response.json({ snapshotSequence: 10, thread: { ...thread(), deletedAt: null, messages, activities: [activity], checkpoints: [] } })
    if (url.endsWith('/api/orchestration/dispatch')) {
      const command = JSON.parse(String(init?.body)); commands.push(command)
      if (reject) { reject = false; throw new Error('Receipt connection lost') }
      messages.push({ id: command.message.messageId, ...command.message, turnId: 'new-turn', streaming: false, createdAt: at, updatedAt: at })
      return Response.json({ sequence: 11 })
    }
    return new Response('{}', { status: 404 })
  }
  const client = new T3EngineClient({ dataDirectory: root, fetch, webSocket: server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0, reconnectDelaysMs: [10000] })
  const current = () => client.view().projects[0]!.threads[0]!
  try {
    await client.pair('http://fixture.test', 'fixture'); await client.openThread('t1')
    await client.holdMessageComment('t1', { messageId: 'm1', from: 0, to: 4, kind: 'comment', text: 'Keep this held.' })
    const held = structuredClone(current().comments)
    await expect(client.prepareLocalSetup(true)).rejects.toThrow('enable continuation')
    enabled = true
    await client.prepareLocalSetup(true)
    expect(commands).toHaveLength(0)
    status = 'error'; activeTurnId = null
    server.dropAll(); await vi.waitFor(() => expect(client.view().state).toBe('disconnected'))
    await client.reconnect()
    expect(current().recovery?.state).toBe('failed')
    await expect(client.continueInterruptedThread('t1')).rejects.toThrow('Receipt connection lost')
    await client.continueInterruptedThread('t1')
    expect(commands).toHaveLength(2)
    expect(commands[1]).toEqual(commands[0])
    expect(commands[0]!.message).toMatchObject({ text: 'Continue where you left off.', attachments: [] })
    expect(current().recovery).toMatchObject({ state: 'continued', source: 'message' })
    await client.continueInterruptedThread('t1')
    expect(commands).toHaveLength(2)
    expect(current().comments).toEqual(held)
    expect(current().activities).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'native-question', payload: activity.payload })]))
  } finally { await client.shutdown(); await rm(root, { recursive: true, force: true }) }
})
