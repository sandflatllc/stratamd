import { readFile } from 'node:fs/promises'
import { dirname, join, delimiter, isAbsolute, resolve } from 'node:path'
import { isWindows } from './runtime'

export { delimiter as pathDelimiter }

export function executableCandidates(binary: string, cwd: string, searchPath: string): string[] {
  const explicit = /[/\\]/.test(binary) || isAbsolute(binary)
  const bases = explicit ? [resolve(cwd, binary)] : searchPath.split(delimiter).filter(Boolean).map(directory => join(directory, binary))
  const suffixes = isWindows() && !/\.(exe|com|cmd|bat)$/i.test(binary) ? ['', '.exe', '.com', '.cmd', '.bat'] : ['']
  return bases.flatMap(base => suffixes.map(suffix => base + suffix))
}

/** npm's Windows shims name their JavaScript entry; run it directly with bundled Node. */
export async function nodeCommand(executable: string, args: string[], node: string): Promise<{ executable: string; args: string[] }> {
  if (!isWindows() || !/\.(cmd|bat)$/i.test(executable)) return { executable, args }
  const source = await readFile(executable, 'utf8')
  const relative = /"%dp0%\\([^"\r\n]+\.(?:mjs|cjs|js))"/i.exec(source)?.[1]
  if (!relative) throw new Error(`Cannot run the launcher ${executable}. Select the provider's .exe or Node entry file.`)
  return { executable: node, args: [join(dirname(executable), relative), ...args] }
}
