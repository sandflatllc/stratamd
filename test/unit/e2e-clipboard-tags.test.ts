import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The Playwright suite runs ordinary tests in parallel and clipboard tests one
 * at a time (playwright.config.ts). Every Electron app on the display shares
 * one operating-system clipboard, so a test that writes it can corrupt another
 * test's read even when it never reads the clipboard itself. This check keeps
 * the `@clipboard` tag in step with what the tests actually do.
 */

const e2eDir = join(__dirname, '../e2e')

// Lines that touch the native clipboard. Electron's clipboard module, the
// copy/cut/paste shortcuts, the app's copy buttons and menu items, and the
// Copy for agent helper.
const triggers: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bclipboard\.(readText|writeText|read|write|clear)\b/, reason: "Electron's clipboard module" },
  { pattern: /primaryKey\('[cvx]'\)/, reason: 'a copy, cut, or paste shortcut' },
  { pattern: /(Control|Meta)\+[CVX]\b/i, reason: 'a copy, cut, or paste shortcut' },
  { pattern: /(Shift|Control)\+Insert\b/i, reason: 'a copy or paste shortcut' },
  { pattern: /name: (['"])(Copy full path|Copy the prompt for your agent|Cut|Paste)\1/, reason: 'a menu item or button that uses the clipboard' },
  { pattern: /copyForAgent\(|name: \/Copy for agent/, reason: 'Copy for agent' }
]

const tagPattern = /\btag: (?:\[[^\]]*)?['"]@clipboard['"]/

interface TestBlock {
  title: string
  line: number
  tagged: boolean
  start: number
  end: number
}

function testBlocks(lines: string[]): TestBlock[] {
  const blocks: TestBlock[] = []
  lines.forEach((text, index) => {
    const declaration = /^(\s*)test\((['"])(.*?)\2,/.exec(text)
    if (!declaration) return
    const indent = declaration[1] ?? ''
    // The callback closes on the first later line that is exactly `})` at the
    // declaration's indentation.
    let end = lines.length
    for (let later = index + 1; later < lines.length; later += 1) {
      if (lines[later] === `${indent}})`) { end = later; break }
    }
    blocks.push({ title: declaration[3] ?? '', line: index + 1, tagged: tagPattern.test(text), start: index, end })
  })
  return blocks
}

async function specFiles(): Promise<string[]> {
  return (await readdir(e2eDir)).filter((name) => name.endsWith('.spec.ts')).sort()
}

describe('e2e clipboard tags', () => {
  it('tags every Playwright test that reads or writes the native clipboard with @clipboard', async () => {
    const problems: string[] = []
    const taggedWithoutTrigger: string[] = []
    for (const name of await specFiles()) {
      const lines = (await readFile(join(e2eDir, name), 'utf8')).split('\n')
      const blocks = testBlocks(lines)
      const triggered = new Set<TestBlock>()
      lines.forEach((text, index) => {
        const trigger = triggers.find((candidate) => candidate.pattern.test(text))
        if (!trigger) return
        const block = blocks.find((candidate) => index > candidate.start && index < candidate.end)
        if (!block) {
          problems.push(`${name}:${index + 1} uses ${trigger.reason} outside any test; move it into a test tagged @clipboard`)
          return
        }
        triggered.add(block)
        if (!block.tagged) {
          problems.push(`${name}:${index + 1} uses ${trigger.reason}; add { tag: '@clipboard' } to the test at line ${block.line} ("${block.title}")`)
        }
      })
      for (const block of blocks) {
        if (block.tagged && !triggered.has(block)) taggedWithoutTrigger.push(`${name}:${block.line} ("${block.title}")`)
      }
    }
    expect(problems, 'Clipboard tests run one at a time only when tagged').toEqual([])
    expect(taggedWithoutTrigger, 'Drop @clipboard from tests that no longer touch the clipboard so they run in parallel').toEqual([])
  })

  it('finds the known clipboard tests', async () => {
    let tagged = 0
    for (const name of await specFiles()) {
      const lines = (await readFile(join(e2eDir, name), 'utf8')).split('\n')
      tagged += testBlocks(lines).filter((block) => block.tagged).length
    }
    // Guards the scanner itself: a regex change that stops recognizing test
    // declarations would otherwise pass the first check vacuously.
    expect(tagged).toBeGreaterThanOrEqual(8)
  })
})
