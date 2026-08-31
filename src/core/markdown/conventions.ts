import type { MarkdownAst, MarkdownConventions } from './types.js'

interface PositionedNode {
  type: string
  position?: {
    start: { offset?: number | undefined }
    end: { offset?: number | undefined }
  } | undefined
  children?: readonly PositionedNode[] | undefined
  title?: string | null | undefined
}

type MarkerCount<T extends string> = Record<T, { count: number; first: number }>

function markerCounts<T extends string>(markers: readonly T[]): MarkerCount<T> {
  return Object.fromEntries(markers.map((marker) => [marker, { count: 0, first: Infinity }])) as MarkerCount<T>
}

function record<T extends string>(counts: MarkerCount<T>, marker: T, offset: number): void {
  counts[marker].count += 1
  counts[marker].first = Math.min(counts[marker].first, offset)
}

function select<T extends string>(counts: MarkerCount<T>, fallback: T): T {
  let selected = fallback
  for (const marker of Object.keys(counts) as T[]) {
    const current = counts[marker]
    const best = counts[selected]
    if (current.count > best.count || (current.count === best.count && current.first < best.first)) {
      selected = marker
    }
  }
  return selected
}

function visit(node: PositionedNode, callback: (node: PositionedNode) => void): void {
  callback(node)
  if (node.children) for (const child of node.children) visit(child, callback)
}

function lineEnding(source: string): '\n' | '\r\n' | '\r' {
  let crlf = 0
  let lf = 0
  let cr = 0
  let first: '\n' | '\r\n' | '\r' | undefined

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\r') {
      if (source[index + 1] === '\n') {
        crlf += 1
        first ??= '\r\n'
        index += 1
      } else {
        cr += 1
        first ??= '\r'
      }
    } else if (character === '\n') {
      lf += 1
      first ??= '\n'
    }
  }

  const maximum = Math.max(crlf, lf, cr)
  if (maximum === 0) return '\n'
  if (crlf === maximum && (first === '\r\n' || crlf > lf && crlf > cr)) return '\r\n'
  if (lf === maximum && (first === '\n' || lf > cr)) return '\n'
  return '\r'
}

function finalNewline(source: string): boolean {
  return source.endsWith('\n') || source.endsWith('\r')
}

export function detectMarkdownConventions(source: string, ast: MarkdownAst): MarkdownConventions {
  const syntaxOffset = source.startsWith('\uFEFF') ? 1 : 0
  const syntaxSource = source.slice(syntaxOffset)
  const bullet = markerCounts(['*', '+', '-'] as const)
  const ordered = markerCounts(['.', ')'] as const)
  const emphasis = markerCounts(['*', '_'] as const)
  const strong = markerCounts(['*', '_'] as const)
  const fence = markerCounts(['`', '~'] as const)
  const heading = markerCounts(['atx', 'setext'] as const)
  const rule = markerCounts(['*', '-', '_'] as const)
  const quote = markerCounts(['"', "'"] as const)
  const indentation: Array<'one' | 'tab'> = []
  let closedAtx = 0
  let openAtx = 0
  let spacedRules = 0
  let compactRules = 0

  for (const match of syntaxSource.matchAll(/^( {0,3})([-+*]|\d+[.)])([ \t]+)/gm)) {
    const marker = match[2]
    const whitespace = match[3] ?? ''
    const offset = match.index + syntaxOffset + (match[1]?.length ?? 0)
    if (marker === '*' || marker === '+' || marker === '-') record(bullet, marker, offset)
    else if (marker) record(ordered, marker.endsWith(')') ? ')' : '.', offset)
    indentation.push(whitespace === ' ' ? 'one' : 'tab')
  }

  visit(ast as PositionedNode, (node) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return
    const raw = source.slice(start, end)

    if (node.type === 'emphasis') {
      const marker = raw[0]
      if (marker === '*' || marker === '_') record(emphasis, marker, start)
    } else if (node.type === 'strong') {
      const marker = raw[0]
      if (marker === '*' || marker === '_') record(strong, marker, start)
    } else if (node.type === 'code' && /^(?:`{3,}|~{3,})/.test(raw)) {
      const marker = raw[0]
      if (marker === '`' || marker === '~') record(fence, marker, start)
    } else if (node.type === 'heading') {
      if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(raw)) {
        record(heading, 'atx', start)
        if (/[ \t]+#{1,6}[ \t]*$/.test(raw)) closedAtx += 1
        else openAtx += 1
      } else {
        record(heading, 'setext', start)
      }
    } else if (node.type === 'thematicBreak') {
      const marker = raw.match(/[*_-]/)?.[0]
      if (marker === '*' || marker === '-' || marker === '_') record(rule, marker, start)
      if (/[ \t]/.test(raw.trim())) spacedRules += 1
      else compactRules += 1
    } else if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && node.title) {
      const titleMarker = raw.match(/[ \t](?:"[^"\r\n]*"|'[^'\r\n]*')\)?[ \t]*$/)?.[0].trim()[0]
      if (titleMarker === '"' || titleMarker === "'") record(quote, titleMarker, start)
    }
  })

  const oneIndent = indentation.filter((item) => item === 'one').length
  const tabIndent = indentation.length - oneIndent
  const listItemIndent = oneIndent > 0 && tabIndent > 0 ? 'mixed' : tabIndent > 0 ? 'tab' : 'one'

  return {
    lineEnding: lineEnding(source),
    hasFinalNewline: finalNewline(source),
    bom: source.startsWith('\uFEFF'),
    bullet: select(bullet, '-'),
    bulletOrdered: select(ordered, '.'),
    emphasis: select(emphasis, '*'),
    strong: select(strong, '*'),
    listItemIndent,
    fence: select(fence, '`'),
    heading: select(heading, 'atx'),
    closeAtx: closedAtx > openAtx,
    rule: select(rule, '*'),
    ruleSpaces: spacedRules > compactRules,
    quote: select(quote, '"')
  }
}
