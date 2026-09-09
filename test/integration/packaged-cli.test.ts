import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readlink, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { AGENT_HELP } from '../../src/cli/agent-help.js'

const executeFile = promisify(execFile)
const temporaryDirectories: string[] = []

export interface PackagedLayout {
  readonly root: string
  readonly cli: string
  readonly gui: string
}

/** Where the CLI script and GUI binary live inside each packaged build (mac-plan §4.4). */
export function packagedLayout(platform: string, root: string): PackagedLayout {
  if (platform === 'darwin') {
    return {
      root,
      cli: join(root, 'Contents', 'Resources', 'bin', 'stratamd'),
      gui: join(root, 'Contents', 'MacOS', 'StrataMD'),
    }
  }
  return {
    root,
    cli: join(root, 'stratamd'),
    gui: join(root, 'stratamd-app'),
  }
}

/** The Linux unpacked directory, or the .app inside electron-builder's arch-suffixed mac output. */
async function discoverPackagedRoot(): Promise<string | undefined> {
  if (process.env.STRATAMD_PACKAGED_ROOT) return resolve(process.env.STRATAMD_PACKAGED_ROOT)
  // Discovery runs only for test:packaged; a plain `pnpm test` with a stale
  // dist directory must not silently grow a two-minute packaged run.
  if (process.env.STRATAMD_PACKAGED_TEST !== '1') return undefined
  const dist = JSON.parse(await readFile('build/latest-package.json', 'utf8')).output as string
  if (process.platform === 'darwin') {
    let entries
    try {
      entries = await readdir(dist)
    } catch {
      return undefined
    }
    for (const entry of entries.filter((name) => name.startsWith('mac'))) {
      const candidate = join(dist, entry, 'StrataMD.app')
      try {
        await stat(candidate)
        return candidate
      } catch {
        // Keep looking; dir output is arch-suffixed (mac, mac-arm64).
      }
    }
    return undefined
  }
  const candidate = join(dist, 'linux-unpacked')
  try {
    await stat(candidate)
    return candidate
  } catch {
    return undefined
  }
}

const packagedRoot = await discoverPackagedRoot()
const describePackaged = packagedRoot ? describe : describe.skip

afterAll(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })))
})

describe('packaged layout calculations', () => {
  it('places the CLI beside the Linux binary and under Contents/Resources/bin on macOS', () => {
    expect(packagedLayout('linux', '/opt/strata')).toEqual({
      root: '/opt/strata',
      cli: '/opt/strata/stratamd',
      gui: '/opt/strata/stratamd-app',
    })
    expect(packagedLayout('darwin', '/Applications/StrataMD.app')).toEqual({
      root: '/Applications/StrataMD.app',
      cli: '/Applications/StrataMD.app/Contents/Resources/bin/stratamd',
      gui: '/Applications/StrataMD.app/Contents/MacOS/StrataMD',
    })
  })
})

describePackaged('packaged CLI', () => {
  it('ships the native accessibility module and selected-window helper outside the archive', async () => {
    const layout = packagedLayout(process.platform, packagedRoot!)
    const resources = process.platform === 'darwin' ? join(layout.root, 'Contents', 'Resources') : join(layout.root, 'resources')
    const archive = join(resources, 'app.asar')
    const load = await executeFile(layout.gui, ['-e', 'const root=process.argv[1]; const fs=require("node:fs"); const p=require("node:path"); const a=require(p.join(root,"node_modules/@crowecawcaw/xa11y")); if(typeof a.App.byPid!=="function")throw Error("Native accessibility missing"); if(!fs.existsSync(p.join(root,"out/main/accessibility-worker.js")))throw Error("Worker missing"); console.log("native accessibility loaded")', archive], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    expect(load.stdout.trim()).toBe('native accessibility loaded')
    if (process.platform === 'linux') {
      const helper = join(resources, 'app.asar.unpacked', 'out', 'main', 'capture-x11')
      expect((await stat(helper)).mode & 0o111).not.toBe(0)
      // Invalid input exits before opening a display. No owner window is queried.
      await expect(executeFile(helper, ['invalid'])).rejects.toMatchObject({ code: 1 })
    }
    expect(await readFile(join(resources, 'resources', 'licenses', 't3-window-capture.txt'), 'utf8')).toContain('T3 Tools Inc.')
  })

  it('runs from the packaged build and setup links that packaged executable', async () => {
    const layout = packagedLayout(process.platform, packagedRoot!)
    expect((await stat(layout.cli)).mode & 0o111).not.toBe(0)
    expect((await stat(layout.gui)).mode & 0o111).not.toBe(0)

    const help = await executeFile(layout.cli, ['--agent-help'])
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
    await executeFile(layout.cli, ['setup'], { env: environment })
    const installed = join(home, '.local', 'bin', 'stratamd')
    expect(await readlink(installed)).toBe(layout.cli)
    expect((await executeFile(installed, ['--agent-help'], { env: environment })).stdout).toBe(`${AGENT_HELP}\n`)

    await executeFile(layout.cli, ['setup', '--remove'], { env: environment })
    await expect(stat(installed)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)
})
