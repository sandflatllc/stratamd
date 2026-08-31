import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CorpusManifest, CorpusShape, GeneratedCorpus } from './types'

const FIRST_HEADING = 'StrataMD performance fixture'
const TERMINAL_MARKER = 'STRATAMD-PERFORMANCE-FIXTURE-END'

interface Counters {
  sections: number
  tables: number
  tableCells: number
  listItems: number
  taskItems: number
  codeBlocks: number
  codeBytes: number
  images: number
}

function seededWord(seed: number, index: number): string {
  const words = ['buffer', 'review', 'annotation', 'editor', 'markdown', 'delivery', 'snapshot', 'theme', 'source', 'visual', 'agent', 'change']
  return words[(seed * 17 + index * 31) % words.length]!
}

function prose(seed: number, section: number, sentences = 3): string {
  return Array.from({ length: sentences }, (_, sentence) => {
    const offset = section * 11 + sentence * 5
    return `Section ${section} keeps ${seededWord(seed, offset)} work deterministic while **bold text**, *italic text*, ~~revisions~~, \`inline code\`, and [a local-safe link](https://example.com/performance/${section}) exercise rich inline rendering.`
  }).join(' ')
}

function richSection(seed: number, section: number, counters: Counters): string {
  counters.sections += 1
  counters.tables += 1
  counters.tableCells += 12
  counters.listItems += 4
  counters.taskItems += 2
  counters.codeBlocks += 1
  const code = `const section${section} = { seed: ${seed}, active: true }\nconsole.log(section${section})`
  counters.codeBytes += Buffer.byteLength(code)
  const image = section % 20 === 0 ? `\n\n![Local performance asset](performance-asset.svg)` : ''
  if (image) counters.images += 1
  return `## Rich section ${section}\n\n${prose(seed, section)}\n\n- [ ] Inspect ${seededWord(seed, section)} latency\n- [x] Preserve visual behavior\n- Nested-looking item with **strong** and *emphasized* content\n- Link to [section ${section}](#rich-section-${section})\n\n| Construct | Value | Notes |\n| --- | ---: | --- |\n| section | ${section} | deterministic fixture row |\n| seed | ${seed} | stable across runs |\n| status | active | rich table rendering |\n\n> Review quote ${section}. ${prose(seed + 1, section, 1)}\n\n\`\`\`ts\n${code}\n\`\`\`${image}\n\n`
}

function blockHeavySection(seed: number, section: number, counters: Counters): string {
  counters.sections += 1
  return `## Block ${section}\n\n${prose(seed, section, 1)}\n\n### Detail ${section}\n\nShort paragraph ${section}a.\n\nShort paragraph ${section}b with **bold**.\n\nShort paragraph ${section}c with *emphasis*.\n\n`
}

function tableHeavySection(seed: number, section: number, counters: Counters): string {
  counters.sections += 1
  counters.tables += 1
  counters.tableCells += 55
  const rows = Array.from({ length: 10 }, (_, row) => `| ${section}.${row} | ${seededWord(seed, row)} | ${row * section} | active | table cell text |`).join('\n')
  return `## Table ${section}\n\n| Id | Name | Value | Status | Notes |\n| --- | --- | ---: | :---: | --- |\n${rows}\n\n`
}

function listHeavySection(seed: number, section: number, counters: Counters): string {
  counters.sections += 1
  counters.listItems += 12
  counters.taskItems += 4
  return `## List ${section}\n\n- Item ${section}.1 with ${seededWord(seed, section)}\n  - Nested ${section}.1.1\n    - Deep ${section}.1.1.1\n- [ ] Task ${section}.2\n- [x] Task ${section}.3\n- Item ${section}.4\n  1. Ordered ${section}.4.1\n  2. Ordered ${section}.4.2\n- [ ] Task ${section}.5\n- [x] Task ${section}.6\n- Final ${section}.7\n- Final ${section}.8\n\n`
}

function codeHeavySection(seed: number, section: number, counters: Counters): string {
  counters.sections += 1
  counters.codeBlocks += 1
  const body = Array.from({ length: 28 }, (_, line) => `const value_${section}_${line} = "${seededWord(seed, section + line)}-${section}-${line}"`).join('\n')
  counters.codeBytes += Buffer.byteLength(body)
  return `## Code ${section}\n\n${prose(seed, section, 1)}\n\n\`\`\`ts\n${body}\n\`\`\`\n\n`
}

function plainSection(seed: number, section: number, counters: Counters): string {
  counters.sections += 1
  return `## Plain section ${section}\n\n${seededWord(seed, section)} ${'x'.repeat(16 * 1024)}\n\n`
}

const sectionFactories: Record<CorpusShape, (seed: number, section: number, counters: Counters) => string> = {
  plain: plainSection,
  rich: richSection,
  'block-heavy': blockHeavySection,
  'table-heavy': tableHeavySection,
  'list-heavy': listHeavySection,
  'code-heavy': codeHeavySection,
}

export function generateCorpus(shape: CorpusShape, requestedBytes: number, seed = 1729): GeneratedCorpus {
  if (!Number.isInteger(requestedBytes) || requestedBytes < 1) throw new RangeError('requestedBytes must be a positive integer')
  const counters: Counters = { sections: 0, tables: 0, tableCells: 0, listItems: 0, taskItems: 0, codeBlocks: 0, codeBytes: 0, images: 0 }
  const chunks = [`# ${FIRST_HEADING}\n\nFixture seed: ${seed}. Requested shape: ${shape}.\n\n`]
  const factory = sectionFactories[shape]
  let section = 0
  while (Buffer.byteLength(chunks.join('')) < requestedBytes) {
    section += 1
    chunks.push(factory(seed, section, counters))
  }
  chunks.push(`<!-- ${TERMINAL_MARKER} -->\n`)
  const markdown = chunks.join('')
  const lines = markdown.split('\n').length
  const topLevelBlocks = markdown.split(/\n\n+/u).filter(Boolean).length
  const manifest: CorpusManifest = {
    shape,
    requestedBytes,
    bytes: Buffer.byteLength(markdown),
    lines,
    topLevelBlocks,
    ...counters,
    seed,
  }
  return { markdown, manifest, firstHeading: FIRST_HEADING, terminalMarker: TERMINAL_MARKER }
}

export async function writeCorpusAssets(documentPath: string): Promise<void> {
  const asset = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#9b5cff"/><stop offset="1" stop-color="#ff5c8a"/></linearGradient></defs><rect width="960" height="540" rx="48" fill="#241e3b"/><circle cx="220" cy="270" r="150" fill="url(#g)" opacity=".72"/><path d="M420 170h360v44H420zm0 84h280v30H420zm0 66h330v30H420z" fill="#f4f3f6" opacity=".86"/></svg>`
  await writeFile(join(dirname(documentPath), 'performance-asset.svg'), asset)
}
