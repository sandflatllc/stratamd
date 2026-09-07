import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isAppRootNavigation, isLocalPage, isLocalPageSync, resolveLocalLink } from '../../src/main/local-link'
import { classifyLocalLink } from '../../src/shared/local-link'
import { pageName } from '../../src/shared/preview'

describe('classifyLocalLink', () => {
  it('leaves web, mail, and in-page links to their own handling', () => {
    for (const href of ['https://example.com/a.html', 'http://localhost:5173', 'mailto:a@b.c', '#heading', '//cdn/a.html', '', '   '])
      expect(classifyLocalLink(href), href).toBeNull()
  })
  it('names pages and Markdown files, keeping the query a page reads its state from', () => {
    expect(classifyLocalLink('docs/design/prototype.html?state=working')).toEqual({ kind: 'html', path: 'docs/design/prototype.html', suffix: '?state=working', fileUrl: false })
    expect(classifyLocalLink('./notes/Plan%20A.MD#goals')).toEqual({ kind: 'markdown', path: './notes/Plan A.MD', suffix: '#goals', fileUrl: false })
    expect(classifyLocalLink('/home/me/out/report.htm')).toMatchObject({ kind: 'html', path: '/home/me/out/report.htm' })
    expect(classifyLocalLink('file:///home/me/out/report.html?x=1')).toEqual({ kind: 'html', path: '/home/me/out/report.html', suffix: '?x=1', fileUrl: true })
  })
  it('marks everything else as other so the click is swallowed and explained', () => {
    expect(classifyLocalLink('docs/picture.png')?.kind).toBe('other')
    expect(classifyLocalLink('src/main.ts')?.kind).toBe('other')
    expect(classifyLocalLink('file://server/share/a.html')).toBeNull()
  })
})

describe('resolveLocalLink', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'strata-local-link-'))
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'proto.html'), '<h1>Proto</h1>')
    await writeFile(join(root, 'plan.md'), '# Plan')
    await writeFile(join(root, 'docs', 'picture.png'), 'png')
    await symlink(join(root, 'docs', 'proto.html'), join(root, 'alias.html'))
    return root
  }
  it('resolves a relative page against the project folder and keeps the query', async () => {
    const root = await fixture()
    const target = await resolveLocalLink('docs/proto.html?state=done', root)
    expect(target).toEqual({ kind: 'html', path: join(root, 'docs', 'proto.html'), url: `${pathToFileURL(join(root, 'docs', 'proto.html')).href}?state=done` })
  })
  it('opens absolute paths anywhere on disk, with or without a project, and follows symlinks', async () => {
    const root = await fixture()
    expect((await resolveLocalLink(join(root, 'plan.md'), null)).kind).toBe('markdown')
    expect((await resolveLocalLink(join(root, 'alias.html'), null)).path).toBe(join(root, 'docs', 'proto.html'))
    expect((await resolveLocalLink(pathToFileURL(join(root, 'plan.md')).href, null)).path).toBe(join(root, 'plan.md'))
  })
  it('refuses with a plain reason: relative without a project, missing, folders, and other kinds', async () => {
    const root = await fixture()
    await expect(resolveLocalLink('docs/proto.html', null)).rejects.toThrow('Add a project')
    await expect(resolveLocalLink('docs/nope.html', root)).rejects.toThrow(`${join(root, 'docs', 'nope.html')} does not exist.`)
    await expect(resolveLocalLink('docs', root)).rejects.toThrow('not a web link')
    await expect(resolveLocalLink('docs/picture.png', root)).rejects.toThrow('not a web link')
    await expect(resolveLocalLink('https://example.com/a.html', root)).rejects.toThrow('not a web link')
  })
})

describe('isLocalPage', () => {
  it('accepts only file URLs naming an existing .html or .htm file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-local-page-'))
    await writeFile(join(root, 'a.html'), '')
    await writeFile(join(root, 'b.md'), '')
    const page = pathToFileURL(join(root, 'a.html')).href
    expect(await isLocalPage(`${page}?state=1`)).toBe(true)
    expect(isLocalPageSync(page)).toBe(true)
    expect(await isLocalPage(pathToFileURL(join(root, 'b.md')).href)).toBe(false)
    expect(await isLocalPage(pathToFileURL(join(root, 'missing.html')).href)).toBe(false)
    expect(await isLocalPage(pathToFileURL(root).href)).toBe(false)
    expect(await isLocalPage('https://example.com/a.html')).toBe(false)
    expect(isLocalPageSync('not a url')).toBe(false)
  })
})

describe('isAppRootNavigation', () => {
  it('allows only the app root, which the crash card reloads', () => {
    expect(isAppRootNavigation('app://stratamd/', 'stratamd')).toBe(true)
    expect(isAppRootNavigation('app://stratamd/?openDocument=1', 'stratamd')).toBe(true)
    expect(isAppRootNavigation('app://stratamd/#top', 'stratamd')).toBe(true)
    expect(isAppRootNavigation('app://stratamd/docs/design/prototype.html', 'stratamd')).toBe(false)
    expect(isAppRootNavigation('app://other/', 'stratamd')).toBe(false)
    expect(isAppRootNavigation('https://stratamd/', 'stratamd')).toBe(false)
  })
})

describe('pageName', () => {
  it('names a local page by its file', () => {
    expect(pageName('file:///home/me/docs/My%20proto.html?state=1', '')).toBe('My proto.html')
  })
})
