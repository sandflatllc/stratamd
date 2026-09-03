import { Fragment, type Node as ProseMirrorNode } from 'prosemirror-model'
import type { EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view'
import type { LocalImageResolver } from './images.js'
import { strataSchema } from './schema.js'
import { COMPONENT_REGISTRY } from '../core/markdown/components.js'
import { componentGlyph, componentLabel, componentQualifier } from './component-labels.js'

interface TableData {
  node: ProseMirrorNode
  offset: number
  rows: string[][]
}

interface ScreenshotPin {
  pin: number
  x: number
  y: number
  version: string
  note: string
  row: number
}

interface ComponentSessionState {
  decisionColumn?: number | null
  screenshotFocused?: boolean
  activePin?: number | null
  evidenceActive?: boolean
}

export interface ScreenshotPinDiscussionRequest {
  componentOrdinal: number
  pin: number
  image: string
  left: number
  top: number
}

function cellText(cell: ProseMirrorNode): string { return cell.textContent.trim() }

function directTable(node: ProseMirrorNode): TableData | null {
  let found: TableData | null = null
  node.forEach((child, offset) => {
    if (!found && child.type === strataSchema.nodes.table) {
      const rows: string[][] = []
      child.forEach((row) => {
        const cells: string[] = []
        row.forEach((cell) => cells.push(cellText(cell)))
        rows.push(cells)
      })
      found = { node: child, offset, rows }
    }
  })
  return found
}

function firstImageSource(node: ProseMirrorNode): string | null {
  let source: string | null = null
  node.descendants((child) => {
    if (source === null && child.type === strataSchema.nodes.image) source = String(child.attrs.src ?? '')
    return source === null
  })
  return source
}

function makeCell(text: string): ProseMirrorNode {
  const paragraph = strataSchema.nodes.paragraph.create(null, text ? strataSchema.text(text) : undefined)
  return strataSchema.nodes.table_cell.create(null, paragraph)
}

function replaceCellText(cell: ProseMirrorNode, text: string): ProseMirrorNode {
  const paragraph = strataSchema.nodes.paragraph.create(null, text ? strataSchema.text(text) : undefined)
  return cell.type.create(cell.attrs, paragraph, cell.marks)
}

function sourceAttributes(node: ProseMirrorNode): Record<string, string> {
  const attributes: Record<string, string> = {}
  if (typeof node.attrs.sourceId === 'string') attributes['data-source-id'] = node.attrs.sourceId
  if (typeof node.attrs.sourceFrom === 'number') attributes['data-source-from'] = String(node.attrs.sourceFrom)
  if (typeof node.attrs.sourceTo === 'number') attributes['data-source-to'] = String(node.attrs.sourceTo)
  return attributes
}

class ComponentNodeView implements NodeView {
  readonly dom: HTMLElement
  readonly contentDOM: HTMLElement

  private node: ProseMirrorNode
  private readonly view: EditorView
  private readonly getPos: () => number | undefined
  private readonly documentPath: string
  private readonly resolveImage: LocalImageResolver
  private readonly onDiscuss: ((request: ScreenshotPinDiscussionRequest) => void) | undefined
  private readonly sessionState: ComponentSessionState
  private readonly eyebrow: HTMLElement
  private readonly tooling: HTMLElement
  private chart: { destroy(): void } | null = null
  private chartGeneration = 0
  private screenshotGeneration = 0
  private imageVersion: string | null = null
  private resolvedImageSource: string | null = null
  private placingPin = false
  private screenshotFocused: boolean
  private activePin: number | null
  private decisionColumn: number | null
  private evidenceActive: boolean

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    documentPath: string,
    resolveImage: LocalImageResolver,
    sessionState: ComponentSessionState,
    onDiscuss?: (request: ScreenshotPinDiscussionRequest) => void,
  ) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.documentPath = documentPath
    this.resolveImage = resolveImage
    this.onDiscuss = onDiscuss
    this.sessionState = sessionState
    this.screenshotFocused = sessionState.screenshotFocused ?? false
    this.activePin = sessionState.activePin ?? null
    this.decisionColumn = sessionState.decisionColumn ?? null
    this.evidenceActive = sessionState.evidenceActive ?? false
    this.dom = document.createElement('section')
    this.dom.className = `strata-component strata-component--${this.name().toLowerCase()}`
    this.dom.setAttribute('role', 'region')
    for (const [key, value] of Object.entries(sourceAttributes(node))) this.dom.setAttribute(key, value)
    this.eyebrow = document.createElement('div')
    this.eyebrow.className = 'strata-component__eyebrow'
    this.eyebrow.contentEditable = 'false'
    const icon = document.createElement('span')
    icon.className = 'strata-component__icon'
    icon.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span')
    label.className = 'strata-component__label'
    const qualifier = document.createElement('span')
    qualifier.className = 'strata-component__qualifier'
    this.tooling = document.createElement('span')
    this.tooling.className = 'strata-component-tooling'
    this.eyebrow.append(icon, label, qualifier, this.tooling)
    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'strata-component__body'
    this.dom.append(this.eyebrow, this.contentDOM)
    this.contentDOM.addEventListener('click', (event) => this.contentActivated(event), true)
    this.contentDOM.addEventListener('focusin', (event) => this.contentActivated(event), true)
    this.contentDOM.addEventListener('strata-image-ready', () => this.decorateScreenshot())
    this.contentDOM.addEventListener('mousedown', (event) => this.protectScreenshotPointerDown(event), true)
    this.contentDOM.addEventListener('click', (event) => this.activateScreenshotImage(event as MouseEvent), true)
    this.contentDOM.addEventListener('keydown', (event) => this.activateScreenshotImageFromKeyboard(event as KeyboardEvent), true)
    this.configure()
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type || node.attrs.name !== this.node.attrs.name) return false
    if (node.eq(this.node)) {
      this.node = node
      return true
    }
    this.node = node
    for (const [key, value] of Object.entries(sourceAttributes(node))) this.dom.setAttribute(key, value)
    this.configure()
    return true
  }

  destroy(): void {
    this.chartGeneration += 1
    this.screenshotGeneration += 1
    this.chart?.destroy()
  }

  ignoreMutation(mutation: Parameters<NonNullable<NodeView['ignoreMutation']>>[0]): boolean {
    const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement
    const selector = '.strata-component-tooling, .strata-chart-surface, .strata-screenshot-pin-layer, .strata-screenshot-status'
    if (target?.closest(selector)) return true
    if (mutation.type === 'attributes' && target === this.dom
      && ['data-focused-alternative', 'data-screenshot-focused', 'data-evidence-active', 'data-active-pin'].includes(mutation.attributeName ?? '')) return true
    if (mutation.type === 'attributes' && mutation.attributeName === 'class' && target?.closest('.strata-component__body')) {
      return true
    }
    if (mutation.type !== 'childList') return false
    return [...mutation.addedNodes, ...mutation.removedNodes].some((changed) => {
      const element = changed instanceof Element ? changed : changed.parentElement
      return element?.matches(selector) || element?.closest(selector)
    })
  }

  private name(): string { return String(this.node.attrs.name) }

  private semantic(): string {
    const properties = this.node.attrs.properties as Record<string, string> | null
    if (this.name() === 'Callout') return properties?.kind ?? 'context'
    if (this.name() === 'Verdict') return properties?.outcome ?? 'neutral'
    if (this.name() === 'Chart') return properties?.kind ?? COMPONENT_REGISTRY.Chart.properties.kind!.default
    return this.name()
  }

  private configure(): void {
    const name = this.name()
    const semantic = this.semantic()
    this.dom.dataset.strataComponent = name
    this.dom.dataset.strataComponentState = semantic
    this.dom.setAttribute('aria-label', `${name}: ${semantic}`)
    this.eyebrow.querySelector('.strata-component__icon')!.textContent = componentGlyph(name, semantic)
    this.eyebrow.querySelector('.strata-component__label')!.textContent = componentLabel(name, semantic)
    const qualifier = this.eyebrow.querySelector<HTMLElement>('.strata-component__qualifier')!
    qualifier.textContent = componentQualifier(name, semantic)
    qualifier.hidden = qualifier.textContent.length === 0
    this.contentDOM.dataset.componentBody = name.toLowerCase()
    if (name === 'PhaseBoard') {
      let phases = 0
      this.node.forEach((child) => { if (child.type.name === 'heading' && Number(child.attrs.level) === 3) phases += 1 })
      this.dom.style.setProperty('--phase-count', String(Math.max(1, phases)))
    } else this.dom.style.removeProperty('--phase-count')
    this.dom.toggleAttribute('data-screenshot-focused', name === 'AnnotatedScreenshot' && this.screenshotFocused)
    this.dom.toggleAttribute('data-evidence-active', name === 'EvidenceChain' && this.evidenceActive)
    if (name === 'AnnotatedScreenshot' && this.activePin !== null) this.dom.dataset.activePin = String(this.activePin)
    else this.dom.removeAttribute('data-active-pin')
    this.tooling.replaceChildren()
    if (name === 'DecisionMatrix') this.configureDecisionMatrix()
    if (name === 'Chart') this.configureChart()
    else this.removeChart()
    if (name === 'AnnotatedScreenshot') this.configureScreenshot()
    else this.removeScreenshot()
  }

  private quietButton(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'quiet-button strata-component-action'
    button.textContent = label
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); action() })
    return button
  }

  private configureDecisionMatrix(): void {
    const rows = directTable(this.node)?.rows ?? []
    rows[0]?.slice(1).forEach((header, index) => {
      const column = index + 2
      const button = this.quietButton(`Focus ${header}`, () => {
        this.decisionColumn = this.decisionColumn === column ? null : column
        this.sessionState.decisionColumn = this.decisionColumn
        this.paintDecisionMatrix()
      })
      button.dataset.decisionColumn = String(column)
      this.tooling.append(button)
    })
    this.tooling.append(this.quietButton('Show all', () => {
      this.decisionColumn = null
      this.sessionState.decisionColumn = null
      this.paintDecisionMatrix()
    }))
    this.paintDecisionMatrix()
  }

  private paintDecisionMatrix(): void {
    if (this.decisionColumn === null) this.dom.removeAttribute('data-focused-alternative')
    else this.dom.dataset.focusedAlternative = String(this.decisionColumn)
    this.tooling.querySelectorAll<HTMLButtonElement>('[data-decision-column]').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.decisionColumn) === this.decisionColumn))
    })
    const showAll = Array.from(this.tooling.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Show all')
    if (showAll) showAll.disabled = this.decisionColumn === null
  }

  private removeChart(): void {
    this.chartGeneration += 1
    this.chart?.destroy()
    this.chart = null
    this.dom.querySelector('.strata-chart-surface')?.remove()
  }

  private configureChart(): void {
    this.removeChart()
    const table = directTable(this.node)
    if (!table || table.rows.length < 2) return
    const generation = ++this.chartGeneration
    const surface = document.createElement('div')
    surface.className = 'strata-chart-surface'
    surface.contentEditable = 'false'
    surface.setAttribute('aria-busy', 'true')
    surface.textContent = 'Drawing chart…'
    this.dom.insertBefore(surface, this.contentDOM)
    const headers = table.rows[0]!
    const labels = table.rows.slice(1).map((row) => row[0] ?? '')
    const series = headers.slice(1).map((label, index) => ({
      label,
      values: table.rows.slice(1).map((row) => Number(row[index + 1])),
    }))
    void import('./chart-renderer.js').then(({ renderDeclarativeChart }) => {
      if (generation !== this.chartGeneration || !surface.isConnected) return
      const canvas = document.createElement('canvas')
      canvas.setAttribute('role', 'img')
      canvas.setAttribute('aria-label', `${this.semantic()} chart with ${labels.length} categories and ${series.length} series`)
      surface.replaceChildren(canvas)
      const style = getComputedStyle(this.dom)
      const colors = Array.from({ length: 6 }, (_, index) => style.getPropertyValue(`--visuals-category-${index + 1}`).trim())
      try {
        const rendered = renderDeclarativeChart(canvas, {
          kind: this.semantic() === 'bar' ? 'bar' : 'line', labels, series, colors,
          textColor: style.getPropertyValue('--document-body').trim(),
          gridColor: style.getPropertyValue('--surfaces-border').trim(),
        })
        this.chart = rendered
        surface.removeAttribute('aria-busy')
        surface.dataset.chartRenderMs = rendered.durationMs.toFixed(3)
        document.documentElement.dataset.chartRenderMs = rendered.durationMs.toFixed(3)
      } catch {
        surface.replaceChildren(document.createTextNode('This chart could not be drawn. Edit the table below.'))
        surface.removeAttribute('aria-busy')
      }
    }).catch(() => {
      if (generation === this.chartGeneration) {
        surface.textContent = 'This chart could not be drawn. Edit the table below.'
        surface.removeAttribute('aria-busy')
      }
    })
  }

  private configureScreenshot(): void {
    const source = firstImageSource(this.node)
    const generation = ++this.screenshotGeneration
    if (source !== this.resolvedImageSource) this.imageVersion = null
    const place = this.quietButton(this.placingPin ? 'Choose position…' : 'Place pin', () => {
      this.placingPin = !this.placingPin
      this.tooling.replaceChildren()
      this.configureScreenshot()
    })
    place.disabled = this.imageVersion === null
    const focus = this.quietButton(this.screenshotFocused ? 'Close focus' : 'Focus image', () => {
      this.screenshotFocused = !this.screenshotFocused
      this.sessionState.screenshotFocused = this.screenshotFocused
      this.dom.toggleAttribute('data-screenshot-focused', this.screenshotFocused)
      this.tooling.replaceChildren()
      this.configureScreenshot()
      this.dom.scrollIntoView({ block: 'center' })
    })
    focus.disabled = source === null
    this.tooling.append(place, focus)
    if (source && source !== this.resolvedImageSource) {
      void this.resolveImage({ documentPath: this.documentPath, source }).then((resolved) => {
        if (generation !== this.screenshotGeneration) return
        this.resolvedImageSource = source
        this.imageVersion = resolved && 'version' in resolved && typeof resolved.version === 'string' ? resolved.version : null
        this.tooling.replaceChildren()
        this.configureScreenshot()
      }).catch(() => {
        if (generation === this.screenshotGeneration) {
          this.resolvedImageSource = source
          this.imageVersion = null
          this.tooling.replaceChildren()
          this.configureScreenshot()
        }
      })
    }
    requestAnimationFrame(() => this.decorateScreenshot())
  }

  private removeScreenshot(): void {
    this.screenshotGeneration += 1
    this.imageVersion = null
    this.resolvedImageSource = null
    this.placingPin = false
    this.screenshotFocused = false
    this.sessionState.screenshotFocused = false
    this.dom.removeAttribute('data-screenshot-focused')
    this.dom.querySelectorAll('.strata-screenshot-pin-layer, .strata-screenshot-status').forEach((element) => element.remove())
  }

  private screenshotPins(): ScreenshotPin[] {
    return (directTable(this.node)?.rows.slice(1) ?? []).flatMap((row, index) => {
      const pin = Number(row[0]); const x = Number(row[1]); const y = Number(row[2])
      return Number.isFinite(pin) && Number.isFinite(x) && Number.isFinite(y)
        ? [{ pin, x, y, version: row[3] ?? '', note: row[4] ?? '', row: index }]
        : []
    })
  }

  private screenshotRows(): HTMLTableRowElement[] {
    return [...this.dom.querySelectorAll<HTMLTableRowElement>('tbody tr')].filter((row) => row.querySelector('td'))
  }

  private decorateScreenshot(): void {
    if (this.name() !== 'AnnotatedScreenshot') return
    this.dom.querySelectorAll('.strata-screenshot-pin-layer, .strata-screenshot-status').forEach((element) => element.remove())
    const image = this.contentDOM.querySelector<HTMLElement>('.strata-image--ready')
    if (!image) return
    image.classList.add('strata-screenshot-image')
    image.tabIndex = -1
    image.setAttribute('role', 'group')
    image.setAttribute('aria-label', `Annotated ${image.querySelector('img')?.alt || 'screenshot'}`)
    const pins = this.screenshotPins()
    const layer = document.createElement('span')
    layer.className = 'strata-screenshot-pin-layer'
    layer.contentEditable = 'false'
    for (const pin of pins) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'strata-screenshot-pin'
      button.dataset.pin = String(pin.pin)
      button.style.left = `${pin.x}%`
      button.style.top = `${pin.y}%`
      button.textContent = String(pin.pin)
      button.setAttribute('aria-label', `Pin ${pin.pin}: ${pin.note}`)
      button.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
      })
      button.addEventListener('mouseup', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.activatePin(pin.pin, button)
      })
      button.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation()
        if (event.detail === 0) this.activatePin(pin.pin, button)
      })
      layer.append(button)
    }
    image.append(layer)
    const changed = this.imageVersion !== null && pins.some((pin) => pin.version !== this.imageVersion)
    if (changed) {
      const status = document.createElement('div')
      status.className = 'strata-screenshot-status'
      status.setAttribute('role', 'status')
      status.textContent = 'Image changed — verify pin positions'
      status.append(this.quietButton('Positions are correct', () => this.verifyPositions(this.imageVersion!)))
      this.dom.insertBefore(status, this.contentDOM)
    }
    this.updateActivePinPresentation()
  }

  private updateActivePinPresentation(): void {
    this.dom.querySelectorAll<HTMLElement>('.strata-screenshot-pin').forEach((button) => {
      button.classList.toggle('is-active', Number(button.dataset.pin) === this.activePin)
    })
    const pins = this.screenshotPins()
    this.screenshotRows().forEach((row, index) => {
      row.classList.toggle('is-active', pins.find((entry) => entry.row === index)?.pin === this.activePin)
    })
  }

  private activateScreenshotImage(event: MouseEvent): void {
    if (this.name() !== 'AnnotatedScreenshot') return
    if (event.target instanceof Element && event.target.closest('.strata-screenshot-pin')) return
    const image = event.target instanceof Element ? event.target.closest<HTMLElement>('.strata-image--ready') : null
    if (!image) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!this.placingPin || this.imageVersion === null) {
      this.screenshotFocused = !this.screenshotFocused
      this.sessionState.screenshotFocused = this.screenshotFocused
      this.dom.toggleAttribute('data-screenshot-focused', this.screenshotFocused)
      this.tooling.replaceChildren()
      this.configureScreenshot()
      return
    }
    const bounds = image.getBoundingClientRect()
    const x = Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100))
    const y = Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100))
    this.placingPin = false
    this.appendPin(x, y, this.imageVersion)
  }

  private protectScreenshotPointerDown(event: MouseEvent): void {
    if (this.name() !== 'AnnotatedScreenshot' || !(event.target instanceof Element)
      || !event.target.closest('.strata-image--ready')) return
    if (event.target.closest('.strata-screenshot-pin')) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  private activateScreenshotImageFromKeyboard(event: KeyboardEvent): void {
    if (this.name() !== 'AnnotatedScreenshot' || (event.key !== 'Enter' && event.key !== ' ')) return
    const image = event.target instanceof Element ? event.target.closest<HTMLElement>('.strata-image--ready') : null
    if (!image) return
    event.preventDefault()
    event.stopImmediatePropagation()
    this.screenshotFocused = !this.screenshotFocused
    this.sessionState.screenshotFocused = this.screenshotFocused
    this.dom.toggleAttribute('data-screenshot-focused', this.screenshotFocused)
    this.tooling.replaceChildren()
    this.configureScreenshot()
  }

  private appendPin(x: number, y: number, version: string): void {
    const table = directTable(this.node)
    const componentPos = this.getPos()
    if (!table || componentPos === undefined) return
    const nextPin = Math.max(0, ...this.screenshotPins().map((pin) => pin.pin)) + 1
    const row = strataSchema.nodes.table_row.create(null, [
      makeCell(String(nextPin)), makeCell(x.toFixed(1)), makeCell(y.toFixed(1)), makeCell(version), makeCell('Describe this pin'),
    ])
    const replacement = table.node.copy(table.node.content.append(Fragment.from(row)))
    const from = componentPos + 1 + table.offset
    this.view.dispatch(this.view.state.tr.replaceWith(from, from + table.node.nodeSize, replacement).scrollIntoView())
    this.activePin = nextPin
    this.sessionState.activePin = nextPin
    requestAnimationFrame(() => this.activatePin(nextPin))
  }

  private verifyPositions(version: string): void {
    const table = directTable(this.node)
    const componentPos = this.getPos()
    if (!table || componentPos === undefined) return
    const rows: ProseMirrorNode[] = []
    table.node.forEach((row, rowIndex) => {
      if (rowIndex === 0) { rows.push(row); return }
      const cells: ProseMirrorNode[] = []
      row.forEach((cell, cellIndex) => cells.push(cellIndex === 3 ? replaceCellText(cell, version) : cell))
      rows.push(row.type.create(row.attrs, cells, row.marks))
    })
    const replacement = table.node.copy(Fragment.fromArray(rows))
    const from = componentPos + 1 + table.offset
    this.view.dispatch(this.view.state.tr.replaceWith(from, from + table.node.nodeSize, replacement))
    this.dom.querySelector('.strata-screenshot-status')?.remove()
  }

  private activatePin(pin: number, origin?: HTMLElement): void {
    const originBounds = origin?.getBoundingClientRect()
    this.activePin = pin
    this.sessionState.activePin = pin
    this.dom.dataset.activePin = String(pin)
    this.updateActivePinPresentation()
    const pinData = this.screenshotPins().find((entry) => entry.pin === pin)
    const row = pinData ? this.screenshotRows()[pinData.row] : undefined
    const note = row?.querySelector('td:last-child')
    if (!note) return
    const image = firstImageSource(this.node)
    const componentPosition = this.getPos()
    let componentOrdinal = -1
    let seen = 0
    if (componentPosition !== undefined) {
      this.view.state.doc.forEach((node, position) => {
        if (node.type !== strataSchema.nodes.component_block) return
        if (position === componentPosition) componentOrdinal = seen
        seen += 1
      })
    }
    if (this.onDiscuss && componentOrdinal >= 0 && image) {
      const bounds = originBounds ?? note.getBoundingClientRect()
      const request = { componentOrdinal, pin, image, left: bounds.left + bounds.width / 2, top: bounds.bottom }
      setTimeout(() => this.onDiscuss?.(request), 0)
    }
  }

  private contentActivated(event: Event): void {
    if (this.name() === 'EvidenceChain') {
      const target = event.target instanceof Element ? event.target.closest('h3, p, li') : null
      this.evidenceActive = target !== null
      this.sessionState.evidenceActive = this.evidenceActive
      this.dom.toggleAttribute('data-evidence-active', this.evidenceActive)
    }
    if (this.name() === 'AnnotatedScreenshot' && event.target instanceof Element) {
      const row = event.target.closest<HTMLTableRowElement>('tbody tr')
      if (row) {
        const index = this.screenshotRows().indexOf(row)
        const pin = this.screenshotPins().find((entry) => entry.row === index)?.pin
        if (pin !== undefined) {
          this.activePin = pin
          this.sessionState.activePin = pin
          this.decorateScreenshot()
        }
      }
    }
  }

}

export function createComponentNodeView(
  documentPath: string,
  resolveImage: LocalImageResolver,
  onDiscuss?: (request: ScreenshotPinDiscussionRequest) => void,
): NodeViewConstructor {
  const states = new Map<string, ComponentSessionState>()
  return (node, view, getPos) => {
    const key = typeof node.attrs.sourceId === 'string' ? node.attrs.sourceId : `${node.attrs.name}:${getPos() ?? 'unknown'}`
    const state = states.get(key) ?? {}
    states.set(key, state)
    return new ComponentNodeView(node, view, getPos, documentPath, resolveImage, state, onDiscuss)
  }
}
