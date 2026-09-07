import { useEffect, useRef } from 'react'
import { cloudTexture } from '../ambient/cloudTexture'
import { createCanvasSkyRenderer } from '../ambient/canvasSkyRenderer'
import { createSkyRenderer, type SkyRenderer } from '../ambient/skyRenderer'
import { EFFECT_SLOTS, type SkyFrame } from '../ambient/sceneData'

/** Canvas lifecycle is independent of React renders and the CSS animation ticker. */
export function ClusteredSky({ smoke, className }: { smoke: boolean; className: string }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = host.current
    const shell = element?.closest<HTMLElement>('.app-shell')
    if (!element || !shell) return
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    let canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true'); element.append(canvas)
    let renderer: SkyRenderer | null = null, disposed = false, lost = false, intersecting = true, requestedCloud = false, unsupported = false
    let timer = 0, animationFrame = 0, refreshFrame = 0, last = 0, active = false, speed = 1
    let transcript: Element | null = null, lastAppearance = ''
    const frame: SkyFrame = { width: 0, height: 0, dpr: 1, time: 0, intensity: 1, palette: [], occlusion: [0, 0, 0, 0], highlight: -1 }
    const stop = () => {
      window.clearTimeout(timer); cancelAnimationFrame(animationFrame)
      timer = animationFrame = 0; last = 0; active = false
    }
    const draw = () => { if (renderer && frame.width > 0 && frame.height > 0 && !lost) renderer.draw(frame) }
    // Wake once per 30 Hz frame, rather than visiting every 120/144 Hz display tick.
    function tick(now: number) {
      if (!active || disposed) return
      if (document.hidden || reducedMotion.matches || document.documentElement.dataset.typing === 'true') { stop(); return }
      if (last) frame.time += Math.min((now - last) / 1000, .1) * speed
      last = now; draw()
      timer = window.setTimeout(() => { animationFrame = requestAnimationFrame(tick) }, Math.max(0, 1000 / 30 - (performance.now() - now)))
    }
    function receiveCloud() {
      if (!smoke || requestedCloud || !renderer) return
      requestedCloud = true
      void cloudTexture().then(texture => {
        if (disposed || !renderer || lost) return
        renderer.cloud(texture); lastAppearance = ''; scheduleRefresh()
      }).catch(error => console.warn('Could not load the nebula texture', error))
    }
    function contextLost(event: Event) { event.preventDefault(); lost = true; stop() }
    function contextRestored() {
      lost = false; renderer?.dispose(); renderer = null; requestedCloud = false; scheduleRefresh()
    }
    function initRenderer() {
      renderer = createSkyRenderer(canvas)
      if (!renderer) {
        // A canvas that acquired WebGL cannot subsequently acquire 2D.
        canvas.remove(); canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true'); element!.append(canvas)
        renderer = createCanvasSkyRenderer(canvas)
        // With neither context the sky stays empty; trying again on the next mutation would swap canvases forever.
        if (renderer) canvas.dataset.skyRenderer = 'canvas'
        else { unsupported = true; stop() }
      } else {
        canvas.dataset.skyRenderer = 'webgl'
        canvas.addEventListener('webglcontextlost', contextLost)
        canvas.addEventListener('webglcontextrestored', contextRestored)
      }
      receiveCloud()
    }
    // The transcript this layer skips: the centered one when both placements are open, else the first.
    const findTranscript = () => {
      const scope = element!.parentElement!
      return scope.querySelector('.conversation-panel[data-placement="center"] .conversation-messages') ?? scope.querySelector('.conversation-messages')
    }
    function refresh() {
      refreshFrame = 0
      if (disposed) return
      // The cheap gates come before any layout read: a hidden, paused, or offscreen sky costs nothing per mutation.
      if (!(shell!.dataset.motion === 'true' && !document.hidden && !reducedMotion.matches && intersecting)) { stop(); return }
      const bounds = element!.getBoundingClientRect()
      frame.width = element!.clientWidth; frame.height = element!.clientHeight; frame.dpr = Math.min(devicePixelRatio || 1, 2)
      const style = getComputedStyle(shell!)
      frame.palette = EFFECT_SLOTS.map(slot => {
        const hex = style.getPropertyValue(`--effects-${slot}`).trim().replace('#', '')
        return [0, 2, 4].map(offset => (parseInt(hex.slice(offset, offset + 2), 16) || 0) / 255) as [number, number, number]
      })
      frame.intensity = Math.max(0, Math.min(2, Number(style.getPropertyValue('--effects-intensity')) || 0))
      speed = Math.max(.25, Math.min(2, Number(style.getPropertyValue('--effects-speed')) || 1))
      frame.highlight = EFFECT_SLOTS.findIndex(slot => shell!.dataset.themeHighlight === `effects-${slot}`)
      // Observe only the transcript belonging to this layer's island. Page effects
      // can also skip a transcript, though the opaque island already covers it.
      const next = findTranscript()
      if (next !== transcript) {
        if (transcript) resize.unobserve(transcript)
        transcript = next
        if (transcript) resize.observe(transcript)
      }
      frame.occlusion = [0, 0, 0, 0]
      if (transcript && shell!.dataset.transcriptStyle === 'panel') {
        const rect = transcript.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 28) {
          const xScale = frame.width / bounds.width, yScale = frame.height / bounds.height
          // Leave both 14px corner bands painted; the skipped rectangle must
          // stay inside the opaque panel, including at its rounded top edge.
          frame.occlusion = [(rect.left - bounds.left + 1) * xScale, (rect.top - bounds.top + 14) * yScale, (rect.right - bounds.left - 1) * xScale, (rect.bottom - bounds.top - 14) * yScale]
        }
      }
      const visible = shell!.dataset.motion === 'true' && !document.hidden && !reducedMotion.matches && intersecting && bounds.width > 0 && bounds.height > 0 && frame.intensity > 0
      if (!visible || lost) { stop(); if (frame.intensity === 0 && renderer && !lost) draw(); return }
      if (!renderer && !unsupported) initRenderer()
      if (!renderer) return
      // React can mutate transcript text many times per second. Those mutations
      // must not force additional canvas frames or redraw an unchanged paused sky.
      const appearance = JSON.stringify([frame.width, frame.height, frame.dpr, frame.palette, frame.intensity, frame.highlight, frame.occlusion])
      if (!active && appearance !== lastAppearance) draw()
      lastAppearance = appearance
      if (document.documentElement.dataset.typing === 'true') { stop(); return }
      if (!active) { active = true; last = 0; animationFrame = requestAnimationFrame(tick) }
    }
    function scheduleRefresh() { if (!disposed && !refreshFrame) refreshFrame = requestAnimationFrame(refresh) }
    const resize = new ResizeObserver(scheduleRefresh)
    resize.observe(element); resize.observe(shell)
    const intersection = new IntersectionObserver(entries => { intersecting = entries[0]?.isIntersecting ?? false; scheduleRefresh() })
    intersection.observe(element)
    const themeChanges = new MutationObserver(scheduleRefresh)
    themeChanges.observe(shell, { attributes: true, attributeFilter: ['style', 'data-motion', 'data-transcript-style', 'data-theme-highlight'] })
    // The page layer's parent is the whole shell; a mutation there matters only when it changed which transcript exists.
    const layoutChanges = new MutationObserver(() => { if (findTranscript() !== transcript) scheduleRefresh() })
    layoutChanges.observe(element.parentElement!, { childList: true, subtree: true })
    const typing = new MutationObserver(scheduleRefresh)
    typing.observe(document.documentElement, { attributes: true, attributeFilter: ['data-typing'] })
    document.addEventListener('visibilitychange', scheduleRefresh)
    window.addEventListener('resize', scheduleRefresh)
    reducedMotion.addEventListener('change', scheduleRefresh)
    refresh()
    return () => {
      disposed = true; stop(); cancelAnimationFrame(refreshFrame)
      resize.disconnect(); intersection.disconnect(); themeChanges.disconnect(); layoutChanges.disconnect(); typing.disconnect()
      document.removeEventListener('visibilitychange', scheduleRefresh); window.removeEventListener('resize', scheduleRefresh)
      reducedMotion.removeEventListener('change', scheduleRefresh)
      canvas.removeEventListener('webglcontextlost', contextLost); canvas.removeEventListener('webglcontextrestored', contextRestored)
      renderer?.dispose()
      if (canvas.dataset.skyRenderer === 'webgl') canvas.getContext('webgl')?.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove(); canvas.width = canvas.height = 0
    }
  }, [smoke])
  return <div ref={host} className={`${className} ambient-clustered-sky`} aria-hidden="true" />
}
