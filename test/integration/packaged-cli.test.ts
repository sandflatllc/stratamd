import { execFile } from 'node:child_process'
import { mkdtemp, readlink, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { AGENT_HELP } from '../../src/cli/agent-help.js'

const executeFile = promisify(execFile)
const packagedRoot = process.env.STRATAMD_PACKAGED_ROOT
const describePackaged = packagedRoot ? describe : describe.skip
const temporaryDirectories: string[] = []

afterAll(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })))
})

describePackaged('packaged CLI', () => {
  it('runs from the unpacked build and setup links that packaged executable', async () => {
    const root = resolve(packagedRoot!)
    const executable = join(root, 'stratamd')
    const guiExecutable = join(root, 'stratamd-app')
    expect((await stat(executable)).mode & 0o111).not.toBe(0)
    expect((await stat(guiExecutable)).mode & 0o111).not.toBe(0)

    const help = await executeFile(executable, ['--agent-help'])
    expect(help.stderr).toBe('')
    expect(help.stdout).toBe(`${AGENT_HELP}\n`)

    const home = await mkdtemp(join(tmpdir(), 'stratamd-packaged-'))
    temporaryDirectories.push(home)
    const data = join(home, 'data')
    const environment = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: data,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_RUNTIME_DIR: join(home, 'run')
    }
    await executeFile(executable, ['setup'], { env: environment })
    const installed = join(home, '.local', 'bin', 'stratamd')
    expect(await readlink(installed)).toBe(executable)
    expect((await executeFile(installed, ['--agent-help'], { env: environment })).stdout).toBe(`${AGENT_HELP}\n`)

    const document = join(home, 'offline.md')
    await writeFile(document, '# Packaged CLI\n\nOffline state.\n')
    const state = await executeFile(installed, ['state', document], { env: environment })
    expect(JSON.parse(state.stdout)).toMatchObject({
      version: 11,
      event: 'state',
      file: document,
      document: '# Packaged CLI\n\nOffline state.\n'
    })

    await executeFile(executable, ['setup', '--remove'], { env: environment })
    await expect(stat(installed)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)
})
