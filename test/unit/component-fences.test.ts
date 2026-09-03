import { describe, expect, it } from 'vitest'
import { structureComponentDocument } from '../../src/core/markdown/components'

describe('component wrappers after fenced code', () => {
  it('recognizes a component that follows a fence whose info string touches the marker', () => {
    const source = '# T\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter.\n\n<Verdict outcome="neutral">\nIslands already exist.\n</Verdict>\n'
    const structure = structureComponentDocument(source)
    expect(structure.ranges.map((range) => [range.name, range.complete])).toEqual([['Verdict', true]])
  })

  it('still ignores wrappers inside fences, including tilde fences and longer markers', () => {
    const source = '````md\n<Verdict>\nexample\n</Verdict>\n````\n\n~~~ text\n<Callout>\nno\n</Callout>\n~~~\n\n<Callout kind="warning">\nReal.\n</Callout>\n'
    const structure = structureComponentDocument(source)
    expect(structure.ranges.map((range) => range.name)).toEqual(['Callout'])
  })

  it('does not treat a backtick run with a backtick in its info string as a fence', () => {
    const source = '```a`b\n<Verdict>\nBody.\n</Verdict>\n'
    const structure = structureComponentDocument(source)
    expect(structure.ranges.map((range) => range.name)).toEqual(['Verdict'])
  })
})
