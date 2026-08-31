import { baseKeymap } from 'prosemirror-commands'
import { closeHistory, history, isHistoryTransaction, redo, redoDepth, undo, undoDepth } from 'prosemirror-history'
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { Fragment, type Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorState, NodeSelection, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { tableEditing } from 'prosemirror-tables'
import { EditorView } from 'prosemirror-view'
import type { AnnotationView, BufferOrigin, HunkView, RedoResult, UndoResult } from '../shared/contracts.js'
import type { EditorCommand } from '../renderer/components/Toolbar.js'
import {
  createAnnotationPlugin,
  getAnnotationRanges,
  locateAnnotationAnchor,
  setAnnotationRanges,
  getActiveAnnotation,
  setActiveAnnotation,
  type AnnotationRange,
} from './annotations.js'
import { createEditorCommands, createEditorKeymap, handleTaskCheckboxClick } from './commands.js'
import { createLocalImageNodeViews, type LocalImageResolver } from './images.js'
import {
  parseMarkdownForEditor,
  serializeEditorDocument,
  updateParsedMarkdown,
} from './markdown.js'
import {
  createReviewPlugin,
  getReviewRanges,
  isReviewControlActivationKey,
  locateSourceAnnotationQuote,
  locateSourceReviewInsertion,
  localizeReviewChange,
  setReviewRanges,
  type ReviewRange,
} from './review.js'
import { strataSchema } from './schema.js'
import { editorRangeForSource, sourceRangeIsSingleBlock, sourceSelectionForEditor, wordRangeAt } from './selection.js'
import { createSourceSpanPlugin } from './source-spans.js'
import type { ColdEditorState, EditorMode, EditorRestoreState, EditorSelection, ParsedEditorMarkdown, StrataEditorHandle } from './types.js'
import { CHAIN_HISTORY_META, LocalHistoryChain } from './local-history.js'
import { EditorUndoCoordinator, replaceDocumentProgrammatically } from './undo.js'
import { hasOnlyPrimaryModifier, hasPrimaryModifier } from '../shared/primary-modifier.js'

export * from './annotations.js'
export * from './commands.js'
export * from './images.js'
export * from './local-history.js'
export * from './markdown.js'
export * from './review.js'
export * from './schema.js'
export * from './selection.js'
export * from './source-spans.js'
export * from './types.js'
export * from './undo.js'

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
  documentPath?: string
  resolveLocalImage?: LocalImageResolver
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

function reviewInputs(inputs: readonly (ReviewRange | HunkView)[], doc: ProseMirrorNode): ReviewRange[] {
  return inputs.map((input) => {
    if ('kind' in input) {
      const range = input as ReviewRange
      const relocated = range.replacementText ? locateText(doc, range.replacementText) : null
      return relocated ? { ...range, ...relocated } : range
    }
    const added = input.added.join('\n')
    const location = locateText(doc, added)
    const from = location?.from ?? positionForLine(doc, input.newStart)
    const to = location?.to ?? from
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

function annotationInputs(
  inputs: readonly (AnnotationRange | AnnotationView)[],
  doc: ProseMirrorNode,
  parsedMarkdown?: ParsedEditorMarkdown,
): AnnotationRange[] {
  return inputs.map((input) => {
    if (!('seq' in input)) {
      const range = input as AnnotationRange
      const relocated = locateAnnotationAnchor(doc, range, range.kind)
      return relocated
        ? { ...range, ...relocated }
        : { ...range, status: 'orphaned' }
    }
    const view = input as AnnotationView
    const sourceMapped = parsedMarkdown && typeof view.from === 'number' && typeof view.to === 'number'
      ? editorRangeForSource(parsedMarkdown, doc, view.from, view.to)
      : null
    const validSourceMapping = sourceMapped && (view.kind !== 'suggestion' || sourceMapped.singleBlock)
      ? sourceMapped
      : null
    const located = validSourceMapping ?? locateAnnotationAnchor(doc, { quote: view.quote }, view.kind)
    const from = located?.from ?? 0
    const to = located?.to ?? from
    return {
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
    }
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
      .setSelection(TextSelection.create(view.state.doc, anchor, head))
      .setMeta('addToHistory', false))
  } catch {
    // A DOM reconciliation can invalidate a node between selection read and
    // position lookup. ProseMirror's normal selection polling handles it.
  }
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
  sourceLayer.append(sourceMirror, source)
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
  const editLink = (): void => {
    const href = window.prompt('Link URL')
    if (href !== null) run(commands.setLink(href))
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
          .setSelection(TextSelection.create(view.state.doc, mapped.from))
          .scrollIntoView()
          .setMeta('addToHistory', false))
      }
    }
    options.onChange?.(result.text, 'history')
    return true
  }
  const runHistory = (direction: 'undo' | 'redo'): boolean => {
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
      createReviewPlugin(reviewInputs(reviews, doc), {
        ...(options.onKeepHunk ? { onKeep: options.onKeepHunk } : {}),
        ...(options.onRevertHunk ? { onRevert: options.onRevertHunk } : {}),
      }),
      createAnnotationPlugin(annotationInputs(annotations, doc, parsed), {
        ...(options.onOpenAnnotation ? { onOpen: options.onOpenAnnotation } : {}),
        ...(options.onAcceptSuggestion ? { onAccept: options.onAcceptSuggestion } : {}),
        ...(options.onRejectSuggestion ? { onReject: options.onRejectSuggestion } : {}),
        onAdjust: (id, from, to) => adjustAnnotation(id, from, to),
      }),
    ],
  })

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
      editorView.dispatch(editorView.state.tr.setSelection(TextSelection.create(doc, from, to)))
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

  const documentPath = options.documentPath ?? element.dataset.documentPath ?? ''
  const nodeViews = options.resolveLocalImage
    ? createLocalImageNodeViews(documentPath, options.resolveLocalImage)
    : createLocalImageNodeViews(documentPath)
  const freshState = makeState(parsed.doc, options.pendingHunks ?? [], options.annotations ?? [])
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
    handleKeyDown(editorView) {
      synchronizeDomSelection(editorView)
      return false
    },
    dispatchTransaction(transaction: Transaction) {
      const depthBefore = undoDepth(view.state) as number
      const next = view.state.apply(transaction)
      view.updateState(next)
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
    },
    handleDOMEvents: {
      mouseup: () => { queueMicrotask(reportSelection); return false },
      keyup: () => { queueMicrotask(reportSelection); return false },
      // No preventDefault: the un-prevented default is what makes the main
      // process emit its context-menu event, whose params carry the spelling
      // suggestions (docs/plans/completed/spellcheck-plan.md). Electron shows no menu of its own.
      contextmenu: (editorView, event) => selectWordForContextMenu(editorView, event),
      keydown: (_editorView, event) => {
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
      click: (editorView, event) => handleTaskCheckboxClick(strataSchema, editorView, event),
    },
  })

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
        button.setAttribute('aria-label', `${label} change ${id}`)
        button.disabled = readOnly
        if (callback) button.addEventListener('click', () => callback(id))
        group.append(button)
      }
      sourceActions.append(group)
    }
    for (const input of sourceAnnotationInputs) {
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
      const badge = document.createElement('span')
      badge.className = 'strata-review-author'
      badge.textContent = `${'seq' in input ? input.author === 'user' ? 'you' : input.author.name : input.author || 'external'} · suggestion`
      group.append(badge)
      for (const [label, callback] of [
        ['Accept', options.onAcceptSuggestion],
        ['Reject', options.onRejectSuggestion],
      ] as const) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = label
        button.setAttribute('aria-label', `${label} suggestion ${input.id}`)
        button.disabled = readOnly
        if (callback) button.addEventListener('click', () => callback(input.id))
        group.append(button)
      }
      sourceActions.append(group)
    }
    sourceActions.hidden = mode !== 'source' || sourceActions.childElementCount === 0
  }

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
      singleBlock: sourceRangeIsSingleBlock(parseMarkdownForEditor(source.value), from, to),
      left: bounds.left + bounds.width / 2,
      top: bounds.top,
      ...(explicit ? { explicit } : {}),
    })
  }

  source.addEventListener('input', () => {
    currentMarkdown = source.value
    renderSourceMirror()
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
    options.onChange?.(currentMarkdown, 'edit')
  })
  source.addEventListener('keydown', (event) => {
    if (!hasPrimaryModifier(event)) return
    const key = event.key.toLowerCase()
    if (key === 's') { event.preventDefault(); save() }
    else if (event.key === 'Enter') { event.preventDefault(); send() }
    else if (event.key === '/') { event.preventDefault(); toggleFromKey() }
    else if (key === 'z' && !event.shiftKey) { event.preventDefault(); undoStep() }
    else if (key === 'z' || key === 'y') { event.preventDefault(); redoStep() }
  })
  source.addEventListener('mouseup', () => reportSourceSelection())
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

  const jump = (from: number, to = from): void => {
    const boundedFrom = Math.max(0, Math.min(from, view.state.doc.content.size))
    const boundedTo = Math.max(boundedFrom, Math.min(to, view.state.doc.content.size))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, boundedFrom, boundedTo)))
    centerInScrollParent(boundedFrom)
    view.focus()
  }

  const handle: StrataEditorHandle = {
    setHistoryStep(step) {
      if (undoCoordinator.syncApplicationStep(step)) view.dispatch(closeHistory(view.state.tr))
    },
    exportState: () => ({
      state: view.state,
      markdown: currentMarkdown,
      parsed,
      coordinator: undoCoordinator,
      chain,
      sourceCaret: source.selectionStart,
    }),
    setContent(markdown) {
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
    },
    setReviewState(ranges) {
      sourceReviewInputs = [...ranges]
      view.dispatch(setReviewRanges(view.state.tr, reviewInputs(ranges, view.state.doc)))
      renderSourceMirror()
      renderSourceActions()
    },
    setAnnotations(ranges) {
      sourceAnnotationInputs = [...ranges]
      view.dispatch(setAnnotationRanges(view.state.tr, annotationInputs(ranges, view.state.doc, parseCurrentMarkdown())))
      renderSourceMirror()
      renderSourceActions()
    },
    setReadOnly(value) {
      readOnly = value
      source.readOnly = value
      view.setProps({ editable: () => !readOnly })
      renderSourceActions()
    },
    getMarkdown: () => mode === 'source' ? source.value : serializeEditorDocument(parsed, view.state.doc),
    getState: () => view.state,
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
        image: () => {
          const src = window.prompt('Image path')
          if (src !== null) run(commands.insertImage({ src }))
        },
        'image-update': () => {
          const selection = view.state.selection
          if (!(selection instanceof NodeSelection) || selection.node.type !== strataSchema.nodes.image) return
          const src = window.prompt('Image path', String(selection.node.attrs.src ?? ''))
          if (src === null) return
          const alt = window.prompt('Alternative text', String(selection.node.attrs.alt ?? ''))
          if (alt === null) return
          const title = window.prompt('Image title', String(selection.node.attrs.title ?? ''))
          if (title === null) return
          run(commands.updateSelectedImage({ src, alt: alt || null, title: title || null }))
        },
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
      if (range) jump(range.from, range.to)
    },
    jumpToAnnotation(id) {
      const range = getAnnotationRanges(view.state).find((candidate) => candidate.id === id)
      if (range && range.status !== 'orphaned') jump(range.from, range.to)
    },
    annotationCoordinates(id) {
      const range = getAnnotationRanges(view.state).find((candidate) => candidate.id === id)
      if (!range || range.status === 'orphaned' || mode === 'source') return null
      const size = view.state.doc.content.size
      const from = Math.max(0, Math.min(range.from, size))
      const to = Math.max(from, Math.min(range.to, size))
      const start = view.coordsAtPos(from)
      const end = view.coordsAtPos(to)
      return {
        left: Math.min(start.left, end.left),
        top: Math.min(start.top, end.top),
        right: Math.max(start.right, end.right),
        bottom: Math.max(start.bottom, end.bottom),
      }
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
    toggleSource(force) {
      mode = force === undefined ? mode === 'source' ? 'visual' : 'source' : force ? 'source' : 'visual'
      if (mode === 'source' && sourceMirrorDirty) renderSourceMirror()
      showMode()
      return mode
    },
    destroy() {
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
          .setSelection(TextSelection.create(view.state.doc, mapped.from, mapped.to))
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
