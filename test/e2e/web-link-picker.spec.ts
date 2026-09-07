import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expectActiveDocument, Scenario, switchToDocument } from './harness'
import { openThread } from './cockpit-agent'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { startPreviewPage } from './preview-page'

const picker = (page: Page) => page.getByRole('dialog', { name: 'Open web link', exact: true })
type ExternalProbe = typeof globalThis & { openedWebLinks: string[] }
async function recordExternal(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const probe = globalThis as ExternalProbe
    probe.openedWebLinks = []
    shell.openExternal = async url => { probe.openedWebLinks.push(url) }
  })
}
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as ExternalProbe).openedWebLinks)

test('document, side and center transcript links share a session choice and open once on double click', async ({}, testInfo) => {
  const engine = await startEngine()
  engine.postAssistant('t1', '[First page](https://example.com/first)\n\nhttps://example.com/second')
  const scenario = await seededScenario(testInfo, engine.origin, '# Links\n\n[Document page](https://example.com/document)\n')
  try {
    const page = await scenario.launch()
    await recordExternal(scenario.app!)
    const documentLink = page.getByRole('link', { name: 'Document page', exact: true })
    await documentLink.dblclick()
    await expect(picker(page)).toBeVisible()
    expect(await opened(scenario.app!)).toEqual([])
    await picker(page).getByRole('button', { name: 'Open in default browser', exact: true }).click()
    await expect.poll(() => opened(scenario.app!)).toEqual(['https://example.com/document'])
    await openThread(page, 'Live engine thread')
    const side = page.locator('.conversation-panel[data-placement="side"]')
    await side.getByRole('link', { name: 'First page', exact: true }).dblclick()
    await expect.poll(() => opened(scenario.app!)).toEqual(['https://example.com/document', 'https://example.com/first'])
    await expect(picker(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'Open in center' }).click()
    const center = page.locator('.conversation-panel[data-placement="center"]')
    await center.getByRole('link', { name: 'https://example.com/second', exact: true }).dblclick()
    await expect.poll(() => opened(scenario.app!)).toEqual(['https://example.com/document', 'https://example.com/first', 'https://example.com/second'])
    const first = center.getByRole('link', { name: 'First page', exact: true })
    await first.click()
    await expect(picker(page).getByRole('button', { name: 'Open in default browser', exact: true })).toHaveAttribute('data-last', 'true')
    await page.screenshot({ path: testInfo.outputPath('center-picker.png') })
    await page.keyboard.press('Escape')
    await expect(picker(page)).toHaveCount(0)
    await expect(first).toBeFocused()
    await first.press('Enter')
    await expect(picker(page)).toBeVisible()
    await page.keyboard.press('End')
    await expect(picker(page).getByRole('button', { name: 'Open in default browser', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await opened(scenario.app!)).length).toBe(4)
    await scenario.stop()
    const restored = await scenario.launch()
    await recordExternal(scenario.app!)
    await restored.getByRole('link', { name: 'First page', exact: true }).dblclick()
    await expect(picker(restored)).toBeVisible()
    expect(await opened(scenario.app!)).toEqual([])
    await expect(picker(restored).locator('[data-last="true"]')).toHaveCount(0)
  } finally { await scenario.dispose(); await engine.close() }
})

test('Strata opens a fresh project tab and double click reuses that destination across document and transcript', async ({}, testInfo) => {
  const engine = await startEngine()
  const site = await startPreviewPage()
  const url = `${site.origin}/clients`
  engine.postAssistant('t1', `[Preview page](${url})`)
  const scenario = await seededScenario(testInfo, engine.origin, `# Links\n\n[Document page](${url}?document)\n`)
  engine.setWorkspaceRoot(dirname(scenario.file))
  try {
    const page = await scenario.launch()
    await recordExternal(scenario.app!)
    await openThread(page, 'Live engine thread')
    await page.getByRole('button', { name: 'Open in center' }).click()
    await page.getByRole('link', { name: 'Preview page', exact: true }).click()
    await picker(page).getByRole('button', { name: 'Open in Strata', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Cockpit project preview', exact: true })).toBeVisible()
    const tabs = () => page.evaluate(async () => (await window.strata.getState()).preview.tabs)
    await expect.poll(async () => (await tabs()).map(tab => ({ projectId: tab.projectId, url: tab.url, kind: tab.kind }))).toEqual([{ projectId: 'p1', url, kind: 'owner' }])
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toBeVisible()
    await switchToDocument(page, /cockpit-engine\.md/)
    await page.getByRole('link', { name: 'Document page', exact: true }).dblclick()
    await expect.poll(async () => (await tabs()).map(tab => tab.url)).toEqual([url, `${url}?document`])
    await expect(picker(page)).toHaveCount(0)
    expect(await opened(scenario.app!)).toEqual([])
    // Single click always allows changing the shared destination.
    await page.locator('.conversation-panel[data-placement="side"]').getByRole('link', { name: 'Preview page', exact: true }).click()
    await expect(picker(page).getByRole('button', { name: 'Open in Strata', exact: true })).toHaveAttribute('data-last', 'true')
    await picker(page).getByRole('button', { name: 'Open in default browser', exact: true }).click()
    await expect.poll(() => opened(scenario.app!)).toEqual([url])
  } finally { await scenario.dispose(); await engine.close(); await site.close() }
})

test('saved comment links use the same picker and Escape preserves the comment', async ({}, testInfo) => {
  const engine = await startEngine()
  const messageId = engine.postAssistant('t1', 'A passage to discuss.')
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await recordExternal(scenario.app!)
    await openThread(page, 'Live engine thread')
    await page.evaluate(async messageId => window.strata.holdMessageComment('t1', { messageId, from: 0, to: 9, kind: 'comment', text: 'See [reference](https://example.com/reference).' }), messageId)
    await page.locator('.conversation-panel').getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.some(command => command.type === 'thread.turn.start')).toBe(true)
    engine.postAssistant('t1', 'I will check the reference.')
    await page.getByRole('navigation', { name: 'Conversation history' }).getByRole('button', { name: /^Comment: See/ }).click()
    const comment = page.getByRole('dialog', { name: 'Saved comment', exact: true })
    await expect(comment).toBeVisible()
    await expect(comment).toContainText('reference')
    await page.screenshot({ path: testInfo.outputPath('comment-before-picker.png') })
    await comment.getByRole('link', { name: 'reference', exact: true }).click()
    await expect(picker(page)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('comment-picker.png') })
    await page.keyboard.press('Escape')
    await expect(picker(page)).toHaveCount(0)
    await expect(comment).toBeVisible()
    await comment.getByRole('link', { name: 'reference', exact: true }).click()
    await picker(page).getByRole('button', { name: 'Open in default browser', exact: true }).click()
    await expect.poll(() => opened(scenario.app!)).toEqual(['https://example.com/reference'])
    await expect(comment).toBeVisible()
  } finally { await scenario.dispose(); await engine.close() }
})

test('terminal link gestures share the picker and preserve the native double-click count', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin, '# Links\n\n[Web page](https://example.com/)\n')
  try {
    const page = await scenario.launch()
    await recordExternal(scenario.app!)
    await page.getByRole('link', { name: 'Web page', exact: true }).click()
    await picker(page).getByRole('button', { name: 'Open in default browser', exact: true }).click()
    await page.getByRole('button', { name: 'StrataMD menu', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Terminal/ }).click()
    const drawer = page.getByRole('region', { name: 'Terminal', exact: true })
    await expect(drawer.locator('.terminal-status')).toHaveText('running')
    const target = engine.rpcRequests.find(request => request.tag === 'terminal.attach')!.payload as { threadId: string; terminalId: string }
    await page.evaluate(async ({ threadId, terminalId }) => window.strata.writeEngineTerminal({ threadId, terminalId, data: '\u001b[2J\u001b[Hhttps://example.com/terminal\r\n' }), target)
    const canvas = drawer.locator('canvas')
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.down(modifier)
    await canvas.hover({ position: { x: 20, y: 10 } })
    await expect(canvas).toHaveCSS('cursor', 'pointer')
    await canvas.dblclick({ position: { x: 20, y: 10 }, modifiers: [modifier] })
    await page.keyboard.up(modifier)
    await expect.poll(() => opened(scenario.app!)).toEqual(['https://example.com/', 'https://example.com/terminal'])
    await canvas.click({ position: { x: 20, y: 10 }, modifiers: [modifier] })
    await expect(picker(page)).toBeVisible()
    await expect(picker(page).getByRole('button', { name: 'Open in default browser', exact: true })).toHaveAttribute('data-last', 'true')
  } finally { await scenario.dispose(); await engine.close() }
})

test('without a project the picker keeps external opening available and dismisses on outside click', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Links\n\n[Web page](https://example.com/)\n')
  try {
    const page = await scenario.launch()
    await recordExternal(scenario.app!)
    await page.getByRole('link', { name: 'Web page', exact: true }).click()
    await expect(picker(page).getByRole('button', { name: 'Open in Strata', exact: true })).toBeDisabled()
    await page.getByRole('heading', { name: 'Links', exact: true }).click()
    await expect(picker(page)).toHaveCount(0)
    expect(await opened(scenario.app!)).toEqual([])
    await page.getByRole('link', { name: 'Web page', exact: true }).click()
    await picker(page).getByRole('button', { name: 'Open in default browser', exact: true }).click()
    await expect.poll(() => opened(scenario.app!)).toEqual(['https://example.com/'])
  } finally { await scenario.dispose() }
})

test('document links and document comments retain their project while another project conversation is selected', async ({}, testInfo) => {
  const engine = await startEngine()
  const site = await startPreviewPage()
  const url = `${site.origin}/clients`
  const scenario = await seededScenario(testInfo, engine.origin, `# Links\n\n[Document page](${url})\n`)
  try {
    await scenario.writeSettings({ panels: { explorerWidth: 420 }, animatedBackground: false })
    const page = await scenario.launch()
    const projectId = await page.evaluate(async workspaceRoot => window.strata.createEngineProject({ title: 'Document project', workspaceRoot }), dirname(scenario.file))
    await openThread(page, 'Live engine thread')
    await page.getByRole('link', { name: 'Document page', exact: true }).click()
    await picker(page).getByRole('button', { name: 'Open in Strata', exact: true }).click()
    const tabs = () => page.evaluate(async () => (await window.strata.getState()).preview.tabs)
    await expect.poll(async () => (await tabs()).map(tab => tab.projectId)).toEqual([projectId])
    await switchToDocument(page, /cockpit-engine\.md/)
    await page.evaluate(async ({ path, url }) => window.strata.addAnnotation(path, { kind: 'comment', quote: 'Links', text: `See [comment page](${url}).`, from: 2, to: 7 }), { path: scenario.file, url })
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    await page.locator('.annotations-panel .annotation-row').filter({ hasText: 'Links' }).click()
    await expect(page.getByRole('region', { name: 'comment thread', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('document-comment.png') })
    await expect(page.getByRole('region', { name: 'comment thread', exact: true }).getByRole('link', { name: 'comment page', exact: true })).toBeVisible()
    await page.getByRole('region', { name: 'comment thread', exact: true }).getByRole('link', { name: 'comment page', exact: true }).dblclick()
    await expect.poll(async () => (await tabs()).map(tab => tab.projectId)).toEqual([projectId, projectId])
  } finally { await scenario.dispose(); await engine.close(); await site.close() }
})

test('local .html links get the picker, Markdown links open as documents, and the window never navigates', async ({}, testInfo) => {
  const engine = await startEngine()
  engine.postAssistant('t1', 'Open [prototype](docs/prototype.html?state=working), [plan](notes/plan.md), [missing](docs/missing.html), or [picture](docs/picture.png).')
  const scenario = await seededScenario(testInfo, engine.origin)
  const root = await realpath(dirname(scenario.file))
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'docs', 'prototype.html'), '<!doctype html><title>Prototype</title><h1 id="state"></h1><script>document.getElementById("state").textContent = new URLSearchParams(location.search).get("state") ?? "none"</script>')
  await writeFile(join(root, 'notes', 'plan.md'), '# Plan notes\n\nA plan outside the document folder.\n')
  engine.setWorkspaceRoot(root)
  const pageUrl = `${pathToFileURL(join(root, 'docs', 'prototype.html')).href}?state=working`
  try {
    const page = await scenario.launch()
    await recordExternal(scenario.app!)
    await openThread(page, 'Live engine thread')
    const side = page.locator('.conversation-panel[data-placement="side"]')
    // The completed message mounts its read-only editor a moment after it shows; that resize re-pins the transcript, which would dismiss an open picker.
    await expect(side.locator('[data-message-id] .ProseMirror').first()).toBeVisible()
    const prototype = side.getByRole('link', { name: 'prototype', exact: true })
    await prototype.click()
    await expect(picker(page)).toBeVisible()
    await picker(page).getByRole('button', { name: 'Open in default browser', exact: true }).click()
    await expect.poll(() => opened(scenario.app!)).toEqual([pageUrl])
    await prototype.click()
    await picker(page).getByRole('button', { name: 'Open in Strata', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Cockpit project preview', exact: true })).toBeVisible()
    const tabs = () => page.evaluate(async () => (await window.strata.getState()).preview.tabs)
    await expect.poll(async () => (await tabs()).map(tab => ({ url: tab.url, title: tab.title }))).toEqual([{ url: pageUrl, title: 'Prototype' }])
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toBeVisible()
    await side.getByRole('link', { name: 'missing', exact: true }).click()
    await picker(page).getByRole('button', { name: 'Open in default browser', exact: true }).click()
    await expect(page.getByRole('status')).toContainText(`${join(root, 'docs', 'missing.html')} does not exist.`)
    await side.getByRole('link', { name: 'picture', exact: true }).click()
    await expect(picker(page)).toHaveCount(0)
    await expect(page.getByRole('status')).toContainText('Only web links, .html pages, and Markdown files open from here')
    expect(page.url()).toBe('app://stratamd/')
    expect(await opened(scenario.app!)).toEqual([pageUrl])
    // A Markdown link opens as a document tab with no picker; it goes last because the new document changes what the side panel shows.
    await side.getByRole('link', { name: 'plan', exact: true }).click()
    await expect(picker(page)).toHaveCount(0)
    await expectActiveDocument(page, /plan\.md/)
  } finally { await scenario.dispose(); await engine.close() }
})
