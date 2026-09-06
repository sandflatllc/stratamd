import type { VisualMarkView, VisualPointView, VisualRectView, VisualStrokeView } from '../shared/contracts'

/**
 * Drawing for visual comments (docs/plans/open/visual-review): the same
 * routines paint the session overlay and bake the marks into the capture
 * that travels to the agent, so what the owner saw is what the agent gets.
 * The colors are the active theme's control tokens (PRD §6.13), read at paint
 * time; named colors stand in only when no theme is loaded.
 */
function themeColor(name: string, fallback: string): string {
  const source = document.querySelector('.app-shell') ?? document.documentElement
  return getComputedStyle(source).getPropertyValue(name).trim() || fallback
}

export function markColors(): { element: string; region: string; stroke: string; label: string; regionLabel: string } {
  return {
    element: themeColor('--controls-primary', 'mediumpurple'),
    region: themeColor('--controls-danger', 'hotpink'),
    stroke: themeColor('--controls-danger', 'hotpink'),
    label: themeColor('--controls-primary-text', 'black'),
    regionLabel: themeColor('--controls-danger-text', 'black'),
  }
}
const STROKE_WIDTH = 4
const ARROW_HEAD = 16
const LABEL_FONT = 600
/** A click without a drag marks a small square around the point. */
export const CLICK_MARK_SIZE = 40
/** Pointer travel below this is a click, not a box. */
export const DRAG_THRESHOLD = 4

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    // The visual protocol answers with CORS headers so the bitmap can be drawn and exported.
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The image could not be decoded'))
    image.src = url
  })
}

export function clampRect(rect: VisualRectView, width: number, height: number): VisualRectView {
  const x = Math.max(0, Math.min(width, rect.x))
  const y = Math.max(0, Math.min(height, rect.y))
  return { x, y, width: Math.max(1, Math.min(width - x, rect.width)), height: Math.max(1, Math.min(height - y, rect.height)) }
}

export function rectFromPoints(from: VisualPointView, to: VisualPointView): VisualRectView {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) }
}

export function rectContains(rect: VisualRectView, point: VisualPointView): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

function segmentDistance(point: VisualPointView, from: VisualPointView, to: VisualPointView): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = dx * dx + dy * dy
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length))
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy))
}

/** Whether a point lies within `tolerance` of a stroke, for Erase. */
export function strokeHit(stroke: Pick<VisualStrokeView, 'tool' | 'points'>, point: VisualPointView, tolerance: number): boolean {
  const points = stroke.tool === 'arrow' ? [stroke.points[0], stroke.points.at(-1)].filter((value): value is VisualPointView => value !== undefined) : stroke.points
  if (points.length === 1) return Math.hypot(points[0]!.x - point.x, points[0]!.y - point.y) <= tolerance
  for (let index = 1; index < points.length; index += 1) if (segmentDistance(point, points[index - 1]!, points[index]!) <= tolerance) return true
  return false
}

export function strokeExtent(points: readonly VisualPointView[]): number {
  const first = points[0]
  if (!first) return 0
  let extent = 0
  for (const point of points) extent = Math.max(extent, Math.hypot(point.x - first.x, point.y - first.y))
  return extent
}

/** The SVG path for a stroke, in capture pixels. */
export function strokePath(stroke: Pick<VisualStrokeView, 'tool' | 'points'>): string {
  const points = stroke.tool === 'arrow' ? [stroke.points[0], stroke.points.at(-1)].filter((value): value is VisualPointView => value !== undefined) : stroke.points
  if (points.length === 0) return ''
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
}

/** The arrow head as a path, in capture pixels. */
export function arrowHeadPath(stroke: Pick<VisualStrokeView, 'points'>, size = ARROW_HEAD): string {
  const from = stroke.points[0]
  const to = stroke.points.at(-1)
  if (!from || !to) return ''
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const left = { x: to.x - size * Math.cos(angle - Math.PI / 6), y: to.y - size * Math.sin(angle - Math.PI / 6) }
  const right = { x: to.x - size * Math.cos(angle + Math.PI / 6), y: to.y - size * Math.sin(angle + Math.PI / 6) }
  return `M ${left.x} ${left.y} L ${to.x} ${to.y} L ${right.x} ${right.y}`
}

function drawStroke(context: CanvasRenderingContext2D, stroke: Pick<VisualStrokeView, 'tool' | 'points'>): void {
  const points = stroke.tool === 'arrow' ? [stroke.points[0], stroke.points.at(-1)].filter((value): value is VisualPointView => value !== undefined) : stroke.points
  if (points.length === 0) return
  context.beginPath()
  points.forEach((point, index) => { if (index === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y) })
  context.stroke()
  if (stroke.tool !== 'arrow' || points.length < 2) return
  const from = points[0]!
  const to = points.at(-1)!
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  context.beginPath()
  context.moveTo(to.x - ARROW_HEAD * Math.cos(angle - Math.PI / 6), to.y - ARROW_HEAD * Math.sin(angle - Math.PI / 6))
  context.lineTo(to.x, to.y)
  context.lineTo(to.x - ARROW_HEAD * Math.cos(angle + Math.PI / 6), to.y - ARROW_HEAD * Math.sin(angle + Math.PI / 6))
  context.stroke()
}

/** Paints marks and strokes over whatever the context already holds, in capture pixels. */
export function paintMarks(context: CanvasRenderingContext2D, marks: readonly VisualMarkView[], strokes: readonly VisualStrokeView[], width: number, height: number): void {
  const colors = markColors()
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = STROKE_WIDTH
  context.strokeStyle = colors.stroke
  for (const stroke of strokes) drawStroke(context, stroke)
  const fontSize = Math.max(12, Math.round(Math.min(width, height) / 45))
  context.font = `${LABEL_FONT} ${fontSize}px sans-serif`
  context.textBaseline = 'middle'
  for (const mark of marks) {
    const color = colors[mark.kind]
    context.lineWidth = 3
    context.strokeStyle = color
    if (mark.kind === 'region') context.setLineDash([8, 6])
    else context.setLineDash([])
    context.strokeRect(mark.rect.x, mark.rect.y, mark.rect.width, mark.rect.height)
    context.setLineDash([])
    const label = `${mark.label}${mark.found ? ' ✓' : ''}`
    const padding = Math.round(fontSize * 0.5)
    const boxWidth = context.measureText(label).width + padding * 2
    const boxHeight = fontSize + padding
    const above = mark.rect.y - boxHeight - 4 >= 0
    const x = Math.max(0, Math.min(width - boxWidth, mark.rect.x))
    const y = above ? mark.rect.y - boxHeight - 4 : Math.min(height - boxHeight, mark.rect.y + mark.rect.height + 4)
    context.fillStyle = color
    context.fillRect(x, y, boxWidth, boxHeight)
    context.fillStyle = mark.kind === 'region' ? colors.regionLabel : colors.label
    context.fillText(label, x + padding, y + boxHeight / 2)
  }
  context.restore()
}

/** The capture with its marks baked in, as PNG bytes: what travels to the agent on Send. */
export async function renderMarkedCapture(image: CanvasImageSource, width: number, height: number, marks: readonly VisualMarkView[], strokes: readonly VisualStrokeView[]): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The marked image could not be drawn')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  paintMarks(context, marks, strokes, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('The marked image could not be saved')
  return new Uint8Array(await blob.arrayBuffer())
}
