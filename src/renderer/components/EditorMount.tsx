import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { AnnotationView, DraftView, HunkView } from '../../shared/contracts'
import type { AnnotationRange } from '../../editor/annotations'
import type { ColdEditorState, EditorRestoreState } from '../../editor/types'
import type { ImageInspectionState } from '../../editor/images'
import type { VisualCodeBlockSessions } from '../../editor/code-blocks'
import { toColdEditorState } from '../../editor/index'
import type { RendererEditorFactory, RendererEditorHandle, RendererEditorOptions } from '../editorAdapter'
import { AGENT_COLORS, EXTERNAL_COLOR, textColorFor, USER_ANNOTATION_COLOR } from '../model'
import { forgetFlushed, lastFlushedContent, peekPendingBuffer } from '../pendingBuffer'

interface EditorMountProps extends RendererEditorOptions {
  createEditor: RendererEditorFactory
  documentPath: string
  drafts: DraftView[]
}

export function draftRanges(drafts: readonly DraftView[]): AnnotationRange[] {
  return drafts.map((draft) => ({
    id: draft.id,
    kind: draft.kind,
    status: draft.status === 'attached' ? 'open' : 'orphaned',
    quote: draft.quote,
    prefix: draft.prefix,
    suffix: draft.suffix,
    from: draft.from ?? 0,
    to: draft.to ?? 0,
    sourceFrom: draft.from,
    sourceTo: draft.to,
    author: 'user',
    text: draft.text,
    draft: true,
  }))
}

type SavedEditor =
  | { kind: 'warm'; state: EditorRestoreState; savedAt: number }
  | { kind: 'cold'; state: ColdEditorState }

/**
 * Per open document: the recent tabs keep their complete editor for instant
 * switching; older tabs keep a cold record and rebuild by reparse
 * (docs/plans/completed/cold-tab-plan.md §5). History survives a tab switch either way.
 */
const savedEditors = new Map<string, SavedEditor>()
const focusedTables = new Map<string, string | null>()
const visualCodeBlocks = new Map<string, VisualCodeBlockSessions>()
const inspectedImages = new Map<string, ImageInspectionState>()

/** Warm editors kept beyond the mounted tab; STRATAMD_EDITOR_CACHE overrides for tests and A/B runs. */
const CACHE_LIMIT = (() => {
  const raw = (globalThis as { strataEditorCache?: unknown }).strataEditorCache
  const value = typeof raw === 'string' && raw !== '' ? Number(raw) : Number.NaN
  return Number.isInteger(value) && value >= 0 ? value : 3
})()

function evictBeyondLimit(): void {
  const warm = [...savedEditors]
    .filter((entry): entry is [string, Extract<SavedEditor, { kind: 'warm' }>] => entry[1].kind === 'warm')
    .sort((left, right) => left[1].savedAt - right[1].savedAt)
  for (const [path, saved] of warm.slice(0, Math.max(0, warm.length - CACHE_LIMIT))) {
    savedEditors.set(path, { kind: 'cold', state: toColdEditorState(saved.state) })
  }
}

/** Drop saved editor state for documents that are no longer open. */
export function forgetClosedEditors(openPaths: ReadonlySet<string>): void {
  for (const path of savedEditors.keys()) if (!openPaths.has(path)) savedEditors.delete(path)
  for (const path of focusedTables.keys()) if (!openPaths.has(path)) focusedTables.delete(path)
  for (const path of visualCodeBlocks.keys()) if (!openPaths.has(path)) visualCodeBlocks.delete(path)
  for (const path of inspectedImages.keys()) if (!openPaths.has(path)) inspectedImages.delete(path)
  forgetFlushed(openPaths)
}

export const EditorMount = forwardRef<RendererEditorHandle, EditorMountProps>(function EditorMount(
  { createEditor, documentPath, drafts, ...options }, forwardedRef
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<RendererEditorHandle | null>(null)
  const sourceIntent = useRef<{ owner: RendererEditorHandle | null; source: boolean } | null>(null)
  const handlersRef = useRef(options)
  handlersRef.current = options
  const flashTarget = (attribute: 'reviewId' | 'annotationId', id: string) => {
    const host = hostRef.current
    if (!host) return
    const selector = attribute === 'reviewId' ? '[data-review-id]' : '[data-annotation-id]'
    const matches = [...host.querySelectorAll<HTMLElement>(selector)].filter((node) => node.dataset[attribute] === id)
    for (const node of matches) node.classList.remove('is-flashing')
    const target = matches.find((node) => node.matches(attribute === 'reviewId' ? '.strata-review-change' : '.strata-annotation')) ?? matches[0]
    if (!target) return
    void target.offsetWidth
    target.classList.add('is-flashing')
  }
  const paintDecorations = (hunks: readonly HunkView[], annotations: readonly (AnnotationView | AnnotationRange)[]) => {
    const host = hostRef.current
    if (!host) return
    const hunkColors = new Map(hunks.map((hunk) => [hunk.id, hunk.author ? AGENT_COLORS[hunk.author.color] : EXTERNAL_COLOR]))
    for (const node of host.querySelectorAll<HTMLElement>('[data-review-id]')) {
      const color = node.dataset.reviewId ? hunkColors.get(node.dataset.reviewId) : undefined
      if (color) {
        const resolved = node.classList.contains('strata-review-external') ? EXTERNAL_COLOR : color
        node.style.setProperty('--review-color', resolved)
        node.style.setProperty('--review-color-text', textColorFor(resolved))
      }
    }
    const annotationColors = new Map(annotations.map((annotation) => [annotation.id, annotation.author === 'user'
      ? annotation.kind === 'question' ? 'var(--controls-warning)' : USER_ANNOTATION_COLOR
      : typeof annotation.author === 'string' ? ('color' in annotation ? annotation.color ?? undefined : USER_ANNOTATION_COLOR) : AGENT_COLORS[annotation.author.color]]))
    for (const node of host.querySelectorAll<HTMLElement>('[data-annotation-id]')) {
      const color = node.dataset.annotationId ? annotationColors.get(node.dataset.annotationId) : undefined
      if (color) {
        node.style.setProperty('--strata-annotation-color', color)
        node.style.setProperty('--review-color-text', textColorFor(color))
      }
    }
  }

  useImperativeHandle(forwardedRef, () => ({
    setContent: (content) => editorRef.current?.setContent(content),
    setHistoryStep: (step) => editorRef.current?.setHistoryStep(step),
    exportState: () => editorRef.current!.exportState(),
    setReviewState: (hunks) => editorRef.current?.setReviewState(hunks),
    setAnnotations: (annotations) => editorRef.current?.setAnnotations(annotations),
    setTableViews: (states) => editorRef.current?.setTableViews(states),
    setFoldedHeadings: (headings) => editorRef.current?.setFoldedHeadings(headings),
    getMarkdown: () => editorRef.current?.getMarkdown() ?? options.content,
    focus: () => editorRef.current?.focus(),
    toggleSource: (source) => editorRef.current?.toggleSource(source),
    command: (command) => editorRef.current?.command?.(command),
    // The editor rings the target itself, as a decoration that survives its redraws.
    jumpToHunk: (id) => editorRef.current?.jumpToHunk?.(id),
    jumpToAnnotation: (id) => editorRef.current?.jumpToAnnotation?.(id),
    jumpToHeading: (id) => editorRef.current?.jumpToHeading?.(id),
    headingSource: (id) => editorRef.current?.headingSource?.(id) ?? null,
    setActiveAnnotation: (id) => editorRef.current?.setActiveAnnotation?.(id),
    replaceSelection: (text) => editorRef.current?.replaceSelection?.(text),
    pasteText: (text) => editorRef.current?.pasteText?.(text),
    selectAll: () => editorRef.current?.selectAll?.(),
    find: (query) => editorRef.current?.find?.(query) ?? { count: 0, current: 0 },
    findStep: (direction) => editorRef.current?.findStep?.(direction) ?? { count: 0, current: 0 },
    closeFind: () => editorRef.current?.closeFind?.(),
    destroy: () => editorRef.current?.destroy()
  }), [documentPath, options.content])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const timers = new Set<number>()
    const flashAndRun = (attribute: 'reviewId' | 'annotationId', id: string, run: () => void) => {
      flashTarget(attribute, id)
      const timer = window.setTimeout(() => { timers.delete(timer); run() }, 260)
      timers.add(timer)
    }
    const saved = savedEditors.get(documentPath)
    savedEditors.delete(documentPath)
    const annotations = [...options.annotations, ...draftRanges(drafts)]
    const handle = createEditor(host, {
      ...options,
      annotations,
      ...(saved?.kind === 'warm' ? { restore: saved.state } : {}),
      ...(saved?.kind === 'cold' ? { restoreCold: saved.state, content: saved.state.markdown } : {}),
      onChange: (content, origin) => handlersRef.current.onChange(content, origin),
      onSelection: (selection) => handlersRef.current.onSelection(selection),
      onOpenAnnotation: (id) => handlersRef.current.onOpenAnnotation(id),
      onAdjustAnnotation: (id, range) => handlersRef.current.onAdjustAnnotation(id, range),
      onKeepHunk: (id) => flashAndRun('reviewId', id, () => handlersRef.current.onKeepHunk(id)),
      onRevertHunk: (id) => flashAndRun('reviewId', id, () => handlersRef.current.onRevertHunk(id)),
      onAcceptSuggestion: (id) => flashAndRun('annotationId', id, () => handlersRef.current.onAcceptSuggestion(id)),
      onRejectSuggestion: (id) => flashAndRun('annotationId', id, () => handlersRef.current.onRejectSuggestion(id)),
      onUndo: () => handlersRef.current.onUndo(),
      onRedo: () => handlersRef.current.onRedo(),
      onToggleSource: (source) => {
        const intent = { owner: editorRef.current, source }
        const persist = handlersRef.current.onToggleSource
        // Persisted mode echoes can repeat an older matching value. Keep the
        // newest local mode authoritative until that exact request settles.
        sourceIntent.current = intent
        const finish = (saved: boolean) => {
          if (sourceIntent.current !== intent || editorRef.current !== intent.owner) return
          sourceIntent.current = null
          if (saved) intent.owner?.toggleSource(source)
          else intent.owner?.toggleSource(handlersRef.current.sourceMode)
        }
        try {
          const request = persist(source)
          if (request === undefined) {
            if (sourceIntent.current === intent && editorRef.current === intent.owner) sourceIntent.current = null
            return
          }
          void request.then(() => finish(true), () => finish(false))
        } catch {
          finish(false)
        }
      },
      onHeadings: (headings, activeId, durationMs) => handlersRef.current.onHeadings(headings, activeId, durationMs),
      onTableView: (state) => handlersRef.current.onTableView(state),
      focusedTable: focusedTables.get(documentPath) ?? null,
      onTableFocus: (tableKey) => focusedTables.set(documentPath, tableKey),
      visualCodeSessions: visualCodeBlocks.get(documentPath) ?? (() => {
        const sessions: VisualCodeBlockSessions = new Map()
        visualCodeBlocks.set(documentPath, sessions)
        return sessions
      })(),
      imageInspectionState: inspectedImages.get(documentPath) ?? (() => {
        const state: ImageInspectionState = { activeKey: null, zoom: 1, panX: 0, panY: 0 }
        inspectedImages.set(documentPath, state)
        return state
      })(),
    })
    editorRef.current = handle
    paintDecorations(options.pendingHunks, options.annotations)
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
      savedEditors.set(documentPath, { kind: 'warm', state: handle.exportState(), savedAt: Date.now() })
      evictBeyondLimit()
      if (sourceIntent.current?.owner === handle) sourceIntent.current = null
      handle.destroy()
      editorRef.current = null
      host.replaceChildren()
    }
    // History is per document: it is restored from savedEditors on return and dropped on close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createEditor, documentPath])

  // A pushed view that merely echoes what this editor already sent (or an
  // older flush while newer typing waits) must not replace the editor's text:
  // that is how keystrokes typed across a flush boundary were lost (§5.3).
  useEffect(() => {
    if (peekPendingBuffer()?.path === documentPath) return
    if (lastFlushedContent(documentPath) === options.content) return
    editorRef.current?.setContent(options.content)
  }, [options.content])
  useEffect(() => { editorRef.current?.setHistoryStep(options.historyStep) }, [options.historyStep])
  useEffect(() => { editorRef.current?.setReviewState(options.pendingHunks); paintDecorations(options.pendingHunks, options.annotations) }, [options.pendingHunks])
  useEffect(() => { editorRef.current?.setAnnotations([...options.annotations, ...draftRanges(drafts)]); paintDecorations(options.pendingHunks, options.annotations) }, [drafts, options.annotations])
  useEffect(() => { editorRef.current?.setTableViews(options.tableViews) }, [options.tableViews])
  useEffect(() => { editorRef.current?.setFoldedHeadings(options.foldedHeadings) }, [options.foldedHeadings])
  useEffect(() => {
    if (sourceIntent.current !== null) return
    editorRef.current?.toggleSource(options.sourceMode)
  }, [options.sourceMode])
  useEffect(() => { editorRef.current?.setReadOnly?.(options.readOnly) }, [options.readOnly])

  return <div ref={hostRef} className="prosemirror-host" data-prosemirror-host data-document-path={documentPath} />
})

export function annotationAt(annotations: AnnotationView[], id: string): AnnotationView | undefined {
  return annotations.find((annotation) => annotation.id === id)
}

export function hunkAt(hunks: HunkView[], id: string): HunkView | undefined {
  return hunks.find((hunk) => hunk.id === id)
}
