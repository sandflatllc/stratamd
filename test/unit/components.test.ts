import { EditorState } from 'prosemirror-state'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Fragment } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import {
  COMPONENT_NAMES,
  COMPONENT_REGISTRY,
  parseMarkdown,
  validateComponentMarkdown,
} from '../../src/core/markdown'
import {
  createCoreMarkdownEdits,
  parseMarkdownForEditor,
  serializeEditorDocument,
} from '../../src/editor/markdown'
import { strataSchema } from '../../src/editor/schema'

const examples = COMPONENT_NAMES.map((name) => [name, COMPONENT_REGISTRY[name].example] as const)

describe('registered component tags', () => {
  it.each(examples)('parses %s only as a top-level registered component', (name, source) => {
    const core = parseMarkdown(source)
    expect(core.blocks).toHaveLength(1)
    expect(core.blocks[0]).toMatchObject({ presentation: 'visual' })
    expect(core.blocks[0]?.node).toMatchObject({ type: 'mdxJsxFlowElement', name })

    const editor = parseMarkdownForEditor(source)
    expect(editor.doc.firstChild?.type).toBe(strataSchema.nodes.component_block)
    expect(editor.doc.firstChild?.attrs.name).toBe(name)
    expect(serializeEditorDocument(editor, editor.doc)).toBe(source)
    expect(validateComponentMarkdown(source).valid).toBe(true)
  })

  it('does not activate component examples inside fences or lists', () => {
    const skill = readFileSync(resolve('skills/stratamd/SKILL.md'), 'utf8')
    const skillNodes = parseMarkdown(skill).ast.children
    expect(skillNodes.filter((node) => node.type === 'code')).toHaveLength(12)
    expect(skillNodes.filter((node) => (node as { type: string }).type === 'mdxJsxFlowElement')).toHaveLength(0)

    const list = '- first\n  <Callout>\n  Kept as text.\n  </Callout>\n- second\n'
    const parsedList = parseMarkdown(list)
    expect(parsedList.ast.children[0]).toMatchObject({ type: 'list', children: [{ type: 'listItem' }, { type: 'listItem' }] })
    expect(serializeEditorDocument(parseMarkdownForEditor(list), parseMarkdownForEditor(list).doc)).toBe(list)

    const fenced = '~~~~\n<Callout>\n```\n</Callout>\n~~~~\n'
    expect(parseMarkdown(fenced).ast.children).toEqual([expect.objectContaining({ type: 'code' })])
  })

  it('validates with the same bounded parser used by the app', () => {
    expect(validateComponentMarkdown('<br>\n\n<Callout>\nContext.\n</Callout>').valid).toBe(true)
    expect(validateComponentMarkdown('Before <Callout>inside</Callout> after.')).toMatchObject({
      valid: false,
      problems: [expect.objectContaining({ code: 'COMPONENT_TOP_LEVEL_REQUIRED' })],
    })
  })

  it('keeps unknown, lowercase HTML, and inline registered tags raw and non-executable', () => {
    for (const source of [
      '<Unknown>\nBody.\n</Unknown>',
      '<div>\nBody.\n</div>',
      'Before <Callout>inside</Callout> after.',
    ]) {
      const parsed = parseMarkdownForEditor(source)
      expect(parsed.doc.firstChild?.type).toBe(strataSchema.nodes.raw_block)
      expect(parsed.doc.firstChild?.attrs.kind).toBe('html')
      expect(serializeEditorDocument(parsed, parsed.doc)).toBe(source)
    }
  })

  it('rejects expressions, unknown values, extra properties, empty bodies, and nesting', () => {
    const cases = [
      ['<Callout kind={warning}>\nBody.\n</Callout>', 'COMPONENT_PROPERTY_QUOTED'],
      ['<Callout kind="loud">\nBody.\n</Callout>', 'COMPONENT_PROPERTY_VALUE'],
      ['<MetricStrip color="pink">\n- **One:** 1\n</MetricStrip>', 'COMPONENT_PROPERTY_UNKNOWN'],
      ['<Verdict outcome="neutral"></Verdict>', 'COMPONENT_BODY_REQUIRED'],
      ['<PhaseBoard>\n<Callout>\nBody.\n</Callout>\n</PhaseBoard>', 'COMPONENT_NESTED'],
    ] as const
    for (const [source, code] of cases) {
      const report = validateComponentMarkdown(source)
      expect(report.valid, source).toBe(false)
      expect(report.problems.map((item) => item.code), source).toContain(code)
      const parsed = parseMarkdownForEditor(source)
      expect(parsed.doc.firstChild?.type, source).toBe(strataSchema.nodes.raw_block)
      expect(parsed.doc.firstChild?.attrs.kind, source).toBe('component-error')
      expect(serializeEditorDocument(parsed, parsed.doc), source).toBe(source)
    }
  })

  it('reports unknown Pascal-case tags but ignores ordinary HTML during validation', () => {
    const report = validateComponentMarkdown('<div>plain</div>\n\n<UnknownVisual>\nBody.\n</UnknownVisual>')
    expect(report.valid).toBe(false)
    expect(report.problems).toEqual([
      expect.objectContaining({ code: 'COMPONENT_UNKNOWN', component: 'UnknownVisual' }),
    ])
  })

  it('retains nested child spans and rewrites only the edited child bytes', () => {
    const source = [
      '# Before',
      '',
      '<Callout kind="warning">',
      '### Keep _this delimiter_',
      '',
      'Edit target while this hard wrap',
      'stays exactly here.',
      '',
      '- untouched  ',
      '  list child',
      '</Callout>',
      '',
      'After with  spaces.',
    ].join('\r\n')
    const parsed = parseMarkdownForEditor(source)
    const component = parsed.doc.child(1)
    expect(component.type).toBe(strataSchema.nodes.component_block)
    const childSpans = component.content.content.map((child) => [child.attrs.sourceFrom, child.attrs.sourceTo])
    expect(childSpans.every(([from, to]) => typeof from === 'number' && typeof to === 'number' && from < to)).toBe(true)

    let target = -1
    component.descendants((node, position) => {
      if (!node.isText || target >= 0) return
      const offset = node.text?.indexOf('target') ?? -1
      if (offset >= 0) target = component.resolve(0).start(0) + position + offset
    })
    // Positions from a child traversal are relative to the component. Locate
    // the same text once in the document to avoid relying on its outer offset.
    parsed.doc.descendants((node, position) => {
      if (!node.isText || node.text?.includes('target') !== true) return
      target = position + node.text.indexOf('target')
    })
    expect(target).toBeGreaterThan(0)
    const state = EditorState.create({ schema: strataSchema, doc: parsed.doc })
    const changed = state.apply(state.tr.insertText('result', target, target + 'target'.length)).doc
    const expected = source.replace('Edit target while', 'Edit result while')
    expect(serializeEditorDocument(parsed, changed)).toBe(expected)
    expect(createCoreMarkdownEdits(parsed, changed)).toEqual([{
      block: 'block-1',
      replacement: source.slice(source.indexOf('<Callout'), source.indexOf('</Callout>') + '</Callout>'.length)
        .replace('Edit target while', 'Edit result while'),
    }])
    expect(serializeEditorDocument(parsed, changed)).toContain('### Keep _this delimiter_')
    expect(serializeEditorDocument(parsed, changed)).toContain('- untouched  \r\n  list child')
  })

  it('serializes only properties that were explicitly written', () => {
    for (const source of [
      '<Chart>\n| Label | Value |\n|---|---:|\n| A | 1 |\n</Chart>',
      '<Callout kind="context">\nContext.\n</Callout>',
    ]) {
      const parsed = parseMarkdownForEditor(source)
      const component = parsed.doc.firstChild!
      const extra = strataSchema.nodes.paragraph.create(null, strataSchema.text('Added paragraph.'))
      const changed = component.copy(component.content.append(Fragment.from(extra)))
      const doc = parsed.doc.type.create(parsed.doc.attrs, changed)
      const result = serializeEditorDocument(parsed, doc)
      expect(result.split('\n')[0]).toBe(source.split('\n')[0])
    }
  })

  it('reports malformed component syntax without throwing or rewriting it', () => {
    const source = '<Callout kind="warning">\nBody without a close.\n'
    expect(validateComponentMarkdown(source)).toMatchObject({ valid: false, problems: [{ code: 'COMPONENT_SYNTAX' }] })
    const parsed = parseMarkdownForEditor(source)
    expect(parsed.doc.firstChild?.type).toBe(strataSchema.nodes.raw_block)
    expect(parsed.doc.firstChild?.attrs.kind).toBe('component-error')
    expect(serializeEditorDocument(parsed, parsed.doc)).toBe(source)
  })

  it('does not report malformed ordinary HTML as a component problem', () => {
    expect(validateComponentMarkdown('<div>ordinary HTML without a close')).toEqual({
      valid: true,
      components: [],
      problems: [],
    })
  })
})
