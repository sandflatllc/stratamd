// Creates resources/stratamd.icns from resources/stratamd-icon.svg during a
// Mac build (mac-plan §5). The .icns is generated output: gitignored, rebuilt
// every build, never compared byte-for-byte.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

if (process.platform !== 'darwin') {
  console.error('mac-icon.mjs uses macOS icon tooling (sips, qlmanage, iconutil); run it on a Mac.')
  process.exit(1)
}

const source = 'resources/stratamd-icon.svg'
const target = 'resources/stratamd.icns'
const work = join(tmpdir(), `stratamd-icon-${process.pid}`)
const iconset = join(work, 'stratamd.iconset')
mkdirSync(iconset, { recursive: true })

function tryRun(command, args) {
  const result = spawnSync(command, args, { stdio: 'pipe' })
  return !result.error && result.status === 0
}

// Rasterize the SVG once at full size. sips reads SVG on current macOS; Quick
// Look thumbnailing is the fallback for systems where it does not.
const master = join(work, 'master.png')
let rasterized = tryRun('sips', ['-s', 'format', 'png', source, '--out', master, '-z', '1024', '1024'])
if (!rasterized) {
  if (tryRun('qlmanage', ['-t', '-s', '1024', '-o', work, source])) {
    const thumbnail = readdirSync(work).find((name) => name.endsWith('.png'))
    if (thumbnail) {
      copyFileSync(join(work, thumbnail), master)
      rasterized = true
    }
  }
}
if (!rasterized || !existsSync(master)) {
  console.error(`Could not rasterize ${source}; neither sips nor qlmanage produced a PNG.`)
  process.exit(1)
}

for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  const names = []
  if (size <= 512) names.push(`icon_${size}x${size}.png`)
  if (size >= 32) names.push(`icon_${size / 2}x${size / 2}@2x.png`)
  for (const name of names) {
    if (!tryRun('sips', ['-z', String(size), String(size), master, '--out', join(iconset, name)])) {
      console.error(`Could not resize the icon to ${size}px.`)
      process.exit(1)
    }
  }
}

const convert = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', target], { stdio: 'inherit' })
rmSync(work, { recursive: true, force: true })
if (convert.error || convert.status !== 0) {
  console.error('iconutil could not assemble the .icns.')
  process.exit(1)
}
console.log(`Wrote ${target}`)
