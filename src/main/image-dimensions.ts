/**
 * Intrinsic pixel dimensions from the leading bytes of an image file, for
 * reserving an image's box before the bytes decode. The parser is pure and
 * bounded: it reads only what it is given and answers null whenever the
 * format, the header, or the orientation is not fully understood, so the
 * caller falls back to the browser's own load-based measurement.
 *
 * Supported: PNG, JPEG (baseline and progressive), GIF, WebP (VP8, VP8L,
 * VP8X). JPEG EXIF orientation 5 through 8 swaps the reported dimensions to
 * match what the browser will lay out; an EXIF block that cannot be read, or
 * a WebP or PNG that carries EXIF, reports unknown rather than a guess.
 */
export interface ImageDimensions {
  width: number
  height: number
}

/** How many bytes a caller should read to give the parser a fair chance; JPEG metadata can exceed it. */
export const IMAGE_HEADER_BYTES = 64 * 1024

function u16be(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function u16le(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u32be(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null
  return ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!
}

function u32le(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null
  return bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16) + ((bytes[offset + 3]! << 24) >>> 0)
}

function u24le(bytes: Uint8Array, offset: number): number | null {
  if (offset + 3 > bytes.length) return null
  return bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return ''
  let text = ''
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[offset + index]!)
  return text
}

function valid(width: number | null, height: number | null): ImageDimensions | null {
  if (width === null || height === null || width <= 0 || height <= 0) return null
  return { width, height }
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (ascii(bytes, 12, 4) !== 'IHDR') return null
  const dimensions = valid(u32be(bytes, 16), u32be(bytes, 20))
  if (!dimensions) return null
  // An eXIf chunk can carry an orientation the browser honors. Walk the chunks
  // that fit in the header; one found before the image data means unknown.
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = u32be(bytes, offset)
    const type = ascii(bytes, offset + 4, 4)
    if (length === null) break
    if (type === 'eXIf') return null
    if (type === 'IEND') return dimensions
    if (offset + 12 + length > bytes.length) return null
    offset += 12 + length
  }
  return null
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
  return valid(u16le(bytes, 6), u16le(bytes, 8))
}

/** EXIF orientation from an APP1 payload, 1 when the block has no orientation tag, null when it cannot be read. */
function exifOrientation(bytes: Uint8Array, start: number, end: number): number | null {
  if (ascii(bytes, start, 6) !== 'Exif\0\0') return null
  const tiff = start + 6
  const order = ascii(bytes, tiff, 2)
  const little = order === 'II'
  if (!little && order !== 'MM') return null
  const read16 = (offset: number): number | null => offset + 2 > end ? null : little ? u16le(bytes, offset) : u16be(bytes, offset)
  const read32 = (offset: number): number | null => offset + 4 > end ? null : little ? u32le(bytes, offset) : u32be(bytes, offset)
  if (read16(tiff + 2) !== 0x2a) return null
  const ifdOffset = read32(tiff + 4)
  if (ifdOffset === null) return null
  const ifd = tiff + ifdOffset
  const count = read16(ifd)
  if (count === null) return null
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > end) return null
    const tag = read16(entry)
    if (tag !== 0x0112) continue
    const type = read16(entry + 2)
    const value = type === 3 && read32(entry + 4) === 1 ? read16(entry + 8) : null
    return value !== null && value >= 1 && value <= 8 ? value : null
  }
  return 1
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let offset = 2
  let orientation: number | null = 1
  let frame: ImageDimensions | null = null
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]!
    if (marker === 0xff) { offset += 1; continue }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue }
    if (marker === 0xda || marker === 0xd9) return frame && orientation !== null ? orientation >= 5 ? { width: frame.height, height: frame.width } : frame : null
    const length = u16be(bytes, offset + 2)
    if (length === null || length < 2) return null
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      const height = u16be(bytes, offset + 5)
      const width = u16be(bytes, offset + 7)
      const dimensions = valid(width, height)
      if (!dimensions || length < 8 || offset + 2 + length > bytes.length) return null
      frame = dimensions
    }
    if (marker === 0xe1) {
      const end = Math.min(bytes.length, offset + 2 + length)
      // Only the first Exif APP1 carries the orientation; XMP APP1 blocks are skipped.
      if (ascii(bytes, offset + 4, 6) === 'Exif\0\0') orientation = end < offset + 2 + length ? null : exifOrientation(bytes, offset + 4, end)
    }
    offset += 2 + length
  }
  return null
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    const width = u16le(bytes, 26)
    const height = u16le(bytes, 28)
    return valid(width === null ? null : width & 0x3fff, height === null ? null : height & 0x3fff)
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f || bytes.length < 25) return null
    const b1 = bytes[21]!, b2 = bytes[22]!, b3 = bytes[23]!, b4 = bytes[24]!
    return valid(1 + (b1 | ((b2 & 0x3f) << 8)), 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)))
  }
  if (chunk === 'VP8X') {
    const flags = bytes[20]
    if (flags === undefined) return null
    // An EXIF chunk may orient the picture; the load path measures that case.
    if (flags & 0x08) return null
    const width = u24le(bytes, 24)
    const height = u24le(bytes, 27)
    return valid(width === null ? null : width + 1, height === null ? null : height + 1)
  }
  return null
}

/** Dimensions from a header slice, or null for unsupported, truncated, or orientation-ambiguous input. */
export function imageDimensionsFromHeader(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return pngDimensions(bytes)
  if (bytes.length >= 10 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return gifDimensions(bytes)
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes)
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webpDimensions(bytes)
  return null
}
