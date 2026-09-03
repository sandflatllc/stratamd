import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createStrataApplication, type StrataApplication } from '../../src/main/application'
import { SettingsStore } from '../../src/main/settings'
import { GhostStore } from '../../src/main/storage'

const applications: StrataApplication[] = []

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.shutdown()))
})

async function launch(root: string): Promise<StrataApplication> {
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
  const app = await createStrataApplication({ store, settingsStore, watch: false })
  applications.push(app)
  return app
}

async function tabs(app: StrataApplication): Promise<{ paths: string[]; focused: string | null }> {
  const view = await app.getState()
  return { paths: view.tabs.map((tab) => tab.path), focused: view.tabs.find((tab) => tab.active)?.path ?? null }
}

describe('open documents survive a restart', () => {
  it('reopens last run\'s tabs in order, focuses the same one, and skips files that are gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stratamd-open-documents-'))
    const first = join(root, 'first.md')
    const second = join(root, 'second.md')
    const third = join(root, 'third.md')
    for (const [path, body] of [[first, '# First\n'], [second, '# Second\n'], [third, '# Third\n']] as const) await writeFile(path, body)

    const before = await launch(root)
    await before.openDocument(first)
    await before.openDocument(second)
    await before.openDocument(third)
    await before.openDocument(second)
    expect(await tabs(before)).toEqual({ paths: [first, second, third], focused: second })
    await before.shutdown()
    applications.length = 0

    const remembered = JSON.parse(await readFile(join(root, 'data/open-documents.json'), 'utf8')) as { documents: string[]; focused: string }
    expect(remembered.documents).toEqual([first, second, third])
    expect(remembered.focused).toBe(second)

    await rm(third)
    const after = await launch(root)
    expect(await after.restoreOpenDocuments()).toEqual([first, second])
    expect(await tabs(after)).toEqual({ paths: [first, second], focused: second })

    // Closing a tab updates the record; a fresh start with nothing remembered opens nothing.
    await after.closeDocument(first)
    await after.shutdown()
    applications.length = 0
    expect((JSON.parse(await readFile(join(root, 'data/open-documents.json'), 'utf8')) as { documents: string[] }).documents).toEqual([second])
    const empty = await launch(await mkdtemp(join(tmpdir(), 'stratamd-open-documents-empty-')))
    expect(await empty.restoreOpenDocuments()).toEqual([])
    expect((await tabs(empty)).paths).toEqual([])
  })
})
