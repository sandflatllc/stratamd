import { chromium } from '@playwright/test';
const [,, src, out] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
await page.goto('file://' + src);
await page.evaluate(() => document.fonts.ready);
await page.waitForSelector('body[data-ready]', { timeout: 5000 }).catch(() => {});
await page.screenshot({ path: out });
await browser.close();
