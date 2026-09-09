import { describe, expect, it } from 'vitest'
import { acceptFiles, attachmentLimitMessage, attachmentSummary, classifyFile, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, pastedImageName } from '../../src/core/composer-attachments'

const file = (name: string, type: string, size = 10) => ({ name, type, size })

describe('classifyFile (§6.0)', () => {
  it('trusts a supported browser type and keeps other image types as unsupported images', () => {
    expect(classifyFile(file('shot.png', 'image/png'))).toEqual({ kind: 'image', mimeType: 'image/png' })
    expect(classifyFile(file('photo.JPG', 'IMAGE/JPEG'))).toEqual({ kind: 'image', mimeType: 'image/jpeg' })
    expect(classifyFile(file('logo.svg', 'image/svg+xml'))).toEqual({ kind: 'unsupported-image', mimeType: 'image/svg+xml' })
    expect(classifyFile(file('notes.md', 'text/markdown'))).toEqual({ kind: 'text' })
  })
  it('infers the type from the extension when the browser hands over none', () => {
    expect(classifyFile(file('photo.jpeg', ''))).toEqual({ kind: 'image', mimeType: 'image/jpeg' })
    expect(classifyFile(file('anim.GIF', 'application/octet-stream'))).toEqual({ kind: 'image', mimeType: 'image/gif' })
    expect(classifyFile(file('data.bin', 'application/octet-stream'))).toEqual({ kind: 'binary', mimeType: 'application/octet-stream' })
    expect(classifyFile(file('noext', ''))).toEqual({ kind: 'binary', mimeType: 'application/octet-stream' })
  })
})

describe('pastedImageName', () => {
  it('stamps the local time and picks the extension for the type', () => {
    expect(pastedImageName('image/png', new Date(2026, 8, 5, 14, 3, 7))).toBe('pasted-image-2026-09-05-14-03-07.png')
    expect(pastedImageName('image/jpeg', new Date(2026, 0, 1, 0, 0, 0))).toBe('pasted-image-2026-01-01-00-00-00.jpg')
  })
})

describe('attachmentSummary', () => {
  it('names one file and counts more', () => {
    expect(attachmentSummary([])).toBe('')
    expect(attachmentSummary([{ name: 'shot.png' }])).toBe('Attached shot.png.')
    expect(attachmentSummary([{ name: 'a.png' }, { name: 'b.md' }])).toBe('Attached 2 files.')
  })
})

describe('acceptFiles', () => {
  it('accepts images and text files, renaming pasted images', () => {
    const result = acceptFiles(0, [file('image.png', 'image/png'), file('notes.md', 'text/markdown')], 0, { pasted: true, now: new Date(2026, 8, 5, 9, 0, 0) })
    expect(result.refusal).toBeUndefined()
    expect(result.accepted).toMatchObject([{ kind: 'image', name: 'pasted-image-2026-09-05-09-00-00.png', mimeType: 'image/png' }, { kind: 'text', name: 'notes.md' }])
  })
  it('keeps a picked image name', () => {
    expect(acceptFiles(0, [file('diagram.webp', 'image/webp')], 0).accepted).toMatchObject([{ kind: 'image', name: 'diagram.webp' }])
  })
  it('refuses unsupported images, oversized files, and empty files, naming each', () => {
    expect(acceptFiles(0, [file('logo.svg', 'image/svg+xml')], 0).refusal).toBe('logo.svg is a image/svg+xml image. Attach a PNG, JPEG, GIF, or WebP image.')
    expect(acceptFiles(0, [file('big.png', 'image/png', MAX_IMAGE_BYTES + 1)], 0).refusal).toBe('Image big.png is larger than the 10 MB limit.')
    expect(acceptFiles(0, [file('big.md', 'text/markdown', MAX_TEXT_BYTES + 1)], 0).refusal).toBe('File big.md exceeds the 2 MB attachment limit.')
    expect(acceptFiles(0, [file('empty.png', 'image/png', 0)], 0).refusal).toBe('empty.png is empty.')
    expect(acceptFiles(0, [file('big.png', 'image/png', MAX_IMAGE_BYTES)], 0).refusal).toBeUndefined()
  })
  it('stops at the turn limit and reports only the first refusal', () => {
    const files = Array.from({ length: 10 }, (_, index) => file(`shot-${index}.png`, 'image/png'))
    const result = acceptFiles(0, files, 0)
    expect(result.accepted).toHaveLength(MAX_ATTACHMENTS)
    expect(result.refusal).toBe(attachmentLimitMessage(0))
  })
  it('reserves a slot for the context file when replies or comments ride along', () => {
    const files = Array.from({ length: 8 }, (_, index) => file(`shot-${index}.png`, 'image/png'))
    const result = acceptFiles(0, files, 1)
    expect(result.accepted).toHaveLength(7)
    expect(result.refusal).toBe(attachmentLimitMessage(1))
    expect(result.refusal).toContain('one is reserved for the queued replies and comments')
    expect(acceptFiles(7, [file('one-more.png', 'image/png')], 1).accepted).toHaveLength(0)
    expect(acceptFiles(7, [file('one-more.png', 'image/png')], 0).accepted).toHaveLength(1)
  })
})

it('accepts original binary MIME types to 50 MB, retaining the generated context slot', () => {
  const files = [file('report.pdf', 'application/pdf', 50 * 1024 * 1024), file('export.zip', 'application/zip')]
  expect(acceptFiles(0, files, 1).accepted).toMatchObject([{ kind: 'binary', mimeType: 'application/pdf' }, { kind: 'binary', mimeType: 'application/zip' }])
  expect(acceptFiles(0, [file('too-large.zip', 'application/zip', 50 * 1024 * 1024 + 1)], 0).refusal).toContain('too-large.zip exceeds the 50 MB')
  expect(acceptFiles(7, files, 1).accepted).toHaveLength(0)
  expect(classifyFile(file('report.pdf', ''))).toEqual({ kind: 'binary', mimeType: 'application/pdf' })
})
