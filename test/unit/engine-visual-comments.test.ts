import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { fakeEngineServer } from './support/fake-engine-socket'

/**
 * The image comment loop (docs/plans/open/visual-review, phase 1): a staged
 * image becomes a held visual comment, Send freezes a revision and carries the
 * marked screenshot beside the context file, the reply names the revision,
 * and Looks right and Still wrong work without a turn.
 */
const at = '2026-09-05T12:00:00.000Z'
const thread = {
  id: 't1', projectId: 'p1', title: 'Clients table review', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: {} }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
  latestTurn: null, createdAt: at, updatedAt: at,
  session: { threadId: 't1', status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: null, lastError: null, updatedAt: at },
  latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
}
const shell = { snapshotSequence: 10, projects: [{ id: 'p1', title: 'Mesa', workspaceRoot: '/work', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }], threads: [thread], updatedAt: at }
/** A 1 by 1 PNG. */
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
const marked = Uint8Array.from([...png, 1])
const turn = { model: 'gpt-5.6', effort: null, access: 'full-access' as const }
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function engine() {
  let failUploads = false
  const commands: Array<Record<string, unknown>> = []
  const uploads: Array<{ name: string; contentType: string; bytes: Uint8Array }> = []
  const messages: unknown[] = [{ id: 'm1', role: 'assistant', text: 'Ready when you are.', attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }]
  const uploadNames: string[] = []
  const server = fakeEngineServer((tag, payload) => {
    if (tag.startsWith('orchestration.subscribe')) return [{ kind: 'synchronized' }]
    if (tag === 'attachments.createUploadUrl') { uploadNames.push(String((payload as { name: string }).name)); return { attachmentId: `upload-${uploadNames.length}`, relativeUrl: `/upload/${uploadNames.length}`, expiresAt: 1 } }
    return null
  })
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'secret', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' })
    if (url.endsWith('/api/auth/websocket-ticket')) return Response.json({ ticket: 'ticket-1', expiresAt: at })
    const upload = /\/upload\/(\d+)$/.exec(url)
    if (upload) {
      if (failUploads) return new Response('', { status: 503 })
      uploads.push({ name: uploadNames[Number(upload[1]) - 1]!, contentType: String((init?.headers as Record<string, string>)['content-type']), bytes: new Uint8Array(init?.body as Uint8Array) })
      return new Response('', { status: 200 })
    }
    if (url.endsWith('/api/orchestration/dispatch')) { commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ sequence: 10 + commands.length }) }
    if (url.endsWith('/api/orchestration/shell')) return Response.json(shell)
    if (url.endsWith('/api/orchestration/threads/t1')) return Response.json({ snapshotSequence: 10, thread: { ...thread, deletedAt: null, messages, activities: [], checkpoints: [] }, page: { beforeCursor: null, hasMore: false, snapshotSequence: 10, threadSequence: 10 } })
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
  const event = (type: string, payload: Record<string, unknown>) => server.push('orchestration.subscribeThread', [{ kind: 'event', event: { sequence: 100 + messages.length, eventId: `e${messages.length}`, aggregateKind: 'thread', aggregateId: 't1', occurredAt: at, commandId: null, causationEventId: null, correlationId: null, metadata: {}, type, payload } }])
  const acknowledge = (messageId: string, text: string) => {
    messages.push({ id: messageId, role: 'user', text, attachments: [], turnId: 'turn-2', streaming: false, createdAt: at, updatedAt: at })
    event('thread.message-sent', { threadId: 't1', messageId, role: 'user', text, turnId: 'turn-2', streaming: false, createdAt: at, updatedAt: at })
  }
  const reply = (messageId: string, text: string) => {
    messages.push({ id: messageId, role: 'assistant', text, attachments: [], turnId: 'turn-2', streaming: false, createdAt: at, updatedAt: at })
    event('thread.message-sent', { threadId: 't1', messageId, role: 'assistant', text, turnId: 'turn-2', streaming: false, createdAt: at, updatedAt: at })
  }
  return { server, fetch, commands, uploads, acknowledge, reply, failUploads: (value: boolean) => { failUploads = value } }
}

async function client(fake: ReturnType<typeof engine>, directory: string) {
  const instance = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
  await instance.pair('http://engine.test', 'code'); await instance.openThread('t1')
  await settle()
  return instance
}

const visual = (instance: T3EngineClient) => instance.view().projects[0]!.visualComments ?? []
const contextSection = (text: string, title: string) => JSON.parse(new RegExp(`## ${title}\\n\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``).exec(text)![1]!)

async function hold(instance: T3EngineClient, directory: string) {
  const staged = await instance.stageAttachment({ name: 'pasted-image.png', mimeType: 'image/png', bytes: png })
  const id = await instance.holdVisualComment({
    projectId: 'p1', threadId: 't1', source: { staged: staged.id, name: 'pasted-image.png', width: 1, height: 1 },
    text: 'The header labels drift left.',
    marks: [{ id: 'k1', kind: 'region', label: 'Region 1', captureId: staged.id, rect: { x: 0, y: 0, width: 1, height: 1 }, found: null }],
    strokes: [{ id: 's1', tool: 'arrow', captureId: staged.id, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
    adjustments: [],
    marked: [{ captureId: staged.id, bytes: marked }],
  })
  // The staged copy left; the evidence store holds the clean capture and its marked version.
  expect(await readdir(join(directory, 'composer-attachments'))).toEqual([])
  expect((await readdir(join(directory, 'visual-evidence'))).filter((name) => name.endsWith('.bin'))).toHaveLength(2)
  return { id, staged }
}

describe('visual comments through the engine client', () => {
  it('holds a pasted image with its marks, survives a restart, and keeps the destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-visual-hold-'))
    const fake = engine()
    const first = await client(fake, directory)
    const { id } = await hold(first, directory)
    const held = visual(first)[0]!
    expect(held).toMatchObject({ id, status: 'held', statusLabel: 'held', place: 'Pasted image · 1 × 1', summary: '1 thing marked · 1 arrow', title: 'Region 1' })
    expect(held.draft?.destination).toEqual({ threadId: 't1', threadTitle: 'Clients table review' })
    expect(held.captures[0]!.url).toMatch(/^strata-visual:\/\/evidence\/e_/)
    expect(held.thumbnail).not.toBe(held.captures[0]!.url)
    // Holding again with new text keeps the destination and refreshes the marked capture; the old marked bytes leave.
    await first.holdVisualComment({ id, projectId: 'p1', threadId: 't1', text: 'Second thought.', marks: held.draft!.marks, strokes: [], adjustments: [], marked: [{ captureId: held.captures[0]!.id, bytes: Uint8Array.from([...png, 2]) }] })
    expect((await readdir(join(directory, 'visual-evidence'))).filter((name) => name.endsWith('.bin'))).toHaveLength(2)
    await first.shutdown()

    const second = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0 })
    await second.initialize()
    const restored = visual(second)[0]!
    expect(restored.status).toBe('held')
    expect(restored.draft?.text).toBe('Second thought.')
    expect(restored.draft?.marks.map((mark) => mark.label)).toEqual(['Region 1'])
    expect(await readdir(join(directory, 'composer-attachments')).catch(() => [])).toEqual([])
    await second.shutdown()
  })

  it('sends a frozen revision with the marked screenshot and the brief, then answers by revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-visual-send-'))
    const fake = engine()
    const instance = await client(fake, directory)
    const { id } = await hold(instance, directory)
    await instance.startTurn('t1', { ...turn, text: '', visual: [id] })
    expect(fake.commands).toHaveLength(1)
    const message = fake.commands[0]!.message as { messageId: string; text: string; attachments: Array<{ type: string; name: string; mimeType: string }> }
    expect(message.text).toBe('Visual comment: Region 1.')
    expect(message.attachments.map((attachment) => [attachment.type, attachment.mimeType])).toEqual([['image', 'image/png'], ['file', 'text/markdown']])
    expect(message.attachments[0]!.name).toMatch(/^visual-[0-9a-f]{8}-r1-1\.png$/)
    // The marked version travels, not the clean capture, and the evidence store keeps both.
    expect([...fake.uploads[0]!.bytes]).toEqual([...marked])
    expect((await readdir(join(directory, 'visual-evidence'))).filter((name) => name.endsWith('.bin'))).toHaveLength(2)
    const context = new TextDecoder().decode(fake.uploads[1]!.bytes)
    const briefs = contextSection(context, 'Visual comments')
    expect(briefs).toHaveLength(1)
    expect(briefs[0]).toMatchObject({ id, revision: 1, text: 'The header labels drift left.', captures: [{ name: message.attachments[0]!.name, width: 1, height: 1 }] })
    expect(briefs[0].marks[0]).toMatchObject({ label: 'Region 1', capture: message.attachments[0]!.name, rect: { x: 0, y: 0, width: 1, height: 1 } })
    expect(context).toContain('"ready":true')
    let card = visual(instance)[0]!
    expect(card.status).toBe('sending')
    expect(card.draft).toBeUndefined()
    expect(card.revisions[0]).toMatchObject({ number: 1, state: 'sending', destination: { threadId: 't1' } })

    fake.acknowledge(message.messageId, message.text)
    await settle()
    expect(visual(instance)[0]!.status).toBe('sent')

    // A reply naming the revision with ready moves the card to ready for review; resolve is owner-only.
    fake.reply('reply-1', `Moved the labels.\n\n\`\`\`strata\n${JSON.stringify([{ verb: 'reply', anchor: { item: id }, revision: 1, text: 'Moved the labels back under the cells.', ready: true, file: '/tmp/after.png' }, { verb: 'resolve', anchor: { item: id } }])}\n\`\`\``)
    await settle(); await settle()
    card = visual(instance)[0]!
    expect(card.status).toBe('ready')
    expect(card.revisions[0]!.replies).toEqual([{ messageId: 'reply-1', text: 'Moved the labels back under the cells.', ready: true, file: '/tmp/after.png', at: Date.parse(at) }])
    const outcomes = instance.view().projects[0]!.threads[0]!.outcomes!
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'failed'])
    expect(outcomes[1]!.reason).toContain('Only the owner can resolve')

    // Looks right accepts locally and starts no turn.
    await instance.actVisualComment(id, 'accept')
    expect(visual(instance)[0]!.status).toBe('done')
    expect(fake.commands).toHaveLength(1)

    // Still wrong opens the next private note over the same marks; the next Send is revision 2.
    await instance.actVisualComment(id, 'reopen')
    card = visual(instance)[0]!
    expect(card.status).toBe('held')
    expect(card.draft).toMatchObject({ text: '', marks: [{ label: 'Region 1' }] })
    await instance.holdVisualComment({ id, projectId: 'p1', threadId: 't1', text: 'Still drifting on the phone.', marks: card.draft!.marks, strokes: [], adjustments: [], marked: [] })
    await instance.startTurn('t1', { ...turn, text: '', visual: [id] })
    expect(fake.commands).toHaveLength(2)
    const second = fake.commands[1]!.message as { messageId: string; text: string }
    fake.acknowledge(second.messageId, second.text)
    await settle()
    card = visual(instance)[0]!
    expect(card.status).toBe('sent')
    expect(card.revisions.map((revision) => revision.number)).toEqual([1, 2])

    // A late reply to revision 1 stays readable and changes nothing on the card.
    fake.reply('reply-2', `\`\`\`strata\n${JSON.stringify([{ verb: 'reply', anchor: { item: id }, revision: 1, text: 'One more note on the first pass.', ready: true }])}\n\`\`\``)
    await settle(); await settle()
    card = visual(instance)[0]!
    expect(card.status).toBe('sent')
    expect(card.revisions[0]!.replies).toHaveLength(2)
    expect(card.revisions[1]!.replies).toHaveLength(0)
    await instance.shutdown()
  })

  it('refuses a selection over capacity by name and leaves the draft intact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-visual-capacity-'))
    const fake = engine()
    const instance = await client(fake, directory)
    const { id } = await hold(instance, directory)
    const files = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
      const staged = await instance.stageAttachment({ name: `file-${index}.png`, mimeType: 'image/png', bytes: png })
      return { kind: 'image' as const, id: staged.id, name: `file-${index}.png`, mimeType: 'image/png', sizeBytes: staged.sizeBytes }
    }))
    await expect(instance.startTurn('t1', { ...turn, text: 'Too much', visual: [id], attachments: files })).rejects.toThrow('That send would carry 9 attachments, 1 over the limit of 8: 7 files, 1 marked screenshot, and the context file. Remove a file, or send a visual comment on its own first.')
    expect(fake.commands).toHaveLength(0)
    expect(fake.uploads).toHaveLength(0)
    expect(visual(instance)[0]!.status).toBe('held')
    // Six files fit: six images, the marked screenshot, and the context file.
    await instance.startTurn('t1', { ...turn, text: 'Fits', visual: [id], attachments: files.slice(0, 6) })
    expect((fake.commands[0]!.message as { attachments: unknown[] }).attachments).toHaveLength(8)
    await instance.shutdown()
  })

  it('keeps a failed Send retryable with the frozen revision, not a newer draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-visual-retry-'))
    const fake = engine()
    const instance = await client(fake, directory)
    const { id } = await hold(instance, directory)
    fake.failUploads(true)
    await expect(instance.startTurn('t1', { ...turn, text: '', visual: [id] })).rejects.toThrow()
    let card = visual(instance)[0]!
    expect(card.status).toBe('failed')
    expect(card.statusLabel).toBe('send failed')
    expect(card.revisions[0]!.error).toBeTruthy()
    expect(fake.commands).toHaveLength(0)
    // A newer note held meanwhile stays a draft; retry sends what was frozen.
    await instance.holdVisualComment({ id, projectId: 'p1', threadId: 't1', text: 'Newer thought.', marks: [], strokes: [], adjustments: [], marked: [] })
    fake.failUploads(false)
    await instance.actVisualComment(id, 'retry')
    expect(fake.commands).toHaveLength(1)
    const context = new TextDecoder().decode(fake.uploads.find((upload) => upload.contentType === 'text/markdown')!.bytes)
    expect(context).toContain('The header labels drift left.')
    expect(context).not.toContain('Newer thought.')
    card = visual(instance)[0]!
    expect(card.status).toBe('held')
    expect(card.revisions[0]!.state).toBe('sending')
    expect(card.draft?.text).toBe('Newer thought.')
    await instance.shutdown()
  })

  it('discards an unsent draft with its evidence and keeps a sent comment when its draft is discarded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-visual-discard-'))
    const fake = engine()
    const instance = await client(fake, directory)
    const { id } = await hold(instance, directory)
    await instance.actVisualComment(id, 'discard')
    expect(visual(instance)).toHaveLength(0)
    expect((await readdir(join(directory, 'visual-evidence'))).filter((name) => name.endsWith('.bin'))).toHaveLength(0)
    const { id: second } = await hold(instance, directory)
    await instance.startTurn('t1', { ...turn, text: '', visual: [second] })
    await instance.actVisualComment(second, 'reopen')
    await instance.actVisualComment(second, 'discard')
    expect(visual(instance)[0]).toMatchObject({ id: second, status: 'sending' })
    expect(JSON.parse(await readFile(join(directory, 'engine-visual-comments.json'), 'utf8')).comments[second].revisions).toHaveLength(1)
    await instance.shutdown()
  })
})
