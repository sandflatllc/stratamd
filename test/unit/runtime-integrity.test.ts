import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { verifyRuntime, type StagedRuntime } from '../../src/main/engine/managed-runtime'

it('refuses a corrupt runtime file even when other verification batches succeed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-integrity-'))
  const runtime: StagedRuntime = { directory, version: 'fixture', nodeVersion: '24', platform: process.platform, arch: process.arch, executable: 'node', entry: 'entry', integrity: 'integrity.json' }
  try {
    const files: Record<string, { sha256: string }> = {}
    for (let index = 0; index < 24; index++) {
      const name = `payload-${index}`
      await writeFile(join(directory, name), index === 23 ? 'changed bytes' : 'original bytes')
      files[name] = { sha256: createHash('sha256').update('original bytes').digest('hex') }
    }
    await writeFile(join(directory, 'integrity.json'), JSON.stringify({ files }))
    await expect(verifyRuntime(runtime)).rejects.toThrow('Runtime integrity verification failed at ' + join(directory, 'payload-23'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('refuses a runtime symlink outside its directory even when its recorded target matches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-integrity-'))
  const runtime: StagedRuntime = { directory, version: 'fixture', nodeVersion: '24', platform: process.platform, arch: process.arch, executable: 'node', entry: 'entry', integrity: 'integrity.json' }
  try {
    await symlink('../outside', join(directory, 'dependency'))
    await writeFile(join(directory, 'integrity.json'), JSON.stringify({ files: { dependency: { link: '../outside' } } }))
    await expect(verifyRuntime(runtime)).rejects.toThrow('Runtime link verification failed')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
