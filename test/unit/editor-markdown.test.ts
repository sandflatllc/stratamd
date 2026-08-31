import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import {
  createCoreMarkdownEdits,
  createEditorCommands,
  createEditorMarkdownUpdate,
  frontmatterChipLabel,
  frontmatterKeyCount,
  parseMarkdownForEditor,
  serializeEditorDocument,
  strataSchema,
} from '../../src/editor/index.js'

const corpus = (name: string): string => readFileSync(resolve('test/corpus', name), 'utf8')

describe('StrataMD editor markdown bridge', () => {
  function replaceText(source: string, target: string, replacement: string): string {
    const parsed = parseMarkdownForEditor(source)
    let from = -1
    parsed.doc.descendants((node, pos) => {
      if (!node.isText || from >= 0) return
      const offset = node.text?.indexOf(target) ?? -1
      if (offset >= 0) from = pos + offset
    })
    expect(from).toBeGreaterThan(0)
    const state = EditorState.create({ schema: strataSchema, doc: parsed.doc })
    const changed = state.apply(state.tr.insertText(replacement, from, from + target.length)).doc
    return serializeEditorDocument(parsed, changed)
  }

  it('renders code spans and code blocks with spellcheck disabled', () => {
    const parsed = parseMarkdownForEditor('See `core/README.md`.\n\n```\nrecords-v1-single-file.md\n```\n')
    let block: ProseMirrorNode | undefined
    let span: ProseMirrorNode | undefined
    parsed.doc.descendants((node) => {
      if (node.type === strataSchema.nodes.code_block) block = node
      if (node.isText && node.marks.some((mark) => mark.type === strataSchema.marks.code)) span = node
    })
    expect(block).toBeDefined()
    expect(span).toBeDefined()
    const blockSpec = block!.type.spec.toDOM?.(block!) as readonly unknown[]
    expect((blockSpec[1] as Record<string, string>).spellcheck).toBe('false')
    const codeMark = span!.marks.find((mark) => mark.type === strataSchema.marks.code)!
    const markSpec = codeMark.type.spec.toDOM?.(codeMark, true) as readonly unknown[]
    expect((markSpec[1] as Record<string, string>).spellcheck).toBe('false')
  })

  it('renders YAML as the exact collapsed frontmatter chip contract', () => {
    const source = '---\ntitle: Rollout plan\nowner: me\n  nested: ignored\n---\n\nBody\n'
    const parsed = parseMarkdownForEditor(source)
    const frontmatter = parsed.doc.content.content.find((node) => node.attrs.kind === 'yaml')
    expect(frontmatter).toBeDefined()
    expect(frontmatterKeyCount(String(frontmatter?.attrs.raw))).toBe(2)
    expect(frontmatterChipLabel(String(frontmatter?.attrs.raw))).toBe('▸ --- frontmatter · 2 keys ---')

    const spec = frontmatter?.type.spec.toDOM?.(frontmatter) as readonly unknown[]
    const detailsAttrs = spec[1] as Record<string, string>
    const summary = spec[2] as readonly unknown[]
    const summaryAttrs = summary[1] as Record<string, string>
    expect(detailsAttrs['data-frontmatter-key-count']).toBe('2')
    expect(summary[2]).toBe('▸ --- frontmatter · 2 keys ---')
    expect(summaryAttrs.style).toContain('border-radius:12px')
    expect(summaryAttrs.style).toContain("font-family:var(--font-code),'JetBrains Mono'")
  })

  it('renders a checked task with an animated check glyph and struck label', () => {
    const parsed = parseMarkdownForEditor('- [x] Land the byte-preserving save\n')
    let task: ProseMirrorNode | undefined
    parsed.doc.descendants((node) => {
      if (node.type === strataSchema.nodes.list_item) task = node
    })
    expect(task).toBeDefined()

    const spec = task?.type.spec.toDOM?.(task) as readonly unknown[]
    const checkbox = spec[2] as readonly unknown[]
    const checkboxAttrs = checkbox[1] as Record<string, string>
    const glyph = checkbox[2] as readonly unknown[]
    const glyphAttrs = glyph[1] as Record<string, string>
    const content = spec[3] as readonly unknown[]
    const contentAttrs = content[1] as Record<string, string>
    expect(checkboxAttrs).toEqual(expect.objectContaining({
      role: 'checkbox',
      'aria-checked': 'true',
      'data-task-checkbox': 'true',
    }))
    expect(glyph[2]).toBe('✓')
    expect(glyphAttrs.style).toContain('animation:checkPop')
    expect(contentAttrs.style).toContain('text-decoration:line-through')
    expect(contentAttrs.style).toContain('color:var(--interface-muted)')
  })

  it('represents the visual CommonMark and GFM construct matrix', () => {
    const parsed = parseMarkdownForEditor(corpus('constructs/visual.md'))
    const topLevel = parsed.doc.content.content.map((node) => node.type.name)
    expect(topLevel).toEqual(expect.arrayContaining([
      'heading',
      'paragraph',
      'bullet_list',
      'table',
      'blockquote',
      'horizontal_rule',
      'code_block',
    ]))
    expect(parsed.doc.textContent).toContain('emphasis')
    expect(parsed.doc.textContent).toContain('a hard break, a soft')

    let taskItems = 0
    let checkedItems = 0
    parsed.doc.descendants((node) => {
      if (node.type === strataSchema.nodes.list_item && typeof node.attrs.checked === 'boolean') {
        taskItems += 1
        if (node.attrs.checked) checkedItems += 1
      }
    })
    expect(taskItems).toBe(2)
    expect(checkedItems).toBe(1)
  })

  it('turns unsupported syntax into source-only raw blocks', () => {
    const parsed = parseMarkdownForEditor(corpus('constructs/raw.md'))
    const rawKinds = parsed.doc.content.content
      .filter((node) => node.type === strataSchema.nodes.raw_block)
      .map((node) => node.attrs.kind)
    expect(rawKinds).toEqual(expect.arrayContaining([
      'yaml',
      'footnote',
      'wiki-link',
      'math',
      'html',
      'link-definition',
    ]))
    for (const node of parsed.doc.content.content) {
      if (node.type === strataSchema.nodes.raw_block) expect(node.isAtom).toBe(true)
    }
  })

  it.each([
    'constructs/visual.md',
    'constructs/raw.md',
    'real/launch-queue-index.md',
    'real/customer-document-bridge.md',
    'real/security-stability-plan.md',
  ])('round-trips an untouched corpus file byte for byte: %s', (fixture) => {
    const source = corpus(fixture)
    const parsed = parseMarkdownForEditor(source)
    expect(serializeEditorDocument(parsed, parsed.doc)).toBe(source)
    expect(createCoreMarkdownEdits(parsed, parsed.doc)).toEqual([])
  })

  it('edits the visual construct corpus without normalizing untouched inline syntax', () => {
    const source = corpus('constructs/visual.md')
    const expected = source.replace('A paragraph', 'A revised paragraph')
    expect(replaceText(source, 'A paragraph', 'A revised paragraph')).toBe(expected)
  })

  it('keeps strong marks wrapped around code spans in an edited block', () => {
    const source = '**The design is the handoff in `docs/design/`** for every layout choice.\n'
    expect(replaceText(source, 'layout', 'shell')).toBe(
      '**The design is the handoff in `docs/design/`** for every shell choice.\n',
    )
  })

  it('keeps emphasis continuous across multiple code spans in an edited block', () => {
    const source = 'Say *"edit a `.md` with them, run `stratamd --agent-help` first."* to the agent.\n'
    expect(replaceText(source, 'Say', 'Tell')).toBe(
      'Tell *"edit a `.md` with them, run `stratamd --agent-help` first."* to the agent.\n',
    )
  })

  it('keeps nested emphasis, links, and strikes inside outer marks in an edited block', () => {
    const source = '**bold with *nested emphasis* and a [link](https://example.test) inside** stays intact.\n'
    expect(replaceText(source, 'intact', 'together')).toBe(
      '**bold with *nested emphasis* and a [link](https://example.test) inside** stays together.\n',
    )
  })

  it('retains BOM, CRLF, trailing spaces, and a missing final newline outside an edited block', () => {
    const source = '\ufeff# Title\r\n\r\nParagraph with  spaces  \r\n\r\n* item'
    const parsed = parseMarkdownForEditor(source)
    let titlePosition = 0
    parsed.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'Title') titlePosition = pos
    })
    const state = EditorState.create({ schema: strataSchema, doc: parsed.doc })
    const changed = state.apply(state.tr.insertText('New ', titlePosition, titlePosition)).doc
    const serialized = serializeEditorDocument(parsed, changed)
    expect(serialized.startsWith('\ufeff# New Title\r\n\r\n')).toBe(true)
    expect(serialized).toContain('Paragraph with  spaces  \r\n\r\n* item')
    expect(serialized.endsWith('\n')).toBe(false)
    const update = createEditorMarkdownUpdate(parsed, changed)
    expect(update.blocks.filter((block) => !block.unchanged)).toHaveLength(1)
  })

  it('preserves entities, escapes, and hard-break spelling inside an edited paragraph', () => {
    const source = 'Keep &copy; and an escaped \\*asterisk\\*.\\\r\nEdit target.\r\n'
    expect(replaceText(source, 'target', 'result')).toBe(
      'Keep &copy; and an escaped \\*asterisk\\*.\\\r\nEdit result.\r\n',
    )
  })

  it('keeps an entity inside one existing emphasis run', () => {
    const source = 'Prefix **A &copy; B** and edit target.\n'
    expect(replaceText(source, 'target', 'result')).toBe(
      'Prefix **A &copy; B** and edit result.\n',
    )
  })

  it('preserves two-space hard breaks and CRLF inside an edited paragraph', () => {
    const source = 'First line  \r\nEdit target and keep &amp;.\r\n'
    expect(replaceText(source, 'target', 'result')).toBe(
      'First line  \r\nEdit result and keep &amp;.\r\n',
    )
  })

  it('retains fenced code metadata when editing the code body', () => {
    const source = '```ts title="demo" linenos\nconst old = 1\n```\n\nUntouched.\n'
    expect(replaceText(source, 'old', 'next')).toBe(
      '```ts title="demo" linenos\nconst next = 1\n```\n\nUntouched.\n',
    )
  })

  it('keeps reference-image syntax when editing neighboring inline text', () => {
    const source = '![diagram][asset] and edit target.\n\n[asset]: ./diagram.png "Diagram"\n'
    expect(replaceText(source, 'target', 'result')).toBe(
      '![diagram][asset] and edit result.\n\n[asset]: ./diagram.png "Diagram"\n',
    )
  })

  it('keeps untouched later blocks verbatim when a source block splits', () => {
    const source = 'Alpha bravo\r\n\r\n+   oddly-indented list\r\n'
    const parsed = parseMarkdownForEditor(source)
    const state = EditorState.create({ schema: strataSchema, doc: parsed.doc })
    const changed = state.apply(state.tr.split(7)).doc
    const serialized = serializeEditorDocument(parsed, changed)
    expect(serialized).toBe('Alpha \r\n\r\nbravo\r\n\r\n+   oddly-indented list\r\n')
    expect(createCoreMarkdownEdits(parsed, changed)).toEqual([
      expect.objectContaining({ block: 'block-0', replacement: 'Alpha \r\n\r\nbravo' }),
    ])
  })

  it('makes the launch queue target strong without rewriting another byte', () => {
    const source = corpus('real/launch-queue-index.md')
    const target = 'navigation index'
    const parsed = parseMarkdownForEditor(source)
    let from = -1
    parsed.doc.descendants((node, pos) => {
      if (!node.isText || from >= 0) return
      const offset = node.text?.indexOf(target) ?? -1
      if (offset >= 0) from = pos + offset
    })
    expect(from).toBeGreaterThan(0)
    let state = EditorState.create({ schema: strataSchema, doc: parsed.doc })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + target.length)))
    const command = createEditorCommands().toggleStrong
    let transaction: typeof state.tr | undefined
    expect(command(state, (next) => { transaction = next })).toBe(true)
    expect(transaction).toBeDefined()
    state = state.apply(transaction!)

    expect(serializeEditorDocument(parsed, state.doc)).toBe(source.replace(target, `**${target}**`))
    expect(createCoreMarkdownEdits(parsed, state.doc)).toEqual([
      expect.objectContaining({ block: 'block-1' }),
    ])
  })

  it('adds strong across a mixed-mark selection instead of removing existing strong', () => {
    const source = 'Prefix **already bold** and plain suffix.\n\nUntouched block.\n'
    const parsed = parseMarkdownForEditor(source)
    const selected = 'already bold and plain'
    let start = -1
    let text = ''
    const positions: number[] = []
    parsed.doc.descendants((node, pos) => {
      if (!node.isText) return
      for (let index = 0; index < (node.text?.length ?? 0); index += 1) positions.push(pos + index)
      text += node.text ?? ''
      if (node.isBlock) text += '\n'
    })
    start = text.indexOf(selected)
    expect(start).toBeGreaterThanOrEqual(0)
    const from = positions[start]!
    const to = positions[start + selected.length - 1]! + 1
    let state = EditorState.create({ schema: strataSchema, doc: parsed.doc })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
    let transaction: typeof state.tr | undefined
    createEditorCommands().toggleStrong(state, (next) => { transaction = next })
    state = state.apply(transaction!)
    expect(serializeEditorDocument(parsed, state.doc)).toBe(
      'Prefix **already bold and plain** suffix.\n\nUntouched block.\n',
    )
  })

  it('uses the document strong delimiter for a new mark and preserves existing marks', () => {
    const source = 'Prefix __existing strong__ then plain target.\n'
    const parsed = parseMarkdownForEditor(source)
    const target = 'plain target'
    let from = -1
    parsed.doc.descendants((node, pos) => {
      if (!node.isText || from >= 0) return
      const offset = node.text?.indexOf(target) ?? -1
      if (offset >= 0) from = pos + offset
    })
    let state = EditorState.create({ schema: strataSchema, doc: parsed.doc })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + target.length)))
    let transaction: typeof state.tr | undefined
    createEditorCommands().toggleStrong(state, (next) => { transaction = next })
    state = state.apply(transaction!)
    expect(serializeEditorDocument(parsed, state.doc)).toBe(
      'Prefix __existing strong__ then __plain target__.\n',
    )
  })

  it('parses an empty buffer as an editable paragraph', () => {
    const parsed = parseMarkdownForEditor('')
    expect(parsed.doc.childCount).toBe(1)
    expect(parsed.doc.firstChild?.type).toBe(strataSchema.nodes.paragraph)
    expect(serializeEditorDocument(parsed, parsed.doc)).toBe('')
  })
})
