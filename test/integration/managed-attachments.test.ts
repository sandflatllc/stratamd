import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { LocalEngineManager } from '../../src/main/engine/manager'

it.skipIf(!process.env.STRATAMD_ENGINE_BUNDLE)('uploads Markdown and an image through the stock engine before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-attachments-'))
  const uploads: Array<{ method: string | undefined; status: number }> = []
  let attachments: unknown[] = []
  const client = new T3EngineClient({ dataDirectory: root, terminalShimDirectory: null, fetch: async (input, init) => {
    if (String(input).endsWith('/api/orchestration/dispatch')) {
      const command = JSON.parse(String(init?.body))
      if (command.type === 'thread.turn.start') {
        attachments = command.message.attachments
        // Exercise the real upload path without invoking a provider.
        throw new Error('Upload proof stops before provider dispatch')
      }
    }
    const response = await fetch(input, init)
    if (String(input).includes('/api/attachments/upload/')) uploads.push({ method: init?.method, status: response.status })
    return response
  } })
  const manager = new LocalEngineManager({
    directory: join(root, 'engine'), bundle: process.env.STRATAMD_ENGINE_BUNDLE!, changed: () => undefined,
    connect: (address, token, identity) => client.pair(address, token, identity), reconnect: () => client.reconnect(),
    authenticate: async address => {
      const credential = JSON.parse(await readFile(join(root, 'engine-credential.json'), 'utf8'))
      return (await fetch(address + '/api/orchestration/shell', { headers: { authorization: `Bearer ${credential.accessToken}` } })).ok
    },
  })
  try {
    await mkdir(join(root, 'project'))
    await manager.start()
    expect(manager.view().state).toBe('running')
    const projectId = await client.createProject({ title: 'Attachment proof', workspaceRoot: join(root, 'project') })
    await expect.poll(() => client.view().projects.some(project => project.id === projectId)).toBe(true)
    const model = client.view().models?.find(model => model.instanceId === 'codex')
    expect(model).toBeDefined()
    const turn = { instanceId: 'codex', model: model!.slug, effort: null, access: 'full-access' as const }
    const threadId = await client.createThread({ projectId, title: 'Attachment proof', ...turn })
    await expect.poll(() => client.view().projects.some(project => project.threads.some(thread => thread.id === threadId))).toBe(true)
    await client.openThread(threadId)
    const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII=', 'base64'))
    const staged = await client.stageAttachment({ name: 'pixel.png', mimeType: 'image/png', bytes })
    await expect(client.startTurn(threadId, { ...turn, text: 'Attachment proof', attachments: [
      { kind: 'text', name: 'notes.md', text: '# Upload proof' },
      { kind: 'image', id: staged.id, name: 'pixel.png', mimeType: 'image/png', sizeBytes: staged.sizeBytes },
    ] })).rejects.toThrow('Upload proof stops before provider dispatch')
    expect(uploads).toEqual([{ method: 'POST', status: 204 }, { method: 'POST', status: 204 }])
    expect(attachments).toEqual([
      expect.objectContaining({ type: 'file', name: 'notes.md', mimeType: 'text/markdown', sizeBytes: 14 }),
      expect.objectContaining({ type: 'image', name: 'pixel.png', mimeType: 'image/png', sizeBytes: bytes.byteLength }),
    ])
  } finally {
    await manager.stop()
    await client.shutdown()
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
