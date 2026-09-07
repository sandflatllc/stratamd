import { describe, expect, it } from 'vitest'
import { imageDimensionsFromHeader } from '../../src/main/image-dimensions'

function png(width: number, height: number, extraChunk?: string): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
  const be = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
  const ihdr = [...be(width), ...be(height), 8, 6, 0, 0, 0, 0, 0, 0, 0]
  const chunk = extraChunk ? [0, 0, 0, 0, ...extraChunk.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0] : []
  const idat = [0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0]
  return Uint8Array.from([...header, ...ihdr, ...chunk, ...idat])
}

function jpeg(width: number, height: number, options: { orientation?: number; progressive?: boolean; brokenExif?: boolean; padding?: number } = {}): Uint8Array {
  const bytes: number[] = [0xff, 0xd8]
  if (options.orientation !== undefined || options.brokenExif) {
    const tiff = options.brokenExif ? [0x4d, 0x4d, 0, 0x2b] : [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, options.orientation ?? 1, 0, 0, 0, 0, 0, 0]
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
    const length = payload.length + 2
    bytes.push(0xff, 0xe1, (length >> 8) & 255, length & 255, ...payload)
  }
  if (options.padding) {
    const length = options.padding + 2
    bytes.push(0xff, 0xe2, (length >> 8) & 255, length & 255, ...new Array<number>(options.padding).fill(0))
  }
  bytes.push(0xff, 0xc4, 0, 4, 0, 0)
  bytes.push(0xff, options.progressive ? 0xc2 : 0xc0, 0, 17, 8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1)
  bytes.push(0xff, 0xda)
  return Uint8Array.from(bytes)
}

function gif(width: number, height: number): Uint8Array {
  return Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 255, width >> 8, height & 255, height >> 8, 0, 0, 0])
}

function riff(chunk: string, payload: number[]): Uint8Array {
  const text = (value: string) => value.split('').map((c) => c.charCodeAt(0))
  return Uint8Array.from([...text('RIFF'), 0, 0, 0, 0, ...text('WEBP'), ...text(chunk), 0, 0, 0, 0, ...payload])
}

describe('image header dimensions', () => {
  it('reads PNG, GIF, and JPEG headers', () => {
    expect(imageDimensionsFromHeader(png(1200, 800))).toEqual({ width: 1200, height: 800 })
    expect(imageDimensionsFromHeader(gif(320, 200))).toEqual({ width: 320, height: 200 })
    expect(imageDimensionsFromHeader(jpeg(640, 480))).toEqual({ width: 640, height: 480 })
    expect(imageDimensionsFromHeader(jpeg(640, 480, { progressive: true }))).toEqual({ width: 640, height: 480 })
  })

  it('reads the three WebP layouts and refuses an extended file that carries EXIF', () => {
    expect(imageDimensionsFromHeader(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0x58, 0x02]))).toEqual({ width: 800, height: 600 })
    // VP8L: 1-bit signature then 14-bit width-1 and height-1 packed little-endian.
    const width = 640 - 1, height = 360 - 1
    const b1 = width & 255, b2 = ((width >> 8) & 0x3f) | ((height & 3) << 6), b3 = (height >> 2) & 255, b4 = (height >> 10) & 0x0f
    expect(imageDimensionsFromHeader(riff('VP8L', [0x2f, b1, b2, b3, b4]))).toEqual({ width: 640, height: 360 })
    expect(imageDimensionsFromHeader(riff('VP8X', [0x10, 0, 0, 0, 0xff, 0x03, 0, 0x57, 0x02, 0]))).toEqual({ width: 1024, height: 600 })
    expect(imageDimensionsFromHeader(riff('VP8X', [0x08, 0, 0, 0, 0xff, 0x03, 0, 0x57, 0x02, 0]))).toBeNull()
  })

  it('swaps JPEG dimensions for rotated EXIF orientations and refuses unreadable EXIF', () => {
    expect(imageDimensionsFromHeader(jpeg(640, 480, { orientation: 1 }))).toEqual({ width: 640, height: 480 })
    expect(imageDimensionsFromHeader(jpeg(640, 480, { orientation: 3 }))).toEqual({ width: 640, height: 480 })
    expect(imageDimensionsFromHeader(jpeg(640, 480, { orientation: 6 }))).toEqual({ width: 480, height: 640 })
    expect(imageDimensionsFromHeader(jpeg(640, 480, { orientation: 8 }))).toEqual({ width: 480, height: 640 })
    expect(imageDimensionsFromHeader(jpeg(640, 480, { brokenExif: true }))).toBeNull()
  })

  it('answers unknown for truncated headers, metadata beyond the read, PNG EXIF, and other formats', () => {
    expect(imageDimensionsFromHeader(png(1200, 800).subarray(0, 20))).toBeNull()
    expect(imageDimensionsFromHeader(jpeg(640, 480, { padding: 3000 }).subarray(0, 2000))).toBeNull()
    expect(imageDimensionsFromHeader(png(10, 10, 'eXIf'))).toBeNull()
    expect(imageDimensionsFromHeader(Uint8Array.from([0x42, 0x4d, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]))).toBeNull()
    expect(imageDimensionsFromHeader(new Uint8Array(0))).toBeNull()
    expect(imageDimensionsFromHeader(png(0, 800))).toBeNull()
    // Orientation metadata can follow image data. A bounded read that cannot
    // inspect it must leave sizing to the browser.
    expect(imageDimensionsFromHeader(png(1200, 800).subarray(0, 40))).toBeNull()
    expect(imageDimensionsFromHeader(jpeg(640, 480).subarray(0, 16))).toBeNull()
  })
})
