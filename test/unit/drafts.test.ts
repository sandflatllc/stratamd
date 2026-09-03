import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createDraftStore, discardDraft, holdDraft, relocateDraft } from '../../src/core/drafts'
import { readDraftStore, writeDraftStore } from '../../src/main/drafts'
import { draftCountsForHeadings } from '../../src/renderer/components/Contents'
import type { DraftView } from '../../src/shared/contracts'

describe('private held comments', () => {
  it('anchors, relocates, and discards drafts without changing their text', () => {
    const source = '# Plan\n\nAlpha target.\n'
    const from = source.indexOf('target')
    const held = holdDraft(createDraftStore(), source, {
      id: 'd_one', kind: 'comment', text: '  Tighten this.  ', quote: 'target',
      from, to: from + 6, recipients: ['thread-a', 'thread-a'], createdAt: 12,
    })
    expect(held.drafts[0]).toMatchObject({ id: 'd_one', text: 'Tighten this.', recipients: ['thread-a'] })
    expect(relocateDraft(held.drafts[0]!, `Before.\n${source}`)).toMatchObject({ status: 'attached', from: from + 8, to: from + 14 })
    expect(relocateDraft(held.drafts[0]!, source.replace('target', 'subject')).status).toBe('orphaned')
    expect(discardDraft(held, 'd_one').drafts).toEqual([])
  })

  it('writes its own atomic private file and reads it back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratamd-drafts-'))
    const path = join(directory, 'drafts.json')
    const source = 'Keep this sentence.\n'
    const store = holdDraft(createDraftStore(), source, {
      id: 'd_private', kind: 'question', text: 'Why?', quote: 'this sentence',
      from: 5, to: 18, recipients: ['thread-a'], createdAt: 14,
    })
    await writeDraftStore(path, store)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readDraftStore(path)).toEqual(store)
    expect(await readFile(path, 'utf8')).not.toContain('formatVersion": 4')
  })

  it('names the drafts file when stored data is invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratamd-drafts-invalid-'))
    const path = join(directory, 'drafts.json')
    const invalid = { formatVersion: 1 as const, drafts: [{}] }

    await expect(writeDraftStore(path, invalid as never)).rejects.toThrow(`Invalid draft: ${path}`)
  })

  it('marks the Contents section containing each draft', () => {
    const headings = [
      { id: 'h1', level: 1 as const, text: 'Plan', position: 0, sourceFrom: 0, atx: true },
      { id: 'h2', level: 2 as const, text: 'Details', position: 10, sourceFrom: 20, atx: true },
    ]
    const makeDraft = (id: string, from: number): DraftView => ({
      id, kind: 'comment', quote: 'x', prefix: '', suffix: '', text: 'Note', from, to: from + 1,
      status: 'attached', recipients: ['thread-a'], createdAt: 1,
    })
    expect([...draftCountsForHeadings(headings, [makeDraft('d_1', 5), makeDraft('d_2', 30)]).entries()]).toEqual([['h1', 1], ['h2', 1]])
  })
})
