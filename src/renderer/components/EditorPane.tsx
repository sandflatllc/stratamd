import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { AnnotationKind, AnnotationView, BufferOrigin, DocumentView, HunkView, PanelSize, RedoResult, SpellingContext, UndoResult } from '../../shared/contracts'
import type { EditorSelection, RendererEditorFactory, RendererEditorHandle } from '../editorAdapter'
import { bannerFor, currentAnnotation } from '../model'
import { AnnotationComposer } from './AnnotationComposer'
import { AmbientDecor } from './AmbientDecor'
import { EditorMount } from './EditorMount'
import { Resizer } from './Resizer'
import { ThreadPanel, type SpanAnchor } from './ThreadPanel'
import { Toolbar, type EditorCommand } from './Toolbar'

interface EditorPaneProps {
  document: DocumentView
  documentMeasure: number
  zoom: number
  threadPanelSize: PanelSize
  composerSize: PanelSize
  createEditor: RendererEditorFactory
  onDocumentMeasure(value: number, commit: boolean): void
  onThreadPanelSize(size: PanelSize, commit: boolean): void
  onComposerSize(size: PanelSize, commit: boolean): void
  onBufferChange(content: string, origin: BufferOrigin): void
  onToggleSource(source: boolean): void
  onSave(): void
  onUndo(): Promise<UndoResult>
  onRedo(): Promise<RedoResult>
  onKeepHunk(id: string): void
  onRevertHunk(hunk: HunkView): void
  onAddAnnotation(kind: AnnotationKind, quote: string, text: string, from: number, to: number): void
  onAdjustAnnotation(id: string, quote: string, from: number, to: number): void
  onReply(id: string, text: string): void
  onResolve(id: string): void
  onAccept(id: string): void
  onReject(id: string): void
  selectedAnnotation: AnnotationView | null
  onSelectAnnotation(annotation: AnnotationView | null): void
  jumpHunkId: string | null
  jumpAnnotationId: string | null
}

/** Scroll offsets per open document, so returning to a tab lands where the user left it. */
const savedScroll = new Map<string, { pane: number; source: number }>()

/** Drop scroll offsets for documents that are no longer open. */
export function forgetClosedScroll(openPaths: ReadonlySet<string>): void {
  for (const path of savedScroll.keys()) if (!openPaths.has(path)) savedScroll.delete(path)
}

export function EditorPane(props: EditorPaneProps) {
  const { document } = props
  const [selection, setSelection] = useState<EditorSelection | null>(null)
  const [spelling, setSpelling] = useState<SpellingContext | null>(null)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const editor = useRef<RendererEditorHandle | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const dismissedSelection = useRef<string | null>(null)
  const banner = bannerDismissed ? null : bannerFor(document)
  const selectedAnnotation = currentAnnotation(document, props.selectedAnnotation)
  const command = (next: EditorCommand) => editor.current?.command?.(next)
  const dismissComposer = () => {
    dismissedSelection.current = selection ? `${selection.from}:${selection.to}` : null
    setSelection(null)
    setSpelling(null)
    window.requestAnimationFrame(() => editor.current?.focus())
  }
  // The pill opens synchronously on right-click; the misspelling and its
  // suggestions land one IPC hop later and attach by exact word match.
  useEffect(() => window.strata.onSpelling?.(setSpelling), [])
  useEffect(() => { setBannerDismissed(false) }, [document.path, document.deleted, document.invalidUtf8])
  // Offsets are recorded live on scroll; teardown ordering would otherwise
  // read a collapsed container.
  useEffect(() => {
    const node = scroll.current
    if (!node) return
    const sourceNode = node.querySelector<HTMLTextAreaElement>('.strata-source-editor')
    const offsets = savedScroll.get(document.path) ?? { pane: 0, source: 0 }
    savedScroll.set(document.path, offsets)
    // A rebuilt editor can still be filling in below this effect, in which
    // case the browser clamps the restored offset against a short pane and it
    // silently lands at 0. Reapply as the pane grows until the offset sticks;
    // any real interaction means the user has taken over, so stop.
    let restoreTarget: number | null = offsets.pane > 0 ? offsets.pane : null
    const observer = new ResizeObserver(() => {
      if (restoreTarget === null) return
      node.scrollTop = restoreTarget
      if (node.scrollTop >= restoreTarget) settle()
    })
    const settle = () => {
      restoreTarget = null
      observer.disconnect()
      node.removeEventListener('wheel', settle)
      node.removeEventListener('mousedown', settle)
      node.removeEventListener('touchstart', settle)
      node.removeEventListener('keydown', settle)
    }
    node.scrollTop = offsets.pane
    if (sourceNode) sourceNode.scrollTop = offsets.source
    if (restoreTarget !== null && node.scrollTop >= restoreTarget) restoreTarget = null
    if (restoreTarget !== null) {
      for (const child of node.children) observer.observe(child)
      node.addEventListener('wheel', settle, { passive: true })
      node.addEventListener('mousedown', settle)
      node.addEventListener('touchstart', settle, { passive: true })
      node.addEventListener('keydown', settle)
    }
    const recordPane = () => { if (restoreTarget === null) offsets.pane = node.scrollTop }
    const recordSource = () => { if (sourceNode) offsets.source = sourceNode.scrollTop }
    node.addEventListener('scroll', recordPane, { passive: true })
    sourceNode?.addEventListener('scroll', recordSource, { passive: true })
    return () => {
      settle()
      node.removeEventListener('scroll', recordPane)
      sourceNode?.removeEventListener('scroll', recordSource)
    }
  }, [document.path])
  useEffect(() => { if (props.jumpHunkId) editor.current?.jumpToHunk?.(props.jumpHunkId) }, [props.jumpHunkId])
  useEffect(() => { if (props.jumpAnnotationId) editor.current?.jumpToAnnotation?.(props.jumpAnnotationId) }, [props.jumpAnnotationId])
  const activeAnnotationId = selectedAnnotation?.status === 'open' ? selectedAnnotation.id : null
  useEffect(() => { editor.current?.setActiveAnnotation?.(activeAnnotationId) }, [activeAnnotationId])
  // One-shot coordinate query at open time, after the jump effect above has
  // centered the span; a movable panel needs no live anchor tracking.
  const [thread, setThread] = useState<{ id: string; anchor: SpanAnchor | null; fallback: { x: number; y: number } } | null>(null)
  const selectedId = selectedAnnotation?.id ?? null
  useEffect(() => {
    if (selectedId === null) {
      setThread(null)
      return
    }
    const bounds = scroll.current?.getBoundingClientRect()
    setThread({
      id: selectedId,
      anchor: editor.current?.annotationCoordinates?.(selectedId) ?? null,
      fallback: bounds
        ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    })
  }, [selectedId, props.jumpAnnotationId])
  return (
    <main className="editor-island island" data-pane="editor" style={{ '--zoom': props.zoom } as CSSProperties}>
      <AmbientDecor variant="editor" />
      <Toolbar source={document.sourceMode} sourceOnly={document.sourceOnly} readOnly={document.readOnly} dirty={document.dirty} onCommand={command} onToggleSource={() => props.onToggleSource(!document.sourceMode)} onSave={props.onSave} />
      {banner && (
        <div className={`banner banner-${banner.tone}`} role="status">
          <span>{banner.text}</span>
          <button type="button" aria-label="Dismiss banner" onClick={() => setBannerDismissed(true)}>×</button>
        </div>
      )}
      <div className="editor-scroll" ref={scroll}>
        <div className="document-column" style={{ width: `min(${props.documentMeasure}px, 100%)` }}>
          <Resizer axis="vertical" label="Resize document measure" value={props.documentMeasure} min={620} max={1600} onChange={(value) => props.onDocumentMeasure(value, false)} onCommit={(value) => props.onDocumentMeasure(value, true)} />
          <EditorMount
            key={document.path}
            ref={editor}
            createEditor={props.createEditor}
            documentPath={document.path}
            content={document.content}
            sourceMode={document.sourceMode}
            readOnly={document.readOnly}
            pendingHunks={document.pendingHunks}
            annotations={document.annotations}
            historyStep={document.historyStep}
            onChange={props.onBufferChange}
            onSelection={(next) => {
              const selectionKey = next ? `${next.from}:${next.to}` : null
              if (!next?.explicit && selectionKey !== null && selectionKey === dismissedSelection.current) return
              dismissedSelection.current = null
              if (!next || !scroll.current) { setSelection(next); return }
              const bounds = scroll.current.getBoundingClientRect()
              setSelection({ ...next, left: next.left - bounds.left + scroll.current.scrollLeft, top: next.top - bounds.top + scroll.current.scrollTop })
            }}
            onOpenAnnotation={(id) => props.onSelectAnnotation(document.annotations.find((item) => item.id === id) ?? null)}
            onAdjustAnnotation={(id, range) => props.onAdjustAnnotation(id, range.quote, range.from, range.to)}
            onKeepHunk={props.onKeepHunk}
            onRevertHunk={(id) => { const hunk = document.pendingHunks.find((item) => item.id === id); if (hunk) props.onRevertHunk(hunk) }}
            onAcceptSuggestion={props.onAccept}
            onRejectSuggestion={props.onReject}
            onUndo={props.onUndo}
            onRedo={props.onRedo}
            resolveLocalImage={async ({ source }) => {
              const url = await window.strata.resolveLocalImage(document.path, source)
              return url ? { url } : null
            }}
          />
        </div>
        <AnnotationComposer
          selection={selection}
          spelling={spelling}
          size={props.composerSize}
          zoom={props.zoom}
          onSize={props.onComposerSize}
          onDismiss={dismissComposer}
          onSubmit={(kind, text) => {
            if (!selection) return
            props.onAddAnnotation(kind, selection.quote, text, selection.from, selection.to)
            dismissComposer()
          }}
          onReplaceWord={(suggestion) => {
            editor.current?.replaceSelection?.(suggestion)
            setSpelling(null)
            setSelection(null)
          }}
          onAddToDictionary={(word) => {
            // The pill stays open for annotation; the learned word's underline clears on its own.
            void window.strata.addDictionaryWord?.(word)
            setSpelling(null)
          }}
        />
      </div>
      {selectedAnnotation && thread && thread.id === selectedAnnotation.id && createPortal(
        <ThreadPanel
          key={selectedAnnotation.id}
          annotation={selectedAnnotation}
          anchor={thread.anchor}
          fallbackCenter={thread.fallback}
          size={props.threadPanelSize}
          zoom={props.zoom}
          onSize={props.onThreadPanelSize}
          onReply={(text) => props.onReply(selectedAnnotation.id, text)}
          onResolve={() => props.onResolve(selectedAnnotation.id)}
          onClose={() => props.onSelectAnnotation(null)}
        />,
        // The panel floats over every island; inside the editor island the
        // rail's own stacking context would paint on top of it.
        globalThis.document.querySelector('.app-shell') ?? globalThis.document.body,
      )}
    </main>
  )
}
