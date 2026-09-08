import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStrataApplication, type StrataApplication } from '../../src/main/application'
import * as explorer from '../../src/main/explorer'
import * as log from '../../src/main/log'
import { SettingsStore } from '../../src/main/settings'
import { GhostStore } from '../../src/main/storage'

const applications: StrataApplication[] = []
const roots: string[] = []
const scanExplorer = explorer.scanExplorer

afterEach(async () => {
  await Promise.all(applications.splice(0).map(app => app.shutdown()))
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stratamd-explorer-startup-'))
  roots.push(root)
  const folder = join(root, 'plans')
  await mkdir(folder)
  const path = join(folder, 'next.md')
  await writeFile(path, '# Next plan\n')
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  await store.initialize()
  await writeFile(join(store.dataDirectory, 'open-documents.json'), JSON.stringify({ formatVersion: 1, documents: [path], focused: path }))
  const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
  await settingsStore.update({ explorerFolders: [folder] })
  const app = await createStrataApplication({ store, settingsStore, watch: false })
  applications.push(app)
  return { app, folder, path }
}

/** Hold actual scanning until the test releases it or the application cancels it. */
function holdScan() {
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  vi.spyOn(explorer, 'scanExplorer').mockImplementationOnce(async (folders, options) => {
    const signal = options!.signal!
    entered.resolve(signal)
    const cancel = () => release.reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      await release.promise
      return await scanExplorer(folders, options)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  })
  return { entered: entered.promise, release: () => release.resolve() }
}

describe('background explorer startup', () => {
  it('restores documents and exposes folder roots while scanning is held, then publishes the index', async () => {
    const pending = holdScan()
    const { app, folder, path } = await fixture()
    await pending.entered
    expect((await app.getState()).explorer).toEqual([expect.objectContaining({ path: folder, files: [] })])
    expect(await app.restoreOpenDocuments()).toEqual([path])
    expect((await app.getState()).activeDocument?.content).toBe('# Next plan\n')
    pending.release()
    await expect.poll(async () => (await app.getState()).explorer[0]?.files.map(file => file.path)).toEqual([path])
  })

  it('cancels startup scanning when a folder is removed and keeps the newer index', async () => {
    const pending = holdScan()
    const { app, folder } = await fixture()
    const signal = await pending.entered
    await app.removeFolder(folder)
    expect(signal.aborted).toBe(true)
    expect((await app.getState()).explorer).toEqual([])
  })

  it('cancels a held startup scan on shutdown', async () => {
    const pending = holdScan()
    const { app } = await fixture()
    const signal = await pending.entered
    await app.shutdown()
    expect(signal.aborted).toBe(true)
  })

  it('keeps documents usable after a failed scan and allows refresh to recover', async () => {
    const error = new Error('Cannot read the plans directory')
    vi.spyOn(explorer, 'scanExplorer').mockRejectedValueOnce(error)
    const report = vi.spyOn(log, 'logError').mockImplementation(() => undefined)
    const { app, path } = await fixture()
    await expect.poll(() => report.mock.calls.length).toBe(1)
    expect(report).toHaveBeenCalledWith('explorer', 'Startup folder scan failed', error)
    await app.restoreOpenDocuments()
    expect((await app.getState()).activeDocument?.content).toBe('# Next plan\n')
    await app.refreshExplorer()
    expect((await app.getState()).explorer[0]?.files.map(file => file.path)).toEqual([path])
  })
})
