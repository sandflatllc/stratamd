import { describe, expect, it } from 'vitest'
import type { EditorHeading } from '../../src/editor/headings'
import type { WalkthroughState } from '../../src/shared/contracts'
import { referencedHeadings } from '../../src/shared/walkthrough'
import { sectionPreview, stepLevel, stepNumber, walkthroughView } from '../../src/renderer/walkthrough'
import { componentGlyph, componentLabel, componentQualifier } from '../../src/editor/component-labels'

const DOCUMENT = `# Review

Lede.

## 1. Verdict

Mesa's product is **strong** and its written process is upside down. See [08 §2.3](./e.md).

| Fact | Evidence |
|---|---|
| One | 08 |

## 2. Islands

| Island | Owns |
|---|---|
| Sales | Stage |

### 2.1 Detail

Detail body.

## 3. Change list

<PhaseBoard>
### Now

- Fix integration migration ordering. *1 day*
</PhaseBoard>
`

function headings(): EditorHeading[] {
  const found: EditorHeading[] = []
  const lines = DOCUMENT.split('\n')
  let offset = 0
  for (const line of lines) {
    const match = /^(#{1,6}) (.*)$/u.exec(line)
    if (match) {
      const level = match[1]!.length as EditorHeading['level']
      found.push({ id: `heading:${found.length + 1}`, level, text: match[2]!, position: offset, sourceFrom: offset, atx: true })
    }
    offset += line.length + 1
  }
  return found
}

const inactive: WalkthroughState = { active: false, level: 'h2', current: null, excluded: [], markers: [] }

describe('walkthroughView', () => {
  it('is null while the walkthrough is inactive', () => {
    expect(walkthroughView(headings(), inactive)).toBeNull()
  })

  it('lists H2 steps by default and adds H3 steps only in H2 + H3 mode', () => {
    const all = headings()
    const h2 = walkthroughView(all, { ...inactive, active: true })!
    expect(h2.included.map(({ heading }) => heading.text)).toEqual(['1. Verdict', '2. Islands', '3. Change list'])
    const h3 = walkthroughView(all, { ...inactive, active: true, level: 'h2-h3' })!
    expect(h3.included.map(({ heading }) => heading.text)).toEqual(['1. Verdict', '2. Islands', '2.1 Detail', '3. Change list', 'Now'])
    expect(stepLevel('h2', 3)).toBe(false)
    expect(stepLevel('h2-h3', 3)).toBe(true)
  })

  it('resolves the current step, its index, and its marker', () => {
    const all = headings()
    const islands = referencedHeadings(all).find(({ heading }) => heading.text === '2. Islands')!.reference
    const view = walkthroughView(all, {
      active: true, level: 'h2', current: islands, excluded: [],
      markers: [{ heading: islands, status: 'reviewed', reviewedHash: 'a', sourceHash: 'a' }],
    })!
    expect(view.currentIndex).toBe(1)
    expect(view.current?.heading.text).toBe('2. Islands')
    expect(view.markerByKey.get(JSON.stringify(islands))?.status).toBe('reviewed')
    expect(stepNumber(view.currentIndex)).toBe('02')
  })

  it('drops excluded steps from the route without losing them from the references', () => {
    const all = headings()
    const verdict = referencedHeadings(all).find(({ heading }) => heading.text === '1. Verdict')!.reference
    const view = walkthroughView(all, { ...inactive, active: true, excluded: [verdict] })!
    expect(view.included.map(({ heading }) => heading.text)).toEqual(['2. Islands', '3. Change list'])
    expect(view.references.some(({ heading }) => heading.text === '1. Verdict')).toBe(true)
  })
})

describe('sectionPreview', () => {
  it('reads the first paragraph as plain words', () => {
    const verdict = headings().find((heading) => heading.text === '1. Verdict')!
    expect(sectionPreview(DOCUMENT, verdict)).toBe("Mesa's product is strong and its written process is upside down. See 08 §2.3.")
  })

  it('skips tables, looks into subsections, and stops at the next peer heading', () => {
    const islands = headings().find((heading) => heading.text === '2. Islands')!
    expect(sectionPreview(DOCUMENT, islands)).toBe('Detail body.')
    const detail = headings().find((heading) => heading.text === '2.1 Detail')!
    expect(sectionPreview(DOCUMENT, detail)).toBe('Detail body.')
  })

  it('looks through component wrappers and deeper headings for the first sentence', () => {
    const change = headings().find((heading) => heading.text === '3. Change list')!
    expect(sectionPreview(DOCUMENT, change)).toBe('Fix integration migration ordering. 1 day')
  })

  it('truncates long previews on a word boundary', () => {
    const long = `## Long\n\n${'word '.repeat(80).trim()}.\n`
    const preview = sectionPreview(long, { sourceFrom: 0, level: 2 }, 60)
    expect(preview.length).toBeLessThanOrEqual(61)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview).not.toContain('  ')
  })

  it('returns nothing for a runtime heading without a source offset', () => {
    expect(sectionPreview(DOCUMENT, { sourceFrom: null, level: 2 })).toBe('')
  })
})

describe('component labels', () => {
  it('never exposes a registry name twice', () => {
    expect(componentLabel('MetricStrip', 'MetricStrip')).toBe('Metrics')
    expect(componentLabel('PhaseBoard', 'PhaseBoard')).toBe('Phases')
    expect(componentLabel('Callout', 'warning')).toBe('Warning')
    expect(componentLabel('Chart', 'bar')).toBe('Bar chart')
    expect(componentLabel('EvidenceChain', 'EvidenceChain')).toBe('Evidence')
    expect(componentLabel('AnnotatedScreenshot', 'AnnotatedScreenshot')).toBe('Annotated screenshot')
    expect(componentLabel('Verdict', 'recommended')).toBe('Verdict')
    expect(componentQualifier('Verdict', 'recommended')).toBe('Recommended')
    expect(componentQualifier('Verdict', 'neutral')).toBe('')
    expect(componentQualifier('MetricStrip', 'MetricStrip')).toBe('')
    expect(componentGlyph('Callout', 'warning')).toBe('!')
    expect(componentGlyph('Verdict', 'blocked')).toBe('◆')
  })
})
