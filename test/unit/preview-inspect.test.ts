import { describe, expect, it } from 'vitest'
import { CLEAR_STRATA_SCRIPT, describeScript, locateScript, outlineScript, RELEVANT_STYLE, scrollScript } from '../../src/main/preview/inspect'
import { toCaptureRect, toPagePoint, toPageRect, visualSendRefusal } from '../../src/core/visual-comments'

/**
 * Marking up a running page (docs/plans/open/visual-review, phase 3): the
 * one-shot page queries are strings run inside the page; they carry no Strata
 * copy, embed their inputs safely, and the pure helpers around them map
 * pixels and word the refusal.
 */
describe('the page scripts', () => {
  it('carry no Strata interface into the page and embed their inputs as data', () => {
    const scripts = [describeScript({ point: { x: 10, y: 20 } }), describeScript({ rect: { x: 1, y: 2, width: 30, height: 40 } }), locateScript({ selector: 'button#save', testIds: ['save'], role: 'button', name: 'Save' }), outlineScript({ selector: null, testIds: [], role: 'link', name: 'Home' }, 2_000), scrollScript({ by: { x: 0, y: 300 } }), scrollScript({ to: { x: 0, y: 0 } }), CLEAR_STRATA_SCRIPT]
    for (const script of scripts) {
      expect(script).not.toMatch(/What should change|Send now|Hold|visual-card|visual-palette/)
      expect(() => new Function(script)).not.toThrow()
    }
    // A hostile name or selector is data, never code.
    const hostile = locateScript({ selector: '</script><script>alert(1)</script>', testIds: ['"); alert(1); ("'], role: null, name: 'x`${y}`' })
    expect(hostile).toContain(JSON.stringify('</script><script>alert(1)</script>'))
    expect(() => new Function(hostile)).not.toThrow()
  })

  it('describes with a bounded set of style properties and a short-lived outline', () => {
    expect(RELEVANT_STYLE.length).toBeLessThanOrEqual(16)
    expect(RELEVANT_STYLE).toContain('font-size')
    expect(outlineScript({ selector: 'a', testIds: [], role: null, name: null }, 1500.6)).toContain('1501')
    expect(CLEAR_STRATA_SCRIPT).toContain('[data-strata-visual="outline"]')
  })
})

describe('page pixels and the refusal before Send', () => {
  it('maps between capture pixels and page pixels by the capture scale', () => {
    expect(toCaptureRect({ x: 10, y: 20, width: 30, height: 40 }, 0.5)).toEqual({ x: 5, y: 10, width: 15, height: 20 })
    expect(toPageRect({ x: 5, y: 10, width: 15, height: 20 }, 0.5)).toEqual({ x: 10, y: 20, width: 30, height: 40 })
    expect(toPagePoint({ x: 5, y: 10 }, 0.5)).toEqual({ x: 10, y: 20 })
    expect(toPageRect({ x: 5, y: 10, width: 15, height: 20 }, 0)).toEqual({ x: 5, y: 10, width: 15, height: 20 })
  })

  it('refuses only a replaced page or a missing target, naming the marks in plain words', () => {
    expect(visualSendRefusal({ pageReplaced: false, missing: [] })).toBeNull()
    expect(visualSendRefusal({ pageReplaced: true, missing: ['New client button'] })).toBe('The page has moved on since you marked it. Your note and marks are kept; mark the page again to send.')
    expect(visualSendRefusal({ pageReplaced: false, missing: ['New client button'] })).toBe('New client button is no longer on the page. Your note and marks are kept; remove that mark or mark the page again to send.')
    expect(visualSendRefusal({ pageReplaced: false, missing: ['Table header', 'New client button'] })).toBe('Table header and New client button are no longer on the page. Your note and marks are kept; remove those marks or mark the page again to send.')
  })
})
