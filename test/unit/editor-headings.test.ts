import { EditorState } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { createHeadingPlugin, headingsForState, parseMarkdownForEditor, projectHeadings, strataSchema, createSourceSpanPlugin, getTrackedSourceBlocks } from '../../src/editor/index'
import { headingOutline } from '../../src/renderer/components/Contents'

describe('live document heading index', () => {
  it('projects nested headings and preserves skipped-level hierarchy', () => {
    const doc = parseMarkdownForEditor('# Title\n\n## Section\n\n#### Detail\n\n> ### Quoted heading\n').doc
    const headings = projectHeadings(doc)
    expect(headings.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 1, text: 'Title' },
      { level: 2, text: 'Section' },
      { level: 4, text: 'Detail' },
      { level: 3, text: 'Quoted heading' },
    ])
    const outline = headingOutline(headings.slice(1))
    expect(outline).toHaveLength(1)
    expect(outline[0]?.children.map((node) => node.heading.text)).toEqual(['Detail', 'Quoted heading'])
  })

  it('keeps a runtime heading identity when text before it or inside it changes', () => {
    const paragraph = strataSchema.nodes.paragraph.create(null, strataSchema.text('Before'))
    const heading = strataSchema.nodes.heading.create({ level: 2 }, strataSchema.text('Heading'))
    let state = EditorState.create({ schema: strataSchema, doc: strataSchema.nodes.doc.create(null, [paragraph, heading]), plugins: [createHeadingPlugin()] })
    const first = headingsForState(state)[0]!
    state = state.apply(state.tr.insertText(' more', 7))
    const moved = headingsForState(state)[0]!
    expect(moved.id).toBe(first.id)
    expect(moved.position).toBeGreaterThan(first.position)
    state = state.apply(state.tr.insertText('New ', moved.position + 1))
    expect(headingsForState(state)[0]).toMatchObject({ id: first.id, text: 'New Heading' })
  })

  it('indexes headings created, split, and removed inside changed ranges', () => {
    const paragraph = strataSchema.nodes.paragraph.create(null, strataSchema.text('First'))
    let state = EditorState.create({ schema: strataSchema, doc: strataSchema.nodes.doc.create(null, [paragraph]), plugins: [createHeadingPlugin()] })
    state = state.apply(state.tr.setBlockType(0, paragraph.nodeSize, strataSchema.nodes.heading, { level: 2 }))
    expect(headingsForState(state).map(({ level, text }) => ({ level, text }))).toEqual([{ level: 2, text: 'First' }])
    const identity = headingsForState(state)[0]!.id
    state = state.apply(state.tr.split(3, 1, [{ type: strataSchema.nodes.heading, attrs: { level: 3 } }]))
    expect(headingsForState(state).map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 2, text: 'Fi' },
      { level: 3, text: 'rst' },
    ])
    expect(headingsForState(state)[0]!.id).toBe(identity)
    state = state.apply(state.tr.setBlockType(0, state.doc.content.size, strataSchema.nodes.paragraph))
    expect(headingsForState(state)).toEqual([])
  })
})


it.each([63, 65])('preserves headings and source tracking through %i-step transactions', (steps) => {
  const parsed = parseMarkdownForEditor('Before.\n\n## Existing heading\n\nNew heading.\n')
  let state = EditorState.create({ doc: parsed.doc, plugins: [createHeadingPlugin(), createSourceSpanPlugin()] })
  const original = headingsForState(state)[0]!
  const transaction = state.tr
  for (let step = 0; step < steps - 1; step++) transaction.insertText('x', 1)
  const last = transaction.doc.lastChild!
  const position = transaction.doc.content.size - last.nodeSize
  transaction.setBlockType(position, transaction.doc.content.size, strataSchema.nodes.heading, { ...last.attrs, level: 3 })
  state = state.apply(transaction)
  expect(headingsForState(state)).toMatchObject([
    { id: original.id, text: 'Existing heading', position: original.position + steps - 1 },
    { text: 'New heading.', level: 3 },
  ])
  expect(getTrackedSourceBlocks(state).map(({ id, span }) => ({ id, span })))
    .toEqual(parsed.blocks.map(({ id, span }) => ({ id, span })))
  expect(getTrackedSourceBlocks(state)[0]?.dirty).toBe(true)
})
