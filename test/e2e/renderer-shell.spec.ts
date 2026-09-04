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
    const textDragDefaults = await page.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.setData('text/plain', 'selected editor text')
      const shell = document.querySelector<HTMLElement>('.app-shell')!
      return ['dragenter', 'dragover', 'drop'].map((type) => {
        const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer })
        shell.dispatchEvent(event)
        return event.defaultPrevented
      })
    })
    expect(textDragDefaults).toEqual([false, false, false])
    await expect(page.locator('.drop-overlay')).toHaveCount(0)
    await expect(page.getByText('Drop a .md or .markdown file.', { exact: true })).toHaveCount(0)

    const nonMarkdown = join(dirname(value.file), 'not-markdown.txt')
    await writeFile(nonMarkdown, 'Not Markdown.\n')
    await fixture.setInputFiles(nonMarkdown)
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#drop-fixture')!
      const transfer = new DataTransfer()
      transfer.items.add(input.files![0]!)
      const shell = document.querySelector<HTMLElement>('.app-shell')!
      shell.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    await expect(page.locator('.drop-overlay')).toBeVisible()
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#drop-fixture')!
      const transfer = new DataTransfer()
      transfer.items.add(input.files![0]!)
      document.querySelector<HTMLElement>('.app-shell')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    await expect(page.getByRole('status')).toContainText('Drop a .md or .markdown file.')
    await expect(page.locator('.drop-overlay')).toHaveCount(0)

    await fixture.setInputFiles(value.file)
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#drop-fixture')!
      const transfer = new DataTransfer()
      transfer.items.add(input.files![0]!)
      document.querySelector<HTMLElement>('.app-shell')!.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    await expect(page.locator('.drop-overlay')).toBeVisible()
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#drop-fixture')!
      const transfer = new DataTransfer()
      transfer.items.add(input.files![0]!)
      const shell = document.querySelector<HTMLElement>('.app-shell')!
      shell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    await expect(page.getByRole('textbox', { name: /Document editor/i })).toBeVisible()
  } finally {
    await value.dispose()
  }
})

test('explorer and document tabs copy full paths from a right-click menu', { tag: '@clipboard' }, async ({}, testInfo) => {
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

    await page.getByRole('button', { name: /paths\.md/i }).click()
    await value.app!.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))
    const tab = page.getByRole('tab', { name: /paths\.md/i })
    await tab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy full path' }).click()
    await expect.poll(() => value.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(value.file)
  } finally {
    await value.dispose()
  }
})



test('second-instance path launch opens a tab in the running instance', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const value = await Scenario.create(testInfo, '# First\n', 'first.md')
  const second = join(dirname(value.file), 'second.md')
  await writeFile(second, '# Second\n')
  try {
    const page = await value.launch()
    const executable = value.app!.process().spawnfile
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
    expect(childExit, childOutput).toBe(0)
    expect(value.app!.windows()).toHaveLength(1)
    await expect(page.getByText('second.md', { exact: false }).first()).toBeVisible()
  } finally {
    await value.dispose()
  }
})
