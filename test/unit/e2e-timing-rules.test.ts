import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Two timing rules the Electron suite enforces (test/e2e/README.md, "Writing
 * a spec that holds up"). A fixed sleep is a race with a timer and every
 * flake traced on 2026-09-05 sat next to one or would have; a per-test
 * budget above a minute turns a hang into a worker lost for that long. New
 * sleeps fail here; removing one is always allowed, and the allowlist below
 * shrinks with it.
 */

const e2eDir = join(__dirname, '../e2e')

/** Fixed sleeps still present per file; a file absent here allows none. */
const allowedSleeps: Record<string, number> = {
  'agent-collaboration.spec.ts': 3,
  'annotation-highlight-after-edit.spec.ts': 5,
  'annotation-right-click.spec.ts': 1,
  'annotation-stale-selection.spec.ts': 2,
  'annotation-table-comment.spec.ts': 1,
  'cockpit-drafts.spec.ts': 1,
  'cockpit-engine.spec.ts': 1,
  'cold-tabs.spec.ts': 6,
  'editor-context-menu.spec.ts': 3,
  'shell-keyboard.spec.ts': 2,
  'spellcheck.spec.ts': 6,
  'typing-flush.spec.ts': 1,
  'undo-redo.spec.ts': 7,
  'visual-handoff.spec.ts': 4
}

const BUDGET_LIMIT_MS = 60_000

async function specFiles(): Promise<string[]> {
  return (await readdir(e2eDir)).filter((name) => name.endsWith('.ts')).sort()
}

describe('e2e timing rules', () => {
  it('adds no fixed sleeps beyond the ones already allowed', async () => {
    const overages: string[] = []
    const stale: string[] = []
    const counts = new Map<string, number>()
    for (const name of await specFiles()) {
      const source = await readFile(join(e2eDir, name), 'utf8')
      const count = (source.match(/\bwaitForTimeout\(/g) ?? []).length
      counts.set(name, count)
      const allowed = allowedSleeps[name] ?? 0
      if (count > allowed) overages.push(`${name}: ${count} fixed sleep(s), ${allowed} allowed; wait for the condition instead`)
    }
    for (const [name, allowed] of Object.entries(allowedSleeps)) {
      const count = counts.get(name) ?? 0
      if (count < allowed) stale.push(`${name}: ${count} fixed sleep(s) left, allowlist says ${allowed}; lower it`)
    }
    expect(overages, overages.join('\n')).toEqual([])
    expect(stale, stale.join('\n')).toEqual([])
  })

  it('keeps every per-test budget at one minute or under', async () => {
    const offenders: string[] = []
    for (const name of await specFiles()) {
      const source = await readFile(join(e2eDir, name), 'utf8')
      for (const match of source.matchAll(/test\.setTimeout\(\s*([0-9_]+)\s*\)/g)) {
        const budget = Number(match[1]!.replace(/_/g, ''))
        if (budget > BUDGET_LIMIT_MS) offenders.push(`${name}: test.setTimeout(${match[1]}) exceeds ${BUDGET_LIMIT_MS}; split the test or wait for a narrower condition`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
