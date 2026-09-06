import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../../src/main/settings'
import { GhostStore } from '../../src/main/storage'
import { attach, createStrataApplication, FakeEngine } from './support/cockpit'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stratamd-persist-cache-'))
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
  const engine = new FakeEngine()
  const app = await createStrataApplication({ store, settingsStore, engine, watch: false })
  return { root, store, engine, app }
}

async function document(root: string, name: string, content: string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, content)
  return path
}

/** The recovery invariant: everything the saved meta references exists and verifies. */
async function expectMetaBlobsPresent(store: GhostStore, path: string): Promise<void> {
  const meta = await store.loadMeta(path)
  const blobs = new Set<string>()
  for (const blob of [meta.ghostBlob, meta.diskBlob, meta.shadowBlob, meta.mirrorBlob]) {
    if (typeof blob === 'string') blobs.add(blob)
  }
  for (const blob of meta.snapshotBlobs ?? []) blobs.add(blob)
  for (const segment of meta.segments) {
    if (segment.beforeBlob) blobs.add(segment.beforeBlob)
    if (segment.afterBlob) blobs.add(segment.afterBlob)
  }
  expect(blobs.size).toBeGreaterThan(0)
  for (const blob of blobs) {
    await expect(store.getObject(blob), `blob ${blob}`).resolves.toBeDefined()
  }
}

describe('persist blob caching', () => {
  it('keeps every meta-referenced blob on disk across a long mixed session', async () => {
    const { root, store, app } = await fixture()
    const path = await document(root, 'plan.md', '# Plan\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.\n')
    await app.openDocument(path)

    let buffer = '# Plan\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.\n'
    for (let step = 0; step < 12; step += 1) {
      // Model an agent reading the acknowledged mirror, not racing the editor's debounced write.
      buffer = (await app.getState()).activeDocument!.content
      buffer = buffer.replace('Paragraph two.', `Paragraph two. Agent pass ${step}.`)
      await store.writeBuffer(path, buffer)
      await app.recheckFocused()
      const content = (await app.getState()).activeDocument!.content
      const typed = content.replace('Paragraph one.', `Paragraph one. User pass ${step}.`)
      await app.updateBuffer(path, typed)
      await expect.poll(async () => (await store.readBuffer(path))?.toString('utf8'), { timeout: 2500 }).toBe(typed)
      await app.recheckFocused()
    }
    await expectMetaBlobsPresent(store, path)

    await app.undo(path)
    await app.undo(path)
    await app.redo(path)
    await expectMetaBlobsPresent(store, path)

    await app.save(path)
    await expectMetaBlobsPresent(store, path)
  })

  it('survives garbage collection triggered by forgetting another document', async () => {
    const { root, store, app } = await fixture()
    const keep = await document(root, 'keep.md', '# Keep\n\nStable line.\n')
    const discard = await document(root, 'discard.md', '# Discard\n\nTemporary.\n')
    await app.openDocument(keep)
    await app.openDocument(discard)

    await app.updateBuffer(keep, '# Keep\n\nStable line edited.\n')
    await app.closeDocument(discard, 'discard')
    await app.forgetDocument(discard)

    // The cache was invalidated by the collection, so later persists must re-prove their blobs, including a return to earlier content via undo.
    await app.updateBuffer(keep, '# Keep\n\nStable line edited twice.\n')
    await app.undo(keep)
    await app.updateBuffer(keep, '# Keep\n\nStable line edited final.\n')
    await expectMetaBlobsPresent(store, keep)
  })

  it('keeps the snapshot set bounded across a long typing session', async () => {
    const { root, store, engine, app } = await fixture()
    const path = await document(root, 'typing.md', '# Notes\n\n')
    await app.openDocument(path)
    await attach({ app, engine, path }, 't1')

    let text = '# Notes\n\n'
    for (let step = 0; step < 120; step += 1) {
      text += step % 7 === 6 ? '\n' : String.fromCharCode(97 + (step % 26))
      await app.updateBuffer(path, text)
      // A Save every so often starts a fresh segment, as a real session does.
      if (step % 40 === 39) await app.save(path)
    }
    await app.flushPersistence(path)
    const meta = await store.loadMeta(path)
    // One user segment per round plus the current content: never a snapshot per keystroke.
    expect(meta.segments.length).toBeLessThanOrEqual(4)
    expect((meta.snapshotBlobs ?? []).length).toBeLessThanOrEqual(2 * meta.segments.length + 6)
    await expectMetaBlobsPresent(store, path)
    // Reopening from the pruned set still replays the rounds and keeps the attachment.
    await app.closeDocument(path)
    await app.openDocument(path)
    const reopened = (await app.getState()).activeDocument!
    expect(reopened.saves).toHaveLength(3)
    expect(reopened.attachments.map((attachment) => attachment.agent.id)).toEqual(['t1'])
    expect(reopened.content).toBe(text)
  })
})
