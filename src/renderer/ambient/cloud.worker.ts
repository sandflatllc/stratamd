import { seededRandom } from './sceneData'

// Two RGBA weight maps retain all five color contributions and density. Theme
// changes only update GPU uniforms; no noise generation or texture upload.
const width = 1100
const height = 720
const random = seededRandom()
const noiseValues = Float32Array.from({ length: 65536 }, random)
function noise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y)
  let fx = x - ix, fy = y - iy
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
  const a = noiseValues[(ix & 255) + ((iy & 255) << 8)]!
  const b = noiseValues[((ix + 1) & 255) + ((iy & 255) << 8)]!
  const c = noiseValues[(ix & 255) + (((iy + 1) & 255) << 8)]!
  const d = noiseValues[((ix + 1) & 255) + (((iy + 1) & 255) << 8)]!
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}
function fbm(x: number, y: number): number {
  let sum = 0, amplitude = .53
  for (let i = 0; i < 6; i++) { sum += noise(x, y) * amplitude; x = x * 2.04 + 17.1; y = y * 2.04 + 9.2; amplitude *= .49 }
  return sum
}
const main = new Uint8Array(width * height * 4)
const details = new Uint8Array(width * height * 4)
for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
  const u = i / width, v = j / height, x = u * 4.8, y = v * 4
  const a = fbm(x * .75 + 14, y * .75 + 31), b = fbm(x * .9 + 39, y * .9 + 7)
  const n = fbm(x + a * 2.9, y + b * 2.7), detail = fbm(x * 2.8 + 8, y * 2.8 + 19)
  const fold = .43 + .23 * Math.sin(u * 6.6) + (a - .5) * .48
  const band = Math.exp(-Math.pow((v - fold) / .23, 2)), second = Math.exp(-Math.pow((v - (.86 - .5 * u)) / .21, 2))
  const density = (band * .75 + second * .4) * Math.pow(Math.max(0, (n - .23) / .65), 1.6) * (.8 + detail * .4)
  const patch = (cx: number, cy: number, rx: number, ry: number) => Math.exp(-Math.pow((u + (a - .5) * .25 - cx) / rx, 2) - Math.pow((v + (b - .5) * .22 - cy) / ry, 2))
  const weights = [.07 + patch(.14, .48, .32, .5), .06 + patch(.88, .27, .34, .46), patch(.54, .73, .28, .32) * 1.15, patch(.20, .30, .15, .17) * 1.7 * (.4 + detail), patch(.87, .70, .19, .24) * 1.3 * (.4 + detail)]
  const sum = weights.reduce((total, value) => total + value, 0), index = (j * width + i) * 4
  for (let k = 0; k < 3; k++) main[index + k] = Math.round(weights[k]! / sum * 255)
  main[index + 3] = Math.min(210, density * 360)
  details[index] = Math.round(weights[3]! / sum * 255)
  details[index + 1] = Math.round(weights[4]! / sum * 255)
}
postMessage({ width, height, main, details }, { transfer: [main.buffer, details.buffer] })
