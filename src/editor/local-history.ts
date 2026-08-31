import { spliceContent } from '../shared/view-sync.js'

/**
 * Transactions that replay a chain entry carry this meta key; the chain moves
 * its own stacks for them, so dispatch-time observation skips them.
 */
export const CHAIN_HISTORY_META = 'strataChainHistory'

/** One entry per prosemirror-history group; matches its depth limit. */
const DEPTH_LIMIT = 100

/**
 * One local history entry as a two-way markdown splice: the later revision is
 * the earlier one with `removed` replaced by `inserted` at `prefix`.
 */
export interface ChainEntry {
  /** UTF-16 code units shared at the start and end of both revisions. */
  prefix: number
  suffix: number
  removed: string
  inserted: string
  /** Redo entries: the undo that produced this entry ran through prosemirror-history. */
  viaPM: boolean
}

/** What a cold tab keeps of the chain; `viaPM` is meaningless without a live editor. */
export interface ColdChainState {
  undo: readonly ChainEntry[]
  redo: readonly ChainEntry[]
}

export type ChainStepResult =
  | { status: 'applied'; text: string; changedAt: number }
  | { status: 'empty' }
  | { status: 'invalid' }

function makeEntry(earlier: string, later: string, viaPM: boolean): ChainEntry {
  const splice = spliceContent(earlier, later)
  return {
    prefix: splice.prefix,
    suffix: splice.suffix,
    removed: earlier.slice(splice.prefix, earlier.length - splice.suffix),
    inserted: splice.insert,
    viaPM,
  }
}

/** The later revision, or null when `text` is not the entry's earlier revision. */
function applyForward(entry: ChainEntry, text: string): string | null {
  if (text.length !== entry.prefix + entry.removed.length + entry.suffix) return null
  if (text.slice(entry.prefix, entry.prefix + entry.removed.length) !== entry.removed) return null
  return text.slice(0, entry.prefix) + entry.inserted + text.slice(entry.prefix + entry.removed.length)
}

/** The earlier revision, or null when `text` is not the entry's later revision. */
function applyBackward(entry: ChainEntry, text: string): string | null {
  if (text.length !== entry.prefix + entry.inserted.length + entry.suffix) return null
  if (text.slice(entry.prefix, entry.prefix + entry.inserted.length) !== entry.inserted) return null
  return text.slice(0, entry.prefix) + entry.removed + text.slice(entry.prefix + entry.inserted.length)
}

/**
 * Local editor history as a chain of markdown splices, mirroring
 * prosemirror-history's undo groups while the editor is live and standing in
 * for them after a cold rebuild (docs/plans/completed/cold-tab-plan.md §3). Entries apply only
 * to the exact revision they were recorded against; any observed transition
 * that contradicts the recorded chain drops the whole chain, so a stale splice
 * is never applied.
 */
export class LocalHistoryChain {
  #undo: ChainEntry[] = []
  #redo: ChainEntry[] = []
  /** Markdown after the last observed transition. */
  #current: string
  /** Markdown at the open group's start; equal to #current when no group is open. */
  #boundary: string

  constructor(initial: string) {
    this.#current = initial
    this.#boundary = initial
  }

  static restore(state: ColdChainState, markdown: string): LocalHistoryChain {
    const chain = new LocalHistoryChain(markdown)
    chain.#undo = state.undo.map((entry) => ({ ...entry, viaPM: false }))
    chain.#redo = state.redo.map((entry) => ({ ...entry, viaPM: false }))
    return chain
  }

  get undoLength(): number {
    return this.#undo.length + (this.#boundary === this.#current ? 0 : 1)
  }

  get redoLength(): number {
    return this.#redo.length
  }

  redoTop(): ChainEntry | undefined {
    return this.#redo.at(-1)
  }

  /**
   * A source-mode edit changed the markdown without changing the ProseMirror
   * document (trailing newline, whitespace the parse swallows), so no
   * transaction observed it. The text joins the open group; without one it
   * opens an implicit group at the current boundary.
   */
  syncSourceText(after: string): void {
    if (after === this.#current) return
    this.#redo = []
    this.#current = after
  }

  /** Close the open group (eviction, or a programmatic change landing on it). */
  finalize(): void {
    if (this.#boundary === this.#current) return
    this.#push(this.#undo, makeEntry(this.#boundary, this.#current, false))
    this.#boundary = this.#current
  }

  /** A cold tab keeps the stacks only; the markdown lives in the cold record. */
  export(): ColdChainState {
    this.finalize()
    return {
      undo: this.#undo.map((entry) => ({ ...entry, viaPM: false })),
      redo: this.#redo.map((entry) => ({ ...entry, viaPM: false })),
    }
  }

  /** A document-changing transaction opened a new undo group. */
  observeGroupOpen(after: string): void {
    this.finalize()
    this.#redo = []
    this.#current = after
  }

  /** A document-changing transaction extended the open group. */
  observeGroupContinue(after: string): void {
    this.#redo = []
    this.#current = after
  }

  /** An `addToHistory: false` transaction (external content, merges). */
  observeProgrammatic(after: string): void {
    this.finalize()
    this.#current = after
    this.#boundary = after
  }

  /** Mirror a prosemirror-history undo; false when the chain diverged and was dropped. */
  observeHistoryUndo(after: string): boolean {
    if (this.#boundary !== this.#current) {
      // The undone group is the open one; its undo must land on the group's start.
      if (after !== this.#boundary) return this.#diverge()
      this.#redo.push(makeEntry(this.#boundary, this.#current, true))
      this.#current = after
      return true
    }
    const entry = this.#undo.pop()
    if (!entry || applyBackward(entry, this.#current) !== after) return this.#diverge()
    this.#redo.push({ ...entry, viaPM: true })
    this.#current = after
    this.#boundary = after
    return true
  }

  /** Mirror a prosemirror-history redo; false when the chain diverged and was dropped. */
  observeHistoryRedo(after: string): boolean {
    const entry = this.#redo.pop()
    if (!entry || applyForward(entry, this.#current) !== after) return this.#diverge()
    this.#push(this.#undo, { ...entry, viaPM: false })
    this.#current = after
    this.#boundary = after
    return true
  }

  /** Undo the top entry against the live buffer: the chain-backed path. */
  undoStep(current: string): ChainStepResult {
    return this.#step(current, this.#undo, this.#redo, applyBackward)
  }

  redoStep(current: string): ChainStepResult {
    return this.#step(current, this.#redo, this.#undo, applyForward)
  }

  #step(
    current: string,
    from: ChainEntry[],
    to: ChainEntry[],
    apply: (entry: ChainEntry, text: string) => string | null,
  ): ChainStepResult {
    this.finalize()
    if (current !== this.#current) {
      this.#diverge()
      return { status: 'invalid' }
    }
    const entry = from.at(-1)
    if (!entry) return { status: 'empty' }
    const text = apply(entry, current)
    if (text === null) {
      this.#diverge()
      return { status: 'invalid' }
    }
    from.pop()
    this.#push(to, { ...entry, viaPM: false })
    this.#current = text
    this.#boundary = text
    return { status: 'applied', text, changedAt: entry.prefix }
  }

  #push(stack: ChainEntry[], entry: ChainEntry): void {
    stack.push(entry)
    if (stack.length > DEPTH_LIMIT) stack.shift()
  }

  #diverge(): false {
    this.#undo = []
    this.#redo = []
    this.#boundary = this.#current
    return false
  }
}
