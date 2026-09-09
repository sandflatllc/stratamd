import { describe, expect, it } from 'vitest'
import { historyScanSchema, isPrivateHistoryPath, recentHistoryGroups } from '../../src/shared/history-import'

const candidate = (path: string, lastActiveAt = '2026-09-03T12:00:00Z') => ({ path, title: path, sources: ['codex'] as const, threadCount: 2, lastActiveAt, alreadyImported: false })
describe('native history discovery', () => {
  it('groups clones by repository and bounds the most recent projects', () => {
    const candidates = historyScanSchema.parse({ scannedAt: '2026-09-03T12:00:00Z', candidates: [candidate('/old', '2025-01-01T00:00:00Z'), { ...candidate('/work/a'), git: { remoteKey: 'github:owner/repo', repository: 'owner/repo' } }, { ...candidate('/work/b'), git: { remoteKey: 'github:owner/repo', repository: 'owner/repo' } }] }).candidates
    expect(recentHistoryGroups(candidates, 2)).toMatchObject([{ title: 'owner/repo', candidates: [{ path: '/work/a' }, { path: '/work/b' }] }])
  })
  it('excludes private assistant paths lexically without reading them', () => {
    for (const path of ['/home/dillonc/.openclaw', '/home/dillonc/.openclaw/workspace', '/srv/openclaw/private', '/srv/openclaw/private/transcripts', '/volumes/openclaw_private_state', '/containers/openclaw-private', '/srv/openclaw/other/../private']) expect(isPrivateHistoryPath(path)).toBe(true)
    expect(isPrivateHistoryPath('/home/dillonc/Projects/openclaw-private-setup')).toBe(false)
    const candidates = historyScanSchema.parse({ scannedAt: '2026-09-03T12:00:00Z', candidates: [candidate('/srv/openclaw/private'), candidate('/work/safe')] }).candidates
    expect(recentHistoryGroups(candidates).map(group => group.key)).toEqual(['/work/safe'])
  })
})

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { T3EngineClient } from '../../src/main/engine/client'
import { fakeEngineServer } from './support/fake-engine-socket'
it('uses native RPC counts for unchanged retries and refuses changed or private roots before import', async () => {
  const at = '2026-09-03T12:00:00Z'
  let calls = 0
  const server = fakeEngineServer(tag => {
    if (tag.startsWith('orchestration.subscribe')) return [{ kind: 'synchronized' }]
    if (tag === 'agentSessions.scan') return { scannedAt: at, candidates: [candidate('/work/safe'), candidate('/srv/openclaw/private')] }
    if (tag === 'agentSessions.import') return ++calls === 1 ? { importedCount: 2, skippedCount: 0 } : { importedCount: 0, skippedCount: 2 }
    return null
  })
  const client = new T3EngineClient({ dataDirectory: await mkdtemp(join(tmpdir(), 'strata-history-')), webSocket: server.WebSocket, fetch: async input => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'test', expiresAt: at })
    return Response.json({ snapshotSequence: 1, projects: [{ id: 'safe', title: 'Safe', workspaceRoot: '/work/safe', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }, { id: 'private', title: 'Private', workspaceRoot: '/srv/openclaw/private', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }], threads: [], updatedAt: at })
  } })
  try {
    await client.pair('http://engine.test', 'code')
    expect((await client.scanHistory()).candidates.map(candidate => candidate.path)).toEqual(['/work/safe'])
    await expect(client.importHistory({ projectId: 'safe', expectedWorkspaceRoot: '/work/changed' })).rejects.toThrow('folder changed')
    await expect(client.importHistory({ projectId: 'private', expectedWorkspaceRoot: '/srv/openclaw/private' })).rejects.toThrow('Private assistant')
    expect(calls).toBe(0)
    const input = { projectId: 'safe', expectedWorkspaceRoot: '/work/safe' }
    expect(await client.importHistory(input)).toEqual({ importedCount: 2, skippedCount: 0 })
    expect(await client.importHistory(input)).toEqual({ importedCount: 0, skippedCount: 2 })
    expect(server.requests.filter(request => request.tag === 'agentSessions.import').map(request => request.payload)).toEqual([input, input])
    expect(server.requests.some(request => request.tag === 'orchestration.dispatchCommand')).toBe(false)
  } finally { await client.shutdown() }
})
