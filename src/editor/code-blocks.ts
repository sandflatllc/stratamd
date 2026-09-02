import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view'
import { parseMermaidSvg, renderMermaid } from './mermaid-renderer'
import { toolbarButton } from './dom.js'

export interface VisualCodeBlockState {
  presentation: 'visual' | 'source'
  zoom: number
  panX: number
  panY: number
}

export type VisualCodeBlockSessions = Map<string, VisualCodeBlockState>

export interface CodeBlockNodeViewOptions {
  sessions: VisualCodeBlockSessions
}

interface TreeNode {
  label: string
  children: TreeNode[]
}

export function visualCodeFenceKind(info: unknown, meta: unknown): 'mermaid' | 'tree' | null {
  const language = typeof info === 'string' ? info.trim() : ''
  return (language === 'mermaid' || language === 'tree') && !(typeof meta === 'string' && meta.trim())
    ? language
    : null
}

export function parseFileTree(source: string): TreeNode[] | null {
  const roots: TreeNode[] = []
  const stack: TreeNode[] = []
  for (const raw of source.split(/\r?\n/u)) {
    if (!raw.trim()) continue
    const branch = /^((?:(?:│   |    ))*)(?:├── |└── )(.*)$/u.exec(raw)
    const plain = /^( *)(\S.*)$/u.exec(raw)
    let depth: number
    let label: string
    if (branch) {
      depth = (branch[1]?.length ?? 0) / 4 + 1
      label = branch[2]?.trim() ?? ''
    } else if (plain && (plain[1]?.length ?? 0) % 2 === 0) {
      depth = (plain[1]?.length ?? 0) / 2
      label = plain[2]?.trim() ?? ''
    } else {
      return null
    }
    if (!label || depth > stack.length) return null
    const node: TreeNode = { label, children: [] }
    if (depth === 0) roots.push(node)
    else stack[depth - 1]?.children.push(node)
    stack.length = depth
    stack.push(node)
  }
  return roots.length > 0 ? roots : null
}

function button(label: string, action: () => void, className = 'quiet-button'): HTMLButtonElement {
  return toolbarButton(label, action, { className })
}

class CodeBlockNodeView implements NodeView {
  readonly dom: HTMLElement
  readonly contentDOM: HTMLElement
  private node: ProseMirrorNode
  private readonly sessions: VisualCodeBlockSessions
  private readonly key: string
  private readonly kind: 'mermaid' | 'tree' | null
  private readonly source: HTMLPreElement
  private readonly visual: HTMLElement
  private readonly toolbar: HTMLElement | null
  private readonly viewport: HTMLElement | null
  private readonly canvas: HTMLElement | null
  private generation = 0
  private renderTimer: number | null = null
  private diagramDirty = false
  private dragging: { x: number; y: number; panX: number; panY: number } | null = null

  constructor(node: ProseMirrorNode, _view: EditorView, getPos: () => number | undefined, options: CodeBlockNodeViewOptions) {
    this.node = node
    this.sessions = options.sessions
    const info = String(node.attrs.info ?? '').trim()
    const special = visualCodeFenceKind(node.attrs.info, node.attrs.meta)
    this.kind = special
    const sourceId = typeof node.attrs.sourceId === 'string' ? node.attrs.sourceId : null
    this.key = sourceId ?? `${info}:${getPos() ?? 0}`
    this.source = document.createElement('pre')
    this.source.dataset.info = info
    this.source.spellcheck = false
    this.contentDOM = document.createElement('code')
    this.source.append(this.contentDOM)
    if (special === null) {
      this.dom = this.source
      this.visual = this.source
      this.toolbar = null
      this.viewport = null
      this.canvas = null
      return
    }

    this.dom = document.createElement('figure')
    this.dom.className = `strata-visual-code strata-visual-code--${special}`
    this.toolbar = document.createElement('div')
    this.toolbar.className = 'strata-visual-code__toolbar'
    const title = document.createElement('span')
    title.className = 'strata-visual-code__title'
    title.textContent = special === 'mermaid' ? 'Diagram' : 'File tree'
    this.toolbar.append(title)
    this.toolbar.append(
      button(special === 'mermaid' ? 'Diagram' : 'Tree', () => this.setPresentation('visual')),
      button('Source', () => this.setPresentation('source')),
    )
    this.visual = document.createElement('div')
    this.visual.className = 'strata-visual-code__visual'
    if (special === 'mermaid') {
      this.toolbar.append(
        button('−', () => this.changeZoom(-0.1)),
        button('Reset', () => this.resetTransform()),
        button('+', () => this.changeZoom(0.1)),
      )
      this.viewport = document.createElement('div')
      this.viewport.className = 'strata-mermaid-viewport'
      this.viewport.tabIndex = 0
      this.viewport.setAttribute('role', 'img')
      this.viewport.setAttribute('aria-label', 'Mermaid diagram')
      this.canvas = document.createElement('div')
      this.canvas.className = 'strata-mermaid-canvas'
      this.viewport.append(this.canvas)
      this.visual.append(this.viewport)
      this.viewport.addEventListener('pointerdown', (event) => this.startPan(event))
      this.viewport.addEventListener('pointermove', (event) => this.pan(event))
      this.viewport.addEventListener('pointerup', () => { this.dragging = null })
      this.viewport.addEventListener('pointercancel', () => { this.dragging = null })
      this.viewport.addEventListener('keydown', (event) => this.panKey(event))
    } else {
      this.viewport = null
      this.canvas = null
    }
    this.dom.append(this.toolbar, this.visual, this.source)
    this.render()
  }

  update(node: ProseMirrorNode): boolean {
    const kind = visualCodeFenceKind(node.attrs.info, node.attrs.meta)
    if (node.type !== this.node.type || kind !== this.kind) return false
    const changed = node.textContent !== this.node.textContent
    this.node = node
    if (changed) {
      if (this.kind === 'mermaid') this.markDiagramDirty()
      else this.render()
    }
    return true
  }

  destroy(): void {
    this.generation += 1
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer)
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && !this.contentDOM.contains(event.target)
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.target !== this.contentDOM && !this.contentDOM.contains(mutation.target)
  }

  private state(): VisualCodeBlockState {
    const existing = this.sessions.get(this.key)
    if (existing) return existing
    const created: VisualCodeBlockState = { presentation: 'visual', zoom: 1, panX: 0, panY: 0 }
    this.sessions.set(this.key, created)
    return created
  }

  private updateState(patch: Partial<VisualCodeBlockState>): void {
    this.sessions.set(this.key, { ...this.state(), ...patch })
    this.paintState()
  }

  private setPresentation(presentation: 'visual' | 'source'): void {
    this.updateState({ presentation })
    if (presentation === 'source') this.contentDOM.focus()
    else if (this.diagramDirty) this.renderDiagram()
  }

  private changeZoom(delta: number): void {
    this.updateState({ zoom: Math.max(0.5, Math.min(3, Number((this.state().zoom + delta).toFixed(1)))) })
  }

  private resetTransform(): void {
    this.updateState({ zoom: 1, panX: 0, panY: 0 })
  }

  private startPan(event: PointerEvent): void {
    if (event.button !== 0) return
    const state = this.state()
    this.dragging = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY }
    this.viewport?.setPointerCapture(event.pointerId)
  }

  private pan(event: PointerEvent): void {
    if (!this.dragging) return
    this.updateState({
      panX: this.dragging.panX + event.clientX - this.dragging.x,
      panY: this.dragging.panY + event.clientY - this.dragging.y,
    })
  }

  private panKey(event: KeyboardEvent): void {
    if (!event.key.startsWith('Arrow')) return
    event.preventDefault()
    const amount = event.shiftKey ? 40 : 12
    const state = this.state()
    this.updateState({
      panX: state.panX + (event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0),
      panY: state.panY + (event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0),
    })
  }

  private paintState(): void {
    if (!this.toolbar) return
    const state = this.state()
    this.source.hidden = state.presentation !== 'source'
    this.visual.hidden = state.presentation !== 'visual'
    const controls = this.toolbar.querySelectorAll('button')
    controls[0]?.setAttribute('aria-pressed', String(state.presentation === 'visual'))
    controls[1]?.setAttribute('aria-pressed', String(state.presentation === 'source'))
    if (this.canvas) this.canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`
    if (this.viewport) this.viewport.setAttribute('aria-label', `Mermaid diagram, ${Math.round(state.zoom * 100)} percent zoom`)
  }

  private renderTree(): void {
    const tree = parseFileTree(this.node.textContent)
    this.visual.replaceChildren()
    if (!tree) {
      const error = document.createElement('div')
      error.className = 'strata-visual-code__error'
      error.textContent = 'This file tree could not be read. Use Source to edit the preserved text.'
      const preserved = document.createElement('pre')
      preserved.className = 'strata-file-tree__preserved'
      preserved.textContent = this.node.textContent
      this.visual.append(error, preserved)
      return
    }
    const root = document.createElement('div')
    root.className = 'strata-file-tree'
    root.setAttribute('role', 'tree')
    root.setAttribute('aria-label', 'File tree')
    const append = (nodes: TreeNode[], parent: HTMLElement, level: number): void => {
      for (const node of nodes) {
        const item = document.createElement('div')
        item.className = 'strata-file-tree__item'
        item.setAttribute('role', 'treeitem')
        item.setAttribute('aria-level', String(level))
        const label = document.createElement('span')
        label.textContent = `${node.children.length > 0 ? '▾' : node.label.endsWith('/') ? '▸' : '·'} ${node.label}`
        item.append(label)
        parent.append(item)
        if (node.children.length > 0) {
          item.tabIndex = 0
          item.setAttribute('aria-expanded', 'true')
          const group = document.createElement('div')
          group.setAttribute('role', 'group')
          item.append(group)
          const toggle = (): void => {
            const expanded = item.getAttribute('aria-expanded') !== 'false'
            item.setAttribute('aria-expanded', String(!expanded))
            group.hidden = expanded
            label.textContent = `${expanded ? '▸' : '▾'} ${node.label}`
          }
          label.addEventListener('click', toggle)
          item.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            toggle()
          })
          append(node.children, group, level + 1)
        }
      }
    }
    append(tree, root, 1)
    this.visual.append(root)
  }

  private render(): void {
    this.paintState()
    if (this.kind === 'tree') {
      this.renderTree()
      return
    }
    this.renderDiagram()
  }

  private markDiagramDirty(): void {
    this.diagramDirty = true
    if (this.state().presentation === 'source') return
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer)
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null
      this.renderDiagram()
    }, 250)
  }

  private renderDiagram(): void {
    if (!this.canvas || !this.diagramDirty && this.generation > 0) return
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer)
      this.renderTimer = null
    }
    this.diagramDirty = false
    const generation = ++this.generation
    this.canvas.replaceChildren()
    const loading = document.createElement('span')
    loading.className = 'strata-visual-code__loading'
    loading.textContent = 'Drawing diagram…'
    this.canvas.append(loading)
    void renderMermaid(`strata-mermaid-${generation}-${Math.random().toString(36).slice(2)}`, this.node.textContent, { normalizeBreaks: true })
      .then((result) => {
        if (generation !== this.generation) return
        this.canvas?.replaceChildren(parseMermaidSvg(result.svg))
        this.paintState()
      })
      .catch((error: unknown) => {
        if (generation !== this.generation || !this.canvas) return
        const message = document.createElement('div')
        message.className = 'strata-visual-code__error'
        const detail = error instanceof Error ? error.message.split('\n')[0] : 'Check the Mermaid source.'
        message.textContent = `This diagram could not be drawn. ${detail}`
        this.canvas.replaceChildren(message)
      })
  }
}

export function createCodeBlockNodeView(options: CodeBlockNodeViewOptions) {
  return (node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined): NodeView =>
    new CodeBlockNodeView(node, view, getPos, options)
}
