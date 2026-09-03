import { readFile, rename } from 'node:fs/promises'
import type { AnnotationContext } from '../shared/contracts'
import { DRAFT_FORMAT_VERSION, createDraftStore, type Draft, type DraftStore } from '../core/drafts'
import { atomicWriteFile, isRecord, PRIVATE_FILE_MODE } from './storage'
import { logError } from './log'
import { annotationContextSchema } from './validation'

function context(value: unknown): AnnotationContext | undefined {
  return annotationContextSchema.safeParse(value).data
}

function draft(value: unknown): Draft | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^d_[a-z0-9-]+$/iu.test(value.id)) return null
  if (value.kind !== 'comment' && value.kind !== 'question' && value.kind !== 'suggestion') return null
  if (typeof value.text !== 'string' || !value.text.trim() || !isRecord(value.anchor)) return null
  const anchor = value.anchor
  if (typeof anchor.quote !== 'string' || !anchor.quote || typeof anchor.prefix !== 'string' || typeof anchor.suffix !== 'string') return null
  if (!Number.isInteger(anchor.from) || !Number.isInteger(anchor.to) || Number(anchor.from) < 0 || Number(anchor.to) < Number(anchor.from)) return null
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
    ...(annotationContext ? { context: annotationContext } : {}),
    createdAt: value.createdAt,
  }
}

export function normalizeDraftStore(value: unknown, path: string): DraftStore {
  if (!isRecord(value)) throw new Error(`Invalid draft store: ${path}`)
  if (value.formatVersion !== DRAFT_FORMAT_VERSION) throw new Error(`Unsupported draft store version ${String(value.formatVersion)}: ${path}`)
  if (!Array.isArray(value.drafts)) throw new Error(`Invalid draft list: ${path}`)
  const valid = value.drafts.map(draft)
  if (valid.some((item) => item === null)) throw new Error(`Invalid draft: ${path}`)
  return { formatVersion: DRAFT_FORMAT_VERSION, drafts: valid as Draft[] }
}

export async function readDraftStore(path: string): Promise<DraftStore> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createDraftStore()
    throw new Error(`Could not read private drafts at ${path}`, { cause: error })
  }
  try {
    return normalizeDraftStore(JSON.parse(source), path)
  } catch (error) {
    const preservedPath = `${path}.broken-${new Date().toISOString().replace(/[:.]/gu, '-')}`
    try {
      await rename(path, preservedPath)
      logError('drafts', `Private drafts could not be read; the file was kept at ${preservedPath} and an empty store applies`, error)
    } catch (renameError) {
      logError('drafts', `Private drafts could not be read and the file could not be moved aside: ${path}`, renameError)
    }
    return createDraftStore()
  }
}

export async function writeDraftStore(path: string, store: DraftStore): Promise<void> {
  const normalized = normalizeDraftStore(store, path)
  await atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
}
