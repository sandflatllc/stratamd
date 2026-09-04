import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseStrataBlock } from '../../src/core/blocks'

describe('agent chat contract corpus', () => {
  it('keeps prose to at most one line for each posted action without repeating proposed text', async () => {
    const message = await readFile(new URL('../corpus/messages/action-summary.md', import.meta.url), 'utf8')
    const parsed = parseStrataBlock(message)
    expect(parsed).not.toBeNull()
    expect(parsed!.results.filter((result) => result.entry)).toHaveLength(2)

    const prose = message.slice(0, message.indexOf('```strata')).trim().split('\n').filter(Boolean)
    expect(prose.length).toBeLessThanOrEqual(parsed!.results.length)
    expect(prose.join('\n')).not.toContain('Should the budget change?')
    expect(prose.join('\n')).not.toContain('Thursday')
  })
})
