import { expect, it } from 'vitest'
import { completedMessageParses, conversationParse, conversationMatches } from '../../src/renderer/conversationReading'
it('caches canonical completed parses across unrelated ticks and refreshes changed source', () => {
  const before = completedMessageParses
  for (let tick = 0; tick < 10; tick++) for (let message = 0; message < 100; message++) conversationParse(`cache-${message}`, `# Heading ${message}\n\n<Callout>\n\nBody.\n</Callout>`)
  expect(completedMessageParses - before).toBe(100)
  const first = conversationParse('cache-0', '# Heading 0\n\n<Callout>\n\nBody.\n</Callout>')
  expect(conversationParse('cache-0', first.source)).toBe(first)
  expect(conversationParse('cache-0', '# Changed')).not.toBe(first)
  expect(completedMessageParses - before).toBe(101)
})

it('finds displayed formatted text and returns its exact source range', () => {
  const source = '# Heading\n\nA **formatted** passage.\n'
  expect(conversationMatches('find-rendered', source, 'formatted passage').map(range => source.slice(range.from, range.to))).toEqual(['formatted** passage'])
  expect(conversationMatches('find-rendered', source, '**')).toEqual([])
})
