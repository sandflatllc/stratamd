import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { atomicWriteFile, PRIVATE_FILE_MODE } from '../storage'
import type { VisualCommentRecord } from '../../core/visual-comments'

/**
 * The visual comment store (docs/plans/open/visual-review): one record per
 * comment, owned by a project, in its own file beside the conversation store.
 * The engine identity field is reserved beside every thread reference so a
 * second paired engine can never claim another's threads.
 */
export interface VisualCommentsStore {
  formatVersion: 1
  comments: Record<string, VisualCommentRecord>
}

const point = z.object({ x: z.number(), y: z.number() }).strict()
const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict()
const identity = z.object({
  role: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  testIds: z.array(z.string()).optional(),
  selector: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  style: z.record(z.string(), z.string()).optional(),
  sources: z.array(z.object({ file: z.string(), line: z.number().int(), column: z.number().int(), role: z.enum(['definition', 'usage', 'candidate']).optional() })).optional(),
  viewportRect: rect.optional(),
  pageRect: rect.optional(),
})
const mark = z.object({ id: z.string().min(1), kind: z.enum(['element', 'region']), label: z.string(), captureId: z.string().min(1), rect, found: z.boolean().nullable(), identity: identity.optional() })
const stroke = z.object({ id: z.string().min(1), tool: z.enum(['draw', 'arrow']), captureId: z.string().min(1), points: z.array(point) })
const adjustment = z.object({ markId: z.string().min(1), property: z.string().min(1), value: z.string(), label: z.string() })
const destination = z.object({ threadId: z.string().min(1), engine: z.string().nullable() })
const capture = z.object({ id: z.string().min(1), width: z.number().positive(), height: z.number().positive(), scroll: point.optional(), scale: z.number().positive().optional(), requested: z.boolean().optional(), markedId: z.string().optional(), takenAt: z.number() })
const anchor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), name: z.string() }),
  z.object({ kind: z.literal('page'), url: z.string(), title: z.string(), instance: z.string(), workingFolder: z.string().nullable(), viewport: z.object({ width: z.number(), height: z.number(), preset: z.string().nullable() }), deviceScale: z.number() }),
])
const draft = z.object({ text: z.string(), marks: z.array(mark), strokes: z.array(stroke), adjustments: z.array(adjustment), destination, updatedAt: z.number() })
const reply = z.object({ messageId: z.string().min(1), text: z.string(), ready: z.boolean(), file: z.string().optional(), at: z.number() })
const comparison = z.object({ thenId: z.string(), nowId: z.string().nullable(), note: z.string().nullable(), takenAt: z.number() })
const revision = z.object({
  number: z.number().int().positive(), text: z.string(), marks: z.array(mark), strokes: z.array(stroke), adjustments: z.array(adjustment), destination,
  captures: z.array(z.string()), evidence: z.array(z.string()), deliveryId: z.string().min(1), sentAt: z.number(),
  state: z.enum(['sending', 'sent', 'failed']), error: z.string().optional(), replies: z.array(reply), accepted: z.boolean().optional(), comparison: comparison.optional(),
})
export const visualCommentRecord = z.object({
  id: z.string().regex(/^v_/u), projectId: z.string().min(1), engine: z.string().nullable(), anchor, captures: z.array(capture),
  draft: draft.nullable(), revisions: z.array(revision), createdAt: z.number(), updatedAt: z.number(),
})

export function emptyVisualCommentsStore(): VisualCommentsStore {
  return { formatVersion: 1, comments: {} }
}

export function normalizeVisualCommentsStore(value: unknown): VisualCommentsStore {
  const store = emptyVisualCommentsStore()
  if (!value || typeof value !== 'object' || (value as { formatVersion?: unknown }).formatVersion !== 1) return store
  const comments = (value as { comments?: unknown }).comments
  if (!comments || typeof comments !== 'object') return store
  for (const [id, raw] of Object.entries(comments as Record<string, unknown>)) {
    const parsed = visualCommentRecord.safeParse(raw)
    if (parsed.success && parsed.data.id === id) store.comments[id] = parsed.data as VisualCommentRecord
  }
  return store
}

export async function readVisualCommentsStore(path: string): Promise<VisualCommentsStore> {
  try { return normalizeVisualCommentsStore(JSON.parse(await readFile(path, 'utf8'))) } catch { return emptyVisualCommentsStore() }
}

export async function writeVisualCommentsStore(path: string, store: VisualCommentsStore): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
}

/** Every evidence id any comment still references: captures, marked captures, delivered evidence, and comparisons. */
export function referencedEvidence(store: VisualCommentsStore): Set<string> {
  const ids = new Set<string>()
  for (const comment of Object.values(store.comments)) {
    for (const capture of comment.captures) { ids.add(capture.id); if (capture.markedId) ids.add(capture.markedId) }
    for (const revision of comment.revisions) {
      for (const id of revision.evidence) ids.add(id)
      if (revision.comparison) { ids.add(revision.comparison.thenId); if (revision.comparison.nowId) ids.add(revision.comparison.nowId) }
    }
  }
  return ids
}
