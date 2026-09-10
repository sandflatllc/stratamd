import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isDarwin, isWindows } from './runtime'

const execute = promisify(execFile)

/** Preserve relative dependency links without the per-file JS scheduling cost of fs.cp. */
export async function copyRuntimeDirectory(source: string, destination: string): Promise<void> {
  if (isWindows()) {
    try {
      await execute('robocopy.exe', [source, destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/SL', '/SJ', '/IS', '/IT', '/MT:8', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true, maxBuffer: 64_000 })
    } catch (error) {
      // Robocopy uses 1–7 for successful copy/difference results, 8+ for failures.
      const code = (error as { code?: unknown }).code
      if (typeof code !== 'number' || code < 1 || code >= 8) throw error
    }
    return
  }
  await execute('/bin/cp', isDarwin() ? ['-c', '-R', '-P', source, destination] : ['-a', '--reflink=auto', '--', source, destination], { maxBuffer: 64_000 })
}
