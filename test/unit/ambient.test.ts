import { describe, expect, it } from 'vitest'
import { renderAmbient, type AmbientIsland } from '../../src/renderer/components/AmbientDecor'
import { AMBIENT_STYLES } from '../../src/shared/theme-keys'

// Element counts per style and scale from docs/design/animations-handoff.md.
const PAGE_COUNTS = { 'rising-motes': 10, 'aurora-drift': 3, starfield: 14, 'grid-drift': 1, 'glow-orbs': 5, 'shimmer-sweep': 1, 'breathing-tint': 1, none: 0 }
const CARD_COUNTS = { 'rising-motes': 5, 'aurora-drift': 2, starfield: 7, 'grid-drift': 1, 'shimmer-sweep': 1, 'breathing-tint': 1, none: 0 }
const GLOW_ORB_COUNTS: Record<AmbientIsland, number> = { explorer: 3, editor: 6, changes: 2, annotations: 2, agents: 2 }

describe('ambient factory', () => {
  it('renders the handoff element counts for every style at both scales', () => {
    for (const { id } of AMBIENT_STYLES) {
      expect(renderAmbient(id, 'page')).toHaveLength(PAGE_COUNTS[id])
      if (id !== 'glow-orbs') expect(renderAmbient(id, 'card', 'changes')).toHaveLength(CARD_COUNTS[id])
    }
    for (const island of Object.keys(GLOW_ORB_COUNTS) as AmbientIsland[]) expect(renderAmbient('glow-orbs', 'card', island)).toHaveLength(GLOW_ORB_COUNTS[island])
  })

  it('mixes every color from the five effect slots scaled by intensity and every duration by speed', () => {
    for (const element of [...renderAmbient('rising-motes', 'page'), ...renderAmbient('starfield', 'card', 'agents')]) {
      const text = JSON.stringify({ ...element.style, ...element.inner })
      expect(text).toMatch(/var\(--(?:effects-(?:primary|secondary|tertiary|detail-1|detail-2)|interface-primary)\)/)
      expect(text).not.toMatch(/#[0-9a-f]{6}|rgba?\(/i)
      expect(element.style.animationDuration ?? element.inner?.animationDuration).toMatch(/^calc\([\d.]+s \/ var\(--effects-speed\)\)$/)
    }
    const firstGlow = renderAmbient('glow-orbs', 'page')[0]!
    expect(JSON.stringify({ ...firstGlow.style, ...firstGlow.inner })).toContain('* var(--effects-intensity)')
  })

  it('references only effect slots, never control, change, or people colors, and marks each colored element with its slot', () => {
    for (const { id } of AMBIENT_STYLES) {
      for (const scale of ['page', 'card'] as const) {
        for (const element of renderAmbient(id, scale, 'editor')) {
          const text = JSON.stringify({ ...element.style, ...element.inner })
          expect(text).not.toMatch(/var\(--(?:controls|changes|people)-/)
          const colored = /var\(--effects-(?:primary|secondary|tertiary|detail-1|detail-2)\)/.test(text)
          if (colored) expect(element.slot, `${id}/${scale}`).toMatch(/^(?:primary|secondary|tertiary|detail-1|detail-2)$/)
        }
      }
    }
  })

  it('staggers a repeated window style so islands never move in lockstep', () => {
    const durations = (['explorer', 'editor', 'changes'] as const).map((island) => renderAmbient('shimmer-sweep', 'card', island)[0]!.style.animationDuration)
    expect(new Set(durations).size).toBe(3)
  })
})
