import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EngineMessageView, HeadingReference } from '../../shared/contracts'
import { createStrataEditor, type AnnotationRange, type EditorSelection, type LayoutReadiness, type StrataEditorHandle } from '../../editor'
import { isOwnerComment, resolveMessageAnchor, type MessageComment } from '../../core/conversation-delivery'
import { conversationParse } from '../conversationReading'
import { MessageMarkdown } from '../messageMarkdown'
import { transcriptDiagnostics } from '../transcriptDiagnostics'
import type { RowDisplay } from '../transcriptCoordinator'
import { TranscriptContext } from './ConversationHistory'

export interface PassageTarget { message: string; from: number; to: number; serial: number; align?: 'start'; annotation?: string; pending?: boolean }

/**
 * One completed answer. It shows source-mapped lightweight Markdown until the
 * transcript coordinator has a ready rich editor for it, then hosts that
 * editor in a slot the coordinator fills; the swap and its scroll correction
 * are the coordinator's transaction, never this component's own effect.
 */
export const ConversationMessage = memo(function ConversationMessage({ message, comments, pinned, target, onSelection, onOpen, root, folds, onFold }: {
  message: EngineMessageView; comments: MessageComment[]; pinned: boolean; target: PassageTarget | null
  root: string | null; folds: HeadingReference[]; onFold(heading: HeadingReference, folded: boolean): void
  onSelection(selection: EditorSelection | null): void; onOpen(id: string): void
}) {
  const port = useContext(TranscriptContext)
  const row = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const lightweight = useRef<HTMLDivElement>(null)
  const editor = useRef<StrataEditorHandle | null>(null)
  const [display, setDisplay] = useState<{ mode: RowDisplay; reserved: number | null; source: string }>({ mode: 'lightweight', reserved: null, source: message.prose ?? message.text })
  const [selected, setSelected] = useState(false)
  const latest = useRef({ onSelection, onOpen, onFold }); latest.current = { onSelection, onOpen, onFold }
  const source = message.prose ?? message.text
  const documentPath = root ? `${root}/.conversation.md` : ''
  const inputs = useRef({ source, root, documentPath }); inputs.current = { source, root, documentPath }
  const displayedSource = useRef(display.source); displayedSource.current = display.source
  const generation = useRef(0)
  const isTarget = target?.message === message.id
  const isPinned = pinned || selected || (isTarget && target?.pending !== false)
  const pinnedRef = useRef(isPinned); pinnedRef.current = isPinned
  const protectedRef = useRef(selected); protectedRef.current = selected
  const targetRef = useRef(isTarget); targetRef.current = isTarget
  const foldsRef = useRef(folds); foldsRef.current = folds
  const foldsKey = JSON.stringify(folds)
  /** The folds a staged candidate was built with; a different set invalidates it. */
  const builtFolds = useRef<string | null>(null)
  const versions = useRef<Record<string, string>>({})
  const ranges = useMemo<AnnotationRange[]>(() => {
    const list: AnnotationRange[] = comments.flatMap(comment => {
      const range = resolveMessageAnchor(comment, message)
      return range ? [{ id: comment.id, kind: isOwnerComment(comment) && comment.kind === 'suggestion' ? 'comment' : comment.kind, status: !isOwnerComment(comment) && comment.state === 'resolved' ? 'resolved' as const : 'open' as const, from: 0, to: 0, sourceFrom: range.from, sourceTo: range.to, quote: comment.selection, text: comment.text, author: 'user', draft: comment.state === 'held' }] : []
    })
    if (target?.message === message.id && target.align !== 'start' && !target.annotation) list.push({ id: 'conversation-jump', kind: 'comment', status: 'open', from: 0, to: 0, sourceFrom: target.from, sourceTo: target.to, quote: source.slice(target.from, target.to), author: 'user' })
    return list
  }, [comments, target, message, source])
  const rangesRef = useRef(ranges); rangesRef.current = ranges

  useEffect(() => {
    const changed = () => { const selection = window.getSelection(); setSelected(Boolean(selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode && row.current?.contains(selection.anchorNode) && row.current.contains(selection.focusNode))) }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [])

  useEffect(() => {
    if (!port || !row.current) return
    setDisplay({ mode: 'lightweight', reserved: null, source: inputs.current.source })
    versions.current = {}
    const element = row.current.closest<HTMLElement>('[data-message-id]') ?? row.current
    const protectedDisplay = () => protectedRef.current || element.contains(document.activeElement) || element.querySelector('[data-reading-retained]') !== null
    const resolveVersion = async (imageSource: string) => inputs.current.root ? (await window.strata.resolveLocalImage(inputs.current.documentPath, imageSource))?.version ?? null : null
    return port.register({
      id: message.id,
      element,
      get source() { return inputs.current.source },
      displayedSource: () => displayedSource.current,
      protected: protectedDisplay,
      pinned: () => pinnedRef.current || protectedDisplay(),
      folds: () => JSON.stringify(foldsRef.current),
      transient: () => targetRef.current,
      slot: () => slot.current,
      lightweight: () => lightweight.current,
      createEditor: (host: HTMLElement, readiness: LayoutReadiness) => {
        const { source, root, documentPath } = inputs.current
        const created = ++generation.current
        versions.current = {}
        builtFolds.current = JSON.stringify(foldsRef.current)
        return createStrataEditor(host, {
        content: source, parsed: conversationParse(message.id, source), readOnly: true, ariaLabel: 'Assistant message',
        documentPath,
        // The transcript's own image path: main resolves against the project's workspace and supplies header dimensions.
        resolveLocalImage: async ({ source: imageSource }) => {
          if (!root) return null
          await transcriptDiagnostics.gate('image-metadata')
          const resolved = await window.strata.resolveLocalImage(documentPath, imageSource)
          if (created === generation.current && resolved?.version) versions.current[imageSource] = resolved.version
          return resolved
        },
        resolveLocalMarkdown: markdownSource => root ? window.strata.resolveLocalMarkdown(documentPath, markdownSource) : Promise.resolve(null),
        onOpenLocalMarkdown: path => { void window.strata.openDocument(path) },
        onSelection: selection => { if (editor.current) latest.current.onSelection(selection) },
        onOpenAnnotation: id => { if (editor.current) latest.current.onOpen(id) },
        onFold: (heading, folded) => latest.current.onFold(heading, folded),
        foldedHeadings: foldsRef.current,
        annotations: rangesRef.current,
        layoutReadiness: readiness,
      }) },
      setDisplay: (mode, reserved) => setDisplay({ mode, reserved, source: inputs.current.source }),
      published: (handle) => {
        editor.current = handle
        if (handle) { handle.setAnnotations(rangesRef.current); handle.setFoldedHeadings(foldsRef.current) }
      },
      imageVersions: () => ({ ...versions.current }),
      imageVersion: resolveVersion,
    })
  }, [port, message.id])

  const previousInputs = useRef({ source, root })
  useEffect(() => {
    if (previousInputs.current.source !== source || previousInputs.current.root !== root) {
      previousInputs.current = { source, root }
      generation.current += 1
      port?.invalidate(message.id, 'source')
    }
  }, [source, root, port, message.id])

  useEffect(() => { port?.refresh() }, [port, isPinned])
  useLayoutEffect(() => { if (display.source === source) editor.current?.setAnnotations(ranges) }, [ranges, display.mode, display.source, source])
  useLayoutEffect(() => {
    if (editor.current) editor.current.setFoldedHeadings(folds)
    else if (builtFolds.current !== null && builtFolds.current !== foldsKey) { builtFolds.current = null; port?.invalidate(message.id, 'folds') }
  }, [foldsKey, display.mode])

  return <div ref={row} className="conversation-rich-message" data-rich-mounted={display.mode === 'rich' || undefined} data-transcript-display={display.mode} >
    {display.mode === 'rich'
      ? <div ref={slot} className="conversation-editor-slot" data-document-path={documentPath || undefined} />
      : display.mode === 'placeholder'
        ? <div className="conversation-placeholder" style={{ height: display.reserved ?? 0 }} aria-label="Preparing answer">Preparing answer…</div>
        : <div ref={lightweight} className="conversation-lightweight"><MessageMarkdown text={display.source} sourceMap /></div>}
  </div>
})
