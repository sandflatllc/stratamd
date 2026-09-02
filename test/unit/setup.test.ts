import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveSkillTarget, setup, type SetupCommandRunner } from '../../src/cli/setup.js'

const temporaryDirectories: string[] = []
const executable = join(process.cwd(), 'bin', 'stratamd')
const skillSource = join(process.cwd(), 'skills', 'stratamd', 'SKILL.md')
const okRunner: SetupCommandRunner = () => ({ status: 0, stdout: '', stderr: '' })

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(home)
  return home
}

function linuxOptions(home: string, environment: NodeJS.ProcessEnv = {}) {
  return {
    platform: 'linux',
    home,
    executable,
    environment: {
      HOME: home,
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CONFIG_HOME: join(home, 'config'),
      PATH: `${join(home, '.local', 'bin')}:/usr/bin`,
      ...environment
    },
    commandRunner: okRunner
  }
}

describe('setup --skill', () => {
  it('maps harness names to their skills directories and takes any other value as a directory', () => {
    expect(resolveSkillTarget('claude', '/home/me', {})).toBe('/home/me/.claude/skills/stratamd')
    expect(resolveSkillTarget('codex', '/home/me', {})).toBe('/home/me/.codex/skills/stratamd')
    expect(resolveSkillTarget('codex', '/home/me', { CODEX_HOME: '/opt/codex' })).toBe('/opt/codex/skills/stratamd')
    expect(resolveSkillTarget('agents', '/home/me', {})).toBe('/home/me/.agents/skills/stratamd')
    expect(resolveSkillTarget('/srv/skills', '/home/me', {})).toBe('/srv/skills/stratamd')
    expect(resolveSkillTarget('~/mine', '/home/me', {})).toBe('/home/me/mine/stratamd')
  })

  it('installs the skill for claude, reports unchanged on repeat, and refreshes a stale copy', async () => {
    const home = await temporaryHome('stratamd-skill-claude-')
    const installed = join(home, '.claude', 'skills', 'stratamd', 'SKILL.md')
    const source = await readFile(skillSource, 'utf8')

    const first = await setup({ ...linuxOptions(home), skill: 'claude' })
    expect(first.skill).toMatchObject({
      target: 'claude',
      path: dirname(installed),
      status: 'installed'
    })
    expect(first.skill?.files).toContain('SKILL.md')
    expect(first.skill?.resolved).toBeUndefined()
    expect(first.hint).toBeUndefined()
    expect(await readFile(installed, 'utf8')).toBe(source)

    const second = await setup({ ...linuxOptions(home), skill: 'claude' })
    expect(second.skill?.status).toBe('unchanged')

    await writeFile(installed, 'stale copy\n')
    const third = await setup({ ...linuxOptions(home), skill: 'claude' })
    expect(third.skill?.status).toBe('updated')
    expect(await readFile(installed, 'utf8')).toBe(source)
  })

  it('writes through a symlinked skill directory and keeps the link', async () => {
    const home = await temporaryHome('stratamd-skill-link-')
    const canonical = join(home, '.agents', 'skills', 'stratamd')
    const link = join(home, '.claude', 'skills', 'stratamd')
    await mkdir(canonical, { recursive: true })
    await writeFile(join(canonical, 'SKILL.md'), 'stale copy\n')
    await mkdir(dirname(link), { recursive: true })
    await symlink(canonical, link)

    const result = await setup({ ...linuxOptions(home), skill: 'claude' })
    expect(result.skill).toMatchObject({ path: link, resolved: await realpath(canonical), status: 'updated' })
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toBe(await readFile(skillSource, 'utf8'))
  })

  it('installs into an explicit directory on macOS, where setup runs no commands', async () => {
    const home = await temporaryHome('stratamd-skill-dir-')
    const result = await setup({
      platform: 'darwin',
      home,
      executable,
      environment: { HOME: home, PATH: join(home, '.local', 'bin') },
      commandRunner: (() => { throw new Error('setup must not run commands on macOS') }) satisfies SetupCommandRunner,
      skill: join(home, 'custom-skills')
    })
    expect(result).toMatchObject({ ok: true, platform: 'darwin', action: 'install', warnings: [] })
    expect(result.skill).toMatchObject({ path: join(home, 'custom-skills', 'stratamd'), status: 'installed' })
    await stat(join(home, 'custom-skills', 'stratamd', 'SKILL.md'))
  })

  it('refuses a file where the skill directory should be', async () => {
    const home = await temporaryHome('stratamd-skill-conflict-')
    const path = join(home, '.agents', 'skills', 'stratamd')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not a directory\n')
    await expect(setup({ ...linuxOptions(home), skill: 'agents' })).rejects.toMatchObject({
      code: 'SETUP_CONFLICT',
      detail: { path, hint: expect.stringContaining('setup --skill') }
    })
  })

  it('points at --skill when setup runs without it', async () => {
    const home = await temporaryHome('stratamd-skill-hint-')
    const result = await setup(linuxOptions(home))
    expect(result).toMatchObject({
      ok: true,
      platform: 'linux',
      action: 'install',
      link: join(home, '.local', 'bin', 'stratamd'),
      executable,
      warnings: []
    })
    expect(result.skill).toBeUndefined()
    expect(result.hint).toContain('setup --skill claude')

    const removed = await setup({ ...linuxOptions(home), remove: true })
    expect(removed).toMatchObject({ ok: true, action: 'remove' })
    expect(removed.hint).toBeUndefined()
  })
})

describe('setup warnings and conflicts', () => {
  it.each([
    ['update-desktop-database', 'desktop-file-utils'],
    ['update-mime-database', 'shared-mime-info']
  ] as const)('warns with the package name when %s is missing, and still installs', async (missing, pkg) => {
    const home = await temporaryHome('stratamd-setup-missing-tool-')
    const runner: SetupCommandRunner = (command) => command === missing
      ? { status: null, error: Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }) }
      : { status: 0, stdout: '', stderr: '' }
    const notices: string[] = []

    const result = await setup({
      ...linuxOptions(home),
      commandRunner: runner,
      report: (text) => { notices.push(text) }
    })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(`${missing} is not installed`)
    expect(result.warnings[0]).toContain(pkg)
    expect(notices.join('')).toContain(pkg)
    await stat(join(home, 'data', 'applications', 'stratamd.desktop'))
    await stat(join(home, '.local', 'bin', 'stratamd'))
  })

  it('warns when a database tool fails and includes its stderr', async () => {
    const home = await temporaryHome('stratamd-setup-failing-tool-')
    const runner: SetupCommandRunner = (command) => command === 'update-mime-database'
      ? { status: 1, stderr: 'permission denied' }
      : { status: 0, stdout: '', stderr: '' }
    const result = await setup({ ...linuxOptions(home), commandRunner: runner })
    expect(result.warnings).toEqual([expect.stringContaining('update-mime-database failed: permission denied')])
  })

  it('warns on Linux when ~/.local/bin is not on PATH', async () => {
    const home = await temporaryHome('stratamd-setup-path-')
    const notices: string[] = []
    const result = await setup({
      ...linuxOptions(home, { PATH: '/usr/bin:/bin' }),
      report: (text) => { notices.push(text) }
    })
    expect(result.warnings.join('')).toContain('.local/bin is not on your PATH')
    expect(notices.join('')).toContain('.local/bin is not on your PATH')
  })

  it('names the existing target and the way out in SETUP_CONFLICT', async () => {
    const home = await temporaryHome('stratamd-setup-conflict-')
    const link = join(home, '.local', 'bin', 'stratamd')
    await mkdir(dirname(link), { recursive: true })
    await symlink('/opt/old-stratamd/stratamd', link)
    await expect(setup(linuxOptions(home))).rejects.toMatchObject({
      code: 'SETUP_CONFLICT',
      message: expect.stringContaining('/opt/old-stratamd/stratamd'),
      detail: {
        link,
        existing: '/opt/old-stratamd/stratamd',
        hint: expect.stringContaining('/opt/old-stratamd/stratamd setup --remove')
      }
    })
  })

  it('refuses a plain file at the link path', async () => {
    const home = await temporaryHome('stratamd-setup-file-conflict-')
    const link = join(home, '.local', 'bin', 'stratamd')
    await mkdir(dirname(link), { recursive: true })
    await writeFile(link, '#!/bin/sh\n')
    await expect(setup(linuxOptions(home))).rejects.toMatchObject({
      code: 'SETUP_CONFLICT',
      detail: { link, existing: null }
    })
  })
})
