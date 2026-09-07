/** Browser-only bitmap composition, also run in an isolated Electron renderer.
 * Keep this function self-contained so the main process can serialize it.
 */
export interface CommentSheetInput {
  image: string
  text: string
  labels: string[]
  adjustments: string[]
  requested: boolean
}

export async function paintCommentSheet(input: CommentSheetInput): Promise<{ dataUrl: string; width: number; height: number }> {
  const image = new Image()
  image.src = input.image
  // A DOMException from decode() does not survive the trip to the main process; a plain Error carries its sentence.
  try { await image.decode() } catch { throw new Error('The capture image could not be read. Capture or attach it again.') }
  const width = image.naturalWidth, height = image.naturalHeight
  const below = width >= 1600 || width / height >= 2.3
  const noteWidth = below ? Math.max(480, width) : Math.max(400, Math.min(600, Math.round(width * .4)))
  const fontSize = below ? Math.max(22, Math.min(36, Math.round(width / 55))) : 24
  const padding = fontSize * 1.25, lineHeight = fontSize * 1.5
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The comment image could not be drawn')
  context.font = `${fontSize}px sans-serif`
  const available = noteWidth - padding * 2
  // Preserve paragraphs and break oversized words by grapheme, never by UTF-16 unit.
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const wrap = (text: string): string[] => text.split(/\r?\n/).flatMap(paragraph => {
    const lines: string[] = []
    let line = ''
    for (const word of paragraph.split(/(\s+)/)) {
      if (context.measureText(line + word).width <= available) { line += word; continue }
      if (line.trim()) { lines.push(line.trimEnd()); line = '' }
      for (const { segment } of graphemes.segment(word.trimStart())) {
        if (context.measureText(line + segment).width > available && line) { lines.push(line); line = '' }
        line += segment
      }
    }
    lines.push(line.trimEnd())
    return lines
  })
  const rows = [
    { text: input.requested ? 'Requested appearance' : 'Visual comment', heading: true },
    ...(input.labels.length ? [{ text: input.labels.join(' · '), heading: false }] : []),
    { text: '', heading: false },
    { text: input.text.trim() || 'See the marked areas.', heading: false },
    ...(input.adjustments.length ? [{ text: '', heading: false }, { text: 'Requested changes', heading: true }, ...input.adjustments.map(text => ({ text, heading: false }))] : []),
  ].flatMap(row => {
    context.font = `${row.heading ? '700 ' : ''}${fontSize}px sans-serif`
    return wrap(row.text).map(text => ({ text, heading: row.heading }))
  })
  const noteHeight = Math.ceil(padding * 2 + rows.length * lineHeight)
  const outputWidth = below ? Math.max(width, noteWidth) : width + noteWidth
  const outputHeight = below ? height + noteHeight : Math.max(height, noteHeight)
  if (outputWidth > 16384 || outputHeight > 16384 || outputWidth * outputHeight > 32_000_000) {
    throw new Error('This screenshot and comment are too large for one image. Use a smaller screenshot or split the comment before sending.')
  }
  canvas.width = outputWidth
  canvas.height = outputHeight
  context.fillStyle = '#111318'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0)
  const x = below ? 0 : width, y = below ? height : 0
  context.fillStyle = '#f5f6f8'
  context.fillRect(x, y, canvas.width - x, canvas.height - y)
  context.fillStyle = '#191c24'
  context.textBaseline = 'top'
  rows.forEach((row, index) => {
    context.font = `${row.heading ? '700 ' : ''}${fontSize}px sans-serif`
    context.fillText(row.text, x + padding, y + padding + index * lineHeight)
  })
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
}
