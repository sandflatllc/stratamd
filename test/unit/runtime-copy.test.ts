import { afterEach, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyRuntimeDirectory, publishRuntimeDirectory } from '../../src/platform/runtime-copy'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

it('copies runtime files independently while preserving relative dependency links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-runtime-copy-'))
  roots.push(root)
  const source = join(root, 'source with spaces'), destination = join(root, 'destination with spaces')
  await mkdir(join(source, 'packages'), { recursive: true })
  await mkdir(join(source, 'empty'), { recursive: true })
  await writeFile(join(source, 'packages/runtime.js'), 'original')
  await symlink('packages/runtime.js', join(source, 'runtime.js'))

  await copyRuntimeDirectory(source, destination)
  expect((await lstat(join(destination, 'empty'))).isDirectory()).toBe(true)
  expect((await lstat(join(destination, 'runtime.js'))).isSymbolicLink()).toBe(true)
  expect(await readlink(join(destination, 'runtime.js'))).toBe(await readlink(join(source, 'runtime.js')))

  await writeFile(join(destination, 'packages/runtime.js'), 'changed')
  expect(await readFile(join(source, 'packages/runtime.js'), 'utf8')).toBe('original')
  expect(await readFile(join(destination, 'runtime.js'), 'utf8')).toBe('changed')
})

it('refuses an unavailable source instead of reporting a successful empty copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-runtime-copy-'))
  roots.push(root)
  await expect(copyRuntimeDirectory(join(root, 'missing'), join(root, 'destination'))).rejects.toThrow()
})

it('keeps the original error when a runtime cannot be published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-runtime-publish-'))
  roots.push(root)
  await expect(publishRuntimeDirectory(join(root, 'missing'), join(root, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform !== 'win32')('publishes a runtime after a Windows working-directory lock is released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-runtime-publish-'))
  roots.push(root)
  const source = join(root, 'pending'), destination = join(root, 'runtime')
  await mkdir(source)
  await writeFile(join(source, 'runtime.json'), 'verified')
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); process.stdin.once('data', () => process.exit(0))"], { cwd: source, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  let release: ReturnType<typeof setTimeout> | undefined
  try {
    await once(child.stdout, 'data')
    await expect(rename(source, destination)).rejects.toMatchObject({ code: 'EBUSY' })
    release = setTimeout(() => child.stdin.write('release'), 150)
    await publishRuntimeDirectory(source, destination)
    expect(await readFile(join(destination, 'runtime.json'), 'utf8')).toBe('verified')
  } finally {
    clearTimeout(release)
    if (child.exitCode === null) child.kill()
    await closed
  }
})
