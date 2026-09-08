import { copyRuntimeDirectory } from '../../platform/runtime-copy'
import { assertSupportedPlatform } from '../../platform/runtime'
import { execFile } from 'node:child_process'
import { readFile, readlink, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
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
      verifications.set(directory, verifications.get(pending) ?? Promise.resolve())
      verifications.delete(pending)
      return { ...manifest, directory }
    } catch (error) { await rm(pending, { recursive: true, force: true }); throw error }
  }
  const staged = { ...manifest, directory }
  await verifyRuntime(staged)
  return staged
}

/** Verifications already completed or in flight this launch, by runtime directory. */
const verifications = new Map<string, Promise<void>>()

/**
 * A staged runtime is verified once per launch. The startup path asks about
 * the bundled runtime, the recorded runtime, and the selected runtime, which
 * are often the same directory; its files do not change while Strata runs.
 * A failed verification is forgotten so a retry checks the files again.
 */
export function verifyRuntime(runtime: StagedRuntime): Promise<void> {
  const existing = verifications.get(runtime.directory)
  if (existing) return existing
  const verification = verifyRuntimeFiles(runtime)
  verifications.set(runtime.directory, verification)
  verification.catch(() => { if (verifications.get(runtime.directory) === verification) verifications.delete(runtime.directory) })
  return verification
}

/** Reads and hashes the manifest's files away from the main thread, with the same bounded concurrency as before. */
const HASH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const { directory, files } = workerData
let next = 0
const run = async () => {
  for (;;) {
    const entry = files[next++]
    if (!entry) return
    const digest = createHash('sha256').update(await readFile(join(directory, entry[0]))).digest('hex')
    if (digest !== entry[1]) throw new Error('Runtime integrity verification failed at ' + join(directory, entry[0]))
  }
}
Promise.all(Array.from({ length: Math.min(8, files.length) }, run)).then(
  () => parentPort.postMessage({ ok: true }),
  (error) => parentPort.postMessage({ ok: false, message: error && error.message ? error.message : String(error) }),
)
`

function hashFilesInWorker(directory: string, files: Array<[string, string]>): Promise<void> {
  if (files.length === 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(HASH_WORKER, { eval: true, workerData: { directory, files } })
    let settled = false
    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      if (error) reject(error); else resolve()
      void worker.terminate()
    }
    worker.once('message', (result: { ok: boolean; message?: string }) => finish(result.ok ? null : new Error(result.message ?? 'Runtime integrity verification failed')))
    worker.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))))
    worker.once('exit', (code) => finish(code === 0 ? null : new Error(`Runtime verification stopped with code ${code}`)))
  })
}

async function verifyRuntimeFiles(runtime: StagedRuntime): Promise<void> {
  for (const path of [runtime.executable, runtime.entry, ...(runtime.integrity ? [runtime.integrity] : [])]) if (typeof path !== 'string' || !resolve(runtime.directory, path).startsWith(resolve(runtime.directory) + '/')) throw new Error('Invalid runtime manifest path')
  if (runtime.integrity) {
    const manifest = JSON.parse(await readFile(join(runtime.directory, runtime.integrity), 'utf8')) as { files: Record<string, { sha256?: string; link?: string }> }
    const hashes: Array<[string, string]> = []
    for (const [path, expected] of Object.entries(manifest.files)) {
      if (!resolve(runtime.directory, path).startsWith(resolve(runtime.directory) + '/')) throw new Error('Invalid runtime integrity path')
      const file = join(runtime.directory, path)
      if (expected.link !== undefined) {
        if (await readlink(file) !== expected.link || !resolve(file, '..', expected.link).startsWith(resolve(runtime.directory) + '/')) throw new Error(`Runtime link verification failed at ${file}`)
      } else hashes.push([path, expected.sha256 ?? ''])
    }
    await hashFilesInWorker(runtime.directory, hashes)
  }

  // Running Node itself checks its architecture and libraries. Both CommonJS and ESM native dependencies are exercised.
  await execute(join(runtime.directory, runtime.executable), ['--input-type=module', '-e', "import {createRequire} from 'node:module';const r=createRequire(process.cwd()+'/package.json');r('node-pty');r('msgpackr-extract');await import('@ff-labs/fff-node');"], { cwd: runtime.directory, timeout: 30_000, maxBuffer: 64_000 })
}
