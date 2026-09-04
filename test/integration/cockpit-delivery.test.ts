import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStrataApplication, type StrataApplication } from '../../src/main/application'
import type { EngineReadClient } from '../../src/main/engine/client'
import type { EngineView } from '../../src/shared/contracts'
import { GhostStore } from '../../src/main/storage'
import { SettingsStore } from '../../src/main/settings'

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
      state: 'connected', server: 'http://engine.test', serverVersion: '0.0.33', supportedVersion: '0.0.33', problem: null, activeThreadId: 't1',
      projects: [{ id: 'p1', title: 'Project', workspaceRoot: '/work', threads: [{
        id: 't1', projectId: 'p1', title: 'Reviewer', model: 'gpt-5.6', providerInstanceId: 'codex', effort: 'medium', access: 'full-access', status: 'idle',
        updatedAt: new Date(0).toISOString(), unread: false, pendingApprovals: false, pendingUserInput: false, activeTurnId: null, turnStartedAt: null,
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
    expect(engine.turns[0]).toMatchObject({ messageId: deliveryId, commandId: `strata-${deliveryId}`, attachment: { name: `${deliveryId}.md` } })
    expect(engine.turns[0]!.text).toMatch(/^Delivery .*: 0 changes, 0 items\.$/)
    expect(engine.turns[0]!.attachment?.text).toContain('Original.')
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
    const blockId = /- (b[0-9a-f]+): Original\./.exec(engine.turns[0]!.attachment!.text)![1]!
    engine.assistant('assistant-1', `Done.\n\n\`\`\`strata\n${JSON.stringify([
      { verb: 'question', anchor: { document: path, block: blockId }, text: 'Keep this?' },
      { verb: 'comment', anchor: { document: path, block: blockId }, text: 'Checked.' },
      { verb: 'edit', anchor: { document: path, block: 'b-stale' }, match: 'Original', replace: 'Revised' },
    ])}\n\`\`\``)
    for (let attempt = 0; attempt < 200 && (await app.getState()).activeDocument!.annotations.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await app.getState()).activeDocument!.annotations.map((item) => item.text)).toEqual(['Keep this?', 'Checked.'])

    await app.send(path, { recipients: ['t1'], note: 'Continue.', includeExternal: false })
    expect(engine.turns[1]!.attachment!.text).toContain('1. applied as a_')
    expect(engine.turns[1]!.attachment!.text).toContain('2. applied as a_')
    expect(engine.turns[1]!.attachment!.text).toContain('3. failed: block b-stale changed')
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
    expect(engine.turns[0]!.attachment!.text).toContain('# Bootstrap')
  })
})
