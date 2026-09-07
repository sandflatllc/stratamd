import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const moduleURL = new URL('../../scripts/package-output.mjs', import.meta.url).href
const reserve = (path: string) => exec(process.execPath, ['--input-type=module', '-e', `import {reservePackageOutput} from ${JSON.stringify(moduleURL)};console.log(await reservePackageOutput(process.argv[1]))`, path])

it('reserves independent package outputs and refuses existing trees and symlink aliases before touching their bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-package-output-'))
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { cwd: root })
  try {
    const installation = join(root, 'installed')
    await mkdir(join(installation, 'resources'), { recursive: true })
    await writeFile(join(installation, 'resources/app.asar'), 'running installation sentinel')
    await symlink(installation, join(root, 'alias'))
    for (const path of [installation, join(root, 'alias'), join(root, 'alias/build'), join(installation, 'build')]) await expect(reserve(path)).rejects.toThrow()
    expect(await readFile(join(installation, 'resources/app.asar'), 'utf8')).toBe('running installation sentinel')
    expect((await reserve(join(root, 'fresh'))).stdout.trim()).toBe(resolve(root, 'fresh'))
    await expect(reserve(join(root, 'fresh'))).rejects.toThrow()
    const mac = join(root, 'Strata.app', 'Contents')
    await mkdir(mac, { recursive: true })
    await expect(reserve(join(mac, 'new'))).rejects.toThrow()
  } finally { child.kill(); await rm(root, { recursive: true, force: true }) }
})
