import type { CloudTexture } from './cloudTexture'
import { createStars, type SkyFrame, type SkyStar } from './sceneData'
import type { SkyRenderer } from './skyRenderer'

/** Preserve the scene on machines where Chromium cannot create a WebGL context. */
export function createCanvasSkyRenderer(canvas: HTMLCanvasElement): SkyRenderer | null {
  const context = canvas.getContext('2d')
  if (!context) return null
  const far = document.createElement('canvas'), fog = document.createElement('canvas')
  const farContext = far.getContext('2d')!, fogContext = fog.getContext('2d')!
  const stars = createStars(), distant = stars.filter(star => star.depth === 1), near = stars.filter(star => star.depth !== 1)
  let texture: CloudTexture | undefined, lastPalette = '', lastSize = '', ready = false
  let colors: string[] = [], opacity: number[] = []
  function paintStar(target: CanvasRenderingContext2D, star: SkyStar, frame: SkyFrame, x: number, y: number, radius: number, alpha: number) {
    const color = colors[star.color]!
    target.globalAlpha = Math.min(1, alpha * frame.intensity) * opacity[star.color]!
    target.fillStyle = color; target.beginPath(); target.arc(x, y, radius, 0, Math.PI * 2); target.fill()
    if (star.core) {
      const glow = target.createRadialGradient(x, y, 0, x, y, radius * 14)
      glow.addColorStop(0, color + '55'); glow.addColorStop(.2, color + '22'); glow.addColorStop(1, color + '00')
      target.fillStyle = glow; target.fillRect(x - radius * 14, y - radius * 14, radius * 28, radius * 28)
      target.strokeStyle = color; target.lineWidth = .6; target.globalAlpha *= .55
      target.beginPath(); target.moveTo(x - radius * 6, y); target.lineTo(x + radius * 6, y)
      target.moveTo(x, y - radius * 6); target.lineTo(x, y + radius * 6); target.stroke()
    }
    target.globalAlpha = 1
  }
  function recolor(frame: SkyFrame) {
    colors = frame.palette.map(color => '#' + color.map(value => Math.round((value * .38 + .62) * 255).toString(16).padStart(2, '0')).join(''))
    opacity = colors.map((_, index) => frame.highlight < 0 || frame.highlight === index ? 1 : .18)
    if (!texture) return
    fog.width = texture.width; fog.height = texture.height
    const image = fogContext.createImageData(fog.width, fog.height)
    for (let index = 0; index < image.data.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) {
        let value = 0
        for (let slot = 0; slot < 5; slot++) {
          const weight = slot < 3 ? texture.main[index + slot]! : texture.details[index + slot - 3]!
          value += weight * frame.palette[slot]![channel]! * opacity[slot]!
        }
        image.data[index + channel] = value * .70
      }
      image.data[index + 3] = texture.main[index + 3]!
    }
    fogContext.putImageData(image, 0, 0); ready = true
  }
  return {
    cloud(value) { texture = value; lastPalette = '' },
    draw(frame) {
      const { width: w, height: h, dpr: d, time: t } = frame
      const paletteKey = JSON.stringify([frame.palette, frame.highlight, frame.intensity]), sizeKey = `${w}/${h}/${d}`
      const changed = lastPalette !== paletteKey || lastSize !== sizeKey
      if (lastPalette !== paletteKey) { recolor(frame); lastPalette = paletteKey }
      if (lastSize !== sizeKey) {
        canvas.width = far.width = Math.round(w * d); canvas.height = far.height = Math.round(h * d); lastSize = sizeKey
      }
      if (changed) {
        farContext.setTransform(d, 0, 0, d, 0, 0); farContext.clearRect(0, 0, w, h)
        for (const star of distant) paintStar(farContext, star, frame, star.x * w, star.y * h, star.radius, star.alpha)
      }
      context.setTransform(d, 0, 0, d, 0, 0); context.clearRect(0, 0, w, h); context.save()
      const [left, top, right, bottom] = frame.occlusion
      context.beginPath(); context.rect(0, 0, w, h)
      if (right > left && bottom > top) context.rect(left, top, right - left, bottom - top)
      context.clip('evenodd')
      const ox = Math.sin(t * .055) * w * .006, oy = Math.sin(t * .043) * h * .004
      context.drawImage(far, -w * .01 + ox, -h * .01 + oy, w * 1.02, h * 1.02)
      if (ready) {
        const fx = Math.sin(t * .085) * w * .038, fy = Math.sin(t * .063) * h * .033
        context.globalCompositeOperation = 'screen'; context.globalAlpha = Math.min(1, .95 * frame.intensity)
        for (let row = 0; row < 120; row++) {
          const v = row / 120, sh = fog.height / 120
          const bend = Math.sin(v * 6.5 + t * .14) * w * .009 + Math.sin(v * 15 - t * .095) * w * .004
          const y = Math.round(-h * .08 + fy + v * h * 1.16), end = Math.round(-h * .08 + fy + (row + 1) / 120 * h * 1.16)
          context.drawImage(fog, 0, row * sh, fog.width, sh, -w * .07 + fx + bend, y, w * 1.14, end - y)
        }
        context.globalAlpha = Math.min(1, .22 * frame.intensity); context.save(); context.translate(w, h); context.rotate(Math.PI)
        context.drawImage(fog, -w * .08 - fx * .65, -h * .08 - fy * .8, w * 1.16, h * 1.16); context.restore()
        context.globalCompositeOperation = 'source-over'; context.globalAlpha = 1
      }
      for (const star of near) {
        const radius = star.core ? star.radius * (.97 + .035 * Math.sin(t * .9 + star.phase)) : star.radius
        const alpha = star.core ? .78 + .20 * Math.sin(t * (.62 + star.radius * .13) + star.phase) : star.alpha * (.74 + .26 * Math.sin(t * (.65 + star.phase % 7 * .08) + star.phase))
        paintStar(context, star, frame, (star.x * 1.02 - .01) * w + ox * star.depth, (star.y * 1.02 - .01) * h + oy * star.depth, radius, alpha)
      }
      context.restore()
    },
    dispose() { far.width = far.height = fog.width = fog.height = 0; texture = undefined }
  }
}
