import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GhostStore } from '../../src/main/storage'
import { findMarkdownByIdentity, scanAndSeedExplorer, scanExplorer } from '../../src/main/explorer'

const run = promisify(execFile)
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stratamd-explorer-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('explorer scanning', () => {
  it('honors gitignore, skips node_modules, follows symlinks safely, and deduplicates overlaps', async () => {
    const root = await temporaryDirectory()
    await run('git', ['init', '-q', root])
    await writeFile(join(root, '.gitignore'), 'ignored.md\nnested/private.markdown\n')
    await mkdir(join(root, 'nested'))
    await mkdir(join(root, 'node_modules'))
    await Promise.all([
      writeFile(join(root, 'visible.md'), ''),
      writeFile(join(root, 'ignored.md'), ''),
      writeFile(join(root, 'notes.txt'), ''),
      writeFile(join(root, 'nested', 'visible.markdown'), ''),
      writeFile(join(root, 'nested', 'private.markdown'), ''),
      writeFile(join(root, 'node_modules', 'package.md'), ''),
    ])
    await symlink(root, join(root, 'nested', 'loop'))
    await symlink(join(root, 'visible.md'), join(root, 'nested', 'alias.md'))

    const result = await scanExplorer([root, join(root, 'nested')])
    expect(result.files.map((file) => file.path)).toEqual([
      join(root, 'nested', 'visible.markdown'),
      join(root, 'visible.md'),
    ])
    expect(result.files.find((file) => file.path.endsWith('visible.md'))?.displayPath).toBe(
      join(root, 'visible.md'),
    )
  })

  it('includes missing stored documents under configured roots', async () => {
    const root = await temporaryDirectory()
    const missing = join(root, 'gone.md')
    const result = await scanExplorer([root], { knownDocuments: [{ realpath: missing }] })
    expect(result.files).toContainEqual(expect.objectContaining({ path: missing, missing: true }))
  })

  it('Scan seeds every ghost from the document itself and skips invalid UTF-8', async () => {
    const root = await temporaryDirectory()
    await run('git', ['init', '-q', root])
    await run('git', ['-C', root, 'config', 'user.name', 'Test'])
    await run('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    const tracked = join(root, 'tracked.md')
    const untracked = join(root, 'untracked.md')
    const invalid = join(root, 'invalid.md')
    await writeFile(tracked, 'head\n')
    await run('git', ['-C', root, 'add', 'tracked.md'])
    await run('git', ['-C', root, 'commit', '-qm', 'tracked'])
    await writeFile(tracked, 'working\n')
    await writeFile(untracked, 'new\n')
    await writeFile(invalid, Buffer.from([0x80]))

    // Git plays no part in Scan seeding (PRD §6.3): a tracked file with
    // uncommitted edits and an untracked file both seed from disk content.
    const store = new GhostStore({ dataDirectory: join(root, '.data') })
    const result = await scanAndSeedExplorer([root], store)
    expect(result.seeded).toEqual([tracked, untracked])
    expect(result.skippedInvalidUtf8).toEqual([invalid])
    expect(await store.getObjectText((await store.loadMeta(tracked)).ghostBlob)).toBe('working\n')
    expect(await store.getObjectText((await store.loadMeta(untracked)).ghostBlob)).toBe('new\n')
  })

  it('finds a moved open document across roots without gitignore and refuses ambiguous hard links', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'source.md')
    const ignoredDirectory = join(root, 'ignored')
    await mkdir(ignoredDirectory)
    await writeFile(join(root, '.gitignore'), 'ignored/\n')
    await writeFile(source, 'same inode')
    const identity = await stat(source, { bigint: true })
    const moved = join(ignoredDirectory, 'moved.md')
    const { rename } = await import('node:fs/promises')
    await rename(source, moved)

    expect(await findMarkdownByIdentity([root], identity, [source])).toBe(moved)

    const alias = join(root, 'alias.md')
    await link(moved, alias)
    expect(await findMarkdownByIdentity([root], identity, [source])).toBeNull()
  })
})
