import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEME_KEYS } from '../../src/shared/theme-keys'

// PRD §6.9: the panes scale text through one factor, `--zoom`, and every color
// comes from the theme. The cockpit panels once shipped with rem sizes and a
// token vocabulary no theme defined, so zoom and theming never reached them.
// These checks read the stylesheet itself, so a rule cannot slip back in.

const css = readFileSync('src/renderer/styles.css', 'utf8')

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(?:ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts') ? [path] : []
  })
}

/** Every custom property the stylesheet, the theme table, or a component's inline style defines. */
function definedVariables(): Set<string> {
  const defined = new Set<string>()
  for (const match of css.matchAll(/(?:^|[\s;{])(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(match[1]!)
  for (const entry of THEME_KEYS) {
    defined.add(entry.variable)
    defined.add(`${entry.variable}-text`)
  }
  for (const path of [...sources('src/renderer'), ...sources('src/editor'), ...sources('src/shared')]) {
    for (const match of readFileSync(path, 'utf8').matchAll(/['"`](--[a-zA-Z0-9-]+)['"`]/g)) defined.add(match[1]!)
  }
  return defined
}

/** Rules in the pane-scoped cockpit families: the left window, the center conversation, the right rail's Documents. */
const SCOPED = /^\s*(?:\.(?:conversation|turn-|project|engine-empty|thread-picker|rail-tab|folder-row|file-row|panel-heading))/

function rules(): Array<{ selector: string; body: string; line: number }> {
  const out: Array<{ selector: string; body: string; line: number }> = []
  const lines = css.split('\n')
  lines.forEach((line, index) => {
    const match = /^([^{@/][^{]*)\{([^}]*)\}\s*$/.exec(line)
    if (match) out.push({ selector: match[1]!.trim(), body: match[2]!, line: index + 1 })
  })
  return out
}

describe('stylesheet zoom and tokens', () => {
  it('names only custom properties that something defines', () => {
    const defined = definedVariables()
    const missing = new Set<string>()
    for (const match of css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) if (!defined.has(match[1]!)) missing.add(match[1]!)
    expect([...missing].sort()).toEqual([])
  })

  it('scales every cockpit-panel font size by the pane zoom factor', () => {
    const offenders: string[] = []
    for (const rule of rules()) {
      if (!rule.selector.split(',').some((selector) => SCOPED.test(selector))) continue
      for (const declaration of rule.body.matchAll(/font-size:\s*([^;]+)/g)) {
        const value = declaration[1]!.trim()
        // Zoom reaches a size through the calc or through em, which follows a zoomed parent.
        if (value.includes('var(--zoom') || /^[\d.]+em$/.test(value) || value === '0' || value === 'inherit') continue
        offenders.push(`line ${rule.line}: ${rule.selector} { font-size: ${value} }`)
      }
      for (const declaration of rule.body.matchAll(/\bfont:\s*([^;]+)/g)) {
        const value = declaration[1]!.trim()
        if (value === 'inherit' || value.includes('var(--zoom')) continue
        offenders.push(`line ${rule.line}: ${rule.selector} { font: ${value} }`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('renders conversation message prose through the shared prose class', () => {
    expect(css).toMatch(/\.conversation-prose \{[^}]*font-size: calc\(\d+px \* var\(--zoom, 1\)\)/)
    const conversation = readFileSync('src/renderer/components/Conversation.tsx', 'utf8')
    expect(conversation).toContain('MessageMarkdown')
    expect(conversation).not.toContain('InlineMarkdown')
  })
})
