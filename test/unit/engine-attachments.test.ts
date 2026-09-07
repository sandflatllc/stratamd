import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { normalizeConversationsStore } from '../../src/main/engine/conversation-state'
import { StagedAttachmentStore } from '../../src/main/engine/staged-attachments'
import { attachmentLimitMessage } from '../../src/core/composer-attachments'
import { fakeEngineServer } from './support/fake-engine-socket'

const at = '2026-09-05T12:00:00.000Z'
const questions = '1. Which audience should lead?\n2. Should launch be public?\n3. What is the budget?'
const thread = {
  id: 't1', projectId: 'p1', title: 'Screens', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: {} }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
  latestTurn: null, createdAt: at, updatedAt: at,
  session: { threadId: 't1', status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: null, lastError: null, updatedAt: at },
  latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
}
const shell = { snapshotSequence: 10, projects: [{ id: 'p1', title: 'Project', workspaceRoot: '/work', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }], threads: [thread], updatedAt: at }
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

/** A T3 that records every upload's content type and bytes, and can lose a dispatch response. */
function engine() {
  let failDispatch = false
  const commands: Array<Record<string, unknown>> = []
  const uploads: Array<{ contentType: string; bytes: Uint8Array }> = []
  const messages: unknown[] = [{ id: 'm1', role: 'assistant', text: questions, attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }]
  const server = fakeEngineServer((tag) => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : tag === 'attachments.createUploadUrl' ? { attachmentId: `upload-${uploads.length + 1}`, relativeUrl: '/upload/next', expiresAt: 1 } : null)
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
    if (url.endsWith('/upload/next') && init?.method === 'POST') { uploads.push({ contentType: String((init?.headers as Record<string, string>)['content-type']), bytes: new Uint8Array(init?.body as Uint8Array) }); return new Response(null, { status: 204 }) }
    if (url.endsWith('/api/orchestration/dispatch')) { commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>); if (failDispatch) throw new Error('Lost dispatch response'); return Response.json({ sequence: 10 + commands.length }) }
    if (url.endsWith('/api/orchestration/shell')) return Response.json(shell)
    if (url.endsWith('/api/orchestration/threads/t1')) return Response.json({ snapshotSequence: 10, thread: { ...thread, deletedAt: null, messages, activities: [], checkpoints: [] }, page: { beforeCursor: null, hasMore: false, snapshotSequence: 10, threadSequence: 10 } })
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
  return { server, fetch, commands, uploads, failDispatch: (value: boolean) => { failDispatch = value } }
}

const uploadPayloads = (server: ReturnType<typeof fakeEngineServer>) => server.requests.filter((request) => request.tag === 'attachments.createUploadUrl').map((request) => request.payload as Record<string, unknown>)
const stagedFiles = (directory: string) => readdir(join(directory, 'composer-attachments')).catch(() => [] as string[])
const turn = { model: 'gpt-5.6', effort: null, access: 'full-access' as const }

async function client(fake: ReturnType<typeof engine>, directory: string) {
  const instance = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
  await instance.pair('http://engine.test', 'code'); await instance.openThread('t1')
  await new Promise<void>((resolve) => setImmediate(resolve))
  return instance
}

describe('composer image attachments (§6.0)', () => {
  it('uploads a pasted image with its real type before dispatching, then drops the staged bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-image-upload-'))
    const fake = engine()
    const instance = await client(fake, directory)
    const staged = await instance.stageAttachment({ name: 'pasted-image-2026-09-05-12-00-00.png', mimeType: 'image/png', bytes: png })
    expect(await stagedFiles(directory)).toHaveLength(2)
    await instance.startTurn('t1', { ...turn, text: '', attachments: [{ kind: 'image', id: staged.id, name: 'pasted-image-2026-09-05-12-00-00.png', mimeType: 'image/png', sizeBytes: staged.sizeBytes }] })
    expect(uploadPayloads(fake.server)).toEqual([{ type: 'image', name: 'pasted-image-2026-09-05-12-00-00.png', mimeType: 'image/png', sizeBytes: png.byteLength }])
    expect(fake.uploads).toHaveLength(1)
    expect(fake.uploads[0]!.contentType).toBe('image/png')
    expect([...fake.uploads[0]!.bytes]).toEqual([...png])
    expect(fake.commands[0]).toMatchObject({ message: { text: 'Attached pasted-image-2026-09-05-12-00-00.png.', attachments: [{ type: 'image', id: 'upload-1', name: 'pasted-image-2026-09-05-12-00-00.png', mimeType: 'image/png', sizeBytes: png.byteLength }] } })
    expect(await stagedFiles(directory)).toEqual([])
    await instance.shutdown()
  })

  it('sends a text file and an image in the order the owner attached them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-mixed-upload-'))
    const fake = engine()
    const instance = await client(fake, directory)
    const staged = await instance.stageAttachment({ name: 'shot.png', mimeType: 'image/png', bytes: png })
    await instance.startTurn('t1', { ...turn, text: 'Compare these.', attachments: [{ kind: 'text', name: 'notes.md', text: '# Notes' }, { kind: 'image', id: staged.id, name: 'shot.png', mimeType: 'image/png', sizeBytes: staged.sizeBytes }] })
    expect(uploadPayloads(fake.server).map((payload) => [payload.type, payload.mimeType])).toEqual([['file', 'text/markdown'], ['image', 'image/png']])
    expect(fake.uploads.map((upload) => upload.contentType)).toEqual(['text/markdown', 'image/png'])
    expect(fake.commands[0]).toMatchObject({ message: { text: 'Compare these.', attachments: [{ type: 'file', name: 'notes.md' }, { type: 'image', name: 'shot.png' }] } })
    await instance.shutdown()
  })

  it('keeps the generated context file inside the eight-attachment limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-attachment-limit-'))
    const fake = engine()
    const instance = await client(fake, directory)
    const items = () => instance.view().projects[0]!.threads[0]!.items!
    await instance.queueItemReply('t1', items()[0]!.id, 'Audience')
    const images = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const staged = await instance.stageAttachment({ name: `shot-${index}.png`, mimeType: 'image/png', bytes: png })
      return { kind: 'image' as const, id: staged.id, name: `shot-${index}.png`, mimeType: 'image/png', sizeBytes: staged.sizeBytes }
    }))
    // Eight owner files plus the replies file would be nine: refused before anything is written, the reply still queued.
    await expect(instance.startTurn('t1', { ...turn, text: 'Too many', attachments: images, replies: { [items()[0]!.id]: 'Audience' } })).rejects.toThrow(attachmentLimitMessage(1))
    expect(fake.uploads).toHaveLength(0)
    expect(fake.commands).toHaveLength(0)
    expect(instance.view().projects[0]!.threads[0]!.deliveries ?? []).toHaveLength(0)
    expect(items()[0]!.status).toBe('drafted')
    expect(await stagedFiles(directory)).toHaveLength(16)
    // Seven fit: eight uploads, the context file last.
    await instance.startTurn('t1', { ...turn, text: 'Seven fit', attachments: images.slice(0, 7), replies: { [items()[0]!.id]: 'Audience' } })
    expect(fake.uploads).toHaveLength(8)
    expect(uploadPayloads(fake.server).map((payload) => payload.type)).toEqual([...Array.from({ length: 7 }, () => 'image'), 'file'])
    const attachments = (fake.commands[0]!.message as { attachments: Array<{ name: string }> }).attachments
    expect(attachments).toHaveLength(8)
    expect(attachments[7]!.name).toMatch(/^conversation-.*\.md$/)
    await instance.shutdown()
  })

  it('refuses a send whose image was removed, and abandons a saved preparation whose bytes are gone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-missing-staged-'))
    const fake = engine()
    const first = await client(fake, directory)
    const removed = await first.stageAttachment({ name: 'removed.png', mimeType: 'image/png', bytes: png })
    await first.discardAttachment(removed.id)
    await expect(first.startTurn('t1', { ...turn, text: 'Gone', attachments: [{ kind: 'image', id: removed.id, name: 'removed.png', mimeType: 'image/png', sizeBytes: png.byteLength }] })).rejects.toThrow('Attachment removed.png is no longer staged')
    expect(fake.uploads).toHaveLength(0)

    // A dispatch that loses its response leaves the preparation saved with its upload done; a second image still waits.
    const items = () => first.view().projects[0]!.threads[0]!.items!
    await first.queueItemReply('t1', items()[0]!.id, 'Audience')
    const kept = await first.stageAttachment({ name: 'kept.png', mimeType: 'image/png', bytes: png })
    fake.failDispatch(true)
    await expect(first.startTurn('t1', { ...turn, messageId: 'lost', text: 'Saved', attachments: [{ kind: 'image', id: kept.id, name: 'kept.png', mimeType: 'image/png', sizeBytes: png.byteLength }], replies: { [items()[0]!.id]: 'Audience' } })).rejects.toThrow()
    await first.shutdown()
    fake.failDispatch(false)
    // The image uploaded before the dispatch, so its staged bytes are already gone; the preparation keeps the uploaded reference and resumes without a second upload.
    expect(fake.uploads).toHaveLength(2)
    const second = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await second.initialize()
    expect(fake.uploads).toHaveLength(2)
    expect(fake.commands).toHaveLength(2)
    expect(fake.commands[1]).toEqual(fake.commands[0])
    await second.shutdown()
  })

  it('drops a preparation whose image was swept before upload and returns its reply to the queue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-swept-staged-'))
    const fake = engine()
    const first = await client(fake, directory)
    const items = () => first.view().projects[0]!.threads[0]!.items!
    await first.queueItemReply('t1', items()[0]!.id, 'Audience')
    const staged = await first.stageAttachment({ name: 'later.png', mimeType: 'image/png', bytes: png })
    // The signed URL request fails, so the preparation is saved with nothing uploaded.
    const failing = fakeEngineServer((tag) => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
    const failingClient = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: failing.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await first.shutdown()
    await failingClient.initialize()
    await expect(failingClient.startTurn('t1', { ...turn, messageId: 'swept', text: 'Saved', attachments: [{ kind: 'image', id: staged.id, name: 'later.png', mimeType: 'image/png', sizeBytes: png.byteLength }], replies: { [items()[0]!.id]: 'Audience' } })).rejects.toThrow()
    await failingClient.shutdown()
    expect(fake.uploads).toHaveLength(0)
    await new StagedAttachmentStore(join(directory, 'composer-attachments')).discard(staged.id)
    const second = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await second.initialize(); await second.openThread('t1')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(fake.commands).toHaveLength(0)
    const view = second.view().projects[0]!.threads[0]!
    expect(view.deliveries ?? []).toHaveLength(0)
    expect(view.items!.find((item) => item.draftReply === 'Audience')).toBeDefined()
    await second.shutdown()
  })

  it('keeps staged images a draft or a saved preparation names and sweeps the rest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-retain-'))
    const fake = engine()
    const instance = await client(fake, directory)
    const drafted = await instance.stageAttachment({ name: 'drafted.png', mimeType: 'image/png', bytes: png })
    const orphan = await instance.stageAttachment({ name: 'orphan.png', mimeType: 'image/png', bytes: png })
    const prepared = await instance.stageAttachment({ name: 'prepared.png', mimeType: 'image/png', bytes: png })
    const failing = fakeEngineServer((tag) => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : null)
    await instance.shutdown()
    const offline = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: failing.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await offline.initialize()
    await expect(offline.startTurn('t1', { ...turn, messageId: 'held', text: 'Later', attachments: [{ kind: 'image', id: prepared.id, name: 'prepared.png', mimeType: 'image/png', sizeBytes: png.byteLength }] })).rejects.toThrow()
    await offline.retainAttachments([drafted.id])
    expect((await stagedFiles(directory)).filter((name) => name.endsWith('.bin')).toSorted()).toEqual([`${drafted.id}.bin`, `${prepared.id}.bin`].toSorted())
    expect(await stagedFiles(directory)).not.toContain(`${orphan.id}.bin`)
    await offline.shutdown()
  })
})

describe('saved preparations from before images (§6.0)', () => {
  const command = (messageId: string) => ({ type: 'thread.turn.start', commandId: `strata-${messageId}`, threadId: 't1', createdAt: at, message: { messageId, role: 'user', text: 'Delivery', attachments: [] }, modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: {} }, runtimeMode: 'full-access', interactionMode: 'default' })

  it('normalizes entries without a kind to text and keeps uploaded references; unreadable entries drop the preparation', () => {
    const store = normalizeConversationsStore({ formatVersion: 1, threads: { t1: { replies: {}, pending: [], answered: [], dismissed: [], prepared: [
      { messageId: 'plain', command: command('plain'), attachments: [{ name: 'a.md', text: 'Bytes' }] },
      { messageId: 'done', command: command('done'), attachments: [{ name: 'b.md', text: 'Bytes', uploaded: { type: 'file', id: 'upload-9', name: 'b.md', mimeType: 'text/markdown', sizeBytes: 5 } }] },
      { messageId: 'image', command: command('image'), attachments: [{ kind: 'image', id: 'a_1', name: 'c.png', mimeType: 'image/png', sizeBytes: 3 }] },
      { messageId: 'broken', command: command('broken'), attachments: [{ name: 'd.md' }] },
    ] } } })
    expect(store.threads.t1!.prepared).toEqual([
      { messageId: 'plain', command: command('plain'), attachments: [{ kind: 'text', name: 'a.md', text: 'Bytes' }] },
      { messageId: 'done', command: command('done'), attachments: [{ kind: 'text', name: 'b.md', text: 'Bytes', uploaded: { type: 'file', id: 'upload-9', name: 'b.md', mimeType: 'text/markdown', sizeBytes: 5 } }] },
      { messageId: 'image', command: command('image'), attachments: [{ kind: 'image', id: 'a_1', name: 'c.png', mimeType: 'image/png', sizeBytes: 3 }] },
    ])
  })

  it('resumes a legacy entry by uploading its text, and one already uploaded by dispatching alone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-legacy-prepared-'))
    const fake = engine()
    await writeFile(join(directory, 'engine-credential.json'), JSON.stringify({ formatVersion: 1, server: 'http://engine.test', accessToken: 'secret', expiresAt: Date.parse(at) + 3_600_000, scopes: ['orchestration:read', 'orchestration:operate'] }), { mode: 0o600 })
    await writeFile(join(directory, 'engine-conversations.json'), JSON.stringify({ formatVersion: 1, threads: { t1: { replies: {}, pending: [{ deliveryId: 'pending-upload', itemIds: [], replies: {} }, { deliveryId: 'pending-dispatch', itemIds: [], replies: {} }], answered: [], dismissed: [], prepared: [
      { messageId: 'pending-upload', command: command('pending-upload'), attachments: [{ name: 'a.md', text: 'Legacy bytes' }] },
      { messageId: 'pending-dispatch', command: command('pending-dispatch'), attachments: [{ name: 'b.md', text: 'Already up', uploaded: { type: 'file', id: 'upload-9', name: 'b.md', mimeType: 'text/markdown', sizeBytes: 10 } }] },
    ] } } }), { mode: 0o600 })
    const instance = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await instance.initialize()
    expect(fake.uploads.map((upload) => [upload.contentType, new TextDecoder().decode(upload.bytes)])).toEqual([['text/markdown', 'Legacy bytes']])
    expect(fake.commands.map((entry) => (entry.message as { messageId: string }).messageId)).toEqual(['pending-upload', 'pending-dispatch'])
    expect(fake.commands[0]).toMatchObject({ message: { attachments: [{ type: 'file', id: 'upload-1', name: 'a.md', mimeType: 'text/markdown' }] } })
    expect(fake.commands[1]).toMatchObject({ message: { attachments: [{ type: 'file', id: 'upload-9', name: 'b.md', sizeBytes: 10 }] } })
    await instance.shutdown()
  })
})
