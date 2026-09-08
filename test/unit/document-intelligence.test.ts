import { EditorState } from 'prosemirror-state'
import { parseMarkdownForEditor, strataSchema } from '../../src/editor/index'
import { createReferencePreviewPlugin } from '../../src/editor/references'
import { describe, expect, it } from 'vitest'
import { parseFileTree, visualCodeFenceKind } from '../../src/editor/code-blocks'
import { MERMAID_CONFIG, normalizeMermaidSource } from '../../src/editor/mermaid-renderer'
import { localMarkdownCandidate, markdownPreviewText } from '../../src/editor/references'
import { referencedHeadings } from '../../src/shared/walkthrough'

describe('Phase 6 document intelligence', () => {
  it('normalizes only syntax that the real review fixture needs under strict Mermaid', () => {
    expect(normalizeMermaidSource('flowchart LR\n A[one<br/>two] --> B')).toBe('flowchart LR\n A[one\ntwo] --> B')
    expect(normalizeMermaidSource('sequenceDiagram\n A-->>B: one; two')).toBe('sequenceDiagram\n A-->>B: one#59; two')
    expect(normalizeMermaidSource('graph LR\n A --> B')).toBe('graph LR\n A --> B')
  })

  it('enhances only exact fences and fixes the Mermaid security contract', () => {
    expect(visualCodeFenceKind('mermaid', null)).toBe('mermaid')
    expect(visualCodeFenceKind('tree', '')).toBe('tree')
    expect(visualCodeFenceKind('Mermaid', null)).toBeNull()
    expect(visualCodeFenceKind('mermaid', 'extra')).toBeNull()
    expect(MERMAID_CONFIG).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
    })
  })

  it('parses ordinary branch glyphs and rejects unsafe indentation jumps', () => {
    expect(parseFileTree('root/\n├── a.md\n└── src/\n    └── index.ts\n')).toEqual([{
      label: 'root/',
      children: [
        { label: 'a.md', children: [] },
        { label: 'src/', children: [{ label: 'index.ts', children: [] }] },
      ],
    }])
    expect(parseFileTree('root/\n        too-deep.md\n')).toBeNull()
  })

  it('recognizes only complete local Markdown paths and creates plain bounded copy', () => {
    expect(localMarkdownCandidate('../notes/one.md#part')).toBe('../notes/one.md#part')
    expect(localMarkdownCandidate('https://example.test/one.md')).toBeNull()
    expect(localMarkdownCandidate('one.ts')).toBeNull()
    expect(markdownPreviewText('# Title\n\nRead **this** [source](two.md).')).toEqual({ title: 'Title', excerpt: 'Title Read this source.' })
  })

  it('builds conservative references for every Markdown heading level', () => {
    const references = referencedHeadings(Array.from({ length: 6 }, (_, index) => ({
      level: index + 1,
      text: `Level ${index + 1}`,
    })))
    expect(references.map(({ reference }) => reference.level)).toEqual([1, 2, 3, 4, 5, 6])
    expect(references[5]?.reference).toMatchObject({ text: 'Level 6', parentText: 'Level 5' })
  })
})


it.each([63, 65])('finds a reference created by a %i-step transaction and removes its decoration on deletion', (steps) => {
  const plugin = createReferencePreviewPlugin()
  let state = EditorState.create({ doc: parseMarkdownForEditor('Before.\n\nReference.').doc, plugins: [plugin] })
  const transaction = state.tr
  for (let step = 0; step < steps - 1; step++) transaction.insertText('x', 1)
  const at = transaction.doc.content.size - 1
  transaction.insert(at, strataSchema.text('docs/plan.md', [strataSchema.marks.code.create()]))
  state = state.apply(transaction)
  expect(plugin.getState(state)?.find()).toHaveLength(1)
  state = state.apply(state.tr.delete(at, at + 'docs/plan.md'.length))
  expect(plugin.getState(state)?.find()).toHaveLength(0)
})
