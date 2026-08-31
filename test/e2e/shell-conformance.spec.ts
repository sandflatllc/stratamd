import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario, expectPayload, primaryKey, selectTextInVisualEditor, setSource } from './harness'

async function tabTo(page: Page, target: Locator, limit = 120): Promise<void> {
  await expect(target).toBeVisible()
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press('Tab')
    if (await target.evaluate((element) => document.activeElement === element)) return
  }
  const focused = await page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return String(active)
    return `${active.tagName.toLowerCase()} ${active.getAttribute('aria-label') ?? active.textContent?.trim() ?? ''}`
  })
  throw new Error(`Tab did not reach the requested control; focus stopped at ${focused}`)
}

/** Playwright cannot fill <input type="color">; set it the way a picker would and let React see the input event. */
async function setColor(input: Locator, hex: string): Promise<void> {
  await input.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, hex)
}

async function writeAgentBuffer(value: Scenario, content: string): Promise<void> {
  const state = await value.state()
  expect(state.buffer).toBeTruthy()
  await value.tag('agent-a', 'Agent A')
  await value.atomicWrite(state.buffer!, content)
  await expect(value.page!.getByRole('button', { name: /^Keep change /i }).first()).toBeVisible()
}

test('panel resize persists across an application restart', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, '# Panels\n\nResize me.\n', 'panels.md')
  try {
    const page = await value.launch()
    const resizer = page.getByRole('button', { name: 'Resize file explorer' })
    await expect(resizer).toHaveAttribute('aria-valuenow', '212')
    const bounds = await resizer.boundingBox()
    expect(bounds).toBeTruthy()

    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds!.x + bounds!.width / 2 + 64, bounds!.y + bounds!.height / 2, { steps: 4 })
    await page.mouse.up()
    await expect(resizer).toHaveAttribute('aria-valuenow', '276')

    const settingsPath = join(String(value.env.XDG_CONFIG_HOME), 'stratamd', 'settings.json')
    await expect.poll(async () => {
      try {
        return JSON.parse(await readFile(settingsPath, 'utf8')).panels.explorerWidth
      } catch {
        return null
      }
    }).toBe(276)

    await value.stop()
    const restarted = await value.launch()
    await expect(restarted.getByRole('button', { name: 'Resize file explorer' })).toHaveAttribute('aria-valuenow', '276')
  } finally {
    await value.dispose()
  }
})

test('per-pane text zoom follows the hovered pane, resets from one button, and persists across restart', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, '# Zoom\n\nScale me.\n', 'zoom.md')
  try {
    const page = await value.launch()
    const explorer = page.locator('[data-pane="explorer"]')
    const editor = page.locator('[data-pane="editor"]')
    const rail = page.locator('[data-pane="rightRail"]')
    const zoomOf = (pane: Locator) => pane.evaluate((element) => getComputedStyle(element).getPropertyValue('--zoom').trim())
    const reset = page.getByRole('button', { name: 'Reset zoom' })
    await expect(reset).toBeHidden()

    await explorer.hover()
    await page.keyboard.press(primaryKey('Equal'))
    await page.keyboard.press(primaryKey('Equal'))
    await expect.poll(() => zoomOf(explorer)).toBe('1.2')
    expect(await zoomOf(editor)).toBe('1')
    await expect(page.locator('.explorer .panel-heading h2')).toHaveCSS('font-size', '18px')

    await rail.hover()
    await page.keyboard.press(primaryKey('Minus'))
    await expect.poll(() => zoomOf(rail)).toBe('0.9')

    const editorBox = await editor.boundingBox()
    await page.mouse.move(editorBox!.x + editorBox!.width / 2, editorBox!.y + editorBox!.height / 2)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    await expect.poll(() => zoomOf(editor)).toBe('1.1')
    await expect(page.locator('.prosemirror-host .ProseMirror')).toHaveCSS('font-size', '23.1px')
    await expect(reset).toBeVisible()

    const settingsPath = join(String(value.env.XDG_CONFIG_HOME), 'stratamd', 'settings.json')
    await expect.poll(async () => {
      try {
        return JSON.parse(await readFile(settingsPath, 'utf8')).zoom
      } catch {
        return null
      }
    }).toEqual({ explorer: 1.2, editor: 1.1, rightRail: 0.9, composer: 1 })

    await value.stop()
    const restarted = await value.launch()
    await expect.poll(() => restarted.locator('[data-pane="editor"]').evaluate((element) => getComputedStyle(element).getPropertyValue('--zoom').trim())).toBe('1.1')
    await restarted.getByRole('button', { name: 'Reset zoom' }).click()
    await expect.poll(() => restarted.locator('[data-pane="explorer"]').evaluate((element) => getComputedStyle(element).getPropertyValue('--zoom').trim())).toBe('1')
    await expect(restarted.getByRole('button', { name: 'Reset zoom' })).toBeHidden()
    await expect.poll(async () => JSON.parse(await readFile(settingsPath, 'utf8')).zoom).toEqual({ explorer: 1, editor: 1, rightRail: 1, composer: 1 })
  } finally {
    await value.dispose()
  }
})

test('a theme file sets fonts and attribution colors, applies live when rewritten, and persists across restart', async ({}, testInfo) => {
  const original = '# Typography\n\nOriginal.\n'
  const proposed = '# Typography\n\nAgent proposal.\n'
  const value = await Scenario.create(testInfo, original, 'appearance.md')
  const themePath = join(String(value.env.XDG_CONFIG_HOME), 'stratamd', 'themes', 'dusk.json')
  await mkdir(dirname(themePath), { recursive: true })
  await writeFile(themePath, JSON.stringify({
    name: 'Dusk',
    fonts: { text: 'Nunito' },
    surfaces: { window: '#f0e8f8', panel: '#fffbfd', border: '#e0c8d8' },
    document: { body: '#221122' },
    people: { you: '#102030', 'agent-1': '#405060', 'agent-4': '#d0e0f0' },
  }))
  await value.writeSettings({ theme: 'dusk' })
  try {
    const page = await value.launch()
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    await writeAgentBuffer(value, proposed)
    await page.evaluate(async ({ path, from, to }) => window.strata.addAnnotation(path, {
      kind: 'comment', quote: 'Typography', text: 'Check the configured color.', from, to,
    }), { path: value.file, from: original.indexOf('Typography'), to: original.indexOf('Typography') + 'Typography'.length })

    const shell = page.locator('.app-shell')
    const avatar = page.locator('.agent-avatar').filter({ hasText: 'AA' })
    const badge = page.getByRole('tab', { name: /appearance\.md/i }).locator('.tab-badge')
    const chip = page.locator('.annotation-row').filter({ hasText: 'Typography' }).locator('.annotation-chip')
    await expect(shell).toHaveCSS('font-family', /Nunito/)
    // Surfaces follow the theme too, not only fonts and attribution: a light theme lightens the panels.
    await expect(page.locator('.explorer')).toHaveCSS('background-color', 'rgb(255, 251, 253)')
    await expect(page.locator('.explorer')).toHaveCSS('border-color', 'rgb(224, 200, 216)')
    await expect(page.locator('.editor-island .ProseMirror p').first()).toHaveCSS('color', 'rgb(34, 17, 34)')
    await expect(avatar).toHaveCSS('background-color', 'rgb(64, 80, 96)')
    await expect(badge).toHaveCSS('background-color', 'rgb(64, 80, 96)')
    await expect(chip).toHaveCSS('color', 'rgb(16, 32, 48)')

    // An agent rewrites the file: the app follows without restart.
    await writeFile(themePath, JSON.stringify({
      name: 'Dusk',
      fonts: { text: 'Baloo 2' },
      people: { you: '#203040', 'agent-1': '#506070' },
    }))
    await expect(shell).toHaveCSS('font-family', /Baloo 2/)
    await expect(avatar).toHaveCSS('background-color', 'rgb(80, 96, 112)')
    await expect(badge).toHaveCSS('background-color', 'rgb(80, 96, 112)')
    await expect(chip).toHaveCSS('color', 'rgb(32, 48, 64)')

    await value.stop()
    const restarted = await value.launch()
    await expect(restarted.locator('.app-shell')).toHaveCSS('font-family', /Baloo 2/)
    await expect(restarted.locator('.annotation-row').filter({ hasText: 'Typography' }).locator('.annotation-chip')).toHaveCSS('color', 'rgb(32, 48, 64)')
  } finally {
    await value.dispose()
  }
})

test('the theme panel floats over a live app, writes only chosen keys, follows agent edits, reverts, and persists its geometry', async ({}, testInfo) => {
  const fixture = [
    '# Theme', '', '## Section', '', '### Detail', '',
    'Some **bold** and *italic* and ~~struck~~ text with `code` and a [link](https://example.com).', '',
    '- bullet', '- [x] done', '- [ ] open', '', '1. first', '2. second', '', '> quoted', '',
    '| a | b |', '|---|---|', '| 1 | 2 |', '', '```', 'block', '```', '', '---', '', 'After.', ''
  ].join('\n')
  const value = await Scenario.create(testInfo, fixture, 'theme.md')
  try {
    const page = await value.launch()
    const strong = page.locator('.editor-island .ProseMirror strong').first()
    const em = page.locator('.editor-island .ProseMirror em').first()
    await expect(strong).toHaveCSS('color', 'rgb(219, 218, 222)')
    await expect(em).toHaveCSS('color', 'rgb(219, 218, 222)')

    await page.getByRole('button', { name: 'Theme', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Theme' })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Built-in theme')
    await expect(page.locator('.modal-backdrop')).toHaveCount(0)
    // The sample document opens as a real tab and explains each construct in its own words.
    await expect(page.getByRole('tab', { name: /Theme sample\.md/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.editor-island .ProseMirror h1')).toContainText('level-one heading')
    await expect(page.locator('.editor-island .ProseMirror table')).toBeVisible()
    await page.getByRole('tab', { name: /theme\.md/ }).click()

    // The document stays editable behind the panel.
    await page.getByRole('textbox', { name: /Document editor/i }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' More.')
    await expect(page.locator('.editor-island .ProseMirror')).toContainText('More.')

    await panel.getByRole('button', { name: 'New from this' }).click()
    await expect(panel.getByRole('combobox', { name: 'Theme' })).toHaveValue('copy-of-strata')
    const themePath = join(String(value.env.XDG_CONFIG_HOME), 'stratamd', 'themes', 'copy-of-strata.json')
    // A copy of a stock theme starts with all 40 swatches and six other values chosen.
    const parsedTheme = async () => { try { return JSON.parse(await readFile(themePath, 'utf8')) } catch { return {} } }
    await expect.poll(async () => (await parsedTheme()).document?.bold).toBe('#dbdade')
    await expect.poll(async () => (await parsedTheme())['schema-version']).toBe(2)
    expect(await parsedTheme()).toMatchObject({ name: 'Copy of Strata', controls: { positive: '#3dc97c' }, effects: { intensity: 1 } })

    const bold = panel.locator('.theme-row[data-key="document.bold"]')
    await expect(bold).toHaveClass(/is-set/)
    await bold.hover()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-highlight', 'document-bold')
    await setColor(bold.locator('input[type="color"]'), '#ff8800')
    await expect(strong).toHaveCSS('color', 'rgb(255, 136, 0)')
    await expect(bold).toHaveClass(/is-set/)
    await expect.poll(async () => (await parsedTheme()).document?.bold).toBe('#ff8800')

    // An agent rewrites the file: the row highlights and the app follows.
    await writeFile(themePath, JSON.stringify({ name: 'Copy of Strata', document: { bold: '#00aa88', italic: '#123456' } }))
    await expect(strong).toHaveCSS('color', 'rgb(0, 170, 136)')
    await expect(em).toHaveCSS('color', 'rgb(18, 52, 86)')
    await expect(panel.locator('.theme-row[data-key="document.italic"]')).toHaveClass(/is-set/)

    await bold.getByRole('button', { name: 'Use default' }).click()
    await expect(strong).toHaveCSS('color', 'rgb(219, 218, 222)')
    await expect.poll(async () => JSON.parse(await readFile(themePath, 'utf8'))).toEqual({ 'schema-version': 2, name: 'Copy of Strata', document: { italic: '#123456' } })

    // Revert restores the snapshot from when the panel opened: the complete copy.
    await panel.getByRole('button', { name: 'Revert to when opened' }).click()
    await expect.poll(async () => (await parsedTheme()).document?.italic).toBe('#dbdade')
    await expect.poll(async () => (await parsedTheme()).document?.bold).toBe('#dbdade')

    await panel.getByRole('button', { name: 'Decoration and motion' }).click()
    await panel.locator('.theme-row[data-key="effects.panel-style"] select').selectOption('starfield')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ambient-windows', 'starfield')
    await expect(page.locator('.ambient-layer-editor .ambient-star')).toHaveCount(7)

    // Move and resize, then restart: geometry and theme persist.
    const header = panel.locator('.theme-panel-grip')
    const box = (await header.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2 - 120, { steps: 4 })
    await page.mouse.up()
    const moved = (await panel.boundingBox())!
    expect(Math.round(moved.x)).toBeLessThan(Math.round(box.x) - 130)
    const settingsPath = join(String(value.env.XDG_CONFIG_HOME), 'stratamd', 'settings.json')
    await expect.poll(async () => JSON.parse(await readFile(settingsPath, 'utf8')).panels.themePanel.x).toBe(Math.round(moved.x))

    await value.stop()
    const restarted = await value.launch()
    await restarted.getByRole('button', { name: 'Recover my edits' }).click()
    await restarted.getByRole('tab', { name: /theme\.md/ }).click()
    await expect(restarted.locator('.app-shell')).toHaveAttribute('data-ambient-windows', 'starfield')
    await restarted.getByRole('button', { name: 'Theme', exact: true }).click()
    const reopened = restarted.getByRole('dialog', { name: 'Theme' })
    // Persisted, not the bottom-right default (about 200px away); the clamp may shift it a little with window size.
    expect(Math.abs((await reopened.boundingBox())!.x - moved.x)).toBeLessThan(60)
    await expect(reopened.getByRole('combobox', { name: 'Theme' })).toHaveValue('copy-of-strata')
    await reopened.getByRole('combobox', { name: 'Theme' }).selectOption('strata')
    await expect(restarted.locator('.app-shell')).toHaveAttribute('data-ambient-windows', 'glow-orbs')
    await expect(reopened).toContainText('Built-in theme')
  } finally {
    await value.dispose()
  }
})

test('two tabs route pathless state and initial attach to the focused document', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, '# First\n\nFirst document.\n', 'first.md')
  const second = join(dirname(value.file), 'second.md')
  await writeFile(second, '# Second\n\nSecond document.\n')
  try {
    const page = await value.launch()
    await page.evaluate(async (path) => window.strata.openDocument(path), second)
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByRole('tab', { name: /second\.md/i })).toHaveAttribute('aria-selected', 'true')

    const secondState = expectPayload(await value.cli(['state']))
    expect(secondState.file).toBe(second)
    const secondAttach = expectPayload(await value.cli([
      'attach', '--as', 'agent-second', '--name', 'Second agent', '--timeout', '0',
    ]))
    expect(secondAttach.event).toBe('initial')
    expect(secondAttach.file).toBe(second)

    await page.getByRole('tab', { name: /first\.md/i }).click()
    await expect(page.getByRole('tab', { name: /first\.md/i })).toHaveAttribute('aria-selected', 'true')
    const firstState = expectPayload(await value.cli(['state']))
    expect(firstState.file).toBe(value.file)
    const firstAttach = expectPayload(await value.cli([
      'attach', '--as', 'agent-first', '--name', 'First agent', '--timeout', '0',
    ]))
    expect(firstAttach.event).toBe('initial')
    expect(firstAttach.file).toBe(value.file)
  } finally {
    await value.dispose()
  }
})

test('production renderer blocks a remote image without making a remote request', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, '# Images\n\nLocal-only rendering.\n', 'images.md')
  try {
    const page = await value.launch()
    const remoteRequests: string[] = []
    page.on('request', (request) => {
      if (/^https?:/i.test(request.url())) remoteRequests.push(request.url())
    })

    const remoteUrl = 'https://stratamd-remote.invalid/tracker.png'
    const markdown = `# Images\n\n![Remote tracker](${remoteUrl})\n`
    await setSource(page, markdown)
    await value.waitForBuffer(markdown)
    await page.keyboard.press(primaryKey('/'))

    await expect(page.locator('.strata-image--blocked')).toContainText('Remote image blocked')
    expect(remoteRequests).toEqual([])
    const remoteResources = await page.evaluate(() => performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /^https?:/i.test(url)))
    expect(remoteResources).toEqual([])
  } finally {
    await value.dispose()
  }
})

test('keyboard reaches and operates direct Keep and Revert actions', async ({}, testInfo) => {
  const original = '# Review\n\nOriginal wording.\n'
  const kept = '# Review\n\nAgent wording.\n'
  const reverted = '# Review\n\nSecond agent wording.\n'
  const value = await Scenario.create(testInfo, original, 'review.md')
  try {
    const page = await value.launch()
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')

    await writeAgentBuffer(value, kept)
    const keep = page.getByRole('button', { name: /^Keep change /i }).first()
    await tabTo(page, keep)
    await page.keyboard.press('Space')
    await expect.poll(async () => (await value.changes()).segments?.length ?? 0).toBe(0)
    expect((await value.state()).document).toBe(kept)

    await writeAgentBuffer(value, reverted)
    const revert = page.getByRole('button', { name: /^Revert change /i }).first()
    await tabTo(page, revert)
    await page.keyboard.press('Space')
    await expect.poll(async () => (await value.state()).document).toBe(kept)
    await expect(page.getByRole('button', { name: /^Revert change /i })).toHaveCount(0)
  } finally {
    await value.dispose()
  }
})

test('keyboard operates composer recipient previews and an annotation thread', async ({}, testInfo) => {
  const original = '# Keyboard\n\nReply to this sentence.\n'
  const edited = '# Keyboard\n\nReply to this sentence.\n\nOwner edit.\n'
  const value = await Scenario.create(testInfo, original, 'keyboard.md')
  try {
    const page = await value.launch()
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('initial')
    await setSource(page, edited)
    await value.waitForBuffer(edited)

    await page.keyboard.press(primaryKey('Enter'))
    const composer = page.getByRole('dialog', { name: /Send changes/i })
    await expect(composer).toBeVisible()
    const previewTabs = composer.getByRole('tablist', { name: /What each agent receives/i })
    const agentAPreview = previewTabs.getByRole('tab', { name: 'Agent A' })
    const agentBPreview = previewTabs.getByRole('tab', { name: 'Agent B' })
    await expect(agentAPreview).toHaveAttribute('aria-selected', 'true')
    await tabTo(page, agentAPreview)
    await page.keyboard.press('ArrowRight')
    await expect(agentBPreview).toBeFocused()
    await expect(agentBPreview).toHaveClass(/active/)
    await expect(agentBPreview).toHaveAttribute('aria-selected', 'true')
    await expect(composer.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', await agentBPreview.getAttribute('id') ?? '')

    const agentBRecipient = composer.getByRole('checkbox').nth(1)
    await tabTo(page, agentBRecipient)
    await page.keyboard.press('Space')
    await expect(agentBRecipient).not.toBeChecked()
    await page.keyboard.press('Escape')
    await expect(composer).toBeHidden()

    const editor = page.getByRole('textbox', { name: /Document editor/i })
    await selectTextInVisualEditor(page, 'Reply to this sentence.')
    const annotationMenu = page.getByRole('menu', { name: /Annotate selection/i })
    await annotationMenu.getByRole('menuitem', { name: /Comment/i }).click()
    const annotationText = page.getByRole('textbox', { name: /Annotation text/i })
    await expect(annotationText).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(annotationText).toBeHidden()
    await expect(annotationMenu).toBeHidden()
    await expect(editor).toBeFocused()
    await expect.poll(() => editor.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('Reply to this sentence.')

    const annotation = await value.cli([
      'annotate', value.file,
      '--kind', 'comment',
      '--quote', 'Reply to this sentence.',
      '--text', 'Use the thread from the keyboard.',
      '--as', 'agent-a',
    ])
    expect(annotation.code, annotation.stderr).toBe(0)
    const row = page.locator('.annotations-panel').getByRole('button').filter({ hasText: 'Reply to this sentence.' })
    await expect(row).toBeVisible()
    await tabTo(page, row)
    await page.keyboard.press('Enter')

    const thread = page.getByRole('dialog', { name: /comment thread/i })
    await expect(thread).toBeVisible()
    const reply = thread.getByRole('textbox', { name: 'Reply' })
    await tabTo(page, reply)
    await page.keyboard.type('Keyboard reply')
    await page.keyboard.press('Enter')
    await expect(reply).toHaveValue('')
    await expect(thread.getByText('Keyboard reply', { exact: true })).toBeVisible()
    await expect.poll(async () => {
      const payload = await value.state() as unknown as {
        annotations?: Array<{ replies?: Array<{ text: string }> }>
      }
      return payload.annotations?.flatMap((item) => item.replies ?? []).map((item) => item.text) ?? []
    }).toContain('Keyboard reply')

    const resolve = thread.getByRole('button', { name: /Resolve thread/i })
    await tabTo(page, resolve)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await value.state()).annotations?.find((item) => item.kind === 'comment')?.status).toBe('resolved')
  } finally {
    await value.dispose()
  }
})

for (const decision of ['mine', 'incoming'] as const) {
  test(`keyboard resolves a Save conflict by choosing ${decision}`, async ({}, testInfo) => {
    const original = '# Conflict\n\nOriginal block.\n'
    const mine = '# Conflict\n\nMy unsaved block.\n'
    const incoming = '# Conflict\n\nIncoming disk block.\n'
    const value = await Scenario.create(testInfo, original, `conflict-${decision}.md`)
    try {
      const page = await value.launch()
      await setSource(page, mine)
      await value.waitForBuffer(mine)
      await value.atomicWrite(value.file, incoming)
      await page.keyboard.press(primaryKey('s'))

      const dialog = page.getByRole('dialog', { name: /External write conflicts with your edits/i })
      await expect(dialog).toBeVisible()
      const keepMine = dialog.getByRole('button', { name: /Keep mine/i })
      const takeIncoming = dialog.getByRole('button', { name: /Take incoming/i })
      await expect(keepMine).toBeFocused()
      if (decision === 'incoming') {
        await page.keyboard.press('Tab')
        await expect(takeIncoming).toBeFocused()
      }
      await page.keyboard.press('Enter')
      await expect(dialog).toBeHidden()
      await expect.poll(async () => (await value.state()).document).toBe(decision === 'mine' ? mine : incoming)
    } finally {
      await value.dispose()
    }
  })
}

test('keyboard dismisses an invalid UTF-8 banner', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, Buffer.from([0xff, 0xfe, 0x00]), 'invalid.md')
  try {
    const page = await value.launch()
    const banner = page.getByRole('status').filter({ hasText: /Invalid UTF-8/i })
    await expect(banner).toBeVisible()
    const dismiss = banner.getByRole('button', { name: /Dismiss banner/i })
    await tabTo(page, dismiss)
    await page.keyboard.press('Enter')
    await expect(banner).toBeHidden()
  } finally {
    await value.dispose()
  }
})
