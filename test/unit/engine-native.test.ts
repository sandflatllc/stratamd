import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
// @ts-expect-error Build helper is executed directly by Node.
import { pruneNativeBuild } from '../../scripts/engine-native.mjs'

it('retains Windows and Unix PTY runtime dependencies while removing machine-specific build output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pty-prune-'))
  const files = ['config.gypi', 'node-pty.sln', 'Release/obj/pty.obj', 'Release/pty.pdb', 'Release/pty.lib', 'Release/pty.node', 'Release/conpty.node', 'Release/winpty.dll', 'Release/winpty-agent.exe', 'Release/spawn-helper', 'Release/conpty/conpty.dll', 'Release/conpty/OpenConsole.exe', 'Release/conpty/debug.pdb']
  try {
    for (const file of files) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), file) }
    await pruneNativeBuild(root)
    expect(await readdir(root)).toEqual(['Release'])
    expect((await readdir(join(root, 'Release'))).sort()).toEqual(['conpty', 'conpty.node', 'pty.node', 'spawn-helper', 'winpty-agent.exe', 'winpty.dll'])
    expect((await readdir(join(root, 'Release/conpty'))).sort()).toEqual(['OpenConsole.exe', 'conpty.dll'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
