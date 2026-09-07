import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { NodeView, NodeViewConstructor } from 'prosemirror-view'
import { toolbarButton } from './dom.js'
import type { LayoutReadiness } from './layout-readiness.js'

export interface LocalImageRequest {
  documentPath: string
  source: string
}

export interface ResolvedLocalImageBytes {
  bytes: ArrayBuffer | Uint8Array
  mimeType: string
}

export interface ResolvedLocalImageUrl {
  /** Must use StrataMD's main-process-backed strata-image protocol. */
  url: string
  path?: string
  version?: string
  /** Intrinsic pixel dimensions read from the file header, when the format and orientation are understood. */
  width?: number
  height?: number
}

export type ResolvedLocalImage = ResolvedLocalImageBytes | ResolvedLocalImageUrl
export type LocalImageResolver = (request: LocalImageRequest) => Promise<ResolvedLocalImage | null>

export interface ImageInspectionState {
  activeKey: string | null
  zoom: number
  panX: number
  panY: number
}

export class ImageInspectionManager {
  private readonly host: HTMLElement
  private readonly state: ImageInspectionState
  private overlay: HTMLElement | null = null
  private origin: HTMLElement | null = null

  constructor(host: HTMLElement, state: ImageInspectionState) {
    this.host = host
    this.state = state
  }

  isActive(key: string): boolean { return this.state.activeKey === key }

  open(key: string, url: string, alt: string, title: string | null, source: string, origin: HTMLElement): void {
    this.close(false)
    this.state.activeKey = key
    this.origin = origin
    const overlay = document.createElement('section')
    overlay.className = 'strata-image-inspector'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'false')
    overlay.setAttribute('aria-label', `Inspect ${alt}`)
    const editor = this.host.closest<HTMLElement>('.editor-island')
    const bounds = editor?.getBoundingClientRect()
    if (bounds) Object.assign(overlay.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` })
    const header = document.createElement('header')
    const details = document.createElement('div')
    const heading = document.createElement('strong')
    heading.textContent = alt
    const metadata = document.createElement('span')
    metadata.textContent = [title, source].filter(Boolean).join(' · ')
    details.append(heading, metadata)
    const controls = document.createElement('div')
    controls.append(
      toolbarButton('Fit', () => this.transform({ zoom: 1, panX: 0, panY: 0 }), { className: 'quiet-button' }),
      toolbarButton('−', () => this.transform({ zoom: Math.max(0.5, this.state.zoom - 0.1) }), { className: 'quiet-button' }),
      toolbarButton('+', () => this.transform({ zoom: Math.min(4, this.state.zoom + 0.1) }), { className: 'quiet-button' }),
      toolbarButton('Close', () => this.close(), { className: 'quiet-button' }),
    )
    header.append(details, controls)
    const viewport = document.createElement('div')
    viewport.className = 'strata-image-inspector__viewport'
    viewport.tabIndex = 0
    const image = document.createElement('img')
    image.src = url
    image.alt = alt
    image.draggable = false
    viewport.append(image)
    let drag: { x: number; y: number; panX: number; panY: number } | null = null
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      drag = { x: event.clientX, y: event.clientY, panX: this.state.panX, panY: this.state.panY }
      viewport.setPointerCapture(event.pointerId)
    })
    viewport.addEventListener('pointermove', (event) => {
      if (!drag) return
      this.transform({ panX: drag.panX + event.clientX - drag.x, panY: drag.panY + event.clientY - drag.y })
    })
    viewport.addEventListener('pointerup', () => { drag = null })
    viewport.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); this.close(); return }
      if (!event.key.startsWith('Arrow')) return
      event.preventDefault()
      const amount = event.shiftKey ? 40 : 12
      this.transform({
        panX: this.state.panX + (event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0),
        panY: this.state.panY + (event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0),
      })
    })
    overlay.append(header, viewport)
    document.body.append(overlay)
    this.overlay = overlay
    this.paint()
    viewport.focus()
  }

  close(restoreFocus = true): void {
    const origin = this.origin
    this.overlay?.remove()
    this.overlay = null
    this.state.activeKey = null
    this.origin = null
    if (restoreFocus && origin) {
      requestAnimationFrame(() => {
        if (origin.isConnected) origin.focus({ preventScroll: true })
      })
    }
  }

  destroy(): void { this.overlay?.remove(); this.overlay = null; this.origin = null }

  private transform(patch: Partial<Pick<ImageInspectionState, 'zoom' | 'panX' | 'panY'>>): void {
    Object.assign(this.state, patch)
    this.paint()
  }

  private paint(): void {
    const image = this.overlay?.querySelector<HTMLImageElement>('img')
    if (image) image.style.transform = `translate(${this.state.panX}px, ${this.state.panY}px) scale(${this.state.zoom})`
  }
}

const imageMimeTypes = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'image/x-icon',
])

/**
 * A Markdown image source is local only when it has no URL scheme. Absolute
 * and relative POSIX paths are both passed to the main process for its final
 * realpath and allowed-root check.
 */
export function isLocalImageSource(source: string): boolean {
  const value = source.trim()
  if (value.length === 0 || value.startsWith('//') || value.startsWith('#')) return false
  return !/^[a-z][a-z\d+.-]*:/iu.test(value)
}

function byteBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes.slice(0)
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function normalizedAbsolutePath(documentPath: string, source: string): string | null {
  if (documentPath.includes('\0') || source.includes('\0') || !documentPath.startsWith('/')) return null
  const slash = documentPath.lastIndexOf('/')
  const combined = source.startsWith('/') ? source : `${documentPath.slice(0, slash + 1)}${source}`
  const segments: string[] = []
  for (const segment of combined.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function trustedProtocolUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'strata-image:'
      && url.hostname === 'local'
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
  } catch {
    return false
  }
}

/**
 * Produces a request for the registered Electron protocol. The protocol
 * handler still realpaths the target and checks document and explorer roots.
 */
export const resolveImageThroughMainProtocol: LocalImageResolver = async ({ documentPath, source }) => {
  if (!isLocalImageSource(source)) return null
  const path = normalizedAbsolutePath(documentPath, source)
  return path === null ? null : { url: `strata-image://local/${base64Url(path)}` }
}

class LocalImageNodeView implements NodeView {
  readonly dom: HTMLSpanElement

  private node: ProseMirrorNode
  private readonly documentPath: string
  private readonly resolve: LocalImageResolver
  private readonly inspection: ImageInspectionManager | null
  private readonly readiness: LayoutReadiness | null
  private readonly key: string
  private generation = 0
  private objectUrl: string | null = null
  private settle: (() => void) | null = null

  constructor(node: ProseMirrorNode, documentPath: string, resolve: LocalImageResolver, inspection: ImageInspectionManager | null, readiness: LayoutReadiness | null = null) {
    this.node = node
    this.documentPath = documentPath
    this.resolve = resolve
    this.inspection = inspection
    this.readiness = readiness
    this.key = typeof node.attrs.sourceId === 'string' ? node.attrs.sourceId : String(node.attrs.src ?? '')
    this.dom = document.createElement('span')
    this.dom.className = 'strata-image strata-image--loading'
    this.dom.contentEditable = 'false'
    this.dom.draggable = true
    this.load()
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false
    const changed = node.attrs.src !== this.node.attrs.src
      || node.attrs.alt !== this.node.attrs.alt
      || node.attrs.title !== this.node.attrs.title
    this.node = node
    if (changed) this.load()
    return true
  }

  destroy(): void {
    this.generation += 1
    this.revokeObjectUrl()
    this.settled()
  }

  ignoreMutation(): boolean {
    return true
  }

  /** The current load reached a terminal presentation; the editor's layout no longer waits on it. */
  private settled(): void {
    const settle = this.settle
    this.settle = null
    settle?.()
  }

  private placeholder(text: string, modifier: string): void {
    this.revokeObjectUrl()
    this.dom.replaceChildren()
    this.dom.className = `strata-image strata-image--${modifier}`
    this.dom.setAttribute('role', 'img')
    this.dom.setAttribute('aria-label', this.altText())
    this.dom.removeAttribute('tabindex')
    this.dom.onclick = null
    this.dom.onkeydown = null
    const label = document.createElement('span')
    label.className = 'strata-image__placeholder'
    label.textContent = text
    this.dom.append(label)
  }

  private altText(): string {
    return typeof this.node.attrs.alt === 'string' && this.node.attrs.alt.length > 0
      ? this.node.attrs.alt
      : 'Image'
  }

  private revokeObjectUrl(): void {
    if (this.objectUrl === null) return
    URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = null
  }

  private load(): void {
    const generation = ++this.generation
    this.settled()
    const source = String(this.node.attrs.src ?? '').trim()
    if (!isLocalImageSource(source)) {
      this.placeholder('Remote image blocked', 'blocked')
      return
    }

    // Layout waits until the image reaches a terminal presentation: a decoded
    // picture at its final box, or the unavailable placeholder. Installing the
    // element is not enough; the box only settles once the bytes decode.
    this.settle = this.readiness?.begin(`image:${source}`) ?? null
    const finish = (): void => { if (generation === this.generation) this.settled() }
    this.placeholder('Loading image', 'loading')
    void this.resolve({ documentPath: this.documentPath, source })
      .then(async (resolved) => {
        if (generation !== this.generation) return
        if (resolved === null) {
          this.placeholder('Image unavailable', 'missing')
          finish()
          return
        }

        this.revokeObjectUrl()
        let sourceUrl: string
        let displayPath = source
        let dimensions: { width: number; height: number } | null = null
        if ('url' in resolved) {
          if (!trustedProtocolUrl(resolved.url)) {
            this.placeholder('Image unavailable', 'missing')
            finish()
            return
          }
          sourceUrl = resolved.url
          displayPath = resolved.path ?? source
          if (typeof resolved.width === 'number' && typeof resolved.height === 'number' && resolved.width > 0 && resolved.height > 0) dimensions = { width: resolved.width, height: resolved.height }
        } else {
          if (!imageMimeTypes.has(resolved.mimeType.toLowerCase())) {
            this.placeholder('Image unavailable', 'missing')
            finish()
            return
          }
          const blob = new Blob([byteBuffer(resolved.bytes)], { type: resolved.mimeType })
          this.objectUrl = URL.createObjectURL(blob)
          sourceUrl = this.objectUrl
        }
        const image = document.createElement('img')
        // Header dimensions reserve the CSS-constrained box before the bytes
        // arrive: the width attribute bounds the box and the height attribute
        // supplies the aspect ratio while the stylesheet keeps height auto.
        if (dimensions) {
          image.width = dimensions.width
          image.height = dimensions.height
          image.dataset.intrinsicWidth = String(dimensions.width)
          image.dataset.intrinsicHeight = String(dimensions.height)
        }
        image.src = sourceUrl
        image.alt = this.altText()
        if (typeof this.node.attrs.title === 'string') image.title = this.node.attrs.title
        image.draggable = false
        image.addEventListener('error', () => {
          if (generation === this.generation) { this.placeholder('Image unavailable', 'missing'); finish() }
        }, { once: true })
        const decoded = (): void => {
          if (generation !== this.generation) return
          image.dataset.decoded = 'true'
          finish()
        }
        const waitForDecode = (): void => {
          void (this.readiness ? this.readiness.pass('image-decode') : Promise.resolve())
            .then(() => image.decode())
            .then(decoded, () => {
              // decode() rejects for images the browser cannot decode and for
              // elements detached mid-flight; the error listener covers the former.
              if (generation === this.generation && image.complete && image.naturalWidth > 0) decoded()
            })
        }
        if (image.complete && image.naturalWidth > 0) waitForDecode()
        else image.addEventListener('load', waitForDecode, { once: true })
        this.dom.replaceChildren(image)
        this.dom.className = 'strata-image strata-image--ready'
        this.dom.removeAttribute('role')
        this.dom.removeAttribute('aria-label')
        this.dom.tabIndex = 0
        this.dom.setAttribute('role', 'button')
        this.dom.setAttribute('aria-label', `Inspect ${this.altText()}`)
        this.dom.dispatchEvent(new CustomEvent('strata-image-ready', { bubbles: true }))
        const inspect = (): void => this.inspection?.open(
          this.key,
          sourceUrl,
          this.altText(),
          typeof this.node.attrs.title === 'string' ? this.node.attrs.title : null,
          displayPath,
          this.dom,
        )
        this.dom.onclick = inspect
        this.dom.onkeydown = (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          inspect()
        }
        if (this.inspection?.isActive(this.key)) inspect()
      })
      .catch(() => {
        if (generation === this.generation) { this.placeholder('Image unavailable', 'missing'); finish() }
      })
  }
}

/** Create the `image` entry for EditorProps.nodeViews. */
export function createLocalImageNodeView(
  documentPath: string,
  resolve: LocalImageResolver = resolveImageThroughMainProtocol,
  inspection: ImageInspectionManager | null = null,
  readiness: LayoutReadiness | null = null,
): NodeViewConstructor {
  return (node) => new LocalImageNodeView(node, documentPath, resolve, inspection, readiness)
}

/** Convenience wrapper for direct use as EditorProps.nodeViews. */
export function createLocalImageNodeViews(
  documentPath: string,
  resolve: LocalImageResolver = resolveImageThroughMainProtocol,
  inspection: ImageInspectionManager | null = null,
  readiness: LayoutReadiness | null = null,
): Record<'image', NodeViewConstructor> {
  return { image: createLocalImageNodeView(documentPath, resolve, inspection, readiness) }
}
