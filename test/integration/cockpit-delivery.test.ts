import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStrataApplication, type StrataApplication } from '../../src/main/application'
import type { EngineReadClient } from '../../src/main/engine/client'
import type { EngineView } from '../../src/shared/contracts'
import { GhostStore } from '../../src/main/storage'
import { SettingsStore } from '../../src/main/settings'
import { deliveryText } from './support/cockpit'

class DeliveryEngine implements EngineReadClient {
  readonly turns: Array<Parameters<EngineReadClient['startTurn']>[1]> = []
  readonly #listeners = new Set<(view: EngineView) => void>()
  #messages: EngineView['projects'][number]['threads'][number]['messages'] = []

  initialize = async () => {}
  shutdown = async () => {}
  pair = async () => {}
  reconnect = async () => {}
  openThread = async () => {}
  interrupt = async () => {}
  respondApproval = async () => {}
  respondUserInput = async () => {}
  subscribe(listener: (view: EngineView) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  view(): EngineView {
    return {
      state: 'connected', server: 'http://engine.test', problem: null, credential: null, activeThreadId: 't1', accounts: [], terminalDefaults: {}, terminalShimDirectory: null,
      projects: [{ id: 'p1', title: 'Project', workspaceRoot: '/work', threads: [{
        id: 't1', projectId: 'p1', title: 'Reviewer', model: 'gpt-5.6', providerInstanceId: 'codex', effort: 'medium', access: 'full-access', status: 'idle',
        updatedAt: new Date(0).toISOString(), lastExchangeAt: new Date(0).toISOString(), unread: false, pendingApprovals: false, pendingUserInput: false, activeTurnId: null, turnStartedAt: null, latestTurn: null, pinnedAt: null, snoozedUntil: null, lifecycle: 'active', archived: false, attention: 0, pendingWork: 0,
        messages: this.#messages, activities: [],
      }] }],
    }
  }
  async startTurn(_threadId: string, input: Parameters<EngineReadClient['startTurn']>[1]) { this.turns.push(structuredClone(input)) }
  acknowledge(messageId: string) {
    this.#messages = [{ id: messageId, role: 'user', text: 'Delivery', turnId: 'turn-1', streaming: false, createdAt: new Date(0).toISOString(), attachmentCount: 1 }]
    const view = this.view()
    for (const listener of this.#listeners) listener(view)
  }
  assistant(messageId: string, text: string) {
    this.#messages = [...this.#messages, { id: messageId, role: 'assistant', text, turnId: 'turn-1', streaming: false, createdAt: new Date(0).toISOString(), attachmentCount: 0 }]
    const view = this.view()
    for (const listener of this.#listeners) listener(view)
  }
}

const applications: StrataApplication[] = []
afterEach(async () => Promise.all(applications.splice(0).map((app) => app.shutdown())))

describe('cockpit delivery turns', () => {
  it('attaches by sending, dispatches the rendered delivery as a file, and advances once on message acknowledgment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-cockpit-delivery-'))
    const path = join(root, 'plan.md')
    await writeFile(path, '# Plan\n\nOriginal.\n')
    const store = new GhostStore({ dataDirectory: join(root, 'data') })
    const engine = new DeliveryEngine()
    const app = await createStrataApplication({ store, settingsStore: new SettingsStore({ configDirectory: join(root, 'config') }), engine, watch: false })
    applications.push(app)
    await app.openDocument(path)
    const preview = await app.previewSend(path, { recipients: ['t1'], note: 'Review this.', includeExternal: false })
    const [deliveryId] = await app.send(path, { recipients: ['t1'], note: 'Review this.', includeExternal: false, token: preview[0]!.token })

    expect(engine.turns).toHaveLength(1)
    expect(engine.turns[0]).toMatchObject({ messageId: deliveryId, commandId: `strata-${deliveryId}`, attachments: [{ name: `${deliveryId}.md` }] })
    expect(engine.turns[0]!.text).toMatch(/^Delivery .*: 0 changes, 0 items\.$/)
    expect(deliveryText(engine.turns[0]!)).toContain('Original.')
    expect((await store.loadMeta(path)).attachments.t1?.deliveries).toHaveLength(1)

    engine.acknowledge(deliveryId!)
    for (let attempt = 0; attempt < 200 && (await store.loadMeta(path)).attachments.t1?.deliveries.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const settled = await store.loadMeta(path)
    expect(settled.attachments.t1?.deliveries).toHaveLength(0)
    expect(engine.turns).toHaveLength(1)
  })

  it('applies valid strata entries, keeps a stale entry as a failure, and reports every outcome next turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-cockpit-block-'))
    const path = join(root, 'plan.md')
    await writeFile(path, '# Plan\n\nOriginal.\n')
    const store = new GhostStore({ dataDirectory: join(root, 'data') })
    const engine = new DeliveryEngine()
    const app = await createStrataApplication({ store, settingsStore: new SettingsStore({ configDirectory: join(root, 'config') }), engine, watch: false })
    applications.push(app)
    await app.openDocument(path)
    const [first] = await app.send(path, { recipients: ['t1'], note: '', includeExternal: false })
    engine.acknowledge(first!)
    for (let attempt = 0; attempt < 200 && (await store.loadMeta(path)).attachments.t1?.deliveries.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const blockId = /- (b[0-9a-f]+): Original\./.exec(deliveryText(engine.turns[0]!)!)![1]!
    engine.assistant('assistant-1', `Done.\n\n\`\`\`strata\n${JSON.stringify([
      { verb: 'decision', anchor: { document: path, block: blockId }, text: 'Which?', options: ['Keep', 'Change'] },
      { verb: 'question', anchor: { document: path, block: blockId }, text: 'Keep this?' },
      { verb: 'suggest', anchor: { document: path, block: blockId }, replacement: 'Suggested.' },
      { verb: 'edit', anchor: { document: path, block: blockId }, match: 'Original', replace: 'Revised' },
      { verb: 'edit', anchor: { document: path, block: 'b-stale' }, match: 'Original', replace: 'Revised' },
    ])}\n\`\`\``)
    for (let attempt = 0; attempt < 200 && ((await app.getState()).activeDocument!.items?.length ?? 0) < 4; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await app.getState()).activeDocument!.items?.map((item) => [item.kind, item.turnId])).toEqual([
      ['decision', 'turn-1'], ['question', 'turn-1'], ['suggestion', 'turn-1'], ['edit', 'turn-1'],
    ])
    // Projects shows the thread's pending work across its documents (§5.2): three open items plus the edit's pending hunk.
    expect((await app.getState()).engine.projects[0]!.threads[0]!.pendingWork).toBe(4)

    await app.send(path, { recipients: ['t1'], note: 'Continue.', includeExternal: false })
    expect(deliveryText(engine.turns[1]!)).toContain('1. applied as a_')
    expect(deliveryText(engine.turns[1]!)).toContain('2. applied as a_')
    expect(deliveryText(engine.turns[1]!)).toContain('3. applied as a_')
    expect(deliveryText(engine.turns[1]!)).toContain('4. applied')
    expect(deliveryText(engine.turns[1]!)).toContain('5. failed: block b-stale changed')
  })

  it('accepts an attach-only block from an unattached thread and starts its first delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-cockpit-bootstrap-'))
    const path = join(root, 'plan.md')
    await writeFile(path, '# Bootstrap\n')
    const engine = new DeliveryEngine()
    engine.assistant('bootstrap-1', `\`\`\`strata\n[{"verb":"attach","document":${JSON.stringify(path)}}]\n\`\`\``)
    const app = await createStrataApplication({
      store: new GhostStore({ dataDirectory: join(root, 'data') }),
      settingsStore: new SettingsStore({ configDirectory: join(root, 'config') }), engine, watch: false,
    })
    applications.push(app)
    await app.openDocument(path)
    for (let attempt = 0; attempt < 50 && engine.turns.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await app.getState()).activeDocument!.attachments[0]?.agent.id).toBe('t1')
    expect(deliveryText(engine.turns[0]!)).toContain('# Bootstrap')
  })
})

it('document preview freezes explicit conversation selections separately for each recipient', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-mixed-delivery-'))
  const path = join(root, 'mixed.md')
  await writeFile(path, '# Mixed document\n\nSource paragraph.\n')
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  const engine = new DeliveryEngine()
  const originalView = engine.view.bind(engine)
  engine.view = () => {
    const view = originalView()
    const base = view.projects[0]!.threads[0]!
    view.projects[0]!.threads = ['t1', 't2'].map(id => ({ ...base, id, items: [{ id: `item-${id}`, kind: 'question', status: 'drafted', review: 'unreviewed', text: 'Question', quote: 'Source', order: 0, threadId: id, turnId: null, messageId: null, annotationId: null, hunkId: null, inferred: true, draftReply: `Private reply for ${id}` }] }))
    return view
  }
  const app = await createStrataApplication({ store, settingsStore: new SettingsStore({ configDirectory: join(root, 'config') }), engine, watch: false })
  applications.push(app)
  await app.openDocument(path)
  const request = { recipients: ['t1', 't2'], note: 'Read this', includeExternal: false, conversation: {
    t1: { deliveryId: 'mixed-t1', comments: {}, replies: { 'item-t1': 'Private reply for t1' } },
    t2: { deliveryId: 'mixed-t2', comments: {}, replies: {} },
  } }
  const previews = await app.previewSend(path, request)
  expect(previews[0]!.text).toContain('Private reply for t1')
  expect(previews[1]!.text).not.toContain('Private reply')
  await app.send(path, { ...request, token: previews[0]!.token })
  expect(engine.turns[0]!.context?.replies).toEqual([{ itemId: 'item-t1', text: 'Private reply for t1' }])
  expect(engine.turns[1]!.context).toBeUndefined()
  const saved = await store.loadMeta(path)
  expect(saved.attachments.t1?.deliveries[0]).toHaveProperty('conversationContext')
})

it('routes one mixed action block to two documents without duplicating conversation outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-mixed-actions-'))
  const paths = [join(root, 'first.md'), join(root, 'second.md')]
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  const engine = new DeliveryEngine()
  const app = await createStrataApplication({ store, settingsStore: new SettingsStore({ configDirectory: join(root, 'config') }), engine, watch: false })
  applications.push(app)
  for (const path of paths) {
    await writeFile(path, '# Document\n\nTarget paragraph.\n')
    await app.openDocument(path)
    const [delivery] = await app.send(path, { recipients: ['t1'], note: '', includeExternal: false })
    engine.acknowledge(delivery!)
    await vi.waitFor(async () => expect((await store.loadMeta(path)).attachments.t1?.deliveries).toHaveLength(0))
  }
  const text = 'Mixed.\n\n```strata\n' + JSON.stringify([
    ...paths.map(document => ({ verb: 'comment', anchor: { document, quote: 'Target paragraph.' }, text: `Comment for ${document}` })),
    { verb: 'reply', anchor: { item: 'c_owner' }, text: 'A conversation reply.' },
    { verb: 'decision', anchor: { message: 'm_answer', block: 'b_missing' }, text: 'Malformed choices' },
  ]) + '\n```'
  engine.assistant('mixed-actions', text)
  for (const path of paths) {
    await app.openDocument(path)
    await vi.waitFor(async () => expect((await app.getState()).activeDocument!.annotations).toHaveLength(1))
    expect((await app.getState()).activeDocument!.annotations[0]!.text).toBe(`Comment for ${path}`)
  }
  engine.assistant('mixed-actions', text)
  for (const path of paths) {
    await app.openDocument(path)
    expect((await app.getState()).activeDocument!.annotations).toHaveLength(1)
    await app.send(path, { recipients: ['t1'], note: '', includeExternal: false })
    const payload = deliveryText(engine.turns.at(-1)!)!
    expect(payload).toContain('applied as a_')
    expect(payload).not.toContain('failed:')
    expect(payload).not.toContain('A conversation reply.')
  }
})

it('resolves conversation Markdown from its registered project without an open document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-conversation-reference-'))
  await writeFile(join(root, 'notes.md'), '# Local notes\n')
  const engine = new DeliveryEngine()
  const original = engine.view.bind(engine)
  engine.view = () => { const view = original(); view.projects[0]!.workspaceRoot = root; return view }
  const app = await createStrataApplication({ store: new GhostStore({ dataDirectory: join(root, 'data') }), settingsStore: new SettingsStore({ configDirectory: join(root, 'config') }), engine, watch: false })
  applications.push(app)
  expect(await app.resolveLocalMarkdown(join(root, '.conversation.md'), 'notes.md')).toMatchObject({ source: '# Local notes\n' })
  await expect(app.resolveLocalMarkdown(join(root, '.conversation.md'), '../outside.md')).rejects.toThrow('File missing:')
  expect((await app.getState()).activeDocument).toBeNull()
})
