import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { executableCandidates, nodeCommand } from '../../src/platform/commands'
import { findProviderExecutable } from '../../src/main/engine/local-usage'

it('finds a configured tilde path outside the engine working directory', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'provider-path-'))
  const binary = join(root, 'codex.js')
  try {
    await writeFile(binary, '', { mode: 0o700 })
    expect(await findProviderExecutable(`~/${relative(homedir(), binary)}`, root, '')).toBe(binary)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('uses runnable Windows suffixes instead of npm shell siblings and expands Windows homes', () => {
  const context = { platform: 'win32', home: 'C:\\Users\\Owner' }
  expect(executableCandidates('codex', 'C:\\engine', 'C:\\npm;D:\\bin', context)).toEqual([
    'C:\\npm\\codex.exe', 'C:\\npm\\codex.com', 'C:\\npm\\codex.cmd', 'C:\\npm\\codex.bat',
    'D:\\bin\\codex.exe', 'D:\\bin\\codex.com', 'D:\\bin\\codex.cmd', 'D:\\bin\\codex.bat',
  ])
  expect(executableCandidates('~\\tools\\claude.cmd', 'D:\\engine', '', context)).toEqual(['C:\\Users\\Owner\\tools\\claude.cmd'])
  expect(executableCandidates('~/tools/claude.cmd', 'D:\\engine', '', context)).toEqual(['C:\\Users\\Owner\\tools\\claude.cmd'])
})

it('resolves npm cmd shims to JavaScript without evaluating shell arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provider-shim-'))
  const launcher = join(root, 'claude.cmd'), entry = join(root, 'node_modules', 'provider', 'cli.js')
  try {
    await mkdir(join(root, 'node_modules', 'provider'), { recursive: true })
    await writeFile(entry, '')
    await writeFile(launcher, '@echo off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\provider\\cli.js" %*\r\n')
    expect(await nodeCommand(launcher, ['a & b', '%PATH%'], process.execPath, 'win32')).toEqual({ executable: process.execPath, args: [entry, 'a & b', '%PATH%'] })
    expect(await nodeCommand(entry, [], process.execPath, 'win32')).toEqual({ executable: process.execPath, args: [entry] })
    await writeFile(launcher, '@echo off\r\nunknown-command %*\r\n')
    await expect(nodeCommand(launcher, [], process.execPath, 'win32')).rejects.toThrow('Cannot run the launcher')
  } finally { await rm(root, { recursive: true, force: true }) }
})
