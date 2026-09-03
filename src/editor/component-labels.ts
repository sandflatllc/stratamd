/**
 * Human copy for registered component chrome. Registry names stay in the
 * accessible label and data attributes; the visible eyebrow reads as a short
 * word, never as `METRICSTRIP · METRICSTRIP`.
 */
const CALLOUT_KINDS: Record<string, string> = { context: 'Context', warning: 'Warning', implication: 'Implication', support: 'Support' }
const VERDICT_OUTCOMES: Record<string, string> = { recommended: 'Recommended', caution: 'Caution', blocked: 'Blocked', neutral: '' }

export function componentLabel(name: string, semantic: string): string {
  switch (name) {
    case 'Callout': return CALLOUT_KINDS[semantic] ?? 'Note'
    case 'Verdict': return 'Verdict'
    case 'MetricStrip': return 'Metrics'
    case 'PhaseBoard': return 'Phases'
    case 'DecisionMatrix': return 'Decision matrix'
    case 'BeforeAfter': return 'Before and after'
    case 'Chart': return semantic === 'bar' ? 'Bar chart' : 'Line chart'
    case 'EvidenceChain': return 'Evidence'
    case 'AnnotatedScreenshot': return 'Annotated screenshot'
    default: return name
  }
}

/** A second, quieter word when the semantic adds meaning beyond the label. */
export function componentQualifier(name: string, semantic: string): string {
  if (name === 'Verdict') return VERDICT_OUTCOMES[semantic] ?? ''
  return ''
}

export function componentGlyph(name: string, semantic: string): string {
  switch (name) {
    case 'Callout': return semantic === 'warning' ? '!' : semantic === 'implication' ? '→' : semantic === 'support' ? '✓' : '✦'
    case 'Verdict': return '◆'
    case 'MetricStrip': return '▥'
    case 'PhaseBoard': return '≡'
    case 'DecisionMatrix': return '⊞'
    case 'BeforeAfter': return '◐'
    case 'Chart': return '▥'
    case 'EvidenceChain': return '⌁'
    case 'AnnotatedScreenshot': return '⊙'
    default: return '•'
  }
}
