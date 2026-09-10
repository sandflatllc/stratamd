import { access, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, delimiter, win32, posix } from 'node:path'

export { delimiter as pathDelimiter }

export function executableCandidates(binary: string, cwd: string, searchPath: string, context: { platform?: string; home?: string } = {}): string[] {
  const windows = (context.platform ?? process.platform) === 'win32'
  const path = windows ? win32 : posix
  binary = binary.trim()
  if (!binary) return []
  if (binary === '~' || binary.startsWith('~/') || windows && binary.startsWith('~\\')) binary = path.join(context.home ?? homedir(), binary.slice(2))
  const explicit = /[/\\]/.test(binary) || path.isAbsolute(binary)
  const bases = explicit ? [path.resolve(cwd, binary)] : searchPath.split(path.delimiter).filter(Boolean).map(directory => path.resolve(cwd, directory, binary))
  // npm's extensionless sibling is a POSIX shell script, not a Windows executable.
  const suffixes = windows && !/\.(exe|com|cmd|bat|mjs|cjs|js)$/i.test(binary) ? ['.exe', '.com', '.cmd', '.bat'] : ['']
  return bases.flatMap(base => suffixes.map(suffix => base + suffix))
}

export async function findExecutable(binary: string, cwd: string, searchPath: string, excluded: readonly string[] = []): Promise<string | null> {
  const excludedPaths = await Promise.all(excluded.map(path => realpath(path).catch(() => path)))
  for (const path of executableCandidates(binary, cwd, searchPath)) {
    try {
      await access(path, constants.X_OK)
      const actual = await realpath(path)
      if (excludedPaths.some(excludedPath => process.platform === 'win32' ? excludedPath.toLowerCase() === actual.toLowerCase() : excludedPath === actual)) continue
      return path
    } catch { /* Try the next configured search directory. */ }
  }
  return null
}

/** npm's Windows shims name their JavaScript entry; run it directly with bundled Node. */
export async function nodeCommand(executable: string, args: string[], node: string, platform: string = process.platform): Promise<{ executable: string; args: string[] }> {
  if (/\.(mjs|cjs|js)$/i.test(executable)) return { executable: node, args: [executable, ...args] }
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return { executable, args }
  const source = await readFile(executable, 'utf8')
  const relative = /"%dp0%\\([^"\r\n]+\.(?:mjs|cjs|js))"/i.exec(source)?.[1]
  if (!relative) throw new Error(`Cannot run the launcher ${executable}. Select the provider's .exe or Node entry file.`)
  return { executable: node, args: [join(dirname(executable), ...relative.split('\\')), ...args] }
}
