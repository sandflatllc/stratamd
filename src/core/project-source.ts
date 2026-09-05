/** Paths belong to the paired workstation, never the renderer's filesystem. */
export function parentPath(path: string): string {
  if (path === '/') return '/'
  const clean = path.replace(/\/+$/, '')
  const index = clean.lastIndexOf('/')
  return index < 0 ? '~' : index === 0 ? '/' : clean.slice(0, index)
}
export function joinPath(parent: string, child: string): string { return `${parent.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}` }
export function repositoryFolderName(repository: string): string {
  return repository.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).at(-1)?.replace(/\.git$/, '') ?? ''
}
export function parseGitUrl(value: string): string | null {
  const input = value.trim()
  if (/\s/.test(input)) return null
  if (/^git@[^/:]+:[^\s]+$/.test(input)) return repositoryFolderName(input) ? input : null
  try {
    const url = new URL(input)
    return ['https:', 'ssh:'].includes(url.protocol) && url.hostname && url.pathname !== '/' && repositoryFolderName(input) ? input : null
  } catch { return null }
}
export function parseGithubRepository(value: string): string | null {
  const input = value.trim().replace(/\.git$/, '')
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(input) && !['.', '..'].includes(input.split('/')[1]!) ? input : null
}
