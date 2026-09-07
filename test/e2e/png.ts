import { deflateSync } from 'node:zlib'

/** A decodable RGBA PNG of the given size, painted with a gradient and a seed-dependent stripe so two files never match. */
export function pngBytes(width: number, height: number, seed = 0): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 4
      const stripe = Math.floor((x + seed * 37) / 40) % 2 === 0
      raw[offset] = (x * 255 / width) & 255
      raw[offset + 1] = stripe ? 200 : (Math.floor(y * 16 / height) * 16) & 255
      raw[offset + 2] = (seed * 50) & 255
      raw[offset + 3] = 255
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

let table: Uint32Array | null = null
function crc32(bytes: Buffer): number {
  if (!table) {
    table = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = table[(crc ^ byte) & 255]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
