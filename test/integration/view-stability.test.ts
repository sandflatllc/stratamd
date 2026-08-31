import { mkdtemp, writeFile } from 'node:fs/promises'
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

async function fixture(content = '# Plan\n\nOriginal.\n') {
  const root = await mkdtemp(join(tmpdir(), 'stratamd-view-stability-'))
  const path = join(root, 'plan.md')
  await writeFile(path, content)
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
  const app = await createStrataApplication({ store, settingsStore, watch: false })
  applications.push(app)
  await app.openDocument(path)
  return { app, path, store }
}

describe('published view stability', () => {
  it('keeps identity for untouched sections and fresh values for touched ones', async () => {
    const { app, path, store } = await fixture()
    const first = await app.getState()

    await app.updateSettings({ zoom: { explorer: 1, editor: 1.2, rightRail: 1, composer: 1 } })
    const afterSettings = await app.getState()
    expect(afterSettings.settings.zoom.editor).toBe(1.2)
    expect(afterSettings.settings).not.toBe(first.settings)
    expect(afterSettings.activeDocument).toBe(first.activeDocument)
    expect(afterSettings.tabs).toBe(first.tabs)
    expect(afterSettings.explorer).toBe(first.explorer)

    await store.writeBuffer(path, '# Plan\n\nOriginal.\n\nAgent addition.\n')
    await app.recheckFocused()
    const afterExternal = await app.getState()
    expect(afterExternal.activeDocument).not.toBe(afterSettings.activeDocument)
    expect(afterExternal.activeDocument?.content).toContain('Agent addition.')
    expect(afterExternal.activeDocument?.pendingHunks).toHaveLength(1)
    expect(afterExternal.settings).toBe(afterSettings.settings)

    await app.addAnnotation(path, {
      kind: 'comment',
      quote: 'Original.',
      text: 'Note this.',
      from: afterExternal.activeDocument!.content.indexOf('Original.'),
      to: afterExternal.activeDocument!.content.indexOf('Original.') + 'Original.'.length,
    })
    const afterAnnotation = await app.getState()
    expect(afterAnnotation.activeDocument?.annotations).toHaveLength(1)
    expect(afterAnnotation.activeDocument?.pendingHunks).toBe(afterExternal.activeDocument?.pendingHunks)
    expect(afterAnnotation.settings).toBe(afterSettings.settings)
  })

  it('reports correct hunk line numbers through the cached line index', async () => {
    const { app, path, store } = await fixture('# Plan\n\nAlpha.\n\nBeta.\n\nGamma.\n')
    await store.writeBuffer(path, '# Plan\n\nAlpha.\n\nBeta changed.\n\nGamma.\n')
    await app.recheckFocused()
    const document = (await app.getState()).activeDocument!
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]!.oldStart).toBe(5)
    expect(document.pendingHunks[0]!.newStart).toBe(5)
    expect(document.pendingHunks[0]!.removed).toEqual(['Beta.'])
    expect(document.pendingHunks[0]!.added).toEqual(['Beta changed.'])
  })
})
