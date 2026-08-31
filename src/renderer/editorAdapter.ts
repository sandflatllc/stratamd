import type { LocalImageRequest, ResolvedLocalImage } from '../editor/images'
import type { ColdEditorState, EditorRestoreState } from '../editor/types'
import type { AnnotationView, BufferOrigin, HunkView, RedoResult, UndoResult } from '../shared/contracts'
import type { EditorCommand } from './components/Toolbar'

export interface EditorSelection {
  quote: string
  from: number
  to: number
  singleBlock: boolean
  left: number
  top: number
  /** Set on a right-click selection, which must show the menu even for a just-dismissed range. */
  explicit?: boolean
}

export interface RendererEditorOptions {
  content: string
  sourceMode: boolean
  readOnly: boolean
  pendingHunks: HunkView[]
  annotations: AnnotationView[]
  historyStep: number
  restore?: EditorRestoreState
  restoreCold?: ColdEditorState
  onChange(content: string, origin: BufferOrigin): void
  onSelection(selection: EditorSelection | null): void
  onOpenAnnotation(annotationId: string): void
  onAdjustAnnotation(annotationId: string, range: EditorSelection): void
  onKeepHunk(hunkId: string): void
  onRevertHunk(hunkId: string): void
  onAcceptSuggestion(annotationId: string): void
  onRejectSuggestion(annotationId: string): void
  onUndo(): Promise<UndoResult>
  onRedo(): Promise<RedoResult>
  resolveLocalImage(request: LocalImageRequest): Promise<ResolvedLocalImage | null>
}

export interface RendererEditorHandle {
  setContent(content: string): void
  setHistoryStep(step: number): void
  exportState(): EditorRestoreState
  setReviewState(hunks: HunkView[]): void
  setAnnotations(annotations: AnnotationView[]): void
  setReadOnly?(readOnly: boolean): void
  getMarkdown(): string
  focus(): void
  toggleSource(source: boolean): void
  command?(command: EditorCommand): void
  jumpToHunk?(hunkId: string): void
  jumpToAnnotation?(annotationId: string): void
  /** One-shot client coordinates of an annotation's span for the thread panel. */
  annotationCoordinates?(annotationId: string): { left: number; top: number; right: number; bottom: number } | null
  setActiveAnnotation?(annotationId: string | null): void
  /** Replaces the current visual selection through the normal edit path (the annotate menu's spelling column). */
  replaceSelection?(text: string): void
  destroy(): void
}

export type RendererEditorFactory = (element: HTMLElement, options: RendererEditorOptions) => RendererEditorHandle
