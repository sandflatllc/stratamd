import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeTerminalShims } from '../../src/main/account-shims'

describe('account terminal shims', () => {
  it('writes an owner-only launcher with the selected account home for each driver', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-shims-'))
    const [codex, claude] = await writeTerminalShims(root, [
      { name: 'codex', command: 'codex', homeVariable: 'CODEX_HOME', home: "/accounts/it's work" },
      { name: 'claude', command: 'claude', homeVariable: 'CLAUDE_CONFIG_DIR', home: '/accounts/claude-home' },
    ])
    expect(await readFile(codex!, 'utf8')).toBe(`#!/bin/sh\nexec env CODEX_HOME='/accounts/it'\\''s work' 'codex' "$@"\n`)
    expect(await readFile(claude!, 'utf8')).toContain(`CLAUDE_CONFIG_DIR='/accounts/claude-home' 'claude' "$@"`)
    expect((await stat(codex!)).mode & 0o777).toBe(0o700)
  })

  it('removes the launcher of a driver whose terminal default went back to the system default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-shims-retire-'))
    await writeTerminalShims(root, [{ name: 'codex', command: 'codex', homeVariable: 'CODEX_HOME', home: '/a' }, { name: 'claude', command: 'claude', homeVariable: 'CLAUDE_CONFIG_DIR', home: '/b' }])
    await writeTerminalShims(root, [{ name: 'claude', command: 'claude', homeVariable: 'CLAUDE_CONFIG_DIR', home: '/b' }], ['codex', 'claude'])
    expect(await readdir(root)).toEqual(['claude'])
  })
})
