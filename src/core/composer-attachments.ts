/**
 * Rules for what the conversation composer may attach (PRD §6.0): which
 * images T3 forwards to a provider, how large they may be, how many
 * attachments one turn carries, and the words both the composer and the
 * engine client use when they refuse. Pure so the renderer and the main
 * process share one answer.
 */

export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type SupportedImageType = typeof SUPPORTED_IMAGE_TYPES[number]

/** T3's per-image ceiling on a provider turn. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** Text files keep the composer's original limit. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** T3 refuses a turn carrying more; Strata's generated context file counts toward it. */
export const MAX_ATTACHMENTS = 8

const EXTENSION_TYPES: Record<string, SupportedImageType> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const TYPE_EXTENSIONS: Record<SupportedImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export function isSupportedImageType(mimeType: string): mimeType is SupportedImageType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mimeType.toLowerCase())
}

export type FileClass =
  | { kind: 'image'; mimeType: SupportedImageType }
  | { kind: 'unsupported-image'; mimeType: string }
  | { kind: 'text' }

/**
 * Drags from other apps and shell pipes hand over files with an empty or
 * generic type; the extension then decides, as in T3. A declared image type
 * outside the supported set stays an image so the refusal can name it.
 */
export function classifyFile(file: { name: string; type: string }): FileClass {
  const declared = file.type.toLowerCase()
  if (declared === '' || declared === 'application/octet-stream') {
    const dot = file.name.lastIndexOf('.')
    const inferred = dot > 0 ? EXTENSION_TYPES[file.name.slice(dot + 1).toLowerCase()] : undefined
    return inferred ? { kind: 'image', mimeType: inferred } : { kind: 'text' }
  }
  if (!declared.startsWith('image/')) return { kind: 'text' }
  return isSupportedImageType(declared) ? { kind: 'image', mimeType: declared } : { kind: 'unsupported-image', mimeType: declared }
}

/** Chromium names every pasted image `image.png`; a timestamp keeps two pastes in one turn apart. */
export function pastedImageName(mimeType: SupportedImageType, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return `pasted-image-${stamp}.${TYPE_EXTENSIONS[mimeType]}`
}

/** The user message when the owner sends attachments without a note. */
export function attachmentSummary(attachments: ReadonlyArray<{ name: string }>): string {
  if (attachments.length === 0) return ''
  return attachments.length === 1 ? `Attached ${attachments[0]!.name}.` : `Attached ${attachments.length} files.`
}

/** One sentence for the composer and the engine client, so a refusal reads the same in both places. */
export function attachmentLimitMessage(reserved: 0 | 1): string {
  return reserved
    ? `A turn carries at most ${MAX_ATTACHMENTS} attachments, and one is reserved for the queued replies and comments. Remove a file, or send the replies on their own first.`
    : `A turn carries at most ${MAX_ATTACHMENTS} attachments. Remove a file before adding another.`
}

export type AcceptedFile<File extends { name: string; size: number; type: string }> =
  | { kind: 'image'; file: File; name: string; mimeType: SupportedImageType }
  | { kind: 'text'; file: File; name: string }

export interface AcceptFilesResult<File extends { name: string; size: number; type: string }> {
  accepted: AcceptedFile<File>[]
  /** The first refusal; later ones would repeat it. */
  refusal?: string
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

/**
 * Applies the count and size rules to files the owner pasted or picked.
 * `reserved` is 1 when the send will add Strata's context file. Pasted
 * images arrive with Chromium's generic name and `pasted` renames them.
 */
export function acceptFiles<File extends { name: string; size: number; type: string }>(
  currentCount: number,
  files: readonly File[],
  reserved: 0 | 1,
  options: { pasted?: boolean; now?: Date } = {},
): AcceptFilesResult<File> {
  const accepted: AcceptedFile<File>[] = []
  let refusal: string | undefined
  const refuse = (message: string) => { refusal ??= message }
  for (const file of files) {
    const classification = classifyFile(file)
    if (classification.kind === 'unsupported-image') { refuse(`${file.name} is a ${classification.mimeType} image. Attach a PNG, JPEG, GIF, or WebP image.`); continue }
    if (classification.kind === 'image' && file.size > MAX_IMAGE_BYTES) { refuse(`Image ${file.name} is larger than the ${megabytes(MAX_IMAGE_BYTES)} limit.`); continue }
    if (classification.kind === 'text' && file.size > MAX_TEXT_BYTES) { refuse(`File ${file.name} exceeds the ${megabytes(MAX_TEXT_BYTES)} attachment limit.`); continue }
    if (file.size === 0) { refuse(`${file.name} is empty.`); continue }
    if (currentCount + accepted.length + reserved >= MAX_ATTACHMENTS) { refuse(attachmentLimitMessage(reserved)); continue }
    if (classification.kind === 'image') {
      const name = options.pasted ? pastedImageName(classification.mimeType, options.now ?? new Date()) : file.name
      accepted.push({ kind: 'image', file, name, mimeType: classification.mimeType })
    } else accepted.push({ kind: 'text', file, name: file.name })
  }
  return refusal ? { accepted, refusal } : { accepted }
}
