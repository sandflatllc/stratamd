import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'

const at = '2026-09-03T12:00:00.000Z'

function shell(text = 'First thread', status: 'idle' | 'running' = 'idle') {
  return {
    snapshotSequence: 4,
    projects: [{ id: 'p1', title: 'StrataMD', workspaceRoot: '/work/strata', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }],
    threads: [{
      id: 't1', projectId: 'p1', title: text,
      modelSelection: { instanceId: 'codex-main', model: 'gpt-5.6', options: { effort: 'medium' } },
      runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null,
      latestTurn: null, createdAt: at, updatedAt: at,
      session: { threadId: 't1', status, providerName: 'codex', providerInstanceId: 'codex-main', runtimeMode: 'full-access', activeTurnId: status === 'running' ? 'turn-1' : null, lastError: null, updatedAt: at },
      latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
    }],
    updatedAt: at,
  }
}

function detail(message = 'Engine transcript') {
  return {
    snapshotSequence: 5,
    thread: {
      ...shell().threads[0], deletedAt: null,
      messages: [{ id: 'm1', role: 'assistant', text: message, attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }],
      activities: [], checkpoints: [],
    },
    page: { beforeCursor: null, hasMore: false, snapshotSequence: 5, threadSequence: 5 },
  }
}

describe('T3 engine read client', () => {
  it('pairs, keeps the credential private, projects the shell, and persists visits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-'))
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, ...(init ? { init } : {}) })
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'session-secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell(), { headers: { 'x-t3-version': '0.0.33' } })
      if (url.endsWith('/api/orchestration/threads/t1')) return Response.json(detail())
      return new Response('', { status: 404 })
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, now: () => Date.parse(at), pollMs: 60_000 })
    await client.initialize()
    expect(client.view().state).toBe('unpaired')

    await client.pair('http://engine.test:3774/path-is-ignored', 'one-time-code')
    expect(client.view()).toMatchObject({ state: 'connected', server: 'http://engine.test:3774', serverVersion: '0.0.33' })
    expect(client.view().projects[0]?.threads[0]).toMatchObject({ id: 't1', title: 'First thread', model: 'gpt-5.6', effort: 'medium', access: 'full-access' })
    expect(requests[0]?.init?.body?.toString()).toContain('subject_token=one-time-code')
    expect(requests[1]?.init?.headers).toEqual({ authorization: 'Bearer session-secret' })
    expect((await stat(join(directory, 'engine-credential.json'))).mode & 0o777).toBe(0o600)

    await client.openThread('t1')
    expect(client.view().activeThreadId).toBe('t1')
    expect(client.view().projects[0]?.threads[0]?.messages[0]?.text).toBe('Engine transcript')
    expect(client.view().projects[0]?.threads[0]?.unread).toBe(false)
    expect(JSON.parse(await readFile(join(directory, 'engine-reading.json'), 'utf8'))).toMatchObject({ activeThreadId: 't1' })
    await client.shutdown()
  })

  it('publishes one disconnected state and recovers the same active conversation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-engine-reconnect-'))
    let online = true
    let transcript = 'Before restart'
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
      if (!online) throw new TypeError('fetch failed')
      if (url.endsWith('/api/orchestration/shell')) return Response.json(shell(), { headers: { 'x-t3-version': '0.0.33' } })
      return Response.json(detail(transcript))
    }) as typeof globalThis.fetch
    const client = new T3EngineClient({ dataDirectory: directory, fetch, pollMs: 60_000 })
    await client.initialize()
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    online = false
    await client.reconnect()
    expect(client.view()).toMatchObject({ state: 'disconnected', server: 'http://engine.test', activeThreadId: 't1' })
    transcript = 'After restart'
    online = true
    await client.reconnect()
    expect(client.view().projects[0]?.threads[0]?.messages[0]?.text).toBe('After restart')
    expect(client.view().activeThreadId).toBe('t1')
    await client.shutdown()
  })
})
