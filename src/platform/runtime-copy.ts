import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isDarwin } from './runtime'

/** Preserve relative dependency links without the per-file JS scheduling cost of fs.cp. */
export async function copyRuntimeDirectory(source: string, destination: string): Promise<void> {
  await promisify(execFile)('/bin/cp', isDarwin() ? ['-R', '-P', source, destination] : ['-a', '--reflink=auto', '--', source, destination], { maxBuffer: 64_000 })
}
