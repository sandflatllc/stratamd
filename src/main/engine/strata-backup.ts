import { readFile, writeFile, mkdir, readdir, copyFile, cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ENGINE_STORE_FILES, connectionDirectory } from './identity'
import { copyRuntimeDirectory } from '../../platform/runtime-copy'
import { type GhostStore, type AttachmentMeta, type DocumentMeta, atomicWriteFile } from '../storage'
interface Binding { attachments: Readonly<Record<string, AttachmentMeta>>; leadAgentId: string | null }
interface Snapshot { identity: string; documents: Record<string, Binding> }
const hashes = (binding: Binding) => [...new Set(Object.values(binding.attachments).flatMap(value => [value.baselineBlob, ...value.deliveries.flatMap(delivery => [delivery.snapshotBlob, ...(delivery.payloadBlob ? [delivery.payloadBlob] : [])])]))]
export function documentBinding(meta: DocumentMeta, identity: string): Binding {
  return meta.engineIdentity === identity ? { attachments: meta.attachments, leadAgentId: meta.leadAgentId ?? null } : meta.engineAttachments?.[identity] ?? { attachments: {}, leadAgentId: null }
}
export async function captureStrataEngine(store: GhostStore, identity: string, destination: string): Promise<void> {
  const directory = await connectionDirectory(store.dataDirectory, identity), target = join(destination, 'strata')
  await mkdir(join(target, 'objects'), { recursive: true, mode: 0o700 })
  for (const name of ENGINE_STORE_FILES.filter(name => name !== 'engine-credential.json')) {
    try { await copyFile(join(directory, name), join(target, name)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  for (const folder of ['composer-attachments', 'visual-evidence']) {
    try { await copyRuntimeDirectory(join(directory, folder), join(target, folder)) } catch (error) {
      try { await readdir(join(directory, folder)); throw error } catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing }
    }
  }
  const snapshot: Snapshot = { identity, documents: {} }
  for (const meta of await store.listDocuments()) {
    const binding = documentBinding(meta, identity)
    snapshot.documents[meta.realpath] = binding
    for (const hash of hashes(binding)) await writeFile(join(target, 'objects', hash), await store.getObject(hash), { mode: 0o600 })
  }
  await atomicWriteFile(join(target, 'bindings.json'), JSON.stringify(snapshot))
}
/** Engine state only. Markdown, buffers, review history and renderer drafts are never rewound. */
export async function restoreStrataEngine(store: GhostStore, source: string, applyDocument: (meta: DocumentMeta, binding: Binding, identity: string, archiveIdentity: string) => Promise<void>): Promise<void> {
  const target = join(source, 'strata')
  const snapshot = JSON.parse(await readFile(join(target, 'bindings.json'), 'utf8')) as Snapshot
  const directory = await connectionDirectory(store.dataDirectory, snapshot.identity)
  for (const name of ENGINE_STORE_FILES.filter(name => name !== 'engine-credential.json')) {
    await rm(join(directory, name), { force: true })
    try { await copyFile(join(target, name), join(directory, name)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  // Staged image and evidence ids are immutable. Merge saved files so newer unsent drafts retain their bytes.
  for (const folder of ['composer-attachments', 'visual-evidence']) {
    try { await cp(join(target, folder), join(directory, folder), { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true }) } catch (error) {
      try { await readdir(join(target, folder)); throw error } catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing }
    }
  }
  for (const hash of await readdir(join(target, 'objects'))) if (await store.putObject(await readFile(join(target, 'objects', hash))) !== hash) throw new Error(`Backup payload verification failed: ${hash}`)
  const archiveIdentity = `${snapshot.identity}:archive:${Date.now()}`
  for (const meta of await store.listDocuments()) await applyDocument(meta, snapshot.documents[meta.realpath] ?? { attachments: {}, leadAgentId: null }, snapshot.identity, archiveIdentity)
}
