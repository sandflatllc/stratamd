import { createHash } from 'node:crypto'
import { copyRuntimeDirectory } from '../../platform/runtime-copy'
import { assertSupportedPlatform } from '../../platform/runtime'
import { execFile } from 'node:child_process'
import { readFile, readlink, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ensurePrivateDirectory } from '../storage'

const execute = promisify(execFile)
export interface BundledRuntime { version: string; nodeVersion: string; platform: string; arch: string; executable: string; entry: string; integrity?: string }
export interface StagedRuntime extends BundledRuntime { directory: string }

export async function stageRuntime(bundle: string, root: string): Promise<StagedRuntime> {
  const manifest = JSON.parse(await readFile(join(bundle, 'runtime.json'), 'utf8')) as BundledRuntime
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.version) || manifest.platform !== assertSupportedPlatform() || manifest.arch !== process.arch) throw new Error(`Bundled engine at ${bundle} does not support ${assertSupportedPlatform()}-${process.arch}`)
  const directory = join(root, 'runtime', manifest.version)
  for (const relative of [manifest.executable, manifest.entry]) {
    if (typeof relative !== 'string' || !resolve(bundle, relative).startsWith(resolve(bundle) + '/')) throw new Error(`Invalid bundled engine path at ${bundle}`)
  }
  try { await stat(join(directory, 'runtime.json')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const pending = `${directory}.staging-${process.pid}`
    await ensurePrivateDirectory(join(root, 'runtime'))
    await rm(pending, { recursive: true, force: true })
    try {
      await copyRuntimeDirectory(bundle, pending)
      await verifyRuntime({ ...manifest, directory: pending })
      await rename(pending, directory)
      // Rename preserves the runtime just verified; do not load every native module twice on a cold launch.
      return { ...manifest, directory }
    } catch (error) { await rm(pending, { recursive: true, force: true }); throw error }
  }
  const staged = { ...manifest, directory }
  await verifyRuntime(staged)
  return staged
}

export async function verifyRuntime(runtime: StagedRuntime): Promise<void> {
  for (const path of [runtime.executable, runtime.entry, ...(runtime.integrity ? [runtime.integrity] : [])]) if (typeof path !== 'string' || !resolve(runtime.directory, path).startsWith(resolve(runtime.directory) + '/')) throw new Error('Invalid runtime manifest path')
  if (runtime.integrity) {
    const manifest = JSON.parse(await readFile(join(runtime.directory, runtime.integrity), 'utf8')) as { files: Record<string, { sha256?: string; link?: string }> }
    const entries = Object.entries(manifest.files)
    let next = 0
    // Bound reads instead of scheduling 19,000 sequential filesystem round trips on Electron's main process.
    const checks = await Promise.allSettled(Array.from({ length: Math.min(8, entries.length) }, async () => {
      for (;;) {
        const entry = entries[next++]
        if (!entry) return
        const [path, expected] = entry
        if (!resolve(runtime.directory, path).startsWith(resolve(runtime.directory) + '/')) throw new Error('Invalid runtime integrity path')
        const file = join(runtime.directory, path)
        if (expected.link !== undefined) {
          if (await readlink(file) !== expected.link || !resolve(file, '..', expected.link).startsWith(resolve(runtime.directory) + '/')) throw new Error(`Runtime link verification failed at ${file}`)
        } else if (createHash('sha256').update(await readFile(file)).digest('hex') !== expected.sha256) throw new Error(`Runtime integrity verification failed at ${file}`)
      }
    }))
    for (const check of checks) if (check.status === 'rejected') throw check.reason
  }

  // Running Node itself checks its architecture and libraries. Both CommonJS and ESM native dependencies are exercised.
  await execute(join(runtime.directory, runtime.executable), ['--input-type=module', '-e', "import {createRequire} from 'node:module';const r=createRequire(process.cwd()+'/package.json');r('node-pty');r('msgpackr-extract');await import('@ff-labs/fff-node');"], { cwd: runtime.directory, timeout: 30_000, maxBuffer: 64_000 })
}
