import { baseKeymap, selectAll } from 'prosemirror-commands'
import { closeHistory, history, isHistoryTransaction, redo, redoDepth, undo, undoDepth } from 'prosemirror-history'
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { Fragment, type Mark, type Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorState, NodeSelection, Selection, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { tableEditing } from 'prosemirror-tables'
import { EditorView } from 'prosemirror-view'
import type { AnnotationView, BufferOrigin, HeadingReference, HunkView, RedoResult, TableViewState, UndoResult } from '../shared/contracts.js'
import type { EditorCommand } from '../renderer/components/Toolbar.js'
import {
  createAnnotationPlugin,
  ANNOTATION_RANGES_META,
  getAnnotationRanges,
  locateAnnotationAnchor,
  setAnnotationRanges,
  getActiveAnnotation,
  setActiveAnnotation,
  setAnnotationFlash,
  type AnnotationRange,
} from './annotations.js'
import { createEditorCommands, createEditorKeymap, handleTaskCheckboxClick } from './commands.js'
import { createFindPlugin, FIND_CURRENT_CLASS, FIND_MATCH_CLASS, findInText, findResultOf, firstMatchFrom, getFindState, NO_MATCHES, setFind, stepMatch, type FindMatch, type FindResult } from './find.js'
import { createLocalImageNodeViews, ImageInspectionManager, resolveImageThroughMainProtocol, type ImageInspectionState, type LocalImageResolver } from './images.js'
import {
  parseMarkdownForEditor,
  serializeEditorDocument,
  updateParsedMarkdown,
} from './markdown.js'
import { markdownClipboardTextParser } from './paste.js'
import { openEditorPopover, type PopoverHandle } from './popover.js'
import {
  createReviewPlugin,
  REVIEW_RANGES_META,
  getReviewRanges,
  isReviewControlActivationKey,
  locateSourceAnnotationQuote,
  locateSourceReviewInsertion,
  localizeReviewChange,
  reviewControlLabel,
  sourceOffsetForLine,
  setReviewFlash,
  setReviewRanges,
  type ReviewRange,
} from './review.js'
import { strataSchema } from './schema.js'
import { editorRangeForSource, sourceRangeIsSingleBlock, sourceSelectionForEditor, wordRangeAt } from './selection.js'
import { createSourceSpanPlugin } from './source-spans.js'
import type { ColdEditorState, EditorMode, EditorRestoreState, EditorSelection, ParsedEditorMarkdown, StrataEditorHandle } from './types.js'
import { CHAIN_HISTORY_META, LocalHistoryChain } from './local-history.js'
import { EditorUndoCoordinator, replaceDocumentProgrammatically } from './undo.js'
import { hasOnlyPrimaryModifier, hasPrimaryModifier, isMacLike } from '../shared/primary-modifier.js'
import { createHeadingPlugin, headingsForState, headingUpdateDurationForState, type EditorHeading } from './headings.js'
import { TableNodeViewManager, tableReferencesForDocument, type TableDiscussionRequest } from './tables.js'
import { createCodeBlockNodeView, type VisualCodeBlockSessions } from './code-blocks.js'
import { FoldingManager } from './folding.js'
import { createReferencePreviewPlugin, ReferencePreviewController, type LocalMarkdownResolver } from './references.js'
import { createComponentNodeView, type ScreenshotPinDiscussionRequest } from './components.js'

export * from './annotations.js'
export * from './commands.js'
export * from './find.js'
export * from './headings.js'
export * from './images.js'
export * from './code-blocks.js'
export * from './folding.js'
export * from './references.js'
export * from './local-history.js'
export * from './markdown.js'
export * from './paste.js'
export * from './popover.js'
export * from './review.js'
export * from './schema.js'
export * from './selection.js'
export * from './source-spans.js'
export * from './tables.js'
export * from './types.js'
export * from './undo.js'
export * from './components.js'

export interface StrataEditorOptions {
  content: string
  sourceMode?: boolean
  readOnly?: boolean
  pendingHunks?: readonly (ReviewRange | HunkView)[]
  annotations?: readonly (AnnotationRange | AnnotationView)[]
  onChange?(markdown: string, origin: BufferOrigin): void
  onSelection?(selection: EditorSelection | null): void
  onOpenAnnotation?(id: string): void
  /** The user dragged an annotation handle; the range is an exact markdown slice of the current buffer. */
  onAdjustAnnotation?(id: string, range: EditorSelection): void
  onKeepHunk?(id: string): void
  onRevertHunk?(id: string): void
  onAcceptSuggestion?(id: string): void
  onRejectSuggestion?(id: string): void
  onSave?(): void
  onSend?(): void
  /** Undo or redo the newest application step in main; resolves with main's answer. */
  onUndo?(): Promise<UndoResult> | UndoResult
  onRedo?(): Promise<RedoResult> | RedoResult
  historyStep?: number
  /** State exported by a previous editor for the same document. */
  restore?: EditorRestoreState
  /** Cold record for a document whose editor was evicted; ignored when `restore` is present. */
  restoreCold?: ColdEditorState
  onToggleSource?(source: boolean): void
  /** Coalesced projection from the live ProseMirror tree plus the heading at the reading line. */
  onHeadings?(headings: readonly EditorHeading[], activeId: string | null, durationMs: number): void
  tableViews?: readonly TableViewState[]
  focusedTable?: string | null
  onTableView?(state: TableViewState): void
  onTableFocus?(tableKey: string | null): void
  documentPath?: string
  resolveLocalImage?: LocalImageResolver
  visualCodeSessions?: VisualCodeBlockSessions
  imageInspectionState?: ImageInspectionState
  foldedHeadings?: readonly HeadingReference[]
  onFold?(heading: HeadingReference, folded: boolean): void
  resolveLocalMarkdown?: LocalMarkdownResolver
  onOpenLocalMarkdown?(path: string): void
}

function editorInputRules() {
  const nodes = strataSchema.nodes
  return inputRules({ rules: [
    textblockTypeInputRule(/^(#{1,6})\s$/u, nodes.heading, (match) => ({
      level: match[1]?.length ?? 1,
      style: 'atx',
      sourceId: null,
      sourceFrom: null,
      sourceTo: null,
    })),
    textblockTypeInputRule(/^```([\w-]*)\s$/u, nodes.code_block, (match) => ({
      fenced: true,
      fence: '`',
      info: match[1] || null,
      meta: null,
      indent: false,
      sourceId: null,
      sourceFrom: null,
      sourceTo: null,
    })),
    wrappingInputRule(/^\s*>\s$/u, nodes.blockquote),
    wrappingInputRule(/^\s*([-+*])\s$/u, nodes.bullet_list, (match) => ({
      marker: match[1] ?? '-',
      tight: true,
      sourceId: null,
      sourceFrom: null,
      sourceTo: null,
    })),
    wrappingInputRule(/^\s*(\d+)([.)])\s$/u, nodes.ordered_list, (match) => ({
      order: Number(match[1]),
      marker: match[2] ?? '.',
      delimiter: match[2] ?? '.',
      tight: true,
      sourceId: null,
      sourceFrom: null,
      sourceTo: null,
    })),
    new InputRule(/^(?:---|___|\*\*\*)\s$/u, (state, _match, start, end) => {
      const $start = state.doc.resolve(start)
      if (!$start.parent.isTextblock) return null
      const transaction = state.tr.replaceWith(
        $start.before(),
        $start.after(),
        Fragment.fromArray([nodes.horizontal_rule.create(), nodes.paragraph.create()]),
      )
      return transaction.setSelection(TextSelection.near(
        transaction.doc.resolve(Math.min($start.before() + 2, transaction.doc.content.size)),
      ))
    }),
  ] })
}

function locateText(doc: ProseMirrorNode, quote: string): { from: number; to: number } | null {
  return quote ? locateAnnotationAnchor(doc, { quote }) : null
}

function positionForLine(doc: ProseMirrorNode, line: number): number {
  let currentLine = 1
  let result = 1
  doc.descendants((node, pos, parent) => {
    if (currentLine >= line) return false
    if (node.isText) {
      for (const match of node.text?.matchAll(/\n/gu) ?? []) {
        currentLine += 1
        result = pos + (match.index ?? 0) + 1
        if (currentLine >= line) return false
      }
    } else if ((node.type.name === 'soft_break' || node.type.name === 'hard_break') || node.isBlock && parent === doc && pos > 0) {
      currentLine += 1
      result = pos
    }
    return currentLine < line
  })
  return Math.max(0, Math.min(result, doc.content.size))
}

function reviewInputs(inputs: readonly (ReviewRange | HunkView)[], doc: ProseMirrorNode, parsedMarkdown?: ParsedEditorMarkdown): ReviewRange[] {
  return inputs.map((input) => {
    if ('kind' in input) {
      const range = input as ReviewRange
      const relocated = range.replacementText ? locateText(doc, range.replacementText) : null
      return relocated ? { ...range, ...relocated } : range
    }
    const added = input.added.join('\n')
    const location = locateText(doc, added)
    const sourceMapped = parsedMarkdown
      ? editorRangeForSource(
          parsedMarkdown,
          doc,
          sourceOffsetForLine(parsedMarkdown.source, input.newStart),
          sourceOffsetForLine(parsedMarkdown.source, input.newStart + Math.max(1, input.newLines)),
        )
      : null
    const from = location?.from ?? sourceMapped?.from ?? positionForLine(doc, input.newStart)
    const to = location?.to ?? sourceMapped?.to ?? from
    return {
      id: input.id,
      from,
      to,
      kind: 'direct',
      status: input.status,
      author: input.author?.name ?? 'external',
      agent: input.author?.id ?? null,
      ...(input.removed.length > 0 ? { deletedText: input.removed.join('\n') } : {}),
      ...(added ? { replacementText: added } : {}),
    }
  })
}

export function annotationInputs(
  inputs: readonly (AnnotationRange | AnnotationView)[],
  doc: ProseMirrorNode,
  parsedMarkdown?: ParsedEditorMarkdown,
): AnnotationRange[] {
  return inputs.flatMap((input) => {
    if (!('seq' in input)) {
      const range = input as AnnotationRange
      const sourceMapped = range.draft
        && parsedMarkdown
        && typeof range.sourceFrom === 'number'
        && typeof range.sourceTo === 'number'
        ? editorRangeForSource(parsedMarkdown, doc, range.sourceFrom, range.sourceTo)
        : null
      const validSourceMapping = sourceMapped && (range.kind !== 'suggestion' || sourceMapped.singleBlock)
        ? sourceMapped
        : null
      const relocated = validSourceMapping ?? locateAnnotationAnchor(doc, range, range.kind)
      return [relocated
        ? { ...range, ...relocated }
        : { ...range, status: 'orphaned' }]
    }
    const view = input as AnnotationView
    if (view.anchor === 'document') return []
    const sourceMapped = parsedMarkdown && typeof view.from === 'number' && typeof view.to === 'number'
      ? editorRangeForSource(parsedMarkdown, doc, view.from, view.to)
      : null
    const validSourceMapping = sourceMapped && (view.kind !== 'suggestion' || sourceMapped.singleBlock)
      ? sourceMapped
      : null
    const located = validSourceMapping ?? locateAnnotationAnchor(doc, { quote: view.quote }, view.kind)
    const from = located?.from ?? 0
    const to = located?.to ?? from
    return [{
      id: view.id,
      kind: view.kind,
      status: located ? view.status : 'orphaned',
      quote: view.quote,
      from,
      to,
      author: view.author === 'user' ? 'user' : view.author.name,
      agent: view.author === 'user' ? null : view.author.id,
      color: view.author === 'user' ? null : view.author.color,
      text: view.replacement ?? view.text,
    }]
  })
}

function dispatchEditorEvent(element: HTMLElement, name: string): void {
  element.dispatchEvent(new CustomEvent(name, { bubbles: true }))
}

/**
 * Browser Selection updates can lag one key event behind a programmatic DOM
 * selection. Read the live DOM range before keymaps run so formatting always
 * targets what the user can see selected, including endpoints inside marks.
 */
function synchronizeDomSelection(view: EditorView): void {
  const domSelection = view.dom.ownerDocument.getSelection()
  const anchorNode = domSelection?.anchorNode
  const focusNode = domSelection?.focusNode
  if (!domSelection || !anchorNode || !focusNode || domSelection.rangeCount === 0) return
  if (!view.dom.contains(anchorNode) || !view.dom.contains(focusNode)) return
  try {
    const anchor = view.posAtDOM(anchorNode, domSelection.anchorOffset)
    const head = view.posAtDOM(focusNode, domSelection.focusOffset)
    if (anchor === view.state.selection.anchor && head === view.state.selection.head) return
    view.dispatch(view.state.tr
      .setSelection(TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head)))
      .setMeta('addToHistory', false))
  } catch {
    // A DOM reconciliation can invalidate a node between selection read and
    // position lookup. ProseMirror's normal selection polling handles it.
  }
}

/** A text selection between two document positions, each nudged to the nearest inline position. */
function textSelectionBetween(doc: ProseMirrorNode, from: number, to = from): Selection {
  const size = doc.content.size
  const $from = doc.resolve(Math.max(0, Math.min(from, size)))
  const $to = doc.resolve(Math.max(0, Math.min(to, size)))
  return TextSelection.between($from, $to)
}

/** The extent of the link mark touching `pos` inside its textblock, or null. */
function linkRangeAt(doc: ProseMirrorNode, pos: number, linkType: Mark['type']): { from: number; to: number; mark: Mark } | null {
  const $pos = doc.resolve(pos)
  const parent = $pos.parent
  if (!parent.isTextblock) return null
  const start = $pos.start()
  const runs: Array<{ from: number; to: number; mark: Mark }> = []
  let offset = 0
  parent.forEach((child) => {
    const from = start + offset
    const to = from + child.nodeSize
    offset += child.nodeSize
    const mark = child.marks.find((candidate) => candidate.type === linkType)
    if (!mark) return
    const last = runs.at(-1)
    if (last && last.to === from && last.mark.eq(mark)) last.to = to
    else runs.push({ from, to, mark })
  })
  return runs.find((run) => run.from <= pos && pos <= run.to) ?? null
}

/** Mount the toolkit-only ProseMirror editor into an uncontrolled DOM host. */
export function createStrataEditor(element: HTMLElement, options: StrataEditorOptions): StrataEditorHandle {
  const cold = options.restore ? undefined : options.restoreCold
  let currentMarkdown = options.restore?.markdown ?? cold?.markdown ?? options.content
  let parsed = options.restore?.parsed ?? parseMarkdownForEditor(currentMarkdown)
  // `parsed` is the open-time parse the byte-preserving serializer needs. Anything
  // that maps markdown offsets to editor positions must use the parse of the
  // markdown those offsets refer to, which after typing is `currentMarkdown`.
  let currentParse = { markdown: currentMarkdown, parsed }
  const parseCurrentMarkdown = (): ParsedEditorMarkdown => {
    if (currentParse.markdown !== currentMarkdown) currentParse = { markdown: currentMarkdown, parsed: updateParsedMarkdown(currentParse.parsed, currentMarkdown) }
    return currentParse.parsed
  }
  let mode: EditorMode = options.sourceMode ? 'source' : 'visual'
  let readOnly = options.readOnly === true
  let suppressChange = false
  let sourceMirrorDirty = true
  const undoCoordinator = options.restore?.coordinator ?? cold?.coordinator ?? new EditorUndoCoordinator()
  const chain = options.restore?.chain
    ?? (cold ? LocalHistoryChain.restore(cold.chain, currentMarkdown) : new LocalHistoryChain(currentMarkdown))
  let sourceReviewInputs = [...(options.pendingHunks ?? [])]
  let sourceAnnotationInputs = [...(options.annotations ?? [])]
  const phase6Enabled = (globalThis as { strataPhase6Disabled?: unknown }).strataPhase6Disabled !== '1'
  const referencePreviewsEnabled = phase6Enabled && Boolean(options.resolveLocalMarkdown && options.onOpenLocalMarkdown)
  const documentPath = options.documentPath ?? element.dataset.documentPath ?? ''
  const foldingManager = new FoldingManager({
    ...(options.foldedHeadings ? { folded: options.foldedHeadings } : {}),
    ...(options.onFold ? { onFold: options.onFold } : {}),
  })

  const visual = document.createElement('div')
  visual.className = 'strata-visual-editor'
  const presentationStyles = document.createElement('style')
  presentationStyles.textContent = `
    @keyframes checkPop {
      0% { transform: scale(0) rotate(-30deg); }
      70% { transform: scale(1.4) rotate(8deg); }
      100% { transform: scale(1) rotate(0); }
    }
    .strata-prosemirror summary[data-frontmatter-chip="true"]::marker { content: ""; }
    .strata-prosemirror summary[data-frontmatter-chip="true"]::-webkit-details-marker { display: none; }
    .strata-review-author--external { background: var(--people-external); color: var(--people-external-text); }
  `
  visual.append(presentationStyles)
  const source = document.createElement('textarea')
  source.className = 'strata-source-editor'
  source.name = 'Source editor'
  source.setAttribute('aria-label', 'Source editor')
  source.spellcheck = false
  source.value = currentMarkdown
  const sourceLayer = document.createElement('div')
  sourceLayer.className = 'strata-source-layer'
  const sourceMirror = document.createElement('pre')
  sourceMirror.className = 'strata-source-mirror'
  sourceMirror.setAttribute('aria-hidden', 'true')
  // Find matches in source view live on their own layer so they never displace
  // a review highlight that shares the same bytes.
  const sourceFind = document.createElement('pre')
  sourceFind.className = 'strata-source-mirror strata-source-find'
  sourceFind.setAttribute('aria-hidden', 'true')
  sourceFind.hidden = true
  sourceLayer.append(sourceMirror, sourceFind, source)
  const sourceActions = document.createElement('div')
  sourceActions.className = 'strata-source-review-actions'
  sourceActions.setAttribute('role', 'group')
  sourceActions.setAttribute('aria-label', 'Source review actions')
  element.replaceChildren(visual, sourceLayer, sourceActions)

  let view: EditorView
  const commands = createEditorCommands()
  const run = (command: Command): void => { command(view.state, view.dispatch, view) }

  const save = (): void => {
    if (options.onSave) options.onSave()
    else dispatchEditorEvent(element, 'stratamd:save')
  }
  const send = (): void => {
    if (options.onSend) options.onSend()
    else dispatchEditorEvent(element, 'stratamd:send')
  }
  const toggleFromKey = (): void => {
    const next = mode !== 'source'
    handle.toggleSource(next)
    options.onToggleSource?.(next)
    dispatchEditorEvent(element, 'stratamd:toggle-source')
  }
  // The link and image forms (§2.8). One at a time; closing returns focus to the editor.
  let popover: PopoverHandle | null = null
  const closePopover = (): void => {
    popover?.close()
    popover = null
  }
  const finishPopover = (): void => {
    closePopover()
    view.focus()
  }
  const selectionAnchor = () => {
    const { from, to } = view.state.selection
    const start = view.coordsAtPos(from)
    const end = view.coordsAtPos(to)
    return { left: Math.min(start.left, end.left), top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom) }
  }
  const editLink = (): void => {
    if (mode === 'source' || readOnly) return
    closePopover()
    const linkType = strataSchema.marks.link
    const { from, to, empty } = view.state.selection
    // A caret inside a link edits the whole link; a selection edits its own range.
    const existing = empty
      ? linkRangeAt(view.state.doc, from, linkType)
      : (() => {
          let mark: Mark | null = null
          view.state.doc.nodesBetween(from, to, (node) => {
            if (mark) return false
            mark = node.marks.find((candidate) => candidate.type === linkType) ?? null
            return true
          })
          return mark ? { from, to, mark } : null
        })()
    if (existing && empty) {
      view.dispatch(view.state.tr.setSelection(textSelectionBetween(view.state.doc, existing.from, existing.to)).setMeta('addToHistory', false))
    }
    popover = openEditorPopover(element, {
      title: existing ? 'Edit link' : 'Add link',
      fields: [
        { name: 'href', label: 'Address', value: existing ? String(existing.mark.attrs.href ?? '') : '', placeholder: 'https://…' },
        { name: 'title', label: 'Title (optional)', value: existing ? String(existing.mark.attrs.title ?? '') : '' },
      ],
      submitLabel: existing ? 'Update link' : 'Add link',
      ...(existing ? { secondary: { label: 'Remove link', onClick: () => { run(commands.removeLink); finishPopover() } } } : {}),
      anchor: selectionAnchor(),
      onSubmit: ({ href, title }) => {
        const target = (href ?? '').trim()
        const caption = (title ?? '').trim() || null
        if (!target) {
          if (existing) run(commands.removeLink)
        } else if (view.state.selection.empty) {
          // Nothing selected: the address becomes the link text.
          const mark = linkType.create({ href: target, title: caption, autolink: false, reference: null })
          view.dispatch(view.state.tr.replaceSelectionWith(strataSchema.text(target, [mark]), false).scrollIntoView())
        } else {
          run(commands.setLink(target, caption))
        }
        finishPopover()
      },
      onCancel: finishPopover,
    })
  }
  const editImage = (): void => {
    if (mode === 'source' || readOnly) return
    closePopover()
    const selection = view.state.selection
    const image = selection instanceof NodeSelection && selection.node.type === strataSchema.nodes.image ? selection.node : null
    popover = openEditorPopover(element, {
      title: image ? 'Edit image' : 'Add image',
      fields: [
        { name: 'src', label: 'Path or address', value: image ? String(image.attrs.src ?? '') : '', placeholder: 'images/figure.png' },
        { name: 'alt', label: 'Alt text', value: image ? String(image.attrs.alt ?? '') : '' },
        { name: 'title', label: 'Title (optional)', value: image ? String(image.attrs.title ?? '') : '' },
      ],
      submitLabel: image ? 'Update image' : 'Add image',
      anchor: selectionAnchor(),
      onSubmit: ({ src, alt, title }) => {
        const source = (src ?? '').trim()
        if (source) {
          const attrs = { src: source, alt: (alt ?? '').trim() || null, title: (title ?? '').trim() || null }
          run(image ? commands.updateSelectedImage(attrs) : commands.insertImage(attrs))
        }
        finishPopover()
      },
      onCancel: finishPopover,
    })
  }
  /** Move the source caret to the first byte that changed. */
  const placeSourceCaret = (before: string, after: string): void => {
    if (mode !== 'source') return
    let index = 0
    const limit = Math.min(before.length, after.length)
    while (index < limit && before.charCodeAt(index) === after.charCodeAt(index)) index += 1
    source.setSelectionRange(index, index)
  }
  /** Replay a chain entry: the path for local entries prosemirror-history no longer holds. */
  const applyChainStep = (direction: 'undo' | 'redo'): boolean => {
    if (view.composing) return false
    const result = direction === 'undo' ? chain.undoStep(currentMarkdown) : chain.redoStep(currentMarkdown)
    if (result.status === 'empty') return false
    if (result.status === 'invalid') {
      console.error('StrataMD undo: the splice chain no longer matches the buffer and was dropped')
      return false
    }
    const before = currentMarkdown
    const nextParsed = updateParsedMarkdown(currentParse.parsed, result.text)
    const reviews = reviewInputs(getReviewRanges(view.state), nextParsed.doc)
    const annotations = annotationInputs(getAnnotationRanges(view.state), nextParsed.doc, nextParsed)
    let transaction = replaceDocumentProgrammatically(view.state.tr, nextParsed.doc)
    transaction = setReviewRanges(transaction, reviews)
    transaction = setAnnotationRanges(transaction, annotations)
    transaction.setMeta(CHAIN_HISTORY_META, true)
    suppressChange = true
    currentMarkdown = result.text
    view.dispatch(transaction)
    suppressChange = false
    parsed = nextParsed
    currentParse = { markdown: result.text, parsed: nextParsed }
    source.value = result.text
    renderSourceMirror()
    if (mode === 'source') {
      placeSourceCaret(before, result.text)
    } else {
      const at = Math.max(0, Math.min(result.changedAt, result.text.length))
      const mapped = editorRangeForSource(nextParsed, view.state.doc, at, Math.min(at + 1, result.text.length))
      if (mapped) {
        view.dispatch(view.state.tr
          .setSelection(textSelectionBetween(view.state.doc, mapped.from))
          .scrollIntoView()
          .setMeta('addToHistory', false))
      }
    }
    options.onChange?.(result.text, 'history')
    return true
  }
  const runHistory = (direction: 'undo' | 'redo'): boolean => {
    flushSourceReparse()
    const entry = direction === 'undo' ? undoCoordinator.takeUndo() : undoCoordinator.takeRedo()
    if (entry === undefined) return false
    if (entry === 'local') {
      // prosemirror-history holds the newest local entries; the chain holds the
      // rest. The redo stack's order is authoritative: a chain-applied entry on
      // top must replay before prosemirror-history's own redo (its entries sit
      // below by the undo routing order).
      const top = chain.redoTop()
      const throughEditor = direction === 'undo'
        ? (undoDepth(view.state) as number) > 0
        : (redoDepth(view.state) as number) > 0 && (top === undefined || top.viaPM)
      if (throughEditor) {
        const before = currentMarkdown
        const command = direction === 'undo' ? undo : redo
        undoCoordinator.settle(command(view.state, view.dispatch))
        placeSourceCaret(before, currentMarkdown)
        return true
      }
      undoCoordinator.settle(applyChainStep(direction))
      return true
    }
    const callback = direction === 'undo' ? options.onUndo : options.onRedo
    const expected = direction === 'undo' ? 'undone' : 'redone'
    Promise.resolve()
      .then(() => callback?.())
      .then((result) => undoCoordinator.settle(result === expected), () => undoCoordinator.settle(false))
    return true
  }
  const undoStep = (): boolean => runHistory('undo')
  const redoStep = (): boolean => runHistory('redo')

  const makeState = (doc: ProseMirrorNode, reviews: readonly (ReviewRange | HunkView)[], annotations: readonly (AnnotationRange | AnnotationView)[]) => EditorState.create({
    schema: strataSchema,
    doc,
    plugins: [
      history(),
      editorInputRules(),
      keymap(createEditorKeymap({
        save,
        send,
        toggleSource: toggleFromKey,
        editLink,
        undo: undoStep,
        redo: redoStep,
      })),
      keymap(baseKeymap),
      tableEditing(),
      createSourceSpanPlugin(),
      createHeadingPlugin(),
      ...(phase6Enabled ? [foldingManager.plugin()] : []),
      ...(referencePreviewsEnabled ? [createReferencePreviewPlugin()] : []),
      createReviewPlugin(reviewInputs(reviews, doc, parsed), {
        ...(options.onKeepHunk ? { onKeep: options.onKeepHunk } : {}),
        ...(options.onRevertHunk ? { onRevert: options.onRevertHunk } : {}),
      }),
      createAnnotationPlugin(annotationInputs(annotations, doc, parsed), {
        ...(options.onOpenAnnotation ? { onOpen: options.onOpenAnnotation } : {}),
        ...(options.onAcceptSuggestion ? { onAccept: options.onAcceptSuggestion } : {}),
        ...(options.onRejectSuggestion ? { onReject: options.onRejectSuggestion } : {}),
        onAdjust: (id, from, to) => adjustAnnotation(id, from, to),
      }),
      createFindPlugin(),
    ],
  })

  // Whether the latest selection came from the pointer or the keyboard (§5.1):
  // the annotate pill's bare C/Q/S keys act only on pointer selections, so a
  // Shift+Arrow selection keeps typing-to-replace. A programmatic selection
  // with no input before it counts as pointer.
  let keyboardSelection = false
  const reportSelection = (explicit = false): void => {
    if (!options.onSelection) return
    const { from, to, empty } = view.state.selection
    if (empty) {
      options.onSelection(null)
      return
    }
    const selection = sourceSelectionForEditor(
      parseCurrentMarkdown(),
      view.state.doc,
      from,
      to,
    )
    if (!selection) {
      options.onSelection(null)
      return
    }
    const start = view.coordsAtPos(from)
    const end = view.coordsAtPos(to)
    options.onSelection({
      ...selection,
      left: (start.left + end.right) / 2,
      top: Math.min(start.top, end.top),
      pointer: explicit || !keyboardSelection,
      ...(explicit ? { explicit } : {}),
    })
  }

  /**
   * Right-click annotates without dragging: the word under the cursor becomes
   * the selection. Every mutation is deferred to a macrotask: microtasks run
   * inside the contextmenu dispatch, and any DOM change before Blink finishes
   * building the context-menu params (which carry the spelling suggestions,
   * docs/plans/completed/spellcheck-plan.md) blanks those params.
   */
  const selectWordForContextMenu = (editorView: EditorView, event: MouseEvent): boolean => {
    const clicked = editorView.posAtCoords({ left: event.clientX, top: event.clientY })
    if (!clicked) return false
    const { selection } = editorView.state
    if (!selection.empty && clicked.pos >= selection.from && clicked.pos <= selection.to) {
      setTimeout(() => reportSelection(true), 0)
      return true
    }
    const resolved = editorView.state.doc.resolve(clicked.pos)
    if (!resolved.parent.isTextblock) return false
    // The one-character leaf text keeps string indexes equal to content offsets.
    const text = resolved.parent.textBetween(0, resolved.parent.content.size, '\n', '￼')
    const range = wordRangeAt(text, resolved.parentOffset)
    if (!range) return false
    const start = resolved.start()
    setTimeout(() => {
      const doc = editorView.state.doc
      const from = Math.min(start + range.from, doc.content.size)
      const to = Math.min(start + range.to, doc.content.size)
      editorView.dispatch(editorView.state.tr.setSelection(textSelectionBetween(doc, from, to)))
      editorView.focus()
      reportSelection(true)
    }, 0)
    return true
  }

  const adjustAnnotation = (id: string, from: number, to: number): void => {
    const snapBack = (): void => {
      view.dispatch(setAnnotationRanges(view.state.tr, annotationInputs(sourceAnnotationInputs, view.state.doc, parseCurrentMarkdown())))
    }
    const range = getAnnotationRanges(view.state).find((candidate) => candidate.id === id)
    const selection = sourceSelectionForEditor(parseCurrentMarkdown(), view.state.doc, from, to)
    if (!range || !selection || !options.onAdjustAnnotation || (range.kind === 'suggestion' && !selection.singleBlock)) {
      snapBack()
      return
    }
    const start = view.coordsAtPos(from)
    const end = view.coordsAtPos(to)
    options.onAdjustAnnotation(id, { ...selection, left: (start.left + end.right) / 2, top: Math.min(start.top, end.top) })
  }

  const imageInspection = new ImageInspectionManager(element, options.imageInspectionState ?? { activeKey: null, zoom: 1, panX: 0, panY: 0 })
  const imageNodeViews = options.resolveLocalImage
    ? createLocalImageNodeViews(documentPath, options.resolveLocalImage, phase6Enabled ? imageInspection : null)
    : createLocalImageNodeViews(documentPath, undefined, phase6Enabled ? imageInspection : null)
  const referencePreview = referencePreviewsEnabled && options.resolveLocalMarkdown && options.onOpenLocalMarkdown
    ? new ReferencePreviewController(element, options.resolveLocalMarkdown, options.onOpenLocalMarkdown)
    : null
  const tableDiscussion = (request: TableDiscussionRequest): void => {
    const parsedNow = parseCurrentMarkdown()
    let seenTables = -1
    let tableIndex = -1
    view.state.doc.forEach((node, position) => {
      if (node.type.name !== 'table') return
      seenTables += 1
      if (position === request.tablePosition) tableIndex = seenTables
    })
    const parsedTables: ProseMirrorNode[] = []
    parsedNow.doc.forEach((node) => {
      if (node.type.name === 'table') parsedTables.push(node)
    })
    const parsedTable = parsedTables[tableIndex]
    if (!parsedTable || request.row + 1 >= parsedTable.childCount) return
    const row = parsedTable?.child(request.row + 1)
    const from = row?.attrs.sourceFrom
    const to = row?.attrs.sourceTo
    const reference = tableReferencesForDocument(view.state.doc).find((table) => table.position === request.tablePosition)?.reference
    if (typeof from !== 'number' || typeof to !== 'number' || !reference || from < 0 || to <= from || to > currentMarkdown.length) return
    const column = request.kind === 'table-cell'
      ? { index: request.column, label: reference.headers[request.column] ?? `Column ${request.column + 1}` }
      : null
    options.onSelection?.({
      quote: currentMarkdown.slice(from, to),
      from,
      to,
      singleBlock: false,
      left: request.left,
      top: request.top,
      pointer: true,
      explicit: true,
      annotationKind: 'question',
      annotationContext: {
        kind: request.kind,
        heading: reference.headingText,
        columns: reference.headers,
        column,
      },
    })
  }
  const screenshotPinDiscussion = (request: ScreenshotPinDiscussionRequest): void => {
    if (!options.onSelection) return
    const parsedNow = parseCurrentMarkdown()
    const component = parsedNow.blocks.filter((block) => block.node.type === strataSchema.nodes.component_block)[request.componentOrdinal]
    if (!component) return
    let row: { text: string; offset: number } | null = null
    let offset = 0
    for (const line of component.raw.split(/\r\n|\r|\n/u)) {
      const pin = line.match(/^\|\s*(\d+)\s*\|/u)
      if (pin && Number(pin[1]) === request.pin) { row = { text: line, offset }; break }
      offset += line.length + (component.raw.slice(offset + line.length).startsWith('\r\n') ? 2 : 1)
    }
    if (!row) return
    const from = component.span.from + row.offset
    const to = from + row.text.length
    const quote = currentMarkdown.slice(from, to)
    if (!quote) return
    options.onSelection({
      quote,
      from,
      to,
      singleBlock: true,
      left: request.left,
      top: request.top,
      pointer: true,
      explicit: true,
      annotationKind: 'question',
      annotationContext: {
        kind: 'screenshot-pin',
        component: 'AnnotatedScreenshot',
        componentLine: currentMarkdown.slice(0, component.span.from).split('\n').length,
        image: request.image,
        pin: request.pin,
      },
    })
  }
  const tableManager = new TableNodeViewManager({
    ...(options.tableViews ? { states: options.tableViews } : {}),
    ...(options.focusedTable !== undefined ? { focusedTable: options.focusedTable } : {}),
    ...(options.onTableView ? { onState: options.onTableView } : {}),
    ...(options.onTableFocus ? { onFocus: options.onTableFocus } : {}),
    onDiscuss: tableDiscussion,
  })
  const nodeViews = {
    ...imageNodeViews,
    component_block: createComponentNodeView(documentPath, options.resolveLocalImage ?? resolveImageThroughMainProtocol, screenshotPinDiscussion),
    ...(phase6Enabled ? {
      code_block: createCodeBlockNodeView({ sessions: options.visualCodeSessions ?? new Map() }),
      heading: (node: ProseMirrorNode, editorView: EditorView, getPos: () => number | undefined) => foldingManager.createHeading(node, editorView, getPos),
    } : {}),
    table: (node: ProseMirrorNode, editorView: EditorView, getPos: () => number | undefined) => tableManager.create(node, editorView, getPos),
  }
  const freshState = makeState(parsed.doc, options.pendingHunks ?? [], options.annotations ?? [])
  let scheduleHeadings = (): void => undefined
  view = new EditorView(visual, {
    // A restored state keeps its history and plugin fields; the plugins themselves are
    // recreated so their callbacks point at this editor.
    state: options.restore ? options.restore.state.reconfigure({ plugins: freshState.plugins }) : freshState,
    attributes: {
      role: 'textbox',
      'aria-label': 'Document editor',
      'aria-multiline': 'true',
      class: 'strata-prosemirror',
    },
    editable: () => !readOnly,
    nodeViews,
    // Plain text that reads as markdown is inserted as markdown (§5.9).
    clipboardTextParser: (text, $context, plain) => markdownClipboardTextParser(text, $context, plain) ?? undefined as never,
    handleKeyDown(editorView) {
      synchronizeDomSelection(editorView)
      return false
    },
    dispatchTransaction(transaction: Transaction) {
      const transactionStarted = performance.now()
      const depthBefore = undoDepth(view.state) as number
      const next = view.state.apply(transaction)
      if (phase6Enabled && transaction.docChanged && transaction.getMeta('addToHistory') !== false && foldingManager.hasFolds()) {
        foldingManager.revealPosition(next.selection.head)
      }
      view.updateState(next)
      if (transaction.selectionSet) {
        tableManager.restoreWhenSelectionLeaves(next.selection.from)
        if (phase6Enabled && foldingManager.hasFolds()) foldingManager.restoreWhenSelectionLeaves(next.selection.from)
      }
      const rangesChanged = transaction.docChanged
        || transaction.getMeta(REVIEW_RANGES_META) !== undefined
        || transaction.getMeta(ANNOTATION_RANGES_META) !== undefined
      if (rangesChanged) {
        tableManager.setReviewRanges(getReviewRanges(next), getAnnotationRanges(next))
        if (phase6Enabled && foldingManager.hasFolds()) foldingManager.setReviewRanges(getReviewRanges(next), getAnnotationRanges(next))
      }
      if (transaction.docChanged) scheduleHeadings()
      if (phase6Enabled && transaction.docChanged && foldingManager.hasFolds()) foldingManager.documentChanged(next.selection.head)
      const fromHistory = isHistoryTransaction(transaction)
      const depthAfter = undoDepth(next) as number
      if (!fromHistory && depthAfter > depthBefore) undoCoordinator.record('local')
      if (!transaction.docChanged) return
      // Suppressed dispatches (setContent, source input, chain replay) set
      // currentMarkdown to the post-transaction text before dispatching.
      const after = suppressChange ? currentMarkdown : serializeEditorDocument(parsed, next.doc)
      if (transaction.getMeta(CHAIN_HISTORY_META) !== true) {
        let mirrored = true
        if (fromHistory) {
          mirrored = depthAfter < depthBefore ? chain.observeHistoryUndo(after) : chain.observeHistoryRedo(after)
        } else if (transaction.getMeta('addToHistory') === false) {
          chain.observeProgrammatic(after)
        } else if (depthAfter > depthBefore) {
          chain.observeGroupOpen(after)
        } else {
          chain.observeGroupContinue(after)
        }
        if (!mirrored) console.error('StrataMD undo: the splice chain diverged from the editor history and was dropped')
      }
      if (suppressChange) return
      currentMarkdown = after
      source.value = currentMarkdown
      renderSourceMirror()
      options.onChange?.(currentMarkdown, fromHistory ? 'history' : 'edit')
      document.documentElement.dataset.editorTransactionMs = (performance.now() - transactionStarted).toFixed(3)
    },
    handleDOMEvents: {
      mousedown: () => { keyboardSelection = false; return false },
      mouseup: () => { keyboardSelection = false; queueMicrotask(reportSelection); return false },
      keyup: () => { queueMicrotask(reportSelection); return false },
      // No preventDefault: the un-prevented default is what makes the main
      // process emit its context-menu event, whose params carry the spelling
      // suggestions (docs/plans/completed/spellcheck-plan.md). Electron shows no menu of its own.
      contextmenu: (editorView, event) => selectWordForContextMenu(editorView, event),
      keydown: (editorView, event) => {
        synchronizeDomSelection(editorView)
        if (referencePreview?.activate(event)) return true
        const mac = isMacLike()
        const documentStart = hasOnlyPrimaryModifier(event)
          && (mac ? event.key === 'ArrowUp' : event.key === 'Home')
        const documentEnd = hasOnlyPrimaryModifier(event)
          && (mac ? event.key === 'ArrowDown' : event.key === 'End')
        if (documentStart || documentEnd) {
          event.preventDefault()
          if (documentEnd && phase6Enabled && foldingManager.hasFolds()) {
            foldingManager.revealPosition(editorView.state.doc.content.size - 1)
          }
          editorView.dispatch(editorView.state.tr.setSelection(
            documentStart ? Selection.atStart(editorView.state.doc) : Selection.atEnd(editorView.state.doc),
          ).scrollIntoView())
          return true
        }
        const headingLineStart = editorView.state.selection.empty
          && !event.shiftKey
          && !event.altKey
          && (mac
            ? hasOnlyPrimaryModifier(event) && event.key === 'ArrowLeft'
            : !event.ctrlKey && !event.metaKey && event.key === 'Home')
        const headingLineEnd = editorView.state.selection.empty
          && !event.shiftKey
          && !event.altKey
          && (mac
            ? hasOnlyPrimaryModifier(event) && event.key === 'ArrowRight'
            : !event.ctrlKey && !event.metaKey && event.key === 'End')
        if ((headingLineStart || headingLineEnd) && editorView.state.selection.$head.parent.type.name === 'heading') {
          event.preventDefault()
          const position = headingLineStart
            ? editorView.state.selection.$head.start()
            : editorView.state.selection.$head.end()
          editorView.dispatch(editorView.state.tr.setSelection(
            TextSelection.create(editorView.state.doc, position),
          ).scrollIntoView())
          return true
        }
        if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End' || event.key === 'PageUp' || event.key === 'PageDown' || (event.key.toLowerCase() === 'a' && hasPrimaryModifier(event))) {
          keyboardSelection = true
        }
        if (!isReviewControlActivationKey(event.key)) return false
        const button = event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>(
              '.strata-review-controls button, .strata-suggestion-controls button',
            )
          : null
        if (!button || button.disabled) return false
        event.preventDefault()
        event.stopPropagation()
        button.click()
        return true
      },
      click: (editorView, event) => referencePreview?.activate(event) || handleTaskCheckboxClick(strataSchema, editorView, event),
    },
  })
  if (phase6Enabled) foldingManager.attach(view)
  tableManager.setReviewRanges(getReviewRanges(view.state), getAnnotationRanges(view.state))
  if (phase6Enabled) foldingManager.setReviewRanges(getReviewRanges(view.state), getAnnotationRanges(view.state))
  let headingFrame: number | null = null
  let lastHeadingSignature = ''
  let lastActiveHeading: string | null = null
  const editorScroll = element.closest<HTMLElement>('.editor-scroll')
  const sourceOffsetRect = (offset: number): DOMRect | null => {
    if (sourceMirrorDirty) renderSourceMirror()
    const walker = document.createTreeWalker(sourceMirror, NodeFilter.SHOW_TEXT)
    let remaining = Math.max(0, Math.min(offset, currentMarkdown.length))
    let last: Text | null = null
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      last = node
      const length = node.data.length
      if (remaining <= length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.collapse(true)
        return range.getBoundingClientRect()
      }
      remaining -= length
    }
    if (!last) return sourceMirror.getBoundingClientRect()
    const range = document.createRange()
    range.setStart(last, last.data.length)
    range.collapse(true)
    return range.getBoundingClientRect()
  }
  const reportHeadings = (): void => {
    headingFrame = null
    if (!options.onHeadings) return
    const started = performance.now()
    const headings = headingsForState(view.state)
    const scrollBounds = editorScroll?.getBoundingClientRect()
    const readingLine = scrollBounds ? scrollBounds.top + scrollBounds.height / 2 : Number.NEGATIVE_INFINITY
    let activeId = headings[0]?.id ?? null
    if (mode === 'visual') {
      const editorBounds = view.dom.getBoundingClientRect()
      const position = view.posAtCoords({ left: editorBounds.left + 8, top: readingLine })?.pos
      if (position !== undefined) {
        for (const heading of headings) {
          if (heading.position <= position) activeId = heading.id
          else break
        }
      }
    } else {
      let low = 0
      let high = headings.length - 1
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const heading = headings[middle]!
        const bounds = heading.sourceFrom === null ? null : sourceOffsetRect(heading.sourceFrom)
        if (bounds && bounds.top <= readingLine) {
          activeId = heading.id
          low = middle + 1
        } else high = middle - 1
      }
    }
    const signature = JSON.stringify(headings.map(({ id, level, text }) => ({ id, level, text })))
    if (signature === lastHeadingSignature && activeId === lastActiveHeading) return
    lastHeadingSignature = signature
    lastActiveHeading = activeId
    options.onHeadings(headings, activeId, headingUpdateDurationForState(view.state) + performance.now() - started)
  }
  scheduleHeadings = (): void => {
    if (headingFrame !== null) return
    headingFrame = window.requestAnimationFrame(reportHeadings)
  }
  const headingScroll = (): void => scheduleHeadings()
  editorScroll?.addEventListener('scroll', headingScroll, { passive: true })
  scheduleHeadings()

  const handleDocumentSelection = (): void => {
    const domSelection = view.dom.ownerDocument.getSelection()
    if (!domSelection?.anchorNode || !domSelection.focusNode) return
    if (!view.dom.contains(domSelection.anchorNode) || !view.dom.contains(domSelection.focusNode)) return
    synchronizeDomSelection(view)
    queueMicrotask(reportSelection)
  }
  view.dom.ownerDocument.addEventListener('selectionchange', handleDocumentSelection)

  const handleSelectedEditorShortcut = (event: KeyboardEvent): void => {
    if (!hasOnlyPrimaryModifier(event) || event.altKey) return
    const domSelection = view.dom.ownerDocument.getSelection()
    if (!domSelection?.anchorNode || !domSelection.focusNode) return
    if (!view.dom.contains(domSelection.anchorNode) || !view.dom.contains(domSelection.focusNode)) return
    synchronizeDomSelection(view)

    const key = event.key.toLowerCase()
    let command: Command | null = null
    if (!event.shiftKey && key === 'b') command = commands.toggleStrong
    else if (!event.shiftKey && key === 'i') command = commands.toggleEmphasis
    else if (event.shiftKey && key === 'c') command = commands.toggleInlineCode
    else if (event.shiftKey && key === '7') command = commands.toggleOrderedList
    else if (event.shiftKey && key === '8') command = commands.toggleBulletList
    else if (!event.shiftKey && /^[1-6]$/u.test(key)) {
      command = commands.setHeading(Number(key) as 1 | 2 | 3 | 4 | 5 | 6)
    }

    if (!command) return
    run(command)
    event.preventDefault()
    event.stopPropagation()
  }
  view.dom.ownerDocument.addEventListener('keydown', handleSelectedEditorShortcut, true)

  const showMode = (): void => {
    visual.hidden = mode === 'source'
    sourceLayer.hidden = mode !== 'source'
    sourceActions.hidden = mode !== 'source' || sourceActions.childElementCount === 0
    if (mode === 'source') source.focus()
  }

  interface SourceHighlight {
    from: number
    to: number
    className: string
    before?: string
    after?: string
  }

  const sourceHighlights = (): SourceHighlight[] => {
    const highlights: SourceHighlight[] = []
    const frontmatter = /^(?:\ufeff)?---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/u.exec(currentMarkdown)
    if (frontmatter) highlights.push({ from: 0, to: frontmatter[0].length, className: 'strata-source-frontmatter' })
    for (const input of sourceReviewInputs) {
      const removed = 'kind' in input ? input.deletedText ?? '' : input.removed.join('\n')
      const added = 'kind' in input ? input.replacementText ?? '' : input.added.join('\n')
      if (!added) continue
      const localized = removed ? localizeReviewChange(removed, added) : null
      const visible = localized?.insertedText || added
      const line = 'kind' in input
        ? (() => {
            const mapped = sourceSelectionForEditor(parsed, view.state.doc, input.from, input.to)
            if (!mapped) return 1
            return currentMarkdown.slice(0, mapped.from).split(/\r?\n/u).length
          })()
        : input.newStart
      const located = locateSourceReviewInsertion(
        currentMarkdown,
        added,
        line,
        localized?.prefixLength ?? 0,
        visible,
      )
      if (!located || !visible) continue
      highlights.push({
        ...located,
        className: 'strata-source-review-insertion',
        ...(localized?.deletedText || removed ? { before: localized?.deletedText || removed } : {}),
      })
    }
    for (const input of sourceAnnotationInputs) {
      if (!('seq' in input) && input.draft) {
        const located = locateSourceAnnotationQuote(currentMarkdown, input.quote, input.from, input.to)
        if (located) highlights.push({ ...located, className: 'strata-source-draft' })
        continue
      }
      if (input.kind !== 'suggestion' || input.status !== 'open') continue
      const located = locateSourceAnnotationQuote(
        currentMarkdown,
        input.quote,
        'seq' in input ? input.from : null,
        'seq' in input ? input.to : null,
      )
      if (!located) continue
      const after = 'seq' in input ? input.replacement ?? input.text : input.text ?? ''
      highlights.push({ ...located, className: 'strata-source-suggestion-deletion', ...(after ? { after } : {}) })
    }
    return highlights.sort((left, right) => left.from - right.from || right.to - left.to)
  }

  const renderSourceMirror = (): void => {
    if (mode !== 'source') {
      sourceMirrorDirty = true
      return
    }
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const highlight of sourceHighlights()) {
      if (highlight.from < cursor || highlight.to <= highlight.from) continue
      if (highlight.from > cursor) fragment.append(document.createTextNode(currentMarkdown.slice(cursor, highlight.from)))
      const span = document.createElement('span')
      span.className = highlight.className
      if (highlight.before) span.dataset.deleted = highlight.before
      if (highlight.after) span.dataset.replacement = highlight.after
      span.textContent = currentMarkdown.slice(highlight.from, highlight.to)
      fragment.append(span)
      cursor = highlight.to
    }
    if (cursor < currentMarkdown.length) fragment.append(document.createTextNode(currentMarkdown.slice(cursor)))
    sourceMirror.replaceChildren(fragment)
    sourceMirrorDirty = false
  }

  const renderSourceActions = (): void => {
    sourceActions.replaceChildren()
    for (const input of sourceReviewInputs) {
      const id = input.id
      const author = 'kind' in input ? input.author : input.author?.name ?? 'external'
      const group = document.createElement('span')
      group.className = 'strata-source-review-action'
      group.dataset.reviewId = id
      const fullRemoved = 'kind' in input ? input.deletedText ?? '' : input.removed.join('\n')
      const fullAdded = 'kind' in input ? input.replacementText ?? '' : input.added.join('\n')
      const localized = fullRemoved && fullAdded ? localizeReviewChange(fullRemoved, fullAdded) : null
      const removed = localized?.deletedText ?? fullRemoved
      const added = localized?.insertedText ?? fullAdded
      if (removed) {
        const deletion = document.createElement('del')
        deletion.textContent = removed
        group.append(deletion)
      }
      if (added) {
        const insertion = document.createElement('ins')
        insertion.textContent = added
        group.append(insertion)
      }
      const badge = document.createElement('span')
      badge.className = 'strata-review-author'
      badge.textContent = author
      group.append(badge)
      for (const [label, callback] of [['Keep', options.onKeepHunk], ['Revert', options.onRevertHunk]] as const) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = label
        button.setAttribute('aria-label', reviewControlLabel(label, 'change', author, fullAdded || fullRemoved))
        button.disabled = readOnly
        if (callback) button.addEventListener('click', () => callback(id))
        group.append(button)
      }
      sourceActions.append(group)
    }
    for (const input of sourceAnnotationInputs) {
      if (!('seq' in input) && input.draft) continue
      if (input.kind !== 'suggestion' || input.status !== 'open') continue
      const group = document.createElement('span')
      group.className = 'strata-source-suggestion-action'
      group.dataset.annotationId = input.id
      const deletion = document.createElement('del')
      deletion.textContent = input.quote
      group.append(deletion)
      const insertion = document.createElement('ins')
      insertion.textContent = 'seq' in input ? input.replacement ?? input.text : input.text ?? ''
      group.append(insertion)
      const suggestionAuthor = 'seq' in input ? input.author === 'user' ? 'you' : input.author.name : input.author || 'external'
      const badge = document.createElement('span')
      badge.className = 'strata-review-author'
      badge.textContent = `${suggestionAuthor} · suggestion`
      group.append(badge)
      for (const [label, callback] of [
        ['Accept', options.onAcceptSuggestion],
        ['Reject', options.onRejectSuggestion],
      ] as const) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = label
        button.setAttribute('aria-label', reviewControlLabel(label, 'suggestion', suggestionAuthor, insertion.textContent || input.quote))
        button.disabled = readOnly
        if (callback) button.addEventListener('click', () => callback(input.id))
        group.append(button)
      }
      sourceActions.append(group)
    }
    sourceActions.hidden = mode !== 'source' || sourceActions.childElementCount === 0
  }

  let sourceKeyboardSelection = false
  const reportSourceSelection = (explicit = false): void => {
    if (!options.onSelection) return
    const from = source.selectionStart
    const to = source.selectionEnd
    if (from === to) {
      options.onSelection(null)
      return
    }
    const bounds = source.getBoundingClientRect()
    options.onSelection({
      quote: source.value.slice(from, to),
      from,
      to,
      singleBlock: sourceRangeIsSingleBlock(parsedForSource(), from, to),
      left: bounds.left + bounds.width / 2,
      top: bounds.top,
      pointer: explicit || !sourceKeyboardSelection,
      ...(explicit ? { explicit } : {}),
    })
  }

  // Source typing reparses on a short trailing timer instead of per keystroke
  // (§5.8); anything that reads the visual document first flushes it.
  const SOURCE_REPARSE_MS = 150
  let sourceReparseTimer: number | null = null
  const reparseSource = (): void => {
    if (currentParse.markdown === currentMarkdown && parsed === currentParse.parsed) return
    const nextParsed = updateParsedMarkdown(currentParse.parsed, currentMarkdown)
    const reviews = reviewInputs(getReviewRanges(view.state), nextParsed.doc).map((range) => {
      const exact = range.replacementText ? locateText(nextParsed.doc, range.replacementText) : null
      return exact ? { ...range, ...exact } : { ...range, status: 'mixed' as const }
    })
    const annotations = annotationInputs(getAnnotationRanges(view.state), nextParsed.doc, nextParsed)
    let transaction = replaceDocumentProgrammatically(view.state.tr, nextParsed.doc, { history: true })
    transaction = setReviewRanges(transaction, reviews)
    transaction = setAnnotationRanges(transaction, annotations)
    suppressChange = true
    view.dispatch(transaction)
    suppressChange = false
    parsed = nextParsed
    currentParse = { markdown: currentMarkdown, parsed: nextParsed }
    // A text-only change (trailing newline, swallowed whitespace) produces no
    // document transaction, so the chain hears about it here.
    chain.syncSourceText(currentMarkdown)
    scheduleHeadings()
  }
  const flushSourceReparse = (): void => {
    if (sourceReparseTimer === null) return
    window.clearTimeout(sourceReparseTimer)
    sourceReparseTimer = null
    reparseSource()
  }
  const parsedForSource = (): ParsedEditorMarkdown => {
    flushSourceReparse()
    return parseCurrentMarkdown()
  }
  source.addEventListener('input', () => {
    currentMarkdown = source.value
    renderSourceMirror()
    if (findQuery) {
      const matches = findInText(currentMarkdown, findQuery)
      findIndex = firstMatchFrom(matches, source.selectionStart)
      renderSourceFind(matches)
    }
    if (sourceReparseTimer !== null) window.clearTimeout(sourceReparseTimer)
    sourceReparseTimer = window.setTimeout(() => { sourceReparseTimer = null; reparseSource() }, SOURCE_REPARSE_MS)
    options.onChange?.(currentMarkdown, 'edit')
  })
  source.addEventListener('mousedown', () => { sourceKeyboardSelection = false })
  source.addEventListener('keydown', (event) => {
    if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End' || (event.key.toLowerCase() === 'a' && hasPrimaryModifier(event))) sourceKeyboardSelection = true
    if (!hasPrimaryModifier(event)) return
    const key = event.key.toLowerCase()
    if (key === 's') { event.preventDefault(); save() }
    else if (event.key === 'Enter') { event.preventDefault(); send() }
    else if (event.key === '/') { event.preventDefault(); toggleFromKey() }
    else if (key === 'z' && !event.shiftKey) { event.preventDefault(); undoStep() }
    else if (key === 'z' || key === 'y') { event.preventDefault(); redoStep() }
  })
  source.addEventListener('mouseup', () => { sourceKeyboardSelection = false; reportSourceSelection() })
  source.addEventListener('keyup', () => reportSourceSelection())
  // The browser has already moved the caret to the click point (or kept the selection).
  source.addEventListener('contextmenu', (event) => {
    if (source.selectionStart === source.selectionEnd) {
      const range = wordRangeAt(source.value, source.selectionStart)
      if (!range) return
      source.setSelectionRange(range.from, range.to)
    }
    event.preventDefault()
    reportSourceSelection(true)
  })

  /** A row click centers the target in the editor (PRD §6.9), not minimally scrolls it. */
  const centerInScrollParent = (position: number): void => {
    let parent: HTMLElement | null = view.dom.parentElement
    while (
      parent &&
      !(parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY))
    ) {
      parent = parent.parentElement
    }
    if (!parent) return
    const coords = view.coordsAtPos(position)
    const bounds = parent.getBoundingClientRect()
    parent.scrollTop += coords.top - bounds.top - parent.clientHeight / 2
  }

  // The flash after a jump is a decoration class (PRD §6.9): a class set on the
  // DOM from outside would be redrawn away by the editor's mutation observer.
  let flashTimer: number | null = null
  const clearFlashes = (transaction: Transaction): Transaction => setAnnotationFlash(setReviewFlash(transaction, null), null)
  const flash = (apply: (transaction: Transaction, id: string | null) => Transaction, id: string): void => {
    if (flashTimer !== null) window.clearTimeout(flashTimer)
    // One ring at a time: the previous target stops before the next starts.
    view.dispatch(apply(clearFlashes(view.state.tr), id))
    flashTimer = window.setTimeout(() => {
      flashTimer = null
      view.dispatch(clearFlashes(view.state.tr))
    }, 900)
  }

  const jump = (from: number, to = from): void => {
    tableManager.revealPosition(from)
    foldingManager.revealPosition(from)
    // A clamp to the document size can land on the doc node itself; `between`
    // nudges each end to the nearest inline position.
    const selection = textSelectionBetween(view.state.doc, from, Math.max(from, to))
    view.dispatch(view.state.tr.setSelection(selection))
    centerInScrollParent(selection.from)
    view.focus()
  }

  // ---- Find (PRD §6.1). One query and one current index serve both views;
  // the visual plugin holds the visual matches, the source layer the raw ones.
  let findQuery = ''
  let findIndex = -1
  const renderSourceFind = (matches: readonly FindMatch[]): void => {
    if (!findQuery || mode !== 'source') {
      sourceFind.hidden = true
      sourceFind.replaceChildren()
      return
    }
    const fragment = document.createDocumentFragment()
    let cursor = 0
    matches.forEach((match, index) => {
      if (match.from > cursor) fragment.append(document.createTextNode(currentMarkdown.slice(cursor, match.from)))
      const span = document.createElement('span')
      span.className = index === findIndex ? `${FIND_MATCH_CLASS} ${FIND_CURRENT_CLASS}` : FIND_MATCH_CLASS
      span.textContent = currentMarkdown.slice(match.from, match.to)
      fragment.append(span)
      cursor = match.to
    })
    if (cursor < currentMarkdown.length) fragment.append(document.createTextNode(currentMarkdown.slice(cursor)))
    sourceFind.replaceChildren(fragment)
    sourceFind.hidden = false
  }
  const revealCurrentMatch = (): void => {
    if (mode === 'visual') {
      const match = currentFindMatches()[findIndex]
      if (match) {
        tableManager.revealPosition(match.from)
        foldingManager.revealPosition(match.from)
      }
    }
    const host = mode === 'source' ? sourceFind : visual
    host.querySelector(`.${FIND_CURRENT_CLASS}`)?.scrollIntoView({ block: 'center' })
  }
  const applyFind = (): FindResult => {
    if (mode === 'source') {
      if (!findQuery) { renderSourceFind([]); return NO_MATCHES }
      const matches = findInText(currentMarkdown, findQuery)
      findIndex = matches.length === 0 ? -1 : Math.max(0, Math.min(matches.length - 1, findIndex))
      renderSourceFind(matches)
      revealCurrentMatch()
      return findResultOf(matches, findIndex)
    }
    view.dispatch(setFind(view.state.tr, findQuery, findIndex))
    const state = getFindState(view.state)
    findIndex = state.current
    revealCurrentMatch()
    return findResultOf(state.matches, findIndex)
  }
  const currentFindMatches = (): readonly FindMatch[] =>
    mode === 'source' ? findInText(currentMarkdown, findQuery) : getFindState(view.state).matches

  /** The markdown offset for a visual caret: the start of the next character, or the end of the previous one. */
  const sourceCaretFor = (pos: number): number | null => {
    const parsedNow = parseCurrentMarkdown()
    const size = view.state.doc.content.size
    const forward = pos < size ? sourceSelectionForEditor(parsedNow, view.state.doc, pos, pos + 1) : null
    if (forward) return forward.from
    const backward = pos > 0 ? sourceSelectionForEditor(parsedNow, view.state.doc, pos - 1, pos) : null
    return backward ? backward.to : null
  }
  /** The visual position for a markdown caret offset, by the same rule. */
  const editorCaretFor = (offset: number): number | null => {
    const parsedNow = parseCurrentMarkdown()
    const forward = offset < currentMarkdown.length ? editorRangeForSource(parsedNow, view.state.doc, offset, offset + 1) : null
    if (forward) return forward.from
    const backward = offset > 0 ? editorRangeForSource(parsedNow, view.state.doc, offset - 1, offset) : null
    return backward ? backward.to : null
  }

  const handle: StrataEditorHandle = {
    find(query) {
      if (query !== findQuery) {
        findQuery = query
        // A new query starts at the first match at or after the caret.
        const caret = mode === 'source' ? source.selectionStart : view.state.selection.from
        const matches = mode === 'source'
          ? findInText(currentMarkdown, query)
          : getFindState(view.state.apply(setFind(view.state.tr, query, 0))).matches
        findIndex = firstMatchFrom(matches, caret)
      }
      return applyFind()
    },
    findStep(direction) {
      const matches = currentFindMatches()
      findIndex = stepMatch(matches.length, findIndex, direction)
      return applyFind()
    },
    closeFind() {
      const matches = currentFindMatches()
      const landing = findIndex >= 0 ? matches[findIndex] : undefined
      findQuery = ''
      findIndex = -1
      // Both views clear, whichever is showing: a view toggle may still be in flight.
      renderSourceFind([])
      if (mode === 'source') {
        if (landing) source.setSelectionRange(landing.from, landing.from)
        source.focus()
        return
      }
      let transaction = setFind(view.state.tr, '', -1)
      // The caret lands on the match; a collapsed selection never opens the annotate menu.
      if (landing) transaction = transaction.setSelection(textSelectionBetween(view.state.doc, landing.from))
      view.dispatch(transaction)
      view.focus()
    },
    setHistoryStep(step) {
      if (undoCoordinator.syncApplicationStep(step)) view.dispatch(closeHistory(view.state.tr))
    },
    exportState: () => {
      flushSourceReparse()
      return {
      state: view.state,
      markdown: currentMarkdown,
      parsed,
      coordinator: undoCoordinator,
      chain,
      sourceCaret: source.selectionStart,
      }
    },
    setContent(markdown) {
      flushSourceReparse()
      if (markdown === currentMarkdown) return
      const nextParsed = updateParsedMarkdown(currentParse.parsed, markdown)
      const reviews = reviewInputs(getReviewRanges(view.state), nextParsed.doc)
      const annotations = annotationInputs(getAnnotationRanges(view.state), nextParsed.doc, nextParsed)
      let transaction = replaceDocumentProgrammatically(view.state.tr, nextParsed.doc)
      transaction = setReviewRanges(transaction, reviews)
      transaction = setAnnotationRanges(transaction, annotations)
      suppressChange = true
      currentMarkdown = markdown
      view.dispatch(transaction)
      suppressChange = false
      parsed = nextParsed
      currentParse = { markdown, parsed: nextParsed }
      // Idempotent when the dispatch already observed it; covers content
      // changes the document representation swallows.
      chain.observeProgrammatic(markdown)
      source.value = markdown
      renderSourceMirror()
      scheduleHeadings()
    },
    setReviewState(ranges) {
      flushSourceReparse()
      sourceReviewInputs = [...ranges]
      view.dispatch(setReviewRanges(view.state.tr, reviewInputs(ranges, view.state.doc, parseCurrentMarkdown())))
      renderSourceMirror()
      renderSourceActions()
    },
    setAnnotations(ranges) {
      flushSourceReparse()
      sourceAnnotationInputs = [...ranges]
      view.dispatch(setAnnotationRanges(view.state.tr, annotationInputs(ranges, view.state.doc, parseCurrentMarkdown())))
      renderSourceMirror()
      renderSourceActions()
    },
    setTableViews(states) {
      tableManager.setStates(states)
    },
    setFoldedHeadings(headings) {
      foldingManager.setFolded(headings)
    },
    setReadOnly(value) {
      readOnly = value
      source.readOnly = value
      view.setProps({ editable: () => !readOnly })
      renderSourceActions()
    },
    getMarkdown: () => mode === 'source' ? source.value : serializeEditorDocument(parsed, view.state.doc),
    getState: () => { flushSourceReparse(); return view.state },
    command(command: string) {
      const headingLevel = (): 1 | 2 | 3 | 4 | 5 | 6 => {
        const parent = view.state.selection.$from.parent
        if (parent.type !== strataSchema.nodes.heading) return 1
        return Math.min(6, Number(parent.attrs.level) + 1) as 1 | 2 | 3 | 4 | 5 | 6
      }
      const commandMap: Partial<Record<EditorCommand, () => void>> = {
        bold: () => run(commands.toggleStrong),
        italic: () => run(commands.toggleEmphasis),
        code: () => run(commands.toggleInlineCode),
        link: editLink,
        'link-autolink': () => run(commands.setAutolink()),
        'link-remove': () => run(commands.removeLink),
        heading: () => run(commands.setHeading(headingLevel())),
        'bullet-list': () => run(commands.toggleBulletList),
        'ordered-list': () => run(commands.toggleOrderedList),
        'list-tight': () => run(commands.setListTight(true)),
        'list-loose': () => run(commands.setListTight(false)),
        'list-indent': () => run(commands.sinkListItem),
        'list-outdent': () => run(commands.liftListItem),
        'task-list': () => run(commands.toggleTaskList),
        blockquote: () => run(commands.toggleBlockquote),
        table: () => run(commands.insertTable()),
        'table-column-before': () => run(commands.table.addColumnBefore),
        'table-column-after': () => run(commands.table.addColumnAfter),
        'table-column-delete': () => run(commands.table.deleteColumn),
        'table-row-before': () => run(commands.table.addRowBefore),
        'table-row-after': () => run(commands.table.addRowAfter),
        'table-row-delete': () => run(commands.table.deleteRow),
        'table-delete': () => run(commands.table.deleteTable),
        'table-merge-cells': () => run(commands.table.mergeCells),
        'table-split-cell': () => run(commands.table.splitCell),
        'table-toggle-header-row': () => run(commands.table.toggleHeaderRow),
        'table-toggle-header-column': () => run(commands.table.toggleHeaderColumn),
        'code-block': () => run(commands.setCodeBlock),
        'indented-code-block': () => run(commands.setIndentedCodeBlock),
        image: editImage,
        'image-update': editImage,
        'horizontal-rule': () => run(commands.insertHorizontalRule),
        'hard-break': () => run(commands.insertHardBreak),
        'soft-break': () => run(commands.insertSoftBreak),
      }
      const requestedHeading = /^heading-([1-6])$/u.exec(command)
      if (requestedHeading) {
        run(commands.setHeading(Number(requestedHeading[1]) as 1 | 2 | 3 | 4 | 5 | 6))
        return
      }
      if (command === 'strikethrough') { run(commands.toggleStrikethrough); return }
      if (command === 'paragraph') { run(commands.setParagraph); return }
      commandMap[command as EditorCommand]?.()
    },
    jumpToHunk(id) {
      const range = getReviewRanges(view.state).find((candidate) => candidate.id === id)
      if (!range) return
      jump(range.from, range.to)
      flash(setReviewFlash, id)
    },
    jumpToAnnotation(id) {
      const range = getAnnotationRanges(view.state).find((candidate) => candidate.id === id)
      if (!range || range.status === 'orphaned') return
      jump(range.from, range.to)
      flash(setAnnotationFlash, id)
    },
    jumpToHeading(id) {
      const heading = headingsForState(view.state).find((candidate) => candidate.id === id)
      if (!heading) return
      if (mode === 'source' && heading.sourceFrom !== null) {
        source.setSelectionRange(heading.sourceFrom, heading.sourceFrom)
        source.focus({ preventScroll: true })
        const target = sourceOffsetRect(heading.sourceFrom)
        const bounds = editorScroll?.getBoundingClientRect()
        if (target && bounds && editorScroll) editorScroll.scrollTop += target.top - bounds.top - bounds.height / 2
      } else {
        jump(heading.position + 1)
      }
      scheduleHeadings()
    },
    headingSource(id) {
      const ordinal = headingsForState(view.state).findIndex((candidate) => candidate.id === id)
      if (ordinal < 0) return null
      const parsedNow = parseCurrentMarkdown()
      let heading: ProseMirrorNode | undefined
      let headingOrdinal = 0
      parsedNow.doc.descendants((node) => {
        if (node.type !== strataSchema.nodes.heading) return
        if (headingOrdinal === ordinal) heading = node
        headingOrdinal += 1
      })
      const from = heading?.attrs.sourceFrom
      const to = heading?.attrs.sourceTo
      if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || to <= from || to > currentMarkdown.length) return null
      return { quote: currentMarkdown.slice(from, to), from, to, atx: heading?.attrs.style === 'atx' }
    },
    setActiveAnnotation(id) {
      if (getActiveAnnotation(view.state) === id) return
      view.dispatch(setActiveAnnotation(view.state.tr, id))
    },
    replaceSelection(text) {
      // The same transaction path as typing, so the buffer, dirtiness, one-step
      // undo, and the splice-chain mirror all follow (docs/plans/completed/spellcheck-plan.md).
      if (mode === 'source' || readOnly || view.state.selection.empty) return
      view.dispatch(view.state.tr.insertText(text))
      view.focus()
    },
    focus: () => mode === 'source' ? source.focus() : view.focus(),
    pasteText(text) {
      if (readOnly) return
      if (mode === 'source') {
        source.setRangeText(text, source.selectionStart, source.selectionEnd, 'end')
        source.dispatchEvent(new Event('input', { bubbles: true }))
        source.focus()
        return
      }
      // The same path as a paste event, so markdown text is parsed as markdown (§5.9).
      view.pasteText(text)
      view.focus()
    },
    selectAll() {
      if (mode === 'source') {
        source.focus()
        source.select()
        reportSourceSelection(true)
        return
      }
      keyboardSelection = false
      run(selectAll)
      view.focus()
      reportSelection(true)
    },
    toggleSource(force) {
      const previous = mode
      mode = force === undefined ? mode === 'source' ? 'visual' : 'source' : force ? 'source' : 'visual'
      if (previous === mode) return mode
      closePopover()
      // The selection follows the view change (§5.8): visual → source maps
      // through the byte-exact selection, source → visual maps back.
      if (mode === 'source') {
        const { from, to, empty } = view.state.selection
        const range = empty ? null : sourceSelectionForEditor(parseCurrentMarkdown(), view.state.doc, from, to)
        const caret = empty ? sourceCaretFor(from) : null
        if (sourceMirrorDirty) renderSourceMirror()
        showMode()
        if (range) source.setSelectionRange(range.from, range.to)
        else if (caret !== null) source.setSelectionRange(caret, caret)
      } else {
        flushSourceReparse()
        const from = source.selectionStart
        const to = source.selectionEnd
        const range = from === to ? null : editorRangeForSource(parseCurrentMarkdown(), view.state.doc, from, to)
        const caret = from === to ? editorCaretFor(from) : null
        showMode()
        const target = range ?? (caret === null ? null : { from: caret, to: caret })
        if (target) {
          view.dispatch(view.state.tr
            .setSelection(textSelectionBetween(view.state.doc, target.from, target.to))
            .scrollIntoView()
            .setMeta('addToHistory', false))
        }
        view.focus()
      }
      if (findQuery && previous !== mode) {
        // The search carries across views; the visual plugin idles while source view owns it.
        if (mode === 'source') view.dispatch(setFind(view.state.tr, '', -1))
        applyFind()
      }
      scheduleHeadings()
      return mode
    },
    destroy() {
      closePopover()
      referencePreview?.destroy()
      imageInspection.destroy()
      foldingManager.destroy()
      flushSourceReparse()
      if (flashTimer !== null) window.clearTimeout(flashTimer)
      if (headingFrame !== null) window.cancelAnimationFrame(headingFrame)
      editorScroll?.removeEventListener('scroll', headingScroll)
      view.dom.ownerDocument.removeEventListener('selectionchange', handleDocumentSelection)
      view.dom.ownerDocument.removeEventListener('keydown', handleSelectedEditorShortcut, true)
      view.destroy()
      element.replaceChildren()
    },
  }

  handle.setReadOnly(readOnly)
  renderSourceMirror()
  renderSourceActions()
  showMode()
  if (cold) {
    source.setSelectionRange(cold.sourceCaret, cold.sourceCaret)
    if (cold.selection) {
      const mapped = editorRangeForSource(parsed, view.state.doc, cold.selection.from, cold.selection.to)
      if (mapped) {
        view.dispatch(view.state.tr
          .setSelection(textSelectionBetween(view.state.doc, mapped.from, mapped.to))
          .setMeta('addToHistory', false))
      }
    }
  }
  return handle
}

/**
 * Convert a warm editor record to its cold form on eviction: the markdown, the
 * splice chain, the coordinator, and where the user was (docs/plans/completed/cold-tab-plan.md §5).
 */
export function toColdEditorState(saved: EditorRestoreState): ColdEditorState {
  const { from, to, empty } = saved.state.selection
  let selection: { from: number; to: number } | null = null
  if (!empty) {
    const parsedForMarkdown = saved.parsed.source === saved.markdown
      ? saved.parsed
      : parseMarkdownForEditor(saved.markdown)
    const mapped = sourceSelectionForEditor(parsedForMarkdown, saved.state.doc, from, to)
    if (mapped) selection = { from: mapped.from, to: mapped.to }
  }
  return {
    markdown: saved.markdown,
    chain: saved.chain.export(),
    coordinator: saved.coordinator,
    selection,
    sourceCaret: saved.sourceCaret,
  }
}
