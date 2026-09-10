import { randomUUID } from 'node:crypto'
import { isDarwin, isWindows } from '../../platform/runtime'
import { execFile } from 'node:child_process'
import { open, readFile, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { bootId, processStartTime } from '../../platform/process-identity'
import { unixSupportBinding } from '../../platform/unix-support'
import { ensurePrivateDirectory } from '../storage'

const execute = promisify(execFile)
export interface OwnedProcess { pid: number; bootId: string; startTime: string; executable: string; baseDirectory: string }
export async function processStamp(pid: number): Promise<{ bootId: string; startTime: string }> {
  const [boot, start] = await Promise.all([bootId(), processStartTime(pid)])
  if (!boot || !start) throw new Error(`Cannot verify the identity of engine process ${pid}`)
  return { bootId: boot, startTime: start }
}
export async function verifiedProcess(record: OwnedProcess): Promise<boolean> {
  try {
    const stamp = await processStamp(record.pid)
    if (stamp.bootId !== record.bootId || stamp.startTime !== record.startTime) return false
    if (isWindows()) {
      const info = unixSupportBinding().processInfo?.(record.pid)
      // Kernel creation time pins the exact process incarnation. The manager
      // separately validates its data directory and authenticates adoption.
      return !!info && info.startTime === stamp.startTime && (await realpath(info.executable)).toLowerCase() === (await realpath(record.executable)).toLowerCase()
    }
    if (!isDarwin()) {
      const [executable, command] = await Promise.all([realpath(`/proc/${record.pid}/exe`), readFile(`/proc/${record.pid}/cmdline`, 'utf8')])
      const args = command.split('\0')
      return executable === await realpath(record.executable) && args[args.indexOf('--base-dir') + 1] === record.baseDirectory
    }
    const { stdout } = await execute('ps', ['-ww', '-p', String(record.pid), '-o', 'command='])
    return stdout.trim().startsWith(record.executable + ' ') && stdout.includes(`--base-dir ${record.baseDirectory}`)
  } catch { return false }
}

/** The advisory file is never unlinked: every contender must lock the same inode. */
export async function takeEngineLock(root: string): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(root)
  const path = join(root, 'lock')
  const guard = await open(join(root, 'ownership.lock'), 'a+', 0o600)
  try {
    if (!unixSupportBinding().tryLock(guard.fd)) throw new Error(`Another Strata process owns ${path}`)
    // Compatibility with a live manager using the former exclusive-file protocol.
    // An abandoned reclaim marker cannot confer ownership; it is left untouched.
    let previous: { pid: number; bootId: string; startTime: string } | undefined
    try { previous = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Engine lock ${path} is unreadable. Inspect its owner before recovery.`)
    }
    if (previous) {
      let alive = true
      try { process.kill(previous.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
      if (alive) {
        try { const stamp = await processStamp(previous.pid); alive = stamp.bootId === previous.bootId && stamp.startTime === previous.startTime } catch { /* Unknown owner remains protected. */ }
      }
      if (alive) throw new Error(`Another Strata process (${previous.pid}) owns ${path}`)
    }
    const stamp = JSON.stringify({ lease: randomUUID(), pid: process.pid, ...await processStamp(process.pid) })
    const { atomicWriteFile } = await import('../storage')
    await atomicWriteFile(path, stamp)
    let released = false
    return async () => {
      if (released) return
      released = true
      try { if (await readFile(path, 'utf8') === stamp) await unlink(path) }
      finally { await guard.close() }
    }
  } catch (error) { await guard.close(); throw error }
}
