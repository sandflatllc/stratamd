import { Fragment, type Node as ProseMirrorNode } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'

export type HistoryEntry = 'local' | 'application'

/**
 * One ordered timeline of local ProseMirror history events and application
 * steps (Keep, Revert, Accept, external merge). Local entries come from
 * prosemirror-history's undo depth; application entries from the step counter
 * main publishes. Undo and redo take the top entry and settle it once the
 * action has succeeded or failed.
 */
export class EditorUndoCoordinator {
  #undo: HistoryEntry[] = []
  #redo: HistoryEntry[] = []
  #pending: { entry: HistoryEntry; direction: 'undo' | 'redo'; interrupted: boolean } | null = null
  #step: number | null = null

  get undoEntries(): readonly HistoryEntry[] {
    return this.#undo
  }

  get redoEntries(): readonly HistoryEntry[] {
    return this.#redo
  }

  get pending(): boolean {
    return this.#pending !== null
  }

  /** A new step happened: it goes on top and invalidates redo. */
  record(entry: HistoryEntry): void {
    this.#undo.push(entry)
    this.#redo = []
    if (this.#pending) this.#pending.interrupted = true
  }

  /** Returns true when the step increased and an application entry was recorded. */
  syncApplicationStep(step: number): boolean {
    const previous = this.#step
    this.#step = step
    if (previous === null || step <= previous) return false
    this.record('application')
    return true
  }

  takeUndo(): HistoryEntry | undefined {
    return this.#take('undo')
  }

  takeRedo(): HistoryEntry | undefined {
    return this.#take('redo')
  }

  /** Finish the taken entry: on success it moves to the other stack, otherwise it is dropped. */
  settle(success: boolean): void {
    const pending = this.#pending
    this.#pending = null
    if (!pending || !success || pending.interrupted) return
    if (pending.direction === 'undo') this.#redo.push(pending.entry)
    else this.#undo.push(pending.entry)
  }

  #take(direction: 'undo' | 'redo'): HistoryEntry | undefined {
    if (this.#pending) return undefined
    const entry = (direction === 'undo' ? this.#undo : this.#redo).pop()
    if (entry === undefined) return undefined
    this.#pending = { entry, direction, interrupted: false }
    return entry
  }
}

function withoutSourceMetadata(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isText) return node
  const children: ProseMirrorNode[] = []
  node.forEach((child) => children.push(withoutSourceMetadata(child)))
  const attrs = {
    ...node.attrs,
    ...('sourceId' in node.attrs ? { sourceId: null } : {}),
    ...('sourceFrom' in node.attrs ? { sourceFrom: null } : {}),
    ...('sourceTo' in node.attrs ? { sourceTo: null } : {}),
  }
  return node.type.create(attrs, Fragment.fromArray(children), node.marks)
}

/**
 * Apply a programmatic snapshot as the smallest semantic replacement. Source
 * offsets are synchronized separately so parser bookkeeping cannot turn a
 * one-word external edit into a whole-document replacement that destroys the
 * mapping for older ProseMirror history items.
 */
export function replaceDocumentProgrammatically(
  transaction: Transaction,
  nextDocument: ProseMirrorNode,
  options: { history?: boolean } = {},
): Transaction {
  const currentSemantic = withoutSourceMetadata(transaction.doc)
  const nextSemantic = withoutSourceMetadata(nextDocument)
  const start = currentSemantic.content.findDiffStart(nextSemantic.content)

  if (start !== null) {
    const ends = currentSemantic.content.findDiffEnd(nextSemantic.content)
    if (ends !== null) {
      let { a, b } = ends
      const overlap = start - Math.min(a, b)
      if (overlap > 0) {
        a += overlap
        b += overlap
      }
      transaction.replace(start, a, nextDocument.slice(start, b))
    }
  }

  // Fitting an open slice can force structure the snapshot does not have
  // (closing table wrappers, for one), leaving the spliced document a
  // different size than the snapshot. Position-wise metadata mapping is only
  // meaningful when the splice landed exactly; walking a larger document
  // against the snapshot would read past its end and throw.
  if (transaction.doc.content.size === nextDocument.content.size) {
    const metadataUpdates: Array<{ pos: number; attrs: Readonly<Record<string, unknown>> }> = []
    transaction.doc.descendants((node, pos) => {
      if (!('sourceId' in node.attrs)) return
      const expected = nextDocument.nodeAt(pos)
      if (!expected || expected.type !== node.type) return
      if (
        node.attrs.sourceId !== expected.attrs.sourceId
        || node.attrs.sourceFrom !== expected.attrs.sourceFrom
        || node.attrs.sourceTo !== expected.attrs.sourceTo
      ) {
        metadataUpdates.push({
          pos,
          attrs: {
            ...node.attrs,
            sourceId: expected.attrs.sourceId,
            sourceFrom: expected.attrs.sourceFrom,
            sourceTo: expected.attrs.sourceTo,
          },
        })
      }
    })
    for (const update of metadataUpdates) {
      transaction.setNodeMarkup(update.pos, undefined, update.attrs)
    }
  }

  // Unusual structural replacements can make position-wise metadata mapping
  // impossible. Correct content wins; the ordinary case remains byte-local.
  if (!transaction.doc.eq(nextDocument)) {
    transaction.replaceWith(0, transaction.doc.content.size, nextDocument.content)
  }
  return options.history ? transaction : transaction.setMeta('addToHistory', false)
}
