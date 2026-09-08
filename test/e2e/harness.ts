import { _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { constants, realpathSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnnotationContext } from '../../src/shared/contracts'
import { settledBox } from './geometry'
import { scenarioEvidence } from './test'
import { DISPLAYS_VARIABLE, SERIAL_COMMAND, parseDisplays } from './display'

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  removed: string[]
  added: string[]
}

export interface Segment {
  author: 'user' | 'external'
  tag?: { agent: string; name: string }
  hunks: Hunk[]
}

export interface Annotation {
  id: string
  seq?: number
  kind: 'comment' | 'question' | 'suggestion' | 'decision'
  status: 'open' | 'resolved' | 'orphaned'
  anchor?: 'quote' | 'heading' | 'document'
  quote: string
  text: string
  context?: AnnotationContext
  resolution?: 'accepted' | 'rejected'
  decision?: {
    options: readonly string[]
    answers: readonly { seq: number; option: string | null; other?: string; author: 'user'; answeredAt: number }[]
  }
}

export interface DocumentInspection {
  buffer?: string
  document?: string
  attachments?: Array<{ agent: string; name: string; state: string; lead: boolean }>
  segments?: Segment[]
  annotations?: Annotation[]
}

// Canonicalizes TMPDIR before any scenario path derives from it (macOS /var
// symlink). The vitest setup file does the same for unit tests; it registers
// vitest hooks, so Playwright cannot import it.
process.env.TMPDIR = realpathSync(tmpdir())

const here = dirname(fileURLToPath(import.meta.url))
export const projectRoot = resolve(here, '../..')
export const mainEntry = join(projectRoot, 'out/main/index.js')

/**
 * Shortcut helpers so specs never hard-code a platform modifier
 * (mac-plan §6): Command on a Mac host, Control elsewhere, and the Mac
 * arrow-key equivalents of Home and End.
 */
const macHost = process.platform === 'darwin'
export function primaryKey(key: string): string {
  return `${macHost ? 'Meta' : 'Control'}+${key}`
}
export const documentStartKey = macHost ? 'Meta+ArrowUp' : 'Control+Home'
export const documentEndKey = macHost ? 'Meta+ArrowDown' : 'Control+End'
// On a Mac, Home and End scroll without moving the caret; Command+arrow moves it.
export const lineStartKey = macHost ? 'Meta+ArrowLeft' : 'Home'
export const lineEndKey = macHost ? 'Meta+ArrowRight' : 'End'
// Shift+End on a Mac extends the selection to the end of the document, not the line.
export const selectToLineEndKey = macHost ? 'Shift+Meta+ArrowRight' : 'Shift+End'

/** X11 and ozone settings apply only on Linux; a Mac host launches plainly. */
export const launchArgs: string[] = macHost ? [] : ['--ozone-platform=x11']
const linuxLaunchEnv = { ELECTRON_OZONE_PLATFORM_HINT: 'x11' }

/**
 * The X display for this worker. Global setup publishes one display per
 * worker slot; a parallel run without that list would put every window on one
 * display, where each launch steals focus and closes the others' menus, so it
 * is refused rather than allowed to flake.
 */
function workerDisplay(testInfo: TestInfo): string | undefined {
  if (macHost) return undefined
  const displays = parseDisplays(process.env[DISPLAYS_VARIABLE])
  if (!displays) {
    if (testInfo.config.workers > 1) {
      throw new Error(
        `${DISPLAYS_VARIABLE} is unset with ${testInfo.config.workers} workers, so every worker would share one X display. ` +
        `Register test/e2e/display.ts as globalSetup, or run ${SERIAL_COMMAND}`
      )
    }
    return undefined
  }
  const display = displays[testInfo.parallelIndex]
  if (display === undefined) {
    throw new Error(`${DISPLAYS_VARIABLE} has ${displays.length} display(s) but this is worker slot ${testInfo.parallelIndex}; supply one display per worker`)
  }
  return display
}

const CLOSE_TIMEOUT_MS = 5_000
const EXIT_TIMEOUT_MS = 2_000

/** Resolves once the process has exited, killing it if the wait runs out. */
async function processExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  const exited = () => child.exitCode !== null || child.signalCode !== null
  if (exited()) return
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolveExit() }, timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolveExit() })
  })
}


export class Scenario {
  private tracing = false
  private launches = 0
  readonly rawTraces: string
  readonly traces: string[] = []
  readonly screenshots: string[] = []
  private readonly testInfo: TestInfo

  readonly root: string
  readonly file: string
  readonly runtimeRoot: string
  readonly env: Record<string, string>
  app: ElectronApplication | undefined
  page: Page | undefined

  private constructor(root: string, file: string, runtimeRoot: string, env: Record<string, string>, testInfo: TestInfo) {
    this.testInfo = testInfo
    const scenarios = scenarioEvidence(testInfo)
    this.rawTraces = testInfo.outputPath(`electron-raw-${scenarios.size}`)
    scenarios.add(this)
    this.root = root
    this.file = file
    this.runtimeRoot = runtimeRoot
    this.env = env
  }

  static async create(testInfo: TestInfo, content: string | Buffer, name = 'scenario.md'): Promise<Scenario> {
    // Documents live in this isolated directory so acceptance fixtures are outside StrataMD's
    // own Git worktree and exercise the PRD's non-Git baseline behavior.
    // The ghost store and Electron's user data live here too, not under
    // testInfo.outputPath: Playwright deletes its output directory at the
    // start of every run and again before every test, so anything kept there
    // is deleted out from under a running app by any second Playwright run in
    // this repo.
    const runtime = await mkdtemp(join(tmpdir(), 'stratamd-e2e-'))
    const root = runtime
    const documentRoot = join(runtime, 'documents')
    const file = join(documentRoot, name)
    const data = join(runtime, 'data')
    const config = join(runtime, 'config')
    const userData = join(runtime, 'user-data')

    await Promise.all([mkdir(documentRoot, { recursive: true }), mkdir(data, { recursive: true }), mkdir(config, { recursive: true }), mkdir(userData, { recursive: true })])
    await writeFile(file, content)
    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => !['ELECTRON_RUN_AS_NODE', 'WAYLAND_DISPLAY'].includes(entry[0]) && entry[1] !== undefined
      )
    )
    const display = workerDisplay(testInfo)
    return new Scenario(root, file, runtime, {
      ...inheritedEnvironment,
      // The worker's own X display (test/e2e/display.ts); the inherited one on a serial run.
      ...(display === undefined ? {} : { DISPLAY: display }),
      XDG_RUNTIME_DIR: runtime,
      XDG_DATA_HOME: data,
      XDG_CONFIG_HOME: config,
      // Isolates Electron's profile and its single-instance lock per scenario;
      // XDG_CONFIG_HOME only achieves that on Linux.
      STRATAMD_ENGINE_MODE: 'external',
      STRATAMD_USER_DATA: userData,
      STRATAMD_TEST_LOGIN_FILE: join(runtime, 'login-registration.json'),
      ...(macHost ? {} : linuxLaunchEnv),
      // Every e2e run checks each merged view update against the full view.
      // Performance profiles measure the production protocol, so verify mode
      // (which ships the full view beside every patch) stays off for them.
      STRATAMD_VIEW_VERIFY: process.env.STRATAMD_PERF_PROFILE ? '0' : '1',
      // Every stitched block-scoped reparse is checked against a full parse
      // (docs/plans/completed/reparse-plan.md §7); off for perf profiles for the same reason.
      STRATAMD_PARSE_VERIFY: process.env.STRATAMD_PERF_PROFILE ? '0' : '1',
      // Each boundary renders a hidden crash-probe button for the containment
      // tests (docs/plans/completed/crash-hardening-plan.md §4).
      STRATAMD_CRASH_PROBE: '1'
    }, testInfo)
  }

  /** Tests use a fixed Strata Vivid fixture unless they choose a theme. */
  async writeSettings(settings: Record<string, unknown>): Promise<void> {
    const path = join(String(this.env.XDG_CONFIG_HOME), 'stratamd/settings.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ theme: 'strata-vivid', ...settings }, null, 2)}\n`)
  }

  async launch(file = this.file, extraArgs: string[] = []): Promise<Page> {
    await access(mainEntry, constants.R_OK)
    // Tests that wrote no settings still get an explicit theme so visual
    // assertions never depend on the fallback path.
    const settingsPath = join(String(this.env.XDG_CONFIG_HOME), 'stratamd/settings.json')
    try {
      await access(settingsPath, constants.R_OK)
    } catch {
      await this.writeSettings({})
    }
    this.app = await electron.launch({
      args: [...launchArgs, ...extraArgs, mainEntry, file],
      cwd: projectRoot,
      tracesDir: this.rawTraces,
      env: this.env
    })
    this.launches += 1
    if (!process.env.STRATAMD_PERF_PROFILE) {
      await this.app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
      this.tracing = true
    }
    this.page = await this.app.firstWindow()
    await this.page.waitForLoadState('domcontentloaded')
    await expect.poll(async () => (await this.page!.evaluate(() => window.strata.getState())).activeDocument?.path).toBe(file)
    await expect(this.page.getByRole('button', { name: 'Docs menu', exact: true })).toBeVisible()
    return this.page
  }

  async launchEmpty(): Promise<Page> {
    await access(mainEntry, constants.R_OK)
    this.app = await electron.launch({
      args: [...launchArgs, mainEntry],
      cwd: projectRoot,
      tracesDir: this.rawTraces,
      env: this.env
    })
    this.launches += 1
    if (!process.env.STRATAMD_PERF_PROFILE) {
      await this.app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
      this.tracing = true
    }
    this.page = await this.app.firstWindow()
    await this.page.waitForLoadState('domcontentloaded')
    await expect(this.page.getByRole('button', { name: 'StrataMD menu' })).toBeVisible()
    return this.page
  }

  async captureEvidence(): Promise<void> {
    const app = this.app
    if (!app || !this.tracing) return
    this.tracing = false
    const name = `electron-${this.testInfo.parallelIndex}-${this.testInfo.testId.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}-${[...scenarioEvidence(this.testInfo)].indexOf(this)}-${this.launches}`
    const trace = this.testInfo.outputPath(`${name}.zip`)
    const screenshot = this.testInfo.outputPath(`${name}.png`)
    // Disposal often runs inside a test's finally block, before Playwright marks
    // the assertion failed. Keep evidence until afterEach knows the result.
    if (this.testInfo.status !== this.testInfo.expectedStatus || this.testInfo.errors.length) {
      await this.page?.screenshot({ path: screenshot }).then(() => this.screenshots.push(screenshot)).catch(() => undefined)
    }
    try {
      await app.context().tracing.stop({ path: trace })
      this.traces.push(trace)
    } catch (error) {
      // A process may exit through a native close action before teardown. Raw
      // trace data is already in this invocation's directory, even on a crash.
      const child = app.process()
      if ((child.exitCode === null && child.signalCode === null) || !/Target page, context or browser has been closed/.test(String(error))) throw error
      await this.testInfo.attach('electron-trace-note', { body: `Electron exited before archive export. Raw trace: ${this.rawTraces}`, contentType: 'text/plain' })
    }
  }

  async stop(crash = false): Promise<void> {
    try { await this.captureEvidence() } finally { await this.closeApplication(crash) }
  }

  private async closeApplication(crash: boolean): Promise<void> {
    const app = this.app
    this.app = undefined
    this.page = undefined
    if (!app) return

    if (crash) {
      let child: ChildProcess
      try { child = app.process() } catch { return }
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>((resolveClose) => {
        const timer = setTimeout(resolveClose, 2_000)
        child.once('exit', () => { clearTimeout(timer); resolveClose() })
        child.kill('SIGKILL')
      })
      return
    }

    // A quit the app declines (a close prompt) or a stalled helper would
    // otherwise hold the scenario's single-instance lock into the next launch
    // and eat the test budget in silence; the close is bounded and the exit
    // verified.
    let child: ChildProcess | undefined
    try { child = app.process() } catch { child = undefined }
    try {
      await Promise.race([
        app.close(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Electron did not close within the bound')), CLOSE_TIMEOUT_MS))
      ])
    } catch {
      child?.kill('SIGKILL')
    }
    if (child) await processExit(child, EXIT_TIMEOUT_MS)
  }

  async dispose(): Promise<void> {
    await this.stop(true).catch(() => undefined)
    // Electron's helper processes can still be flushing into config/Electron
    // when the main process dies, so a single pass can hit ENOTEMPTY.
    await rm(this.runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }

  async inspectDocument(file = this.file): Promise<DocumentInspection> {
    if (!this.page) throw new Error('The application is not running')
    const document = await this.page.evaluate(async () => (await window.strata.getState()).activeDocument)
    if (document === null || document.path !== file) throw new Error(`The active document is not ${file}`)
    const hunks = document.pendingHunks.map(({ oldStart, oldLines, newStart, newLines, removed, added }) => ({ oldStart, oldLines, newStart, newLines, removed, added }))
    return {
      buffer: document.bufferPath,
      document: document.content,
      attachments: document.attachments.map((attachment) => ({
        agent: attachment.agent.id,
        name: attachment.agent.name,
        state: attachment.state,
        lead: attachment.agent.id === document.leadAgentId,
      })),
      segments: hunks.length === 0 ? [] : [{ author: 'external', hunks }],
      annotations: document.annotations as Annotation[],
    }
  }

  async atomicWrite(path: string, content: string | Buffer): Promise<void> {
    const temporary = `${path}.stratamd-acceptance-tmp`
    await writeFile(temporary, content)
    await rename(temporary, path)
  }

  async waitForBuffer(expected: string, timeoutMs = 5_000): Promise<void> {
    const payload = await this.inspectDocument()
    expect(payload.buffer).toBeTruthy()
    await expect.poll(async () => readFile(payload.buffer!, 'utf8'), { timeout: timeoutMs }).toBe(expected)
  }
}


export async function sourceEditor(page: Page) {
  const source = page.getByRole('textbox', { name: /source editor/i })
  if (await source.count()) return source.first()
  // Setup helpers should not depend on whichever control happened to receive
  // focus at launch. Shortcut behavior is exercised directly in dedicated specs.
  await page.getByRole('button', { name: /source$/i }).click()
  await expect(source).toBeVisible()
  return source
}

export async function setSource(page: Page, content: string): Promise<void> {
  const editor = await sourceEditor(page)
  await editor.fill(content)
}

/** Completion belongs to this IPC request, including no-op saves and conflicts. */
export async function save(page: Page): Promise<void> {
  const diagnostics = () => page.evaluate(() => (window.strata as unknown as {
    saveDiagnostics(): { issued: number; completed: { request: number; path: string; error: string | null } | null }
  }).saveDiagnostics())
  const before = await diagnostics()
  const path = await page.evaluate(async () => (await window.strata.getState()).activeDocument!.path)
  await page.getByRole('button', { name: /^Saved?$/i }).click()
  await expect.poll(async () => {
    const result = (await diagnostics()).completed
    return result?.request === before.issued + 1 && result.path === path
  }).toBe(true)
  const result = (await diagnostics()).completed!
  if (result.error) {
    await expect(page.getByRole('dialog', { name: /changed outside StrataMD while you were editing/i }), result.error).toBeVisible()
  }
}

export async function send(page: Page, options: { note?: string; includeExternal?: boolean; recipientNames?: string[] } = {}): Promise<void> {
  await page.getByRole('button', { name: /^Send(?:\b|$)/i }).first().click()
  const dialog = page.getByRole('dialog', { name: /Send changes/i })
  await expect(dialog).toBeVisible()
  if (options.note) await dialog.getByRole('textbox', { name: /note/i }).fill(options.note)
  if (options.recipientNames) {
    const recipients = dialog.locator('fieldset').getByRole('checkbox')
    for (let index = 0; index < await recipients.count(); index += 1) {
      const checkbox = recipients.nth(index)
      const name = await checkbox.evaluate((input) => input.closest('label')?.textContent?.trim() ?? '')
      if (options.recipientNames.includes(name)) await checkbox.check()
      else await checkbox.uncheck()
    }
  }
  if (options.includeExternal) {
    // External changes are unchecked items now, not a global toggle.
    const externals = dialog.locator('.send-item[data-author="external"] input[type="checkbox"]')
    await expect(externals.first()).toBeVisible()
    for (let index = 0; index < await externals.count(); index += 1) await externals.nth(index).check()
  }
  // Preview content and queued notices can move the action row. Setup sends
  // wait for that layout; send-composer.spec.ts separately covers queued clicks.
  await expect(dialog.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false')
  await settledBox(page, dialog)
  await dialog.getByRole('button', { name: /^Send$/i }).click()
  await expect(dialog).toBeHidden()
}

export async function selectTextInVisualEditor(page: Page, exactText: string): Promise<void> {
  const source = page.getByRole('textbox', { name: /source editor/i })
  if (await source.isVisible().catch(() => false)) await page.keyboard.press(primaryKey('/'))

  const editor = page.getByRole('textbox', { name: /document editor/i })
  await expect(editor).toBeVisible()
  await editor.focus()
  const selected = await editor.evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const value = node.textContent ?? ''
      const start = value.indexOf(needle)
      if (start < 0) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + needle.length)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  }, exactText)
  expect(selected, `Could not find ${JSON.stringify(exactText)} in the visual editor`).toBe(true)
}

export async function selectVisualEditorRange(page: Page, startText: string, endText: string): Promise<void> {
  const editor = page.getByRole('textbox', { name: /document editor/i })
  await expect(editor).toBeVisible()
  await editor.focus()
  const selected = await editor.evaluate((root, endpoints) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let startNode: Text | null = null
    let startOffset = -1
    let endNode: Text | null = null
    let endOffset = -1
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const value = node.data
      if (!startNode) {
        const found = value.indexOf(endpoints.startText)
        if (found >= 0) {
          startNode = node
          startOffset = found
        }
      }
      if (startNode) {
        const found = value.indexOf(endpoints.endText)
        if (found >= 0) {
          endNode = node
          endOffset = found + endpoints.endText.length
        }
      }
    }
    if (!startNode || !endNode) return false
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    return true
  }, { startText, endText })
  expect(selected, `Could not select ${JSON.stringify(startText)} through ${JSON.stringify(endText)}`).toBe(true)
}

export function allHunks(payload: DocumentInspection): Hunk[] {
  return (payload.segments ?? []).flatMap((segment) => segment.hunks ?? [])
}

export function externalText(payload: DocumentInspection): string {
  return (payload.segments ?? [])
    .filter((segment) => segment.author === 'external')
    .flatMap((segment) => segment.hunks)
    .flatMap((hunk) => [...hunk.removed, ...hunk.added])
    .join('\n')
}

/** Waits for the persisted tab selection, including its panel becoming visible. */
export async function selectNavigationTab(page: Page, name: 'Projects' | 'Conversation' | 'Contents'): Promise<void> {
  const tab = page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator(`#navigation-panel-${name.toLowerCase()}`)).toBeVisible()
}

/**
 * Brings an open document to the center through the Docs menu.
 */
export async function switchToDocument(page: Page, name: RegExp): Promise<void> {
  await openDocsMenu(page)
  await page.getByRole('menu', { name: 'Open docs' }).getByRole('menuitem', { name }).click()
}

/** Open the logo menu through its visible control before choosing a shell action. */
export async function openAppMenu(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: 'StrataMD menu' })
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  await expect(page.getByRole('menu', { name: 'StrataMD', exact: true })).toBeVisible()
}

/** Assert document state without relying on the removed active-document pill. */
export async function expectActiveDocument(page: Page, name: RegExp): Promise<void> {
  await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).activeDocument?.path ?? '').toMatch(name)
  await expect(page.locator('.editor-island [data-document-path]')).toHaveAttribute('data-document-path', name)
}

export async function expectDocumentListed(page: Page, name: RegExp, listed = true): Promise<void> {
  await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).tabs.some(tab => name.test(tab.path))).toBe(listed)
}

export async function openDocsMenu(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Docs menu', exact: true })
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  await expect(page.getByRole('menu', { name: 'Open docs', exact: true })).toBeVisible()
}

export async function expectDocumentDirty(page: Page, name: RegExp, dirty: boolean): Promise<void> {
  await openDocsMenu(page)
  await expect(page.getByRole('menu', { name: 'Open docs', exact: true }).getByRole('menuitem', { name }).locator('.tab-dirty-dot')).toHaveCount(dirty ? 1 : 0)
  await page.keyboard.press('Escape')
}
