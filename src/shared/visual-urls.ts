/** The renderer reads visual evidence and staged composer images through this main-process protocol. */
export const VISUAL_IMAGE_SCHEME = 'strata-visual'
export type VisualImageKind = 'evidence' | 'staged' | 'browser'

export function visualImageUrl(kind: VisualImageKind, id: string): string {
  return `${VISUAL_IMAGE_SCHEME}://${kind}/${encodeURIComponent(id)}`
}
