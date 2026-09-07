import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readVisualCommentsStore, referencedEvidence, writeVisualCommentsStore } from '../../src/main/engine/visual-comments'
import { VisualEvidenceStore } from '../../src/main/engine/visual-evidence'

it.each(['{', '{"formatVersion":2,"comments":{}}', '{"formatVersion":1,"comments":{"v_bad":{}}}', 'missing', 'directory'])('preserves bytes and images when comment inventory is incomplete: %s', async input => {
  const root = await mkdtemp(join(tmpdir(), 'strata-evidence-safety-'))
  const path = join(root, 'comments.json'), evidence = new VisualEvidenceStore(join(root, 'images'))
  try {
    const image = await evidence.put({ bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1 })
    if (input === 'directory') await mkdir(path)
    else if (input !== 'missing') await writeFile(path, input)
    const store = await readVisualCommentsStore(path, evidence.directory)
    expect(store.readProblem).toContain(path)
    expect(await evidence.sweep(referencedEvidence(store))).toEqual([])
    await expect(writeVisualCommentsStore(path, store)).rejects.toThrow('original store and images were kept')
    expect(await evidence.exists(image.id)).toBe(true)
    if (!['directory', 'missing'].includes(input)) expect(await readFile(path, 'utf8')).toBe(input)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps unfinished session captures after another comment is discarded and after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-capture-ownership-'))
  try {
    const evidence = new VisualEvidenceStore(root)
    const active = await evidence.put({ bytes: new Uint8Array([1]), width: 1, height: 1, protected: true })
    const discarded = await evidence.put({ bytes: new Uint8Array([2]), width: 1, height: 1 })
    expect(await new VisualEvidenceStore(root).sweep(new Set())).toEqual([discarded.id])
    expect(await evidence.exists(active.id)).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('releases evidence only after its last durable session owner releases it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-two-owners-'))
  try {
    const store = new VisualEvidenceStore(root)
    const capture = await store.put({ bytes: new Uint8Array([9]), width: 1, height: 1, protected: true })
    await store.retainOwner('one', [capture.id]); await store.retainOwner('two', [capture.id])
    await store.retainOwner('one', [])
    const restarted = new VisualEvidenceStore(root)
    expect(await restarted.sweep(new Set())).toEqual([])
    expect(await restarted.exists(capture.id)).toBe(true)
    await restarted.retainOwner('two', [])
    expect(await restarted.sweep(new Set())).toEqual([capture.id])
  } finally { await rm(root, { recursive: true, force: true }) }
})
