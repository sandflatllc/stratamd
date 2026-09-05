import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { fakeEngineServer } from './support/fake-engine-socket'

const at = '2026-09-03T12:00:00.000Z'
const questions = '1. Which audience should lead?\n2. Should launch be public?\n3. What is the budget?\n4. Which region goes first?\n5. Keep the old name?\n6. Require approval?\n7. When should work begin?'
const thread = {
  id: 't1', projectId: 'p1', title: 'Interview', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: {} }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
  latestTurn: null, createdAt: at, updatedAt: at,
  session: { threadId: 't1', status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: null, lastError: null, updatedAt: at },
  latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
}
const shell = { snapshotSequence: 10, projects: [{ id: 'p1', title: 'Project', workspaceRoot: '/work', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }], threads: [thread], updatedAt: at }
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function engine() {
  let failUploads = false
  let failDispatch = false
  const commands: Array<Record<string, unknown>> = []
  const uploads: string[] = []
  const messages: unknown[] = [{ id: 'm1', role: 'assistant', text: questions, attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }]
  const server = fakeEngineServer((tag) => tag.startsWith('orchestration.subscribe') ? [{ kind: 'synchronized' }] : tag === 'attachments.createUploadUrl' ? { attachmentId: `upload-${uploads.length + 1}`, relativeUrl: '/upload/next', expiresAt: 1 } : null)
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
    if (url.endsWith('/upload/next')) { if (failUploads) return new Response('', { status: 503 }); uploads.push(new TextDecoder().decode(init?.body as Uint8Array)); return new Response('', { status: 200 }) }
    if (url.endsWith('/api/orchestration/dispatch')) { commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>); if (failDispatch) throw new Error("Lost dispatch response"); return Response.json({ sequence: 10 + commands.length }) }
    if (url.endsWith('/api/orchestration/shell')) return Response.json(shell)
    if (url.endsWith('/api/orchestration/threads/t1')) return Response.json({ snapshotSequence: 10, thread: { ...thread, deletedAt: null, messages, activities: [], checkpoints: [] }, page: { beforeCursor: null, hasMore: false, snapshotSequence: 10, threadSequence: 10 } })
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
  /** The engine lists the delivered message, which is how a delivery is acknowledged. */
  const acknowledge = (messageId: string, text: string) => {
    messages.push({ id: messageId, role: 'user', text, attachments: [], turnId: 'turn-2', streaming: false, createdAt: at, updatedAt: at })
    server.push('orchestration.subscribeThread', [{ kind: 'event', event: { sequence: 11 + commands.length, eventId: `e${commands.length}`, aggregateKind: 'thread', aggregateId: 't1', occurredAt: at, commandId: null, causationEventId: null, correlationId: null, metadata: {}, type: 'thread.message-sent', payload: { threadId: 't1', messageId, role: 'user', text, turnId: 'turn-2', streaming: false, createdAt: at, updatedAt: at } } }])
  }
  return { server, fetch, commands, uploads, acknowledge, post: (id: string, text: string) => { messages.push({ id, role: "assistant", text, attachments: [], turnId: `turn-${id}`, streaming: false, createdAt: at, updatedAt: at }) }, failUploads: (value: boolean) => { failUploads = value }, failDispatch: (value: boolean) => { failDispatch = value } }
}

describe('conversation items remembered in the main process (§5.4, §5.12)', () => {
  it('four answers travel keyed by item id in one delivery, show Drafted until acknowledged, and survive a restart with a dismissal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-conversation-state-'))
    const fake = engine()
    const client = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await client.pair('http://engine.test', 'code')
    await client.openThread('t1')
    await settle()
    const items = () => client.view().projects[0]!.threads[0]!.items!
    expect(items()).toHaveLength(7)
    expect(items().every((item) => item.inferred && item.status === 'open')).toBe(true)

    const answers = ['Audience', 'Yes', '$10k', 'West']
    for (const [index, answer] of answers.entries()) await client.queueItemReply('t1', items()[index]!.id, answer)
    expect(items().filter((item) => item.status === 'drafted').map((item) => item.draftReply)).toEqual(answers)
    await client.discardItemReply('t1', items()[3]!.id)
    expect(items().filter((item) => item.status === 'drafted')).toHaveLength(3)
    await client.queueItemReply('t1', items()[3]!.id, 'West')

    await client.startTurn('t1', { replies: Object.fromEntries(items().filter(item => item.draftReply !== undefined).map(item => [item.id, item.draftReply!])), text: '', model: 'gpt-5.6', effort: null, access: 'full-access' })
    expect(fake.commands.filter((command) => command.type === 'thread.turn.start')).toHaveLength(1)
    const turn = fake.commands[0]!.message as { messageId: string; text: string; attachments: Array<{ name: string }> }
    expect(turn.text).toBe('Replies to 4 items.')
    expect(turn.attachments.map((attachment) => attachment.name)).toEqual([`conversation-${turn.messageId}.md`])
    expect(fake.commands[0]).toMatchObject({ commandId: `strata-${turn.messageId}` })
    expect(fake.uploads).toHaveLength(1)
    const rows = JSON.parse(fake.uploads[0]!.match(/```json\n([\s\S]*?)\n```/u)![1]!)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual({ itemId: items()[0]!.id, text: 'Audience' })
    // Drafted holds until the Send carrying the reply is acknowledged.
    expect(items().filter((item) => item.status === 'drafted')).toHaveLength(4)
    expect(items().filter((item) => item.status === 'drafted').every((item) => item.draftReply === undefined)).toBe(true)
    await expect(client.startTurn('t1', { text: '   ', model: 'gpt-5.6', effort: null, access: 'full-access' })).rejects.toThrow('Write a message or queue a reply')

    fake.acknowledge(turn.messageId, turn.text)
    await settle()
    expect(items().filter((item) => item.status === 'done')).toHaveLength(4)
    expect(items().filter((item) => item.status === 'open')).toHaveLength(3)
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(directory, 'engine-commands.json'), 'utf8')).pending).toEqual([]))

    const dismissedId = items().find((item) => item.status === 'open')!.id
    await client.dismissItem('t1', dismissedId)
    expect(items()).toHaveLength(6)
    await client.shutdown()

    // A restart reads the same store: the answers stay done, the dismissal stays hidden, two remain open.
    const again = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await again.initialize()
    const reopened = again.view().projects[0]!.threads[0]!.items!
    expect(reopened).toHaveLength(6)
    expect(reopened.filter((item) => item.status === 'done')).toHaveLength(4)
    expect(reopened.filter((item) => item.status === 'open')).toHaveLength(2)
    expect(reopened.some((item) => item.id === dismissedId)).toBe(false)
    await again.shutdown()
  })
})

it('recovers rejected uploads after restart with frozen comments and replies, preserving later drafts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-comment-retry-'))
  const fake = engine()
  const options = { dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 }
  const first = new T3EngineClient(options)
  await first.pair('http://engine.test', 'code'); await first.openThread('t1')
  const id = await first.holdMessageComment('t1', { messageId: 'm1', from: 3, to: 30, kind: 'comment', text: 'A multiline\ncomment' })
  const item = first.view().projects[0]!.threads[0]!.items!.find(item => item.inferred)!
  await first.queueItemReply('t1', item.id, 'Original reply')
  fake.failUploads(true)
  await expect(first.startTurn('t1', { messageId: 'delivery-frozen', text: 'Saved note', model: 'gpt-5.6', effort: null, access: 'full-access', comments: { [id]: 1 }, replies: { [item.id]: 'Original reply' } })).rejects.toThrow()
  await first.queueItemReply('t1', item.id, 'Later reply')
  expect(fake.commands).toHaveLength(0)
  await first.shutdown()
  fake.failUploads(false)
  const second = new T3EngineClient(options); await second.initialize()
  expect(fake.commands).toHaveLength(1)
  expect(fake.uploads).toHaveLength(1)
  expect(fake.uploads[0]).toContain('A multiline\\ncomment')
  expect(fake.uploads[0]).toContain('Original reply')
  expect(fake.uploads[0]).not.toContain('Later reply')
  expect(second.view().projects[0]!.threads[0]!.items!.find(candidate => candidate.id === item.id)?.draftReply).toBe('Later reply')
  fake.acknowledge('delivery-frozen', 'Saved note')
  await vi.waitFor(() => expect(second.view().projects[0]!.threads[0]!.comments![0]!.state).toBe('open'))
  await second.shutdown()
})

it('reuses uploaded references and command identity after a lost dispatch response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-comment-dispatch-'))
  const fake = engine()
  const options = { dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 }
  const first = new T3EngineClient(options)
  await first.pair('http://engine.test', 'code'); await first.openThread('t1')
  fake.failDispatch(true)
  await expect(first.startTurn('t1', { messageId: 'lost', text: 'Saved', attachment: { name: 'a.md', text: 'Original bytes' }, model: 'gpt-5.6', effort: null, access: 'full-access' })).rejects.toThrow()
  await first.shutdown(); fake.failDispatch(false)
  const second = new T3EngineClient(options); await second.initialize()
  expect(fake.uploads).toEqual(['Original bytes'])
  expect(fake.commands).toHaveLength(2)
  expect(fake.commands[1]).toEqual(fake.commands[0])
  await second.shutdown()
})

it('routes standalone conversation actions once, keeps decisions owner-controlled, and delivers outcomes on the next Send', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-comment-actions-'))
  const fake = engine()
  const options = { dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 }
  const first = new T3EngineClient(options)
  await first.pair('http://engine.test', 'code'); await first.openThread('t1')
  const block = first.view().projects[0]!.threads[0]!.messages[0]!.blocks![0]!.id
  fake.post('actions', 'Items.\n\n```strata\n' + JSON.stringify([
    { verb: 'decision', anchor: { message: 'm1', block }, text: 'Choose', options: ['First', 'Second'] },
    { verb: 'question', anchor: { message: 'm1', block }, text: 'Explain?' },
  ]) + '\n```')
  await first.reconnect()
  await vi.waitFor(() => expect(first.view().projects[0]!.threads[0]!.comments).toHaveLength(2))
  fake.post('replies', 'Replies.\n\n```strata\n' + JSON.stringify([
    { verb: 'reply', anchor: { item: 'm_actions_1' }, text: 'Reply exactly once.' },
    { verb: 'resolve', anchor: { item: 'm_actions_0' } },
    { verb: 'resolve', anchor: { item: 'm_actions_1' } },
    { verb: 'decision', anchor: { message: 'm1', block }, text: 'Missing choices' },
  ]) + '\n```')
  await first.reconnect()
  await vi.waitFor(() => expect(first.view().projects[0]!.threads[0]!.comments![1]!.replies).toHaveLength(1))
  await first.shutdown()
  const second = new T3EngineClient(options); await second.initialize()
  const state = second.view().projects[0]!.threads[0]!
  expect(state.comments![0]).toMatchObject({ state: 'open', options: ['First', 'Second'] })
  expect(state.comments![1]).toMatchObject({ state: 'resolved', replies: [{ author: 'agent', text: 'Reply exactly once.' }] })
  expect(state.outcomes?.find(outcome => outcome.message === 'replies' && outcome.index === 1)?.status).toBe('failed')
  expect(state.outcomes?.find(outcome => outcome.message === 'replies' && outcome.index === 3)?.status).toBe('failed')
  expect(fake.commands).toHaveLength(0)
  await second.startTurn('t1', { text: 'Continue', model: 'gpt-5.6', effort: null, access: 'full-access' })
  expect(fake.uploads.at(-1)).toContain('Strata block outcomes')
  await second.shutdown()
})

it('a document-frozen context delivers the original reply while a newer revision remains queued', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-frozen-document-context-'))
  const fake = engine()
  const client = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
  await client.pair('http://engine.test', 'code'); await client.openThread('t1')
  const item = client.view().projects[0]!.threads[0]!.items![0]!
  await client.queueItemReply('t1', item.id, 'Original')
  const context = { deliveryId: 'doc-context', threadId: 't1', annotations: [], replies: [{ itemId: item.id, text: 'Original' }], blocks: [], outcomes: [] }
  await client.queueItemReply('t1', item.id, 'Newer')
  await client.startTurn('t1', { messageId: 'doc-context', text: 'Document Send', model: 'gpt-5.6', effort: null, access: 'full-access', context })
  expect(fake.uploads[0]).toContain('Original')
  expect(fake.uploads[0]).not.toContain('Newer')
  fake.acknowledge('doc-context', 'Document Send')
  await settle()
  expect(client.view().projects[0]!.threads[0]!.items!.find(candidate => candidate.id === item.id)).toMatchObject({ status: 'drafted', draftReply: 'Newer' })
  await client.shutdown()
})

it('holds two comments through restart, quick-sends a third, then sends only one held comment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-three-comments-'))
  const fake = engine()
  const options = { dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 }
  const first = new T3EngineClient(options)
  await first.pair('http://engine.test', 'code'); await first.openThread('t1')
  const hold = (client: T3EngineClient, text: string) => client.holdMessageComment('t1', { messageId: 'm1', from: 3, to: 30, kind: 'comment', text })
  const one = await hold(first, 'First held comment')
  const two = await hold(first, 'Second stays private')
  await first.shutdown()
  const second = new T3EngineClient(options); await second.initialize()
  expect(second.view().projects[0]!.threads[0]!.comments?.map(comment => comment.state)).toEqual(['held', 'held'])
  const three = await hold(second, 'Quick send third')
  const input = { text: '', model: 'gpt-5.6', effort: null, access: 'full-access' as const }
  await second.startTurn('t1', { ...input, messageId: 'quick-three', comments: { [three]: 1 } })
  expect(fake.uploads[0]).toContain('Quick send third')
  expect(fake.uploads[0]).not.toContain('First held')
  expect(fake.uploads[0]).not.toContain('Second stays')
  fake.acknowledge('quick-three', 'Comments'); await settle()
  await second.startTurn('t1', { ...input, messageId: 'held-one', comments: { [one]: 1 } })
  expect(fake.uploads[1]).toContain('First held comment')
  expect(fake.uploads[1]).not.toContain('Second stays')
  expect(second.view().projects[0]!.threads[0]!.comments?.find(comment => comment.id === two)?.state).toBe('held')
  await second.shutdown()
})
