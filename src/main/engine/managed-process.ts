import { randomUUID } from 'node:crypto'
import { isDarwin } from '../../platform/runtime'
import { execFile } from 'node:child_process'
import { open, readFile, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { bootId, processStartTime } from '../../platform/process-identity'
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
    if (!isDarwin()) {
      const [executable, command] = await Promise.all([realpath(`/proc/${record.pid}/exe`), readFile(`/proc/${record.pid}/cmdline`, 'utf8')])
      const args = command.split('\0')
      return executable === await realpath(record.executable) && args[args.indexOf('--base-dir') + 1] === record.baseDirectory
    }
    const { stdout } = await execute('ps', ['-ww', '-p', String(record.pid), '-o', 'command='])
    return stdout.trim().startsWith(record.executable + ' ') && stdout.includes(`--base-dir ${record.baseDirectory}`)
  } catch { return false }
}

/** Exclusive creation and an incarnation stamp keep overlapping launches from owning the same store. */
export async function takeEngineLock(root: string): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(root)
  const path = join(root, 'lock')
  const stamp = { lease: randomUUID(), pid: process.pid, ...await processStamp(process.pid) }
  let reclaim: Awaited<ReturnType<typeof open>> | null = null
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600)
      await file.writeFile(JSON.stringify(stamp)); await file.sync(); await file.close()
      return async () => {
        try { if (await readFile(path, 'utf8') === JSON.stringify(stamp)) await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Serialize stale-lock reclamation, including the subsequent exclusive creation.
      // An interrupted reclaimer is refused conservatively; it never authorizes deleting another lock.
      if (!reclaim) {
        try { reclaim = await open(`${path}.reclaim`, 'wx', 0o600) }
        catch { throw new Error(`Engine lock recovery is already in progress at ${path}.reclaim`) }
      }
      let old: typeof stamp
      try { old = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error(`Engine lock ${path} is unreadable. Another Strata may be starting.`) }
      let alive = true
      try { process.kill(old.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
      if (alive) {
        try { const current = await processStamp(old.pid); alive = current.bootId === old.bootId && current.startTime === old.startTime } catch { /* Unknown ownership is not permission to remove the lock. */ }
      }
      if (alive) throw new Error(`Another Strata process (${old.pid}) owns ${path}`)
      // Verify the file still names the same owner immediately before removing a stale lock.
      if (await readFile(path, 'utf8') !== JSON.stringify(old)) throw new Error(`Engine ownership changed at ${path}`)
      await unlink(path)
    }
  }
  throw new Error(`Could not acquire engine lock ${path}`)
  } finally { if (reclaim) { await reclaim.close(); await unlink(`${path}.reclaim`) } }
}
