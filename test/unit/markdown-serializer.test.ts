import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MarkdownNode } from '../../src/core/markdown/index.js'
import { describe, expect, it } from 'vitest'
import {
  parseMarkdown,
  serializeMarkdown,
  serializeMarkdownBlock,
  serializeMarkdownWithMetadata
} from '../../src/core/markdown/index.js'

function paragraph(value: string): MarkdownNode {
  return { type: 'paragraph', children: [{ type: 'text', value }] } as MarkdownNode
}

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../corpus/constructs/${name}`, import.meta.url)), 'utf8')
}

describe('byte-preserving markdown serialization', () => {
  it.each([
    '',
    '\uFEFF',
    '\uFEFF# Heading\r\n\r\n- one  \r\n- two',
    '# Heading\n\nparagraph\n',
    'mixed\r\n\r\nend\n',
    'trailing spaces   '
  ])('round-trips unchanged source exactly', (source) => {
    expect(Buffer.from(serializeMarkdown(parseMarkdown(source)))).toEqual(Buffer.from(source))
  })

  it.each(['visual.md', 'raw.md'])('round-trips the construct corpus byte-for-byte: %s', (name) => {
    const source = fixture(name)
    expect(Buffer.from(serializeMarkdown(parseMarkdown(source)))).toEqual(Buffer.from(source))
  })

  it('rewrites only the edited top-level block', () => {
    const source = '\uFEFF# Keep\r\n\r\nOld *paragraph*  \r\nwrapped\r\n\r\n- keep\r\n- this'
    const parsed = parseMarkdown(source)
    const result = serializeMarkdownWithMetadata(parsed, [
      { block: 1, replacement: paragraph('New paragraph') }
    ])

    expect(result.value).toBe('\uFEFF# Keep\r\n\r\nNew paragraph\r\n\r\n- keep\r\n- this')
    expect(result.rewrittenSpans).toEqual([{
      blockId: 'block-1',
      original: parsed.blocks[1]?.span,
      outputStart: source.indexOf('Old'),
      outputEnd: source.indexOf('Old') + 'New paragraph'.length
    }])
  })

  it('uses detected delimiter, list, heading, fence, and line-ending conventions', () => {
    const context = parseMarkdown([
      'Existing',
      '========',
      '',
      '+ _item_',
      '',
      '~~~js',
      'old',
      '~~~',
      ''
    ].join('\r\n'))

    const list = {
      type: 'list',
      ordered: false,
      spread: false,
      children: [{
        type: 'listItem',
        spread: false,
        children: [{ type: 'paragraph', children: [{ type: 'emphasis', children: [{ type: 'text', value: 'new' }] }] }]
      }]
    } as MarkdownNode
    const heading = { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Changed' }] } as MarkdownNode
    const code = { type: 'code', lang: 'ts', value: 'const x = 1' } as MarkdownNode

    expect(serializeMarkdownBlock(list, context.conventions)).toBe('+ _new_')
    expect(serializeMarkdownBlock(heading, context.conventions)).toBe('Changed\r\n=======')
    expect(serializeMarkdownBlock(code, context.conventions)).toBe('~~~ts\r\nconst x = 1\r\n~~~')
  })

  it('serializes edited GFM strikethrough, task lists, and tables', () => {
    for (const source of ['~~old~~', '- [x] task', '| A |\n| - |\n| B |']) {
      const parsed = parseMarkdown(source)
      const block = parsed.blocks[0]
      expect(block).toBeDefined()
      const output = serializeMarkdown(parsed, [{ block: 0, replacement: block!.node }])
      expect(parseMarkdown(output).blocks[0]?.node.type).toBe(block!.node.type)
      expect(output).toBe(source)
    }
  })

  it('preserves a missing final newline when replacing the last block', () => {
    const parsed = parseMarkdown('# title\n\nold')
    expect(serializeMarkdown(parsed, [{ block: 'block-1', replacement: paragraph('new') }])).toBe('# title\n\nnew')
  })

  it('enlarges a structural rewrite by one line ending when a neighbor would be absorbed', () => {
    const parsed = parseMarkdown('before\n\n---\nafter')
    const result = serializeMarkdownWithMetadata(parsed, [{ block: 1, replacement: paragraph('middle') }])

    expect(result.value).toBe('before\n\nmiddle\n\nafter')
    expect(parseMarkdown(result.value).blocks.map((block) => block.node.type)).toEqual([
      'paragraph', 'paragraph', 'paragraph'
    ])
    const span = result.rewrittenSpans[0]
    expect(span).toBeDefined()
    expect(span!.outputEnd - span!.outputStart).toBe('middle\n'.length)
  })

  it('protects block boundaries for editor-produced markdown strings', () => {
    const parsed = parseMarkdown('before\n\n---\nafter')
    expect(serializeMarkdown(parsed, [{ block: 1, replacement: 'middle' }]))
      .toBe('before\n\nmiddle\n\nafter')
  })

  it('uses source-view replacement strings verbatim', () => {
    const parsed = parseMarkdown('before\n\n[[old]]\n\nafter\n')
    const replacement = '[[new]]  \r\nsource-owned'
    expect(serializeMarkdown(parsed, [{ block: 1, replacement }]))
      .toBe(`before\n\n${replacement}\n\nafter\n`)
  })

  it('supports the smallest possible block deletion and multiple ordered edits', () => {
    const parsed = parseMarkdown('one\n\ntwo\n\nthree')
    const output = serializeMarkdown(parsed, [
      { block: 2, replacement: paragraph('THREE') },
      { block: 0, replacement: null }
    ])
    expect(output).toBe('\n\ntwo\n\nTHREE')
  })

  it('inserts blocks without rewriting existing bytes or merging neighbors', () => {
    const source = '\uFEFFone\r\n\r\ntwo\r\n'
    const parsed = parseMarkdown(source)
    const result = serializeMarkdownWithMetadata(parsed, [
      { insertBefore: 1, replacement: paragraph('middle') },
      { insertBefore: 'end', replacement: paragraph('last') }
    ])

    expect(result.value).toBe('\uFEFFone\r\n\r\nmiddle\r\n\r\ntwo\r\n\r\nlast\r\n')
    expect(result.rewrittenSpans.map((span) => [span.blockId, span.original.start.offset, span.original.end.offset]))
      .toEqual([
        ['insertion-0', parsed.blocks[1]?.span.start.offset, parsed.blocks[1]?.span.start.offset],
        ['insertion-1', source.length, source.length]
      ])
  })

  it('inserts into empty and BOM-only documents', () => {
    expect(serializeMarkdown(parseMarkdown(''), [{ insertBefore: 'end', replacement: paragraph('new') }])).toBe('new')
    expect(serializeMarkdown(parseMarkdown('\uFEFF'), [{ insertBefore: 'end', replacement: paragraph('new') }]))
      .toBe('\uFEFFnew')
  })

  it('rejects unknown and duplicate block references', () => {
    const parsed = parseMarkdown('one')
    expect(() => serializeMarkdown(parsed, [{ block: 3, replacement: 'x' }])).toThrow(RangeError)
    expect(() => serializeMarkdown(parsed, [
      { block: 0, replacement: 'x' },
      { block: 'block-0', replacement: 'y' }
    ])).toThrow(/more than once/)
  })
})
