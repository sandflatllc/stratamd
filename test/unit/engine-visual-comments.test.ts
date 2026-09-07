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

async function client(fake: ReturnType<typeof engine>, directory: string, previewHost?: NonNullable<ConstructorParameters<typeof T3EngineClient>[0]['previewHost']>) {
  const instance = new T3EngineClient({ dataDirectory: directory, fetch: fake.fetch, webSocket: fake.server.WebSocket, now: () => Date.parse(at), publishDelayMs: 0, ...(previewHost ? { previewHost } : {}) })
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
    await vi.waitFor(() => expect(visual(instance)[0]!.revisions[0]!.replies.length).toBeGreaterThan(0))
    card = visual(instance)[0]!
    expect(card.status).toBe('ready')
    expect(card.revisions[0]!.replies).toMatchObject([{ messageId: 'reply-1', text: 'Moved the labels back under the cells.', ready: true, file: '/tmp/after.png', at: Date.parse(at) }])
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
    await vi.waitFor(() => expect(visual(instance)[0]!.revisions[0]!.replies).toHaveLength(2))
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
    fake.failUploads(false)
    await Promise.all([instance.actVisualComment(id, 'retry'), instance.resumeAfterMaintenance()])
    expect(fake.commands).toHaveLength(1)
    const context = new TextDecoder().decode(fake.uploads.find((upload) => upload.contentType === 'text/markdown')!.bytes)
    expect(context).toContain('The header labels drift left.')
    expect(context).not.toContain('Newer thought.')
    card = visual(instance)[0]!
    expect(card.status).toBe('sending')
    expect(card.revisions[0]!.state).toBe('sending')
    expect(card.draft).toBeUndefined()
    await instance.shutdown()
  })

  it('cancels a failed frozen send before replacing it and preserves the replacement on late acknowledgment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-visual-replacement-'))
    const fake = engine(), instance = await client(fake, directory)
    const { id } = await hold(instance, directory)
    fake.failUploads(true)
    await expect(instance.startTurn('t1', { ...turn, text: '', visual: [id] })).rejects.toThrow()
    const old = instance.visualComment(id)!.revisions[0]!.deliveryId
    await instance.holdVisualComment({ id, projectId: 'p1', threadId: 't1', text: 'Replacement note', marks: [], strokes: [], adjustments: [], marked: [] })
    fake.failUploads(false)
    await expect(instance.actVisualComment(id, 'retry')).rejects.toThrow('frozen send is gone')
    fake.acknowledge(old, 'Old note')
    await vi.waitFor(() => expect(instance.view().projects[0]!.threads[0]!.messages?.some(message => message.id === old)).toBe(true))
    expect(visual(instance)[0]!.draft?.text).toBe('Replacement note')
    expect(fake.commands).toHaveLength(0)
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

describe('a comment on a running page (phase 3)', () => {
  it('holds over captured frames, re-checks its marks before Send, refuses with the draft kept, and sends once the page agrees', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-visual-page-'))
    const fake = engine()
    let answer: { refusal: string | null; found: Record<string, boolean> } = { refusal: 'New client button is no longer on the page. Your note and marks are kept; remove that mark or mark the page again to send.', found: {} }
    const recheck = vi.fn(async () => answer)
    const instance = await client(fake, directory, { operations: [], handle: async () => ({ ok: true, result: null }), setRegistered: () => undefined, recheckVisual: recheck })
    // Annotate stored two frames, one per scroll position, before anything was held.
    const first = await instance.storeVisualCapture({ bytes: png, width: 1, height: 1 })
    const second = await instance.storeVisualCapture({ bytes: png, width: 1, height: 1 })
    const page = { tabId: 'tab_1', captures: [{ id: first, width: 1, height: 1, scroll: { x: 0, y: 0 }, scale: 1 }, { id: second, width: 1, height: 1, scroll: { x: 0, y: 900 }, scale: 1 }], url: 'http://localhost:5173/clients', title: 'Clients', viewport: { width: 1200, height: 800 }, preset: null, deviceScale: 1 }
    const identity = { role: 'button', name: 'New client', selector: 'button#new-client', testIds: ['new-client'], sources: [{ file: 'src/pages/Clients.tsx', line: 41, column: 9, role: 'usage' as const }] }
    const id = await instance.holdVisualComment({
      projectId: 'p1', threadId: 't1', page, text: 'Into the header row.',
      marks: [{ id: 'k1', kind: 'element', label: 'New client button', captureId: first, rect: { x: 0, y: 0, width: 1, height: 1 }, found: true, identity }, { id: 'k2', kind: 'element', label: 'The end of the page.', captureId: second, rect: { x: 0, y: 0, width: 1, height: 1 }, found: true, identity: { role: null, name: null, selector: 'p#bottom', testIds: [] } }],
      strokes: [], adjustments: [], marked: [{ captureId: first, bytes: marked }, { captureId: second, bytes: marked }],
    })
    const held = visual(instance).find((comment) => comment.id === id)!
    expect(held.status).toBe('held')
    expect(held.place).toBe('Clients · window size')
    expect(held.anchor).toMatchObject({ kind: 'page', url: 'http://localhost:5173/clients', instance: 'tab_1' })
    expect(held.captures.map((capture) => capture.scroll)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 900 }])
    // The re-check refuses: nothing is frozen, no turn starts, the draft stays.
    await expect(instance.startTurn('t1', { text: '', ...turn, visual: [id] })).rejects.toThrow('New client button is no longer on the page')
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(fake.commands.filter((command) => command.type === 'thread.turn.start')).toHaveLength(0)
    expect(visual(instance).find((comment) => comment.id === id)!.status).toBe('held')
    // The page agrees: both frames travel, the brief carries each mark's identity and sources, and the found flags follow the check.
    answer = { refusal: null, found: { k1: true, k2: false } }
    await instance.startTurn('t1', { text: '', ...turn, visual: [id] })
    const command = fake.commands.find((candidate) => candidate.type === 'thread.turn.start')!
    const attachments = (command.message as { attachments: Array<{ name: string }> }).attachments
    expect(attachments.map((attachment) => attachment.name).filter((name) => name.endsWith('.png'))).toHaveLength(2)
    const context = fake.uploads.find((upload) => upload.name.endsWith('.md'))!
    const brief = contextSection(Buffer.from(context.bytes).toString('utf8'), 'Visual comments')[0]
    expect(brief.marks[0]).toMatchObject({ label: 'New client button', found: true, selector: 'button#new-client', sources: [{ file: 'src/pages/Clients.tsx', line: 41 }] })
    expect(brief.marks[1]).toMatchObject({ label: 'The end of the page.', found: false, selector: 'p#bottom' })
    expect(brief.captures.map((capture: { scroll?: { y: number } }) => capture.scroll?.y)).toEqual([0, 900])
    // Show me reads the record back: the anchor, the marks, and their identities.
    expect(instance.visualComment(id)?.revisions[0]?.marks[0]?.identity?.selector).toBe('button#new-client')
    await instance.shutdown()
  })
})

describe('Then / now and adjustments (phase 4)', () => {
  it('takes the comparison on a ready reply through the host, retakes it on the next, and carries the requested appearance with adjustments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-visual-compare-'))
    const fake = engine()
    let outcome: { then: { bytes: Uint8Array; width: number; height: number }; now: { bytes: Uint8Array; width: number; height: number } | null; note: string | null } = { then: { bytes: png, width: 1, height: 1 }, now: { bytes: png, width: 1, height: 1 }, note: null }
    const compare = vi.fn(async () => outcome)
    const instance = await client(fake, directory, { operations: [], handle: async () => ({ ok: true, result: null }), setRegistered: () => undefined, recheckVisual: async () => ({ refusal: null, found: {} }), compareVisual: compare })
    const clean = await instance.storeVisualCapture({ bytes: png, width: 1, height: 1 })
    const requested = await instance.storeVisualCapture({ bytes: marked, width: 1, height: 1 })
    const page = { tabId: 'tab_1', captures: [{ id: clean, width: 1, height: 1, scroll: { x: 0, y: 0 }, scale: 1 }, { id: requested, width: 1, height: 1, scroll: { x: 0, y: 0 }, scale: 1, requested: true }], url: 'http://localhost:5173/clients', title: 'Clients', viewport: { width: 1200, height: 800 }, preset: null, deviceScale: 1 }
    const id = await instance.holdVisualComment({
      projectId: 'p1', threadId: 't1', page, text: 'Bigger, like this.',
      marks: [{ id: 'k1', kind: 'element', label: 'New client button', captureId: clean, rect: { x: 0, y: 0, width: 1, height: 1 }, found: true, identity: { role: 'button', name: 'New client', selector: 'button#new-client', testIds: [] } }],
      strokes: [], adjustments: [{ markId: 'k1', property: 'font-size', value: '18px', label: 'Text size: slightly larger' }], marked: [{ captureId: clean, bytes: marked }],
    })
    await instance.startTurn('t1', { text: '', ...turn, visual: [id] })
    const command = fake.commands.find((candidate) => candidate.type === 'thread.turn.start')!
    const attachments = (command.message as { attachments: Array<{ name: string }> }).attachments
    // The marked capture, the requested appearance, and the context file.
    expect(attachments).toHaveLength(3)
    const brief = contextSection(Buffer.from(fake.uploads.find((upload) => upload.name.endsWith('.md'))!.bytes).toString('utf8'), 'Visual comments')[0]
    expect(brief.adjustments).toEqual([{ mark: 'k1', property: 'font-size', value: '18px' }])
    expect(brief.captures.map((capture: { requested?: boolean }) => capture.requested ?? false)).toEqual([false, true])
    fake.acknowledge(String((command.message as { messageId: string }).messageId), 'Bigger, like this.')
    await vi.waitFor(() => expect(visual(instance)[0]!.status).toBe('sent'))
    // Ready for review is a trigger: the host captures "now", and the record keeps both crops on that revision.
    fake.reply('a1', `Done.\n\n\`\`\`strata\n${JSON.stringify([{ verb: 'reply', anchor: { item: id }, revision: 1, text: 'Done.', ready: true }])}\n\`\`\``)
    await vi.waitFor(() => expect(visual(instance)[0]!.revisions[0]!.comparison).toBeDefined())
    expect(compare).toHaveBeenCalledTimes(1)
    const first = visual(instance)[0]!.revisions[0]!.comparison!
    expect(first.nowUrl).toMatch(/^strata-visual:\/\/evidence\/e_/)
    expect(first.note).toBeNull()
    expect(visual(instance)[0]!.status).toBe('ready')
    // The next ready reply retakes it; the views differ and the note says so, with no empty pair.
    outcome = { then: { bytes: png, width: 1, height: 1 }, now: null, note: 'The views differ: New client button was not found on the page now.' }
    fake.reply('a2', `Again.\n\n\`\`\`strata\n${JSON.stringify([{ verb: 'reply', anchor: { item: id }, revision: 1, text: 'Again.', ready: true }])}\n\`\`\``)
    await vi.waitFor(() => expect(visual(instance)[0]!.revisions[0]!.comparison?.nowUrl).toBeNull())
    expect(visual(instance)[0]!.revisions[0]!.comparison?.note).toContain('views differ')
    // Each reply keeps its own comparison alongside the original captures.
    expect(visual(instance)[0]!.revisions[0]!.replies[0]!.comparison).toEqual(first)
    const files = (await readdir(join(directory, 'visual-evidence'))).filter((name) => name.endsWith('.bin'))
    expect(files).toHaveLength(6)
    await instance.shutdown()
  })
})
