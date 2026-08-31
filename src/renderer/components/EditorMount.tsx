import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { AnnotationView, HunkView } from '../../shared/contracts'
import type { ColdEditorState, EditorRestoreState } from '../../editor/types'
import { toColdEditorState } from '../../editor/index'
import type { RendererEditorFactory, RendererEditorHandle, RendererEditorOptions } from '../editorAdapter'
import { AGENT_COLORS, EXTERNAL_COLOR, textColorFor, USER_ANNOTATION_COLOR } from '../model'

interface EditorMountProps extends RendererEditorOptions {
  createEditor: RendererEditorFactory
  documentPath: string
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
}

export const EditorMount = forwardRef<RendererEditorHandle, EditorMountProps>(function EditorMount(
  { createEditor, documentPath, ...options }, forwardedRef
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<RendererEditorHandle | null>(null)
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
  const paintDecorations = (hunks: readonly HunkView[], annotations: readonly AnnotationView[]) => {
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
    const annotationColors = new Map(annotations.map((annotation) => [annotation.id, annotation.author === 'user' ? annotation.kind === 'question' ? 'var(--controls-warning)' : USER_ANNOTATION_COLOR : AGENT_COLORS[annotation.author.color]]))
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
    getMarkdown: () => editorRef.current?.getMarkdown() ?? options.content,
    focus: () => editorRef.current?.focus(),
    toggleSource: (source) => editorRef.current?.toggleSource(source),
    command: (command) => editorRef.current?.command?.(command),
    jumpToHunk: (id) => { editorRef.current?.jumpToHunk?.(id); flashTarget('reviewId', id) },
    jumpToAnnotation: (id) => { editorRef.current?.jumpToAnnotation?.(id); flashTarget('annotationId', id) },
    annotationCoordinates: (id) => editorRef.current?.annotationCoordinates?.(id) ?? null,
    setActiveAnnotation: (id) => editorRef.current?.setActiveAnnotation?.(id),
    replaceSelection: (text) => editorRef.current?.replaceSelection?.(text),
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
    const handle = createEditor(host, {
      ...options,
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
      onRedo: () => handlersRef.current.onRedo()
    })
    editorRef.current = handle
    paintDecorations(options.pendingHunks, options.annotations)
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
      savedEditors.set(documentPath, { kind: 'warm', state: handle.exportState(), savedAt: Date.now() })
      evictBeyondLimit()
      handle.destroy()
      editorRef.current = null
      host.replaceChildren()
    }
    // History is per document: it is restored from savedEditors on return and dropped on close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createEditor, documentPath])

  useEffect(() => { editorRef.current?.setContent(options.content) }, [options.content])
  useEffect(() => { editorRef.current?.setHistoryStep(options.historyStep) }, [options.historyStep])
  useEffect(() => { editorRef.current?.setReviewState(options.pendingHunks); paintDecorations(options.pendingHunks, options.annotations) }, [options.pendingHunks])
  useEffect(() => { editorRef.current?.setAnnotations(options.annotations); paintDecorations(options.pendingHunks, options.annotations) }, [options.annotations])
  useEffect(() => { editorRef.current?.toggleSource(options.sourceMode) }, [options.sourceMode])
  useEffect(() => { editorRef.current?.setReadOnly?.(options.readOnly) }, [options.readOnly])

  return <div ref={hostRef} className="prosemirror-host" data-prosemirror-host data-document-path={documentPath} />
})

export function annotationAt(annotations: AnnotationView[], id: string): AnnotationView | undefined {
  return annotations.find((annotation) => annotation.id === id)
}

export function hunkAt(hunks: HunkView[], id: string): HunkView | undefined {
  return hunks.find((hunk) => hunk.id === id)
}
