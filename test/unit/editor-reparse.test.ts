import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createEditorMarkdownUpdate,
  describeParseDivergence,
  parseMarkdownForEditor,
  reparseStats,
  resetReparseStats,
  serializeEditorDocument,
  strataSchema,
  updateParsedMarkdown,
} from '../../src/editor/index.js'
import type { ParsedEditorMarkdown } from '../../src/editor/types.js'
import { generateCorpus } from '../performance/corpus.js'
import type { CorpusShape } from '../performance/types.js'

/** Deterministic PRNG so failures replay exactly. */
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const INSERT_PIECES = [
  'word ',
  'a plain trailing clause',
  '\n\nA new paragraph about stitching.\n\n',
  'café 😀 emoji',
  ' **bold** and *emphasis* ',
  '\n',
  'x',
  'multi\nline\ninsert',
]

interface EditStep {
  kind: 'insert' | 'delete' | 'replace'
  at: number
  end: number
  text: string
}

function pickPosition(random: () => number, parsed: ParsedEditorMarkdown): number {
  const blocks = parsed.core.blocks
  const source = parsed.source
  const roll = random()
  if (roll < 0.06) return 0
  if (roll < 0.12) return source.length
  if (blocks.length === 0) return Math.floor(random() * (source.length + 1))
  const block = blocks[Math.floor(random() * blocks.length)]!
  const kind = random()
  if (kind < 0.25) return block.span.start.offset
  if (kind < 0.5) return block.span.end.offset
  if (kind < 0.85) {
    const width = block.span.end.offset - block.span.start.offset
    return block.span.start.offset + Math.floor(random() * Math.max(1, width))
  }
  // Inside the gap after the block.
  return Math.min(source.length, block.span.end.offset + 1)
}

function nextEdit(random: () => number, parsed: ParsedEditorMarkdown): EditStep {
  const at = pickPosition(random, parsed)
  const roll = random()
  if (roll < 0.45) {
    return { kind: 'insert', at, end: at, text: INSERT_PIECES[Math.floor(random() * INSERT_PIECES.length)]! }
  }
  const spanMultiple = random() < 0.25 && parsed.core.blocks.length > 3
  const width = spanMultiple
    ? Math.floor(random() * 400) + 50
    : Math.floor(random() * 40) + 1
  const end = Math.min(parsed.source.length, at + width)
  if (roll < 0.75) return { kind: 'delete', at, end, text: '' }
  return { kind: 'replace', at, end, text: INSERT_PIECES[Math.floor(random() * INSERT_PIECES.length)]! }
}

function applyEdit(source: string, edit: EditStep): string {
  return source.slice(0, edit.at) + edit.text + source.slice(edit.end)
}

/** Replace block `index` of the parse's doc with a fresh edited paragraph. */
function withEditedBlock(parsed: ParsedEditorMarkdown, index: number): ProseMirrorNode {
  const children: ProseMirrorNode[] = []
  parsed.doc.forEach((child, _offset, childIndex) => {
    children.push(childIndex === index
      ? strataSchema.nodes.paragraph.create(
          { sourceId: child.attrs.sourceId ?? null, sourceFrom: null, sourceTo: null },
          strataSchema.text('An edited paragraph replaces this block.'),
        )
      : child)
  })
  return strataSchema.nodes.doc.create(null, children)
}

function expectEquivalent(stitched: ParsedEditorMarkdown, next: string): ParsedEditorMarkdown {
  const full = parseMarkdownForEditor(next)
  expect(describeParseDivergence(stitched, full)).toBeNull()
  return full
}

describe('updateParsedMarkdown property: stitched equals full across chained edits', () => {
  beforeEach(() => {
    delete process.env.STRATAMD_PARSE_VERIFY
    resetReparseStats()
  })

  const shapes: CorpusShape[] = ['plain', 'rich', 'block-heavy', 'table-heavy', 'list-heavy', 'code-heavy']

  for (const shape of shapes) {
    it(`chains 18 generated edits over the ${shape} corpus`, () => {
      const random = mulberry32(shape.length * 7919 + 17)
      let source = generateCorpus(shape, 6 * 1024).markdown
      let current = parseMarkdownForEditor(source)
      for (let step = 0; step < 18; step += 1) {
        const edit = nextEdit(random, current)
        const next = applyEdit(source, edit)
        const stitched = updateParsedMarkdown(current, next)
        const full = expectEquivalent(stitched, next)

        // Serialize-after-edit byte equality: the identical doc surgery on the
        // stitched and the fresh parse must serialize to identical bytes.
        expect(serializeEditorDocument(stitched, stitched.doc)).toBe(next)
        if (stitched.blocks.length > 0) {
          const blockIndex = Math.floor(random() * stitched.blocks.length)
          expect(serializeEditorDocument(stitched, withEditedBlock(stitched, blockIndex)))
            .toBe(serializeEditorDocument(full, withEditedBlock(full, blockIndex)))
        }

        // The serializer handoff must see every stitched block as unchanged.
        const update = createEditorMarkdownUpdate(stitched, stitched.doc)
        expect(update.blocks.every((block) => block.unchanged)).toBe(true)
        expect(update.deleted).toHaveLength(0)

        source = next
        current = stitched
      }
    })
  }

  it('chains edits over a CRLF document', () => {
    const random = mulberry32(4242)
    let source = generateCorpus('block-heavy', 4 * 1024).markdown.replaceAll('\n', '\r\n')
    let current = parseMarkdownForEditor(source)
    for (let step = 0; step < 14; step += 1) {
      const edit = nextEdit(random, current)
      const next = applyEdit(source, edit)
      const stitched = updateParsedMarkdown(current, next)
      expectEquivalent(stitched, next)
      expect(serializeEditorDocument(stitched, stitched.doc)).toBe(next)
      source = next
      current = stitched
    }
  })

  it('actually stitches (the property run is not all fallbacks)', () => {
    resetReparseStats()
    const source = generateCorpus('block-heavy', 6 * 1024).markdown
    let current = parseMarkdownForEditor(source)
    const middle = current.core.blocks[Math.floor(current.core.blocks.length / 2)]!
    let text = source
    for (let step = 0; step < 5; step += 1) {
      const at = middle.span.start.offset + 3 + step
      const next = text.slice(0, at) + 'y' + text.slice(at)
      current = updateParsedMarkdown(current, next)
      expectEquivalent(current, next)
      text = next
    }
    expect(reparseStats.stitched).toBe(5)
    expect(reparseStats.fallbacks).toEqual({})
  })
})

describe('updateParsedMarkdown fallback screen', () => {
  beforeEach(() => {
    delete process.env.STRATAMD_PARSE_VERIFY
    resetReparseStats()
  })

  const paragraphs = (count: number): string =>
    Array.from({ length: count }, (_, index) => `Paragraph ${index} keeps ordinary prose flowing here.`).join('\n\n') + '\n'

  function updateAndCheck(previous: ParsedEditorMarkdown, next: string): ParsedEditorMarkdown {
    const updated = updateParsedMarkdown(previous, next)
    expectEquivalent(updated, next)
    return updated
  }

  function editMiddle(source: string, insert: string): { previous: ParsedEditorMarkdown; next: string } {
    const previous = parseMarkdownForEditor(source)
    const middle = previous.core.blocks[Math.floor(previous.core.blocks.length / 2)]!
    const at = middle.span.start.offset + 4
    return { previous, next: source.slice(0, at) + insert + source.slice(at) }
  }

  it('stitches plain prose edits without any fallback', () => {
    const { previous, next } = editMiddle(paragraphs(9), 'inserted words ')
    updateAndCheck(previous, next)
    expect(reparseStats.stitched).toBe(1)
    expect(reparseStats.fallbacks).toEqual({})
  })

  it('stitches a new paragraph typed into a gap', () => {
    const source = paragraphs(9)
    const previous = parseMarkdownForEditor(source)
    const middle = previous.core.blocks[4]!
    const at = middle.span.end.offset + 1
    const next = source.slice(0, at) + '\nA fresh paragraph lands in the gap.\n' + source.slice(at)
    updateAndCheck(previous, next)
    expect(reparseStats.stitched).toBe(1)
  })

  it('stitches a deletion spanning multiple blocks', () => {
    const source = paragraphs(10)
    const previous = parseMarkdownForEditor(source)
    const from = previous.core.blocks[3]!.span.start.offset + 5
    const to = previous.core.blocks[5]!.span.start.offset + 5
    updateAndCheck(previous, source.slice(0, from) + source.slice(to))
    expect(reparseStats.stitched).toBe(1)
  })

  it('stitches an edit that merges blocks by joining a gap line', () => {
    const source = paragraphs(8)
    const previous = parseMarkdownForEditor(source)
    const block = previous.core.blocks[4]!
    // Insert between the two gap newlines: the next paragraph joins this one.
    const at = block.span.end.offset + 1
    updateAndCheck(previous, source.slice(0, at) + 'joined line' + source.slice(at))
    expect(reparseStats.stitched).toBe(1)
  })

  it('stitches edits in the last block (no end sentinel needed at EOF)', () => {
    const source = paragraphs(8)
    const previous = parseMarkdownForEditor(source)
    const next = `${source}appended tail text`
    updateAndCheck(previous, next)
    expect(reparseStats.stitched).toBe(1)
  })

  it('falls back when the previous parse holds a link reference definition', () => {
    const source = `${paragraphs(6)}\n[ref]: https://example.com\n\n${paragraphs(3)}`
    const { previous, next } = editMiddle(source, 'more ')
    updateAndCheck(previous, next)
    expect(reparseStats.fallbacks['link-definition']).toBe(1)
    expect(reparseStats.stitched).toBe(0)
  })

  it('falls back when the change touches offset 0', () => {
    const source = paragraphs(8)
    const previous = parseMarkdownForEditor(source)
    updateAndCheck(previous, `X${source}`)
    expect(reparseStats.fallbacks['offset-zero']).toBe(1)
  })

  it('falls back when the region borders frontmatter', () => {
    const source = `---\ntitle: Test\n---\n\n${paragraphs(6)}`
    const previous = parseMarkdownForEditor(source)
    const second = previous.core.blocks[2]!
    const at = second.span.start.offset + 4
    updateAndCheck(previous, source.slice(0, at) + 'y' + source.slice(at))
    expect(reparseStats.fallbacks['frontmatter']).toBe(1)
  })

  it('falls back when the changed text contains a fence marker', () => {
    const { previous, next } = editMiddle(paragraphs(9), '```')
    updateAndCheck(previous, next)
    expect(reparseStats.fallbacks['changed-construct']).toBe(1)
  })

  it('falls back when the changed text contains math fences', () => {
    const { previous, next } = editMiddle(paragraphs(9), '$$')
    updateAndCheck(previous, next)
    expect(reparseStats.fallbacks['changed-construct']).toBe(1)
  })

  it('falls back when the changed line can open an HTML block', () => {
    const source = paragraphs(9)
    const previous = parseMarkdownForEditor(source)
    const middle = previous.core.blocks[4]!
    const at = middle.span.start.offset
    updateAndCheck(previous, `${source.slice(0, at)}<div>\n${source.slice(at)}`)
    expect(reparseStats.fallbacks['changed-construct']).toBe(1)
  })

  it('falls back when the changed line looks like a definition', () => {
    const source = paragraphs(9)
    const previous = parseMarkdownForEditor(source)
    const middle = previous.core.blocks[4]!
    const at = middle.span.start.offset
    updateAndCheck(previous, `${source.slice(0, at)}[maybe]: target\n${source.slice(at)}`)
    expect(reparseStats.fallbacks['changed-construct']).toBe(1)
  })

  it('falls back when the changed text contains footnote syntax', () => {
    const { previous, next } = editMiddle(paragraphs(9), 'see [^note]')
    updateAndCheck(previous, next)
    expect(reparseStats.fallbacks['changed-construct']).toBe(1)
  })

  it('falls back when the region borders a raw block', () => {
    const source = `${paragraphs(4)}\n<!-- a comment -->\n\n${paragraphs(4)}`
    const previous = parseMarkdownForEditor(source)
    const htmlIndex = previous.core.blocks.findIndex((block) => block.rawKind === 'html')
    expect(htmlIndex).toBeGreaterThan(0)
    const neighbour = previous.core.blocks[htmlIndex + 1]!
    const at = neighbour.span.start.offset + 4
    updateAndCheck(previous, source.slice(0, at) + 'y' + source.slice(at))
    expect(reparseStats.fallbacks['raw-block']).toBe(1)
  })

  it('falls back when the region exceeds 32 blocks', () => {
    const source = paragraphs(45)
    const previous = parseMarkdownForEditor(source)
    const from = previous.core.blocks[3]!.span.start.offset + 2
    const to = previous.core.blocks[40]!.span.start.offset + 2
    updateAndCheck(previous, source.slice(0, from) + ' pruned ' + source.slice(to))
    expect(reparseStats.fallbacks['region-too-large']).toBe(1)
  })

  it('falls back when the previous parse has no blocks', () => {
    const previous = parseMarkdownForEditor('')
    updateAndCheck(previous, 'hello world')
    expect(reparseStats.fallbacks['no-blocks']).toBe(1)
  })

  it('returns the previous parse untouched for identical source', () => {
    const previous = parseMarkdownForEditor(paragraphs(4))
    expect(updateParsedMarkdown(previous, previous.source)).toBe(previous)
    expect(reparseStats.stitched).toBe(0)
    expect(reparseStats.fallbacks).toEqual({})
  })
})

describe('updateParsedMarkdown offset shifting', () => {
  beforeEach(() => {
    delete process.env.STRATAMD_PARSE_VERIFY
    resetReparseStats()
  })

  it('shifts character, byte, and line offsets past multi-byte content', () => {
    const source = 'Alpha block one.\n\nSecond with café and 😀 emoji.\n\nThird plain.\n\nFourth café block.\n\nFifth tail block.\n'
    const previous = parseMarkdownForEditor(source)
    const at = previous.core.blocks[2]!.span.start.offset + 6
    const next = source.slice(0, at) + 'naïve 🎈 ' + source.slice(at)
    const stitched = updateParsedMarkdown(previous, next)
    const full = parseMarkdownForEditor(next)
    expect(describeParseDivergence(stitched, full)).toBeNull()
    expect(reparseStats.stitched).toBe(1)
    // The trailing block's SourcePoints moved by the multi-byte deltas.
    const last = stitched.core.blocks.at(-1)!
    const lastFull = full.core.blocks.at(-1)!
    expect(last.span.start).toEqual(lastFull.span.start)
    expect(last.span.end).toEqual(lastFull.span.end)
  })

  it('shifts line counts for edits that add and remove lines in CRLF documents', () => {
    const source = 'One block here.\r\n\r\nTwo block here.\r\n\r\nThree block here.\r\n\r\nFour block here.\r\n\r\nFive block here.\r\n'
    const previous = parseMarkdownForEditor(source)
    const at = previous.core.blocks[2]!.span.start.offset + 5
    const next = source.slice(0, at) + 'split\r\nacross ' + source.slice(at)
    const stitched = updateParsedMarkdown(previous, next)
    expect(describeParseDivergence(stitched, parseMarkdownForEditor(next))).toBeNull()
    expect(reparseStats.stitched).toBe(1)
  })

  it('keeps equivalence when a splice boundary lands inside a CRLF pair', () => {
    const source = 'Alpha one.\n\nBeta two here.\n\nGamma three.\n\nDelta four.\n\nEpsilon five.\n'
    const previous = parseMarkdownForEditor(source)
    // Convert one gap's \n\n to \r\n\r\n: the common-suffix scan splits the pair.
    const gapAt = previous.core.blocks[2]!.span.end.offset
    const next = `${source.slice(0, gapAt)}\r\n\r\n${source.slice(gapAt + 2)}`
    const stitched = updateParsedMarkdown(previous, next)
    expect(describeParseDivergence(stitched, parseMarkdownForEditor(next))).toBeNull()
  })

  it('renumbers block ids when the edit changes the block count', () => {
    const source = 'Alpha one.\n\nBeta two.\n\nGamma three.\n\nDelta four.\n\nEpsilon five.\n\nZeta six.\n'
    const previous = parseMarkdownForEditor(source)
    const middle = previous.core.blocks[2]!
    const at = middle.span.end.offset
    const next = `${source.slice(0, at)}\n\nInserted paragraph.${source.slice(at)}`
    const stitched = updateParsedMarkdown(previous, next)
    const full = parseMarkdownForEditor(next)
    expect(describeParseDivergence(stitched, full)).toBeNull()
    expect(stitched.blocks.map((block) => block.id)).toEqual(full.blocks.map((block) => block.id))
    expect(reparseStats.stitched).toBe(1)
  })

  it('does not mutate the previous parse (serializer baseline safety)', () => {
    const source = 'Alpha one.\n\nBeta two.\n\n- item a\n- item b\n\nGamma three.\n\nDelta four.\n\nEpsilon five.\n'
    const previous = parseMarkdownForEditor(source)
    const spansBefore = JSON.stringify(previous.core.blocks.map((block) => block.span))
    const astBefore = JSON.stringify(previous.core.ast)
    const attrsBefore = JSON.stringify(previous.blocks.map((block) => block.node.toJSON()))
    const at = previous.core.blocks[2]!.span.start.offset + 2
    const next = source.slice(0, at) + 'inserted ' + source.slice(at)
    updateParsedMarkdown(previous, next)
    expect(JSON.stringify(previous.core.blocks.map((block) => block.span))).toBe(spansBefore)
    expect(JSON.stringify(previous.core.ast)).toBe(astBefore)
    expect(JSON.stringify(previous.blocks.map((block) => block.node.toJSON()))).toBe(attrsBefore)
  })

  it('verify mode deep-compares and still returns the stitched result', () => {
    process.env.STRATAMD_PARSE_VERIFY = '1'
    try {
      const source = 'Alpha one.\n\nBeta two.\n\nGamma three.\n\nDelta four.\n\nEpsilon five.\n'
      const previous = parseMarkdownForEditor(source)
      const at = previous.core.blocks[2]!.span.start.offset + 2
      const next = source.slice(0, at) + 'w' + source.slice(at)
      const stitched = updateParsedMarkdown(previous, next)
      expect(describeParseDivergence(stitched, parseMarkdownForEditor(next))).toBeNull()
      expect(reparseStats.stitched).toBe(1)
      expect(reparseStats.fallbacks['verify-divergence']).toBeUndefined()
    } finally {
      delete process.env.STRATAMD_PARSE_VERIFY
    }
  })
})
