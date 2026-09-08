/** What a non-web link in a reply, saved comment, or terminal points at. */
export type LocalLinkKind = 'html' | 'markdown' | 'other'

export interface LocalLink {
  kind: LocalLinkKind
  /** The path part, percent-decoded, with any query and fragment removed. */
  path: string
  /** The query and fragment, kept so a page can read its state (`?state=working`). */
  suffix: string
  /** True when the link was written as a `file:` URL rather than a path. */
  fileUrl: boolean
}

const PAGE = new Set(['.html', '.htm'])
const MARKDOWN = new Set(['.md', '.markdown'])

function extension(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * Classifies a link that is not a web address. Web, mail, and in-page links
 * return null so their own handling applies; a `file:` URL or a path (absolute
 * or relative to the project folder) says whether it names a page, a Markdown
 * document, or something Strata does not open.
 */
export function classifyLocalLink(href: string): LocalLink | null {
  const raw = href.trim()
  if (!raw || raw.startsWith('#') || raw.startsWith('//') || raw.includes('\0')) return null
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(raw)?.[1]?.toLowerCase()
  if (scheme && scheme !== 'file') return null
  let path: string
  let suffix: string
  if (scheme === 'file') {
    let url: URL
    try { url = new URL(raw) } catch { return null }
    if (url.host && url.host !== 'localhost') return null
    path = url.pathname
    suffix = `${url.search}${url.hash}`
  } else {
    const cut = raw.search(/[?#]/u)
    path = cut < 0 ? raw : raw.slice(0, cut)
    suffix = cut < 0 ? '' : raw.slice(cut)
  }
  try { path = decodeURIComponent(path) } catch { return null }
  if (!path || path.includes('\0')) return null
  const ext = extension(path)
  const kind: LocalLinkKind = PAGE.has(ext) ? 'html' : MARKDOWN.has(ext) ? 'markdown' : 'other'
  return { kind, path, suffix, fileUrl: scheme === 'file' }
}
