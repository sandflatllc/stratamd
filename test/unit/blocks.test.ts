import { describe, expect, it } from 'vitest'
import { blockOutcomeLines, mapMarkdownBlocks, parseStrataBlock, resolveBlock } from '../../src/core/blocks'

describe('strata transcript blocks', () => {
  it('maps stable markdown blocks and resolves their original ranges', () => {
    const source = '# Title\n\nFirst paragraph.\n\n- One\n- Two\n'
    const first = mapMarkdownBlocks('/work/plan.md', source)
    const second = mapMarkdownBlocks('/work/plan.md', source)
    expect(second).toEqual(first)
    expect(first.blocks.map((block) => block.text)).toEqual(['# Title', 'First paragraph.', '- One\n- Two'])
    expect(resolveBlock(first, first.blocks[1]!.id)).toMatchObject({ text: 'First paragraph.', from: 9 })
  })

  it('keeps two valid entries when a stale or malformed sibling fails and reports all outcomes', () => {
    const parsed = parseStrataBlock(`Done.\n\n\`\`\`strata\n${JSON.stringify([
      { verb: 'question', anchor: { document: '/work/plan.md', block: 'b-good' }, text: 'Ship it?' },
      { verb: 'edit', anchor: { document: '/work/plan.md', block: 'b-stale' }, match: 'old', replace: 'new' },
      { verb: 'comment', anchor: { document: '/work/plan.md', block: 'b-last' }, text: 'Checked.' },
    ])}\n\`\`\``)!
    expect(parsed.prose).toBe('Done.')
    expect(parsed.results.filter((result) => result.entry)).toHaveLength(3)
    expect(blockOutcomeLines([
      { index: 0, status: 'applied', itemId: 'item-1' },
      { index: 1, status: 'failed', reason: 'block b-stale changed', candidates: ['b-near'] },
      { index: 2, status: 'applied', itemId: 'item-2' },
    ])).toEqual(['1. applied as item-1', '2. failed: block b-stale changed; nearest: b-near', '3. applied as item-2'])
  })

  it('accepts an attach-only bootstrap and rejects an invalid entry without dropping valid siblings', () => {
    const attach = parseStrataBlock('```strata\n[{"verb":"attach","document":"/work/plan.md"}]\n```')!
    expect(attach.results[0]?.entry).toEqual({ verb: 'attach', document: '/work/plan.md' })
    const mixed = parseStrataBlock('```strata\n[{"verb":"question"},{"verb":"lead","document":"/work/plan.md","action":"claim"}]\n```')!
    expect(mixed.results[0]?.error).toBeTruthy()
    expect(mixed.results[1]?.entry?.verb).toBe('lead')
  })
})
