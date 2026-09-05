import { mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isStagedAttachmentId, StagedAttachmentStore } from '../../src/main/engine/staged-attachments'

async function store() {
  const directory = join(await mkdtemp(join(tmpdir(), 'strata-staged-')), 'composer-attachments')
  return { directory, store: new StagedAttachmentStore(directory, () => 1_700_000_000_000) }
}
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])

describe('StagedAttachmentStore (§6.0)', () => {
  it('stages bytes privately and reads them back with their name and type', async () => {
    const { directory, store: staged } = await store()
    const record = await staged.stage({ name: 'shot.png', mimeType: 'image/png', bytes: png })
    expect(isStagedAttachmentId(record.id)).toBe(true)
    expect(record).toMatchObject({ name: 'shot.png', mimeType: 'image/png', sizeBytes: 8, createdAt: 1_700_000_000_000 })
    expect((await stat(join(directory, `${record.id}.bin`))).mode & 0o777).toBe(0o600)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    const read = await staged.read(record.id)
    expect(read?.meta).toMatchObject({ id: record.id, name: 'shot.png', mimeType: 'image/png', sizeBytes: 8 })
    expect([...read!.bytes]).toEqual([...png])
    expect(await staged.exists(record.id)).toBe(true)
  })
  it('refuses empty bytes and ids that are not its own', async () => {
    const { store: staged } = await store()
    await expect(staged.stage({ name: 'empty.png', mimeType: 'image/png', bytes: new Uint8Array() })).rejects.toThrow('Attachment empty.png is empty')
    await expect(staged.read('../etc/passwd')).rejects.toThrow('not valid')
    await expect(staged.discard('a_not-a-uuid')).rejects.toThrow('not valid')
  })
  it('discards bytes and metadata together, and a second discard is quiet', async () => {
    const { directory, store: staged } = await store()
    const record = await staged.stage({ name: 'shot.png', mimeType: 'image/png', bytes: png })
    await staged.discard(record.id)
    expect(await readdir(directory)).toEqual([])
    expect(await staged.read(record.id)).toBeNull()
    expect(await staged.exists(record.id)).toBe(false)
    await expect(staged.discard(record.id)).resolves.toBeUndefined()
  })
  it('sweeps everything the caller does not keep', async () => {
    const { directory, store: staged } = await store()
    const kept = await staged.stage({ name: 'kept.png', mimeType: 'image/png', bytes: png })
    const gone = await staged.stage({ name: 'gone.png', mimeType: 'image/png', bytes: png })
    expect(await staged.sweep(new Set([kept.id]))).toEqual([gone.id])
    expect((await readdir(directory)).toSorted()).toEqual([`${kept.id}.bin`, `${kept.id}.json`])
    expect(await staged.sweep(new Set([kept.id]))).toEqual([])
  })
})
