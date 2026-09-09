import type { ProviderCommandSnapshot } from '../shared/provider-commands'

export interface CommandQuery { from: number; to: number; query: string; skillsOnly: boolean }
export interface ComposerCommandItem { id: string; name: string; description: string; kind: 'command' | 'skill'; token: string }

/** A token at the caret, never a slash inside a URL or a selected passage. */
export function composerCommandQuery(text: string, start: number, end = start): CommandQuery | null {
  if (start !== end) return null
  const match = /(?:^|\s)([/\$])([^\s/$]*)$/.exec(text.slice(0, start))
  if (!match) return null
  return { from: start - match[2]!.length - 1, to: start, query: match[2]!, skillsOnly: match[1] === '$' }
}

export function composerCommandItems(snapshot: ProviderCommandSnapshot | undefined, query: CommandQuery): ComposerCommandItem[] {
  if (!snapshot) return []
  const skills = snapshot.skills.filter(skill => skill.enabled && skill.userInvocable !== false)
  const skillNames = new Set(skills.map(skill => skill.name.toLowerCase()))
  const seen = new Set<string>()
  const entries = [
    ...(query.skillsOnly ? [] : snapshot.slashCommands.filter(command => !skillNames.has(command.name.toLowerCase())).map(command => ({ id: `command:${command.name}`, name: command.name, description: command.description ?? command.input?.hint ?? '', kind: 'command' as const, token: `/${command.name}`, search: command.name }))),
    ...skills.map(skill => ({ id: `skill:${skill.name}`, name: skill.name, description: skill.shortDescription ?? skill.description ?? '', kind: 'skill' as const, token: `$${skill.name}`, search: `${skill.name} ${skill.displayName ?? ''} ${skill.description ?? ''}` })),
  ]
  const needle = query.query.toLowerCase()
  return entries.filter(entry => {
    const key = entry.id.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return `${entry.search} ${entry.description}`.toLowerCase().includes(needle)
  }).map(({ search: _search, ...entry }) => entry)
}

export function replaceCommandQuery(text: string, query: CommandQuery, token: string): { text: string; caret: number } {
  const suffix = text.slice(query.to)
  const insertion = token ? `${token} ` : ''
  return { text: text.slice(0, query.from) + insertion + (token ? suffix.replace(/^ /, '') : suffix), caret: query.from + insertion.length }
}
