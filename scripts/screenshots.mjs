// Produces high-resolution product-page screenshots from a real build of the app.
//
//   pnpm build && node scripts/screenshots.mjs
//
// Launches the built main process against an isolated XDG home, opens the
// real agent-written plan, captures every stock theme, attaches two agents through
// the real CLI, and captures the review and collaboration states the page shows.
// Nothing here touches your normal StrataMD data or config.

import { _electron as electron, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out/main/index.js')
const cli = join(root, 'bin/stratamd')
const outDir = join(root, 'docs/screenshots/product')
const themeDir = join(outDir, 'themes')
const stateDir = join(outDir, 'states')
const sourcePath = process.env.STRATAMD_SCREENSHOT_SOURCE
  ? resolve(process.env.STRATAMD_SCREENSHOT_SOURCE)
  : join(root, 'docs/plans/completed/agent-collaboration-plan.md')
const viewport = { width: 2560, height: 1440 }
const workspaceClip = { x: 430, y: 100, width: 2070, height: 1260 }
const themeIds = ['strata', 'strata-vivid', 'ember', 'candyfloss', 'isotope', 'nebula', 'paper']
const activeThemePath = (id) => join(themeDir, `${id}-active-review.png`)

// A fixed path gives the explorer a believable project name while keeping the
// entire session isolated from the user's real StrataMD data.
const base = join(tmpdir(), 'product-demo', 'stratamd-shots')
await rm(base, { recursive: true, force: true })
const runtime = join(base, 'workspace')
const notes = join(runtime, 'agent-project')
const data = join(runtime, 'data')
const config = join(runtime, 'config')
await mkdir(runtime, { recursive: true })
await Promise.all([
  mkdir(join(notes, 'resources'), { recursive: true }),
  mkdir(join(notes, 'plans'), { recursive: true }),
  mkdir(join(notes, 'research'), { recursive: true }),
  mkdir(join(notes, 'notes'), { recursive: true }),
  mkdir(join(notes, 'archive'), { recursive: true }),
  mkdir(data),
  mkdir(join(config, 'stratamd'), { recursive: true }),
  mkdir(themeDir, { recursive: true }),
  mkdir(stateDir, { recursive: true })
])

const withoutProductImages = (await readFile(sourcePath, 'utf8'))
  .replace(/^\*Screenshots open at their full captured resolution\.\*\n?/m, '')
  .replace(/^\| Paper \| Strata Vivid \|\n\|:---:\|:---:\|\n.*screenshots\/product\/themes\/paper\.png.*\n\| Candyfloss \| Ember \|\n.*screenshots\/product\/themes\/candyfloss\.png.*\n?/m, '')
  .replace(/^.*screenshots\/product\/.*\n?/gm, '')
const sample = withoutProductImages.replace('../../resources/stratamd-icon.svg', 'resources/stratamd-icon.svg')
const doc = join(notes, basename(sourcePath))
await writeFile(doc, sample)
await copyFile(join(root, 'resources/stratamd-icon.svg'), join(notes, 'resources/stratamd-icon.svg'))
const reviewNotes = join(notes, 'review-notes.md')
const requirements = join(notes, 'requirements.md')
await Promise.all([
  writeFile(reviewNotes, '# Review notes\n\nQuestions and decisions from the current agent round.\n'),
  writeFile(requirements, '# Requirements\n\nThe user keeps final review authority.\n'),
  writeFile(join(notes, 'README.md'), '# Agent project\n\nPlans reviewed in StrataMD.\n'),
  writeFile(join(notes, 'plans/implementation.md'), '# Implementation\n\nCurrent build sequence.\n'),
  writeFile(join(notes, 'plans/release-checklist.md'), '# Release checklist\n\n- [ ] Review agent changes\n- [ ] Run tests\n'),
  writeFile(join(notes, 'plans/windows-support.md'), '# Windows support\n\nPackaging notes.\n'),
  writeFile(join(notes, 'research/agent-behavior.md'), '# Agent behavior\n\nCommon planning failures and review notes.\n'),
  writeFile(join(notes, 'research/editor-comparison.md'), '# Editor comparison\n\nNotes from testing Markdown readers.\n'),
  writeFile(join(notes, 'notes/open-questions.md'), '# Open questions\n\nItems for the next review round.\n'),
  writeFile(join(notes, 'notes/theme-ideas.md'), '# Theme ideas\n\nColor and layout experiments.\n'),
  writeFile(join(notes, 'archive/earlier-draft.md'), '# Earlier draft\n\nSuperseded.\n')
])
await writeFile(join(config, 'stratamd/settings.json'), JSON.stringify({
  explorerFolders: [notes],
  panels: {
    explorerWidth: 340,
    rightRailWidth: 470,
    changesHeight: 500,
    annotationsHeight: 390,
    documentMeasure: 1180,
    themePanel: { x: 1880, y: 160, width: 620, height: 1180 },
    sendComposer: { width: 1160, height: 760 }
  }
}, null, 2))

const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !['ELECTRON_RUN_AS_NODE', 'WAYLAND_DISPLAY'].includes(key) && value !== undefined))
Object.assign(env, { XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, ELECTRON_OZONE_PLATFORM_HINT: 'x11' })

function run(args) {
  return new Promise((done, fail) => {
    const child = spawn(cli, args, { cwd: root, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', fail)
    child.once('close', (code) => done({ code, stdout, stderr }))
  })
}

async function payload(args) {
  const result = await run(args)
  if (result.code !== 0) throw new Error(`stratamd ${args.join(' ')} failed (${result.code}): ${result.stderr}`)
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined
}

const app = await electron.launch({ args: ['--ozone-platform=x11', mainEntry, doc], cwd: root, env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.setViewportSize(viewport)
await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible()

const settle = async (ms = 700) => page.waitForTimeout(ms)
const shot = async (path, options = {}) => {
  await page.evaluate(() => document.activeElement?.blur())
  await settle()
  await page.locator('.toast').evaluateAll((elements) => elements.forEach((element) => {
    element.style.visibility = 'hidden'
  }))
  await page.screenshot({ path, animations: 'disabled', ...options })
  console.log(`wrote ${path.replace(`${root}/`, '')}`)
}

const scrollToTop = async () => page.locator('.editor-scroll').evaluate((element) => { element.scrollTop = 0 })
const scrollToText = async (text) => {
  const found = await page.getByRole('textbox', { name: /document editor/i }).evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (!(node.textContent ?? '').includes(needle)) continue
      node.parentElement?.scrollIntoView({ block: 'center' })
      return true
    }
    return false
  }, text)
  if (!found) throw new Error(`Could not scroll to ${JSON.stringify(text)}`)
  await settle(350)
}

// A used project has context around the active plan. Keep supporting documents
// open as tabs and expand the two folders most relevant to the review.
await page.getByRole('button', { name: 'Scan', exact: true }).click()
const plansFolder = page.locator('.folder-row.subfolder').filter({ hasText: 'plans' })
const researchFolder = page.locator('.folder-row.subfolder').filter({ hasText: 'research' })
await expect(plansFolder).toBeVisible()
await expect(page.locator('.toast').filter({ hasText: 'Scan complete' })).toHaveCount(0, { timeout: 10_000 })
await page.evaluate(async (path) => window.strata.openDocument(path), reviewNotes)
await page.evaluate(async (path) => window.strata.openDocument(path), requirements)
await page.evaluate(async (path) => window.strata.openDocument(path), doc)
await expect(page.getByRole('tab')).toHaveCount(3)
await plansFolder.click()
await researchFolder.click()

// 1. The theme picker over a plain theme so the control depth stays readable.
await page.evaluate(() => window.strata.selectTheme('paper'))
await page.getByRole('button', { name: /^Theme$/ }).click()
const panel = page.getByRole('dialog', { name: 'Theme' })
await expect(panel).toBeVisible()
await shot(join(stateDir, 'theme-panel.png'))
await page.screenshot({ path: join(stateDir, 'theme-panel--workspace.png'), animations: 'disabled', clip: workspaceClip })
console.log(`wrote ${join(stateDir, 'theme-panel--workspace.png').replace(`${root}/`, '')}`)
await panel.getByRole('button', { name: /Close theme panel/ }).click()
await page.getByRole('tab', { name: new RegExp(basename(sourcePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).click()
await expect(page.getByRole('textbox', { name: /document editor/i })).toContainText('Agent messages, the Lead agent, and the review board')

// 2. Build a dense but real review round before the product captures. Three
// agents join, Claude leads, one agent has a message waiting, several edits have
// already been saved, three more remain unsaved, and seven annotations map the
// discussion. This is the state the app is designed for.
await page.evaluate(() => window.strata.selectTheme('ember'))
const codex = await payload(['attach', doc, '--as', 'codex', '--name', 'Codex', '--timeout', '0'])
await payload(['attach', doc, '--as', 'claude', '--name', 'Claude', '--timeout', '0'])
await payload(['attach', doc, '--as', 'gemini', '--name', 'Gemini', '--timeout', '0'])
await payload(['lead', doc, '--as', 'claude'])
await payload(['send', doc, '--as', 'codex', '--to', 'gemini', '--text', 'Review the requirements section after Claude finishes the wording pass.'])

let edited = sample
const writeAgentEdit = async (agent, name, needle, replacement) => {
  if (!edited.includes(needle)) throw new Error(`Screenshot source is missing ${JSON.stringify(needle)}`)
  await payload(['changed', doc, '--as', agent, '--name', name])
  edited = edited.replace(needle, replacement)
  const temporary = `${codex.buffer}.${agent}.tmp`
  await writeFile(temporary, edited)
  await rename(temporary, codex.buffer)
  await settle(250)
}

await writeAgentEdit('codex', 'Codex', '**review board** revamp', '**review board** redesign')
await writeAgentEdit('gemini', 'Gemini', 'Messages remove that manual relay.', 'Agent messages remove that manual relay.')
await writeAgentEdit('claude', 'Claude', 'One attachment per document may hold the Lead.', 'Only one attachment per document may hold the Lead.')
await writeAgentEdit('codex', 'Codex', '| End-of-round notification | None |', '| End-of-round notification | No notification |')
await expect(page.locator('.change-row')).toHaveCount(4)

// Saving creates a real saved-review group and one save-history round. Agent
// changes remain pending for the user, exactly as they do in normal use.
await payload(['save', doc, '--as', 'claude'])
await expect(page.locator('.save-history-heading')).toContainText('Saves · 1')

await writeAgentEdit('codex', 'Codex', 'Three features carry this:', 'Three pieces carry this:')
await writeAgentEdit('gemini', 'Gemini', 'fresh attachments hold no privileges', 'new attachments hold no privileges')
await writeAgentEdit('claude', 'Claude', 'The user returns to a saved file', 'The user comes back to a saved file')

await payload(['annotate', doc, '--as', 'claude', '--kind', 'suggestion',
  '--quote', "nothing an agent does moves the user's review state",
  '--text', 'agent decisions never count as user review'])
await payload(['annotate', doc, '--as', 'gemini', '--kind', 'suggestion',
  '--quote', "the user's Send is the only thing that wakes a waiting agent",
  '--text', "only the user's Send wakes a waiting agent"])
await payload(['annotate', doc, '--as', 'codex', '--kind', 'comment',
  '--quote', 'user in the loop',
  '--label', 'Review mode',
  '--text', 'This is the useful middle ground: agents review each other, while the user still controls the round.'])
await payload(['annotate', doc, '--as', 'claude', '--kind', 'question',
  '--quote', 'new attachments hold no privileges',
  '--text', 'Should this call out that every agent starts without Lead?'])
await payload(['annotate', doc, '--as', 'gemini', '--kind', 'comment',
  '--quote', 'Lead accepts agreed suggestions and saves',
  '--label', 'Agent handoff',
  '--text', 'This makes the unattended review mode concrete.'])
await payload(['annotate', doc, '--as', 'codex', '--kind', 'question',
  '--quote', 'One unacked message per sender→recipient pair',
  '--text', 'Does the sender get a clear retry message when this slot is occupied?'])
await payload(['annotate', doc, '--as', 'claude', '--kind', 'question',
  '--quote', 'Only one attachment per document may hold the Lead.',
  '--text', 'Should the reviewer lead the next round, or should the drafting agent keep it?'])
await expect(page.locator('.annotation-row')).toHaveCount(7)
await expect(page.locator('.change-group-heading').filter({ hasText: 'Proposed' })).toContainText('Proposed · 2')
await expect(page.locator('.change-group-heading').filter({ hasText: 'Unsaved' })).toContainText('Unsaved · 3')
await expect(page.locator('.change-group-heading').filter({ hasText: /^Saved/ })).toContainText('Saved · 3')
await expect(page.getByRole('button', { name: /^Send(?:\b|$)/i })).toBeEnabled()

// 3. Capture the hero and every stock theme only after the document has a real
// review round in progress. The hero shows the plan with populated review rails.
// The theme set holds the same active document position so color and hierarchy
// remain directly comparable across themes.
await page.evaluate(() => window.strata.selectTheme('strata-vivid'))
await scrollToText('Three pieces carry this')
await shot(join(stateDir, 'hero-active-review.png'))
for (const id of themeIds) {
  await page.evaluate((theme) => window.strata.selectTheme(theme), id)
  await settle(900)
  await shot(activeThemePath(id))
}

// 4. One collaboration frame carries the annotation, review, attribution, and
// Lead story together. Source mode gets its own composition later.
await page.evaluate(() => window.strata.selectTheme('candyfloss'))
await scrollToText('user in the loop')
await page.locator('.annotation-row').filter({ hasText: 'user in the loop' }).click()
await expect(page.getByRole('dialog', { name: /comment thread/i })).toBeVisible()
await shot(join(stateDir, 'collaboration.png'))
await page.getByRole('button', { name: /Close thread/i }).click()

await page.evaluate(() => window.strata.selectTheme('isotope'))
await page.keyboard.press('Control+/')
const sourceEditor = page.getByRole('textbox', { name: /source editor/i })
await expect(sourceEditor).toBeVisible()
const sourceRatio = await sourceEditor.evaluate((element, needle) => {
  const index = element.value.indexOf(needle)
  if (index < 0) throw new Error(`Could not find ${JSON.stringify(needle)} in source view`)
  element.blur()
  const line = element.value.slice(0, index).split('\n').length
  const lines = element.value.split('\n').length
  return Math.max(0, (line - 6) / lines)
}, '## 4. The Lead agent')
await page.locator('.editor-scroll').evaluate((element, ratio) => {
  element.scrollTop = ratio * (element.scrollHeight - element.clientHeight)
}, sourceRatio)
await settle()
await page.screenshot({ path: join(stateDir, 'source-review.png'), animations: 'disabled' })
console.log(`wrote ${join(stateDir, 'source-review.png').replace(`${root}/`, '')}`)
await page.screenshot({ path: join(stateDir, 'source-review--workspace.png'), animations: 'disabled', clip: workspaceClip })
console.log(`wrote ${join(stateDir, 'source-review--workspace.png').replace(`${root}/`, '')}`)
await page.keyboard.press('Control+/')
await expect(page.locator('.ProseMirror')).toBeVisible()

// 5. Per-recipient Send preview in the context of the complete app window.
await page.evaluate(() => window.strata.selectTheme('strata'))
await page.getByRole('button', { name: /^Send(?:\b|$)/i }).click()
const composer = page.getByRole('dialog', { name: /Send changes/i })
await expect(composer).toBeVisible()
await composer.getByRole('textbox', { name: /note/i }).fill('Claude, review the Lead safeguard. Codex, check whether the message queue rules still preserve the user review boundary.')
await settle(1000)
await shot(join(stateDir, 'send-preview.png'))
await composer.screenshot({ path: join(stateDir, 'send-preview--detail.png'), animations: 'disabled' })
console.log(`wrote ${join(stateDir, 'send-preview--detail.png').replace(`${root}/`, '')}`)
await page.keyboard.press('Escape')
await expect(composer).toBeHidden()

await app.close()
await rm(base, { recursive: true, force: true })
console.log(`done: ${outDir} at ${viewport.width}x${viewport.height}`)
