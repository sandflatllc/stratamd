import { z } from 'zod'

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
const name = z.string().min(1).max(512)
export const documentSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('staged'), id: name, name }).strict(),
  z.object({ kind: z.literal('attachment'), id: name, threadId: name, name }).strict(),
])
export type DocumentSource = z.infer<typeof documentSourceSchema>
export interface DocumentPreviewData { id: string; name: string; kind: 'pdf' | 'html'; bytes: Uint8Array }
export interface DocumentBounds { id: string | null; bounds: { x: number; y: number; width: number; height: number } | null }
export function documentKind(name: string): 'pdf' | 'html' | null {
  return /\.pdf$/i.test(name) ? 'pdf' : /\.html?$/i.test(name) ? 'html' : null
}
