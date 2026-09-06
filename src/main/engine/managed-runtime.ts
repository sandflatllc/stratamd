import { copyRuntimeDirectory } from '../../platform/runtime-copy'
import { assertSupportedPlatform } from '../../platform/runtime'
import { execFile } from 'node:child_process'
import { readFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ensurePrivateDirectory } from '../storage'

const execute = promisify(execFile)
export interface BundledRuntime { version: string; nodeVersion: string; platform: string; arch: string; executable: string; entry: string }
export interface StagedRuntime extends BundledRuntime { directory: string }

export async function stageRuntime(bundle: string, root: string): Promise<StagedRuntime> {
  const manifest = JSON.parse(await readFile(join(bundle, 'runtime.json'), 'utf8')) as BundledRuntime
  if (!/^[a-zA-Z0-9._-]+$/.test(manifest.version) || manifest.platform !== assertSupportedPlatform() || manifest.arch !== process.arch) throw new Error(`Bundled engine at ${bundle} does not support ${assertSupportedPlatform()}-${process.arch}`)
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
  // Running Node itself checks its architecture and libraries. Both CommonJS and ESM native dependencies are exercised.
  await execute(join(runtime.directory, runtime.executable), ['--input-type=module', '-e', "import {createRequire} from 'node:module';const r=createRequire(process.cwd()+'/package.json');r('node-pty');r('msgpackr-extract');await import('@ff-labs/fff-node');"], { cwd: runtime.directory, timeout: 30_000, maxBuffer: 64_000 })
}
