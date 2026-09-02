import { EditorState } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { parseMarkdown, validateComponentMarkdown } from '../../src/core/markdown'
import { annotatedScreenshotData, type ComponentAstNode } from '../../src/core/markdown/components'
import { parseMarkdownForEditor, serializeEditorDocument } from '../../src/editor/markdown'
import { strataSchema } from '../../src/editor/schema'

function problemCodes(source: string): string[] {
  return validateComponentMarkdown(source).problems.map((problem) => problem.code)
}

describe('Phase 8 visual component schemas', () => {
  it.each([
    ['DecisionMatrix', '<DecisionMatrix>\n| Criterion | A | B |\n|---|---|---|\n| Safety | High | Low |\n</DecisionMatrix>'],
    ['BeforeAfter', '<BeforeAfter>\n> ### Before\n> Manual review.\n\n> ### After\n> Tracked review.\n</BeforeAfter>'],
    ['Chart', '<Chart kind="bar">\n| Month | Open | Typing |\n|---|---:|---:|\n| Jul | 240 | 12.4 |\n</Chart>'],
    ['EvidenceChain', '<EvidenceChain>\n### Claim\n\nA claim.\n\n### Evidence\n\n- [Local](./evidence.md#finding)\n- [This section](#finding)\n\n### Therefore\n\nThe conclusion.\n</EvidenceChain>'],
    ['AnnotatedScreenshot', '<AnnotatedScreenshot>\n![Review](./review.png)\n\n| Pin | X | Y | Image version | Note |\n|---:|---:|---:|---|---|\n| 1 | 24.0 | 31.5 | 42:1000 | Boundary. |\n</AnnotatedScreenshot>'],
  ])('accepts the exact %s schema', (name, source) => {
    expect(validateComponentMarkdown(source)).toMatchObject({ valid: true, components: [{ name, line: 1 }], problems: [] })
    const parsed = parseMarkdownForEditor(source)
    expect(parsed.doc.firstChild).toMatchObject({ type: strataSchema.nodes.component_block, attrs: { name } })
    expect(serializeEditorDocument(parsed, parsed.doc)).toBe(source)
  })

  it.each([
    ['DecisionMatrix', '<DecisionMatrix>\n| Choice | A |\n|---|---|\n| Safety | High |\n</DecisionMatrix>', 'COMPONENT_BODY_INVALID'],
    ['BeforeAfter', '<BeforeAfter>\n### Before\n\nPlain.\n\n> ### After\n> Quoted.\n</BeforeAfter>', 'COMPONENT_BODY_INVALID'],
    ['Chart', '<Chart>\n| Month | Value |\n|---|---:|\n| Jul | NaN |\n</Chart>', 'COMPONENT_BODY_INVALID'],
    ['EvidenceChain', '<EvidenceChain>\n### Claim\n\nClaim.\n\n### Evidence\n\n- (05 §4)\n\n### Therefore\n\nConclusion.\n</EvidenceChain>', 'COMPONENT_TARGET_REQUIRED'],
    ['AnnotatedScreenshot', '<AnnotatedScreenshot>\n![Review](https://example.com/review.png)\n\n| Pin | X | Y | Image version | Note |\n|---:|---:|---:|---|---|\n</AnnotatedScreenshot>', 'COMPONENT_BODY_INVALID'],
  ])('rejects malformed %s structure without rewriting it', (_name, source, code) => {
    expect(problemCodes(source)).toContain(code)
    const parsed = parseMarkdownForEditor(source)
    expect(parsed.doc.firstChild?.attrs.kind).toBe('component-error')
    expect(serializeEditorDocument(parsed, parsed.doc)).toBe(source)
  })

  it('bounds Chart kinds, series, values, and row count', () => {
    expect(problemCodes('<Chart kind="pie">\n| Label | Value |\n|---|---:|\n| A | 1 |\n</Chart>')).toContain('COMPONENT_PROPERTY_VALUE')
    expect(problemCodes('<Chart>\n| Label | A | B | C | D | E | F | G |\n|---|---:|---:|---:|---:|---:|---:|---:|\n| A | 1 | 2 | 3 | 4 | 5 | 6 | 7 |\n</Chart>')).toContain('COMPONENT_BODY_INVALID')
    expect(problemCodes('<Chart>\n| Label | |\n|---|---:|\n| A | 1 |\n</Chart>')).toContain('COMPONENT_BODY_INVALID')
    expect(problemCodes('<Chart>\n| Label | Value |\n|---|---:|\n| | 1 |\n</Chart>')).toContain('COMPONENT_BODY_INVALID')
    const rows = Array.from({ length: 1_001 }, (_, index) => `| R${index} | ${index} |`).join('\n')
    expect(problemCodes(`<Chart>\n| Label | Value |\n|---|---:|\n${rows}\n</Chart>`)).toContain('COMPONENT_BODY_INVALID')
  })

  it('validates screenshot pins without throwing on short rows', () => {
    const cases = [
      '| 1 | 10 | 20 |',
      '| 0 | 10 | 20 | 42:1000 | Zero pin. |',
      '| 1 | 101 | 20 | 42:1000 | Outside. |',
      '| 1 | 10 | 20 | handwritten | Wrong version. |',
      '| 1 | 10 | 20 | 42:1000 | First. |\n| 1 | 30 | 40 | 42:1000 | Duplicate. |',
      '| 1 | 10 | 20 | 42:1000 | |',
    ]
    for (const rows of cases) {
      const source = `<AnnotatedScreenshot>\n![Review](./review.png)\n\n| Pin | X | Y | Image version | Note |\n|---:|---:|---:|---|---|\n${rows}\n</AnnotatedScreenshot>`
      expect(() => validateComponentMarkdown(source)).not.toThrow()
      expect(problemCodes(source)).toContain('COMPONENT_PIN_INVALID')
    }
  })

  it('extracts prepared screenshot data and keeps Timeline raw', () => {
    const source = '<AnnotatedScreenshot>\n![Review](./review.png)\n\n| Pin | X | Y | Image version | Note |\n|---:|---:|---:|---|---|\n| 3 | 12.5 | 80 | 42:1000 | Third pin. |\n</AnnotatedScreenshot>'
    const node = parseMarkdown(source).blocks[0]!.node as unknown as ComponentAstNode
    expect(annotatedScreenshotData(node)).toEqual({
      imageSource: './review.png',
      pins: [{ pin: 3, x: 12.5, y: 80, version: '42:1000', note: 'Third pin.' }],
      tableEnd: source.indexOf('\n</AnnotatedScreenshot>'),
    })
    const editor = parseMarkdownForEditor(source)
    const table = editor.doc.firstChild?.lastChild
    const noteCell = table?.lastChild?.lastChild
    expect(source.slice(Number(noteCell?.attrs.sourceFrom), Number(noteCell?.attrs.sourceTo))).toBe('| Third pin. |')
    const timeline = '<Timeline>\n- Started\n- Complete\n</Timeline>'
    expect(validateComponentMarkdown(timeline)).toMatchObject({ valid: false, problems: [{ code: 'COMPONENT_UNKNOWN' }] })
    expect(parseMarkdownForEditor(timeline).doc.firstChild?.attrs.kind).toBe('html')
  })

  it('rewrites only the edited child of an extended visual', () => {
    const source = '<EvidenceChain>\r\n### Claim\r\n\r\nA claim.\r\n\r\n### Evidence\r\n\r\n- [Finding](./evidence.md#finding)  \r\n\r\n### Therefore\r\n\r\nKeep this spacing.\r\n</EvidenceChain>\r\n\r\nUntouched.\r\n'
    const parsed = parseMarkdownForEditor(source)
    let position = -1
    parsed.doc.descendants((node, offset) => {
      if (position < 0 && node.isText && node.text?.includes('claim')) position = offset + node.text.indexOf('claim')
    })
    const state = EditorState.create({ schema: strataSchema, doc: parsed.doc })
    const changed = state.apply(state.tr.insertText('finding', position, position + 'claim'.length)).doc
    expect(serializeEditorDocument(parsed, changed)).toBe(source.replace('A claim.', 'A finding.'))
  })
})
