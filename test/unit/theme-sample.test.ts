import { describe, expect, it } from 'vitest'
import { parseMarkdownForEditor, strataSchema } from '../../src/editor/index.js'
import { THEME_KEYS } from '../../src/shared/theme-keys'
import { THEME_SAMPLE_MARKDOWN } from '../../src/shared/theme-sample'

describe('theme sample document', () => {
  it('contains every visually editable construct from PRD §6.1', () => {
    const parsed = parseMarkdownForEditor(THEME_SAMPLE_MARKDOWN)
    const nodes = new Map<string, number>()
    const marks = new Set<string>()
    const headingLevels = new Set<number>()
    let tasks = 0
    parsed.doc.descendants((node) => {
      nodes.set(node.type.name, (nodes.get(node.type.name) ?? 0) + 1)
      for (const mark of node.marks) marks.add(mark.type.name)
      if (node.type === strataSchema.nodes.heading) headingLevels.add(Number(node.attrs.level))
      if (node.type === strataSchema.nodes.list_item && typeof node.attrs.checked === 'boolean') tasks += 1
    })
    for (const name of ['heading', 'paragraph', 'bullet_list', 'ordered_list', 'blockquote', 'code_block', 'horizontal_rule', 'table']) expect(nodes.get(name), name).toBeGreaterThan(0)
    for (const name of ['strong', 'em', 'code', 'link', 'strike']) expect(marks.has(name), name).toBe(true)
    expect([...headingLevels].sort()).toEqual([1, 2, 3, 4])
    expect(tasks).toBe(2)
  })

  it('names every document, interface, and surface value the panel offers', () => {
    for (const entry of THEME_KEYS.filter((key) => key.group === 'document' || key.group === 'interface' || key.group === 'surfaces')) {
      expect(THEME_SAMPLE_MARKDOWN, entry.label).toContain(entry.label)
    }
  })
})
