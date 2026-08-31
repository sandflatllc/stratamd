import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createStrataApplication, type StrataApplication } from '../../src/main/application'
import { SettingsStore } from '../../src/main/settings'
import { GhostStore } from '../../src/main/storage'

const applications: StrataApplication[] = []

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.shutdown()))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stratamd-persist-cache-'))
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
  const app = await createStrataApplication({ store, settingsStore, watch: false })
  applications.push(app)
  return { root, store, app }
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
      buffer = buffer.replace('Paragraph two.', `Paragraph two. Agent pass ${step}.`)
      await store.writeBuffer(path, buffer)
      await app.recheckFocused()
      const content = (await app.getState()).activeDocument!.content
      const typed = content.replace('Paragraph one.', `Paragraph one. User pass ${step}.`)
      await app.updateBuffer(path, typed)
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

    // The cache was invalidated by the collection, so later persists must
    // re-prove their blobs, including a return to earlier content via undo.
    await app.updateBuffer(keep, '# Keep\n\nStable line edited twice.\n')
    await app.undo(keep)
    await app.updateBuffer(keep, '# Keep\n\nStable line edited final.\n')
    await expectMetaBlobsPresent(store, keep)
  })
})
