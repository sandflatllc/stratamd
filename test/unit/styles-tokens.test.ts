import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// PRD §6.13: no color in the app is outside the theme's reach. Every color is a
// theme token in :root or a color-mix of one; nothing else may name a color.
const LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(/gi

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(?:ts|tsx|css)$/.test(entry) && !entry.endsWith('.d.ts') ? [path] : []
  })
}

describe('theme tokens', () => {
  it('keeps every color literal in the stylesheet inside :root', () => {
    const css = readFileSync('src/renderer/styles.css', 'utf8')
    const rootEnd = css.indexOf('}', css.indexOf(':root {')) + 1
    const outside = css.slice(rootEnd).match(LITERAL) ?? []
    expect(outside).toEqual([])
  })

  it('keeps editor and renderer sources free of color literals', () => {
    const offenders: string[] = []
    for (const path of [...sources('src/editor'), ...sources('src/renderer'), ...sources('src/shared')]) {
      if (path.endsWith('styles.css') || path.endsWith('theme-keys.ts') || path.endsWith('bundled-themes.ts')) continue
      const text = readFileSync(path, 'utf8')
      for (const line of text.split('\n')) if (LITERAL.test(line) && !line.includes('THEME_KEYS') && !/^\s*\/\//.test(line)) offenders.push(`${path}: ${line.trim().slice(0, 100)}`)
      LITERAL.lastIndex = 0
    }
    expect(offenders).toEqual([])
  })
})
