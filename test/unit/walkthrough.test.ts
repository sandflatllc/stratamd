import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { WalkthroughState } from '../../src/shared/contracts'
import { applyWalkthroughAction, buildWalkthroughIndex, reconcileWalkthroughState, updateWalkthroughIndex } from '../../src/main/walkthrough'

const EMPTY: WalkthroughState = { active: false, level: 'h2', current: null, excluded: [], markers: [] }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

describe('walkthrough section state', () => {
  it('uses exact heading sections and nested H3 boundaries', () => {
    const markdown = '# Title\n\n## One\n\nIntro.\n\n### Detail\n\nBody.\n\n#### Note\n\nNested.\n\n## Two\n\nEnd.\n'
    const index = buildWalkthroughIndex(markdown)
    expect(index.sections.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 2, text: 'One' },
      { level: 3, text: 'Detail' },
      { level: 2, text: 'Two' },
    ])
    expect(index.sections[0]!.hash).toBe(hash(markdown.slice(markdown.indexOf('## One'), markdown.indexOf('## Two'))))
    expect(index.sections[1]!.hash).toBe(hash(markdown.slice(markdown.indexOf('### Detail'), markdown.indexOf('## Two'))))
  })

  it('marks only affected containing sections and restores Reviewed on exact bytes', () => {
    const before = '## One\n\nIntro.\n\n### Detail\n\nBody.\n\n## Two\n\nEnd.\n'
    let index = buildWalkthroughIndex(before)
    let state = applyWalkthroughAction(EMPTY, { type: 'mark', heading: index.sections[1]!.reference, status: 'reviewed' }, index)
    state = applyWalkthroughAction(state, { type: 'mark', heading: index.sections[0]!.reference, status: 'reviewed' }, index)
    const changed = before.replace('Body.', 'Changed body.')
    const update = updateWalkthroughIndex(index, changed, state)
    expect(update.rebuilt).toBe(false)
    expect(update.hashedSections).toBe(2)
    expect(update.state.markers.map((marker) => marker.status)).toEqual(['revisit', 'revisit'])
    index = update.index
    state = update.state
    const restored = updateWalkthroughIndex(index, before, state)
    expect(restored.state.markers.map((marker) => marker.status)).toEqual(['reviewed', 'reviewed'])
  })

  it('keeps a manual Revisit marker until a later affected edit restores its reviewed hash', () => {
    const before = '## One\n\nBody.\n'
    let index = buildWalkthroughIndex(before)
    let state = applyWalkthroughAction(EMPTY, { type: 'mark', heading: index.sections[0]!.reference, status: 'reviewed' }, index)
    state = applyWalkthroughAction(state, { type: 'mark', heading: index.sections[0]!.reference, status: 'revisit' }, index)
    expect(reconcileWalkthroughState(state, index).markers[0]!.status).toBe('revisit')
    let update = updateWalkthroughIndex(index, before.replace('Body.', 'Changed.'), state)
    index = update.index
    update = updateWalkthroughIndex(index, before, update.state)
    expect(update.state.markers[0]!.status).toBe('reviewed')
  })

  it('marks the final section for revisit when text is appended at EOF', () => {
    const before = '## A\n\nFirst.\n\n## B\n\nLast.'
    const index = buildWalkthroughIndex(before)
    const state = applyWalkthroughAction(EMPTY, { type: 'mark', heading: index.sections[1]!.reference, status: 'reviewed' }, index)
    const update = updateWalkthroughIndex(index, `${before} More.`, state)
    expect(update.rebuilt).toBe(false)
    expect(update.state.markers[0]?.status).toBe('revisit')
  })

  it('preserves one touched heading identity during a rename and discards ambiguous reload matches', () => {
    const before = '## One\n\nBody.\n\n## Other\n\nEnd.\n'
    const index = buildWalkthroughIndex(before)
    const state = applyWalkthroughAction(EMPTY, { type: 'mark', heading: index.sections[0]!.reference, status: 'reviewed' }, index)
    const renamed = updateWalkthroughIndex(index, before.replace('## One', '## Renamed'), state)
    expect(renamed.rebuilt).toBe(true)
    expect(renamed.state.markers[0]?.heading.text).toBe('Renamed')
    expect(renamed.state.markers[0]?.status).toBe('revisit')

    const duplicate = buildWalkthroughIndex('## Same\n\nA.\n\n## Same\n\nB.\n')
    const ambiguousReference = { ...state.markers[0]!.heading, text: 'Same', parentText: null, previousText: null, nextText: null }
    const ambiguous = { ...state, current: ambiguousReference, markers: [{ ...state.markers[0]!, heading: ambiguousReference }] }
    const reconciled = reconcileWalkthroughState(ambiguous, duplicate)
    expect(reconciled.markers).toEqual([])
    expect(reconciled.current).toEqual(duplicate.sections[0]!.reference)
  })

  it('applies level, inclusion, progress target, start, and leave actions privately', () => {
    const index = buildWalkthroughIndex('## One\n\n### Detail\n\n## Two\n')
    let state = applyWalkthroughAction(EMPTY, { type: 'start' }, index)
    expect(state).toMatchObject({ active: true, level: 'h2', current: index.sections[0]!.reference })
    state = applyWalkthroughAction(state, { type: 'set-level', level: 'h2-h3' }, index)
    state = applyWalkthroughAction(state, { type: 'set-included', heading: index.sections[0]!.reference, included: false }, index)
    expect(state.current).toEqual(index.sections[1]!.reference)
    state = applyWalkthroughAction(state, { type: 'leave' }, index)
    expect(state.active).toBe(false)
  })
})
