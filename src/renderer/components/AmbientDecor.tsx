import { createContext, useContext, type CSSProperties } from 'react'
import type { AmbientStyle } from '../../shared/theme-keys'

// The ambient animation system from docs/design/animations-handoff.md.
// Two independent layers, page scale (behind the whole app) and card scale (inside
// each island), each one of eight styles. Every element, placement, size, opacity,
// duration, and delay below is the handoff's; colors come from the theme's five
// `effects` slots so a theme recolors the animation without owning any of its
// geometry. Only transform, opacity, and background-position animate; blurs are
// static. Each colored element carries its slot so the theme panel can isolate it.

export type AmbientScale = 'page' | 'card'
export type AmbientIsland = 'explorer' | 'editor' | 'changes' | 'annotations' | 'agents'
const ISLANDS: readonly AmbientIsland[] = ['explorer', 'editor', 'changes', 'annotations', 'agents']

/** `bright` is not a theme slot: it derives from the interface text color. */
type EffectSlot = 'primary' | 'secondary' | 'tertiary' | 'detail-1' | 'detail-2' | 'bright'

export interface AmbientElement {
  readonly kind: 'wash' | 'dot' | 'glow' | 'band' | 'grid' | 'tint' | 'star'
  readonly style: CSSProperties
  /** The theme's effect slot this element takes its color from, if any. */
  readonly slot?: Exclude<EffectSlot, 'bright'>
  /**
   * Split elements keep expensive paint (blur, pattern) on an inner span so
   * the compositor animates a cached texture: glows animate the outer and
   * blur the inner; grids mask the outer and pan the inner.
   */
  readonly inner?: CSSProperties
}

/** An effect color at an opacity, scaled by the theme's intensity. */
function tint(slot: EffectSlot, alpha: number): string {
  const variable = slot === 'bright' ? 'var(--interface-primary)' : `var(--effects-${slot})`
  return `color-mix(in srgb, ${variable} calc(${Math.round(alpha * 1000) / 10}% * var(--effects-intensity)), transparent)`
}

/** A light version of an effect color, for stars. */
function light(slot: EffectSlot): string {
  return slot === 'bright' ? 'var(--interface-primary)' : `color-mix(in srgb, var(--effects-${slot}) 45%, var(--interface-primary))`
}

function marked(slot: EffectSlot): { slot?: Exclude<EffectSlot, 'bright'> } {
  return slot === 'bright' ? {} : { slot }
}

function seconds(value: number): string {
  return `calc(${value}s / var(--effects-speed))`
}

function animation(name: string, duration: number, delay = 0, extra = ''): CSSProperties {
  return {
    animationName: name,
    animationDuration: seconds(duration),
    animationDelay: seconds(delay),
    animationIterationCount: 'infinite',
    animationTimingFunction: name === 'ambient-rise' || name === 'ambient-grid' ? 'linear' : 'ease-in-out',
    ...(extra ? { animationDirection: extra } : {})
  }
}

function dot(size: number, slot: EffectSlot, alpha: number, place: CSSProperties, name: string, duration: number, delay = 0, direction = ''): AmbientElement {
  return { kind: 'dot', ...marked(slot), style: { ...place, width: size, height: size, borderRadius: '50%', background: tint(slot, alpha), ...animation(name, duration, delay, direction) } }
}

// Measured 2026-08-30: splitting the blur onto an inner element does not
// avoid per-frame re-filtering — the scale animation changes raster scale
// regardless — so glows stay single elements and keep their blur cost.
function glow(size: number | string, slot: EffectSlot, alpha: number, blur: number, place: CSSProperties, name: string, duration: number, delay = 0, direction = '', shape: 'circle' | 'ellipse' = 'circle', stop = '70%'): AmbientElement {
  const width = typeof size === 'number' ? size : size.split('x')[0]
  const height = typeof size === 'number' ? size : size.split('x')[1]
  return { kind: 'glow', ...marked(slot), style: { ...place, width, height, borderRadius: '50%', background: `radial-gradient(${shape}, ${tint(slot, alpha)}, transparent ${stop})`, filter: `blur(${blur}px)`, ...animation(name, duration, delay, direction) } }
}

function star(top: number, left: number, size: number, slot: EffectSlot, duration: number, delay: number): AmbientElement {
  return { kind: 'star', ...marked(slot), style: { top: `${top}%`, left: `${left}%`, width: size, height: size, borderRadius: '50%', background: light(slot), ...animation('ambient-twinkle', duration, delay) } }
}

// The gradient spans a 300%-sized element panned by transform; offsets match
// the former background-position shift on a 300% background-size exactly.
const wash = (): AmbientElement => ({
  kind: 'wash',
  slot: 'primary',
  style: {
    top: 0,
    left: 0,
    width: '300%',
    height: '300%',
    background: `linear-gradient(120deg, ${tint('primary', 0.08)}, ${tint('tertiary', 0.05)} 30%, ${tint('secondary', 0.07)} 60%, ${tint('detail-2', 0.05)})`,
    ...animation('ambient-wash-drift', 34)
  }
})

// ---- Page scale, per the handoff's "Variants — background scale".

const PAGE: Record<AmbientStyle, () => AmbientElement[]> = {
  'rising-motes': () => [
    wash(),
    dot(9, 'tertiary', 0.4, { bottom: -20, left: 9 }, 'ambient-rise', 26),
    dot(6, 'detail-1', 0.35, { bottom: -20, left: 11 }, 'ambient-rise', 33, 11),
    dot(8, 'detail-2', 0.35, { bottom: -20, left: 247 }, 'ambient-rise', 29, 5),
    dot(5, 'primary', 0.4, { bottom: -20, left: 243 }, 'ambient-rise', 24, 16),
    dot(7, 'secondary', 0.35, { bottom: -20, left: '52%' }, 'ambient-rise', 31, 8),
    dot(10, 'detail-1', 0.28, { bottom: -20, left: '70%' }, 'ambient-rise', 27, 19),
    dot(7, 'tertiary', 0.32, { bottom: -20, right: 330 }, 'ambient-rise', 30, 3),
    dot(9, 'primary', 0.38, { bottom: -20, right: 10 }, 'ambient-rise', 25, 14),
    dot(6, 'detail-2', 0.32, { bottom: -20, right: 13 }, 'ambient-rise', 35, 7)
  ],
  'aurora-drift': () => [
    glow('70%x85%', 'primary', 0.13, 60, { top: '-30%', left: '-12%' }, 'ambient-aurora-a', 26, 0, '', 'ellipse', '65%'),
    glow('65%x80%', 'secondary', 0.11, 60, { top: '-22%', right: '-15%' }, 'ambient-aurora-b', 31, 4, '', 'ellipse', '65%'),
    glow('62%x85%', 'tertiary', 0.09, 70, { bottom: '-38%', left: '18%' }, 'ambient-aurora-a', 36, 9, 'reverse', 'ellipse', '65%')
  ],
  starfield: () => [
    star(8, 6, 3, 'primary', 4.2, 0), star(14, 38, 2, 'bright', 3.6, 1.1), star(5, 62, 3, 'secondary', 5.0, 0.4), star(20, 84, 2, 'bright', 3.4, 2.2),
    star(34, 14, 2, 'tertiary', 4.6, 0.8), star(42, 52, 3, 'bright', 3.9, 1.7), star(38, 93, 2, 'primary', 5.2, 2.9), star(58, 8, 3, 'secondary', 4.4, 0.2),
    star(66, 34, 2, 'bright', 3.5, 2.5), star(72, 68, 3, 'detail-1', 4.8, 1.4), star(84, 22, 2, 'bright', 3.7, 3.1), star(88, 78, 2, 'primary', 4.1, 0.6),
    star(52, 76, 2, 'detail-2', 4.9, 1.9), star(26, 26, 2, 'bright', 3.8, 2.7)
  ],
  'grid-drift': () => [{
    kind: 'grid',
    slot: 'primary',
    style: {
      inset: 0,
      maskImage: 'radial-gradient(1000px 640px at 50% 38%, black, transparent 82%)',
      WebkitMaskImage: 'radial-gradient(1000px 640px at 50% 38%, black, transparent 82%)',
    },
    // Overhangs one tile period top-left so the pan never exposes an edge.
    inner: {
      inset: '-56px 0 0 -56px',
      backgroundImage: `linear-gradient(${tint('primary', 0.055)} 1px, transparent 1px), linear-gradient(90deg, ${tint('primary', 0.055)} 1px, transparent 1px)`,
      backgroundSize: '56px 56px',
      ...animation('ambient-grid', 14)
    }
  }],
  'glow-orbs': () => [
    glow(560, 'primary', 0.1, 40, { top: -120, right: '4%' }, 'ambient-glow-1', 24),
    glow(620, 'tertiary', 0.08, 46, { bottom: -160, left: '2%' }, 'ambient-glow-2', 29, 3),
    glow(380, 'secondary', 0.07, 40, { top: '38%', left: '40%' }, 'ambient-glow-3', 33, 6),
    dot(7, 'detail-1', 0.2, { top: '22%', left: '10%' }, 'ambient-mote-wander', 19),
    dot(8, 'detail-2', 0.16, { top: '68%', right: '14%' }, 'ambient-mote-wander', 23, 5, 'reverse')
  ],
  'shimmer-sweep': () => [{
    kind: 'band',
    slot: 'primary',
    style: {
      top: 0, bottom: 0, left: 0, width: '40%',
      background: `linear-gradient(105deg, transparent, ${tint('primary', 0.05)} 45%, ${tint('bright', 0.04)} 50%, ${tint('primary', 0.05)} 55%, transparent)`,
      ...animation('ambient-sweep', 16)
    }
  }],
  'breathing-tint': () => [{
    kind: 'tint',
    slot: 'primary',
    style: { inset: 0, background: `radial-gradient(120% 90% at 50% -15%, ${tint('primary', 0.09)}, transparent 60%)`, ...animation('ambient-breathe', 8) }
  }],
  none: () => []
}

// ---- Card scale, per the handoff's "Variants — window (per-panel) scale".
// Where a style repeats across islands, durations and delays vary per island so
// islands never move in lockstep.

function stagger(island: AmbientIsland): { duration: (base: number) => number; delay: (base: number) => number } {
  const index = ISLANDS.indexOf(island)
  return { duration: (base) => Math.round(base * (1 + index * 0.07) * 10) / 10, delay: (base) => Math.round((base + index * 1.3) * 10) / 10 }
}

const CARD_GLOW_ORBS: Record<AmbientIsland, AmbientElement[]> = {
  explorer: [
    glow(200, 'detail-2', 0.12, 22, { bottom: -60, left: -50 }, 'ambient-inner-a', 14),
    glow(150, 'primary', 0.1, 20, { top: '30%', right: -40 }, 'ambient-inner-b', 18, 2),
    dot(5, 'detail-1', 0.3, { top: '58%', left: 24 }, 'ambient-mote-wander', 16)
  ],
  editor: [
    glow(460, 'primary', 0.09, 34, { top: -100, right: -80 }, 'ambient-glow-1', 22),
    glow(520, 'tertiary', 0.07, 40, { bottom: -140, left: -90 }, 'ambient-glow-2', 27, 3),
    glow(300, 'secondary', 0.06, 34, { top: '44%', left: '34%' }, 'ambient-glow-3', 31, 6),
    dot(6, 'detail-1', 0.18, { top: '24%', left: '12%' }, 'ambient-mote-wander', 19),
    dot(8, 'detail-2', 0.15, { top: '66%', right: '16%' }, 'ambient-mote-wander', 23, 5, 'reverse'),
    dot(5, 'tertiary', 0.18, { top: '82%', left: '56%' }, 'ambient-mote-wander', 17, 9)
  ],
  changes: [
    glow(190, 'primary', 0.12, 20, { top: -50, right: -60 }, 'ambient-inner-b', 15),
    dot(5, 'tertiary', 0.28, { bottom: 14, left: 20 }, 'ambient-mote-wander', 18, 4)
  ],
  annotations: [
    glow(180, 'detail-1', 0.1, 20, { bottom: -60, left: -50 }, 'ambient-inner-a', 17, 2),
    dot(5, 'secondary', 0.3, { top: 20, right: 24 }, 'ambient-mote-wander', 20, 0, 'reverse')
  ],
  agents: [
    glow(170, 'secondary', 0.11, 18, { top: -40, left: -50 }, 'ambient-inner-b', 16, 5),
    dot(6, 'detail-2', 0.28, { right: 30, bottom: 18 }, 'ambient-mote-wander', 21, 7)
  ]
}

const CARD: Record<AmbientStyle, (island: AmbientIsland) => AmbientElement[]> = {
  'rising-motes': (island) => {
    const { duration, delay } = stagger(island)
    return [
      dot(3, 'tertiary', 0.35, { bottom: -12, left: '12%' }, 'ambient-rise', duration(14), delay(0)),
      dot(4, 'detail-1', 0.3, { bottom: -12, left: '34%' }, 'ambient-rise', duration(16), delay(5)),
      dot(5, 'primary', 0.35, { bottom: -12, left: '58%' }, 'ambient-rise', duration(18), delay(9)),
      dot(4, 'secondary', 0.3, { bottom: -12, left: '78%' }, 'ambient-rise', duration(15), delay(2)),
      dot(3, 'detail-2', 0.3, { bottom: -12, left: '90%' }, 'ambient-rise', duration(17), delay(12))
    ]
  },
  'aurora-drift': (island) => {
    const { duration, delay } = stagger(island)
    return [
      glow('75%x90%', 'primary', 0.14, 28, { top: '-40%', left: '-15%' }, 'ambient-aurora-a', duration(18), delay(0), '', 'ellipse', '65%'),
      glow('70%x90%', 'secondary', 0.11, 28, { bottom: '-40%', right: '-15%' }, 'ambient-aurora-b', duration(23), delay(3), '', 'ellipse', '65%')
    ]
  },
  starfield: (island) => {
    const { duration, delay } = stagger(island)
    return [
      star(12, 10, 3, 'primary', duration(4.2), delay(0)), star(22, 68, 2, 'bright', duration(3.6), delay(0.9)), star(44, 30, 3, 'secondary', duration(5), delay(0.3)),
      star(60, 82, 2, 'bright', duration(3.4), delay(1.8)), star(76, 18, 2, 'tertiary', duration(4.6), delay(0.6)), star(86, 58, 2, 'primary', duration(4.1), delay(2.6)),
      star(34, 90, 3, 'detail-1', duration(4.8), delay(1.2))
    ]
  },
  'grid-drift': (island) => {
    const { duration } = stagger(island)
    return [{
      kind: 'grid',
      slot: 'primary',
      style: {
        inset: 0,
        maskImage: 'radial-gradient(80% 70% at 50% 40%, black, transparent 90%)',
        WebkitMaskImage: 'radial-gradient(80% 70% at 50% 40%, black, transparent 90%)',
      },
      inner: {
        inset: '-36px 0 0 -36px',
        backgroundImage: `linear-gradient(${tint('primary', 0.06)} 1px, transparent 1px), linear-gradient(90deg, ${tint('primary', 0.06)} 1px, transparent 1px)`,
        backgroundSize: '36px 36px',
        ...animation('ambient-grid-card', duration(12))
      }
    }]
  },
  'glow-orbs': (island) => CARD_GLOW_ORBS[island],
  'shimmer-sweep': (island) => {
    const { duration, delay } = stagger(island)
    return [{
      kind: 'band',
      slot: 'primary',
      style: {
        top: 0, bottom: 0, left: 0, width: '46%',
        background: `linear-gradient(105deg, transparent, ${tint('primary', 0.06)} 45%, ${tint('bright', 0.05)} 50%, ${tint('primary', 0.06)} 55%, transparent)`,
        ...animation('ambient-sweep', duration(11), delay(0))
      }
    }]
  },
  'breathing-tint': (island) => {
    const { duration, delay } = stagger(island)
    return [{ kind: 'tint', slot: 'primary', style: { inset: 0, background: `radial-gradient(130% 100% at 50% -10%, ${tint('primary', 0.1)}, transparent 62%)`, ...animation('ambient-breathe', duration(7), delay(0)) } }]
  },
  none: () => []
}

/** The handoff's `renderAmbient(style, scale)`: the element tree for one layer. */
export function renderAmbient(style: AmbientStyle, scale: AmbientScale, island: AmbientIsland = 'editor'): AmbientElement[] {
  return scale === 'page' ? PAGE[style]() : CARD[style](island)
}

export interface AmbientChoice {
  readonly background: AmbientStyle
  readonly windows: AmbientStyle
}

export const AmbientContext = createContext<AmbientChoice>({ background: 'rising-motes', windows: 'glow-orbs' })

function Layer({ elements, className }: { elements: AmbientElement[]; className: string }) {
  return (
    <div className={className} aria-hidden="true">
      {elements.map((element, index) => (
        <i className={`ambient-${element.kind}`} data-effect-slot={element.slot} style={element.style} key={index}>
          {element.inner ? <span style={element.inner} /> : null}
        </i>
      ))}
    </div>
  )
}

/** The page-scale layer, directly inside the app shell behind all content. */
export function AmbientBackground() {
  const { background } = useContext(AmbientContext)
  return <Layer className={`ambient-page ambient-page-${background}`} elements={renderAmbient(background, 'page')} />
}

/** The card-scale layer inside one island. */
export function AmbientDecor({ variant }: { variant: AmbientIsland }) {
  const { windows } = useContext(AmbientContext)
  return <Layer className={`ambient-layer ambient-layer-${variant} ambient-layer-${windows}`} elements={renderAmbient(windows, 'card', variant)} />
}
