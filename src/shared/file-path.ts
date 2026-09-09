/** Display paths can belong to a remote workstation with a different OS. */
export function slashPath(path: string): string { return path.replaceAll('\\', '/') }
export function windowsAbsolutePath(path: string): boolean { return /^[a-z]:[/\\]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path) }
export function comparablePath(path: string): string {
  const normalized = slashPath(path).replace(/\/+$/, '')
  return windowsAbsolutePath(path) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}
export function normalizeWindowsPath(path: string): string {
  const slash = slashPath(path)
  const drive = /^([a-z]:)\//i.exec(slash)
  const parts = slash.split('/')
  const prefix = drive ? drive[1]! : `//${parts[2]}/${parts[3]}`
  const out: string[] = []
  for (const segment of parts.slice(drive ? 1 : 4)) {
    if (!segment || segment === '.') continue
    if (segment === '..') out.pop(); else out.push(segment)
  }
  return `${prefix}/${out.join('/')}`.replaceAll('/', '\\')
}
