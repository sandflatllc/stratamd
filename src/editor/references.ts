import { classifyLocalLink } from '../shared/local-link'
import type { LocalMarkdownPreview } from '../shared/contracts'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { popoverPosition } from './popover'

export type LocalMarkdownResolver = (source: string) => Promise<LocalMarkdownPreview | null>

export function localMarkdownCandidate(source: string): string | null {
  return classifyLocalLink(source)?.kind === 'markdown' ? source.trim() : null
}

export function markdownPreviewText(source: string): { title: string | null; excerpt: string } {
  const title = source.match(/^\s{0,3}#{1,6}[ \t]+(.+?)\s*#*\s*$/mu)?.[1]?.trim() ?? null
  const excerpt = source
    .replace(/^\s{0,3}#{1,6}[ \t]+/gmu, '')
    .replace(/```[\s\S]*?```/gu, ' [code block] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_~`>#|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 700)
  return { title, excerpt }
}

const referenceDecorationsKey = new PluginKey<DecorationSet>('stratamd-reference-previews')

function referenceDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, position) => {
    if (!node.isText || !node.marks.some((mark) => mark.type.name === 'code')) return true
    const candidate = localMarkdownCandidate(node.text ?? '')
    if (!candidate) return true
    decorations.push(Decoration.inline(position, position + node.nodeSize, {
      'data-local-markdown-reference': 'true',
      role: 'button',
      tabindex: '0',
      'aria-label': `Preview ${candidate}`,
    }))
    return true
  })
  return DecorationSet.create(doc, decorations)
}

function changedRangeContainsCandidate(transaction: Transaction): boolean {
  let found = false
  if (transaction.steps.length > 64) {
    transaction.doc.descendants((node) => {
      if (found) return false
      if (node.isText && node.marks.some((mark) => mark.type.name === 'code') && localMarkdownCandidate(node.text ?? '')) found = true
      return !found
    })
    return found
  }
  transaction.mapping.maps.forEach((stepMap, index) => {
    if (found) return
    const following = transaction.mapping.slice(index + 1)
    stepMap.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      if (found) return
      const from = Math.max(0, following.map(newFrom, -1) - 1)
      const to = Math.min(transaction.doc.content.size, following.map(newTo, 1) + 1)
      transaction.doc.nodesBetween(Math.min(from, to), Math.max(from, to), (node) => {
        if (node.isText && node.marks.some((mark) => mark.type.name === 'code') && localMarkdownCandidate(node.text ?? '')) {
          found = true
          return false
        }
        return !found
      })
    })
  })
  return found
}

/** ProseMirror owns these focus attributes so its DOM observer never fights them. */
export function createReferencePreviewPlugin(): Plugin<DecorationSet> {
  return new Plugin({
    key: referenceDecorationsKey,
    state: {
      init: (_config, state) => referenceDecorations(state.doc),
      apply: (transaction, previous) => {
        if (!transaction.docChanged) return previous
        if (previous.find().length === 0 && !changedRangeContainsCandidate(transaction)) {
          return previous.map(transaction.mapping, transaction.doc)
        }
        return referenceDecorations(transaction.doc)
      },
    },
    props: { decorations: (state) => referenceDecorationsKey.getState(state) ?? DecorationSet.empty },
  })
}

export class ReferencePreviewController {
  private readonly host: HTMLElement
  private readonly resolve: LocalMarkdownResolver
  private readonly open: (path: string) => void
  private popover: HTMLElement | null = null
  private origin: HTMLElement | null = null
  private generation = 0
  private readonly away = (event: Event): void => {
    if (!this.popover || !(event.target instanceof Node) || this.popover.contains(event.target) || this.origin?.contains(event.target)) return
    this.close()
  }

  constructor(host: HTMLElement, resolve: LocalMarkdownResolver, open: (path: string) => void) {
    this.host = host
    this.resolve = resolve
    this.open = open
    window.addEventListener('pointerdown', this.away, true)
  }

  activate(event: MouseEvent | KeyboardEvent): boolean {
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return false
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('a[href], [data-local-markdown-reference]') : null
    if (!target) return false
    const source = target instanceof HTMLAnchorElement ? target.getAttribute('href') ?? '' : target.textContent ?? ''
    const candidate = localMarkdownCandidate(source)
    if (!candidate) return false
    event.preventDefault()
    event.stopPropagation()
    void this.show(target, candidate)
    return true
  }

  close(restoreFocus = true): void {
    this.generation += 1
    this.popover?.remove()
    this.popover = null
    if (restoreFocus) this.origin?.focus()
    this.origin = null
  }

  destroy(): void { window.removeEventListener('pointerdown', this.away, true); this.close(false) }

  private async show(origin: HTMLElement, source: string): Promise<void> {
    this.close(false)
    const generation = ++this.generation
    this.origin = origin
    const loading = document.createElement('section')
    const started = performance.now()
    loading.className = 'strata-reference-preview'
    loading.setAttribute('role', 'dialog')
    loading.setAttribute('aria-label', `Preview ${source}`)
    loading.textContent = 'Opening preview…'
    this.host.append(loading)
    this.popover = loading
    this.place(origin, loading)
    let failure = `Could not preview ${source}`
    const preview = await this.resolve(source).catch((error: unknown) => {
      if (error instanceof Error) failure = error.message
      return null
    })
    if (generation !== this.generation) return
    if (!preview) {
      const message = document.createElement('p')
      message.textContent = failure
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'quiet-button'
      retry.textContent = 'Retry'
      retry.addEventListener('click', () => { void this.show(origin, source) })
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'quiet-button'
      close.textContent = 'Close'
      close.addEventListener('click', () => this.close())
      loading.replaceChildren(message, retry, close)
      loading.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close() }
      })
      this.place(origin, loading)
      return
    }
    const { title, excerpt } = markdownPreviewText(preview.source)
    const heading = document.createElement('strong')
    heading.textContent = title ?? preview.path.split(/[/\\]/).at(-1) ?? 'Markdown document'
    const path = document.createElement('span')
    path.className = 'strata-reference-preview__path'
    path.textContent = preview.path
    const body = document.createElement('p')
    body.textContent = excerpt || 'This document has no previewable text.'
    const actions = document.createElement('div')
    actions.className = 'editor-popover-actions'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'quiet-button'
    close.textContent = 'Close'
    close.addEventListener('click', () => this.close())
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'primary-button'
    open.textContent = 'Open document'
    open.addEventListener('click', () => { this.close(false); this.open(preview.path) })
    actions.append(close, open)
    loading.replaceChildren(heading, path, body, actions)
    document.documentElement.dataset.referencePreviewMs = (performance.now() - started).toFixed(3)
    loading.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      this.close()
    })
    this.place(origin, loading)
    open.focus()
  }

  private place(origin: HTMLElement, popover: HTMLElement): void {
    const bounds = origin.getBoundingClientRect()
    const size = { width: 380, height: Math.max(180, popover.offsetHeight) }
    const position = popoverPosition({ left: bounds.left, top: bounds.top, bottom: bounds.bottom }, size, { width: innerWidth, height: innerHeight })
    popover.style.left = `${position.left}px`
    popover.style.top = `${position.top}px`
    popover.style.width = `${size.width}px`
  }
}
