import { expect, it } from 'vitest'
import { composerCommandItems, composerCommandQuery, replaceCommandQuery } from '../../src/renderer/composerCommands'

it('replaces only the token at the caret and keeps the surrounding draft', () => {
  const text = 'Review this. /browse More context.'
  const caret = text.indexOf(' More')
  const query = composerCommandQuery(text, caret)!
  expect(replaceCommandQuery(text, query, '$agent-browser')).toEqual({ text: 'Review this. $agent-browser More context.', caret: 28 })
  expect(composerCommandQuery('https://example.com', 19)).toBeNull()
  expect(composerCommandQuery('/browse', 0, 7)).toBeNull()
  expect(composerCommandQuery('$agent-browser ', 15)).toBeNull()
})

it('offers explicit-only skills, filters name and description, and hides disabled or agent-only entries', () => {
  const base = { path: '/skills/browser/SKILL.md', enabled: true }
  const snapshot = { slashCommands: [{ name: 'browser' }, { name: 'compact' }], skills: [
    { ...base, name: 'browser', displayName: 'Page inspector', description: 'Capture evidence', userInvocationOnly: true },
    { ...base, name: 'browser', description: 'Duplicate' },
    { ...base, name: 'disabled', enabled: false },
    { ...base, name: 'agent-only', userInvocable: false },
  ] }
  const all = composerCommandItems(snapshot, composerCommandQuery('/', 1)!)
  expect(all.map(item => item.token)).toEqual(['/compact', '$browser'])
  expect(composerCommandItems(snapshot, composerCommandQuery('/evidence', 9)!)).toEqual([all[1]])
  expect(composerCommandItems(snapshot, composerCommandQuery('/inspector', 10)!)).toEqual([all[1]])
  expect(composerCommandItems(snapshot, composerCommandQuery('/missing', 8)!)).toEqual([])
  expect(composerCommandItems(snapshot, composerCommandQuery('$', 1)!).map(item => item.token)).toEqual(['$browser'])
})
