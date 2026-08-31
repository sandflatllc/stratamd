// Canonicalizes TMPDIR before any scenario path derives from it (macOS /var symlink).
import '../setup-tmpdir'
import { _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  kind: 'comment' | 'question' | 'suggestion'
  status: 'open' | 'resolved' | 'orphaned'
  quote: string
  text: string
  resolution?: 'accepted' | 'rejected'
}

export interface Payload {
  version?: number
  file?: string
  buffer?: string
  agent?: string
  event: 'initial' | 'send' | 'message' | 'resync' | 'closed' | 'timeout' | 'superseded' | 'state' | 'changes'
  deliveryId?: string
  from?: { agent: string; name: string }
  document?: string
  notes?: string[]
  attachments?: Array<{ agent: string; name: string; state: string; lead: boolean }>
  segments?: Segment[]
  annotations?: Annotation[]
  resolved?: Array<{ id: string; kind: string; resolution: string }>
  edits?: Array<{ seq: number; verdict: 'kept' | 'reverted'; quote: string }>
  partial?: boolean
  text?: string
}

export interface CliResult {
  code: number
  pid: number | undefined
  stdout: string
  stderr: string
  payload: Payload | undefined
  error: unknown
}

const here = dirname(fileURLToPath(import.meta.url))
export const projectRoot = resolve(here, '../..')
export const mainEntry = join(projectRoot, 'out/main/index.js')
export const cliEntry = join(projectRoot, 'bin/stratamd')

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

/**
 * X11 and ozone settings apply only on Linux. On a Mac the window is occluded
 * whenever no one is at the screen (every CI runner), and Chromium then stops
 * producing frames — scroll events from programmatic scrolls never fire, so
 * anything recorded from them (scroll offsets) silently stays stale.
 */
export const launchArgs: string[] = macHost
  ? ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
  : ['--ozone-platform=x11']
const linuxLaunchEnv = { ELECTRON_OZONE_PLATFORM_HINT: 'x11' }

function parseJson(value: string): unknown {
  const trimmed = value.trim()
  return trimmed ? JSON.parse(trimmed) : undefined
}

export class Scenario {
  readonly root: string
  readonly file: string
  readonly runtimeRoot: string
  readonly env: Record<string, string>
  app: ElectronApplication | undefined
  page: Page | undefined

  private constructor(root: string, file: string, runtimeRoot: string, env: Record<string, string>) {
    this.root = root
    this.file = file
    this.runtimeRoot = runtimeRoot
    this.env = env
  }

  static async create(_testInfo: TestInfo, content: string | Buffer, name = 'scenario.md'): Promise<Scenario> {
    // Unix-domain socket paths are limited to 108 bytes on Linux. Playwright's
    // descriptive output paths are longer than that. Documents also live in
    // this isolated directory so acceptance fixtures are outside StrataMD's
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
    return new Scenario(root, file, runtime, {
      ...inheritedEnvironment,
      XDG_RUNTIME_DIR: runtime,
      XDG_DATA_HOME: data,
      XDG_CONFIG_HOME: config,
      // Isolates Electron's profile and its single-instance lock per scenario;
      // XDG_CONFIG_HOME only achieves that on Linux.
      STRATAMD_USER_DATA: userData,
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
    })
  }

  /** Tests run on the handoff (Strata) theme unless they choose one; the shipped default is Strata Vivid. */
  async writeSettings(settings: Record<string, unknown>): Promise<void> {
    const path = join(String(this.env.XDG_CONFIG_HOME), 'stratamd/settings.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ theme: 'strata', ...settings }, null, 2)}\n`)
  }

  async launch(file = this.file): Promise<Page> {
    await access(mainEntry, constants.R_OK)
    // Tests that wrote no settings still run on the handoff theme, not the
    // shipped Strata Vivid default, so visual assertions stay against Strata.
    const settingsPath = join(String(this.env.XDG_CONFIG_HOME), 'stratamd/settings.json')
    try {
      await access(settingsPath, constants.R_OK)
    } catch {
      await this.writeSettings({})
    }
    this.app = await electron.launch({
      args: [...launchArgs, mainEntry, file],
      cwd: projectRoot,
      env: this.env
    })
    this.page = await this.app.firstWindow()
    await this.page.waitForLoadState('domcontentloaded')
    await expect(this.page.getByText(file.split('/').at(-1)!, { exact: false }).first()).toBeVisible()
    return this.page
  }

  async launchEmpty(): Promise<Page> {
    await access(mainEntry, constants.R_OK)
    this.app = await electron.launch({
      args: [...launchArgs, mainEntry],
      cwd: projectRoot,
      env: this.env
    })
    this.page = await this.app.firstWindow()
    await this.page.waitForLoadState('domcontentloaded')
    await expect(this.page.getByRole('button', { name: /Add folder/i }).first()).toBeVisible()
    return this.page
  }

  async stop(crash = false): Promise<void> {
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

    try {
      await app.close()
    } catch {
      app.process().kill('SIGKILL')
    }
  }

  async dispose(): Promise<void> {
    await this.stop(true).catch(() => undefined)
    // Electron's helper processes can still be flushing into config/Electron
    // when the main process dies, so a single pass can hit ENOTEMPTY.
    await rm(this.runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }

  async cli(args: string[], timeoutMs = 15_000): Promise<CliResult> {
    await access(cliEntry, constants.X_OK)
    const result = await runProcess(cliEntry, args, this.env, timeoutMs)
    if (result.code === 4 && result.stderr.includes('PEER_REJECTED')) {
      const uid = process.getuid?.()
      result.stderr += `${JSON.stringify({
        diagnostic: 'peer-credentials',
        socket: join(this.runtimeRoot, 'stratamd.sock'),
        runtime: this.runtimeRoot,
        appPid: this.app?.process().pid,
        appUid: uid,
        cliPid: result.pid,
        cliUid: uid,
      })}\n`
    }
    return result
  }

  async attach(agent: string, name = agent): Promise<Payload> {
    return expectPayload(await this.cli(['attach', this.file, '--as', agent, '--name', name, '--timeout', '0']))
  }

  async state(file = this.file): Promise<Payload> {
    return expectPayload(await this.cli(['state', file]))
  }

  async changes(file = this.file): Promise<Payload> {
    return expectPayload(await this.cli(['changes', file]))
  }

  async tag(agent: string, name = agent): Promise<void> {
    const tagged = await this.cli(['changed', this.file, '--as', agent, '--name', name])
    expect(tagged.code, `${tagged.stderr}${tagged.stdout}`).toBe(0)
  }

  async atomicWrite(path: string, content: string | Buffer): Promise<void> {
    const temporary = `${path}.stratamd-acceptance-tmp`
    await writeFile(temporary, content)
    await rename(temporary, path)
  }

  async waitForBuffer(expected: string): Promise<void> {
    const payload = await this.state()
    expect(payload.buffer).toBeTruthy()
    await expect.poll(async () => readFile(payload.buffer!, 'utf8')).toBe(expected)
  }
}

export async function runProcess(executable: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<CliResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, { cwd: projectRoot, env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectProcess(new Error(`Command timed out: ${executable} ${args.join(' ')}`))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', rejectProcess)
    child.once('close', (code) => {
      clearTimeout(timer)
      let payload: Payload | undefined
      let error: unknown
      try { payload = parseJson(stdout) as Payload | undefined } catch (caught) { error = caught }
      resolveProcess({ code: code ?? 1, pid: child.pid, stdout, stderr, payload, error })
    })
  })
}

export function spawnCli(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(cliEntry, args, { cwd: projectRoot, env })
}

export function expectPayload(result: CliResult): Payload {
  expect(result.code, result.stderr || result.stdout).toBe(0)
  expect(result.error, result.stdout).toBeUndefined()
  expect(result.payload).toBeTruthy()
  return result.payload!
}

export async function sourceEditor(page: Page) {
  const source = page.getByRole('textbox', { name: /source editor/i })
  if (await source.count()) return source.first()
  await page.keyboard.press(primaryKey('/'))
  await expect(source).toBeVisible()
  return source
}

export async function setSource(page: Page, content: string): Promise<void> {
  const editor = await sourceEditor(page)
  await editor.fill(content)
}

export async function save(page: Page): Promise<void> {
  // A "Saved." toast from an earlier save lives 2.8 s and is not restarted by an
  // identical message; wait for it to clear so the poll below sees this save's toast.
  await expect(page.locator('.toast').filter({ hasText: /^Saved\./ })).toHaveCount(0, { timeout: 4_000 })
  // The Save button reads a quiet "Saved" when the editor matches the file; clicking it still saves.
  await page.getByRole('button', { name: /^Saved?$/i }).click()
  await expect.poll(async () => {
    const saved = page.locator('.toast').filter({ hasText: /^Saved\./ })
    if (await saved.count()) return (await saved.first().textContent()) ?? ''
    const conflict = page.getByRole('dialog', { name: /External write conflicts with your edits/i })
    return await conflict.count() ? 'conflict' : ''
  }).not.toBe('')
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
  await dialog.getByRole('button', { name: /^Send$/i }).click()
  await expect(dialog).toBeHidden()
}

export async function copyForAgent(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Copy for agent/i }).click()
  await expect(page.getByRole('status')).toContainText(/Copied for your agent/i)
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

export function allHunks(payload: Payload): Hunk[] {
  return (payload.segments ?? []).flatMap((segment) => segment.hunks ?? [])
}

export function externalText(payload: Payload): string {
  return (payload.segments ?? [])
    .filter((segment) => segment.author === 'external')
    .flatMap((segment) => segment.hunks)
    .flatMap((hunk) => [...hunk.removed, ...hunk.added])
    .join('\n')
}
