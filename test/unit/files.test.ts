import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  atomicWriteDocument,
  readDocument,
  resolveAllowedLocalPath,
  saveDocumentWithHashCheck,
  seedGhostFromGit,
} from '../../src/main/files'

const run = promisify(execFile)
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stratamd-files-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('document I/O', () => {
  it('detects invalid UTF-8 without replacing bytes', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'invalid.md')
    await writeFile(path, Buffer.from([0x66, 0x80, 0x6f]))
    const result = await readDocument(path)
    expect(result.validUtf8).toBe(false)
    expect(result.bytes).toEqual(Buffer.from([0x66, 0x80, 0x6f]))
  })

  it('preserves mode and refuses an intervening write', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'save.md')
    await writeFile(path, 'base\n')
    await chmod(path, 0o640)
    const base = await readDocument(path)
    await writeFile(path, 'external\n')
    const conflict = await saveDocumentWithHashCheck(path, 'mine\n', base.hash)
    expect(conflict.status).toBe('conflict')
    expect(await readFile(path, 'utf8')).toBe('external\n')

    const external = await readDocument(path)
    const saved = await saveDocumentWithHashCheck(path, 'accepted\n', external.hash)
    expect(saved.status).toBe('saved')
    expect((await stat(path)).mode & 0o777).toBe(0o640)
  })

  it('can recreate a deleted document atomically', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'recreated.md')
    const saved = await atomicWriteDocument(path, 'back\n')
    expect(saved.bytes.toString('utf8')).toBe('back\n')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

describe('ghost seeding', () => {
  it('uses filtered HEAD, empty for an untracked file, and disk outside git', async () => {
    const directory = await temporaryDirectory()
    await run('git', ['init', '-q', directory])
    await run('git', ['-C', directory, 'config', 'user.name', 'Test'])
    await run('git', ['-C', directory, 'config', 'user.email', 'test@example.com'])
    await writeFile(join(directory, '.gitattributes'), '*.md text eol=crlf\n')
    const tracked = join(directory, 'tracked.md')
    await writeFile(tracked, 'at head\r\n')
    await run('git', ['-C', directory, 'add', '.gitattributes', 'tracked.md'])
    await run('git', ['-C', directory, 'commit', '-qm', 'seed'])
    await writeFile(tracked, 'working change\r\n')

    const fromHead = await seedGhostFromGit(tracked)
    expect(fromHead.source).toBe('head')
    expect(fromHead.content.toString()).toBe('at head\r\n')

    const untracked = join(directory, 'new.md')
    await writeFile(untracked, 'new\r\n')
    expect(await seedGhostFromGit(untracked)).toMatchObject({ source: 'empty', content: Buffer.alloc(0) })

    await writeFile(join(directory, '.gitignore'), 'ignored.md\n')
    const ignored = join(directory, 'ignored.md')
    await writeFile(ignored, 'ignored current\r\n')
    expect(await seedGhostFromGit(ignored)).toMatchObject({
      source: 'empty',
      content: Buffer.alloc(0),
    })

    const outside = await temporaryDirectory()
    const plain = join(outside, 'plain.md')
    await writeFile(plain, 'plain\n')
    expect(await seedGhostFromGit(plain)).toMatchObject({ source: 'disk', content: Buffer.from('plain\n') })
  })
})

describe('local path security', () => {
  it('allows only resolved paths under the document directory or explorer roots', async () => {
    const directory = await temporaryDirectory()
    const other = await temporaryDirectory()
    await mkdir(join(directory, 'images'))
    const document = join(directory, 'doc.md')
    const image = join(directory, 'images', 'ok.png')
    const secret = join(other, 'secret.png')
    await Promise.all([writeFile(document, ''), writeFile(image, ''), writeFile(secret, '')])
    await symlink(secret, join(directory, 'images', 'escape.png'))

    expect(await resolveAllowedLocalPath('images/ok.png', document, [])).toBe(image)
    expect(await resolveAllowedLocalPath('https://example.com/a.png', document, [])).toBeUndefined()
    expect(await resolveAllowedLocalPath('images/escape.png', document, [])).toBeUndefined()
    expect(await resolveAllowedLocalPath(secret, document, [other])).toBe(secret)
  })
})
