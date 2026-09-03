import type { ImageInspectionState, LocalImageRequest, ResolvedLocalImage } from '../editor/images'
import type { VisualCodeBlockSessions } from '../editor/code-blocks'
import type { LocalMarkdownResolver } from '../editor/references'
import type { ColdEditorState, EditorRestoreState } from '../editor/types'
import type { FindResult } from '../editor/find'
import type { AnnotationContext, AnnotationKind, AnnotationView, BufferOrigin, HeadingReference, HunkView, RedoResult, TableViewState, UndoResult } from '../shared/contracts'
import type { EditorCommand } from './components/Toolbar'
import type { EditorHeading } from '../editor/headings'

export interface EditorSelection {
  quote: string
  from: number
  to: number
  singleBlock: boolean
  left: number
  top: number
  /** Set on a right-click selection, which must show the menu even for a just-dismissed range. */
  explicit?: boolean
  /** True when the selection came from the pointer (or a right-click); false for Shift+Arrow and other keyboard selections. */
  pointer?: boolean
  annotationKind?: AnnotationKind
  annotationContext?: AnnotationContext
}

export interface RendererEditorOptions {
  content: string
  sourceMode: boolean
  readOnly: boolean
  pendingHunks: HunkView[]
  annotations: AnnotationView[]
  tableViews: TableViewState[]
  focusedTable?: string | null
  visualCodeSessions?: VisualCodeBlockSessions
  imageInspectionState?: ImageInspectionState
  foldedHeadings: readonly HeadingReference[]
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
  /** The editor switched views from its own shortcut; `source` is the view it now shows. */
  onToggleSource(source: boolean): void
  onHeadings(headings: readonly EditorHeading[], activeId: string | null, durationMs: number): void
  onTableView(state: TableViewState): void
  onTableFocus?(tableKey: string | null): void
  onFold(heading: HeadingReference, folded: boolean): void
  resolveLocalImage(request: LocalImageRequest): Promise<ResolvedLocalImage | null>
  resolveLocalMarkdown: LocalMarkdownResolver
  onOpenLocalMarkdown(path: string): void
}

export interface RendererEditorHandle {
  setContent(content: string): void
  setHistoryStep(step: number): void
  exportState(): EditorRestoreState
  setReviewState(hunks: HunkView[]): void
  setAnnotations(annotations: AnnotationView[]): void
  setTableViews(states: TableViewState[]): void
  setFoldedHeadings(headings: readonly HeadingReference[]): void
  setReadOnly?(readOnly: boolean): void
  getMarkdown(): string
  focus(): void
  toggleSource(source: boolean): void
  command?(command: EditorCommand): void
  jumpToHunk?(hunkId: string): void
  jumpToAnnotation?(annotationId: string): void
  jumpToHeading?(headingId: string): void
  headingSource?(headingId: string): { quote: string; from: number; to: number; atx: boolean } | null
  setActiveAnnotation?(annotationId: string | null): void
  /** Replaces the current visual selection through the normal edit path (the annotate menu's spelling column). */
  replaceSelection?(text: string): void
  pasteText?(text: string): void
  selectAll?(): void
  find?(query: string): FindResult
  findStep?(direction: 1 | -1): FindResult
  closeFind?(): void
  destroy(): void
}

export type RendererEditorFactory = (element: HTMLElement, options: RendererEditorOptions) => RendererEditorHandle
