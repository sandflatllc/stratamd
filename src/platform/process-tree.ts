import { execFile } from 'node:child_process'
import { isWindows } from './runtime'

/** Call only for a live owned child, or a PID whose recorded identity was just verified. */
export function terminateProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (isWindows()) {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    return
  }
  try { process.kill(-pid, signal) } catch { try { process.kill(pid, signal) } catch { /* Already exited. */ } }
}
