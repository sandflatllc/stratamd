import type { VisualAdjustment } from './visual-comments'

/**
 * Adjustments (docs/plans/open/visual-review, phase 4): plain controls for
 * properties that apply directly and visibly to the selected mark. Steppers
 * move in named steps from the page's own value; swatches name a color. Each
 * request is recorded as the exact property and value, with the owner's
 * plain words as its label; the agent implements the intent with the
 * project's styling rules. No number field with units ever appears.
 */
export type AdjustmentKind = 'text-size' | 'text-weight' | 'text-color' | 'background' | 'space-inside' | 'corner-rounding'

export interface AdjustmentControl {
  kind: AdjustmentKind
  /** The row's plain title. */
  title: string
  property: string
  control: 'stepper' | 'swatch'
}

export const ADJUSTMENT_CONTROLS: readonly AdjustmentControl[] = [
  { kind: 'text-size', title: 'Text size', property: 'font-size', control: 'stepper' },
  { kind: 'text-weight', title: 'Text weight', property: 'font-weight', control: 'stepper' },
  { kind: 'text-color', title: 'Text color', property: 'color', control: 'swatch' },
  { kind: 'background', title: 'Background', property: 'background-color', control: 'swatch' },
  { kind: 'space-inside', title: 'Space inside', property: 'padding', control: 'stepper' },
  { kind: 'corner-rounding', title: 'Corner rounding', property: 'border-radius', control: 'stepper' },
]

export const STEP_RANGE = 3

/** Step words from −3 to +3; the middle is the page as it is. */
const STEP_WORDS: Record<Exclude<AdjustmentKind, 'text-color' | 'background'>, readonly string[]> = {
  'text-size': ['much smaller', 'smaller', 'slightly smaller', 'as is', 'slightly larger', 'larger', 'much larger'],
  'text-weight': ['much lighter', 'lighter', 'slightly lighter', 'as is', 'slightly bolder', 'bolder', 'much bolder'],
  'space-inside': ['much less', 'less', 'a little less', 'as is', 'a little more', 'more', 'much more'],
  'corner-rounding': ['square', 'sharper', 'slightly sharper', 'as is', 'slightly rounder', 'rounder', 'much rounder'],
}

/** Swatches: CSS color names the page understands, said in plain words. */
export const SWATCHES: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'black', value: 'black' },
  { name: 'dark gray', value: 'dimgray' },
  { name: 'light gray', value: 'lightgray' },
  { name: 'white', value: 'white' },
  { name: 'red', value: 'crimson' },
  { name: 'orange', value: 'darkorange' },
  { name: 'green', value: 'seagreen' },
  { name: 'blue', value: 'royalblue' },
  { name: 'purple', value: 'rebeccapurple' },
]

export function controlFor(kind: AdjustmentKind): AdjustmentControl {
  return ADJUSTMENT_CONTROLS.find((control) => control.kind === kind)!
}

export function stepWord(kind: AdjustmentKind, step: number): string {
  const words = STEP_WORDS[kind as keyof typeof STEP_WORDS]
  return words?.[Math.max(-STEP_RANGE, Math.min(STEP_RANGE, step)) + STEP_RANGE] ?? 'as is'
}

const px = (value: string | undefined, fallback: number): number => {
  const match = /(-?\d+(?:\.\d+)?)px/.exec(value ?? '')
  return match ? Number(match[1]) : fallback
}

/**
 * The value a step means, from the page's own computed value. Text size moves
 * by an eighth per step, weight by a hundred, space and rounding by 4 px; the
 * outermost rounding step is square.
 */
export function stepValue(kind: AdjustmentKind, base: Record<string, string> | undefined, step: number): string {
  const style = base ?? {}
  if (kind === 'text-size') return `${Math.max(6, Math.round(px(style['font-size'], 16) * (1 + step * 0.125) * 2) / 2)}px`
  if (kind === 'text-weight') {
    const current = /^\d+$/.test(style['font-weight'] ?? '') ? Number(style['font-weight']) : style['font-weight'] === 'bold' ? 700 : 400
    return String(Math.max(100, Math.min(900, Math.round(current / 100) * 100 + step * 100)))
  }
  if (kind === 'space-inside') {
    const parts = (style['padding'] ?? '0px').trim().split(/\s+/).map((part) => `${Math.max(0, px(part, 0) + step * 4)}px`)
    return parts.join(' ')
  }
  if (kind === 'corner-rounding') {
    if (step <= -STEP_RANGE) return '0px'
    return `${Math.max(0, px(style['border-radius']?.split(/\s+/)[0], 0) + step * 4)}px`
  }
  return ''
}

/** The record for one step or swatch on a mark; null when the page is left as it is. */
export function adjustmentFor(kind: AdjustmentKind, markId: string, base: Record<string, string> | undefined, choice: { step: number } | { swatch: string }): VisualAdjustment | null {
  const control = controlFor(kind)
  if ('swatch' in choice) {
    const swatch = SWATCHES.find((candidate) => candidate.value === choice.swatch)
    if (!swatch) return null
    return { markId, property: control.property, value: swatch.value, label: `${control.title}: ${swatch.name}` }
  }
  if (choice.step === 0) return null
  return { markId, property: control.property, value: stepValue(kind, base, choice.step), label: `${control.title}: ${stepWord(kind, choice.step)}` }
}

/** The step an existing adjustment sits at, read back from its plain label. */
export function stepOf(kind: AdjustmentKind, adjustment: VisualAdjustment | undefined): number {
  if (!adjustment) return 0
  const words = STEP_WORDS[kind as keyof typeof STEP_WORDS]
  if (!words) return 0
  const word = adjustment.label.slice(adjustment.label.indexOf(':') + 1).trim()
  const index = words.indexOf(word)
  return index === -1 ? 0 : index - STEP_RANGE
}

export function swatchOf(adjustment: VisualAdjustment | undefined): string | null {
  return adjustment ? SWATCHES.find((swatch) => swatch.value === adjustment.value)?.value ?? null : null
}

/** Adjustments on one mark, one per property. */
export function adjustmentsOn(adjustments: readonly VisualAdjustment[], markId: string): VisualAdjustment[] {
  return adjustments.filter((adjustment) => adjustment.markId === markId)
}

/** Replace or remove the adjustment for one property on one mark. */
export function withAdjustment(adjustments: readonly VisualAdjustment[], markId: string, property: string, next: VisualAdjustment | null): VisualAdjustment[] {
  const rest = adjustments.filter((adjustment) => !(adjustment.markId === markId && adjustment.property === property))
  return next ? [...rest, next] : rest
}
