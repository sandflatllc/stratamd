import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { NodeView, NodeViewConstructor } from 'prosemirror-view'

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
}

export type ResolvedLocalImage = ResolvedLocalImageBytes | ResolvedLocalImageUrl
export type LocalImageResolver = (request: LocalImageRequest) => Promise<ResolvedLocalImage | null>

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
  private generation = 0
  private objectUrl: string | null = null

  constructor(node: ProseMirrorNode, documentPath: string, resolve: LocalImageResolver) {
    this.node = node
    this.documentPath = documentPath
    this.resolve = resolve
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
  }

  ignoreMutation(): boolean {
    return true
  }

  private placeholder(text: string, modifier: string): void {
    this.revokeObjectUrl()
    this.dom.replaceChildren()
    this.dom.className = `strata-image strata-image--${modifier}`
    this.dom.setAttribute('role', 'img')
    this.dom.setAttribute('aria-label', this.altText())
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
    const source = String(this.node.attrs.src ?? '').trim()
    if (!isLocalImageSource(source)) {
      this.placeholder('Remote image blocked', 'blocked')
      return
    }

    this.placeholder('Loading image', 'loading')
    void this.resolve({ documentPath: this.documentPath, source })
      .then((resolved) => {
        if (generation !== this.generation) return
        if (resolved === null) {
          this.placeholder('Image unavailable', 'missing')
          return
        }

        this.revokeObjectUrl()
        let sourceUrl: string
        if ('url' in resolved) {
          if (!trustedProtocolUrl(resolved.url)) {
            this.placeholder('Image unavailable', 'missing')
            return
          }
          sourceUrl = resolved.url
        } else {
          if (!imageMimeTypes.has(resolved.mimeType.toLowerCase())) {
            this.placeholder('Image unavailable', 'missing')
            return
          }
          const blob = new Blob([byteBuffer(resolved.bytes)], { type: resolved.mimeType })
          this.objectUrl = URL.createObjectURL(blob)
          sourceUrl = this.objectUrl
        }
        const image = document.createElement('img')
        image.src = sourceUrl
        image.alt = this.altText()
        if (typeof this.node.attrs.title === 'string') image.title = this.node.attrs.title
        image.draggable = false
        image.addEventListener('error', () => {
          if (generation === this.generation) this.placeholder('Image unavailable', 'missing')
        }, { once: true })
        this.dom.replaceChildren(image)
        this.dom.className = 'strata-image strata-image--ready'
        this.dom.removeAttribute('role')
        this.dom.removeAttribute('aria-label')
      })
      .catch(() => {
        if (generation === this.generation) this.placeholder('Image unavailable', 'missing')
      })
  }
}

/** Create the `image` entry for EditorProps.nodeViews. */
export function createLocalImageNodeView(
  documentPath: string,
  resolve: LocalImageResolver = resolveImageThroughMainProtocol,
): NodeViewConstructor {
  return (node) => new LocalImageNodeView(node, documentPath, resolve)
}

/** Convenience wrapper for direct use as EditorProps.nodeViews. */
export function createLocalImageNodeViews(
  documentPath: string,
  resolve: LocalImageResolver = resolveImageThroughMainProtocol,
): Record<'image', NodeViewConstructor> {
  return { image: createLocalImageNodeView(documentPath, resolve) }
}
