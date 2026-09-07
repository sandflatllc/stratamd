/** The seeded composition approved in the Stars + smoke motion study. */
export interface SkyStar {
  x: number
  y: number
  radius: number
  alpha: number
  phase: number
  color: number
  depth: number
  core: boolean
}

export function seededRandom() {
  let seed = 873
  return () => { seed = seed * 16807 % 2147483647; return (seed - 1) / 2147483646 }
}

export function createStars(): SkyStar[] {
  const random = seededRandom()
  // The study generated its noise table before placing stars.
  for (let i = 0; i < 65536; i++) random()
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(random(), .00001))) * Math.cos(6.2832 * random())
  const stars: SkyStar[] = []
  const add = (x: number, y: number, radius: number, alpha: number) => {
    const index = stars.length
    stars.push({ x, y, radius, alpha, color: index % 5, phase: index, depth: index % 9 === 0 ? 1.7 : 1, core: false })
    random() // Preserve the study's warm/cool selection in its random sequence.
  }
  for (let i = 0; i < 1200; i++) add(random(), random(), .20 + Math.pow(random(), 1.7) * .67, .14 + random() * .40)
  const clusters = [[.10, .23, .029, .073, 350], [.085, .66, .04, .1, 310], [.90, .25, .042, .09, 300], [.91, .72, .04, .084, 380], [.36, .11, .07, .045, 220], [.58, .84, .08, .07, 270], [.68, .40, .044, .1, 240], [.36, .50, .05, .09, 240]] as const
  for (const [x, y, rx, ry, count] of clusters) {
    for (let i = 0; i < count; i++) {
      const spread = random() > .74 ? 2.6 : 1
      add(x + gaussian() * rx * spread, y + gaussian() * ry * spread, .24 + Math.pow(random(), 2) * .82, .20 + random() * .58)
    }
  }
  const cores = [[.11, .26, 2.1], [.085, .31, 1.6], [.912, .70, 2], [.887, .74, 1.4], [.055, .62, 1.5], [.125, .70, 1.15], [.914, .22, 1.65], [.867, .30, 1.05], [.965, .61, 1.3], [.06, .12, 1.15], [.37, .1, 1.5], [.57, .88, 1.3], [.72, .38, 1.8], [.39, .56, 1.45], [.042, .76, 1.1], [.142, .45, 1], [.961, .15, 1.25], [.844, .82, 1.1]] as const
  cores.forEach(([x, y, radius], color) => stars.push({ x, y, radius, alpha: 1, phase: random() * 6.28, color: color % 5, depth: 1.7, core: true }))
  return stars.sort((a, b) => a.depth - b.depth)
}

export const EFFECT_SLOTS = ['primary', 'secondary', 'tertiary', 'detail-1', 'detail-2'] as const
export type SkyPalette = readonly (readonly [number, number, number])[]
export interface SkyFrame {
  width: number
  height: number
  dpr: number
  time: number
  intensity: number
  palette: SkyPalette
  /** Opaque transcript interior, in CSS pixels. Rounded corners remain rendered. */
  occlusion: readonly [number, number, number, number]
  highlight: number
}
