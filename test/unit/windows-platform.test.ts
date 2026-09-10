import { mkdtemp, readFile, rm, open, rename, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { getConfigDirectory, getDataDirectory } from '../../src/platform/paths'
import { linkCopyTarget } from '../../src/core/link-target'
import { classifyLocalLink } from '../../src/shared/local-link'
import { parentPath, joinPath } from '../../src/core/project-source'
import { relativeChangedPath } from '../../src/core/changed-files'
import { setup } from '../../src/cli/setup'
import { unixSupportBinding } from '../../src/platform/unix-support'
import { pathForDescriptor } from '../../src/platform/descriptor-path'
import { atomicWriteFile, ensurePrivateDirectory } from '../../src/main/storage'
import { processStamp, verifiedProcess, takeEngineLock } from '../../src/main/engine/managed-process'
import { windowFrameOptions } from '../../src/platform/window'
import { windowCapturePlatform } from '../../src/platform/window-capture'
import { setStartAtLogin } from '../../src/main/start-at-login'

describe('Windows platform contracts', () => {
  it('uses roaming config and local data, with isolated overrides', () => {
    const context = { platform: 'win32', home: 'C:\\Users\\Dillon', env: {} }
    expect(getConfigDirectory(context)).toBe('C:\\Users\\Dillon\\AppData\\Roaming\\stratamd')
    expect(getDataDirectory(context)).toBe('C:\\Users\\Dillon\\AppData\\Local\\stratamd')
    expect(getDataDirectory({ ...context, env: { LOCALAPPDATA: 'D:\\Local' } })).toBe('D:\\Local\\stratamd')
    expect(getDataDirectory({ ...context, env: { LOCALAPPDATA: 'D:\\Local', XDG_DATA_HOME: 'E:\\Test' } })).toBe('E:\\Test\\stratamd')
  })
  it('resolves drive-letter document links and keeps Windows roots', () => {
    expect(classifyLocalLink('C:\\Docs\\note.md')?.kind).toBe('markdown')
    expect(classifyLocalLink('file:///C:/Docs/a%20b.md')?.path).toBe('C:/Docs/a b.md')
    expect(linkCopyTarget('../other.md', 'C:\\Docs\\notes\\note.md')).toEqual({ kind: 'file', path: 'C:\\Docs\\other.md', written: '../other.md' })
    expect(linkCopyTarget('file:///C:/Docs/a%20b.md', '')).toEqual({ kind: 'file', path: 'C:\\Docs\\a b.md', written: 'file:///C:/Docs/a%20b.md' })
    expect(parentPath('C:\\Docs')).toBe('C:/')
    expect(parentPath('C:\\')).toBe('C:/')
    expect(parentPath('\\\\server\\share')).toBe('//server/share')
    expect(joinPath('C:\\Docs', 'notes')).toBe('C:/Docs/notes')
    expect(relativeChangedPath('C:\\Docs\\notes\\a.md', 'c:\\docs')).toBe('notes/a.md')
  })
  it('uses native window chrome, capture and Electron login registration', async () => {
    expect(windowFrameOptions('win32')).toEqual({ frame: true })
    expect(windowCapturePlatform('win32')).toMatchObject({ platform: 'win32', picker: 'windows', macPermissions: false, chromiumFeatures: [] })
    const calls: boolean[] = []
    await setStartAtLogin(true, 'C:\\Strata\\StrataMD.exe', 'win32', enabled => calls.push(enabled))
    expect(calls).toEqual([true])
  })
  it('installs a managed cmd launcher without administrator symlinks and refuses collisions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'strata-win-setup-'))
    try {
      const executable = join(home, 'Strata launcher.cmd')
      await atomicWriteFile(executable, '@echo off\r\n')
      const options = { platform: 'win32', home, environment: { LOCALAPPDATA: home }, executable }
      const installed = await setup(options)
      expect(await readFile(installed.link, 'utf8')).toContain(`"${executable}" %*`)
      await setup({ ...options, remove: true })
      await atomicWriteFile(installed.link, 'user file')
      await expect(setup(options)).rejects.toThrow()
      expect(await readFile(installed.link, 'utf8')).toBe('user file')
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})

describe.skipIf(process.platform !== 'win32')('Windows native storage and process ownership', () => {
  it('saves, follows renames, and releases kernel file locks on descriptor close', async () => {
    expect(tmpdir()).toBe(await realpath(tmpdir()))
    const root = await mkdtemp(join(tmpdir(), 'strata-win-storage-'))
    try {
      await ensurePrivateDirectory(join(root, 'data'))
      const path = join(root, 'data', 'note.md'), moved = join(root, 'data', 'renamed.md')
      await atomicWriteFile(path, '# Original\r\n')
      const descriptor = await open(path, 'r')
      try {
        await rename(path, moved)
        expect(await pathForDescriptor(descriptor.fd)).toBe(await realpath(moved))
      } finally { await descriptor.close() }
      await atomicWriteFile(moved, '# Changed\r\n')
      expect(await readFile(moved, 'utf8')).toBe('# Changed\r\n')
      const release = await takeEngineLock(root)
      await expect(takeEngineLock(root)).rejects.toThrow(/Another Strata/)
      await release()
      await (await takeEngineLock(root))()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('verifies a live process by kernel creation time and executable', async () => {
    const record = { pid: process.pid, ...await processStamp(process.pid), executable: process.execPath, baseDirectory: process.cwd() }
    expect(unixSupportBinding().processInfo?.(process.pid).startTime).toBe(record.startTime)
    expect(await verifiedProcess(record)).toBe(true)
    expect(await verifiedProcess({ ...record, executable: join(process.cwd(), 'different.exe') })).toBe(false)
    expect(await verifiedProcess({ ...record, startTime: 'different-incarnation' })).toBe(false)
  })
})
