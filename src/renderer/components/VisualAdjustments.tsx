import type { VisualAdjustmentView, VisualMarkView } from '../../shared/contracts'
import { ADJUSTMENT_CONTROLS, adjustmentFor, adjustmentsOn, STEP_RANGE, stepOf, stepWord, SWATCHES, swatchOf, withAdjustment, type AdjustmentKind } from '../../core/visual-adjustments'

/**
 * Adjustments (docs/plans/open/visual-review, phase 4): plain controls on the
 * selected mark. Steppers and swatches, each step applied to the live page
 * and re-captured so the owner sees the effect; Undo and Reset. No number
 * field with units. A control that cannot produce the intended effect leaves
 * the comment as the request rather than changing something else.
 */
export interface VisualAdjustmentsProps {
  mark: VisualMarkView
  adjustments: VisualAdjustmentView[]
  /** Whether the live page is showing the adjustments right now, in plain words. */
  status: string
  busy: boolean
  canUndo: boolean
  onChange(next: VisualAdjustmentView[]): void
  onUndo(): void
  onReset(): void
}

export function VisualAdjustments({ mark, adjustments, status, busy, canUndo, onChange, onUndo, onReset }: VisualAdjustmentsProps) {
  const own = adjustmentsOn(adjustments, mark.id)
  const base = mark.identity?.style
  const set = (kind: AdjustmentKind, choice: { step: number } | { swatch: string }) => {
    const control = ADJUSTMENT_CONTROLS.find((candidate) => candidate.kind === kind)!
    onChange(withAdjustment(adjustments, mark.id, control.property, adjustmentFor(kind, mark.id, base, choice)))
  }
  return (
    <section className="visual-adjustments" aria-label="Adjustments">
      <header><strong>Adjustments</strong><small>{status}</small></header>
      {ADJUSTMENT_CONTROLS.map((control) => {
        const current = own.find((adjustment) => adjustment.property === control.property)
        if (control.control === 'stepper') {
          const step = stepOf(control.kind, current)
          return <div className="visual-adjustment" key={control.kind} data-kind={control.kind}>
            <span className="visual-adjustment-title">{control.title}</span>
            <button type="button" aria-label={`${control.title} less`} disabled={busy || step <= -STEP_RANGE} onClick={() => set(control.kind, { step: step - 1 })}>−</button>
            <output aria-label={`${control.title} now`}>{stepWord(control.kind, step)}</output>
            <button type="button" aria-label={`${control.title} more`} disabled={busy || step >= STEP_RANGE} onClick={() => set(control.kind, { step: step + 1 })}>+</button>
          </div>
        }
        const chosen = swatchOf(current)
        return <div className="visual-adjustment" key={control.kind} data-kind={control.kind}>
          <span className="visual-adjustment-title">{control.title}</span>
          <div className="visual-swatches" role="radiogroup" aria-label={control.title}>
            <button type="button" role="radio" aria-checked={chosen === null} aria-label={`${control.title} as is`} className="visual-swatch" data-as-is="" disabled={busy} onClick={() => onChange(withAdjustment(adjustments, mark.id, control.property, null))}>as is</button>
            {SWATCHES.map((swatch) => <button type="button" role="radio" key={swatch.value} aria-checked={chosen === swatch.value} aria-label={`${control.title} ${swatch.name}`} title={swatch.name} className="visual-swatch" style={{ '--swatch': swatch.value } as React.CSSProperties} disabled={busy} onClick={() => set(control.kind, { swatch: swatch.value })} />)}
          </div>
        </div>
      })}
      <footer>
        <button type="button" className="quiet-button" disabled={busy || !canUndo} onClick={onUndo}>Undo</button>
        <button type="button" className="quiet-button" disabled={busy || adjustments.length === 0} onClick={onReset}>Reset</button>
      </footer>
    </section>
  )
}
