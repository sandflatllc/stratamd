import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp } from 'node:fs/promises'
import { isDarwin, isWindows } from './runtime'

/** Preserve relative dependency links without the per-file JS scheduling cost of fs.cp. */
export async function copyRuntimeDirectory(source: string, destination: string): Promise<void> {
  if (isWindows()) { await cp(source, destination, { recursive: true, verbatimSymlinks: true }); return }
  await promisify(execFile)('/bin/cp', isDarwin() ? ['-c', '-R', '-P', source, destination] : ['-a', '--reflink=auto', '--', source, destination], { maxBuffer: 64_000 })
}
