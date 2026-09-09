import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir, lstat, readlink, rename, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { copyRuntimeDirectory } from '../../platform/runtime-copy'
import { atomicWriteFile, ensurePrivateDirectory } from '../storage'
import type { StagedRuntime } from './managed-runtime'
export interface EngineBackup { replacementVersion?: string; id: string; createdAt: string; version: string; runtime: StagedRuntime; kind: 'upgrade' | 'newer-work' | 'failed-update' }
export async function inventoryDirectory(root: string): Promise<Record<string, { bytes?: number; sha256?: string; link?: string }>> {
  const files: Record<string, { bytes?: number; sha256?: string; link?: string }> = {}
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name), key = relative(root, file)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isSymbolicLink()) files[key] = { link: await readlink(file) }
      else if (entry.isFile()) { const bytes = await readFile(file); files[key] = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') } }
    }
  }
  await visit(root); return files
}
export async function createEngineBackup(root: string, runtime: StagedRuntime, kind: EngineBackup['kind'], capture: (directory: string) => Promise<void>, replacementVersion?: string): Promise<EngineBackup> {
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/[:.]/g, '-')}-${runtime.version}-${kind}`
  const directory = join(root, 'backups', id), pending = directory + '.pending'
  await ensurePrivateDirectory(pending)
  try {
    await copyRuntimeDirectory(join(root, 't3'), join(pending, 't3'))
    await capture(pending)
    await writeFile(join(pending, 'files.json'), JSON.stringify(await inventoryDirectory(pending)), { mode: 0o600 })
    const backup: EngineBackup = { id, createdAt, version: runtime.version, runtime, kind, ...(replacementVersion ? { replacementVersion } : {}) }
    await atomicWriteFile(join(pending, 'backup.json'), JSON.stringify(backup))
    await rename(pending, directory)
    return backup
  } catch (error) { await rm(pending, { recursive: true, force: true }); throw error }
}
export async function listEngineBackups(root: string): Promise<EngineBackup[]> {
  let entries: string[]
  try { entries = await readdir(join(root, 'backups')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const backups: EngineBackup[] = []
  for (const id of entries.filter(id => !id.endsWith('.pending'))) {
    try { backups.push(await readEngineBackup(root, id)) } catch { /* Incomplete backups cannot be restored. */ }
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export async function readEngineBackup(root: string, id: string): Promise<EngineBackup> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error('Invalid engine backup id.')
  const value = JSON.parse(await readFile(join(root, 'backups', id, 'backup.json'), 'utf8')) as EngineBackup
  if (value.id !== id || !value.runtime || !resolve(value.runtime.directory).startsWith(resolve(root, 'runtime') + sep)) throw new Error(`Invalid engine backup at ${id}`)
  return value
}
export async function restoreEngineBackup(root: string, backup: EngineBackup, restore: (directory: string) => Promise<void>): Promise<void> {
  const source = join(root, 'backups', backup.id)
  await verifyEngineBackup(root, backup)
  const stage = join(root, 't3.restoring')
  await rm(stage, { recursive: true, force: true })
  await copyRuntimeDirectory(join(source, 't3'), stage)
  // The journal retains the backup id; both operations are recoverable after a crash.
  await rm(join(root, 't3'), { recursive: true, force: true })
  await rename(stage, join(root, 't3'))
  await restore(source)
}

/** Called only under the engine ownership lock after ready + explicit graceful shutdown. */
export async function retainEngineRecovery(root: string, currentVersion: string): Promise<void> {
  const cleanPath = join(root, 'clean-sessions.json')
  let clean: string[] = []
  try { clean = JSON.parse(await readFile(cleanPath, 'utf8')); if (!Array.isArray(clean) || clean.some(v => typeof v !== 'string')) throw new Error('Invalid clean-session inventory') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  clean = [...new Set([...clean, currentVersion])]
  await atomicWriteFile(cleanPath, JSON.stringify(clean))
  const backups = await listEngineBackups(root)
  const keepVersions = new Set([currentVersion])
  let journalId: string | undefined
  for (const file of ['selected-runtime.json', 'transition.json']) {
    try {
      const value = JSON.parse(await readFile(join(root, file), 'utf8'))
      if (file === 'selected-runtime.json') keepVersions.add(value.version)
      else { journalId = value.backupId; keepVersions.add(value.targetVersion) }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  // Unknown or incomplete records must not permit deletion of their runtime.
  const entries = await readdir(join(root, 'backups')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  if (entries.some(id => !backups.some(backup => backup.id === id))) return
  const latestRollback = backups.find(backup => backup.kind === 'upgrade')
  if (latestRollback) {
    const { verifyRuntime } = await import('./managed-runtime')
    await verifyRuntime(latestRollback.runtime)
    await verifyEngineBackup(root, latestRollback)
  }
  for (const backup of backups) {
    if (backup.kind === 'upgrade' && backup !== latestRollback && backup.id !== journalId && backup.replacementVersion && clean.includes(backup.replacementVersion)) {
      await rm(join(root, 'backups', backup.id), { recursive: true })
    } else keepVersions.add(backup.version)
  }
  for (const entry of await readdir(join(root, 'runtime'), { withFileTypes: true })) {
    if (!entry.isDirectory() || keepVersions.has(entry.name) || entry.name.startsWith('.')) continue
    await rm(join(root, 'runtime', entry.name), { recursive: true })
  }
}

export async function verifyEngineBackup(root: string, backup: EngineBackup): Promise<void> {
  const source = join(root, 'backups', backup.id)
  const files = JSON.parse(await readFile(join(source, 'files.json'), 'utf8')) as Awaited<ReturnType<typeof inventoryDirectory>>
  const actual = await inventoryDirectory(source)
  for (const path of Object.keys(actual)) if (!['files.json', 'backup.json'].includes(path) && !files[path]) throw new Error(`Unexpected backup file: ${path}`)
  for (const [path, expected] of Object.entries(files)) if (JSON.stringify(actual[path]) !== JSON.stringify(expected)) throw new Error(`Engine backup verification failed at ${join(source, path)}`)
}
