import type { MermaidConfig } from 'mermaid'

export interface MermaidRenderOptions {
  normalizeBreaks?: boolean
}

export interface MermaidRenderResult {
  svg: string
  durationMs: number
  normalizedBreaks: boolean
}

let initialized: Promise<typeof import('mermaid')['default']> | null = null

export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  sequence: { useMaxWidth: true },
  maxTextSize: 50_000,
  maxEdges: 1_000,
  suppressErrorRendering: true,
} satisfies MermaidConfig

export function normalizeMermaidSource(source: string): string {
  const kind = source.match(/^\s*([A-Za-z][\w-]*)/u)?.[1]?.toLowerCase()
  if (kind === 'flowchart' || kind === 'graph') {
    return source.replace(/<br\s*\/?>/giu, '\n')
  }
  if (kind === 'sequencediagram') {
    return source.split('\n').map((line) => {
      const message = /^(\s*[^:]+(?:--?|==?)[>x)]{1,2}[^:]*:)(.*)$/u.exec(line)
      return message ? `${message[1]}${message[2]?.replaceAll(';', '#59;') ?? ''}` : line
    }).join('\n')
  }
  return source
}

async function loadMermaid(): Promise<typeof import('mermaid')['default']> {
  initialized ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize(MERMAID_CONFIG)
    return mermaid
  })
  return initialized
}

export async function renderMermaid(
  id: string,
  source: string,
  options: MermaidRenderOptions = {},
): Promise<MermaidRenderResult> {
  const started = performance.now()
  const input = options.normalizeBreaks === true ? normalizeMermaidSource(source) : source
  const normalizedBreaks = input !== source
  const mermaid = await loadMermaid()
  const rendered = await mermaid.render(id, input)
  return { svg: rendered.svg, durationMs: performance.now() - started, normalizedBreaks }
}

export function parseMermaidSvg(svg: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') {
    throw new Error('Mermaid did not return an SVG diagram')
  }
  return document.importNode(root, true) as unknown as SVGSVGElement
}
