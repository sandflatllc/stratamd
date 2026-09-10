import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { writeTerminalShims } from '../../src/main/account-shims'

describe('account terminal shims', () => {
  it.skipIf(process.platform === 'win32')('executes the real provider when its own directory is first on PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-shim-path-'))
    const shims = join(root, 'shims'), providers = join(root, 'providers')
    const binary = join(providers, 'codex')
    try {
      await mkdir(providers); await mkdir(shims)
      await writeFile(binary, '#!/bin/sh\nprintf "%s\\n%s" "$CODEX_HOME" "$1"\n', { mode: 0o700 })
      vi.stubEnv('PATH', [shims, providers, process.env.PATH].join(delimiter))
      const target = { name: 'codex', command: 'codex', homeVariable: 'CODEX_HOME', home: '/test/selected account' }
      await writeTerminalShims(shims, [target])
      await writeTerminalShims(shims, [target])
      const { stdout } = await promisify(execFile)(join(shims, 'codex'), ['literal & argument'], { timeout: 2000 })
      expect(stdout).toBe('/test/selected account\nliteral & argument')
      expect(await readFile(join(shims, 'codex'), 'utf8')).toContain(`'${binary}'`)
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
  })
  it('writes an owner-only launcher with the selected account home for each driver', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-shims-'))
    const [codex, claude] = await writeTerminalShims(root, [
      { name: 'codex', command: process.execPath, homeVariable: 'CODEX_HOME', home: "/accounts/it's work" },
      { name: 'claude', command: process.execPath, homeVariable: 'CLAUDE_CONFIG_DIR', home: '/accounts/claude-home' },
    ])
    if (process.platform === 'win32') {
      expect(await readFile(codex!, 'utf8')).toContain(`set \"CODEX_HOME=/accounts/it's work\"`)
      expect(await readFile(codex!, 'utf8')).toContain(`\"${process.execPath}\" %*`)
      return
    }
    expect(await readFile(codex!, 'utf8')).toBe(`#!/bin/sh\nexec env CODEX_HOME='/accounts/it'\\''s work' '${process.execPath}' "$@"\n`)
    expect(await readFile(claude!, 'utf8')).toContain(`CLAUDE_CONFIG_DIR='/accounts/claude-home' '${process.execPath}' "$@"`)
    expect((await stat(codex!)).mode & 0o777).toBe(0o700)
  })

  it('removes the launcher of a driver whose terminal default went back to the system default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-shims-retire-'))
    await writeTerminalShims(root, [{ name: 'codex', command: process.execPath, homeVariable: 'CODEX_HOME', home: '/a' }, { name: 'claude', command: process.execPath, homeVariable: 'CLAUDE_CONFIG_DIR', home: '/b' }])
    await writeTerminalShims(root, [{ name: 'claude', command: process.execPath, homeVariable: 'CLAUDE_CONFIG_DIR', home: '/b' }], ['codex', 'claude'])
    expect(await readdir(root)).toEqual([process.platform === 'win32' ? 'claude.cmd' : 'claude'])
  })
})
