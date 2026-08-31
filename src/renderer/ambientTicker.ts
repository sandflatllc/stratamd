/**
 * Drive every ambient CSS animation on a coarser clock than the display
 * refresh. The compositor redraws — and re-filters the blurred glow
 * surfaces — only when animation state changes, so ticking at 30 Hz instead
 * of e.g. 144 Hz cuts the whole idle pipeline proportionally (measured in
 * docs/plans/open/performance-plan.md item 5: default pair 2.69% to 0.96% of one core).
 *
 * Pausing an animation and advancing its currentTime replays the exact same
 * keyframes, easing, duration, and theme speed variable; only the sampling
 * cadence changes. The slowest ambient drifts move well under 2 px per tick
 * at 30 Hz. Typing freezes the clock, taking over the former
 * `animation-play-state` rule's duty from PRD §6.12 (motion pauses while
 * keystrokes arrive); the elapsed time accumulates only while not typing, so
 * motion resumes where it stopped instead of jumping.
 */

const TICK_HZ = 30

interface Adopted {
  base: number
  adoptedAt: number
}

export function startAmbientTicker(doc: Document = document): () => void {
  const adopted = new WeakMap<Animation, Adopted>()
  let activeMs = 0
  let last = performance.now()
  const interval = window.setInterval(() => {
    const now = performance.now()
    const delta = now - last
    last = now
    const typing = doc.documentElement.getAttribute('data-typing') === 'true'
    if (!typing) activeMs += delta
    for (const animation of doc.getAnimations()) {
      const name = (animation as CSSAnimation).animationName
      if (typeof name !== 'string' || !name.startsWith('ambient-')) continue
      let entry = adopted.get(animation)
      if (!entry) {
        animation.pause()
        entry = { base: Number(animation.currentTime ?? 0), adoptedAt: activeMs }
        adopted.set(animation, entry)
      }
      if (!typing) animation.currentTime = entry.base + (activeMs - entry.adoptedAt)
    }
  }, 1000 / TICK_HZ)
  return () => window.clearInterval(interval)
}
