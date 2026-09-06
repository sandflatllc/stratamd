import { describe, expect, it } from 'vitest'
import { ADJUSTMENT_CONTROLS, adjustmentFor, adjustmentsOn, stepOf, stepValue, stepWord, SWATCHES, swatchOf, withAdjustment } from '../../src/core/visual-adjustments'
import { applyOverridesScript, CLEAR_OVERRIDES_SCRIPT } from '../../src/main/preview/overrides'

/**
 * Adjustments (docs/plans/open/visual-review, phase 4): named steps from the
 * page's own value, recorded as the exact property and value with the
 * owner's words; overrides as one stylesheet Strata owns, removed whole.
 */
describe('adjustment steps', () => {
  it('names every control in plain words with no unit field', () => {
    expect(ADJUSTMENT_CONTROLS.map((control) => control.title)).toEqual(['Text size', 'Text weight', 'Text color', 'Background', 'Space inside', 'Corner rounding'])
    expect(stepWord('text-size', 1)).toBe('slightly larger')
    expect(stepWord('text-size', -3)).toBe('much smaller')
    expect(stepWord('space-inside', 2)).toBe('more')
    expect(stepWord('corner-rounding', -3)).toBe('square')
    expect(stepWord('text-size', 0)).toBe('as is')
  })

  it('moves from the computed value: an eighth per size step, a hundred per weight, 4 px of space or rounding', () => {
    const base = { 'font-size': '16px', 'font-weight': '400', padding: '8px 14px', 'border-radius': '8px' }
    expect(stepValue('text-size', base, 1)).toBe('18px')
    expect(stepValue('text-size', base, -2)).toBe('12px')
    expect(stepValue('text-weight', base, 2)).toBe('600')
    expect(stepValue('text-weight', { 'font-weight': 'bold' }, 1)).toBe('800')
    expect(stepValue('space-inside', base, 1)).toBe('12px 18px')
    expect(stepValue('space-inside', base, -3)).toBe('0px 2px')
    expect(stepValue('corner-rounding', base, 2)).toBe('16px')
    expect(stepValue('corner-rounding', base, -3)).toBe('0px')
    expect(stepValue('text-size', undefined, 1)).toBe('18px')
  })

  it('records property and value with the label, reads the step back from the label, and leaves the page as it is at zero', () => {
    const base = { 'font-size': '16px' }
    const larger = adjustmentFor('text-size', 'k1', base, { step: 1 })!
    expect(larger).toEqual({ markId: 'k1', property: 'font-size', value: '18px', label: 'Text size: slightly larger' })
    expect(stepOf('text-size', larger)).toBe(1)
    expect(adjustmentFor('text-size', 'k1', base, { step: 0 })).toBeNull()
    const blue = adjustmentFor('text-color', 'k1', base, { swatch: 'royalblue' })!
    expect(blue).toEqual({ markId: 'k1', property: 'color', value: 'royalblue', label: 'Text color: blue' })
    expect(swatchOf(blue)).toBe('royalblue')
    expect(adjustmentFor('background', 'k1', base, { swatch: 'plaid' })).toBeNull()
    expect(SWATCHES.every((swatch) => /^[a-z ]+$/.test(swatch.name))).toBe(true)
    // One adjustment per property on a mark; other marks keep theirs.
    const set = withAdjustment([larger, { markId: 'k2', property: 'font-size', value: '20px', label: 'Text size: larger' }], 'k1', 'font-size', adjustmentFor('text-size', 'k1', base, { step: 2 }))
    expect(adjustmentsOn(set, 'k1')).toEqual([{ markId: 'k1', property: 'font-size', value: '20px', label: 'Text size: larger' }])
    expect(adjustmentsOn(set, 'k2')).toHaveLength(1)
    expect(withAdjustment(set, 'k1', 'font-size', null).map((adjustment) => adjustment.markId)).toEqual(['k2'])
  })
})

describe('override scripts', () => {
  it('apply as one Strata-owned stylesheet with data-only inputs, and clear only Strata\'s own', () => {
    const script = applyOverridesScript([{ markId: 'k1', identity: { selector: 'button#new-client', testIds: ['new-client'], role: 'button', name: 'New client' }, declarations: { 'font-size': '18px', color: 'royalblue' } }])
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('data-strata-visual')
    expect(script).toContain('!important')
    const hostile = applyOverridesScript([{ markId: 'k1"]{}', identity: { selector: '</script>', testIds: [], role: null, name: null }, declarations: { 'font-size; background': 'url(x) }' } }])
    expect(() => new Function(hostile)).not.toThrow()
    expect(CLEAR_OVERRIDES_SCRIPT).toContain('[data-strata-visual="override"]')
    expect(CLEAR_OVERRIDES_SCRIPT).toContain('data-strata-target')
    expect(CLEAR_OVERRIDES_SCRIPT).not.toContain('style=')
  })
})
