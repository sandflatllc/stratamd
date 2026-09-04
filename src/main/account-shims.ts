import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Writes owner-only Linux launchers that select one provider home for terminal use. */
export async function writeTerminalShims(directory: string, accounts: readonly { name: string; command: string; home: string }[]): Promise<string[]> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const paths: string[] = []
  for (const account of accounts) {
    const path = join(directory, account.name)
    await writeFile(path, `#!/bin/sh\nexec env CODEX_HOME=${JSON.stringify(account.home)} ${JSON.stringify(account.command)} "$@"\n`, { mode: 0o700 })
    await chmod(path, 0o700)
    paths.push(path)
  }
  return paths
}
