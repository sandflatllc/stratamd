import { describe, expect, it } from 'vitest'
import { LocalHistoryChain } from '../../src/editor/local-history.js'

/**
 * The splice chain mirrors prosemirror-history's undo groups and stands in for
 * them after a cold rebuild (docs/plans/completed/cold-tab-plan.md §3-§4). These tests drive it
 * with the same observation sequence the editor's dispatchTransaction emits.
 */
describe('LocalHistoryChain', () => {
  const BASE = '# Doc\n\nBase.\n'

  /** Type one burst: a group-opening transaction then continuations. */
  function typeBurst(chain: LocalHistoryChain, revisions: string[]): void {
    const [first, ...rest] = revisions
    chain.observeGroupOpen(first!)
    for (const revision of rest) chain.observeGroupContinue(revision)
  }

  it('finalizes one entry per group and undoes burst by burst', () => {
    const chain = new LocalHistoryChain(BASE)
    typeBurst(chain, ['# Doc\n\nBase. A\n', '# Doc\n\nBase. Al\n', '# Doc\n\nBase. Alpha\n'])
    typeBurst(chain, ['# Doc\n\nBase. Alpha Beta\n'])
    chain.finalize()
    expect(chain.undoLength).toBe(2)

    const first = chain.undoStep('# Doc\n\nBase. Alpha Beta\n')
    expect(first.status === 'applied' && first.text).toBe('# Doc\n\nBase. Alpha\n')
    const second = chain.undoStep('# Doc\n\nBase. Alpha\n')
    expect(second.status === 'applied' && second.text).toBe(BASE)
    expect(chain.undoStep(BASE)).toEqual({ status: 'empty' })
  })

  it('redoes in reverse undo order and reports changedAt at the splice start', () => {
    const chain = new LocalHistoryChain(BASE)
    typeBurst(chain, ['# Doc\n\nBase. Alpha\n'])
    const undone = chain.undoStep('# Doc\n\nBase. Alpha\n')
    expect(undone.status).toBe('applied')
    const redone = chain.redoStep(BASE)
    expect(redone.status === 'applied' && redone.text).toBe('# Doc\n\nBase. Alpha\n')
    expect(redone.status === 'applied' && redone.changedAt).toBe('# Doc\n\nBase.'.length)
  })

  it('clears redo when a new group opens or the open group extends', () => {
    const chain = new LocalHistoryChain(BASE)
    typeBurst(chain, ['# Doc\n\nBase. Alpha\n'])
    chain.undoStep('# Doc\n\nBase. Alpha\n')
    expect(chain.redoLength).toBe(1)
    typeBurst(chain, ['# Doc\n\nBase. Gamma\n'])
    expect(chain.redoLength).toBe(0)
    expect(chain.redoStep('# Doc\n\nBase. Gamma\n')).toEqual({ status: 'empty' })
  })

  it('mirrors prosemirror undo of the open group and of finalized entries', () => {
    const chain = new LocalHistoryChain(BASE)
    typeBurst(chain, ['# Doc\n\nBase. Alpha\n'])
    typeBurst(chain, ['# Doc\n\nBase. Alpha Beta\n'])
    // Beta's group is still open; a prosemirror undo consumes it.
    expect(chain.observeHistoryUndo('# Doc\n\nBase. Alpha\n')).toBe(true)
    expect(chain.redoTop()?.viaPM).toBe(true)
    // Alpha's group was finalized when Beta's opened.
    expect(chain.observeHistoryUndo(BASE)).toBe(true)
    expect(chain.redoLength).toBe(2)
    // Redo mirrors back in order.
    expect(chain.observeHistoryRedo('# Doc\n\nBase. Alpha\n')).toBe(true)
    expect(chain.observeHistoryRedo('# Doc\n\nBase. Alpha Beta\n')).toBe(true)
    expect(chain.undoLength).toBe(2)
  })

  it('finalizes the open group when a programmatic change lands, keeping it undoable', () => {
    const chain = new LocalHistoryChain(BASE)
    typeBurst(chain, ['# Doc\n\nBase. Owner\n'])
    // External merge arrives mid-session (addToHistory: false).
    chain.observeProgrammatic('# Doc\n\nBase. Owner Agent.\n')
    expect(chain.undoLength).toBe(1)
    // Undoing the merge through main restores the pre-merge text, arriving as
    // another programmatic change; then the typing entry applies against
    // exactly the text it recorded.
    chain.observeProgrammatic('# Doc\n\nBase. Owner\n')
    const undone = chain.undoStep('# Doc\n\nBase. Owner\n')
    expect(undone.status === 'applied' && undone.text).toBe(BASE)
  })

  it('drops the whole chain instead of applying a splice against unexpected text', () => {
    const chain = new LocalHistoryChain(BASE)
    typeBurst(chain, ['# Doc\n\nBase. Alpha\n'])
    chain.finalize()
    const result = chain.undoStep('# Doc\n\nSomething else entirely.\n')
    expect(result).toEqual({ status: 'invalid' })
    expect(chain.undoLength).toBe(0)
    expect(chain.redoLength).toBe(0)
  })

  it('drops the chain when a mirrored prosemirror undo lands on unexpected text', () => {
    const chain = new LocalHistoryChain(BASE)
    typeBurst(chain, ['# Doc\n\nBase. Alpha\n'])
    chain.finalize()
    expect(chain.observeHistoryUndo('# Doc\n\nNot the recorded before-text.\n')).toBe(false)
    expect(chain.undoLength).toBe(0)
  })

  it('orders redo across mechanisms: chain-applied entries sit above prosemirror ones', () => {
    // Pre-eviction typing A survives cold; post-rebuild typing B is prosemirror-backed.
    const cold = new LocalHistoryChain(BASE)
    typeBurst(cold, ['# Doc\n\nBase. A\n'])
    const rebuilt = LocalHistoryChain.restore(cold.export(), '# Doc\n\nBase. A\n')
    typeBurst(rebuilt, ['# Doc\n\nBase. A B\n'])
    // Undo B through prosemirror (mirrored), then A through the chain.
    expect(rebuilt.observeHistoryUndo('# Doc\n\nBase. A\n')).toBe(true)
    expect(rebuilt.undoStep('# Doc\n\nBase. A\n').status).toBe('applied')
    // Redo order: A first (chain-applied, viaPM false on top), then B (viaPM true below).
    expect(rebuilt.redoTop()?.viaPM).toBe(false)
    const redoneA = rebuilt.redoStep(BASE)
    expect(redoneA.status === 'applied' && redoneA.text).toBe('# Doc\n\nBase. A\n')
    expect(rebuilt.redoTop()?.viaPM).toBe(true)
    expect(rebuilt.observeHistoryRedo('# Doc\n\nBase. A B\n')).toBe(true)
  })

  it('survives export and restore with flags reset and history intact', () => {
    const chain = new LocalHistoryChain(BASE)
    typeBurst(chain, ['# Doc\n\nBase. Alpha\n'])
    typeBurst(chain, ['# Doc\n\nBase. Alpha Beta\n'])
    expect(chain.observeHistoryUndo('# Doc\n\nBase. Alpha\n')).toBe(true)
    const restored = LocalHistoryChain.restore(chain.export(), '# Doc\n\nBase. Alpha\n')
    expect(restored.undoLength).toBe(1)
    expect(restored.redoLength).toBe(1)
    expect(restored.redoTop()?.viaPM).toBe(false)
    const undone = restored.undoStep('# Doc\n\nBase. Alpha\n')
    expect(undone.status === 'applied' && undone.text).toBe(BASE)
    const redone = restored.redoStep(BASE)
    expect(redone.status === 'applied' && redone.text).toBe('# Doc\n\nBase. Alpha\n')
  })

  it('caps the undo stack at the prosemirror depth limit, dropping oldest', () => {
    const chain = new LocalHistoryChain('0\n')
    for (let step = 1; step <= 120; step += 1) typeBurst(chain, [`${step}\n`])
    chain.finalize()
    expect(chain.undoLength).toBe(100)
    let current = '120\n'
    for (let step = 0; step < 100; step += 1) {
      const result = chain.undoStep(current)
      expect(result.status).toBe('applied')
      if (result.status === 'applied') current = result.text
    }
    expect(current).toBe('20\n')
    expect(chain.undoStep(current)).toEqual({ status: 'empty' })
  })

  it('absorbs text-only source edits the document representation swallows', () => {
    // Typing "Extra line." then Enter in source mode: the trailing newline
    // changes the markdown but not the ProseMirror doc, so it arrives via
    // syncSourceText instead of a transaction.
    const chain = new LocalHistoryChain(BASE)
    chain.observeGroupOpen(`${BASE}Extra line.`)
    chain.syncSourceText(`${BASE}Extra line.\n`)
    chain.finalize()
    expect(chain.undoLength).toBe(1)
    const undone = chain.undoStep(`${BASE}Extra line.\n`)
    expect(undone.status === 'applied' && undone.text).toBe(BASE)
    const redone = chain.redoStep(BASE)
    expect(redone.status === 'applied' && redone.text).toBe(`${BASE}Extra line.\n`)
  })

  it('opens an implicit group for a text-only edit with no group open', () => {
    const chain = new LocalHistoryChain(BASE)
    chain.syncSourceText(`${BASE}\n`)
    chain.finalize()
    expect(chain.undoLength).toBe(1)
    const undone = chain.undoStep(`${BASE}\n`)
    expect(undone.status === 'applied' && undone.text).toBe(BASE)
  })

  it('handles multi-line and CRLF revisions byte-exactly', () => {
    const crlf = '# Doc\r\n\r\nBase.\r\n'
    const chain = new LocalHistoryChain(crlf)
    typeBurst(chain, ['# Doc\r\n\r\nBase.\r\nNew line.\r\n'])
    chain.finalize()
    const undone = chain.undoStep('# Doc\r\n\r\nBase.\r\nNew line.\r\n')
    expect(undone.status === 'applied' && undone.text).toBe(crlf)
  })
})
