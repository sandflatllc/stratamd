import { chromium } from '@playwright/test'
const base = 'file:///home/dillonc/Projects/StrataMD/docs/design/subagent-activity/prototype.html'
const out = '/home/dillonc/Projects/StrataMD/docs/design/subagent-activity/captures'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.5 })
for (const state of ['clusters', 'many', 'hidden', 'modal', 'modal-many', 'done', 'failed', 'legend']) {
  await page.goto(`${base}?state=${state}`)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  const target = state === 'legend' ? page.locator('.board') : page.locator('.window')
  await target.screenshot({ path: `${out}/${state}.png`, animations: 'disabled' })
  console.log('captured', state)
}
await page.goto(`${base}?state=many`); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300)
const h = await page.locator('.conv > header').boundingBox()
await page.screenshot({ path: `${out}/clusters-zoom.png`, clip: { x: h.x + h.width - 520, y: h.y, width: 520, height: h.height }, animations: 'disabled' })
await browser.close()
