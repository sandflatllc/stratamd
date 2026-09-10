import { isWindows } from '../platform/runtime'
import { findExecutable } from '../platform/commands'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface TerminalShimTarget {
  /** The launcher's file name, normally the provider binary's name so PATH order picks it. */
  name: string
  /** The provider binary the launcher runs. */
  command: string
  /** The environment variable the provider reads its home from (CODEX_HOME, CLAUDE_CONFIG_DIR). */
  homeVariable: string
  home: string
}

/**
 * Writes owner-only Linux launchers that select one provider home for terminal
 * use (§5.13). Launchers for drivers no longer defaulted are removed so PATH
 * falls back to the provider's own binary.
 */
export async function writeTerminalShims(directory: string, accounts: readonly TerminalShimTarget[], retire: readonly string[] = []): Promise<string[]> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const paths: string[] = []
  for (const name of retire) {
    if (accounts.some((account) => account.name === name)) continue
    await rm(join(directory, isWindows() ? name + '.cmd' : name), { force: true })
  }
  for (const account of accounts) {
    const path = join(directory, isWindows() ? account.name + '.cmd' : account.name)
    if (!/^[A-Za-z0-9_.-]+$/u.test(account.name) || !/^[A-Z_][A-Z0-9_]*$/u.test(account.homeVariable)) throw new Error(`Refusing to write a launcher named ${account.name}`)
    const command = await findExecutable(account.command, process.cwd(), process.env.PATH ?? '', [path])
    if (!command) throw new Error(`Cannot write ${path}: provider ${account.command} was not found outside the launcher itself.`)
    if (isWindows()) {
      const literal = (value: string) => { if (/[\r\n\"]/.test(value)) throw new Error(`Invalid launcher path ${path}`); return value.replace(/%/g, '%%') }
      await writeFile(path, `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "${account.homeVariable}=${literal(account.home)}"\r\n"${literal(command)}" %*\r\n`)
      paths.push(path); continue
    }
    await writeFile(path, `#!/bin/sh\nexec env ${account.homeVariable}=${shellQuote(account.home)} ${shellQuote(command)} "$@"\n`, { mode: 0o700 })
    await chmod(path, 0o700)
    paths.push(path)
  }
  return paths
}

/** Single-quote for /bin/sh; JSON quoting would let `$` and backticks expand. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}
