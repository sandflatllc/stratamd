import { afterEach, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyRuntimeDirectory } from '../../src/platform/runtime-copy'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

it('copies runtime files independently while preserving relative dependency links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-runtime-copy-'))
  roots.push(root)
  const source = join(root, 'source'), destination = join(root, 'destination')
  await mkdir(join(source, 'packages'), { recursive: true })
  await writeFile(join(source, 'packages/runtime.js'), 'original')
  await symlink('packages/runtime.js', join(source, 'runtime.js'))

  await copyRuntimeDirectory(source, destination)
  expect((await lstat(join(destination, 'runtime.js'))).isSymbolicLink()).toBe(true)
  expect(await readlink(join(destination, 'runtime.js'))).toBe('packages/runtime.js')

  await writeFile(join(destination, 'packages/runtime.js'), 'changed')
  expect(await readFile(join(source, 'packages/runtime.js'), 'utf8')).toBe('original')
  expect(await readFile(join(destination, 'runtime.js'), 'utf8')).toBe('changed')
})
