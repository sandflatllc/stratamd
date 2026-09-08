import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { contextBridge, ipcRenderer } from 'electron'
import type { AppView, StrataApi } from '../../src/shared/contracts'
import type { SyncedView, ViewUpdate } from '../../src/shared/view-sync'
import { IPC } from '../../src/preload/channels'
import { EMPTY_VIEW } from '../../src/renderer/model'

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), invoke: vi.fn(), send: vi.fn() },
  webUtils: {},
}))

let api: StrataApi & { viewSyncDiagnostics(): { seq: number; resyncs: number; verifyMismatches: number } }
let receive: (update: ViewUpdate) => void
const view = (): AppView => structuredClone(EMPTY_VIEW)
const changed = (seq: number, base = seq - 1): ViewUpdate => ({ seq, base, sections: { engine: { ...view().engine, activeThreadId: `thread-${seq}` } } })

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ seq: 1, view: view() })
  await import('../../src/preload/index')
  api = vi.mocked(contextBridge.exposeInMainWorld).mock.calls.find(([name]) => name === 'strata')![1] as typeof api
  const listener = vi.mocked(ipcRenderer.on).mock.calls.find(([channel]) => channel === IPC.stateChanged)![1]
  receive = update => listener({} as Electron.IpcRendererEvent, update)
  await api.getState()
})
afterEach(() => vi.restoreAllMocks())

it('applies each update once for multiple subscribers and unsubscribes them independently', () => {
  const first = vi.fn(), second = vi.fn()
  const unsubscribe = api.subscribe(first)
  api.subscribe(second)
  for (let seq = 2; seq <= 11; seq++) receive(changed(seq))
  expect(first).toHaveBeenCalledTimes(10)
  expect(second).toHaveBeenCalledTimes(10)
  expect(second.mock.lastCall![0].engine.activeThreadId).toBe('thread-11')
  expect(api.viewSyncDiagnostics()).toEqual({ seq: 11, resyncs: 0, verifyMismatches: 0 })
  expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1)
  unsubscribe()
  receive(changed(12))
  expect(first).toHaveBeenCalledTimes(10)
  expect(second).toHaveBeenCalledTimes(11)
})

it('shares gap recovery and never rewinds a newer update when the snapshot arrives late', async () => {
  let resolve!: (value: SyncedView) => void
  vi.mocked(ipcRenderer.invoke).mockReturnValueOnce(new Promise<SyncedView>(done => { resolve = done }))
  const first = vi.fn(), second = vi.fn()
  const unsubscribe = api.subscribe(first)
  api.subscribe(second)
  receive(changed(3))
  receive(changed(4))
  expect(ipcRenderer.invoke).toHaveBeenCalledTimes(2)
  unsubscribe()
  receive({ seq: 5, full: { ...view(), engine: { ...view().engine, activeThreadId: 'newest' } } })
  resolve({ seq: 4, view: view() })
  await vi.waitFor(() => expect(api.viewSyncDiagnostics().seq).toBe(5))
  await api.getState()
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
  expect(second.mock.lastCall![0].engine.activeThreadId).toBe('newest')
  receive(changed(6))
  expect(second).toHaveBeenCalledTimes(2)
  expect(api.viewSyncDiagnostics().resyncs).toBe(1)
})

it('notifies surviving subscribers when a shared recovery finishes', async () => {
  let resolve!: (value: SyncedView) => void
  vi.mocked(ipcRenderer.invoke).mockReturnValueOnce(new Promise<SyncedView>(done => { resolve = done }))
  const first = vi.fn(), second = vi.fn()
  const unsubscribe = api.subscribe(first)
  api.subscribe(second)
  receive(changed(3))
  receive(changed(4))
  unsubscribe()
  resolve({ seq: 4, view: { ...view(), engine: { ...view().engine, activeThreadId: 'recovered' } } })
  await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1))
  expect(first).not.toHaveBeenCalled()
  expect(second.mock.lastCall![0].engine.activeThreadId).toBe('recovered')
  expect(ipcRenderer.invoke).toHaveBeenCalledTimes(2)
})

it('can recover after a failed snapshot request without rejecting into the renderer', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(ipcRenderer.invoke).mockRejectedValueOnce(new Error('offline'))
  const listener = vi.fn()
  api.subscribe(listener)
  receive(changed(3))
  await vi.waitFor(() => expect(error).toHaveBeenCalled())
  vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce({ seq: 5, view: view() })
  receive(changed(5))
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
  expect(api.viewSyncDiagnostics().seq).toBe(5)
})

it('catches up a patch missed during recovery without needing another push', async () => {
  let resolve!: (value: SyncedView) => void
  vi.mocked(ipcRenderer.invoke)
    .mockReturnValueOnce(new Promise<SyncedView>(done => { resolve = done }))
    .mockResolvedValueOnce({ seq: 5, view: { ...view(), engine: { ...view().engine, activeThreadId: 'caught-up' } } })
  const listener = vi.fn()
  api.subscribe(listener)
  receive(changed(3))
  receive(changed(4))
  resolve({ seq: 3, view: view() })
  await vi.waitFor(() => expect(listener.mock.lastCall?.[0].engine.activeThreadId).toBe('caught-up'))
  expect(ipcRenderer.invoke).toHaveBeenCalledTimes(3)
  expect(api.viewSyncDiagnostics().seq).toBe(5)
})
