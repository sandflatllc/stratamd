import { chromium } from '@playwright/test'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 })
await page.goto('file:///home/dillonc/Projects/StrataMD/docs/design/project-picker/mockup.html')
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: '/home/dillonc/Projects/StrataMD/docs/design/project-picker/captures/mockup.png', fullPage: true })
await browser.close()
