import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { launchArgs, Scenario, mainEntry, projectRoot, setSource } from './harness'

test('blank shell opens the first document from the explorer and drag and drop', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, '# First document\n\nOpen from the shell.\n', 'first.md')
  await value.writeSettings({ explorerFolders: [dirname(value.file)] })

  try {
    const page = await value.launchEmpty()
    await expect(page.locator('.stratamd-logo')).toBeVisible()
    await expect(page.locator('.strata-loader')).toBeVisible()
    expect(await page.locator('.stratamd-logo, .strata-loader').evaluateAll((images) => images.every((image) => {
      const value = image as HTMLImageElement
      return value.complete && value.naturalWidth > 0
    }))).toBe(true)
    const explorer = page.getByRole('complementary', { name: /File explorer/i })
    await expect(explorer).toBeVisible()
    await expect(page.getByRole('button', { name: /^Add folder$/i })).toBeVisible()

    await explorer.getByRole('button', { name: /first\.md/i }).click()
    await expect(page.getByRole('textbox', { name: /Document editor/i })).toBeVisible()

    await page.getByRole('button', { name: /Close tab/i }).click()
    await expect(page.getByRole('heading', { name: /Open a markdown file/i })).toBeVisible()

    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.id = 'drop-fixture'
      input.hidden = true
      document.body.append(input)
    })
    const fixture = page.locator('#drop-fixture')
    await fixture.setInputFiles(value.file)
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#drop-fixture')!
      const transfer = new DataTransfer()
      transfer.items.add(input.files![0]!)
      const shell = document.querySelector<HTMLElement>('.app-shell')!
      shell.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
      shell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    await expect(page.getByRole('textbox', { name: /Document editor/i })).toBeVisible()
  } finally {
    await value.dispose()
  }
})

test('explorer root shows parent/name with a full-path tooltip and copies paths from a right-click menu', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, '# Paths\n\nCopy me.\n', 'paths.md')
  const folder = dirname(value.file)
  const segments = folder.split('/').filter(Boolean)
  await value.writeSettings({ explorerFolders: [folder] })
  try {
    const page = await value.launchEmpty()
    const root = page.locator('.folder-row').first()
    await expect(root).toHaveAttribute('title', folder)
    await expect(root.locator('.folder-parent')).toHaveText(`${segments.at(-2)}/`)
    await expect(root.locator('.folder-name')).toHaveText(segments.at(-1)!)

    await root.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy full path' }).click()
    await expect.poll(() => value.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(folder)
    await expect(page.getByRole('menuitem', { name: 'Copy full path' })).toBeHidden()

    await page.getByRole('button', { name: /paths\.md/i }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy full path' }).click()
    await expect.poll(() => value.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(value.file)
  } finally {
    await value.dispose()
  }
})

test('send composer traps focus and Escape restores the trigger', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, '# Focus\n\nOriginal.\n', 'focus.md')

  try {
    const page = await value.launch()
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    await setSource(page, '# Focus\n\nUser edit.\n')
    await value.waitForBuffer('# Focus\n\nUser edit.\n')

    const trigger = page.getByRole('button', { name: /^Send(?:\b|$)/i }).first()
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: /Send changes/i })
    await expect(dialog.getByRole('textbox', { name: /Note for recipients/i })).toBeFocused()
    await expect(dialog.getByRole('button', { name: /^Send$/i })).toBeEnabled()

    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: /^Send$/i })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
  } finally {
    await value.dispose()
  }
})

test('socket open recreates the BrowserWindow after the last window closes', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, '# First\n', 'first.md')
  const second = join(dirname(value.file), 'second.md')
  await writeFile(second, '# Second\n')
  try {
    const page = await value.launch()
    await page.close()
    await expect.poll(() => value.app!.windows().length).toBe(0)
    const opened = value.app!.waitForEvent('window')
    const result = await value.cli(['open', second])
    expect(result.code, result.stderr).toBe(0)
    const replacement = await opened
    await replacement.waitForLoadState('domcontentloaded')
    await expect(replacement.getByText('second.md', { exact: false }).first()).toBeVisible()
  } finally {
    await value.dispose()
  }
})

test('second-instance path launch recreates the BrowserWindow', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const value = await Scenario.create(testInfo, '# First\n', 'first.md')
  const second = join(dirname(value.file), 'second.md')
  await writeFile(second, '# Second\n')
  try {
    const page = await value.launch()
    const executable = value.app!.process().spawnfile
    await page.close()
    await expect.poll(() => value.app!.windows().length).toBe(0)
    const opened = value.app!.waitForEvent('window')
    const child = spawn(executable, [...launchArgs, mainEntry, second], {
      cwd: projectRoot,
      env: value.env,
    })
    let childOutput = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { childOutput += chunk })
    child.stderr?.on('data', (chunk: string) => { childOutput += chunk })
    const childExit = await new Promise<number | null>((resolveChild, rejectChild) => {
      child.once('error', rejectChild)
      child.once('close', (code) => resolveChild(code))
    })
    const replacement = await Promise.race([
      opened,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(
        `No replacement window arrived. Second instance exited ${childExit}. Output:\n${childOutput}`,
      )), 30_000)),
    ])
    await replacement.waitForLoadState('domcontentloaded')
    await expect(replacement.getByText('second.md', { exact: false }).first()).toBeVisible()
  } finally {
    await value.dispose()
  }
})
