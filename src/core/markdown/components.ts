import { fromMarkdown } from 'mdast-util-from-markdown'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { frontmatter } from 'micromark-extension-frontmatter'
import { gfm } from 'micromark-extension-gfm'
import { parseMarkdown } from './parser.js'

export const COMPONENT_NAMES = [
  'Callout',
  'Verdict',
  'MetricStrip',
  'PhaseBoard',
  'DecisionMatrix',
  'BeforeAfter',
  'Chart',
  'EvidenceChain',
  'AnnotatedScreenshot',
] as const
export type ComponentName = typeof COMPONENT_NAMES[number]

export interface ComponentPropertySchema {
  description: string
  required: false
  default: string
  values: readonly string[]
}

export interface ComponentSchema {
  name: ComponentName
  purpose: string
  body: string
  properties: Readonly<Record<string, ComponentPropertySchema>>
  example: string
}

export const COMPONENT_REGISTRY: Readonly<Record<ComponentName, ComponentSchema>> = {
  Callout: {
    name: 'Callout',
    purpose: 'Keep important context, a warning, an implication, or supporting material together.',
    body: 'One or more ordinary Markdown blocks. Use a heading in the body when the callout needs a title.',
    properties: {
      kind: {
        description: 'The semantic job of the note.',
        required: false,
        default: 'context',
        values: ['context', 'warning', 'implication', 'support'],
      },
    },
    example: '<Callout kind="warning">\n### Before continuing\n\nBack up the local store before changing its format.\n</Callout>',
  },
  Verdict: {
    name: 'Verdict',
    purpose: 'Present the controlling judgment at the start of a judgment-heavy section.',
    body: 'One or more ordinary Markdown blocks containing the judgment and its concise rationale.',
    properties: {
      outcome: {
        description: 'The semantic outcome of the judgment.',
        required: false,
        default: 'neutral',
        values: ['recommended', 'caution', 'blocked', 'neutral'],
      },
    },
    example: '<Verdict outcome="recommended">\n### Adopt the bounded parser\n\nIt preserves source identity without allowing executable MDX.\n</Verdict>',
  },
  MetricStrip: {
    name: 'MetricStrip',
    purpose: 'Group a short set of figures that carries part of the argument.',
    body: 'An ordinary Markdown list with one metric per item; start each item with a strong label.',
    properties: {},
    example: '<MetricStrip>\n- **Open time:** 224 ms\n- **Typing:** 9.8 ms\n- **Byte drift:** 0\n</MetricStrip>',
  },
  PhaseBoard: {
    name: 'PhaseBoard',
    purpose: 'Keep several ordered implementation phases and their supporting tables together.',
    body: 'Ordinary Markdown phase headings, prose, lists, and tables in execution order.',
    properties: {},
    example: '<PhaseBoard>\n### Phase 1\n\n| Work | Status |\n|---|---|\n| Parser | Complete |\n\n### Phase 2\n\n- Add editor views.\n</PhaseBoard>',
  },
  DecisionMatrix: {
    name: 'DecisionMatrix',
    purpose: 'Compare two to six explicit alternatives against the same criteria.',
    body: 'Exactly one GFM table. The first header is Criterion and the remaining headers name alternatives.',
    properties: {},
    example: '<DecisionMatrix>\n| Criterion | Keep current | Adopt bounded parser |\n|---|---|---|\n| Byte preservation | Partial | Strong |\n| Executable content | Possible | Blocked |\n</DecisionMatrix>',
  },
  BeforeAfter: {
    name: 'BeforeAfter',
    purpose: 'Show a direct transformation or contrast between two named sides.',
    body: 'Exactly two blockquotes. Each begins with an H3 heading and may contain ordinary Markdown beneath it.',
    properties: {},
    example: '<BeforeAfter>\n> ### Before\n> Copy the document into chat and compare rewrites manually.\n\n> ### With StrataMD\n> Discuss tracked edits in the open document.\n</BeforeAfter>',
  },
  Chart: {
    name: 'Chart',
    purpose: 'Plot a bounded numeric relationship that is harder to see in its source table.',
    body: 'Exactly one GFM table: category labels first, then one to six finite numeric series and at most 1,000 rows.',
    properties: {
      kind: {
        description: 'The declarative chart presentation.',
        required: false,
        default: 'line',
        values: ['line', 'bar'],
      },
    },
    example: '<Chart kind="line">\n| Month | Open time | Typing |\n|---|---:|---:|\n| Jul | 240 | 12.4 |\n| Aug | 224 | 9.8 |\n</Chart>',
  },
  EvidenceChain: {
    name: 'EvidenceChain',
    purpose: 'Keep a claim, explicit local evidence targets, and the earned conclusion connected.',
    body: 'H3 sections named Claim, Evidence, and Therefore in that order. Evidence is a list whose every item contains a local Markdown or same-document heading link.',
    properties: {},
    example: '<EvidenceChain>\n### Claim\n\nMechanical guards hold better than prose.\n\n### Evidence\n\n- [Database findings](./evidence.md#database-guards) — enforced invariants held.\n- [CI findings](#ci-findings) — prose-only gates drifted.\n\n### Therefore\n\nMove the invariant into executable boundaries.\n</EvidenceChain>',
  },
  AnnotatedScreenshot: {
    name: 'AnnotatedScreenshot',
    purpose: 'Connect numbered positions on one local image to durable Markdown notes.',
    body: 'Exactly one local Markdown image followed by a Pin/X/Y/Image version/Note GFM table. Add coordinates with a strata edit or Place pin.',
    properties: {},
    example: '<AnnotatedScreenshot>\n![Review table](./review-table.png)\n\n| Pin | X | Y | Image version | Note |\n|---:|---:|---:|---|---|\n| 1 | 24.0 | 31.5 | 48211:1788372000000000000 | Long rows need a clearer boundary. |\n</AnnotatedScreenshot>',
  },
}

export interface ComponentPosition {
  line: number
  column: number
  offset?: number
}

export interface ComponentAttributeNode {
  type: string
  name?: string
  value?: string | { type?: string; value?: string } | null
  position?: { start: ComponentPosition; end: ComponentPosition }
}

export interface ComponentAstNode {
  type: string
  name?: string | null
  value?: string
  url?: string
  depth?: number
  attributes?: ComponentAttributeNode[]
  children?: ComponentAstNode[]
  position?: { start: ComponentPosition; end: ComponentPosition }
  data?: { strataComponentProblems?: ComponentProblem[] }
}

export interface ComponentProblem {
  code: 'COMPONENT_SYNTAX' | 'COMPONENT_UNKNOWN' | 'COMPONENT_TOP_LEVEL_REQUIRED'
    | 'COMPONENT_PROPERTY_UNKNOWN' | 'COMPONENT_PROPERTY_VALUE' | 'COMPONENT_PROPERTY_QUOTED'
    | 'COMPONENT_PROPERTY_DUPLICATE' | 'COMPONENT_BODY_REQUIRED' | 'COMPONENT_NESTED'
    | 'COMPONENT_BODY_INVALID' | 'COMPONENT_TARGET_REQUIRED' | 'COMPONENT_PIN_INVALID'
  message: string
  fix: string
  line: number
  column: number
  component?: string
  property?: string
}

export interface ComponentAnalysis {
  registered: boolean
  name: string | null
  valid: boolean
  properties: Record<string, string>
  explicit: Record<string, string>
  problems: ComponentProblem[]
}

export interface ComponentValidationReport {
  valid: boolean
  components: Array<{ name: ComponentName; line: number }>
  problems: ComponentProblem[]
}

export function isComponentName(value: unknown): value is ComponentName {
  return typeof value === 'string' && (COMPONENT_NAMES as readonly string[]).includes(value)
}

function positionOf(node: ComponentAstNode | ComponentAttributeNode): { line: number; column: number } {
  return { line: node.position?.start.line ?? 1, column: node.position?.start.column ?? 1 }
}

function problem(
  code: ComponentProblem['code'],
  message: string,
  fix: string,
  node: ComponentAstNode | ComponentAttributeNode,
  component?: string,
  property?: string,
): ComponentProblem {
  return { code, message, fix, ...positionOf(node), ...(component ? { component } : {}), ...(property ? { property } : {}) }
}

function nestedComponent(node: ComponentAstNode): ComponentAstNode | null {
  for (const child of node.children ?? []) {
    if ((child.type === 'mdxJsxFlowElement' || child.type === 'mdxJsxTextElement') && isComponentName(child.name)) return child
    const nested = nestedComponent(child)
    if (nested) return nested
  }
  return null
}

export function mdastText(node: ComponentAstNode): string {
  if (node.type === 'image' || node.type === 'imageReference') return typeof (node as ComponentAstNode & { alt?: unknown }).alt === 'string'
    ? String((node as ComponentAstNode & { alt?: unknown }).alt)
    : ''
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(mdastText).join('')
}

function tableRows(node: ComponentAstNode): ComponentAstNode[][] | null {
  if (node.type !== 'table') return null
  return (node.children ?? []).map((row) => row.children ?? [])
}

export interface AnnotatedScreenshotPinData {
  pin: number
  x: number
  y: number
  version: string
  note: string
}

export interface AnnotatedScreenshotData {
  imageSource: string
  pins: AnnotatedScreenshotPinData[]
  tableEnd: number | null
}

export function annotatedScreenshotData(node: ComponentAstNode): AnnotatedScreenshotData | null {
  const children = node.children ?? []
  const images: ComponentAstNode[] = []
  const visit = (child: ComponentAstNode): void => {
    if (child.type === 'image') images.push(child)
    for (const nested of child.children ?? []) visit(nested)
  }
  for (const child of children) visit(child)
  const tables = children.filter((child) => child.type === 'table')
  const rows = tables.length === 1 ? tableRows(tables[0]!) : null
  if (images.length !== 1 || typeof images[0]!.url !== 'string' || !rows) return null
  return {
    imageSource: images[0]!.url!,
    pins: rows.slice(1).map((row) => ({
      pin: row[0] ? Number(mdastText(row[0])) : Number.NaN,
      x: row[1] ? Number(mdastText(row[1])) : Number.NaN,
      y: row[2] ? Number(mdastText(row[2])) : Number.NaN,
      version: row[3] ? mdastText(row[3]).trim() : '',
      note: row[4] ? mdastText(row[4]).trim() : '',
    })),
    tableEnd: tables[0]?.position?.end.offset ?? null,
  }
}

function bodyProblem(
  node: ComponentAstNode,
  component: ComponentName,
  message: string,
  fix: string,
  code: ComponentProblem['code'] = 'COMPONENT_BODY_INVALID',
): ComponentProblem {
  return problem(code, message, fix, node, component)
}

function hasExplicitLocalTarget(node: ComponentAstNode): boolean {
  if (node.type === 'link' && typeof node.url === 'string') {
    const target = node.url.trim()
    return target.startsWith('#') || (!/^[a-z][a-z\d+.-]*:/iu.test(target) && /\.md(?:own)?(?:[#?]|$)/iu.test(target))
  }
  return (node.children ?? []).some(hasExplicitLocalTarget)
}

function componentBodyProblems(node: ComponentAstNode, name: ComponentName): ComponentProblem[] {
  const children = node.children ?? []
  if (name === 'DecisionMatrix') {
    const rows = children.length === 1 ? tableRows(children[0]!) : null
    const width = rows?.[0]?.length ?? 0
    if (!rows || rows.length < 2 || width < 3 || width > 7 || mdastText(rows[0]![0]!).trim() !== 'Criterion'
      || rows.some((row) => row.length !== width)) {
      return [bodyProblem(node, name, 'DecisionMatrix needs one Criterion table with two to six alternatives.', 'Use one GFM table whose first header is Criterion and whose remaining headers name the alternatives.')]
    }
  }
  if (name === 'BeforeAfter') {
    const valid = children.length === 2 && children.every((side) => {
      const heading = side.type === 'blockquote' ? side.children?.[0] : undefined
      return heading?.type === 'heading' && heading.depth === 3 && mdastText(heading).trim().length > 0
    })
    if (!valid) return [bodyProblem(node, name, 'BeforeAfter needs exactly two blockquotes led by H3 headings.', 'Write two blockquotes, each beginning with > ### Side name.')]
  }
  if (name === 'Chart') {
    const rows = children.length === 1 ? tableRows(children[0]!) : null
    const width = rows?.[0]?.length ?? 0
    const labels = rows?.every((row) => row[0] !== undefined && mdastText(row[0]).trim().length > 0) ?? false
    const seriesLabels = rows?.[0]?.slice(1).every((cell) => mdastText(cell).trim().length > 0) ?? false
    const numeric = rows?.slice(1).every((row) => row.length === width && row.slice(1).every((cell) => {
      const value = mdastText(cell).trim()
      return value.length > 0 && Number.isFinite(Number(value))
    })) ?? false
    if (!rows || rows.length < 2 || rows.length > 1_001 || width < 2 || width > 7 || !labels || !seriesLabels || !numeric) {
      return [bodyProblem(node, name, 'Chart needs one bounded table with category labels and finite numeric series.', 'Use one GFM table with one label column, one to six numeric series, and no more than 1,000 data rows.')]
    }
  }
  if (name === 'EvidenceChain') {
    const headings = children
      .map((child, index) => ({ child, index, text: child.type === 'heading' && child.depth === 3 ? mdastText(child).trim() : '' }))
      .filter((entry) => entry.text.length > 0)
    const validHeadings = headings.length === 3 && headings.map((entry) => entry.text).join('\0') === 'Claim\0Evidence\0Therefore'
    if (!validHeadings) return [bodyProblem(node, name, 'EvidenceChain needs Claim, Evidence, and Therefore H3 sections in order.', 'Add exactly ### Claim, ### Evidence, and ### Therefore sections in that order.')]
    const evidenceStart = headings[1]!.index + 1
    const evidenceEnd = headings[2]!.index
    const lists = children.slice(evidenceStart, evidenceEnd).filter((child) => child.type === 'list')
    const items = lists.flatMap((list) => list.children ?? [])
    if (lists.length !== 1 || items.length === 0 || items.some((item) => !hasExplicitLocalTarget(item))) {
      return [bodyProblem(node, name, 'Every Evidence item needs an explicit local Markdown or heading link.', 'Use links such as [finding](./evidence.md#finding) or [section](#section); numeric shorthand is not a target.', 'COMPONENT_TARGET_REQUIRED')]
    }
  }
  if (name === 'AnnotatedScreenshot') {
    const screenshot = annotatedScreenshotData(node)
    const images: ComponentAstNode[] = []
    const visit = (child: ComponentAstNode): void => {
      if (child.type === 'image') images.push(child)
      for (const nested of child.children ?? []) visit(nested)
    }
    for (const child of children) visit(child)
    const tables = children.filter((child) => child.type === 'table')
    const rows = tables.length === 1 ? tableRows(tables[0]!) : null
    const headers = rows?.[0]?.map((cell) => mdastText(cell).trim()) ?? []
    const localImage = images.length === 1 && typeof images[0]!.url === 'string'
      && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(images[0]!.url!)
    const pins = new Set<number>()
    const validPins = screenshot !== null && (rows?.slice(1).every((row, index) => {
      if (row.length !== 5) return false
      const { pin, x, y, version, note } = screenshot.pins[index]!
      if (!Number.isInteger(pin) || pin < 1 || pins.has(pin) || !Number.isFinite(x) || x < 0 || x > 100
        || !Number.isFinite(y) || y < 0 || y > 100 || !/^\d+:\d+$/u.test(version) || note.length === 0) return false
      pins.add(pin)
      return true
    }) ?? false)
    if (!localImage || children[0]?.type !== 'paragraph' || headers.join('\0') !== 'Pin\0X\0Y\0Image version\0Note') {
      return [bodyProblem(node, name, 'AnnotatedScreenshot needs one local image followed by the exact five-column pin table.', 'Use one local Markdown image, then headers Pin, X, Y, Image version, and Note.')]
    }
    if (!validPins) return [bodyProblem(node, name, 'AnnotatedScreenshot has an invalid pin row.', 'Use unique positive pin numbers, X/Y from 0 through 100, a generated image version, and a nonempty note.', 'COMPONENT_PIN_INVALID')]
  }
  return []
}

export function analyzeComponentNode(node: ComponentAstNode, topLevel = true): ComponentAnalysis {
  const name = typeof node.name === 'string' ? node.name : null
  if (!isComponentName(name)) return { registered: false, name, valid: false, properties: {}, explicit: {}, problems: [] }
  const structuralProblems = node.data?.strataComponentProblems ?? []
  const schema = COMPONENT_REGISTRY[name]
  const problems: ComponentProblem[] = [...structuralProblems]
  const properties: Record<string, string> = Object.fromEntries(
    Object.entries(schema.properties).map(([key, value]) => [key, value.default]),
  )
  const explicit: Record<string, string> = {}
  if (!topLevel || node.type !== 'mdxJsxFlowElement') {
    problems.push(problem(
      'COMPONENT_TOP_LEVEL_REQUIRED',
      `${name} must be a top-level block.`,
      `Put <${name}> and </${name}> on their own block boundaries.`,
      node,
      name,
    ))
  }
  const seen = new Set<string>()
  for (const attribute of node.attributes ?? []) {
    const key = attribute.name
    if (attribute.type !== 'mdxJsxAttribute' || !key) {
      problems.push(problem(
        'COMPONENT_PROPERTY_QUOTED',
        `${name} properties must be quoted text, not an expression or spread.`,
        'Remove the expression and use only a documented quoted property.',
        attribute,
        name,
      ))
      continue
    }
    if (seen.has(key)) {
      problems.push(problem(
        'COMPONENT_PROPERTY_DUPLICATE',
        `${name} repeats the ${key} property.`,
        `Keep one ${key} property.`,
        attribute,
        name,
        key,
      ))
      continue
    }
    seen.add(key)
    const propertySchema = schema.properties[key]
    if (!propertySchema) {
      problems.push(problem(
        'COMPONENT_PROPERTY_UNKNOWN',
        `${name} does not accept the ${key} property.`,
        `Remove ${key} and query stratamd components ${name} for the accepted schema.`,
        attribute,
        name,
        key,
      ))
      continue
    }
    if (typeof attribute.value !== 'string') {
      problems.push(problem(
        'COMPONENT_PROPERTY_QUOTED',
        `${name}.${key} must be a quoted value.`,
        `Use ${key}="${propertySchema.default}" or another documented value.`,
        attribute,
        name,
        key,
      ))
      continue
    }
    if (!propertySchema.values.includes(attribute.value)) {
      problems.push(problem(
        'COMPONENT_PROPERTY_VALUE',
        `${name}.${key} cannot be ${JSON.stringify(attribute.value)}.`,
        `Use one of: ${propertySchema.values.join(', ')}.`,
        attribute,
        name,
        key,
      ))
      continue
    }
    properties[key] = attribute.value
    explicit[key] = attribute.value
  }
  if ((node.children ?? []).length === 0) {
    problems.push(problem(
      'COMPONENT_BODY_REQUIRED',
      `${name} needs a Markdown body.`,
      `Add ordinary Markdown between <${name}> and </${name}>.`,
      node,
      name,
    ))
  }
  const nested = nestedComponent(node)
  if (nested) {
    problems.push(problem(
      'COMPONENT_NESTED',
      `${String(nested.name)} cannot be nested inside ${name}.`,
      'Move the nested component beside this component as another top-level block.',
      nested,
      name,
    ))
  }
  if (problems.length === 0) problems.push(...componentBodyProblems(node, name))
  return { registered: true, name, valid: problems.length === 0, properties, explicit, problems }
}

interface ComponentRange {
  name: ComponentName
  from: number
  to: number
  bodyFrom: number
  bodyTo: number
  line: number
  opening: string
  complete: boolean
  nested?: { name: ComponentName; line: number; column: number }
}

export interface ComponentDocumentStructure {
  source: string
  maskedSource: string
  ranges: readonly ComponentRange[]
  masks: readonly { from: number; to: number }[]
}

interface OpenComponent {
  range: ComponentRange
  depth: number
}

function maskText(value: string): string {
  return value.replace(/[^\r\n]/gu, ' ')
}

function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1
  let lastBreak = -1
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') {
      line += 1
      lastBreak = index
    }
  }
  return { line, column: offset - lastBreak }
}

/**
 * Find only registered tags occupying a complete block-boundary line. The
 * wrapper text is masked without changing offsets, so ordinary Markdown is
 * parsed exactly once and component bodies keep native mdast child spans.
 */
export function structureComponentDocument(source: string): ComponentDocumentStructure {
  const ranges: ComponentRange[] = []
  const masks: Array<{ from: number; to: number }> = []
  const stack: OpenComponent[] = []
  const linePattern = /.*(?:\r\n|\n|\r|$)/gu
  let lineNumber = 0
  let fence: { marker: '`' | '~'; length: number } | null = null
  for (const match of source.matchAll(linePattern)) {
    if (!match[0]) continue
    lineNumber += 1
    const from = match.index
    const line = match[0]
    const content = line.replace(/(?:\r\n|\n|\r)$/u, '')
    const end = from + content.length
    const location = { line: lineNumber, column: 1 }
    if (fence) {
      const closer = content.match(/^ {0,3}(`+|~+)[\t ]*$/u)
      if (closer && closer[1]![0] === fence.marker && closer[1]!.length >= fence.length) fence = null
      continue
    }
    // CommonMark: the info string may follow the marker directly (```mermaid); a backtick fence's info string cannot contain a backtick.
    const opener = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u)
    if (opener && !(opener[1]![0] === '`' && opener[2]!.includes('`'))) {
      fence = { marker: opener[1]![0] as '`' | '~', length: opener[1]!.length }
      continue
    }
    const sameLine = content.match(/^<([A-Za-z][A-Za-z\d]*)(?:\s[^<>]*)?>[\t ]*<\/\1>[\t ]*$/u)
    if (sameLine && isComponentName(sameLine[1])) {
      masks.push({ from, to: end })
      if (stack.length > 0) {
        const root = stack[0]!.range
        root.nested ??= { name: sameLine[1], line: location.line, column: location.column }
      } else {
        ranges.push({
          name: sameLine[1], from, to: end, bodyFrom: end, bodyTo: end,
          line: location.line, opening: content, complete: true,
        })
      }
      continue
    }
    const opening = content.match(/^<([A-Za-z][A-Za-z\d]*)(?:\s[\s\S]*)?>[\t ]*$/u)
    if (opening && isComponentName(opening[1])) {
      masks.push({ from, to: end })
      const range: ComponentRange = {
        name: opening[1], from, to: source.length, bodyFrom: from + line.length,
        bodyTo: source.length, line: location.line, opening: content, complete: false,
      }
      if (stack.length > 0) {
        stack[0]!.range.nested ??= { name: opening[1], line: location.line, column: location.column }
      }
      stack.push({ range, depth: stack.length })
      continue
    }
    const closing = content.match(/^<\/([A-Za-z][A-Za-z\d]*)>[\t ]*$/u)
    if (!closing || !isComponentName(closing[1])) continue
    masks.push({ from, to: end })
    const open = stack.at(-1)
    if (!open || open.range.name !== closing[1]) {
      if (stack.length === 0) {
        ranges.push({
          name: closing[1], from, to: end, bodyFrom: end, bodyTo: end,
          line: location.line, opening: '', complete: false,
        })
      } else {
        stack[0]!.range.complete = false
      }
      continue
    }
    stack.pop()
    open.range.to = end
    open.range.bodyTo = from
    open.range.complete = true
    if (open.depth === 0) ranges.push(open.range)
  }
  for (const open of stack) {
    if (open.depth === 0) ranges.push(open.range)
  }
  ranges.sort((left, right) => left.from - right.from)
  let maskedSource = source
  for (let index = masks.length - 1; index >= 0; index -= 1) {
    const range = masks[index]!
    maskedSource = maskedSource.slice(0, range.from) + maskText(maskedSource.slice(range.from, range.to)) + maskedSource.slice(range.to)
  }
  return { source, maskedSource, ranges, masks }
}

function syntaxProblem(range: ComponentRange, message = `${range.name} has invalid component tag syntax.`): ComponentProblem {
  return {
    code: 'COMPONENT_SYNTAX', message,
    fix: `Use <${range.name}> and </${range.name}> on separate block-boundary lines with quoted documented properties.`,
    line: range.line, column: 1, component: range.name,
  }
}

function wrapperNode(range: ComponentRange): ComponentAstNode | null {
  if (!range.complete || !range.opening) return null
  const opening = range.opening.match(/^<([A-Za-z][A-Za-z\d]*)([\s\S]*?)>[\t ]*$/u)
  if (!opening || opening[1] !== range.name || /\/$/u.test(opening[2]!.trim())) return null
  const attributes: ComponentAttributeNode[] = []
  let rest = opening[2]!
  while (rest.length > 0) {
    const whitespace = rest.match(/^[\t ]+/u)
    if (!whitespace) return null
    rest = rest.slice(whitespace[0].length)
    if (!rest) break
    if (rest.startsWith('{')) {
      attributes.push({ type: 'mdxJsxExpressionAttribute' })
      const end = rest.indexOf('}')
      if (end < 0) return null
      rest = rest.slice(end + 1)
      continue
    }
    const name = rest.match(/^([A-Za-z_][A-Za-z\d_.:-]*)/u)
    if (!name) return null
    rest = rest.slice(name[0].length)
    const equals = rest.match(/^[\t ]*=[\t ]*/u)
    if (!equals) {
      attributes.push({ type: 'mdxJsxAttribute', name: name[1]!, value: null })
      continue
    }
    rest = rest.slice(equals[0].length)
    const quote = rest[0]
    if (quote !== '"' && quote !== "'") {
      const value = rest.match(/^[^\t ]+/u)?.[0] ?? ''
      attributes.push({ type: 'mdxJsxAttribute', name: name[1]!, value: { type: 'mdxJsxAttributeValueExpression', value } })
      rest = rest.slice(value.length)
      continue
    }
    const end = rest.indexOf(quote, 1)
    if (end < 0) return null
    attributes.push({ type: 'mdxJsxAttribute', name: name[1]!, value: rest.slice(1, end) })
    rest = rest.slice(end + 1)
  }
  return { type: 'mdxJsxFlowElement', name: range.name, attributes, children: [] }
}

/** Replace masked wrapper ranges with registered mdast component nodes. */
export function applyComponentStructure(root: ComponentAstNode, structure: ComponentDocumentStructure): void {
  let children = root.children ?? []
  let ranges = structure.ranges
  const rejected = new Set(ranges.filter((range) => children.some((child) => {
    const start = child.position?.start.offset
    const end = child.position?.end.offset
    return start !== undefined && end !== undefined && range.from > start && range.from < end
  })))
  if (rejected.size > 0) {
    ranges = ranges.filter((range) => !rejected.has(range))
    const masks = structure.masks.filter((mask) => ranges.some((range) => mask.from >= range.from && mask.to <= range.to))
    let maskedSource = structure.source
    for (let index = masks.length - 1; index >= 0; index -= 1) {
      const mask = masks[index]!
      maskedSource = maskedSource.slice(0, mask.from) + maskText(maskedSource.slice(mask.from, mask.to)) + maskedSource.slice(mask.to)
    }
    const reparsed = fromMarkdown(maskedSource, {
      extensions: [gfm(), frontmatter(['yaml'])],
      mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])],
    }) as unknown as ComponentAstNode
    children = reparsed.children ?? []
  }
  const output: ComponentAstNode[] = []
  let childIndex = 0
  for (const range of ranges) {
    while ((children[childIndex]?.position?.end.offset ?? Number.POSITIVE_INFINITY) <= range.from) {
      output.push(children[childIndex]!)
      childIndex += 1
    }
    const body: ComponentAstNode[] = []
    while ((children[childIndex]?.position?.start.offset ?? Number.POSITIVE_INFINITY) < range.to) {
      const child = children[childIndex]!
      const start = child.position?.start.offset ?? -1
      const end = child.position?.end.offset ?? Number.POSITIVE_INFINITY
      if (start >= range.bodyFrom && end <= range.bodyTo) body.push(child)
      childIndex += 1
    }
    const parsed = wrapperNode(range)
    const problems: ComponentProblem[] = []
    if (!parsed) problems.push(syntaxProblem(range))
    if (range.nested) {
      problems.push({
        code: 'COMPONENT_NESTED',
        message: `${range.nested.name} cannot be nested inside ${range.name}.`,
        fix: 'Move the nested component beside this component as another top-level block.',
        line: range.nested.line, column: range.nested.column, component: range.name,
      })
    }
    output.push({
      type: 'mdxJsxFlowElement', name: range.name,
      attributes: parsed?.attributes ?? [], children: body,
      position: {
        start: { line: range.line, column: 1, offset: range.from },
        end: { ...lineColumn(structure.maskedSource, range.to), offset: range.to },
      },
      ...(problems.length > 0 ? { data: { strataComponentProblems: problems } } : {}),
    })
  }
  output.push(...children.slice(childIndex))
  root.children = output
}

function visitForValidation(
  node: ComponentAstNode,
  topLevel: boolean,
  components: ComponentValidationReport['components'],
  problems: ComponentProblem[],
): void {
  if (node.type === 'mdxJsxFlowElement' && isComponentName(node.name)) {
    const analysis = analyzeComponentNode(node, topLevel)
    components.push({ name: node.name, line: node.position?.start.line ?? 1 })
    problems.push(...analysis.problems)
    if (topLevel) return
  } else if (node.type === 'html' && typeof node.value === 'string') {
    const opening = node.value.match(/^\s*<([A-Z][A-Za-z\d]*)\b/u)?.[1]
    if (opening && isComponentName(opening)) {
      problems.push(problem(
        'COMPONENT_TOP_LEVEL_REQUIRED',
        `${opening} must be a top-level block.`,
        `Put <${opening}> and </${opening}> on their own block boundaries.`,
        node,
        opening,
      ))
    } else if (opening && topLevel) {
      problems.push(problem(
        'COMPONENT_UNKNOWN',
        `${opening} is not a registered StrataMD component.`,
        'Use ordinary Markdown or query stratamd components for the closed registry.',
        node,
        opening,
      ))
    }
  }
  for (const child of node.children ?? []) visitForValidation(child, false, components, problems)
}

export function validateComponentMarkdown(source: string): ComponentValidationReport {
  const components: ComponentValidationReport['components'] = []
  const problems: ComponentProblem[] = []
  const tree = parseMarkdown(source).ast as unknown as ComponentAstNode
  for (const child of tree.children ?? []) visitForValidation(child, true, components, problems)
  return { valid: problems.length === 0, components, problems }
}
