// Capture preparation, using the real built Electron app and synthetic engine data.
// Run from the repository root under xvfb-run -a. See capture-notes.md.
import { _electron as electron, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { seededScenario, startEngine } from '../../test/e2e/cockpit-engine-harness.ts'

const root = process.cwd()
const output = resolve('docs/readme/images')
await mkdir(output, { recursive: true })
const evidence = '/tmp/strata-readme-capture-evidence'
await mkdir(evidence, { recursive: true })
const info = { config: { workers: 1 }, parallelIndex: 0, testId: 'readme-capture', status: 'passed', expectedStatus: 'passed', errors: [], outputPath: name => join(evidence, name), attach: async () => {} }
const engine = await startEngine({ pendingRequests: false, previewAutomation: true, titles: { t1: 'Review keyboard navigation', t2: 'Plan saved views' } })
const reply = `# Saved views, without extra setup

The board already remembers your filters. Give that state a name and make it easy to return to.

<Verdict outcome="recommended">
### Save the view, keep the board familiar

Put saved views above the board. Keep the existing filters available so a saved view is a starting point you can adjust.
</Verdict>

## Two ways to remember a view

<DecisionMatrix>
| Criterion | On this device | Shared with the team |
| --- | --- | --- |
| Setup | None | Account required |
| Works offline | Yes | Cached views only |
| Best fit | Personal workflow | Team conventions |
</DecisionMatrix>

## What the first version should do

Save a view automatically whenever a filter changes.

Keep the last-used view selected when the project opens again. Give each saved view a name, an edit action, and a way to remove it.

<Callout kind="context">
### One decision before building

Should changes update the saved view immediately, or wait until you choose Save changes?
</Callout>
`
engine.postAssistant('t2', reply)
engine.complete()
const scenario = await seededScenario(info, engine.origin, '# Saved views\n\nA fictional project for Strata screenshots.\n', 'Saved views.md')
engine.setWorkspaceRoot(dirname(scenario.file))
await scenario.writeSettings({ theme: 'strata-vivid', animatedBackground: false, panels: { explorerWidth: 265, rightRailWidth: 365, upperReviewHeight: 520, documentMeasure: 1200 } })

const siteHtml = await readFile(new URL('./test-board.html', import.meta.url), 'utf8')
const site = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(siteHtml) })
await new Promise(resolveReady => site.listen(0, '127.0.0.1', resolveReady))
const siteUrl = `http://127.0.0.1:${site.address().port}`
let app
try {
  app = await electron.launch({
    args: ['--ozone-platform=x11', '--remote-debugging-port=19381', process.env.STRATA_CAPTURE_MAIN || join(root, 'out/main/index.js'), scenario.file],
    cwd: root,
    env: { ...scenario.env, NODE_PATH: join(root, 'node_modules') },
  })
  scenario.app = app
  const page = await app.firstWindow()
  scenario.page = page
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 0, y: 0, width: 1600, height: 1060 }) })
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: 'Open Plan saved views', exact: true }).click()
  await page.getByRole('button', { name: 'Open in center' }).click()
  await page.evaluate(async () => { const active = (await window.strata.getState()).activeDocument; if (active) await window.strata.closeDocument(active.path) })
  await expect(page.locator('.conversation-panel[data-placement="center"] .strata-prosemirror')).toContainText('Saved views, without extra setup')
  await page.evaluate(() => document.fonts.ready)
  await writeFile(join(evidence, 'ready.json'), JSON.stringify({ siteUrl, profile: scenario.runtimeRoot, main: process.env.STRATA_CAPTURE_MAIN || join(root, 'out/main/index.js') }, null, 2))
  console.log(`Ready on CDP 19381. Preview: ${siteUrl}. Control server: http://127.0.0.1:19382`)
  // Small local control endpoint for window captures. Capture the browser in
  // annotation mode, where Strata renders the captured page and marks together.
  // A live child WebContentsView is omitted by BrowserWindow.capturePage.
  const control = createServer(async (request, response) => {
    try {
      const action = new URL(request.url, 'http://127.0.0.1').pathname.slice(1)
      if (action === 'stop') { response.end('stopping'); control.close(); return }
      if (!['agent-workspace', 'passage-comment', 'browser-annotation'].includes(action)) { response.writeHead(404); response.end(); return }
      const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG())
      await writeFile(join(output, `${action}.png`), Buffer.from(bytes))
      response.end(`Captured ${action}`)
    } catch (error) { response.writeHead(500); response.end(String(error)) }
  })
  await new Promise(resolveReady => control.listen(19382, '127.0.0.1', resolveReady))
  await new Promise(resolveStopped => control.once('close', resolveStopped))
} finally {
  await scenario.dispose()
  await engine.close()
  await new Promise(resolveClosed => site.close(resolveClosed))
}
