import { statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { classifyLocalLink } from '../shared/local-link'
import type { LocalLinkTarget } from '../shared/contracts'

const PAGE = new Set(['.html', '.htm'])
const MARKDOWN = new Set(['.md', '.markdown'])

/**
 * Turns a local link from a reply into a file Strata can open. The fence is
 * the file itself: it must exist, be a regular file, and be a page or a
 * Markdown document. Relative links resolve against the project folder; the
 * owner's plans and artifacts often live outside it, so no folder is required.
 */
export async function resolveLocalLink(href: string, base: string | null): Promise<LocalLinkTarget> {
  const link = classifyLocalLink(href)
  if (!link || link.kind === 'other') throw new Error(`${href} is not a web link, a .html page, or a Markdown file, so Strata cannot open it.`)
  let path = link.path
  if (!isAbsolute(path)) {
    if (!base) throw new Error(`${href} is relative to a project folder. Add a project to open it.`)
    path = resolve(base, path)
  }
  let real: string
  try {
    real = await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${path} does not exist.`)
    throw error
  }
  if (!(await stat(real)).isFile()) throw new Error(`${path} is not a file.`)
  const ext = extname(real).toLowerCase()
  const kind = PAGE.has(ext) ? 'html' : MARKDOWN.has(ext) ? 'markdown' : null
  if (!kind) throw new Error(`${path} is not a .html page or a Markdown file, so Strata cannot open it.`)
  return { kind, path: real, url: `${pathToFileURL(real).href}${link.suffix}` }
}

function pagePath(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'file:') return null
  let path: string
  try { path = fileURLToPath(parsed) } catch { return null }
  return PAGE.has(extname(path).toLowerCase()) ? path : null
}

/** A `file:` URL naming an existing .html or .htm file, the only local page a preview tab shows. */
export async function isLocalPage(url: string): Promise<boolean> {
  const path = pagePath(url)
  if (!path) return false
  try { return (await stat(path)).isFile() } catch { return false }
}

/** The synchronous check for navigation guards, which cannot wait. */
export function isLocalPageSync(url: string): boolean {
  const path = pagePath(url)
  if (!path) return false
  try { return statSync(path).isFile() } catch { return false }
}

/** True only for the app's own root page; the crash card reloads there. Any other app path is a missing file. */
export function isAppRootNavigation(url: string, host: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'app:' && parsed.host === host && parsed.pathname === '/'
  } catch { return false }
}
