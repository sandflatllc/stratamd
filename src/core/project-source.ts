import { slashPath } from '../shared/file-path'

/** Paths belong to the paired workstation, never the renderer's filesystem. */
export function parentPath(path: string): string {
  path = slashPath(path)
  if (/^[a-z]:\/?$/i.test(path)) return path.slice(0, 2) + '/'
  if (/^\/\/[^/]+\/[^/]+\/?$/.test(path)) return path.replace(/\/$/, '')
  if (path === '/') return '/'
  const clean = path.replace(/\/+$/, '')
  const index = clean.lastIndexOf('/')
  return index < 0 ? '~' : index === 0 ? '/' : /^[a-z]:$/i.test(clean.slice(0, index)) ? clean.slice(0, index) + '/' : clean.slice(0, index)
}
export function joinPath(parent: string, child: string): string { return `${slashPath(parent).replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}` }
export function folderCrumbs(path: string): Array<{ label: string; path: string }> {
  const clean = slashPath(path)
  const root = clean.match(/^\/\/[^/]+\/[^/]+/)?.[0] ?? clean.match(/^[a-z]:\//i)?.[0] ?? (clean.startsWith('/') ? '/' : '')
  const crumbs = root ? [{ label: root, path: root }] : []
  let current = root
  for (const part of clean.slice(root.length).split('/').filter(Boolean)) {
    current = current ? joinPath(current, part) : part
    crumbs.push({ label: part, path: current })
  }
  return crumbs
}
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
