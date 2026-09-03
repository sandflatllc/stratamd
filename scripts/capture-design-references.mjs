// Captures deterministic reference screenshots of the approved structured-reading
// prototypes (docs/design/structured-reading/*.html) at the viewports the real
// application is captured at, so an implementer can put an app capture beside
// the prototype state it reproduces.
//
//   node scripts/capture-design-references.mjs
//
// Output: docs/design/structured-reading/captures/prototype/*.png. The
// prototypes load fonts from /node_modules/@fontsource, so this serves the
// repository root over a local HTTP server for the duration of the run.
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const designRoot = join(root, 'docs/design/structured-reading')
const outputRoot = join(designRoot, 'captures/prototype')

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

function serve() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = normalize(join(root, decodeURIComponent(url.pathname)))
    if (!path.startsWith(root) || !existsSync(path) || statSync(path).isDirectory()) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
    createReadStream(path).pipe(response)
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)))
}

const STILL = '*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }'

/** One capture: a prototype page, a viewport, and the interactions that reach the state. */
const captures = [
  { file: 'dense-review-faithful-shell.html', name: 'shell-walkthrough-annotations', viewport: { width: 1600, height: 900 } },
  { file: 'dense-review-faithful-shell.html', name: 'shell-changes-tab', viewport: { width: 1600, height: 900 }, prepare: async (page) => { await page.click('.right-tab[data-pane="changesPane"]') } },
  { file: 'dense-review-faithful-shell.html', name: 'shell-pinned-changes', viewport: { width: 1600, height: 900 }, prepare: async (page) => { await page.click('#pinChanges') } },
  { file: 'dense-review-faithful-shell.html', name: 'table-default', viewport: { width: 1600, height: 900 }, prepare: async (page) => { await page.click('.outline-row[data-index="1"]') } },
  { file: 'dense-review-faithful-shell.html', name: 'table-focus-row', viewport: { width: 1600, height: 900 }, prepare: async (page) => { await page.click('.outline-row[data-index="1"]'); await page.click('.table-modes button[data-mode="rows"]') } },
  { file: 'dense-review-faithful-shell.html', name: 'table-compare', viewport: { width: 1600, height: 900 }, prepare: async (page) => { await page.click('.outline-row[data-index="1"]'); await page.click('.table-modes button[data-mode="cards"]') } },
  { file: 'dense-review-faithful-shell.html', name: 'table-focus', viewport: { width: 1600, height: 900 }, prepare: async (page) => { await page.click('.outline-row[data-index="1"]'); await page.click('.focus-table') } },
  { file: 'dense-review-faithful-shell.html', name: 'phase-board', viewport: { width: 1600, height: 900 }, prepare: async (page) => { await page.click('.outline-row[data-index="11"]') } },
  { file: 'dense-review-faithful-shell.html', name: 'contents-h2-h3', viewport: { width: 1600, height: 900 }, prepare: async (page) => { await page.selectOption('#headingLevel', 'h3') } },
  { file: 'dense-review-walkthrough.html', name: 'walkthrough-prototype', viewport: { width: 1600, height: 900 } },
  { file: 'widget-vivid-showcase.html?page=1', name: 'components-sheet-1', viewport: { width: 1920, height: 1080 } },
  { file: 'widget-vivid-showcase.html?page=2', name: 'components-sheet-2', viewport: { width: 1920, height: 1080 } },
  { file: 'high-value-visual-candidates.html?page=1', name: 'candidates-evidence-screenshot', viewport: { width: 1920, height: 1080 } },
  { file: 'high-value-visual-candidates.html?page=2', name: 'candidates-matrix-impact', viewport: { width: 1920, height: 1080 } },
]

const server = await serve()
const { port } = server.address()
await mkdir(outputRoot, { recursive: true })
const browser = await chromium.launch()
try {
  for (const capture of captures) {
    const context = await browser.newContext({ viewport: capture.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${port}/docs/design/structured-reading/${capture.file}`)
    await page.addStyleTag({ content: STILL })
    await page.evaluate(() => document.fonts.ready)
    if (capture.prepare) await capture.prepare(page)
    await page.waitForTimeout(120)
    const output = join(outputRoot, `${capture.name}.png`)
    await page.screenshot({ path: output, fullPage: false })
    console.log(`captured ${output}`)
    await context.close()
  }
} finally {
  await browser.close()
  server.close()
}
