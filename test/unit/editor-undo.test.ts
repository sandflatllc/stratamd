import { readFileSync } from 'node:fs'
import { closeHistory, history, undo, undoDepth } from 'prosemirror-history'
import { EditorState, type Transaction } from 'prosemirror-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEditorKeymap,
  EditorUndoCoordinator,
  parseMarkdownForEditor,
  replaceDocumentProgrammatically,
} from '../../src/editor/index.js'

function typedState(): EditorState {
  const parsed = parseMarkdownForEditor('one\n')
  const state = EditorState.create({ doc: parsed.doc, plugins: [history()] })
  return state.apply(state.tr.insertText(' user', 4))
}

function replaceProgrammatically(state: EditorState, markdown: string, options?: { history: boolean }): EditorState {
  const replacement = parseMarkdownForEditor(markdown).doc
  return state.apply(replaceDocumentProgrammatically(state.tr, replacement, options))
}

describe('undo timeline coordinator', () => {
  it('walks local and application entries in the order they happened, and back', () => {
    const coordinator = new EditorUndoCoordinator()
    coordinator.record('local')
    coordinator.record('application')
    coordinator.record('local')

    const undone: string[] = []
    for (let step = 0; step < 3; step += 1) {
      undone.push(coordinator.takeUndo()!)
      coordinator.settle(true)
    }
    expect(undone).toEqual(['local', 'application', 'local'])
    expect(coordinator.takeUndo()).toBeUndefined()

    const redone: string[] = []
    for (let step = 0; step < 3; step += 1) {
      redone.push(coordinator.takeRedo()!)
      coordinator.settle(true)
    }
    expect(redone).toEqual(['local', 'application', 'local'])
    expect(coordinator.takeRedo()).toBeUndefined()
  })

  it('a new step after an undo clears redo', () => {
    const coordinator = new EditorUndoCoordinator()
    coordinator.record('application')
    coordinator.takeUndo()
    coordinator.settle(true)
    expect(coordinator.redoEntries).toEqual(['application'])
    coordinator.record('local')
    expect(coordinator.redoEntries).toEqual([])
    expect(coordinator.undoEntries).toEqual(['local'])
  })

  it('records one application entry per increase of the step counter', () => {
    const coordinator = new EditorUndoCoordinator()
    expect(coordinator.syncApplicationStep(0)).toBe(false)
    expect(coordinator.syncApplicationStep(0)).toBe(false)
    expect(coordinator.syncApplicationStep(1)).toBe(true)
    expect(coordinator.syncApplicationStep(1)).toBe(false)
    expect(coordinator.syncApplicationStep(3)).toBe(true)
    expect(coordinator.undoEntries).toEqual(['application', 'application'])
  })

  it('locks while an application action is pending and drops the entry when it fails', () => {
    const coordinator = new EditorUndoCoordinator()
    coordinator.record('local')
    coordinator.record('application')

    expect(coordinator.takeUndo()).toBe('application')
    expect(coordinator.pending).toBe(true)
    expect(coordinator.takeUndo()).toBeUndefined()
    coordinator.settle(false)
    expect(coordinator.redoEntries).toEqual([])
    expect(coordinator.takeUndo()).toBe('local')
    coordinator.settle(true)
    expect(coordinator.redoEntries).toEqual(['local'])
  })

  it('does not resurrect a stale redo entry when typing interrupted a pending undo', () => {
    const coordinator = new EditorUndoCoordinator()
    coordinator.record('application')
    coordinator.takeUndo()
    coordinator.record('local')
    coordinator.settle(true)
    expect(coordinator.redoEntries).toEqual([])
    expect(coordinator.undoEntries).toEqual(['local'])
  })
})

describe('editor keymap routing', () => {
  it('binds Ctrl-z to the editor undo and both redo shortcuts to the editor redo', () => {
    const undoStep = vi.fn(() => true)
    const redoStep = vi.fn(() => true)
    const keymap = createEditorKeymap({ undo: undoStep, redo: redoStep })
    const state = typedState()

    expect(keymap['Ctrl-z']!(state, () => undefined)).toBe(true)
    expect(keymap['Shift-Ctrl-z']!(state, () => undefined)).toBe(true)
    expect(keymap['Ctrl-y']!(state, () => undefined)).toBe(true)
    expect(undoStep).toHaveBeenCalledOnce()
    expect(redoStep).toHaveBeenCalledTimes(2)
    expect(state.doc.textContent).toBe('one user')
  })
})

describe('local history across programmatic replacements', () => {
  afterEach(() => { vi.useRealTimers() })

  it('keeps older local history mapped across an external merge and its application undo', () => {
    let state = typedState()
    state = replaceProgrammatically(state, 'one user external\n')
    state = replaceProgrammatically(state, 'one user\n')

    let transaction: Transaction | undefined
    expect(undo(state, (next) => { transaction = next })).toBe(true)
    state = state.apply(transaction!)
    expect(state.doc.textContent).toBe('one')
  })

  it('preserves local undo when an external merge inserts a top-level block', () => {
    const initial = parseMarkdownForEditor('Alpha\n\nBeta\n')
    let state = EditorState.create({ doc: initial.doc, plugins: [history()] })
    state = state.apply(state.tr.insertText(' user', 6))
    const beforeExternal = state.doc

    state = replaceProgrammatically(state, 'Alpha user\n\nGamma\n\nBeta\n')
    expect(state.doc.eq(parseMarkdownForEditor('Alpha user\n\nGamma\n\nBeta\n').doc)).toBe(true)
    state = state.apply(replaceDocumentProgrammatically(state.tr, beforeExternal))

    let transaction: Transaction | undefined
    expect(undo(state, (next) => { transaction = next })).toBe(true)
    state = state.apply(transaction!)
    expect(state.doc.textContent).toBe('AlphaBeta')
  })

  it('source-mode replacements are history events grouped by the 500 ms delay', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const parsed = parseMarkdownForEditor('one\n')
    let state = EditorState.create({ doc: parsed.doc, plugins: [history()] })
    state = replaceProgrammatically(state, 'one t\n', { history: true })
    vi.setSystemTime(1_000_200)
    state = replaceProgrammatically(state, 'one tw\n', { history: true })
    expect(undoDepth(state)).toBe(1)
    vi.setSystemTime(1_001_000)
    state = replaceProgrammatically(state, 'one two\n', { history: true })
    expect(undoDepth(state)).toBe(2)
    expect(undoDepth(replaceProgrammatically(state, 'one two three\n'))).toBe(2)
  })

  it('a table row insertion whose splice outgrows the snapshot falls back to the full replacement', () => {
    // 2026-08-30 incident: an agent inserted two rows into the delivery table
    // of the product page. The semantic diff overlapped into a pure insertion
    // of an open table slice; fitting it added wrapper structure the snapshot
    // does not have, so the spliced document outgrew the snapshot and the
    // metadata walk read past its end, throwing a RangeError that blanked the
    // renderer. The exact document matters — small synthetic tables splice
    // cleanly — so this replays the incident bytes, frozen as a corpus fixture.
    const sample = readFileSync(new URL('../corpus/real/strata-product-page.md', import.meta.url), 'utf8')
    const anchor = '| Direct edits | A larger buffer edit appears as an attributed pending hunk. Keep advances the reviewed copy; Revert restores the earlier text. |\n| Ghost |'
    const insertion = '| Direct edits | A larger buffer edit appears as an attributed pending hunk. Keep advances the reviewed copy; Revert restores the earlier text. |\n| Messages | An attached agent can send a short note to another. The note wakes a waiting recipient and queues for an absent one; one note may wait per sender and recipient pair. |\n| The Lead | The one agent you put in charge. Only the Lead may accept or reject other agents\' suggestions, resolve their threads, and save. Lead accepts and saves still leave pending changes for your review. |\n| Ghost |'
    const state = EditorState.create({ doc: parseMarkdownForEditor(sample).doc })
    const next = parseMarkdownForEditor(sample.replace(anchor, insertion)).doc
    const applied = state.apply(replaceDocumentProgrammatically(state.tr, next))
    expect(applied.doc.eq(next)).toBe(true)
  })

  it('an application step closes the open typing group so typing on both sides stays separate', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const parsed = parseMarkdownForEditor('one\n')
    let state = EditorState.create({ doc: parsed.doc, plugins: [history()] })
    state = state.apply(state.tr.insertText(' a', 4))
    state = state.apply(closeHistory(state.tr))
    state = replaceProgrammatically(state, 'one a external\n')
    vi.setSystemTime(1_000_100)
    state = state.apply(state.tr.insertText('b', 6))
    expect(undoDepth(state)).toBe(2)
  })
})
