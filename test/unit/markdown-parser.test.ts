import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../../src/core/markdown/index.js'

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../corpus/constructs/${name}`, import.meta.url)), 'utf8')
}

describe('parseMarkdown', () => {
  it('retains exact top-level character and UTF-8 byte spans', () => {
    const source = '\uFEFF# café\r\n\r\nEmoji 😀 and text'
    const parsed = parseMarkdown(source)

    expect(parsed.blocks).toHaveLength(2)
    expect(parsed.blocks[0]?.source).toBe('# café')
    expect(parsed.blocks[0]?.span.start.offset).toBe(1)
    expect(parsed.blocks[0]?.span.start.byteOffset).toBe(3)
    expect(parsed.blocks[0]?.span.end.byteOffset).toBe(Buffer.byteLength('\uFEFF# café'))
    expect(parsed.blocks[1]?.source).toBe('Emoji 😀 and text')
    expect(parsed.gaps).toEqual(['\uFEFF', '\r\n\r\n', ''])

    const heading = parsed.ast.children[0]
    expect(heading?.position?.start.offset).toBe(1)
    expect(heading?.position?.end.offset).toBe(7)
  })

  it('parses the full visual CommonMark and GFM corpus', () => {
    const parsed = parseMarkdown(fixture('visual.md'))
    const types = parsed.ast.children.map((node) => node.type)

    expect(types).toContain('heading')
    expect(types).toContain('paragraph')
    expect(types).toContain('list')
    expect(types).toContain('table')
    expect(types).toContain('blockquote')
    expect(types).toContain('thematicBreak')
    expect(types.filter((type) => type === 'code')).toHaveLength(2)
    expect(parsed.blocks.every((block) => block.presentation === 'visual')).toBe(true)

    const allNodeTypes = new Set<string>()
    const visit = (node: { type: string; children?: readonly unknown[] }): void => {
      allNodeTypes.add(node.type)
      for (const child of node.children ?? []) visit(child as typeof node)
    }
    visit(parsed.ast)
    expect(allNodeTypes).toEqual(expect.objectContaining(new Set([
      'emphasis', 'strong', 'delete', 'inlineCode', 'link', 'image', 'break', 'table', 'list'
    ])))
  })

  it('marks source-only constructs as raw top-level blocks', () => {
    const parsed = parseMarkdown(fixture('raw.md'))
    const rawKinds = parsed.blocks.filter((block) => block.presentation === 'raw').map((block) => block.rawKind)

    expect(rawKinds).toContain('frontmatter')
    expect(rawKinds).toContain('footnote')
    expect(rawKinds).toContain('wiki-link')
    expect(rawKinds).toContain('math')
    expect(rawKinds).toContain('html')
    expect(rawKinds).toContain('link-definition')
  })

  it('does not mistake escaped wiki and dollar syntax for raw constructs', () => {
    const parsed = parseMarkdown('Escaped \\[\\[page]], \\$5, and a price of $6.')
    expect(parsed.blocks[0]).toMatchObject({ presentation: 'visual' })
  })

  it('keeps inline HTML source-only rather than rendering it', () => {
    const parsed = parseMarkdown('before <span>inside</span> after')
    expect(parsed.blocks[0]).toMatchObject({ presentation: 'raw', rawKind: 'html' })
  })

  it('detects neighboring source conventions', () => {
    const source = [
      'Setext',
      '======',
      '',
      '+ _one_ and __two__',
      '+ next',
      '',
      '1) first',
      '2) second',
      '',
      '~~~js',
      'code',
      '~~~',
      '',
      '- - -',
      ''
    ].join('\r\n')
    const conventions = parseMarkdown(`\uFEFF${source}`).conventions

    expect(conventions).toMatchObject({
      bom: true,
      lineEnding: '\r\n',
      hasFinalNewline: true,
      bullet: '+',
      bulletOrdered: ')',
      emphasis: '_',
      strong: '_',
      listItemIndent: 'one',
      fence: '~',
      heading: 'setext',
      rule: '-',
      ruleSpaces: true
    })
  })

  it('keeps empty, BOM-only, CR-only, and missing-final-newline metadata', () => {
    expect(parseMarkdown('').blocks).toEqual([])
    expect(parseMarkdown('\uFEFF').gaps).toEqual(['\uFEFF'])
    expect(parseMarkdown('one\rtwo').conventions.lineEnding).toBe('\r')
    expect(parseMarkdown('no newline').conventions.hasFinalNewline).toBe(false)
  })
})
