// What a link's right-click menu copies (PRD §6.9, link copying). A web
// address copies as written; a file link resolves against the document's
// directory to the full path the click would open, with query and fragment
// dropped, and also offers the link exactly as the author wrote it.

export type LinkCopyTarget =
  | { kind: 'web'; address: string }
  | { kind: 'other'; address: string }
  | { kind: 'file'; path: string | null; written: string }

const SCHEME = /^[a-z][a-z\d+.-]*:/i

/** Collapses `.` and `..` segments of an absolute POSIX path. */
export function normalizePosixPath(path: string): string {
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { out.pop(); continue }
    out.push(segment)
  }
  return `/${out.join('/')}`
}

function decode(text: string): string {
  try { return decodeURIComponent(text) } catch { return text }
}

/** The copy target for `href` inside the document at `documentPath`; null when there is nothing to copy. */
export function linkCopyTarget(href: string, documentPath: string): LinkCopyTarget | null {
  const written = href.trim()
  if (!written) return null
  if (/^file:/i.test(written)) {
    try {
      const url = new URL(written)
      return { kind: 'file', path: normalizePosixPath(decode(url.pathname)), written }
    } catch { return { kind: 'file', path: null, written } }
  }
  if (/^https?:\/\//i.test(written)) return { kind: 'web', address: written }
  if (SCHEME.test(written) || written.startsWith('//')) return { kind: 'other', address: written }
  const request = decode(written.split(/[?#]/u, 1)[0] ?? '')
  if (!request) return { kind: 'other', address: written }
  if (request.startsWith('/')) return { kind: 'file', path: normalizePosixPath(request), written }
  const directory = documentPath.startsWith('/') ? documentPath.slice(0, documentPath.lastIndexOf('/')) : ''
  if (!directory && documentPath !== '/') return { kind: 'file', path: null, written }
  return { kind: 'file', path: normalizePosixPath(`${directory}/${request}`), written }
}
