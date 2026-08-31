import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'

export interface SourceSpan {
  /** UTF-16 offsets into the original markdown string. */
  from: number
  to: number
}

export interface ParsedMarkdownBlock {
  id: string
  span: SourceSpan
  raw: string
  node: ProseMirrorNode
}

/**
 * The immutable parse result retained for the lifetime of an editor buffer.
 * Core persistence code can consume this without knowing about ProseMirror.
 */
export interface ParsedEditorMarkdown {
  source: string
  doc: ProseMirrorNode
  blocks: readonly ParsedMarkdownBlock[]
  lineEnding: '\n' | '\r\n'
  hasBom: boolean
  hasFinalNewline: boolean
  /** Parse metadata owned by the byte-preserving core serializer. */
  core: import('../core/markdown/types.js').ParsedMarkdown
}

export interface EditorMarkdownBlock {
  id: string | null
  node: ProseMirrorNode
  original: ParsedMarkdownBlock | null
  unchanged: boolean
}

/**
 * Handoff to the byte-preserving core serializer. Unchanged blocks retain
 * their exact source slices. Changed and inserted blocks carry editor nodes.
 */
export interface EditorMarkdownUpdate {
  source: string
  original: ParsedEditorMarkdown
  blocks: readonly EditorMarkdownBlock[]
  deleted: readonly ParsedMarkdownBlock[]
}

export type EditorMode = 'visual' | 'source'

export interface EditorChange {
  markdown: string
  doc: ProseMirrorNode
  transaction: Transaction | null
  mode: EditorMode
}

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

export interface EditorCommandHandlers {
  onSave?(): void
  onSend?(): void
  onToggleSource?(): void
}

/** What survives a tab switch warm: the ProseMirror state (with its history) and the undo timeline. */
export interface EditorRestoreState {
  state: EditorState
  markdown: string
  parsed: ParsedEditorMarkdown
  coordinator: import('./undo.js').EditorUndoCoordinator
  chain: import('./local-history.js').LocalHistoryChain
  sourceCaret: number
}

/** What survives a tab switch cold: kilobytes instead of the editor (docs/plans/completed/cold-tab-plan.md §5). */
export interface ColdEditorState {
  markdown: string
  chain: import('./local-history.js').ColdChainState
  coordinator: import('./undo.js').EditorUndoCoordinator
  /** Markdown offsets of the selection at eviction; null when empty or unmappable. */
  selection: { from: number; to: number } | null
  sourceCaret: number
}

export interface StrataEditorHandle {
  setContent(markdown: string): void
  /** Main's application-step counter; each increase is one undoable application entry. */
  setHistoryStep(step: number): void
  exportState(): EditorRestoreState
  setReviewState(ranges: readonly (import('./review').ReviewRange | import('../shared/contracts.js').HunkView)[]): void
  setAnnotations(ranges: readonly (import('./annotations').AnnotationRange | import('../shared/contracts.js').AnnotationView)[]): void
  getMarkdown(): string
  getState(): EditorState
  setReadOnly(readOnly: boolean): void
  command(command: string): void
  jumpToHunk(id: string): void
  jumpToAnnotation(id: string): void
  /** One-shot client coordinates of an annotation's span, queried at panel-open time. */
  annotationCoordinates(id: string): { left: number; top: number; right: number; bottom: number } | null
  /** Shows drag handles on one open annotation (null hides them). */
  setActiveAnnotation(id: string | null): void
  /** Replaces the current visual selection through the normal edit path; no-op when empty, read-only, or in source mode. */
  replaceSelection(text: string): void
  focus(): void
  toggleSource(force?: boolean): EditorMode
  destroy(): void
}
