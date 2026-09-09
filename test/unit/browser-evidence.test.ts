import { boundSnapshot } from '../../src/main/preview/snapshot'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserEvidenceStore } from '../../src/main/preview/evidence'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'browser-evidence-')); directories.push(directory)
  const store = new BrowserEvidenceStore(directory, () => {})
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])
  const artifact = await store.save({ tabId: 'tab-1', threadId: 'thread-1', bytes, mimeType: 'video/webm' })
  return { store, artifact, bytes, directory }
}
describe('completed browser evidence', () => {
  it('keeps local bytes after failed transfer and retries only the same known environment', async () => {
    const { store, artifact, bytes } = await setup()
    store.setTransfer({ destination: 'remote A', upload: async () => { throw new Error('Upload refused') } })
    await expect(store.transfer(artifact.id)).rejects.toThrow('Upload refused')
    expect(store.view()[0]).toMatchObject({ status: 'failed', destination: 'remote A' })
    expect(await readFile(artifact.path)).toEqual(Buffer.from(bytes))
    store.setTransfer({ destination: 'remote B', upload: async () => 'wrong' })
    await expect(store.transfer(artifact.id)).rejects.toThrow('Reconnect to remote A')
    store.setTransfer({ destination: 'remote A', upload: async input => { expect(input.bytes).toEqual(Buffer.from(bytes)); return 'pending-upload' } })
    expect(await store.transfer(artifact.id)).toMatchObject({ status: 'saved', uploadedAttachmentId: 'pending-upload' })
  })
  it('refuses an unknown destination and deduplicates overlapping stop transfers', async () => {
    const { store, artifact } = await setup()
    await expect(store.transfer(artifact.id)).rejects.toThrow('No agent environment')
    let complete!: (id: string) => void
    let uploads = 0
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    store.setTransfer({ destination: 'local engine', upload: () => { uploads += 1; began(); return new Promise(resolve => { complete = resolve }) } })
    const first = store.transfer(artifact.id), second = store.transfer(artifact.id)
    expect(first).toBe(second)
    await started
    complete('pending-once'); await first
    await store.transfer(artifact.id)
    expect(uploads).toBe(1)
  })
})

it('bounds Unicode snapshots without cutting a retained locator', () => {
  const selector = 'body > button[data-label="' + '界'.repeat(2000) + '"]'
  const output = boundSnapshot({ url: 'https://example.test', title: 'Page', visibleText: '界'.repeat(20000), interactiveElements: Array.from({length: 200}, () => ({selector, name: 'Button'})), accessibilityTree: {name: '界'.repeat(200000)} })
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(60000)
  expect((output.interactiveElements as Array<{selector: string}>)[0]?.selector).toBe(selector)
})

it('restores the verified local copy and failed destination after restart', async () => {
  const { store, artifact, directory, bytes } = await setup()
  store.setTransfer({ destination: 'remote A', upload: async () => { throw new Error('Unavailable') } })
  await expect(store.transfer(artifact.id)).rejects.toThrow('Unavailable')
  const restored = new BrowserEvidenceStore(directory, () => {})
  await restored.restore()
  expect(restored.view()[0]).toMatchObject({ id: artifact.id, status: 'failed', destination: 'remote A' })
  expect((await restored.read(artifact.id)).bytes).toEqual(Buffer.from(bytes))
})
