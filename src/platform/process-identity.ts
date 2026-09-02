import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * What a lock file records so a later reader can tell a live holder from a
 * recycled pid (docs/plans/open/usability-round-2-plan.md 4.6). A pid alone
 * is reused after a reboot or once the counter wraps; the boot id and the
 * process start time pin it to one incarnation. Both are read without native
 * code: Linux exposes them under /proc, macOS through sysctl and ps. Either
 * may be null when the host cannot answer, and callers fall back to the pid.
 */
export interface ProcessIdentity {
  readonly bootId: string | null
  readonly startTime: string | null
}

type Runner = (file: string, args: readonly string[]) => Promise<{ stdout: string }>

const defaultRunner: Runner = async (file, args) => execFileAsync(file, [...args], { windowsHide: true })

let cachedBootId: Promise<string | null> | undefined

export async function bootId(platform: string = process.platform, run: Runner = defaultRunner): Promise<string | null> {
  if (platform === 'linux') {
    try {
      return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() || null
    } catch {
      return null
    }
  }
  if (platform === 'darwin') {
    try {
      const { stdout } = await run('sysctl', ['-n', 'kern.boottime'])
      // `{ sec = 1725000000, usec = 123456 } Mon Sep  1 ...`; the seconds pin the boot.
      const seconds = /sec\s*=\s*(\d+)/.exec(stdout)?.[1]
      return seconds ?? (stdout.trim() || null)
    } catch {
      return null
    }
  }
  return null
}

export async function processStartTime(
  pid: number,
  platform: string = process.platform,
  run: Runner = defaultRunner,
): Promise<string | null> {
  if (platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      // The command name sits in parentheses and may contain spaces; the
      // fields after it are fixed. starttime is field 22 (ticks since boot).
      const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return afterName[19] ?? null
    } catch {
      return null
    }
  }
  if (platform === 'darwin') {
    try {
      const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)])
      return stdout.trim() || null
    } catch {
      return null
    }
  }
  return null
}

/** The running process's own identity, read once. */
export function currentProcessIdentity(): Promise<ProcessIdentity> {
  cachedBootId ??= bootId()
  return Promise.all([cachedBootId, processStartTime(process.pid)]).then(([boot, startTime]) => ({
    bootId: boot,
    startTime,
  }))
}

/** True when a recorded identity still describes the live process `pid`. */
export async function identityMatches(
  pid: number,
  recorded: Partial<ProcessIdentity>,
): Promise<boolean> {
  if (typeof recorded.bootId === 'string') {
    cachedBootId ??= bootId()
    const current = await cachedBootId
    if (current !== null && current !== recorded.bootId) return false
  }
  if (typeof recorded.startTime === 'string') {
    const current = await processStartTime(pid)
    if (current !== null && current !== recorded.startTime) return false
  }
  return true
}
