import { readFile } from 'node:fs/promises'
import type { AnnotationContext } from '../shared/contracts'
import { DRAFT_FORMAT_VERSION, createDraftStore, type Draft, type DraftStore } from '../core/drafts'
import { atomicWriteFile, PRIVATE_FILE_MODE } from './storage'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function context(value: unknown): AnnotationContext | undefined {
  if (!record(value)) return undefined
  if (value.kind === 'screenshot-pin'
    && value.component === 'AnnotatedScreenshot'
    && Number.isInteger(value.componentLine)
    && typeof value.image === 'string'
    && Number.isInteger(value.pin)) return value as unknown as AnnotationContext
  if ((value.kind === 'table-row' || value.kind === 'table-cell')
    && (typeof value.heading === 'string' || value.heading === null)
    && Array.isArray(value.columns)
    && value.columns.every((item) => typeof item === 'string')
    && (value.column === null || (record(value.column)
      && Number.isInteger(value.column.index)
      && Number(value.column.index) >= 0
      && typeof value.column.label === 'string'))) return value as unknown as AnnotationContext
  return undefined
}

function draft(value: unknown): Draft | null {
  if (!record(value) || typeof value.id !== 'string' || !/^d_[a-z0-9-]+$/iu.test(value.id)) return null
  if (value.kind !== 'comment' && value.kind !== 'question' && value.kind !== 'suggestion') return null
  if (typeof value.text !== 'string' || !value.text.trim() || !record(value.anchor)) return null
  const anchor = value.anchor
  if (typeof anchor.quote !== 'string' || !anchor.quote || typeof anchor.prefix !== 'string' || typeof anchor.suffix !== 'string') return null
  if (!Number.isInteger(anchor.from) || !Number.isInteger(anchor.to) || Number(anchor.from) < 0 || Number(anchor.to) < Number(anchor.from)) return null
  if (!Array.isArray(value.recipients) || !value.recipients.every((item) => typeof item === 'string')) return null
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null
  const annotationContext = context(value.context)
  return {
    id: value.id.slice(0, 512),
    kind: value.kind,
    text: value.text.slice(0, 64 * 1_024),
    anchor: {
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
      from: Number(anchor.from),
      to: Number(anchor.to),
    },
    recipients: [...new Set(value.recipients.slice(0, 128).map((item) => item.slice(0, 512)))],
    ...(annotationContext ? { context: annotationContext } : {}),
    createdAt: value.createdAt,
  }
}

export function normalizeDraftStore(value: unknown): DraftStore {
  if (!record(value)) throw new Error('Invalid draft store')
  if (value.formatVersion !== DRAFT_FORMAT_VERSION) throw new Error(`Unsupported draft store version ${String(value.formatVersion)}`)
  if (!Array.isArray(value.drafts)) throw new Error('Invalid draft list')
  const valid = value.drafts.map(draft)
  if (valid.some((item) => item === null)) throw new Error('Invalid draft')
  return { formatVersion: DRAFT_FORMAT_VERSION, drafts: valid as Draft[] }
}

export async function readDraftStore(path: string): Promise<DraftStore> {
  try {
    return normalizeDraftStore(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createDraftStore()
    throw new Error(`Could not read private drafts at ${path}`, { cause: error })
  }
}

export async function writeDraftStore(path: string, store: DraftStore): Promise<void> {
  const normalized = normalizeDraftStore(store)
  await atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
}
