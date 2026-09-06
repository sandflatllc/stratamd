import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { GhostStore } from '../../src/main/storage'
import { captureStrataEngine, restoreStrataEngine, documentBinding } from '../../src/main/engine/strata-backup'
import { StagedAttachmentStore } from '../../src/main/engine/staged-attachments'
import { connectionDirectory } from '../../src/main/engine/identity'

it('restores matching engine records and attachment payloads while preserving newer Markdown and review metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-state-backup-'))
  try {
    const store = new GhostStore({ dataDirectory: join(root, 'data') })
    await store.initialize()
    const path = join(root, 'notes.md'); await writeFile(path, '# Old text\n')
    let meta = await store.createDocument(path, '# Old text\n')
    const baseline = await store.putObject('original conversation baseline')
    const binding = { attachments: { old: { baselineBlob: baseline, segmentIndex: 0, cursor: 0, deliveries: [] } }, leadAgentId: 'old' }
    meta = await store.saveMeta({ ...meta, engineIdentity: 'engine-proof', ...binding })
    const directory = await connectionDirectory(store.dataDirectory, 'engine-proof')
    await writeFile(join(directory, 'engine-commands.json'), JSON.stringify([]))
    await writeFile(join(directory, 'engine-accounts.json'), JSON.stringify({ preserved: 'original' }))
    await captureStrataEngine(store, 'engine-proof', join(root, 'backup'))
    const images = new StagedAttachmentStore(join(directory, 'composer-attachments'), Date.now)
    const image = await images.stage({ name: 'new.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) })
    await writeFile(path, '# Newer text stays\n')
    await store.writeBuffer(path, '# Unsent editor text stays\n')
    await store.saveMeta({ ...meta, attachments: {}, leadAgentId: null, sourceMode: true })
    await store.collectGarbage()
    await writeFile(join(directory, 'engine-commands.json'), JSON.stringify([{ dangerous: 'newer send' }]))
    await restoreStrataEngine(store, join(root, 'backup'), async (current, saved, identity, archived) => {
      await store.saveMeta({ ...current, ...saved, engineAttachments: { ...current.engineAttachments, [archived]: documentBinding(current, identity) } })
    })
    expect((await store.loadMeta(path)).attachments).toEqual(binding.attachments)
    expect((await store.loadMeta(path)).sourceMode).toBe(true)
    expect(await images.exists(image.id)).toBe(true)
    expect(await store.getObjectText(baseline)).toBe('original conversation baseline')
    expect(await readFile(path, 'utf8')).toBe('# Newer text stays\n')
    expect((await store.readBuffer(path))?.toString()).toBe('# Unsent editor text stays\n')
    expect(JSON.parse(await readFile(join(directory, 'engine-commands.json'), 'utf8'))).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
