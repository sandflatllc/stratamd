import { expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ processInfo: vi.fn() }))
vi.mock('../../src/platform/runtime', () => ({ isWindows: () => true, isDarwin: () => false }))
vi.mock('../../src/platform/unix-support', () => ({ unixSupportBinding: () => native }))
vi.mock('../../src/platform/process-identity', () => ({ bootId: async () => 'windows-filetime-v1', processStartTime: async () => 'creation-time' }))
vi.mock('node:child_process', () => ({ execFile: vi.fn(() => { throw new Error('Health must not start a shell') }) }))
import { execFile } from 'node:child_process'
import { verifiedProcess } from '../../src/main/engine/managed-process'

it('checks Windows process ownership without spawning PowerShell and rejects a recycled PID', async () => {
  const record = { pid: 123, bootId: 'windows-filetime-v1', startTime: 'creation-time', executable: process.execPath, baseDirectory: process.cwd() }
  native.processInfo.mockReturnValue({ startTime: record.startTime, executable: process.execPath })
  expect(await verifiedProcess(record)).toBe(true)
  expect(execFile).not.toHaveBeenCalled()
  native.processInfo.mockReturnValue({ startTime: 'new-incarnation', executable: process.execPath })
  expect(await verifiedProcess(record)).toBe(false)
  native.processInfo.mockImplementation(() => { throw new Error('Process exited') })
  expect(await verifiedProcess(record)).toBe(false)
})
