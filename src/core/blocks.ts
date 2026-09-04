import { createHash } from 'node:crypto'
import { z } from 'zod'

export interface BlockAnchorMap {
  namespace: string
  blocks: Array<{ id: string; from: number; to: number; text: string }>
}

const anchor = z.union([
  z.object({ document: z.string().min(1), block: z.string().min(1) }).strict(),
  z.object({ message: z.string().min(1), block: z.string().min(1) }).strict(),
  z.object({ document: z.string().min(1), quote: z.string().min(1) }).strict(),
  z.object({ item: z.string().min(1) }).strict(),
])
const anchored = { anchor } as const
const entry = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('comment'), ...anchored, text: z.string().min(1) }).strict(),
  z.object({ verb: z.literal('question'), ...anchored, text: z.string().min(1) }).strict(),
  z.object({ verb: z.literal('decision'), ...anchored, text: z.string().min(1), options: z.array(z.string().min(1)).min(2) }).strict(),
  z.object({ verb: z.literal('suggest'), ...anchored, replacement: z.string() }).strict(),
  z.object({ verb: z.literal('edit'), ...anchored, match: z.string(), replace: z.string() }).strict(),
  z.object({ verb: z.literal('reply'), anchor: z.object({ item: z.string().min(1) }).strict(), text: z.string().min(1) }).strict(),
  z.object({ verb: z.enum(['resolve', 'accept', 'reject', 'save']), ...anchored }).strict(),
  z.object({ verb: z.literal('lead'), document: z.string().min(1), action: z.enum(['claim', 'release']) }).strict(),
  z.object({ verb: z.literal('attach'), document: z.string().min(1) }).strict(),
])
export type StrataEntry = z.infer<typeof entry>
export interface StrataBlockResult { index: number; entry?: StrataEntry; error?: string }

function shortId(namespace: string, index: number, text: string): string {
  return `b${createHash('sha256').update(`${namespace}\0${index}\0${text}`).digest('hex').slice(0, 8)}`
}

/** Stable for unchanged source blocks; ranges make the id useful to the existing anchor engine. */
export function mapMarkdownBlocks(namespace: string, source: string): BlockAnchorMap {
  const blocks: BlockAnchorMap['blocks'] = []
  const lines = source.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? []
  let offset = 0
  let start = -1
  let end = -1
  let fenced = false
  const finish = () => {
    if (start < 0) return
    const text = source.slice(start, end).replace(/\n+$/, '')
    if (!text.trim()) { start = -1; return }
    blocks.push({ id: shortId(namespace, blocks.length, text), from: start, to: start + text.length, text })
    start = -1
  }
  for (const line of lines) {
    const blank = /^\s*$/.test(line.replace(/\n$/, ''))
    if (start < 0 && !blank) start = offset
    if (start >= 0) end = offset + line.length
    if (line.startsWith('```')) {
      if (!fenced) fenced = true
      else { fenced = false; finish() }
    } else if (blank && !fenced) finish()
    offset += line.length
  }
  finish()
  return { namespace, blocks }
}

/** Reads only a final fenced strata block. Bad entries do not discard valid siblings. */
export function parseStrataBlock(message: string): { prose: string; results: StrataBlockResult[] } | null {
  const match = /(?:^|\n)```strata\s*\n([\s\S]*?)\n```\s*$/.exec(message)
  if (!match) return null
  let parsed: unknown
  try { parsed = JSON.parse(match[1]!) }
  catch (error) { return { prose: message.slice(0, match.index).trimEnd(), results: [{ index: 0, error: `Malformed JSON: ${error instanceof Error ? error.message : 'invalid value'}` }] } }
  if (!Array.isArray(parsed)) return { prose: message.slice(0, match.index).trimEnd(), results: [{ index: 0, error: 'The strata block must be a JSON array.' }] }
  return {
    prose: message.slice(0, match.index).trimEnd(),
    results: parsed.map((value, index) => {
      const decoded = entry.safeParse(value)
      return decoded.success ? { index, entry: decoded.data } : { index, error: decoded.error.issues.map((issue) => issue.message).join('; ') }
    }),
  }
}

export function resolveBlock(map: BlockAnchorMap, id: string): { from: number; to: number; text: string } | null {
  return map.blocks.find((block) => block.id === id) ?? null
}

export function blockOutcomeLines(outcomes: Array<{ index: number; status: 'applied' | 'failed'; itemId?: string; reason?: string; candidates?: string[] }>): string[] {
  return outcomes.map((outcome) => outcome.status === 'applied'
    ? `${outcome.index + 1}. applied${outcome.itemId ? ` as ${outcome.itemId}` : ''}`
    : `${outcome.index + 1}. failed: ${outcome.reason ?? 'unknown reason'}${outcome.candidates?.length ? `; nearest: ${outcome.candidates.join(' | ')}` : ''}`)
}
