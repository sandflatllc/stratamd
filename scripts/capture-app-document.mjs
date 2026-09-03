// Opens one Markdown file in the built app (out/) under an isolated profile and
// writes a screenshot. A development aid for comparing the real application
// with docs/design/structured-reading captures; it never touches the owner's
// StrataMD store or a running instance.
//
//   node scripts/capture-app-document.mjs <file.md> <output.png> [--contents] [--walkthrough] [--tab changes|annotations] [--pin] [--width 1600] [--height 900] [--scroll <heading text>]
//
// On Linux run it under xvfb-run -a so the window never takes focus.
import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const positional = args.filter((argument) => !argument.startsWith('--'))
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const [file, output] = positional
if (!file || !output) {
  console.error('usage: node scripts/capture-app-document.mjs <file.md> <output.png> [--contents] [--walkthrough] [--tab changes|annotations] [--pin] [--scroll <heading>]')
  process.exit(1)
}

const runtime = await mkdtemp(join(tmpdir(), 'stratamd-capture-'))
const env = Object.fromEntries(Object.entries(process.env).filter(([key, entry]) => !['ELECTRON_RUN_AS_NODE', 'WAYLAND_DISPLAY'].includes(key) && entry !== undefined))
const config = join(runtime, 'config')
await mkdir(join(config, 'stratamd'), { recursive: true })
await writeFile(join(config, 'stratamd/settings.json'), JSON.stringify({
  theme: 'strata-vivid',
  animatedBackground: false,
  panels: { explorerWidth: 274, rightRailWidth: 365, upperReviewHeight: 520, documentMeasure: 1600 },
}, null, 2))
const app = await electron.launch({
  args: [...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []), join(root, 'out/main/index.js'), resolve(file)],
  cwd: root,
  env: {
    ...env,
    XDG_RUNTIME_DIR: runtime,
    XDG_DATA_HOME: join(runtime, 'data'),
    XDG_CONFIG_HOME: config,
    STRATAMD_USER_DATA: join(runtime, 'user-data'),
    ...(process.platform === 'linux' ? { ELECTRON_OZONE_PLATFORM_HINT: 'x11' } : {}),
  },
})
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: Number(value('width', 1600)), height: Number(value('height', 900)) })
  await page.getByRole('textbox', { name: /document editor|source editor/i }).first().waitFor({ timeout: 30_000 })
  if (flag('contents') || flag('walkthrough')) {
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
  }
  if (flag('walkthrough')) {
    const start = page.getByRole('button', { name: 'Start walkthrough' })
    await start.waitFor({ timeout: 10_000 }).catch(() => undefined)
    if (await start.count()) await start.click()
    await page.getByLabel('Walkthrough controls').waitFor({ timeout: 10_000 }).catch(() => undefined)
  }
  const tab = value('tab', null)
  if (tab) await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: new RegExp(`^${tab}`, 'i') }).click()
  if (flag('pin')) await page.getByRole('button', { name: 'Pin changes' }).click()
  const scrollTo = value('scroll', null)
  if (scrollTo) await page.getByRole('button', { name: new RegExp(scrollTo) }).first().click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: resolve(output) })
  console.log(`captured ${resolve(output)}`)
} finally {
  await app.close().catch(() => undefined)
  await rm(runtime, { recursive: true, force: true, maxRetries: 5 })
}
